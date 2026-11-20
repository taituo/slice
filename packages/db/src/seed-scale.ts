import { closePool, getPool } from './pool';
import { migrate } from './migrate';

/**
 * Scale rehearsal: generate N synthetic pizzerias across European metro areas so the routing query,
 * capacity locks and Temporal task queues can be load-tested at the 10,000-site target.
 *   npm run db:seed:scale -- 10000
 */
const metros = [
  { region: 'de-berlin', lat: 52.52, lng: 13.405 },
  { region: 'de-munich', lat: 48.137, lng: 11.575 },
  { region: 'de-hamburg', lat: 53.551, lng: 9.993 },
  { region: 'nl-amsterdam', lat: 52.367, lng: 4.904 },
  { region: 'fr-paris', lat: 48.857, lng: 2.352 },
  { region: 'es-madrid', lat: 40.417, lng: -3.704 },
  { region: 'it-milan', lat: 45.464, lng: 9.19 },
  { region: 'pl-warsaw', lat: 52.23, lng: 21.012 },
  { region: 'se-stockholm', lat: 59.329, lng: 18.069 },
  { region: 'fi-helsinki', lat: 60.17, lng: 24.938 },
];

// Deterministic PRNG so every run builds the same fleet.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seedScale(n: number) {
  await migrate();
  const pool = getPool();
  const rand = mulberry32(42);
  const brandIds = ['slice', 'nightowl', 'bloom'];
  const batch = 500;
  for (let start = 0; start < n; start += batch) {
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let i = start; i < Math.min(n, start + batch); i++) {
      const m = metros[i % metros.length]!;
      // ~25 km spread around the metro centre
      const lat = m.lat + (rand() - 0.5) * 0.45;
      const lng = m.lng + (rand() - 0.5) * 0.7;
      const id = `syn-${String(i).padStart(5, '0')}`;
      const o = values.length;
      tuples.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9})`);
      values.push(
        id,
        brandIds[i % 3],
        `Synthetic ${m.region} #${i}`,
        m.region,
        `Generated address ${i}`,
        lat,
        lng,
        rand() < 0.5 ? 'own_fleet' : 'third_party',
        6 + Math.floor(rand() * 10),
      );
    }
    await pool.query(
      `INSERT INTO pizzerias (id, brand_id, name, region, address, lat, lng, delivery_mode, capacity_per_15min)
       VALUES ${tuples.join(',')} ON CONFLICT (id) DO NOTHING`,
      values,
    );
  }
  await pool.query('ANALYZE pizzerias');
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pizzerias`);
  return rows[0].n as number;
}

if (require.main === module) {
  const n = Number(process.argv[2] ?? 10000);
  seedScale(n)
    .then((total) => console.log(`Pizzerias in database: ${total}`))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
