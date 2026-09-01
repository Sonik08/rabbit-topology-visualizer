import { describe, expect, it } from "vitest";
import {
  bidirectionalForNode,
  traverseDownstream,
} from "../../../src/core/graph/traversal";
import type { GraphEdge, GraphNode } from "../../../src/core/model";

/**
 * Fixture representing the task 58 canonical example:
 *
 *   exchange:x1 → exchange:x2 → shovel:s1 → exchange:x3 → queue:q1
 *
 * plus a fan-out branch (`exchange:x2 → queue:q.branch`) so branch
 * preservation is observable in the bidirectional expansion, and an
 * unrelated `exchange:noise → queue:noise` pair the traversal must NOT
 * touch. `contains` edges are included to prove they are ignored by every
 * routing traversal — matching the task's "structural edges never
 * participate" contract.
 */
function chainFixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    { id: "host:a", kind: "host", label: "a", data: { id: "host:a", name: "a", sourceFiles: [] } },
    { id: "vhost:a:/", kind: "vhost", label: "/", data: { id: "vhost:a:/", hostId: "host:a", name: "/" } },
    { id: "exchange:x1", kind: "exchange", label: "x1", data: { hostId: "host:a", vhostId: "vhost:a:/" } },
    { id: "exchange:x2", kind: "exchange", label: "x2", data: { hostId: "host:a", vhostId: "vhost:a:/" } },
    { id: "exchange:x3", kind: "exchange", label: "x3", data: { hostId: "host:a", vhostId: "vhost:a:/" } },
    { id: "shovel:s1", kind: "shovel", label: "s1", data: { hostId: "host:a", vhostId: "vhost:a:/" } },
    { id: "queue:q1", kind: "queue", label: "q1", data: { hostId: "host:a", vhostId: "vhost:a:/" } },
    { id: "queue:q.branch", kind: "queue", label: "q.branch", data: { hostId: "host:a", vhostId: "vhost:a:/" } },
    { id: "exchange:noise", kind: "exchange", label: "noise", data: { hostId: "host:a", vhostId: "vhost:a:/" } },
    { id: "queue:noise", kind: "queue", label: "noise", data: { hostId: "host:a", vhostId: "vhost:a:/" } },
  ];
  const edges: GraphEdge[] = [
    { id: "c:host->vhost", from: "host:a", to: "vhost:a:/", kind: "contains" },
    { id: "c:v->x1", from: "vhost:a:/", to: "exchange:x1", kind: "contains" },
    { id: "c:v->x2", from: "vhost:a:/", to: "exchange:x2", kind: "contains" },
    { id: "c:v->x3", from: "vhost:a:/", to: "exchange:x3", kind: "contains" },
    { id: "c:v->s1", from: "vhost:a:/", to: "shovel:s1", kind: "contains" },
    { id: "c:v->q1", from: "vhost:a:/", to: "queue:q1", kind: "contains" },
    { id: "c:v->branch", from: "vhost:a:/", to: "queue:q.branch", kind: "contains" },
    { id: "c:v->noise", from: "vhost:a:/", to: "exchange:noise", kind: "contains" },
    { id: "c:v->qnoise", from: "vhost:a:/", to: "queue:noise", kind: "contains" },
    { id: "b:x1->x2", from: "exchange:x1", to: "exchange:x2", kind: "binds", routingKey: "k" },
    { id: "b:x2->s1", from: "exchange:x2", to: "shovel:s1", kind: "binds", routingKey: "k" },
    { id: "s:s1->x3", from: "shovel:s1", to: "exchange:x3", kind: "shovels" },
    { id: "b:x3->q1", from: "exchange:x3", to: "queue:q1", kind: "binds", routingKey: "k" },
    { id: "b:x2->branch", from: "exchange:x2", to: "queue:q.branch", kind: "binds", routingKey: "k" },
    // Unrelated pair — never reachable from the chain.
    { id: "b:noise", from: "exchange:noise", to: "queue:noise", kind: "binds", routingKey: "n" },
  ];
  return { nodes, edges };
}

