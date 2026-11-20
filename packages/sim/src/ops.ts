import { closePool, getPool } from '@slice/db';
import { sleep, staff } from './harness';

/**
 * Operations actors: every kitchen tablet and courier for every live order. Couriers ride from the
 * kitchen to the door sending GPS pings (the order workflow turns them into live tracking).
 * Failure knobs let load tests and demos inject real-world trouble.
 */
export interface OpsOptions {
  stepMs: number;
  rejectRate: number; // kitchen says "oven full"
  courierFailRate: number; // courier never arrives
  pingsPerTrip: number;
  onCourier?: (c: { orderId: string; lat: number; lng: number; progress: number }) => void;
  onEvent?: (text: string) => void;
  rand?: () => number;
}

const DEFAULTS: OpsOptions = { stepMs: 2000, rejectRate: 0.1, courierFailRate: 0, pingsPerTrip: 8 };

interface Live {
  id: string;
  status: string;
  pizzeria_id: string | null;
  plat: number | null;
  plng: number | null;
  dlat: number;
  dlng: number;
}

export async function opsTick(state: Map<string, { status: string; since: number; ping: number }>, o: OpsOptions) {
  const rand = o.rand ?? Math.random;
  const { rows } = await getPool().query<Live>(
    `SELECT o.id, o.status, o.pizzeria_id, p.lat AS plat, p.lng AS plng, o.delivery_lat AS dlat, o.delivery_lng AS dlng
     FROM orders o LEFT JOIN pizzerias p ON p.id = o.pizzeria_id
     WHERE o.status IN ('routed','payment_authorized','preparing','ready','out_for_delivery') AND o.created_at > now() - interval '2 hours'`,
  );
  const now = Date.now();
  for (const r of rows) {
    const s = state.get(r.id);
    if (!s || s.status !== r.status) {
      state.set(r.id, { status: r.status, since: now, ping: 0 });
      continue;
    }
    if (now - s.since < o.stepMs) continue;
    try {
      switch (r.status) {
        case 'routed':
        case 'payment_authorized':
          if (rand() < o.rejectRate) {
            await staff.kitchen(r.id, 'reject', 'oven full', r.pizzeria_id ?? undefined);
            o.onEvent?.(`${r.pizzeria_id} rejected ${r.id}`);
          } else await staff.kitchen(r.id, 'accept', undefined, r.pizzeria_id ?? undefined);
          break;
        case 'preparing':
          await staff.kitchen(r.id, 'ready', undefined, r.pizzeria_id ?? undefined);
          break;
        case 'ready':
          await staff.delivery(r.id, 'picked_up');
          break;
        case 'out_for_delivery': {
          if (s.ping === 0 && rand() < o.courierFailRate) {
            await staff.delivery(r.id, 'failed', 'courier accident (simulated)');
            o.onEvent?.(`courier failed on ${r.id}`);
            break;
          }
          s.ping++;
          const t = Math.min(1, s.ping / o.pingsPerTrip);
          const lat = (r.plat ?? r.dlat) + (r.dlat - (r.plat ?? r.dlat)) * t;
          const lng = (r.plng ?? r.dlng) + (r.dlng - (r.plng ?? r.dlng)) * t;
          o.onCourier?.({ orderId: r.id, lat, lng, progress: t });
          if (t < 1) {
            await staff.location(r.id, lat, lng);
            s.since = now - o.stepMs + Math.max(250, o.stepMs / o.pingsPerTrip); // pings faster than steps
            continue;
          }
          await staff.delivery(r.id, 'delivered');
          break;
        }
      }
      s.since = now;
    } catch (err) {
      o.onEvent?.(`ops error on ${r.id}: ${(err as Error).message}`);
    }
  }
}

export async function runOps(opts: Partial<OpsOptions> = {}, stop: () => boolean = () => false) {
  const o = { ...DEFAULTS, ...opts };
  const state = new Map<string, { status: string; since: number; ping: number }>();
  while (!stop()) {
    await opsTick(state, o).catch((e) => o.onEvent?.(`tick failed: ${e.message}`));
    await sleep(250);
  }
}

if (require.main === module) {
  let stopped = false;
  process.once('SIGINT', () => (stopped = true));
  process.once('SIGTERM', () => (stopped = true));
  const o = {
    stepMs: Number(process.env.SIM_STEP_SECONDS ?? 3) * 1000,
    rejectRate: Number(process.env.REJECT_RATE ?? 0.1),
    courierFailRate: Number(process.env.COURIER_FAIL_RATE ?? 0),
    onEvent: (t: string) => console.log(`[ops] ${t}`),
  };
  console.log(`Ops actors running (step ${o.stepMs / 1000}s, reject ${o.rejectRate}, courier fail ${o.courierFailRate})`);
  runOps(o, () => stopped).finally(() => closePool());
}
