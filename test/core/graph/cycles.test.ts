import { describe, expect, it } from "vitest";
import { findCycles } from "../../../src/core/graph/cycles";
import { buildGraph } from "../../../src/core/graph/buildGraph";
import { upstreamForQueue } from "../../../src/core/graph/traversal";
import { exchangeId, hostId, queueId, vhostId } from "../../../src/core/model/ids";
import type {
  Binding,
  Exchange,
  FederationLink,
  Host,
  Queue,
  Shovel,
  Vhost,
} from "../../../src/core/model/topology";

interface P {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  shovels: Shovel[];
  federations: FederationLink[];
}

function tinyProject(): P {
  const h = hostId("rabbit-a");
  const v = vhostId(h, "/");
  return {
    hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
    vhosts: [{ id: v, hostId: h, name: "/" }],
    exchanges: [],
    queues: [],
    bindings: [],
    shovels: [],
    federations: [],
  };
}

describe("findCycles — no cycles", () => {
  it("returns [] for a DAG (exchange → exchange → queue)", () => {
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xIn = exchangeId(v, "x.in");
    const xMid = exchangeId(v, "x.mid");
    const q = queueId(v, "q.out");
    const p: P = {
      ...tinyProject(),
      exchanges: [
        { id: xIn, hostId: h, vhostId: v, name: "x.in", type: "topic" },
        { id: xMid, hostId: h, vhostId: v, name: "x.mid", type: "topic" },
      ],
      queues: [{ id: q, hostId: h, vhostId: v, name: "q.out" }],
      bindings: [
        { id: "e1", hostId: h, vhostId: v, sourceExchangeId: xIn, destinationId: xMid, destinationType: "exchange", routingKey: "" },
        { id: "e2", hostId: h, vhostId: v, sourceExchangeId: xMid, destinationId: q, destinationType: "queue", routingKey: "" },
      ],
    };
    const graph = buildGraph(p);
    expect(findCycles(graph)).toEqual([]);
  });
});

describe("findCycles — two-node cycle", () => {
  it("detects a cycle when x.a binds to x.b and x.b binds back to x.a", () => {
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xA = exchangeId(v, "x.a");
    const xB = exchangeId(v, "x.b");
    const p: P = {
      ...tinyProject(),
      exchanges: [
        { id: xA, hostId: h, vhostId: v, name: "x.a", type: "topic" },
        { id: xB, hostId: h, vhostId: v, name: "x.b", type: "topic" },
      ],
      bindings: [
        { id: "ab", hostId: h, vhostId: v, sourceExchangeId: xA, destinationId: xB, destinationType: "exchange", routingKey: "" },
        { id: "ba", hostId: h, vhostId: v, sourceExchangeId: xB, destinationId: xA, destinationType: "exchange", routingKey: "" },
      ],
    };
    const graph = buildGraph(p);
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.nodeIds.sort()).toEqual([xA, xB].sort());
    expect(cycles[0]!.witness.edgeIds).toHaveLength(2);
    // Every witness edge id must be one of the two bindings, no self-references.
    for (const eid of cycles[0]!.witness.edgeIds) expect(["ab", "ba"]).toContain(eid);
    // Witness nodes/edges must line up: consecutive nodeIds joined by matching edges.
    expect(cycles[0]!.witness.nodeIds.length).toBe(cycles[0]!.witness.edgeIds.length);
  });
});

describe("findCycles — three-node cycle", () => {
  it("detects a → b → c → a", () => {
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xA = exchangeId(v, "x.a");
    const xB = exchangeId(v, "x.b");
    const xC = exchangeId(v, "x.c");
    const p: P = {
      ...tinyProject(),
      exchanges: [
        { id: xA, hostId: h, vhostId: v, name: "x.a", type: "topic" },
        { id: xB, hostId: h, vhostId: v, name: "x.b", type: "topic" },
        { id: xC, hostId: h, vhostId: v, name: "x.c", type: "topic" },
      ],
      bindings: [
        { id: "ab", hostId: h, vhostId: v, sourceExchangeId: xA, destinationId: xB, destinationType: "exchange", routingKey: "" },
        { id: "bc", hostId: h, vhostId: v, sourceExchangeId: xB, destinationId: xC, destinationType: "exchange", routingKey: "" },
        { id: "ca", hostId: h, vhostId: v, sourceExchangeId: xC, destinationId: xA, destinationType: "exchange", routingKey: "" },
      ],
    };
    const graph = buildGraph(p);
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.nodeIds.length).toBe(3);
    expect(new Set(cycles[0]!.nodeIds)).toEqual(new Set([xA, xB, xC]));
    expect(cycles[0]!.witness.nodeIds.length).toBe(3);
    expect(cycles[0]!.witness.edgeIds.length).toBe(3);
  });
});

