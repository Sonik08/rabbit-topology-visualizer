import { describe, expect, it } from "vitest";
import { buildGraph } from "../../../src/core/graph/buildGraph";
import { bidirectionalForNode } from "../../../src/core/graph/traversal";
import {
  explainDownstreamPath,
  explainUpstreamPath,
} from "../../../src/core/query/pathExplain";
import {
  exchangeId,
  hostId,
  queueId,
  vhostId,
} from "../../../src/core/model/ids";
import type {
  Binding,
  Exchange,
  FederationLink,
  Host,
  Queue,
  Shovel,
  Vhost,
} from "../../../src/core/model/topology";

/**
 * End-to-end regression for task 40's "flow explorer" acceptance scenario:
 *   q50 → shovel1 → exchange1 → exchange3 → queue40 → shovel2 →
 *     exchange4 → queue1 → shovel3 → exchange5 → queue30
 *
 * Cross-vhost + cross-host structure so the "across every loaded host and
 * vhost" requirement is exercised:
 *   host-a / vhost /            : q50, exchange1, exchange3, queue40, shovel1, shovel2
 *   host-a / vhost analytics    : exchange4, queue1, shovel3
 *   host-b / vhost /            : exchange5, queue30
 *
 * Task acceptance: selecting an entity in the MIDDLE of the chain (queue1)
 * MUST expose all applicable routes in BOTH directions across vhosts —
 * upstream must walk back to q50 through the queue40 shovel and the
 * exchange chain on host-a, downstream must reach queue30 on host-b
 * through shovel3 + exchange5. This test locks in that the existing
 * bidirectional-traversal engine already satisfies the specific chain the
 * task calls out, so any future refactor that breaks the multi-hop
 * cross-vhost path fails this regression instead of degrading silently.
 */

interface ChainProject {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  shovels: Shovel[];
  federations: FederationLink[];
}

/**
 * Build the exact 11-hop chain from the task spec. IDs are canonical so a
 * shovel/binding wiring bug would surface as a missing id in the
 * bidirectional result, not as a subtle label mismatch.
 */
