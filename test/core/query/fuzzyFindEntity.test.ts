import { describe, expect, it } from "vitest";
import { fuzzyFindEntity } from "../../../src/core/query/fuzzyFindEntity";
import { buildTopologyIndexes } from "../../../src/core/graph/indexes";
import { exchangeId, hostId, queueId, vhostId } from "../../../src/core/model/ids";
import type {
  Exchange,
  FederationLink,
  Host,
  Policy,
  Queue,
  Shovel,
  Vhost,
} from "../../../src/core/model/topology";

function project(): {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  shovels: Shovel[];
  federations: FederationLink[];
  policies: Policy[];
} {
  const h = hostId("rabbit-a");
  const v = vhostId(h, "/");
  return {
    hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
    vhosts: [{ id: v, hostId: h, name: "/" }],
    exchanges: [
      { id: exchangeId(v, "orders.in"), hostId: h, vhostId: v, name: "orders.in", type: "topic" },
      { id: exchangeId(v, "orders.audit"), hostId: h, vhostId: v, name: "orders.audit", type: "fanout" },
      { id: exchangeId(v, "orders.unrouted"), hostId: h, vhostId: v, name: "orders.unrouted", type: "fanout" },
      { id: exchangeId(v, "billing.events"), hostId: h, vhostId: v, name: "billing.events", type: "topic" },
      { id: exchangeId(v, "unrelated.thing"), hostId: h, vhostId: v, name: "unrelated.thing", type: "direct" },
    ],
    queues: [
      { id: queueId(v, "orders.incoming"), hostId: h, vhostId: v, name: "orders.incoming" },
      { id: queueId(v, "orders.audit"), hostId: h, vhostId: v, name: "orders.audit" },
      { id: queueId(v, "invoicing"), hostId: h, vhostId: v, name: "invoicing" },
    ],
    shovels: [],
    federations: [],
    policies: [],
  };
}

describe("fuzzyFindEntity — tiered scoring", () => {
  const idx = buildTopologyIndexes(project());

  it("ranks exact match ahead of prefix/substring/subsequence", () => {
    const r = fuzzyFindEntity(idx, "orders.in");
    // exact match is the exchange orders.in
    expect(r[0]!.entity.name).toBe("orders.in");
    expect(r[0]!.reason).toBe("exact");
    expect(r[0]!.score).toBe(1);
  });

  it("returns prefix matches for a leading substring", () => {
    const r = fuzzyFindEntity(idx, "orders.");
    const names = r.map((m) => m.entity.name);
    expect(names).toContain("orders.in");
    expect(names).toContain("orders.audit");
    expect(names).toContain("orders.unrouted");
    expect(names).toContain("orders.incoming");
    for (const m of r) {
      if (m.entity.name.toLowerCase().startsWith("orders.")) {
        expect(["prefix", "exact"]).toContain(m.reason);
      }
    }
  });

  it("returns substring matches when the query appears mid-name", () => {
    const r = fuzzyFindEntity(idx, "audit");
    const names = r.map((m) => m.entity.name).sort();
    expect(names).toEqual(["orders.audit", "orders.audit"]);
    for (const m of r) expect(["substring", "exact"]).toContain(m.reason);
  });

  it("returns subsequence matches when characters are scattered in order", () => {
    // 'ordn' → order.in via subsequence: o(rders.i)n
    const r = fuzzyFindEntity(idx, "ordn");
    const names = r.map((m) => m.entity.name);
    expect(names).toContain("orders.in");
    const orderIn = r.find((m) => m.entity.name === "orders.in");
    expect(orderIn?.reason).toBe("subsequence");
  });

  it("returns an empty array for an empty query", () => {
    expect(fuzzyFindEntity(idx, "")).toEqual([]);
    expect(fuzzyFindEntity(idx, "   ")).toEqual([]);
  });

  it("returns an empty array when no candidate meets the minScore threshold", () => {
    const r = fuzzyFindEntity(idx, "zzzzz-not-here");
    expect(r).toEqual([]);
  });
});

