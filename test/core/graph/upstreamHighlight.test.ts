import { describe, expect, it } from "vitest";
import { computeUpstreamHighlight } from "../../../src/core/graph/upstreamHighlight";
import type { GraphEdge, GraphNode } from "../../../src/core/model";

const nodes: GraphNode[] = [
  { id: "host:a", kind: "host", label: "a" },
  { id: "vhost:a:/", kind: "vhost", label: "/" },
  { id: "exchange:a:x1", kind: "exchange", label: "x1" },
  { id: "exchange:a:x2", kind: "exchange", label: "x2" },
  { id: "queue:a:q1", kind: "queue", label: "q1" },
  { id: "queue:a:q2", kind: "queue", label: "q2" },
];

const edges: GraphEdge[] = [
  { id: "contains:host->vhost", from: "host:a", to: "vhost:a:/", kind: "contains" },
  { id: "contains:vhost->x1", from: "vhost:a:/", to: "exchange:a:x1", kind: "contains" },
  { id: "contains:vhost->x2", from: "vhost:a:/", to: "exchange:a:x2", kind: "contains" },
  { id: "contains:vhost->q1", from: "vhost:a:/", to: "queue:a:q1", kind: "contains" },
  { id: "contains:vhost->q2", from: "vhost:a:/", to: "queue:a:q2", kind: "contains" },
  { id: "b:x1->x2", from: "exchange:a:x1", to: "exchange:a:x2", kind: "binds", routingKey: "a.b" },
  { id: "b:x2->q1", from: "exchange:a:x2", to: "queue:a:q1", kind: "binds", routingKey: "a.b" },
  { id: "b:x1->q2", from: "exchange:a:x1", to: "queue:a:q2", kind: "binds", routingKey: "c.*" },
];

