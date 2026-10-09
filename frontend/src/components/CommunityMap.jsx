import { useEffect, useMemo } from 'react'
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet'
import MarkerClusterGroup from 'react-leaflet-cluster'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import './community-map.css'

const lucknowCenter = [26.8467, 80.9462]

function AutoFitReports({ reports }) {
  const map = useMap()
  const pointSignature = reports.map(({ id, latitude, longitude }) => `${id}:${latitude}:${longitude}`).join('|')
  useEffect(() => {
    if (!reports.length) return
    const bounds = L.latLngBounds(reports.map((report) => [report.latitude, report.longitude]))
    if (bounds.isValid()) map.fitBounds(bounds.pad(reports.length === 1 ? 0.65 : 0.2), { maxZoom: 13 })
  }, [map, pointSignature])
  return null
}

function MapPin({ report, onOpen }) {
  const severity = ['high', 'medium', 'low'].includes(report.severity) ? report.severity : 'unassessed'
  const icon = useMemo(() => L.divIcon({
    className: `wastelens-map-pin severity-${severity}`,
    html: '<span></span>',
    iconSize: [24, 32],
    iconAnchor: [12, 28],
    popupAnchor: [0, -27],
  }), [severity])
  const label = report.categories?.length ? report.categories.join(', ') : 'Unmanaged waste'
  return <Marker position={[report.latitude, report.longitude]} icon={icon} title={`${label}, approximate location`}>
    <Popup className="wastelens-map-popup">
      <div className="map-popup-content"><small>COMMUNITY REPORT · APPROXIMATE</small><b>{label}</b><span>{report.status.replaceAll('_', ' ')} · {report.supports} neighbors supporting</span><button type="button" onClick={() => onOpen(report)}>Open report</button></div>
    </Popup>
  </Marker>
}

export default function CommunityMap({ reports, onOpen }) {
  return <div className="community-map">
    <MapContainer center={lucknowCenter} zoom={12} minZoom={10} maxZoom={17} scrollWheelZoom={false} zoomControl className="leaflet-map">
      <TileLayer
        attribution={'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'}
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />
      <AutoFitReports reports={reports}/>
      <MarkerClusterGroup chunkedLoading showCoverageOnHover={false} spiderfyOnMaxZoom>
        {reports.map((report) => <MapPin key={report.id} report={report} onOpen={onOpen}/>) }
      </MarkerClusterGroup>
    </MapContainer>
  </div>
}
