import { describe, expect, it } from "vitest";
import { applyGraphFilters } from "../../../src/core/graph/filterGraph";
import { computeUpstreamHighlight } from "../../../src/core/graph/upstreamHighlight";
import {
  applyVisibility,
  createEmptyVisibility,
  hideNodes,
  isolateNeighborhood,
  restoreNodes,
} from "../../../src/core/graph/visibility";
import type { BuildGraphResult } from "../../../src/core/graph/buildGraph";
import type { GraphEdge, GraphNode } from "../../../src/core/model";
import { toReactFlowElements } from "../../../src/ui/components/topologyGraphElements";

/**
 * Integration coverage for TopologyGraphCanvas's data pipeline:
 *   rawGraph → applyGraphFilters → toReactFlowElements
 *   rawGraph → applyGraphFilters → computeUpstreamHighlight({maxDepth})
 *
 * These asserts mirror the exact composition TopologyGraphCanvas uses, so a
 * regression in either wiring step (filter → render, or depth → highlight)
 * would fail here even without mounting React Flow itself.
 */

function pipelineFixture(): BuildGraphResult {
  const nodes: GraphNode[] = [
    { id: "host:a", kind: "host", label: "a", data: { id: "host:a", name: "a", sourceFiles: [] } },
    { id: "host:b", kind: "host", label: "b", data: { id: "host:b", name: "b", sourceFiles: [] } },
    { id: "vhost:a:/", kind: "vhost", label: "/", data: { id: "vhost:a:/", hostId: "host:a", name: "/" } },
    { id: "vhost:b:/", kind: "vhost", label: "/", data: { id: "vhost:b:/", hostId: "host:b", name: "/" } },
    { id: "exchange:a:x1", kind: "exchange", label: "x1", data: { hostId: "host:a", vhostId: "vhost:a:/", type: "topic" } },
    { id: "exchange:a:x2", kind: "exchange", label: "x2", data: { hostId: "host:a", vhostId: "vhost:a:/", type: "topic" } },
    { id: "exchange:a:x3", kind: "exchange", label: "x3", data: { hostId: "host:a", vhostId: "vhost:a:/", type: "topic" } },
    { id: "queue:a:q1", kind: "queue", label: "q1", data: { hostId: "host:a", vhostId: "vhost:a:/" } },
    { id: "queue:b:q2", kind: "queue", label: "q2", data: { hostId: "host:b", vhostId: "vhost:b:/" } },
  ];
  // A 3-hop chain of exchanges into q1: x1 → x2 → x3 → q1
  const edges: GraphEdge[] = [
    { id: "c:host-a->vhost", from: "host:a", to: "vhost:a:/", kind: "contains" },
    { id: "c:host-b->vhost", from: "host:b", to: "vhost:b:/", kind: "contains" },
    { id: "c:vhost-a->x1", from: "vhost:a:/", to: "exchange:a:x1", kind: "contains" },
    { id: "c:vhost-a->x2", from: "vhost:a:/", to: "exchange:a:x2", kind: "contains" },
    { id: "c:vhost-a->x3", from: "vhost:a:/", to: "exchange:a:x3", kind: "contains" },
    { id: "c:vhost-a->q1", from: "vhost:a:/", to: "queue:a:q1", kind: "contains" },
    { id: "c:vhost-b->q2", from: "vhost:b:/", to: "queue:b:q2", kind: "contains" },
    { id: "b:x1->x2", from: "exchange:a:x1", to: "exchange:a:x2", kind: "binds", routingKey: "a.b" },
    { id: "b:x2->x3", from: "exchange:a:x2", to: "exchange:a:x3", kind: "binds", routingKey: "a.b" },
    { id: "b:x3->q1", from: "exchange:a:x3", to: "queue:a:q1", kind: "binds", routingKey: "a.b" },
  ];
  return { nodes, edges, diagnostics: [] };
}