describe("findCycles — non-Hamiltonian SCC (branching)", () => {
  it("reports the full SCC in nodeIds and a valid sub-cycle in witness", () => {
    // A↔B and A↔C. SCC = {A, B, C} but no simple cycle visits all three;
    // the witness should be a 2-node cycle like A → B → A.
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xA = exchangeId(v, "x.a");
    const xB = exchangeId(v, "x.b");
    const xC = exchangeId(v, "x.c");
    const p: P = {
      ...tinyProject(),
      exchanges: [
        { id: xA, hostId: h, vhostId: v, name: "x.a", type: "topic" },
        { id: xB, hostId: h, vhostId: v, name: "x.b", type: "topic" },
        { id: xC, hostId: h, vhostId: v, name: "x.c", type: "topic" },
      ],
      bindings: [
        { id: "ab", hostId: h, vhostId: v, sourceExchangeId: xA, destinationId: xB, destinationType: "exchange", routingKey: "" },
        { id: "ba", hostId: h, vhostId: v, sourceExchangeId: xB, destinationId: xA, destinationType: "exchange", routingKey: "" },
        { id: "ac", hostId: h, vhostId: v, sourceExchangeId: xA, destinationId: xC, destinationType: "exchange", routingKey: "" },
        { id: "ca", hostId: h, vhostId: v, sourceExchangeId: xC, destinationId: xA, destinationType: "exchange", routingKey: "" },
      ],
    };
    const graph = buildGraph(p);
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(1);
    // SCC contains all three nodes.
    expect(new Set(cycles[0]!.nodeIds)).toEqual(new Set([xA, xB, xC]));
    // Witness is a valid simple cycle: same length of nodes and edges, and
    // every consecutive pair (including the wrap) is joined by the reported edge.
    const witness = cycles[0]!.witness;
    expect(witness.nodeIds.length).toBe(witness.edgeIds.length);
    expect(witness.nodeIds.length).toBeGreaterThanOrEqual(2);
    // Cycle must be simple: no repeated nodes.
    expect(new Set(witness.nodeIds).size).toBe(witness.nodeIds.length);
    // Every witness edge id refers to an actual edge, and the from/to align
    // with consecutive nodeIds (with wraparound closing back to nodeIds[0]).
    const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
    for (let i = 0; i < witness.edgeIds.length; i += 1) {
      const e = edgeById.get(witness.edgeIds[i]!);
      expect(e).toBeDefined();
      expect(e!.from).toBe(witness.nodeIds[i]);
      expect(e!.to).toBe(witness.nodeIds[(i + 1) % witness.nodeIds.length]);
    }
  });

  it("reports a valid witness for two disjoint 2-cycles inside a single SCC via a shared bridge", () => {
    // A↔B, A↔C, and B↔C so the SCC is {A, B, C} with multiple simple cycles.
    // Witness must be one valid simple cycle regardless of which the DFS picks.
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xA = exchangeId(v, "x.a");
    const xB = exchangeId(v, "x.b");
    const xC = exchangeId(v, "x.c");
    const p: P = {
      ...tinyProject(),
      exchanges: [
        { id: xA, hostId: h, vhostId: v, name: "x.a", type: "topic" },
        { id: xB, hostId: h, vhostId: v, name: "x.b", type: "topic" },
        { id: xC, hostId: h, vhostId: v, name: "x.c", type: "topic" },
      ],
      bindings: [
        { id: "ab", hostId: h, vhostId: v, sourceExchangeId: xA, destinationId: xB, destinationType: "exchange", routingKey: "" },
        { id: "ba", hostId: h, vhostId: v, sourceExchangeId: xB, destinationId: xA, destinationType: "exchange", routingKey: "" },
        { id: "ac", hostId: h, vhostId: v, sourceExchangeId: xA, destinationId: xC, destinationType: "exchange", routingKey: "" },
        { id: "ca", hostId: h, vhostId: v, sourceExchangeId: xC, destinationId: xA, destinationType: "exchange", routingKey: "" },
        { id: "bc", hostId: h, vhostId: v, sourceExchangeId: xB, destinationId: xC, destinationType: "exchange", routingKey: "" },
        { id: "cb", hostId: h, vhostId: v, sourceExchangeId: xC, destinationId: xB, destinationType: "exchange", routingKey: "" },
      ],
    };
    const graph = buildGraph(p);
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0]!.nodeIds)).toEqual(new Set([xA, xB, xC]));
    const witness = cycles[0]!.witness;
    expect(new Set(witness.nodeIds).size).toBe(witness.nodeIds.length);
    expect(witness.edgeIds.length).toBe(witness.nodeIds.length);
  });
});

