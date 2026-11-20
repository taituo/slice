import type { FastifyInstance } from 'fastify';
import { getPool } from '@slice/db';

/**
 * Live map feed for load tests: the simulator posts a snapshot of its actors (shoppers, diners,
 * gym-goers, couriers) every second; the map page streams it together with every provider's location.
 */
export interface SimActor {
  id: string;
  kind: 'customer' | 'courier';
  lat: number;
  lng: number;
  state: string;
  intent?: string;
  persona?: string;
  target?: { lat: number; lng: number } | null;
}
export interface SimSnapshot {
  at: string;
  actors: SimActor[];
  stats: Record<string, number>;
  events: Array<{ at: string; actor: string; text: string }>;
}

let latest: SimSnapshot | null = null;

export function registerSim(app: FastifyInstance, adminKey: string) {
  app.post('/v1/sim/state', async (req, reply) => {
    if (req.headers['x-admin-key'] !== adminKey) return reply.code(401).send({ error: 'unauthorized' });
    latest = req.body as SimSnapshot;
    return { ok: true };
  });

  app.get('/v1/sim/places', async () => {
    const { rows } = await getPool().query(
      `SELECT p.id, p.name, 'food' AS kind, p.lat, p.lng, p.status FROM pizzerias p WHERE p.id NOT LIKE 'syn-%'
       UNION ALL SELECT g.id, g.name, 'fitness', g.lat, g.lng, 'open' FROM gyms g
       UNION ALL SELECT m.id, m.name, 'retail', m.lat, m.lng, 'open' FROM merchants m`,
    );
    return { places: rows };
  });

  app.get('/v1/sim/state', async () => latest ?? { at: null, actors: [], stats: {}, events: [] });

  app.get('/v1/sim/stream', async (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    let closed = false;
    req.raw.on('close', () => (closed = true));
    let lastAt = '';
    while (!closed) {
      if (latest && latest.at !== lastAt) {
        reply.raw.write(`event: sim\ndata: ${JSON.stringify(latest)}\n\n`);
        lastAt = latest.at;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    reply.raw.end();
    return reply;
  });
}