describe("TopologyGraphCanvas pipeline — filters affect rendered elements", () => {
  it("filter-free pipeline renders every node and every non-contains edge", () => {
    const graph = applyGraphFilters(pipelineFixture());
    const flow = toReactFlowElements(graph, { includeContains: false });
    expect(flow.nodes).toHaveLength(9);
    // Every edge except the 7 `contains` edges → 3 routing edges rendered
    expect(flow.edges).toHaveLength(3);
  });

  it("host filter cuts rendered nodes/edges — no dangling handles reach React Flow", () => {
    const graph = applyGraphFilters(pipelineFixture(), {
      hostIds: new Set(["host:a"]),
    });
    const flow = toReactFlowElements(graph, { includeContains: false });
    const renderedNodeIds = new Set(flow.nodes.map((n) => n.id));
    // host:b, vhost:b:/, and queue:b:q2 are gone
    expect(renderedNodeIds.has("host:a")).toBe(true);
    expect(renderedNodeIds.has("host:b")).toBe(false);
    expect(renderedNodeIds.has("queue:b:q2")).toBe(false);
    // Every rendered edge points at a rendered node
    for (const e of flow.edges) {
      expect(renderedNodeIds.has(e.source)).toBe(true);
      expect(renderedNodeIds.has(e.target)).toBe(true);
    }
  });

  it("vhost filter that leaves host:b childless prunes host:b (not left as an orphan header)", () => {
    const graph = applyGraphFilters(pipelineFixture(), {
      vhostIds: new Set(["vhost:a:/"]),
    });
    const flow = toReactFlowElements(graph, { includeContains: true });
    const renderedNodeIds = new Set(flow.nodes.map((n) => n.id));
    expect(renderedNodeIds.has("host:a")).toBe(true);
    expect(renderedNodeIds.has("host:b")).toBe(false);
    expect(renderedNodeIds.has("vhost:b:/")).toBe(false);
    // No dangling edges rendered
    for (const e of flow.edges) {
      expect(renderedNodeIds.has(e.source)).toBe(true);
      expect(renderedNodeIds.has(e.target)).toBe(true);
    }
  });

  it("edge-kind filter drops non-routing edges from the rendered flow", () => {
    const graph = applyGraphFilters(pipelineFixture(), {
      edgeKinds: new Set(["binds"]),
    });
    const flow = toReactFlowElements(graph, { includeContains: true });
    for (const e of flow.edges) {
      expect(e.data.kind).toBe("binds");
    }
    expect(flow.edges).toHaveLength(3);
  });
});