describe("traverseDownstream — mirror of traverseUpstream, forward direction", () => {
  it("walks outgoing routing edges from an exchange to every reachable sink through shovels and exchange-to-exchange bindings", () => {
    const input = chainFixture();
    const r = traverseDownstream(input, "exchange:x2");
    // Descendants must include both branches of the fan-out — the shovel
    // chain to queue:q1 AND the direct binding to queue:q.branch — while
    // never touching the unrelated noise pair.
    expect(new Set(r.reachableDescendantIds)).toEqual(
      new Set([
        "shovel:s1",
        "exchange:x3",
        "queue:q1",
        "queue:q.branch",
      ]),
    );
    // Two sink paths reported (queue:q1 and queue:q.branch); the shovel is
    // a mid-chain node not a sink.
    const sinks = r.paths.map((p) => p.sinkNodeId).sort();
    expect(sinks).toEqual(["queue:q.branch", "queue:q1"]);
    // Path to queue:q1 threads exchange:x2 → shovel:s1 → exchange:x3 →
    // queue:q1 in reader order (target-first).
    const toQ1 = r.paths.find((p) => p.sinkNodeId === "queue:q1")!;
    expect(toQ1.steps.map((s) => s.edgeId)).toEqual([
      "b:x2->s1",
      "s:s1->x3",
      "b:x3->q1",
    ]);
    // No structural `contains` edge participates.
    for (const path of r.paths) {
      for (const step of path.steps) {
        expect(step.kind).not.toBe("contains");
      }
    }
  });

  it("`maxDepth` truncates the walk and flags the result", () => {
    const input = chainFixture();
    const r = traverseDownstream(input, "exchange:x2", { maxDepth: 1 });
    // Only the immediate neighbors (shovel:s1 + queue:q.branch) reachable.
    expect(new Set(r.reachableDescendantIds)).toEqual(
      new Set(["shovel:s1", "queue:q.branch"]),
    );
    expect(r.truncated).toBe(true);
  });

  it("is cycle-safe: an edge that revisits an already-seen node is recorded but not re-expanded", () => {
    const input = chainFixture();
    // Add a cycle: exchange:x3 → exchange:x2 (feedback loop).
    input.edges.push({
      id: "b:x3->x2",
      from: "exchange:x3",
      to: "exchange:x2",
      kind: "binds",
      routingKey: "loop",
    });
    const r = traverseDownstream(input, "exchange:x2");
    // The traversal must terminate and note the cycle.
    expect(r.visitedCycles.length).toBeGreaterThan(0);
    // Every reachable descendant is still enumerated exactly once.
    const unique = new Set(r.reachableDescendantIds);
    expect(unique.size).toBe(r.reachableDescendantIds.length);
  });

  it("closed-cycle reach emits representative paths (regression for reach>0 with paths=0 in a cyclic descendant set)", () => {
    // Isolated exchange↔queue cycle with no exit — a reachable closed loop
    // where the only descendants are all on the cycle itself. Before the
    // BFS-tree-leaf fix, `reachableDescendantIds` was populated but `paths`
    // was empty, which contradicted the highlight rendering.
    const nodes: GraphNode[] = [
      { id: "exchange:cy1", kind: "exchange", label: "cy1", data: {} },
      { id: "queue:cy1", kind: "queue", label: "cy1", data: {} },
    ];
    const edges: GraphEdge[] = [
      { id: "b:cy1->q", from: "exchange:cy1", to: "queue:cy1", kind: "binds", routingKey: "k" },
      // Closes the cycle: queue → exchange (unusual but modelled by shovels
      // and federation). Use `shovels` kind so it survives the routing filter.
      { id: "s:q->cy1", from: "queue:cy1", to: "exchange:cy1", kind: "shovels" },
    ];
    const r = traverseDownstream({ nodes, edges }, "exchange:cy1");
    expect(new Set(r.reachableDescendantIds)).toEqual(new Set(["queue:cy1"]));
    // The cycle-back was observed.
    expect(r.visitedCycles).toContain("exchange:cy1");
    // Representative path is emitted for the BFS-tree leaf so the operator
    // has SOMETHING to read next to the non-empty highlight.
    expect(r.paths.length).toBeGreaterThan(0);
    const sinkIds = r.paths.map((p) => p.sinkNodeId).sort();
    expect(sinkIds).toEqual(["queue:cy1"]);
    // The representative path traces target → queue via the one binding.
    const path = r.paths[0]!;
    expect(path.steps.map((s) => s.edgeId)).toEqual(["b:cy1->q"]);
  });
});