function chainFixture(): {
  project: ChainProject;
  ids: {
    hA: string;
    hB: string;
    vHostASlash: string;
    vHostAAnalytics: string;
    vHostBSlash: string;
    q50: string;
    x1: string;
    x3: string;
    q40: string;
    x4: string;
    q1: string;
    x5: string;
    q30: string;
    shovel1: string;
    shovel2: string;
    shovel3: string;
  };
} {
  const hA = hostId("rabbit-a");
  const hB = hostId("rabbit-b");
  const vAslash = vhostId(hA, "/");
  const vAanalytics = vhostId(hA, "analytics");
  const vBslash = vhostId(hB, "/");

  const q50 = queueId(vAslash, "q50");
  const x1 = exchangeId(vAslash, "exchange1");
  const x3 = exchangeId(vAslash, "exchange3");
  const q40 = queueId(vAslash, "queue40");
  const x4 = exchangeId(vAanalytics, "exchange4");
  const q1 = queueId(vAanalytics, "queue1");
  const x5 = exchangeId(vBslash, "exchange5");
  const q30 = queueId(vBslash, "queue30");

  const shovel1 = "shovel:rabbit-a/vhost:rabbit-a:/:shovel1";
  const shovel2 = "shovel:rabbit-a/vhost:rabbit-a:/:shovel2";
  const shovel3 = "shovel:rabbit-a/vhost:rabbit-a:analytics:shovel3";

  const project: ChainProject = {
    hosts: [
      { id: hA, name: "rabbit-a", sourceFiles: [] },
      { id: hB, name: "rabbit-b", sourceFiles: [] },
    ],
    vhosts: [
      { id: vAslash, hostId: hA, name: "/" },
      { id: vAanalytics, hostId: hA, name: "analytics" },
      { id: vBslash, hostId: hB, name: "/" },
    ],
    exchanges: [
      { id: x1, hostId: hA, vhostId: vAslash, name: "exchange1", type: "topic" },
      { id: x3, hostId: hA, vhostId: vAslash, name: "exchange3", type: "topic" },
      { id: x4, hostId: hA, vhostId: vAanalytics, name: "exchange4", type: "topic" },
      { id: x5, hostId: hB, vhostId: vBslash, name: "exchange5", type: "topic" },
    ],
    queues: [
      { id: q50, hostId: hA, vhostId: vAslash, name: "q50" },
      { id: q40, hostId: hA, vhostId: vAslash, name: "queue40" },
      { id: q1, hostId: hA, vhostId: vAanalytics, name: "queue1" },
      { id: q30, hostId: hB, vhostId: vBslash, name: "queue30" },
    ],
    bindings: [
      // exchange1 → exchange3 (e2e binding on host-a/)
      {
        id: "b:x1->x3",
        hostId: hA,
        vhostId: vAslash,
        sourceExchangeId: x1,
        destinationId: x3,
        destinationType: "exchange",
        routingKey: "orders.#",
      },
      // exchange3 → queue40 (host-a/)
      {
        id: "b:x3->q40",
        hostId: hA,
        vhostId: vAslash,
        sourceExchangeId: x3,
        destinationId: q40,
        destinationType: "queue",
        routingKey: "orders.new",
      },
      // exchange4 → queue1 (host-a/analytics)
      {
        id: "b:x4->q1",
        hostId: hA,
        vhostId: vAanalytics,
        sourceExchangeId: x4,
        destinationId: q1,
        destinationType: "queue",
        routingKey: "audit.#",
      },
      // exchange5 → queue30 (host-b/)
      {
        id: "b:x5->q30",
        hostId: hB,
        vhostId: vBslash,
        sourceExchangeId: x5,
        destinationId: q30,
        destinationType: "queue",
        routingKey: "archive.*",
      },
    ],
    shovels: [
      // shovel1: q50 → exchange1 (host-a/)
      {
        id: shovel1,
        hostId: hA,
        vhostId: vAslash,
        name: "shovel1",
        source: { host: "rabbit-a", vhost: "/", queue: "q50" },
        destination: { host: "rabbit-a", vhost: "/", exchange: "exchange1" },
      },
      // shovel2: queue40 (host-a/) → exchange4 (host-a/analytics — cross-vhost)
      {
        id: shovel2,
        hostId: hA,
        vhostId: vAslash,
        name: "shovel2",
        source: { host: "rabbit-a", vhost: "/", queue: "queue40" },
        destination: { host: "rabbit-a", vhost: "analytics", exchange: "exchange4" },
      },
      // shovel3: queue1 (host-a/analytics) → exchange5 (host-b/ — cross-host+vhost)
      {
        id: shovel3,
        hostId: hA,
        vhostId: vAanalytics,
        name: "shovel3",
        source: { host: "rabbit-a", vhost: "analytics", queue: "queue1" },
        destination: { host: "rabbit-b", vhost: "/", exchange: "exchange5" },
      },
    ],
    federations: [],
  };

  return {
    project,
    ids: {
      hA,
      hB,
      vHostASlash: vAslash,
      vHostAAnalytics: vAanalytics,
      vHostBSlash: vBslash,
      q50,
      x1,
      x3,
      q40,
      x4,
      q1,
      x5,
      q30,
      shovel1,
      shovel2,
      shovel3,
    },
  };
}

