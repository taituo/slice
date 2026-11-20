/**
 * Canary / A-B assignment. Deterministic: the same subject in the same experiment always lands in
 * the same bucket, so a customer never flips between variants mid-session, and a whole region can
 * be pinned to the canary while the rest stays on control.
 */
export interface Rollout {
  key: string;
  /** Regions that get the treatment for everyone (region canary). */
  regions?: string[];
  /** Percentage (0-100) of remaining subjects that get the treatment. */
  percent?: number;
  /** Version label of the build that ships this feature, e.g. "2026.11.20-canary". */
  build?: string;
}

/** FNV-1a 32-bit — tiny, stable across runtimes (Node, browsers, React Native, Temporal workflows). */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function bucketOf(subject: string, experimentKey: string): number {
  return fnv1a(`${experimentKey}:${subject}`) % 100;
}

export function assignVariant(rollout: Rollout | undefined, subject: string, region: string): 'control' | 'treatment' {
  if (!rollout) return 'control';
  if (rollout.regions?.includes(region)) return 'treatment';
  const pct = rollout.percent ?? 0;
  return bucketOf(subject, rollout.key) < pct ? 'treatment' : 'control';
}