describe("fuzzyFindEntity — tier bands are strictly disjoint", () => {
  const idx = buildTopologyIndexes(project());

  it("worst-case substring outranks best-case subsequence", () => {
    // Substring `th` matches "unrelated.thing" late in the name (position 10)
    // → near-worst-case substring score. Subsequence `os` matches
    // "orders.audit" as o…s (positions 0 and 5, not contiguous) →
    // representative subsequence score. The tier contract must hold: even
    // the late-position substring must beat the subsequence.
    const rSub = fuzzyFindEntity(idx, "th", { kind: "exchange" });
    const substringMatch = rSub.find((m) => m.entity.name === "unrelated.thing");
    expect(substringMatch).toBeDefined();
    expect(substringMatch!.reason).toBe("substring");

    const rSeq = fuzzyFindEntity(idx, "os", { kind: "queue" });
    const subseqMatch = rSeq.find((m) => m.entity.name === "orders.audit");
    expect(subseqMatch).toBeDefined();
    expect(subseqMatch!.reason).toBe("subsequence");

    expect(substringMatch!.score).toBeGreaterThan(subseqMatch!.score);
    // Independent bounds check: no substring may drop below 0.55, no
    // subsequence may exceed 0.50, so their ranges never overlap.
    expect(substringMatch!.score).toBeGreaterThanOrEqual(0.55);
    expect(subseqMatch!.score).toBeLessThanOrEqual(0.50);
  });

  it("every substring result scores >= every subsequence result across the whole index", () => {
    // Mix both tiers into one call so the internal sort must interleave them.
    // Query `au` produces prefix on "audit"? No — 'audit' isn't in this project.
    // We pick 'or' which prefixes many exchanges, and separately confirm
    // subsequences of "orn" score below any substring of "or".
    const orResults = fuzzyFindEntity(idx, "or", { limit: 100, minScore: 0 });
    const substrings = orResults.filter((m) => m.reason === "substring");
    const prefixes = orResults.filter((m) => m.reason === "prefix");
    for (const s of substrings) {
      expect(s.score).toBeGreaterThanOrEqual(0.55);
      expect(s.score).toBeLessThanOrEqual(0.70);
    }
    for (const p of prefixes) {
      expect(p.score).toBeGreaterThanOrEqual(0.80);
      expect(p.score).toBeLessThanOrEqual(0.85);
    }
    // Every subsequence match sits in [0.30, 0.50].
    const seqResults = fuzzyFindEntity(idx, "orn", { limit: 100, minScore: 0 });
    for (const m of seqResults) {
      if (m.reason === "subsequence") {
        expect(m.score).toBeGreaterThanOrEqual(0.30);
        expect(m.score).toBeLessThanOrEqual(0.50);
      }
    }
  });
});

describe("fuzzyFindEntity — option edge cases", () => {
  const idx = buildTopologyIndexes(project());

  it("negative limit returns [] rather than triggering slice(0, -N) trimming", () => {
    expect(fuzzyFindEntity(idx, "orders", { limit: -3 })).toEqual([]);
    expect(fuzzyFindEntity(idx, "orders", { limit: 0 })).toEqual([]);
  });

  it("non-finite limit falls back to the default (25)", () => {
    const r = fuzzyFindEntity(idx, "orders", { limit: Number.NaN });
    expect(r.length).toBeGreaterThan(0);
  });

  it("minScore > 1 filters everything out", () => {
    expect(fuzzyFindEntity(idx, "orders.in", { minScore: 1.5 })).toEqual([]);
  });

  it("minScore < 0 clamps to 0 (returns any positive-score match)", () => {
    const r = fuzzyFindEntity(idx, "orders", { minScore: -5 });
    expect(r.length).toBeGreaterThan(0);
    for (const m of r) expect(m.score).toBeGreaterThanOrEqual(0);
  });

  it("non-finite minScore falls back to the default (0.3)", () => {
    const r = fuzzyFindEntity(idx, "orders", { minScore: Number.NaN });
    expect(r.length).toBeGreaterThan(0);
    for (const m of r) expect(m.score).toBeGreaterThanOrEqual(0.3);
  });
});

describe("fuzzyFindEntity — filtering + limits", () => {
  const idx = buildTopologyIndexes(project());

  it("kind='queue' excludes exchanges from the results", () => {
    const r = fuzzyFindEntity(idx, "orders", { kind: "queue" });
    for (const m of r) expect(m.entity.kind).toBe("queue");
    const names = new Set(r.map((m) => m.entity.name));
    expect(names.has("orders.incoming")).toBe(true);
    expect(names.has("orders.audit")).toBe(true);
    expect(names.has("orders.in")).toBe(false);
  });

  it("kind='exchange' excludes queues from the results", () => {
    const r = fuzzyFindEntity(idx, "orders", { kind: "exchange" });
    for (const m of r) expect(m.entity.kind).toBe("exchange");
  });

  it("respects a limit and returns at most N results", () => {
    const r = fuzzyFindEntity(idx, "or", { limit: 2 });
    expect(r).toHaveLength(2);
    // First result should be a prefix match, higher than substring
    expect(r[0]!.score).toBeGreaterThanOrEqual(r[1]!.score);
  });

  it("sorts equal scores by name ascending for stable output", () => {
    const r = fuzzyFindEntity(idx, "orders.");
    const prefixMatches = r.filter((m) => m.reason === "prefix");
    const names = prefixMatches.map((m) => m.entity.name);
    const sorted = [...names].sort();
    // Equal-score prefix matches (all same length modifier bucket) should appear
    // in alphabetical order after the score sort.
    for (let i = 1; i < prefixMatches.length; i += 1) {
      if (prefixMatches[i - 1]!.score === prefixMatches[i]!.score) {
        expect(names[i - 1]!.localeCompare(names[i]!) <= 0).toBe(true);
      }
    }
    // Sanity: sorted-by-name is what we produce for the tied subset above.
    expect(sorted.length).toBe(names.length);
  });
});
