import { MapContainer, Marker, Polyline, TileLayer } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// Vite bundles the marker assets; Leaflet's default URL detection fails under
// bundlers, so point it at the imported files explicitly.
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

export default function MapView({
  points,
  height = 300,
}: {
  points: Array<{ lat: number; lon: number }>;
  height?: number;
}) {
  if (points.length === 0) return null;
  const center: [number, number] = [points[points.length - 1].lat, points[points.length - 1].lon];
  const latlngs = points.map((p) => [p.lat, p.lon] as [number, number]);
  return (
    <div className="map-box" style={{ height }}>
      <MapContainer center={center} zoom={13} scrollWheelZoom={false}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {latlngs.length > 1 && <Polyline positions={latlngs} pathOptions={{ color: "#2fe6b0", weight: 4 }} />}
        <Marker position={center} />
      </MapContainer>
    </div>
  );
}
