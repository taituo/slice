import { proxyActivities, sleep } from '@temporalio/workflow';
import type { Activities } from '../activities';
import { analyzeKpis, type OpsFinding } from './analysis';

export type { OpsFinding };

const acts = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 5 },
});

/** Scheduled every Monday 09:00 (see schedules.ts). Books ops calls only where the data says so. */
export async function weeklyOpsReviewWorkflow(): Promise<{ reviewed: number; callsBooked: number; findings: OpsFinding[] }> {
  const kpis = await acts.collectKpis({ days: 7 });
  const findings = analyzeKpis(kpis);
  for (const f of findings) await acts.scheduleOpsCall(f);
  return { reviewed: kpis.length, callsBooked: findings.length, findings };
}

/** Scheduled hourly: anything below its reorder threshold gets a supplier order. */
export async function inventoryReorderWorkflow(): Promise<{ reordered: number }> {
  const low = await acts.inventoryBelowThreshold();
  for (const item of low) {
    await acts.placeSupplierOrder({ pizzeriaId: item.pizzeriaId, ingredient: item.ingredient, qty: item.reorderQty, unit: item.unit });
  }
  return { reordered: low.length };
}

/**
 * Seasonal campaign (Halloween, Black Friday, Christmas…): a durable timer sleeps until launch,
 * announces to marketing-consented customers, sleeps until the end, then closes it out.
 * Survives worker restarts and deploys — the timer lives in Temporal, not in a process.
 */
export async function campaignLifecycleWorkflow(input: { code: string; startsAt: string; endsAt: string }) {
  const untilStart = Date.parse(input.startsAt) - Date.now();
  if (untilStart > 0) await sleep(untilStart);
  const launched = await acts.announceCampaign({ code: input.code, phase: 'start' });
  const untilEnd = Date.parse(input.endsAt) - Date.now();
  if (untilEnd > 0) await sleep(untilEnd);
  await acts.announceCampaign({ code: input.code, phase: 'end' });
  return { code: input.code, audience: launched.audience };
}

/**
 * Usage → development bridge. Clusters product signals (unhandled agent intents, errors, abandoned
 * carts) and files one GitHub issue per recurring theme, labelled for the coding bots to pick up.
 */
export async function productFeedbackWorkflow(input: { minOccurrences?: number } = {}) {
  const min = input.minOccurrences ?? 3;
  const signals = await acts.untriagedSignals();
  type Cluster = { ids: number[]; samples: string[]; source: string; kind: string };
  const clusters = new Map<string, Cluster>();
  for (const s of signals) {
    const theme = String((s.detail as Record<string, unknown>).theme ?? (s.detail as Record<string, unknown>).intent ?? 'general');
    const key = `${s.kind}:${theme}`;
    const c: Cluster = clusters.get(key) ?? { ids: [], samples: [], source: s.source, kind: s.kind };
    c.ids.push(Number(s.id));
    if (c.samples.length < 5) c.samples.push(JSON.stringify(s.detail));
    clusters.set(key, c);
  }
  const filed: Array<{ key: string; url: string | null; dryRun: boolean }> = [];
  const triaged: number[] = [];
  for (const [key, c] of clusters) {
    if (c.ids.length < min) continue;
    // The development deep agent writes the issue: problem, proposal, files, flag, tests, rollout.
    const draft = await acts.draftIssueWithDevAgent({ key, kind: c.kind, count: c.ids.length, samples: c.samples });
    const res = await acts.openIssue({ title: draft.title, body: draft.body, labels: ['bot:triage', 'from-usage', `kind:${c.kind}`] });
    filed.push({ key, ...res });
    triaged.push(...c.ids);
  }
  await acts.markSignalsTriaged({ ids: triaged });
  return { signals: signals.length, issues: filed };
}
