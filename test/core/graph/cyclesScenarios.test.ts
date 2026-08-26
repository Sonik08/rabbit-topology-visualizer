import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildGraph } from "../../../src/core/graph/buildGraph";
import { findCycles } from "../../../src/core/graph/cycles";
import { parseDefinitionsExport } from "../../../src/core/parse/definitionsParser";
import { parseRuntimeParameters } from "../../../src/core/parse/runtimeParameters";
import type {
  Binding,
  Exchange,
  FederationLink,
  Host,
  Queue,
  Shovel,
  Vhost,
} from "../../../src/core/model/topology";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", "..", "fixtures", "minimal-definitions.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

interface Project {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  shovels: Shovel[];
  federations: FederationLink[];
}

function tinyRing(size: number): Project {
  // n exchanges in a ring x0 → x1 → … → x(n-1) → x0
  const nodes: Exchange[] = [];
  const edges: Binding[] = [];
  const hId = "host:ring" as unknown as Host["id"];
  const vId = "vhost:ring:/" as unknown as Vhost["id"];
  for (let i = 0; i < size; i += 1) {
    const id = (`exchange:ring:x${i}` as unknown) as Exchange["id"];
    nodes.push({ id, hostId: hId, vhostId: vId, name: `x${i}`, type: "topic" });
  }
  for (let i = 0; i < size; i += 1) {
    const from = nodes[i]!.id;
    const to = nodes[(i + 1) % size]!.id;
    edges.push({
      id: `b:x${i}->x${(i + 1) % size}`,
      hostId: hId,
      vhostId: vId,
      sourceExchangeId: from,
      destinationId: to,
      destinationType: "exchange",
      routingKey: `k${i}`,
    });
  }
  return {
    hosts: [{ id: hId, name: "ring", sourceFiles: [] }],
    vhosts: [{ id: vId, hostId: hId, name: "/" }],
    exchanges: nodes,
    queues: [],
    bindings: edges,
    shovels: [],
    federations: [],
  };
}

describe("findCycles — scenario: fixture minimal-definitions.json is acyclic", () => {
  it("returns [] for the sanitized fixture (no routing cycles exist)", () => {
    const parsed = parseDefinitionsExport({ json: fixture, hostName: "example-host" });
    const runtime = parseRuntimeParameters({
      hostId: parsed.host.id,
      vhosts: parsed.vhosts,
      parameters: parsed.rawParameters,
    });
    const graph = buildGraph({
      hosts: [parsed.host],
      vhosts: parsed.vhosts,
      exchanges: parsed.exchanges,
      queues: parsed.queues,
      bindings: parsed.bindings,
      shovels: runtime.shovels,
      federations: runtime.federations,
    });
    expect(findCycles(graph)).toEqual([]);
  });
});

describe("findCycles — scenario: N-length ring reports one SCC covering every node", () => {
  it("N=4 ring produces one Cycle whose nodeIds cover the whole ring", () => {
    const graph = buildGraph(tinyRing(4));
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.nodeIds).toHaveLength(4);
    // Every ring node appears in the reported SCC.
    for (let i = 0; i < 4; i += 1) {
      expect(cycles[0]!.nodeIds).toContain(`exchange:ring:x${i}`);
    }
    // Witness pairs must form a closed walk.
    const witnessNodes = cycles[0]!.witness.nodeIds;
    expect(witnessNodes.length).toBeGreaterThanOrEqual(2);
    // Every witness edge must actually exist in the input graph.
    for (const eid of cycles[0]!.witness.edgeIds) {
      expect(graph.edges.some((e) => e.id === eid)).toBe(true);
    }
  });

  it("N=8 ring stays O(V+E) — completes well under 50 ms and reports one SCC", () => {
    const graph = buildGraph(tinyRing(8));
    const t0 = performance.now();
    const cycles = findCycles(graph);
    const elapsed = performance.now() - t0;
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.nodeIds).toHaveLength(8);
    expect(elapsed).toBeLessThan(50);
  });
});