describe("bidirectionalForNode — combined upstream + downstream traversal", () => {
  it("selecting a MID-CHAIN exchange exposes BOTH incoming (upstream) and outgoing (downstream) reach — the task 58 exchange-in-the-middle scenario", () => {
    const input = chainFixture();
    const r = bidirectionalForNode(input, "exchange:x2");
    expect(r.upstream.reachableAncestorIds).toEqual(["exchange:x1"]);
    expect(new Set(r.downstream.reachableDescendantIds)).toEqual(
      new Set([
        "shovel:s1",
        "exchange:x3",
        "queue:q1",
        "queue:q.branch",
      ]),
    );
  });

  it("selecting a SHOVEL — one of the task-required entry-point kinds — walks the incoming exchange chain AND the outgoing destination queue", () => {
    const input = chainFixture();
    const r = bidirectionalForNode(input, "shovel:s1");
    // Upstream from the shovel reaches exchange:x2 → exchange:x1.
    expect(new Set(r.upstream.reachableAncestorIds)).toEqual(
      new Set(["exchange:x2", "exchange:x1"]),
    );
    // Downstream from the shovel reaches exchange:x3 → queue:q1.
    expect(new Set(r.downstream.reachableDescendantIds)).toEqual(
      new Set(["exchange:x3", "queue:q1"]),
    );
  });

  it("selecting an unsupported kind (host / vhost / external) is a safe no-op — empty ancestors/descendants and no crash", () => {
    const input = chainFixture();
    const rHost = bidirectionalForNode(input, "host:a");
    const rVhost = bidirectionalForNode(input, "vhost:a:/");
    expect(rHost.upstream.reachableAncestorIds).toEqual([]);
    expect(rHost.downstream.reachableDescendantIds).toEqual([]);
    expect(rVhost.upstream.reachableAncestorIds).toEqual([]);
    expect(rVhost.downstream.reachableDescendantIds).toEqual([]);
  });

  it("selecting a non-existent id returns empty envelopes without throwing", () => {
    const input = chainFixture();
    const r = bidirectionalForNode(input, "queue:ghost");
    expect(r.targetNodeId).toBe("queue:ghost");
    expect(r.upstream.reachableAncestorIds).toEqual([]);
    expect(r.downstream.reachableDescendantIds).toEqual([]);
  });

  it("the unrelated `exchange:noise → queue:noise` pair is NEVER included in either direction from any chain node — proves the traversal doesn't leak across unconnected sub-graphs", () => {
    const input = chainFixture();
    for (const target of [
      "exchange:x1",
      "exchange:x2",
      "exchange:x3",
      "shovel:s1",
      "queue:q1",
      "queue:q.branch",
    ]) {
      const r = bidirectionalForNode(input, target);
      expect(r.upstream.reachableAncestorIds).not.toContain("exchange:noise");
      expect(r.upstream.reachableAncestorIds).not.toContain("queue:noise");
      expect(r.downstream.reachableDescendantIds).not.toContain("exchange:noise");
      expect(r.downstream.reachableDescendantIds).not.toContain("queue:noise");
    }
  });

  it("cycle guard applies to both directions independently — a downstream cycle does not silently reject an unrelated upstream branch", () => {
    const input = chainFixture();
    // Downstream cycle: x3 → x2 (feeds back into the chain the traversal
    // just came from). Upstream traversal from the shovel should still
    // enumerate x2 and x1 correctly.
    input.edges.push({
      id: "b:x3->x2:cycle",
      from: "exchange:x3",
      to: "exchange:x2",
      kind: "binds",
      routingKey: "loop",
    });
    const r = bidirectionalForNode(input, "shovel:s1");
    // Upstream from the shovel now reaches x1, x2 AND (via the new cycle
    // edge x3 → x2) x3 — which is the honest answer because upstream is a
    // reverse-walk from the shovel and x3 now has a reverse-edge to x2.
    // The test's real assertion is that the walk TERMINATES and enumerates
    // every distinct upstream node exactly once.
    expect(new Set(r.upstream.reachableAncestorIds)).toEqual(
      new Set(["exchange:x1", "exchange:x2", "exchange:x3"]),
    );
    // Downstream still lands on exchange:x3 + queue:q1 (and now surfaces
    // the cycle back to x2).
    expect(r.downstream.reachableDescendantIds).toContain("exchange:x3");
    expect(r.downstream.reachableDescendantIds).toContain("queue:q1");
    // At least one direction observed the cycle — proof the cycle guard
    // fired at all. Which side sees it depends on BFS order; asserting
    // either .upstream OR .downstream keeps the test robust.
    expect(
      r.upstream.visitedCycles.length + r.downstream.visitedCycles.length,
    ).toBeGreaterThan(0);
  });

  it("reachable closed cycle emits representative paths in BOTH directions — pins the panel/highlight consistency contract", () => {
    // Minimal three-node cycle: x1 → x2 → x3 → x1. Selecting x1 must
    // enumerate x2 and x3 both upstream and downstream and produce at least
    // one representative path in each direction so the path panel is not
    // stuck on the pre-fix "no publishers/consumers" empty state while the
    // highlight glows with the cycle nodes.
    const nodes: GraphNode[] = [
      { id: "exchange:x1", kind: "exchange", label: "x1", data: {} },
      { id: "exchange:x2", kind: "exchange", label: "x2", data: {} },
      { id: "exchange:x3", kind: "exchange", label: "x3", data: {} },
    ];
    const edges: GraphEdge[] = [
      { id: "b:x1->x2", from: "exchange:x1", to: "exchange:x2", kind: "binds", routingKey: "k" },
      { id: "b:x2->x3", from: "exchange:x2", to: "exchange:x3", kind: "binds", routingKey: "k" },
      { id: "b:x3->x1", from: "exchange:x3", to: "exchange:x1", kind: "binds", routingKey: "k" },
    ];
    const r = bidirectionalForNode({ nodes, edges }, "exchange:x1");
    // Reach: every other cycle node in BOTH directions.
    expect(new Set(r.upstream.reachableAncestorIds)).toEqual(
      new Set(["exchange:x2", "exchange:x3"]),
    );
    expect(new Set(r.downstream.reachableDescendantIds)).toEqual(
      new Set(["exchange:x2", "exchange:x3"]),
    );
    // Cycle observed on both sides.
    expect(r.upstream.visitedCycles.length).toBeGreaterThan(0);
    expect(r.downstream.visitedCycles.length).toBeGreaterThan(0);
    // Representative paths present — this is the regression the review
    // rejected: without the BFS-tree-leaf fix these would both be [].
    expect(r.upstream.paths.length).toBeGreaterThan(0);
    expect(r.downstream.paths.length).toBeGreaterThan(0);
  });

  it("`followDeadLetter` is honored in BOTH directions — off by default, on when opted-in", () => {
    const input = chainFixture();
    // Add a dead-letter edge from queue:q1 back to a dlx exchange with its
    // own downstream chain, and one INTO the chain from a dlx.
    input.nodes.push(
      { id: "exchange:dlx.up", kind: "exchange", label: "dlx.up", data: {} },
      { id: "exchange:dlx.down", kind: "exchange", label: "dlx.down", data: {} },
      { id: "queue:dlq.down", kind: "queue", label: "dlq.down", data: {} },
    );
    input.edges.push(
      { id: "dl:up->x1", from: "exchange:dlx.up", to: "exchange:x1", kind: "dead-letter" },
      { id: "dl:q1->down", from: "queue:q1", to: "exchange:dlx.down", kind: "dead-letter" },
      { id: "b:down->dlq", from: "exchange:dlx.down", to: "queue:dlq.down", kind: "binds", routingKey: "d" },
    );
    // Without followDeadLetter — DLX chain is invisible.
    const rDefault = bidirectionalForNode(input, "queue:q1");
    expect(rDefault.upstream.reachableAncestorIds).not.toContain("exchange:dlx.up");
    expect(rDefault.downstream.reachableDescendantIds).not.toContain("exchange:dlx.down");
    // With followDeadLetter — dlx chain surfaces in both directions.
    const rDL = bidirectionalForNode(input, "queue:q1", { followDeadLetter: true });
    // The upstream dlx points AT x1 which is upstream of queue:q1, so it
    // becomes an ancestor.
    expect(rDL.upstream.reachableAncestorIds).toContain("exchange:dlx.up");
    // The downstream dlx and its bound queue become descendants.
    expect(rDL.downstream.reachableDescendantIds).toContain("exchange:dlx.down");
    expect(rDL.downstream.reachableDescendantIds).toContain("queue:dlq.down");
  });
});
