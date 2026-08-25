import { describe, expect, it } from "vitest";
import { upstreamForQueue } from "../../../src/core/graph/traversal";
import { buildGraph } from "../../../src/core/graph/buildGraph";
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

function chainProject(): {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  shovels: Shovel[];
  federations: FederationLink[];
} {
  const h = hostId("rabbit-a");
  const v = vhostId(h, "/");
  const xIn = exchangeId(v, "x.in");
  const xMid = exchangeId(v, "x.mid");
  const xAudit = exchangeId(v, "x.audit");
  const qOne = queueId(v, "q.one");
  const qAudit = queueId(v, "q.audit");
  return {
    hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
    vhosts: [{ id: v, hostId: h, name: "/" }],
    exchanges: [
      { id: xIn, hostId: h, vhostId: v, name: "x.in", type: "topic" },
      { id: xMid, hostId: h, vhostId: v, name: "x.mid", type: "topic" },
      { id: xAudit, hostId: h, vhostId: v, name: "x.audit", type: "fanout" },
    ],
    queues: [
      { id: qOne, hostId: h, vhostId: v, name: "q.one" },
      { id: qAudit, hostId: h, vhostId: v, name: "q.audit" },
    ],
    bindings: [
      // x.in → x.mid (exchange-to-exchange)
      {
        id: "b1",
        hostId: h,
        vhostId: v,
        sourceExchangeId: xIn,
        destinationId: xMid,
        destinationType: "exchange",
        routingKey: "orders.*",
      },
      // x.mid → q.one
      {
        id: "b2",
        hostId: h,
        vhostId: v,
        sourceExchangeId: xMid,
        destinationId: qOne,
        destinationType: "queue",
        routingKey: "orders.new",
      },
      // x.audit → q.audit (independent branch)
      {
        id: "b3",
        hostId: h,
        vhostId: v,
        sourceExchangeId: xAudit,
        destinationId: qAudit,
        destinationType: "queue",
        routingKey: "",
      },
    ],
    shovels: [],
    federations: [],
  };
}

describe("upstreamForQueue — chain of exchange→exchange→queue", () => {
  const p = chainProject();
  const graph = buildGraph(p);

  it("finds both upstream exchanges as ancestors of the queue", () => {
    const qOneId = p.queues[0]!.id;
    const r = upstreamForQueue(graph, qOneId);
    expect(r.targetNodeId).toBe(qOneId);
    expect(r.reachableAncestorIds).toContain(p.exchanges[0]!.id); // x.in
    expect(r.reachableAncestorIds).toContain(p.exchanges[1]!.id); // x.mid
    expect(r.truncated).toBe(false);
  });

  it("returns a representative path from the root source (x.in) to the target", () => {
    const qOneId = p.queues[0]!.id;
    const r = upstreamForQueue(graph, qOneId);
    const rootPath = r.paths.find((path) => path.sourceNodeId === p.exchanges[0]!.id);
    expect(rootPath).toBeDefined();
    // The path should traverse x.in → x.mid → q.one
    const nodesOnPath = [rootPath!.sourceNodeId, ...rootPath!.steps.map((s) => s.toNodeId)];
    expect(nodesOnPath).toEqual([
      p.exchanges[0]!.id,
      p.exchanges[1]!.id,
      qOneId,
    ]);
    expect(rootPath!.steps.map((s) => s.kind)).toEqual(["binds", "binds"]);
  });

  it("does not include ancestors from an unrelated branch", () => {
    const qOneId = p.queues[0]!.id;
    const r = upstreamForQueue(graph, qOneId);
    expect(r.reachableAncestorIds).not.toContain(p.exchanges[2]!.id); // x.audit
  });
});

describe("upstreamForQueue — options", () => {
  const p = chainProject();
  const graph = buildGraph(p);

  it("returns empty when the target id is not a queue", () => {
    const notAQueue = p.exchanges[0]!.id;
    const r = upstreamForQueue(graph, notAQueue);
    expect(r.reachableAncestorIds).toEqual([]);
    expect(r.paths).toEqual([]);
  });

  it("returns empty when the target id doesn't exist", () => {
    const r = upstreamForQueue(graph, "queue:does-not-exist");
    expect(r.reachableAncestorIds).toEqual([]);
  });

  it("respects maxDepth by truncating deeper branches", () => {
    const qOneId = p.queues[0]!.id;
    const r = upstreamForQueue(graph, qOneId, { maxDepth: 1 });
    // With depth 1 we can reach x.mid but not x.in
    expect(r.reachableAncestorIds).toContain(p.exchanges[1]!.id);
    expect(r.reachableAncestorIds).not.toContain(p.exchanges[0]!.id);
    expect(r.truncated).toBe(true);
  });
});

