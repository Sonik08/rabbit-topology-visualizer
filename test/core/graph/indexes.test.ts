import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTopologyIndexes } from "../../../src/core/graph/indexes";
import { parseDefinitionsExport } from "../../../src/core/parse/definitionsParser";
import { parseRuntimeParameters } from "../../../src/core/parse/runtimeParameters";
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

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", "..", "fixtures", "minimal-definitions.json");
const fixtureJson = JSON.parse(readFileSync(fixturePath, "utf-8"));

function tinyProject(): {
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
  const v2 = vhostId(h2, "/");
  const v1o = vhostId(h1, "orders");
  return {
    hosts: [
      { id: h1, name: "rabbit-a", sourceFiles: [] },
      { id: h2, name: "rabbit-b", sourceFiles: [] },
    ],
    vhosts: [
      { id: v1, hostId: h1, name: "/" },
      { id: v2, hostId: h2, name: "/" },
      { id: v1o, hostId: h1, name: "orders" },
    ],
    exchanges: [
      { id: exchangeId(v1, "orders.in"), hostId: h1, vhostId: v1, name: "orders.in", type: "topic" },
      { id: exchangeId(v2, "orders.in"), hostId: h2, vhostId: v2, name: "orders.in", type: "topic" },
      { id: exchangeId(v1o, "orders.in"), hostId: h1, vhostId: v1o, name: "orders.in", type: "topic" },
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

describe("buildTopologyIndexes — basic lookups", () => {
  const p = tinyProject();
  const idx = buildTopologyIndexes(p);

  it("resolves entities by their canonical id", () => {
    expect(idx.entityById(p.hosts[0]!.id)?.kind).toBe("host");
    expect(idx.entityById(p.exchanges[0]!.id)?.kind).toBe("exchange");
    expect(idx.entityById("nonexistent")).toBeUndefined();
  });

  it("finds every ambiguous match for a name shared across hosts and vhosts", () => {
    const matches = idx.entitiesByName("orders.in");
    expect(matches).toHaveLength(3);
    for (const m of matches) expect(m.kind).toBe("exchange");
  });

  it("filters by kind+name to disambiguate exchange vs queue", () => {
    const exs = idx.entitiesByKindAndName("exchange", "orders.in");
    expect(exs).toHaveLength(3);
    const qs = idx.entitiesByKindAndName("queue", "orders.in");
    expect(qs).toHaveLength(0);
  });

  it("groups entities by host", () => {
    const rabbitA = idx.entitiesByHost(p.hosts[0]!.id);
    // rabbit-a host itself + its 2 vhosts + 2 exchanges + 2 queues = 7
    expect(rabbitA).toHaveLength(1 + 2 + 2 + 2);
    for (const e of rabbitA) expect(e.hostId).toBe(p.hosts[0]!.id);
  });

  it("groups entities by vhost", () => {
    const ordersVhost = idx.entitiesByVhost(p.vhosts[2]!.id);
    // vhost itself + 1 exchange + 1 queue
    expect(ordersVhost).toHaveLength(3);
  });

  it("groups entities by kind", () => {
    expect(idx.entitiesByKind("host")).toHaveLength(2);
    expect(idx.entitiesByKind("vhost")).toHaveLength(3);
    expect(idx.entitiesByKind("exchange")).toHaveLength(3);
    expect(idx.entitiesByKind("queue")).toHaveLength(2);
    expect(idx.entitiesByKind("shovel")).toEqual([]);
    expect(idx.entitiesByKind("policy")).toEqual([]);
  });
});

describe("buildTopologyIndexes — return values are defensive copies", () => {
  it("mutating a returned array does not affect subsequent calls", () => {
    const idx = buildTopologyIndexes(tinyProject());
    const first = idx.entitiesByKind("exchange");
    first.pop();
    const second = idx.entitiesByKind("exchange");
    expect(second).toHaveLength(3);
  });
});

describe("buildTopologyIndexes — end-to-end with fixture", () => {
  it("indexes the sanitized fixture including runtime shovels + federations", () => {
    const parsed = parseDefinitionsExport({ json: fixtureJson, hostName: "rabbit-a" });
    const runtime = parseRuntimeParameters({
      hostId: parsed.host.id,
      vhosts: parsed.vhosts,
      parameters: parsed.rawParameters,
    });
    const idx = buildTopologyIndexes({
      hosts: [parsed.host],
      vhosts: parsed.vhosts,
      exchanges: parsed.exchanges,
      queues: parsed.queues,
      shovels: runtime.shovels,
      federations: runtime.federations,
      policies: parsed.policies,
    });

    expect(idx.entitiesByKind("exchange")).toHaveLength(5);
    expect(idx.entitiesByKind("queue")).toHaveLength(4);
    expect(idx.entitiesByKind("shovel").length).toBeGreaterThanOrEqual(1);
    expect(idx.entitiesByKind("federation").length).toBeGreaterThanOrEqual(1);
    expect(idx.entitiesByKind("policy")).toHaveLength(2);
    expect(idx.entitiesByKindAndName("exchange", "orders.in")).toHaveLength(1);
  });
});
