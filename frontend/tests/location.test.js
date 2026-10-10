import test from 'node:test'
import assert from 'node:assert/strict'
import { getDeviceLocation, lookupNearbyBins } from '../src/location.js'

const point = { latitude: 26.8467, longitude: 80.9462, accuracy: 18 }
test('device location succeeds without requesting a second fix', async () => {
  let calls = 0
  const geolocation = { getCurrentPosition(success, error, options) {
    calls++; assert.equal(options.enableHighAccuracy, true); success({ coords: point })
  } }
  assert.deepEqual(await getDeviceLocation({ geolocation }), point)
  assert.equal(calls, 1)
})
test('an unavailable cached fix retries with fresh high accuracy', async () => {
  const options = []
  const geolocation = { getCurrentPosition(success, error, config) {
    options.push(config)
    if (options.length === 1) error({ code: 2 })
    else success({ coords: point })
  } }
  assert.deepEqual(await getDeviceLocation({ geolocation }), point)
  assert.equal(options.length, 2)
  assert.equal(options[1].enableHighAccuracy, true)
  assert.equal(options[1].maximumAge, 0)
})
test('denied permission is not repeatedly requested and offers manual selection', async () => {
  let calls = 0
  const geolocation = { getCurrentPosition(success, error) { calls++; error({ code: 1 }) } }
  await assert.rejects(getDeviceLocation({ geolocation }), /permission was denied.*manually/)
  assert.equal(calls, 1)
})
test('unavailable providers and synchronous browser errors yield actionable messages', async () => {
  await assert.rejects(getDeviceLocation({ geolocation: { getCurrentPosition(success, error) { error({ code: 2 }) } } }), /could not determine.*Chrome.*manually/)
  await assert.rejects(getDeviceLocation({ geolocation: { getCurrentPosition() { const error = new Error(); error.name = 'SecurityError'; throw error } } }), /permission was denied/)
})
test('a provider that never calls back times out instead of keeping controls busy indefinitely', async () => {
  await assert.rejects(getDeviceLocation({ geolocation: { getCurrentPosition() {} }, timeout: 5, retryTimeout: 5 }), /took too long/)
})
test('missing geolocation and insecure origins use a manual fallback', async () => {
  await assert.rejects(getDeviceLocation({ geolocation: null }), /unavailable.*manually/)
  await assert.rejects(getDeviceLocation({ geolocation: { getCurrentPosition: assert.fail }, secureContext: false }), /HTTPS.*manually/)
})
test('a manual map point searches only the chosen coordinates without requesting device location', async () => {
  let request
  const result = await lookupNearbyBins({ api: '/api', point, radius: 1000, fetchImpl: async (url, options) => {
    request = { url, options }
    return { ok: true, json: async () => ({ results: [], radius_meters: 1000 }) }
  } })
  assert.equal(request.url, '/api/nearby-bins')
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(JSON.parse(request.options.body), { latitude: point.latitude, longitude: point.longitude, radius_meters: 1000 })
  assert.deepEqual(result.origin, point)
  assert.deepEqual(result.results, [])
})
test('invalid manual points, API failures, and malformed data remain recoverable', async () => {
  await assert.rejects(lookupNearbyBins({ api: '/api', point: null, radius: 1000, fetchImpl: assert.fail }), /Choose a valid point/)
  await assert.rejects(lookupNearbyBins({ api: '/api', point, radius: 1000, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ detail: 'Map provider unavailable' }) }) }), /Map provider unavailable/)
  await assert.rejects(lookupNearbyBins({ api: '/api', point, radius: 1000, fetchImpl: async () => ({ ok: true, json: async () => ({ results: null }) }) }), /could not be read/)
})

test('fresh device coordinates outside Lucknow and their accuracy are preserved, never substituted', async () => {
  const actual = { latitude: 26.721234, longitude: 80.812345, accuracy: 920 }
  const result = await getDeviceLocation({ geolocation: { getCurrentPosition(success, error, options) {
    assert.equal(options.maximumAge, 0)
    assert.equal(options.enableHighAccuracy, true)
    success({ coords: actual })
  } } })
  assert.deepEqual(result, actual)
  await assert.rejects(lookupNearbyBins({ api: '/api', point: result, radius: 500,
    fetchImpl: async (url, options) => {
      assert.deepEqual(JSON.parse(options.body), { latitude: actual.latitude, longitude: actual.longitude, radius_meters: 500 })
      return { ok: false, status: 422, json: async () => ({ detail: 'Outside the supported pilot; coordinates unchanged.' }) }
    } }), /Outside/)
  assert.deepEqual(result, actual)
})