describe("computeUpstreamHighlight", () => {
  it("returns empty highlight for a missing target id", () => {
    const hl = computeUpstreamHighlight({ nodes, edges }, "queue:missing");
    expect(hl.nodeIds.size).toBe(0);
    expect(hl.edgeIds.size).toBe(0);
    expect(hl.targetNodeId).toBeUndefined();
  });

  it("returns empty highlight when no target id is provided", () => {
    expect(computeUpstreamHighlight({ nodes, edges }, undefined).nodeIds.size).toBe(0);
  });

  it("returns empty highlight for a non-queue non-exchange target (host)", () => {
    expect(computeUpstreamHighlight({ nodes, edges }, "host:a").nodeIds.size).toBe(0);
  });

  it("collects every ancestor plus the shortest reverse-path edges for a queue target", () => {
    const hl = computeUpstreamHighlight({ nodes, edges }, "queue:a:q1");
    expect(hl.targetNodeId).toBe("queue:a:q1");
    // target + x2 + x1 ancestors, no q2 (parallel branch not upstream of q1)
    expect([...hl.nodeIds].sort()).toEqual([
      "exchange:a:x1",
      "exchange:a:x2",
      "queue:a:q1",
    ]);
    expect([...hl.edgeIds].sort()).toEqual(["b:x1->x2", "b:x2->q1"]);
  });

  it("supports exchange targets and returns only the ancestors relevant to that exchange", () => {
    const hl = computeUpstreamHighlight({ nodes, edges }, "exchange:a:x2");
    expect(hl.targetNodeId).toBe("exchange:a:x2");
    expect([...hl.nodeIds].sort()).toEqual(["exchange:a:x1", "exchange:a:x2"]);
    expect([...hl.edgeIds]).toEqual(["b:x1->x2"]);
  });

  it("returns fresh Set instances per call so mutating one result never bleeds into another", () => {
    const a = computeUpstreamHighlight({ nodes: [], edges: [] }, undefined);
    const b = computeUpstreamHighlight({ nodes: [], edges: [] }, "queue:missing");
    a.nodeIds.add("poisoned");
    a.edgeIds.add("poisoned-edge");
    expect(b.nodeIds.has("poisoned")).toBe(false);
    expect(b.edgeIds.has("poisoned-edge")).toBe(false);
    // A fresh third call should also be clean.
    const c = computeUpstreamHighlight({ nodes: [], edges: [] }, undefined);
    expect(c.nodeIds.size).toBe(0);
    expect(c.edgeIds.size).toBe(0);
  });

  it("includes every routing edge between highlighted ancestors, not just one shortest-path edge — so diamond branches stay connected", () => {
    // Diamond: x1 binds directly to q1 AND indirectly via x2 → q1.
    // Every intermediate ancestor should stay visually connected: no highlighted
    // node should be left with all its incident edges dimmed.
    const diamondNodes: GraphNode[] = [
      { id: "exchange:a:x1", kind: "exchange", label: "x1" },
      { id: "exchange:a:x2", kind: "exchange", label: "x2" },
      { id: "queue:a:q1", kind: "queue", label: "q1" },
    ];
    const diamondEdges: GraphEdge[] = [
      // Parallel binding from x1 to q1 directly (would be the shortest path).
      { id: "e:direct", from: "exchange:a:x1", to: "queue:a:q1", kind: "binds", routingKey: "k" },
      // Longer branch via x2.
      { id: "e:via-x2-in", from: "exchange:a:x1", to: "exchange:a:x2", kind: "binds", routingKey: "k" },
      { id: "e:via-x2-out", from: "exchange:a:x2", to: "queue:a:q1", kind: "binds", routingKey: "k" },
      // Parallel binding between the same two exchanges (multi-key binding).
      { id: "e:via-x2-in-alt", from: "exchange:a:x1", to: "exchange:a:x2", kind: "binds", routingKey: "k2" },
    ];
    const hl = computeUpstreamHighlight(
      { nodes: diamondNodes, edges: diamondEdges },
      "queue:a:q1",
    );
    expect([...hl.nodeIds].sort()).toEqual([
      "exchange:a:x1",
      "exchange:a:x2",
      "queue:a:q1",
    ]);
    // Every routing edge whose endpoints are both highlighted appears in
    // edgeIds — no ancestor is stranded with only dimmed edges.
    expect([...hl.edgeIds].sort()).toEqual([
      "e:direct",
      "e:via-x2-in",
      "e:via-x2-in-alt",
      "e:via-x2-out",
    ]);
    // Consistency invariant: every highlighted non-target ancestor must have
    // at least one edge in edgeIds touching it (incoming or outgoing among
    // highlighted nodes).
    const edgesById = new Map(diamondEdges.map((e) => [e.id, e]));
    for (const nodeId of hl.nodeIds) {
      if (nodeId === hl.targetNodeId) continue;
      const touched = [...hl.edgeIds].some((eid) => {
        const e = edgesById.get(eid);
        return e && (e.from === nodeId || e.to === nodeId);
      });
      expect(touched, `ancestor ${nodeId} should be connected via a highlighted edge`).toBe(true);
    }
  });

  it("does not include off-path edges whose endpoints are not both highlighted", () => {
    // Adds a sibling exchange feeding a different queue — no endpoint overlap
    // with the ancestry of queue:a:q1, so nothing about it should be highlighted.
    const hl = computeUpstreamHighlight({ nodes, edges }, "queue:a:q1");
    expect(hl.edgeIds.has("b:x1->q2")).toBe(false);
    expect(hl.nodeIds.has("queue:a:q2")).toBe(false);
  });

  it("exposes the underlying traversal result for callers building a path panel", () => {
    const hl = computeUpstreamHighlight({ nodes, edges }, "queue:a:q1");
    expect(hl.traversal).toBeDefined();
    expect(hl.traversal!.paths.map((p) => p.sourceNodeId)).toEqual(["exchange:a:x1"]);
    expect(hl.traversal!.truncated).toBe(false);
  });
});
