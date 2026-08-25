import { describe, expect, it } from "vitest";
import { findEntity } from "../../../src/core/query/findEntity";
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

function twoHostsProject(): {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  shovels: Shovel[];
  federations: FederationLink[];
  policies: Policy[];
} {
  const h1 = hostId("rabbit-a");
  const h2 = hostId("rabbit-b");
  const v1 = vhostId(h1, "/");
  const v1o = vhostId(h1, "orders");
  const v2 = vhostId(h2, "/");
  return {
    hosts: [
      { id: h1, name: "rabbit-a", sourceFiles: [] },
      { id: h2, name: "rabbit-b", sourceFiles: [] },
    ],
    vhosts: [
      { id: v1, hostId: h1, name: "/" },
      { id: v1o, hostId: h1, name: "orders" },
      { id: v2, hostId: h2, name: "/" },
    ],
    exchanges: [
      { id: exchangeId(v1, "orders.in"), hostId: h1, vhostId: v1, name: "orders.in", type: "topic" },
      { id: exchangeId(v1o, "orders.in"), hostId: h1, vhostId: v1o, name: "orders.in", type: "topic" },
      { id: exchangeId(v2, "orders.in"), hostId: h2, vhostId: v2, name: "orders.in", type: "topic" },
      // Same *name* as a queue below to exercise kind filtering.
      { id: exchangeId(v1, "audit"), hostId: h1, vhostId: v1, name: "audit", type: "fanout" },
    ],
    queues: [
      { id: queueId(v1, "audit"), hostId: h1, vhostId: v1, name: "audit" },
      { id: queueId(v1o, "audit"), hostId: h1, vhostId: v1o, name: "audit" },
    ],
    shovels: [],
    federations: [],
    policies: [],
  };
}

describe("findEntity — exact match, kind filtering", () => {
  const p = twoHostsProject();
  const idx = buildTopologyIndexes(p);

  it("finds every 'orders.in' exchange across hosts/vhosts and marks it ambiguous", () => {
    const r = findEntity(idx, "orders.in", { kind: "exchange" });
    expect(r.matches).toHaveLength(3);
    expect(r.ambiguous).toBe(true);
    expect(r.byVhost).toHaveLength(3);
    for (const m of r.matches) expect(m.kind).toBe("exchange");
  });

  it("kind='either' returns both exchange and queue named 'audit'", () => {
    const r = findEntity(idx, "audit");
    // 1 exchange in v1 + 1 queue in v1 + 1 queue in v1o = 3
    expect(r.matches).toHaveLength(3);
    const kinds = r.matches.map((m) => m.kind).sort();
    expect(kinds).toEqual(["exchange", "queue", "queue"]);
    expect(r.ambiguous).toBe(true);
  });

  it("kind='queue' returns only queue matches", () => {
    const r = findEntity(idx, "audit", { kind: "queue" });
    expect(r.matches).toHaveLength(2);
    for (const m of r.matches) expect(m.kind).toBe("queue");
  });

  it("kind='exchange' returns only exchange matches", () => {
    const r = findEntity(idx, "audit", { kind: "exchange" });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.kind).toBe("exchange");
    expect(r.ambiguous).toBe(false);
  });
});

describe("findEntity — host/vhost filtering", () => {
  const p = twoHostsProject();
  const idx = buildTopologyIndexes(p);

  it("host filter narrows results to entities on that host", () => {
    const r = findEntity(idx, "orders.in", { kind: "exchange", hostId: p.hosts[0]!.id });
    expect(r.matches).toHaveLength(2);
    for (const m of r.matches) expect(m.hostId).toBe(p.hosts[0]!.id);
  });

  it("vhost filter resolves ambiguity down to a single match", () => {
    const ordersVhost = p.vhosts.find((v) => v.name === "orders" && v.hostId === p.hosts[0]!.id)!;
    const r = findEntity(idx, "orders.in", {
      kind: "exchange",
      vhostId: ordersVhost.id,
    });
    expect(r.matches).toHaveLength(1);
    expect(r.ambiguous).toBe(false);
    expect(r.matches[0]!.vhostId).toBe(ordersVhost.id);
  });
});

describe("findEntity — no results", () => {
  const p = twoHostsProject();
  const idx = buildTopologyIndexes(p);

  it("returns an empty result with ambiguous=false when nothing matches", () => {
    const r = findEntity(idx, "does-not-exist");
    expect(r.matches).toEqual([]);
    expect(r.ambiguous).toBe(false);
    expect(r.byVhost).toEqual([]);
  });

  it("returns empty when the requested kind has no match even if the other kind does", () => {
    const r = findEntity(idx, "orders.in", { kind: "queue" });
    expect(r.matches).toEqual([]);
    expect(r.ambiguous).toBe(false);
  });
});

describe("findEntity — byVhost grouping", () => {
  const p = twoHostsProject();
  const idx = buildTopologyIndexes(p);

  it("groups matches by (hostId, vhostId)", () => {
    const r = findEntity(idx, "orders.in", { kind: "exchange" });
    for (const group of r.byVhost) {
      expect(group.entities).toHaveLength(1);
      expect(group.hostId).toBeDefined();
      expect(group.vhostId).toBeDefined();
    }
    const seenKeys = r.byVhost.map((g) => `${g.hostId}|${g.vhostId}`);
    expect(new Set(seenKeys).size).toBe(3);
  });
});
