/** Routing benchmark: run after `npm run db:seed:scale -- 10000` (ideally against a separate DATABASE_URL). */
import { findNearestPizzerias, closePool } from '@slice/db';
(async () => {
  const pts = [[52.52,13.405],[48.137,11.575],[60.17,24.938],[40.417,-3.704]];
  await findNearestPizzerias({lat:52.52,lng:13.4});
  const t0 = performance.now(); let n=0;
  for (let i=0;i<400;i++){ const [lat,lng]=pts[i%4]!; const r = await findNearestPizzerias({lat:lat!+(Math.random()-.5)*.1,lng:lng!+(Math.random()-.5)*.1},{limit:5}); n+=r.length; }
  const ms=(performance.now()-t0)/400; console.log(`avg nearest query over 10k pizzerias: ${ms.toFixed(2)} ms (${n/400} results avg)`);
  await closePool();
})();