describe("findCycles — self-loop", () => {
  it("detects a single exchange binding to itself", () => {
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xLoop = exchangeId(v, "x.loop");
    const p: P = {
      ...tinyProject(),
      exchanges: [{ id: xLoop, hostId: h, vhostId: v, name: "x.loop", type: "topic" }],
      bindings: [
        { id: "self", hostId: h, vhostId: v, sourceExchangeId: xLoop, destinationId: xLoop, destinationType: "exchange", routingKey: "loop" },
      ],
    };
    const graph = buildGraph(p);
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.nodeIds).toEqual([xLoop]);
    expect(cycles[0]!.witness.nodeIds).toEqual([xLoop]);
    expect(cycles[0]!.witness.edgeIds).toEqual(["self"]);
  });
});

describe("findCycles — cross-host cycle via federation", () => {
  it("detects a routing cycle that spans two hosts through a federation link", () => {
    // Closed loop: x.a → x.b via bind (rabbit-a internal)
    //              x.b → x.remote via shovel (rabbit-a → rabbit-b)
    //              x.remote → x.a via federation (rabbit-b → rabbit-a)
    const hA = hostId("rabbit-a");
    const hB = hostId("rabbit-b");
    const vA = vhostId(hA, "/");
    const vB = vhostId(hB, "/");
    const xA = exchangeId(vA, "x.a");
    const xB = exchangeId(vA, "x.b");
    const xRemote = exchangeId(vB, "x.remote");
    const p: P = {
      hosts: [
        { id: hA, name: "rabbit-a", sourceFiles: [] },
        { id: hB, name: "rabbit-b", sourceFiles: [] },
      ],
      vhosts: [
        { id: vA, hostId: hA, name: "/" },
        { id: vB, hostId: hB, name: "/" },
      ],
      exchanges: [
        { id: xA, hostId: hA, vhostId: vA, name: "x.a", type: "topic" },
        { id: xB, hostId: hA, vhostId: vA, name: "x.b", type: "topic" },
        { id: xRemote, hostId: hB, vhostId: vB, name: "x.remote", type: "topic" },
      ],
      queues: [],
      bindings: [
        { id: "ab", hostId: hA, vhostId: vA, sourceExchangeId: xA, destinationId: xB, destinationType: "exchange", routingKey: "" },
      ],
      shovels: [
        {
          id: "shovel:out",
          hostId: hA,
          vhostId: vA,
          name: "out",
          // x.b (rabbit-a) → x.remote (rabbit-b)
          source: { host: "rabbit-a", vhost: "/", exchange: "x.b" },
          destination: { host: "rabbit-b", vhost: "/", exchange: "x.remote" },
        },
      ],
      federations: [
        {
          id: "federation:back",
          hostId: hA,
          vhostId: vA,
          name: "back",
          // x.remote (rabbit-b) → x.a (rabbit-a), closing the loop.
          upstream: { host: "rabbit-b", vhost: "/", exchange: "x.remote" },
          downstream: { host: "rabbit-a", vhost: "/", exchange: "x.a" },
        },
      ],
    };
    const graph = buildGraph(p);
    const cycles = findCycles(graph);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    // The SCC must include the three exchanges and the shovel + federation
    // nodes that carry the flow between hosts.
    const allNodes = new Set(cycles.flatMap((c) => c.nodeIds));
    expect(allNodes.has(xA)).toBe(true);
    expect(allNodes.has(xB)).toBe(true);
    expect(allNodes.has(xRemote)).toBe(true);
    expect(allNodes.has("shovel:out")).toBe(true);
    expect(allNodes.has("federation:back")).toBe(true);
  });
});