describe("flow explorer end-to-end (task 40 acceptance chain q50 → … → queue30)", () => {
  it("selecting queue1 in the MIDDLE of the chain exposes all applicable upstream AND downstream routes across every participating vhost", () => {
    const { project, ids } = chainFixture();
    const graph = buildGraph(project);
    const input = { nodes: graph.nodes, edges: graph.edges };

    const result = bidirectionalForNode(input, ids.q1, { maxDepth: 32 });

    // Sanity: target is the middle queue on host-a/analytics.
    expect(result.targetNodeId).toBe(ids.q1);

    // ── Upstream: every hop from q1 back to q50 must be reachable ────────
    // Chain upstream from queue1:
    //   queue1 ← exchange4 ← shovel2 ← queue40 ← exchange3 ← exchange1 ← shovel1 ← q50
    const upIds = new Set(result.upstream.reachableAncestorIds);
    for (const id of [
      ids.x4,
      ids.shovel2,
      ids.q40,
      ids.x3,
      ids.x1,
      ids.shovel1,
      ids.q50,
    ]) {
      expect(upIds.has(id)).toBe(true);
    }
    // Structural containers (host/vhost) MUST NOT appear in the routing-
    // edge ancestry set — the traversal follows routing edges only.
    expect(upIds.has(ids.hA)).toBe(false);
    expect(upIds.has(ids.vHostASlash)).toBe(false);

    // The ultimate upstream source is q50 (its BFS parent chain is empty
    // because q50 has no incoming routing edge).
    const q50Path = result.upstream.paths.find((p) => p.sourceNodeId === ids.q50);
    expect(q50Path).toBeDefined();
    // Path steps walk source → target in message-flow order.
    const upEdgeIds = q50Path!.steps.map((s) => s.edgeId);
    expect(upEdgeIds).toEqual([
      `shovel-in:${ids.shovel1}<-${ids.q50}`,
      `shovel-out:${ids.shovel1}->${ids.x1}`,
      "b:x1->x3",
      "b:x3->q40",
      `shovel-in:${ids.shovel2}<-${ids.q40}`,
      `shovel-out:${ids.shovel2}->${ids.x4}`,
      "b:x4->q1",
    ]);
    // Cross-vhost hop — shovel2 destination vhost (analytics) differs
    // from its source vhost (/) — appears somewhere on the upstream path.
    expect(
      q50Path!.steps.some(
        (s) =>
          s.edgeId === `shovel-out:${ids.shovel2}->${ids.x4}` &&
          s.kind === "shovels",
      ),
    ).toBe(true);

    // ── Downstream: q1 → q30 across the shovel3/exchange5 hop ────────────
    const downIds = new Set(result.downstream.reachableDescendantIds);
    for (const id of [ids.shovel3, ids.x5, ids.q30]) {
      expect(downIds.has(id)).toBe(true);
    }
    const q30Path = result.downstream.paths.find(
      (p) => p.sinkNodeId === ids.q30,
    );
    expect(q30Path).toBeDefined();
    const downEdgeIds = q30Path!.steps.map((s) => s.edgeId);
    expect(downEdgeIds).toEqual([
      `shovel-in:${ids.shovel3}<-${ids.q1}`,
      `shovel-out:${ids.shovel3}->${ids.x5}`,
      "b:x5->q30",
    ]);
    // Cross-host hop: shovel3's destination lives on host-b, distinct
    // from queue1's host (host-a).
    const x5Node = graph.nodes.find((n) => n.id === ids.x5);
    expect(x5Node?.data).toBeDefined();
    expect((x5Node!.data as { hostId?: string }).hostId).toBe(ids.hB);

    // Neither direction was cut off by the depth cap on this 8-hop chain.
    expect(result.upstream.truncated).toBe(false);
    expect(result.downstream.truncated).toBe(false);
  });

  it("path explanations for the middle-of-chain selection surface each hop in message-flow order with binding routing-key context", () => {
    const { project, ids } = chainFixture();
    const graph = buildGraph(project);
    const input = { nodes: graph.nodes, edges: graph.edges };
    const result = bidirectionalForNode(input, ids.q1, { maxDepth: 32 });
    const q50Path = result.upstream.paths.find((p) => p.sourceNodeId === ids.q50)!;
    const upExpl = explainUpstreamPath(q50Path, ids.q1, graph.nodes);
    // First hop describes shovel1 carrying messages OUT of q50.
    expect(upExpl.steps[0]!.sentence).toContain("shovel");
    expect(upExpl.steps[0]!.sentence).toContain("q50");
    // The exchange1 → exchange3 hop must mention the topic routing key so
    // the operator sees WHY the routing occurred (not just that it did).
    const x1x3Step = upExpl.steps.find((s) => s.edgeId === "b:x1->x3")!;
    expect(x1x3Step.sentence).toContain("orders.#");
    // The exchange3 → queue40 hop mentions the more specific routing key.
    const x3q40Step = upExpl.steps.find((s) => s.edgeId === "b:x3->q40")!;
    expect(x3q40Step.sentence).toContain("orders.new");
    // Downstream: shovel3 carries messages from queue1 to exchange5 on
    // rabbit-b, which then binds to queue30 via the archive.* pattern.
    const q30Path = result.downstream.paths.find(
      (p) => p.sinkNodeId === ids.q30,
    )!;
    const downExpl = explainDownstreamPath(q30Path, ids.q1, graph.nodes);
    expect(downExpl.steps[0]!.sentence).toContain("shovel");
    expect(downExpl.steps[0]!.sentence).toContain("queue1");
    const x5q30Step = downExpl.steps.find((s) => s.edgeId === "b:x5->q30")!;
    expect(x5q30Step.sentence).toContain("archive.*");
  });

  it("selecting the ultimate downstream sink (queue30) walks upstream through EVERY hop of the chain including both cross-vhost shovel transitions", () => {
    const { project, ids } = chainFixture();
    const graph = buildGraph(project);
    const input = { nodes: graph.nodes, edges: graph.edges };
    const result = bidirectionalForNode(input, ids.q30, { maxDepth: 32 });
    const upIds = new Set(result.upstream.reachableAncestorIds);
    // Every non-structural node on the chain reaches queue30 upstream.
    for (const id of [
      ids.x5,
      ids.shovel3,
      ids.q1,
      ids.x4,
      ids.shovel2,
      ids.q40,
      ids.x3,
      ids.x1,
      ids.shovel1,
      ids.q50,
    ]) {
      expect(upIds.has(id)).toBe(true);
    }
    // Downstream from a terminal sink is empty (no outgoing routing edges).
    expect(result.downstream.reachableDescendantIds).toEqual([]);
    expect(result.downstream.paths).toEqual([]);
  });

  it("selecting the source queue (q50) walks downstream through EVERY hop of the chain to queue30 on host-b", () => {
    const { project, ids } = chainFixture();
    const graph = buildGraph(project);
    const input = { nodes: graph.nodes, edges: graph.edges };
    const result = bidirectionalForNode(input, ids.q50, { maxDepth: 32 });
    const downIds = new Set(result.downstream.reachableDescendantIds);
    for (const id of [
      ids.shovel1,
      ids.x1,
      ids.x3,
      ids.q40,
      ids.shovel2,
      ids.x4,
      ids.q1,
      ids.shovel3,
      ids.x5,
      ids.q30,
    ]) {
      expect(downIds.has(id)).toBe(true);
    }
    // Upstream from the source publisher is empty.
    expect(result.upstream.reachableAncestorIds).toEqual([]);
    expect(result.upstream.paths).toEqual([]);
    // The downstream path to queue30 spans EVERY vhost that participates.
    const q30Path = result.downstream.paths.find(
      (p) => p.sinkNodeId === ids.q30,
    );
    expect(q30Path).toBeDefined();
    const stepNodeIds = new Set<string>();
    for (const s of q30Path!.steps) {
      stepNodeIds.add(s.fromNodeId);
      stepNodeIds.add(s.toNodeId);
    }
    // At least one node from each participating vhost appears on the path.
    expect(
      graph.nodes.some(
        (n) =>
          (n.data as { vhostId?: string }).vhostId === ids.vHostASlash &&
          stepNodeIds.has(n.id),
      ),
    ).toBe(true);
    expect(
      graph.nodes.some(
        (n) =>
          (n.data as { vhostId?: string }).vhostId === ids.vHostAAnalytics &&
          stepNodeIds.has(n.id),
      ),
    ).toBe(true);
    expect(
      graph.nodes.some(
        (n) =>
          (n.data as { vhostId?: string }).vhostId === ids.vHostBSlash &&
          stepNodeIds.has(n.id),
      ),
    ).toBe(true);
  });

  it("depth truncation on the chain is reported instead of silently dropping upstream hops", () => {
    const { project, ids } = chainFixture();
    const graph = buildGraph(project);
    const input = { nodes: graph.nodes, edges: graph.edges };
    // Cap depth well below the 7-hop upstream chain from q1 back to q50.
    const result = bidirectionalForNode(input, ids.q1, { maxDepth: 2 });
    expect(result.upstream.truncated).toBe(true);
    // The nearest two upstream hops (exchange4 + shovel2) are reachable;
    // deeper hops (queue40, exchange3, exchange1, shovel1, q50) are cut
    // off but the truncated flag surfaces the incompleteness to the UI.
    const upIds = new Set(result.upstream.reachableAncestorIds);
    expect(upIds.has(ids.x4)).toBe(true);
    expect(upIds.has(ids.shovel2)).toBe(true);
    expect(upIds.has(ids.q50)).toBe(false);
  });
});