describe("upstreamForQueue — shovel + external endpoint", () => {
  it("walks through shovel edges and up into external sources", () => {
    const p = chainProject();
    // Add a shovel: external.example.internal:orders.out → x.in
    p.shovels.push({
      id: "shovel:sx",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "sx",
      source: { host: "remote.example.internal", exchange: "orders.out" },
      destination: {
        host: "rabbit-a",
        vhost: "/",
        exchange: "x.in",
      },
    });
    const graph = buildGraph(p);

    const qOneId = p.queues[0]!.id;
    const r = upstreamForQueue(graph, qOneId);

    // The shovel node itself should be reachable, and an external node.
    expect(r.reachableAncestorIds.some((id) => id === "shovel:sx")).toBe(true);
    expect(r.reachableAncestorIds.some((id) => id.startsWith("external:"))).toBe(true);
  });
});

describe("upstreamForQueue — diamond graph", () => {
  it("reaches shared ancestor only once even when two branches lead to it", () => {
    // A → B, A → C, B → D (queue), C → D (queue). Root A is a shared ancestor.
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xA = exchangeId(v, "x.A");
    const xB = exchangeId(v, "x.B");
    const xC = exchangeId(v, "x.C");
    const qD = queueId(v, "q.D");
    const p = {
      hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
      vhosts: [{ id: v, hostId: h, name: "/" }],
      exchanges: [
        { id: xA, hostId: h, vhostId: v, name: "x.A", type: "topic" },
        { id: xB, hostId: h, vhostId: v, name: "x.B", type: "topic" },
        { id: xC, hostId: h, vhostId: v, name: "x.C", type: "topic" },
      ],
      queues: [{ id: qD, hostId: h, vhostId: v, name: "q.D" }],
      bindings: [
        { id: "ab", hostId: h, vhostId: v, sourceExchangeId: xA, destinationId: xB, destinationType: "exchange" as const, routingKey: "" },
        { id: "ac", hostId: h, vhostId: v, sourceExchangeId: xA, destinationId: xC, destinationType: "exchange" as const, routingKey: "" },
        { id: "bd", hostId: h, vhostId: v, sourceExchangeId: xB, destinationId: qD, destinationType: "queue" as const, routingKey: "" },
        { id: "cd", hostId: h, vhostId: v, sourceExchangeId: xC, destinationId: qD, destinationType: "queue" as const, routingKey: "" },
      ],
      shovels: [],
      federations: [],
    };
    const graph = buildGraph(p);
    const r = upstreamForQueue(graph, qD);
    // BFS with global visited expands each node once — A appears once.
    expect(r.reachableAncestorIds).toEqual(expect.arrayContaining([xA, xB, xC]));
    // Exactly one representative path per source; only A is a true source.
    const sources = r.paths.map((path) => path.sourceNodeId);
    expect(sources).toEqual([xA]);
    // A visited once via B or C — the second branch marks it as a diamond.
    expect(r.visitedCycles).toContain(xA);
  });
});

describe("upstreamForQueue — alternate-exchange edges", () => {
  it("reverse-follows alternate-exchange when the alt-exchange feeds a queue", () => {
    // x.main declares alternate-exchange x.alt; x.alt binds to q.leftovers.
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xMain = exchangeId(v, "x.main");
    const xAlt = exchangeId(v, "x.alt");
    const qLeft = queueId(v, "q.leftovers");
    const p = {
      hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
      vhosts: [{ id: v, hostId: h, name: "/" }],
      exchanges: [
        { id: xMain, hostId: h, vhostId: v, name: "x.main", type: "direct", alternateExchange: "x.alt" },
        { id: xAlt, hostId: h, vhostId: v, name: "x.alt", type: "fanout" },
      ],
      queues: [{ id: qLeft, hostId: h, vhostId: v, name: "q.leftovers" }],
      bindings: [
        { id: "altq", hostId: h, vhostId: v, sourceExchangeId: xAlt, destinationId: qLeft, destinationType: "queue" as const, routingKey: "" },
      ],
      shovels: [],
      federations: [],
    };
    const graph = buildGraph(p);
    const r = upstreamForQueue(graph, qLeft);
    // The queue's ancestry: x.alt (via binds) and x.main (via alternate-exchange).
    expect(r.reachableAncestorIds).toContain(xAlt);
    expect(r.reachableAncestorIds).toContain(xMain);
    const kinds = new Set(r.paths.flatMap((path) => path.steps.map((s) => s.kind)));
    expect(kinds.has("alternate-exchange")).toBe(true);
    expect(kinds.has("binds")).toBe(true);
  });
});

describe("upstreamForQueue — federation edges", () => {
  it("reverse-walks federation edges into the federation node and its upstream", () => {
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xIn = exchangeId(v, "x.in");
    const qOne = queueId(v, "q.one");
    const p = {
      hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
      vhosts: [{ id: v, hostId: h, name: "/" }],
      exchanges: [{ id: xIn, hostId: h, vhostId: v, name: "x.in", type: "topic" }],
      queues: [{ id: qOne, hostId: h, vhostId: v, name: "q.one" }],
      bindings: [
        { id: "xq", hostId: h, vhostId: v, sourceExchangeId: xIn, destinationId: qOne, destinationType: "queue" as const, routingKey: "" },
      ],
      shovels: [],
      federations: [
        {
          id: "federation:local/fed",
          hostId: h,
          vhostId: v,
          name: "fed",
          upstream: { host: "remote.example.internal", vhost: "/", exchange: "orders.out" },
          downstream: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
        },
      ],
    };
    const graph = buildGraph(p);
    const r = upstreamForQueue(graph, qOne);
    expect(r.reachableAncestorIds).toContain("federation:local/fed");
    expect(r.reachableAncestorIds.some((id) => id.startsWith("external:"))).toBe(true);
    const kinds = new Set(r.paths.flatMap((path) => path.steps.map((s) => s.kind)));
    expect(kinds.has("federates")).toBe(true);
  });
});