describe("TopologyGraphCanvas pipeline — broad filters compose with hide/restore + isolation", () => {
  it("host filter drops entities from every downstream stage, and hide/restore on the filtered graph doesn't resurrect them", () => {
    // Broad filter → only host:a survives; host:b + queue:b:q2 are gone even
    // before the visibility overlay runs.
    const filtered = applyGraphFilters(pipelineFixture(), {
      hostIds: new Set(["host:a"]),
    });
    let visibility = createEmptyVisibility();
    // Hiding a survivor works.
    visibility = hideNodes(visibility, ["queue:a:q1"]);
    const outHidden = applyVisibility(filtered, visibility);
    const idsHidden = new Set(outHidden.nodes.map((n) => n.id));
    expect(idsHidden.has("queue:a:q1")).toBe(false);
    expect(idsHidden.has("queue:b:q2")).toBe(false); // filter-hidden stays hidden
    // effectivelyHidden lists ONLY the explicit hide (filter-removed nodes are
    // not part of the pre-visibility graph, so they can't be surfaced as
    // "restore me" pills — matches the canvas panel behaviour).
    expect([...outHidden.effectivelyHidden]).toEqual(["queue:a:q1"]);
    // Restore round-trip against the SAME filtered graph.
    const restored = restoreNodes(filtered, visibility, ["queue:a:q1"]);
    const outRestored = applyVisibility(filtered, restored);
    const idsRestored = new Set(outRestored.nodes.map((n) => n.id));
    expect(idsRestored.has("queue:a:q1")).toBe(true);
    expect(idsRestored.has("queue:b:q2")).toBe(false);
    for (const e of outRestored.edges) {
      expect(idsRestored.has(e.from)).toBe(true);
      expect(idsRestored.has(e.to)).toBe(true);
    }
  });

  it("neighborhood isolation composes with a broad host filter — isolation membership is computed against the filtered graph, so restoring an isolation-hidden id clears isolation on the SAME graph", () => {
    const filtered = applyGraphFilters(pipelineFixture(), {
      hostIds: new Set(["host:a"]),
    });
    // Depth-1 isolation on q1 keeps q1 + its immediate upstream (x3) + host/vhost ancestors.
    const isolated = isolateNeighborhood(createEmptyVisibility(), "queue:a:q1", {
      depth: 1,
      direction: "both",
    });
    const outIsolated = applyVisibility(filtered, isolated);
    const idsIsolated = new Set(outIsolated.nodes.map((n) => n.id));
    expect(idsIsolated.has("queue:a:q1")).toBe(true);
    expect(idsIsolated.has("exchange:a:x3")).toBe(true);
    // x1 is two hops away and NOT in the neighborhood — it must show up in
    // effectivelyHidden so the panel's pill list can offer a restore.
    expect(idsIsolated.has("exchange:a:x1")).toBe(false);
    expect(outIsolated.effectivelyHidden.has("exchange:a:x1")).toBe(true);
    // Restoring x1 against the FILTERED graph correctly clears isolation because
    // x1 is not in the depth-1 neighborhood of the filtered graph.
    const restored = restoreNodes(filtered, isolated, ["exchange:a:x1"]);
    expect(restored.isolatedFocus).toBeUndefined();
    const outRestored = applyVisibility(filtered, restored);
    const idsRestored = new Set(outRestored.nodes.map((n) => n.id));
    expect(idsRestored.has("exchange:a:x1")).toBe(true);
    // The broadly-filtered host:b entities remain gone — the visibility
    // overlay never resurrects filter-removed nodes.
    expect(idsRestored.has("queue:b:q2")).toBe(false);
  });
});

describe("TopologyGraphCanvas pipeline — depth affects highlighting", () => {
  it("full depth highlights every ancestor in the 3-hop chain (target + 3 ancestors)", () => {
    const graph = applyGraphFilters(pipelineFixture());
    const highlight = computeUpstreamHighlight(graph, "queue:a:q1", { maxDepth: 32 });
    expect(highlight.targetNodeId).toBe("queue:a:q1");
    expect([...highlight.nodeIds].sort()).toEqual([
      "exchange:a:x1",
      "exchange:a:x2",
      "exchange:a:x3",
      "queue:a:q1",
    ]);
    expect(highlight.traversal?.truncated).toBe(false);
  });

  it("depth=1 truncates the traversal after one hop upstream", () => {
    const graph = applyGraphFilters(pipelineFixture());
    const highlight = computeUpstreamHighlight(graph, "queue:a:q1", { maxDepth: 1 });
    expect([...highlight.nodeIds].sort()).toEqual(["exchange:a:x3", "queue:a:q1"]);
    expect(highlight.traversal?.truncated).toBe(true);
  });

  it("depth=0 highlights only the target and marks the traversal truncated", () => {
    const graph = applyGraphFilters(pipelineFixture());
    const highlight = computeUpstreamHighlight(graph, "queue:a:q1", { maxDepth: 0 });
    expect([...highlight.nodeIds]).toEqual(["queue:a:q1"]);
    expect(highlight.traversal?.truncated).toBe(true);
  });

  it("filter + highlight compose: filtering out an ancestor chain still highlights the survivor", () => {
    // Filter out x1 by dropping its host would kill everything on host:a; instead
    // apply an edge-kind filter that removes only `binds` edges, forcing the
    // traversal to find no upstream ancestors.
    const graph = applyGraphFilters(pipelineFixture(), {
      edgeKinds: new Set(["contains"]),
    });
    const highlight = computeUpstreamHighlight(graph, "queue:a:q1", { maxDepth: 32 });
    // Only the target itself remains highlighted because every routing edge
    // was filtered out before traversal ran.
    expect([...highlight.nodeIds]).toEqual(["queue:a:q1"]);
  });
});
