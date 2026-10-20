"use client";

// The Leaflet map inside the "Set location on map" dialog. Loaded only in the
// browser (next/dynamic, ssr: false) — Leaflet touches `window` on import.

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { useEffect } from "react";

// A plain CSS pin, so no marker image files need bundling (Leaflet's default
// icon URLs break under bundlers).
const PIN = L.divIcon({
  className: "",
  html: '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#2563eb;border:2px solid #fff;transform:rotate(-45deg);box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 22],
});

export type MapLayer = "map" | "satellite";

const TILES: Record<MapLayer, { url: string; attribution: string; maxZoom: number }> = {
  map: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  },
  // New estates often are not on the street map yet; the aerial photo shows
  // the actual lots and slabs.
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    maxZoom: 19,
  },
};

function ClickToPlace({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

function Recenter({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom);
  }, [map, center, zoom]);
  return null;
}

export default function SiteLocationMap({
  center,
  zoom,
  pin,
  layer,
  onPick,
}: {
  center: [number, number];
  zoom: number;
  pin: [number, number] | null;
  layer: MapLayer;
  onPick: (lat: number, lng: number) => void;
}) {
  const t = TILES[layer];
  return (
    <MapContainer center={center} zoom={zoom} style={{ height: "100%", width: "100%" }} scrollWheelZoom>
      <TileLayer key={layer} url={t.url} attribution={t.attribution} maxZoom={t.maxZoom} />
      <Recenter center={center} zoom={zoom} />
      <ClickToPlace onPick={onPick} />
      {pin && (
        <Marker
          position={pin}
          icon={PIN}
          draggable
          eventHandlers={{
            dragend: (e) => {
              const p = (e.target as L.Marker).getLatLng();
              onPick(p.lat, p.lng);
            },
          }}
        />
      )}
    </MapContainer>
  );
}