describe("findCycles — scenario: two disjoint cycles produce two independent SCC reports", () => {
  it("A↔B alongside C↔D yields two distinct Cycle entries", () => {
    const project: Project = {
      hosts: [{ id: "host:m" as unknown as Host["id"], name: "m", sourceFiles: [] }],
      vhosts: [{ id: "vhost:m:/" as unknown as Vhost["id"], hostId: "host:m" as unknown as Host["id"], name: "/" }],
      exchanges: (["a", "b", "c", "d"] as const).map((n) => ({
        id: `exchange:m:${n}` as unknown as Exchange["id"],
        hostId: "host:m" as unknown as Host["id"],
        vhostId: "vhost:m:/" as unknown as Vhost["id"],
        name: n,
        type: "topic",
      })),
      queues: [],
      bindings: [
        binding("a", "b"),
        binding("b", "a"),
        binding("c", "d"),
        binding("d", "c"),
      ],
      shovels: [],
      federations: [],
    };
    const graph = buildGraph(project);
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(2);
    const sortedSccs = cycles.map((c) => c.nodeIds.slice().sort()).sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
    expect(sortedSccs[0]).toEqual(["exchange:m:a", "exchange:m:b"]);
    expect(sortedSccs[1]).toEqual(["exchange:m:c", "exchange:m:d"]);
  });
});

describe("findCycles — scenario: cycle broken when routing edges are excluded", () => {
  it("A↔B cycle formed only by `binds` edges disappears when edgeKinds excludes `binds`", () => {
    const project: Project = {
      hosts: [{ id: "host:x" as unknown as Host["id"], name: "x", sourceFiles: [] }],
      vhosts: [{ id: "vhost:x:/" as unknown as Vhost["id"], hostId: "host:x" as unknown as Host["id"], name: "/" }],
      exchanges: [
        { id: "exchange:x:a" as unknown as Exchange["id"], hostId: "host:x" as unknown as Host["id"], vhostId: "vhost:x:/" as unknown as Vhost["id"], name: "a", type: "topic" },
        { id: "exchange:x:b" as unknown as Exchange["id"], hostId: "host:x" as unknown as Host["id"], vhostId: "vhost:x:/" as unknown as Vhost["id"], name: "b", type: "topic" },
      ],
      queues: [],
      bindings: [
        {
          id: "b:a->b",
          hostId: "host:x" as unknown as Host["id"],
          vhostId: "vhost:x:/" as unknown as Vhost["id"],
          sourceExchangeId: "exchange:x:a" as unknown as Exchange["id"],
          destinationId: "exchange:x:b" as unknown as Exchange["id"],
          destinationType: "exchange",
          routingKey: "",
        },
        {
          id: "b:b->a",
          hostId: "host:x" as unknown as Host["id"],
          vhostId: "vhost:x:/" as unknown as Vhost["id"],
          sourceExchangeId: "exchange:x:b" as unknown as Exchange["id"],
          destinationId: "exchange:x:a" as unknown as Exchange["id"],
          destinationType: "exchange",
          routingKey: "",
        },
      ],
      shovels: [],
      federations: [],
    };
    const graph = buildGraph(project);
    // Baseline: default edge kinds include `binds` → the cycle IS detected.
    expect(findCycles(graph).length).toBe(1);
    // Restricted: exclude `binds` → no cycle can form.
    expect(
      findCycles(graph, { edgeKinds: new Set(["routes", "alternate-exchange", "shovels", "federates"]) }).length,
    ).toBe(0);
  });
});

describe("findCycles — scenario: input isolation (no dangling edges cross into unknown ids)", () => {
  it("ignores edges pointing at ids not in the node set (returns [] for a stray-edge-only input)", () => {
    const cycles = findCycles({
      nodes: [{ id: "exchange:only", kind: "exchange", label: "only" }],
      edges: [
        // Both endpoints are unknown → edge filtered out entirely.
        { id: "b:ghost->ghost", from: "ghost:1", to: "ghost:2", kind: "binds" },
        // Half-dangling — filtered because `from` is unknown.
        { id: "b:ghost->only", from: "ghost:1", to: "exchange:only", kind: "binds" },
      ],
    });
    expect(cycles).toEqual([]);
  });
});

function binding(from: string, to: string): Binding {
  return {
    id: `b:${from}->${to}`,
    hostId: "host:m" as unknown as Host["id"],
    vhostId: "vhost:m:/" as unknown as Vhost["id"],
    sourceExchangeId: `exchange:m:${from}` as unknown as Exchange["id"],
    destinationId: `exchange:m:${to}` as unknown as Exchange["id"],
    destinationType: "exchange",
    routingKey: "",
  };
}
