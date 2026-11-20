// Pure functions shared by workflows and tests — no Temporal imports here.

export interface OpsFinding {
  pizzeriaId: string;
  region: string;
  agenda: string[];
}

/** Pure analysis — kept in the workflow so the decision logic is versioned with the workflow. */
export function analyzeKpis(
  rows: Array<{ id: string; region: string; orders: number; delivered: number; lost: number; rerouted_away: number; capacity_per_15min: number }>,
): OpsFinding[] {
  const findings: OpsFinding[] = [];
  for (const r of rows) {
    const agenda: string[] = [];
    if (r.rerouted_away >= 5) agenda.push(`${r.rerouted_away} orders rerouted away — raise capacity (now ${r.capacity_per_15min}/15min) or add a shift`);
    if (r.orders >= 10 && r.lost / r.orders > 0.1) agenda.push(`${Math.round((r.lost / r.orders) * 100)}% orders lost — review prep times & courier coverage`);
    if (r.orders === 0) agenda.push('No orders this week — consider a local campaign or hosting a virtual brand');
    if (agenda.length) findings.push({ pizzeriaId: r.id, region: r.region, agenda });
  }
  return findings;
}
