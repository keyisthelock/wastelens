import { requestJson } from './report-workflow.js'

export function locationErrorMessage(error) {
  if (error?.code === 1) return 'Location permission was denied. Allow location for this site in your browser/device settings, or choose an area manually.'
  if (error?.code === 3) return 'Your device took too long to find a location. Try again outdoors or near Wi-Fi, or choose an area manually.'
  return 'This browser could not determine your device location. Try Chrome with device location enabled, or choose an area manually.'
}

function locateOnce(geolocation, options) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    // Browser timeouts can exclude time waiting for a permission prompt.
    const timer = setTimeout(() => finish(reject, { code: 3 }), options.timeout)
    try {
      geolocation.getCurrentPosition((position) => {
        const latitude = position?.coords?.latitude
        const longitude = position?.coords?.longitude
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
          || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return finish(reject, { code: 2 })
        finish(resolve, { latitude, longitude, accuracy: Number.isFinite(position.coords.accuracy) && position.coords.accuracy >= 0 ? position.coords.accuracy : null })
      }, (error) => finish(reject, error), options)
    } catch (error) { finish(reject, { code: error?.name === 'SecurityError' ? 1 : 2 }) }
  })
}

export async function getDeviceLocation({ geolocation = globalThis.navigator?.geolocation,
  secureContext = globalThis.isSecureContext, timeout = 8000, retryTimeout = 12000 } = {}) {
  if (secureContext === false) throw new Error('Location needs HTTPS or localhost. Choose an area manually to continue here.')
  if (!geolocation) throw new Error('Device location is unavailable in this browser. Choose an area manually, or open WasteLens in Chrome.')
  try {
    try { return await locateOnce(geolocation, { enableHighAccuracy: true, timeout, maximumAge: 0 }) }
    catch (error) {
      if (error?.code === 1) throw error
      // A fresh, more accurate fix can recover from an unavailable cached fix.
      return await locateOnce(geolocation, { enableHighAccuracy: true, timeout: retryTimeout, maximumAge: 0 })
    }
  } catch (error) { throw new Error(locationErrorMessage(error)) }
}

export async function lookupNearbyBins({ api, point, radius, fetchImpl = globalThis.fetch }) {
  if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)
    || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) {
    throw new Error('Choose a valid point on the map or enter both coordinates before searching.')
  }
  const result = await requestJson(fetchImpl, `${api}/nearby-bins`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ latitude: point.latitude, longitude: point.longitude, radius_meters: radius }),
  }, 'Nearby map data is temporarily unavailable. Your chosen area is still here; try again later.')
  if (!Array.isArray(result.results) || !Number.isFinite(result.radius_meters)) {
    throw new Error('Nearby map data could not be read. Try this area again later.')
  }
  return { ...result, origin: { ...point } }
}
