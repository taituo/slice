import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * Live load-test map: every simulated person, courier, kitchen, gym and shop, streamed from the
 * simulator through /v1/sim/stream. Tiles are OpenStreetMap; markers are plain circles.
 */
interface Actor {
  id: string;
  kind: 'customer' | 'courier';
  lat: number;
  lng: number;
  state: string;
  persona?: string;
  target?: { lat: number; lng: number } | null;
}
interface Snapshot {
  at: string | null;
  actors: Actor[];
  stats: Record<string, number>;
  events: Array<{ at: string; actor: string; text: string }>;
}

const PERSONA: Record<string, string> = { diner: '#c2321f', shopper: '#2563eb', gymgoer: '#0f766e', browser: '#7a6560' };
const PLACE: Record<string, string> = { food: '#c2321f', fitness: '#0f766e', retail: '#2563eb' };

export function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true }).setView([52.515, 13.395], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(m);
    map.current = m;
    layer.current = L.layerGroup().addTo(m);
    fetch('/v1/sim/places')
      .then((r) => r.json())
      .then((d: { places: Array<{ id: string; name: string; kind: string; lat: number; lng: number }> }) => {
        for (const p of d.places) {
          L.circleMarker([p.lat, p.lng], { radius: 9, color: PLACE[p.kind], weight: 3, fillColor: '#fff', fillOpacity: 1 })
            .bindTooltip(`${p.name} (${p.kind})`)
            .addTo(m);
        }
      })
      .catch(() => undefined);
  }, []);

  // Separate from map setup so StrictMode's double-invoke reconnects the stream instead of dropping it.
  useEffect(() => {
    const es = new EventSource('/v1/sim/stream');
    es.addEventListener('sim', (e) => setSnap(JSON.parse((e as MessageEvent).data)));
    return () => es.close();
  }, []);

  useEffect(() => {
    if (!layer.current || !snap) return;
    layer.current.clearLayers();
    for (const a of snap.actors) {
      if (a.kind === 'courier') {
        L.circleMarker([a.lat, a.lng], { radius: 6, color: '#111', weight: 2, fillColor: '#e9a23b', fillOpacity: 1 }).bindTooltip(`${a.id} ${a.state}`).addTo(layer.current);
        continue;
      }
      const color = PERSONA[a.persona ?? 'browser'] ?? '#555';
      if (a.target) L.polyline([[a.lat, a.lng], [a.target.lat, a.target.lng]], { color, weight: 1, dashArray: '3 4', opacity: 0.6 }).addTo(layer.current);
      L.circleMarker([a.lat, a.lng], { radius: 5, color, weight: 1, fillColor: color, fillOpacity: 0.85 }).bindTooltip(`${a.id}: ${a.state}`).addTo(layer.current);
    }
  }, [snap]);

  const s = snap?.stats ?? {};
  return (
    <div className="mapview">
      <div ref={el} className="mapview-map" />
      <aside className="mapview-panel">
        <h2>Live load test</h2>
        {!snap?.at && <p className="fine">Waiting for the simulator. Run <code>npm run load</code>.</p>}
        <dl className="mapview-stats">
          {Object.entries(s).map(([k, v]) => (
            <div key={k}>
              <dt>{k.replace(/_/g, ' ')}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <ul className="mapview-legend">
          {Object.entries(PERSONA).map(([k, c]) => (
            <li key={k}>
              <span style={{ background: c }} /> {k}
            </li>
          ))}
          <li>
            <span style={{ background: '#e9a23b', outline: '2px solid #111' }} /> courier
          </li>
        </ul>
        <h3>What's happening</h3>
        <ol className="mapview-events">
          {[...(snap?.events ?? [])].reverse().slice(0, 14).map((e, i) => (
            <li key={i}>
              <b>{e.actor}</b> {e.text}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