describe("findCycles — restricted edge kinds", () => {
  it("does not report a cycle formed only by dead-letter + binds when dead-letter is excluded", () => {
    // Default edge kinds exclude dead-letter, so a q → x.dlx → q "loop" via
    // dead-letter is NOT a routing cycle.
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xDlx = exchangeId(v, "x.dlx");
    const q = queueId(v, "q.jobs");
    const p: P = {
      ...tinyProject(),
      exchanges: [{ id: xDlx, hostId: h, vhostId: v, name: "x.dlx", type: "fanout" }],
      queues: [
        {
          id: q,
          hostId: h,
          vhostId: v,
          name: "q.jobs",
          deadLetterExchange: "x.dlx",
        },
      ],
      bindings: [
        { id: "back", hostId: h, vhostId: v, sourceExchangeId: xDlx, destinationId: q, destinationType: "queue", routingKey: "" },
      ],
    };
    const graph = buildGraph(p);
    // With default edge kinds: dead-letter excluded → no cycle.
    expect(findCycles(graph)).toEqual([]);
    // Opt in: include dead-letter → a cycle q → x.dlx → q surfaces.
    const withDlx = findCycles(graph, {
      edgeKinds: new Set(["binds", "dead-letter"] as const),
    });
    expect(withDlx.length).toBe(1);
    expect(new Set(withDlx[0]!.nodeIds)).toEqual(new Set([q, xDlx]));
  });
});

describe("findCycles — dense SCC witness stays fast (O(V+E))", () => {
  // A complete directed graph K_n on n=30 exchanges is a single SCC of size 30
  // with n*(n-1) = 870 edges. Under a path-tracking DFS witness search this
  // would fan out combinatorially before finding a cycle; under the BFS
  // globally-visited implementation it completes in a handful of ms because
  // every node/edge is visited at most once.
  it("finds a witness in a complete digraph K_30 in under 100 ms", () => {
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const N = 30;
    const exchanges: Exchange[] = [];
    for (let i = 0; i < N; i += 1) {
      exchanges.push({
        id: exchangeId(v, `x.${i}`),
        hostId: h,
        vhostId: v,
        name: `x.${i}`,
        type: "topic",
      });
    }
    const bindings: Binding[] = [];
    for (let i = 0; i < N; i += 1) {
      for (let j = 0; j < N; j += 1) {
        if (i === j) continue;
        bindings.push({
          id: `e-${i}-${j}`,
          hostId: h,
          vhostId: v,
          sourceExchangeId: exchanges[i]!.id,
          destinationId: exchanges[j]!.id,
          destinationType: "exchange",
          routingKey: "",
        });
      }
    }
    const p: P = { ...tinyProject(), exchanges, bindings };
    const graph = buildGraph(p);

    const start = performance.now();
    const cycles = findCycles(graph);
    const ms = performance.now() - start;

    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.nodeIds.length).toBe(N);
    // Shortest cycle through the deterministic start is length 2 in K_n.
    expect(cycles[0]!.witness.nodeIds.length).toBe(2);
    expect(cycles[0]!.witness.edgeIds.length).toBe(2);
    expect(ms).toBeLessThan(100);
  });
});

describe("upstream traversal + max-depth: existing behaviour still bounds walks", () => {
  it("respects maxDepth over a very deep chain (regression pin)", () => {
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const chain: Exchange[] = [];
    for (let i = 0; i < 50; i += 1) {
      chain.push({
        id: exchangeId(v, `x.${i}`),
        hostId: h,
        vhostId: v,
        name: `x.${i}`,
        type: "topic",
      });
    }
    const q = queueId(v, "q.tail");
    const bindings: Binding[] = [];
    for (let i = 0; i < 49; i += 1) {
      bindings.push({
        id: `bind-${i}`,
        hostId: h,
        vhostId: v,
        sourceExchangeId: chain[i]!.id,
        destinationId: chain[i + 1]!.id,
        destinationType: "exchange",
        routingKey: "",
      });
    }
    bindings.push({
      id: "bind-tail",
      hostId: h,
      vhostId: v,
      sourceExchangeId: chain[49]!.id,
      destinationId: q,
      destinationType: "queue",
      routingKey: "",
    });
    const p: P = {
      ...tinyProject(),
      exchanges: chain,
      queues: [{ id: q, hostId: h, vhostId: v, name: "q.tail" }],
      bindings,
    };
    const graph = buildGraph(p);

    // Default depth 32 cuts before reaching the head.
    const rDefault = upstreamForQueue(graph, q);
    expect(rDefault.truncated).toBe(true);
    expect(rDefault.reachableAncestorIds.length).toBeLessThanOrEqual(32);

    // Wide-enough depth reaches the entire chain (50 exchanges).
    const rDeep = upstreamForQueue(graph, q, { maxDepth: 100 });
    expect(rDeep.truncated).toBe(false);
    expect(rDeep.reachableAncestorIds.length).toBe(50);
  });
});
