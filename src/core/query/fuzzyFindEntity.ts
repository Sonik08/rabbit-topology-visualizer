import type { IndexedEntity, TopologyIndexes } from "../graph/indexes";
import type { EntitySearchKind } from "./findEntity";

export interface FuzzySearchOptions {
  kind?: EntitySearchKind;
  hostId?: string;
  vhostId?: string;
  /** Maximum results returned. Default 25. */
  limit?: number;
  /** Drop candidates whose score is below this threshold. Range 0..1. Default 0.3. */
  minScore?: number;
}

export type FuzzyMatchReason =
  | "exact"
  | "prefix"
  | "substring"
  | "subsequence";

export interface FuzzySearchMatch {
  entity: IndexedEntity;
  /** 0..1, higher is better. */
  score: number;
  reason: FuzzyMatchReason;
}

/**
 * Fuzzy name search over queues and/or exchanges. Uses a cheap tiered scorer:
 * exact > prefix > substring > subsequence. Case-insensitive. Returns matches
 * sorted by score desc, then by entity name asc for stable ordering.
 *
 * Intentionally does *not* rank by graph relevance — this is a text-name search
 * for the UI search box; upstream-flow ranking is a separate query.
 */
export function fuzzyFindEntity(
  indexes: TopologyIndexes,
  query: string,
  options: FuzzySearchOptions = {},
): FuzzySearchMatch[] {
  // Guard both knobs so callers can't accidentally invert the semantics:
  // `slice(0, -1)` would silently drop the last result; a `minScore` outside
  // `[0, 1]` would either drop everything or nothing regardless of query.
  const rawLimit = options.limit ?? 25;
  const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 25;
  if (limit === 0) return [];
  const rawMin = options.minScore ?? 0.3;
  // Only clamp the lower bound: passing minScore > 1 is a legitimate way to
  // say "reject everything, even exact matches" and must not silently succeed.
  const minScore = Number.isFinite(rawMin) ? Math.max(0, rawMin) : 0.3;
  const kind: EntitySearchKind = options.kind ?? "either";

  const q = query.trim();
  if (q.length === 0) return [];

  const candidates =
    kind === "either"
      ? [...indexes.entitiesByKind("exchange"), ...indexes.entitiesByKind("queue")]
      : indexes.entitiesByKind(kind);

  const filtered = candidates.filter((e) => {
    if (options.hostId !== undefined && e.hostId !== options.hostId) return false;
    if (options.vhostId !== undefined && e.vhostId !== options.vhostId) return false;
    return true;
  });

  const qLower = q.toLowerCase();
  const scored: FuzzySearchMatch[] = [];
  for (const entity of filtered) {
    const scoredMatch = scoreCandidate(entity, qLower);
    if (scoredMatch && scoredMatch.score >= minScore) {
      scored.push(scoredMatch);
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entity.name.localeCompare(b.entity.name);
  });

  return scored.slice(0, limit);
}

/**
 * Score bands are deliberately disjoint so the tier ordering
 * `exact > prefix > substring > subsequence` is a hard invariant, not a
 * consequence of a particular dilution. Any worst-case-in-tier score is still
 * strictly above every best-case in the tier below.
 *
 *   exact       = 1.0
 *   prefix      ∈ [0.80, 0.85]
 *   substring   ∈ [0.55, 0.70]
 *   subsequence ∈ [0.30, 0.50]
 */
const PREFIX_BASE = 0.85;
const PREFIX_MIN = 0.80;
const SUBSTRING_BASE = 0.70;
const SUBSTRING_MIN = 0.55;
const SUBSEQUENCE_BASE = 0.30;
const SUBSEQUENCE_SPAN = 0.20; // upper bound 0.50

function scoreCandidate(
  entity: IndexedEntity,
  qLower: string,
): FuzzySearchMatch | undefined {
  const name = entity.name;
  const nameLower = name.toLowerCase();
  if (nameLower === qLower) {
    return { entity, score: 1, reason: "exact" };
  }
  if (nameLower.startsWith(qLower)) {
    // Longer names diluted slightly so shorter matches rank higher,
    // but never drop below PREFIX_MIN.
    const raw = PREFIX_BASE - (nameLower.length - qLower.length) * 0.005;
    return { entity, score: Math.max(PREFIX_MIN, raw), reason: "prefix" };
  }
  const idx = nameLower.indexOf(qLower);
  if (idx > 0) {
    // Later positions score lower, but never drop below SUBSTRING_MIN so any
    // substring outranks any subsequence.
    const raw = SUBSTRING_BASE - (idx / nameLower.length) * 0.15;
    return { entity, score: Math.max(SUBSTRING_MIN, raw), reason: "substring" };
  }
  const subseq = subsequenceScore(nameLower, qLower);
  if (subseq !== undefined) {
    return { entity, score: subseq, reason: "subsequence" };
  }
  return undefined;
}

/**
 * Returns a score in `[SUBSEQUENCE_BASE, SUBSEQUENCE_BASE + SUBSEQUENCE_SPAN]`
 * — i.e. `[0.30, 0.50]` — when every character of `q` appears in `name` in
 * order (not necessarily contiguously). Denser matches (fewer gaps) score
 * higher. Returns `undefined` when `q` is not a subsequence of `name`.
 */
function subsequenceScore(name: string, q: string): number | undefined {
  if (q.length === 0) return undefined;
  if (q.length > name.length) return undefined;
  let i = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  for (let j = 0; j < name.length && i < q.length; j += 1) {
    if (name[j] === q[i]) {
      if (firstIdx === -1) firstIdx = j;
      lastIdx = j;
      i += 1;
    }
  }
  if (i !== q.length) return undefined;
  const span = lastIdx - firstIdx + 1;
  const density = q.length / span;
  return SUBSEQUENCE_BASE + Math.min(SUBSEQUENCE_SPAN, density * SUBSEQUENCE_SPAN);
}
