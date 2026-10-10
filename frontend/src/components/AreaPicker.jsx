import { useEffect, useMemo, useState } from 'react'
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'

function PickPoint({ onPick }) {
  const map = useMap()
  useEffect(() => { const frame = requestAnimationFrame(() => map.invalidateSize()); return () => cancelAnimationFrame(frame) }, [map])
  useMapEvents({ click: ({ latlng }) => onPick(latlng.lat, latlng.lng) })
  return null
}

export default function AreaPicker({ point, onChange, busy, onSearch }) {
  const [fields, setFields] = useState(() => ({ latitude: point ? point.latitude.toFixed(6) : '',
    longitude: point ? point.longitude.toFixed(6) : '' }))
  const marker = useMemo(() => L.divIcon({ className: 'selected-area-pin', html: '<span></span>',
    iconSize: [26, 32], iconAnchor: [13, 30] }), [])
  const pick = (latitude, longitude) => {
    if (busy) return
    setFields({ latitude: latitude.toFixed(6), longitude: longitude.toFixed(6) })
    onChange({ latitude, longitude })
  }
  const update = (name, value) => {
    const next = { ...fields, [name]: value }
    setFields(next)
    const latitude = Number(next.latitude), longitude = Number(next.longitude)
    onChange(next.latitude.trim() && next.longitude.trim() && Number.isFinite(latitude) && Number.isFinite(longitude)
      && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null)
  }
  return <section className="area-picker" aria-label="Choose a bin search area">
    <div className="area-picker-heading"><b>Choose your search area</b><span>Tap the map in Lucknow, or enter coordinates.</span></div>
    <div className="area-picker-map"><MapContainer center={[26.8467, 80.9462]} zoom={13} scrollWheelZoom={false} className="leaflet-map">
      <TileLayer attribution={'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'} url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"/>
      <PickPoint onPick={pick}/>{point && <Marker position={[point.latitude, point.longitude]} icon={marker}/>}</MapContainer></div>
    <div className="area-coordinate-fields"><label>Latitude<input type="number" step="any" min="-90" max="90" value={fields.latitude} disabled={busy} onChange={(event) => update('latitude', event.target.value)} placeholder="e.g. 26.8467"/></label><label>Longitude<input type="number" step="any" min="-180" max="180" value={fields.longitude} disabled={busy} onChange={(event) => update('longitude', event.target.value)} placeholder="e.g. 80.9462"/></label></div>
    <button type="button" className="button button-green guide-action" disabled={busy || !point} onClick={onSearch}>{busy ? 'Searching…' : 'Find bins around this point'}</button>
    <p>No device location is assumed. Search sends only your chosen point to the map lookup service.</p>
  </section>
}
