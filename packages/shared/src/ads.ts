/**
 * Ad serving and guardrails. Variants compete by Thompson sampling on click-through: every serve
 * draws from each variant's Beta(clicks+1, impressions-clicks+1) and shows the highest draw, so
 * new variants still get exposure while winners take most traffic.
 */

export interface AdStats {
  id: string;
  impressions: number;
  clicks: number;
}

/** Marsaglia–Tsang gamma sampler (shape ≥ 1 branch + boost for shape < 1). */
function sampleGamma(shape: number, rand: () => number): number {
  if (shape < 1) return sampleGamma(shape + 1, rand) * Math.pow(rand(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box–Muller standard normal
      const u1 = Math.max(rand(), 1e-12);
      const u2 = rand();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(a: number, b: number, rand: () => number = Math.random): number {
  const x = sampleGamma(a, rand);
  const y = sampleGamma(b, rand);
  return x / (x + y);
}

export function thompsonPick<T extends AdStats>(ads: T[], rand: () => number = Math.random): T | null {
  let best: T | null = null;
  let bestDraw = -1;
  for (const ad of ads) {
    const draw = sampleBeta(ad.clicks + 1, Math.max(0, ad.impressions - ad.clicks) + 1, rand);
    if (draw > bestDraw) {
      best = ad;
      bestDraw = draw;
    }
  }
  return best;
}

/** Variants to pause: enough data, and posterior mean CTR under half of the group's best. */
export function variantsToPause(group: AdStats[], minImpressions = 200): string[] {
  const mean = (a: AdStats) => (a.clicks + 1) / (a.impressions + 2);
  const mature = group.filter((a) => a.impressions >= minImpressions);
  if (mature.length < 2) return [];
  const best = Math.max(...mature.map(mean));
  return mature.filter((a) => mean(a) < best * 0.5).map((a) => a.id);
}

const BANNED = [/\bbest\b/i, /\b#1\b/i, /\bguarantee/i, /\bcheapest\b/i, /\bfree money\b/i, /\bmiracle\b/i];

/**
 * Generated ads must be short, honest and backed by a real offer: any "N% off" claim must equal the
 * special it advertises, and unverifiable superlatives are rejected.
 */
export function checkAdCopy(ad: { headline: string; body: string; cta: string }, facts: { percentOff?: number | null }): string[] {
  const problems: string[] = [];
  if (ad.headline.length > 60) problems.push('headline over 60 characters');
  if (ad.body.length > 140) problems.push('body over 140 characters');
  if (ad.cta.length > 24) problems.push('CTA over 24 characters');
  const text = `${ad.headline} ${ad.body}`;
  for (const re of BANNED) if (re.test(text)) problems.push(`unverifiable claim: ${re.source}`);
  const claims = [...text.matchAll(/(\d{1,2})\s?%/g)].map((m) => Number(m[1]));
  for (const c of claims) {
    if (facts.percentOff == null || c !== Math.round(facts.percentOff)) problems.push(`claims ${c}% without a matching offer`);
  }
  return problems;
}