describe("upstreamForQueue — dead-letter opt-in", () => {
  it("does not follow dead-letter edges by default", () => {
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xJobs = exchangeId(v, "x.jobs");
    const qJobs = queueId(v, "q.jobs");
    const xDlx = exchangeId(v, "x.dlx");
    const qDead = queueId(v, "q.dead");
    const p = {
      hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
      vhosts: [{ id: v, hostId: h, name: "/" }],
      exchanges: [
        { id: xJobs, hostId: h, vhostId: v, name: "x.jobs", type: "direct" },
        { id: xDlx, hostId: h, vhostId: v, name: "x.dlx", type: "fanout" },
      ],
      queues: [
        {
          id: qJobs,
          hostId: h,
          vhostId: v,
          name: "q.jobs",
          deadLetterExchange: "x.dlx",
        },
        { id: qDead, hostId: h, vhostId: v, name: "q.dead" },
      ],
      bindings: [
        { id: "xj", hostId: h, vhostId: v, sourceExchangeId: xJobs, destinationId: qJobs, destinationType: "queue" as const, routingKey: "" },
        { id: "xdlx", hostId: h, vhostId: v, sourceExchangeId: xDlx, destinationId: qDead, destinationType: "queue" as const, routingKey: "" },
      ],
      shovels: [],
      federations: [],
    };
    const graph = buildGraph(p);

    // Default: q.dead's only upstream is x.dlx via `binds`. The dead-letter
    // edge (q.jobs → x.dlx) is NOT followed, so q.jobs is not an ancestor.
    const rDefault = upstreamForQueue(graph, qDead);
    expect(rDefault.reachableAncestorIds).toContain(xDlx);
    expect(rDefault.reachableAncestorIds).not.toContain(qJobs);

    // Opt-in: with followDeadLetter=true, q.jobs (and its own upstream x.jobs)
    // become ancestors of q.dead via the reversed dead-letter edge.
    const rWithDlx = upstreamForQueue(graph, qDead, { followDeadLetter: true });
    expect(rWithDlx.reachableAncestorIds).toContain(qJobs);
    expect(rWithDlx.reachableAncestorIds).toContain(xJobs);
    const kinds = new Set(rWithDlx.paths.flatMap((path) => path.steps.map((s) => s.kind)));
    expect(kinds.has("dead-letter")).toBe(true);
  });
});

describe("upstreamForQueue — invalid maxDepth values are normalized", () => {
  const p = chainProject();
  const graph = buildGraph(p);
  const qOneId = p.queues[0]!.id;

  it("undefined/NaN/Infinity all fall back to the default depth", () => {
    const rBaseline = upstreamForQueue(graph, qOneId);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = upstreamForQueue(graph, qOneId, { maxDepth: bad });
      expect(r.reachableAncestorIds).toEqual(rBaseline.reachableAncestorIds);
      expect(r.truncated).toBe(false);
    }
  });

  it("negative maxDepth clamps to 0 and marks the result truncated", () => {
    const r = upstreamForQueue(graph, qOneId, { maxDepth: -5 });
    expect(r.reachableAncestorIds).toEqual([]);
    expect(r.truncated).toBe(true);
  });

  it("fractional maxDepth is floored", () => {
    // 1.9 → 1: only q.one's direct upstream (x.mid) reached.
    const r = upstreamForQueue(graph, qOneId, { maxDepth: 1.9 });
    expect(r.reachableAncestorIds).toContain(p.exchanges[1]!.id);
    expect(r.reachableAncestorIds).not.toContain(p.exchanges[0]!.id);
    expect(r.truncated).toBe(true);
  });
});

describe("upstreamForQueue — cycle guard", () => {
  it("does not infinite-loop when an exchange binds back into a cycle", () => {
    const p = chainProject();
    // Add a cycle: x.mid → x.in
    p.bindings.push({
      id: "b-cycle",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      sourceExchangeId: p.exchanges[1]!.id,
      destinationId: p.exchanges[0]!.id,
      destinationType: "exchange",
      routingKey: "back",
    });
    const graph = buildGraph(p);
    const qOneId = p.queues[0]!.id;
    const r = upstreamForQueue(graph, qOneId, { maxDepth: 32 });
    expect(r.reachableAncestorIds).toContain(p.exchanges[0]!.id);
    expect(r.reachableAncestorIds).toContain(p.exchanges[1]!.id);
    // The cycle guard should have recorded that we saw a loop back into x.in
    // (or x.mid depending on order of traversal) somewhere.
    expect(r.visitedCycles.length).toBeGreaterThan(0);
  });
});
