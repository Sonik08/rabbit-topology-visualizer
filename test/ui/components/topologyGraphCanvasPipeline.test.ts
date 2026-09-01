import { describe, expect, it } from "vitest";
import { applyGraphFilters } from "../../../src/core/graph/filterGraph";
import {
  computeBidirectionalHighlight,
  computeUpstreamHighlight,
} from "../../../src/core/graph/upstreamHighlight";
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
import { composeFocusedTopology } from "../../../src/ui/components/topologyRenderPipeline";

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

describe("TopologyGraphCanvas pipeline — focused mode composes with filters + visibility (never resurrects excluded nodes)", () => {
  // These tests call `composeFocusedTopology` — the SAME function
  // `TopologyGraphCanvas` uses internally — so reordering or bypassing a
  // stage in the canvas's wiring shows up as a failure here without needing
  // to mount ReactFlow. The filter stage still lives inside
  // `useTopologyGraph`; we mimic that by calling `applyGraphFilters` first
  // and feeding the result into `composeFocusedTopology` as `graph`.
  it("focused mode operates on the FILTERED graph — the unrelated host's queue cannot appear in a focused view rooted on host:a even at maxDepth=32", () => {
    const filtered = applyGraphFilters(pipelineFixture(), {
      hostIds: new Set(["host:a"]),
    });
    const { focused } = composeFocusedTopology({
      graph: filtered,
      visibility: createEmptyVisibility(),
      focusNodeId: "queue:a:q1",
      focusMaxDepth: 32,
    });
    expect(focused).toBeDefined();
    const ids = new Set(focused!.nodes.map((n) => n.id));
    // Full a-chain reachable + contains ancestry present.
    expect(ids.has("queue:a:q1")).toBe(true);
    expect(ids.has("exchange:a:x3")).toBe(true);
    expect(ids.has("exchange:a:x2")).toBe(true);
    expect(ids.has("exchange:a:x1")).toBe(true);
    expect(ids.has("host:a")).toBe(true);
    expect(ids.has("vhost:a:/")).toBe(true);
    // host:b + queue:b:q2 stayed out because applyGraphFilters removed them
    // BEFORE the composition ran — a focused view cannot resurrect them.
    expect(ids.has("host:b")).toBe(false);
    expect(ids.has("queue:b:q2")).toBe(false);
    expect(focused!.focusMissing).toBe(false);
  });

  it("focus target that was filtered out yields the actionable empty-focused-view result (focusMissing=true) instead of resurrecting host:b entities", () => {
    const filtered = applyGraphFilters(pipelineFixture(), {
      hostIds: new Set(["host:a"]),
    });
    const { focused } = composeFocusedTopology({
      graph: filtered,
      visibility: createEmptyVisibility(),
      focusNodeId: "queue:b:q2",
      focusMaxDepth: 32,
    });
    expect(focused).toBeDefined();
    expect(focused!.focusMissing).toBe(true);
    expect(focused!.nodes).toEqual([]);
    expect(focused!.edges).toEqual([]);
  });

  it("visibility hide is applied BEFORE the focused-mode clip: hiding a mid-chain exchange cuts the focused chain and prunes the now-unreachable ancestors", () => {
    // Full graph → no broad filter → hide the middle exchange x2 → focus.
    const { focused } = composeFocusedTopology({
      graph: pipelineFixture(),
      visibility: hideNodes(createEmptyVisibility(), ["exchange:a:x2"]),
      focusNodeId: "queue:a:q1",
      focusMaxDepth: 32,
    });
    expect(focused).toBeDefined();
    const ids = new Set(focused!.nodes.map((n) => n.id));
    // Chain from focus: queue:a:q1 ← exchange:a:x3 ← (x2 hidden, stops here)
    // — x1 is no longer reachable because x2's edges disappeared with it.
    expect(ids.has("queue:a:q1")).toBe(true);
    expect(ids.has("exchange:a:x3")).toBe(true);
    expect(ids.has("exchange:a:x2")).toBe(false);
    expect(ids.has("exchange:a:x1")).toBe(false);
    // Contains ancestry still preserved for the surviving chain.
    expect(ids.has("vhost:a:/")).toBe(true);
    expect(ids.has("host:a")).toBe(true);
  });

  it("end-to-end pipeline (filter → composeFocusedTopology → toReactFlowElements) never emits a rendered node id that was excluded upstream", () => {
    // Broad filter drops host:b, visibility hides x1, focus on queue:a:q1.
    const filtered = applyGraphFilters(pipelineFixture(), {
      hostIds: new Set(["host:a"]),
    });
    const { renderInput } = composeFocusedTopology({
      graph: filtered,
      visibility: hideNodes(createEmptyVisibility(), ["exchange:a:x1"]),
      focusNodeId: "queue:a:q1",
      focusMaxDepth: 32,
    });
    const flow = toReactFlowElements(renderInput, { includeContains: false });
    const renderedIds = new Set(flow.nodes.map((n) => n.id));
    // Focused survivors after the two exclusions: q1 ← x3 ← x2 (x1 hidden).
    expect(renderedIds.has("queue:a:q1")).toBe(true);
    expect(renderedIds.has("exchange:a:x3")).toBe(true);
    expect(renderedIds.has("exchange:a:x2")).toBe(true);
    // Excluded upstream — must NOT reappear via the focused-mode clip.
    expect(renderedIds.has("exchange:a:x1")).toBe(false);
    expect(renderedIds.has("host:b")).toBe(false);
    expect(renderedIds.has("queue:b:q2")).toBe(false);
    // Rendered edges only connect kept nodes.
    for (const e of flow.edges) {
      expect(renderedIds.has(e.source)).toBe(true);
      expect(renderedIds.has(e.target)).toBe(true);
    }
  });

  it("regression: hiding host/vhost containers via visibility does NOT degrade the surviving queue's badge (contextNodes carries canonical vhost data through)", () => {
    // Mirrors the canvas wiring: rawGraph → filter → visibility → focus →
    // render, with `contextNodes` fed from the pre-filter rawGraph so a
    // still-visible entity keeps its resolved vhost/host names even when the
    // structural containers are hidden by visibility state.
    const raw = pipelineFixture();
    const filtered = applyGraphFilters(raw);
    // Explicitly hide the host + vhost containers for host:a — the queue
    // remains visible. The visibility panel UI doesn't expose host/vhost
    // toggles, but the underlying `hideNodes(state, ids)` reducer accepts
    // any node ids, and isolation/programmatic tools can produce this state.
    const visibility = hideNodes(createEmptyVisibility(), [
      "host:a",
      "vhost:a:/",
    ]);
    const { renderInput } = composeFocusedTopology({
      graph: filtered,
      visibility,
    });
    // Sanity: the render input has dropped the containers but kept the queue.
    const renderIds = new Set(renderInput.nodes.map((n) => n.id));
    expect(renderIds.has("host:a")).toBe(false);
    expect(renderIds.has("vhost:a:/")).toBe(false);
    expect(renderIds.has("queue:a:q1")).toBe(true);

    // BAD path (regression pin): if the badge resolver runs on the reduced
    // render input, the queue would degrade to `unknown vhost` — the vhost
    // node it references is no longer in scope.
    const withoutContext = toReactFlowElements(renderInput, {
      includeContains: false,
    });
    const queueWithoutContext = withoutContext.nodes.find(
      (n) => n.id === "queue:a:q1",
    )!;
    expect(queueWithoutContext.data.vhostContext?.unknown).toBe(true);
    expect(queueWithoutContext.data.vhostBadge).toContain("unknown vhost");

    // GOOD path (canvas wiring): the resolver runs on the pre-filter
    // `rawGraph.nodes` via `contextNodes`, so the same visible entity keeps
    // its resolved vhost/host names.
    const withContext = toReactFlowElements(renderInput, {
      includeContains: false,
      contextNodes: raw.nodes,
    });
    const queueWithContext = withContext.nodes.find(
      (n) => n.id === "queue:a:q1",
    )!;
    expect(queueWithContext.data.vhostContext?.unknown).toBe(false);
    expect(queueWithContext.data.vhostContext?.vhostName).toBe("/");
    // The pipeline fixture has vhost `/` on BOTH hosts, so the vhost name
    // is ambiguous and the badge is host-prefixed for disambiguation.
    expect(queueWithContext.data.vhostContext?.ambiguous).toBe(true);
    expect(queueWithContext.data.vhostBadge).toBe("a//");
    expect(queueWithContext.data.vhostTooltip).toBe("vhost / on host a");
    // No excluded container id sneaks back into the render.
    const withContextIds = new Set(withContext.nodes.map((n) => n.id));
    expect(withContextIds.has("host:a")).toBe(false);
    expect(withContextIds.has("vhost:a:/")).toBe(false);
  });

  it("regression: filtering to a single entity kind (queues only) preserves badges via contextNodes even though every host/vhost/exchange is dropped", () => {
    // Emulates the canvas's filter-by-entity-kind path: allow-list = {queue}
    // drops host/vhost/exchange from the render, but the resolver still gets
    // the pre-filter `rawGraph.nodes` via `contextNodes` so the surviving
    // queues keep their vhost badges.
    const raw = pipelineFixture();
    const filtered = applyGraphFilters(raw, { entityKinds: new Set(["queue"]) });
    const { renderInput } = composeFocusedTopology({
      graph: filtered,
      visibility: createEmptyVisibility(),
    });
    const renderIds = new Set(renderInput.nodes.map((n) => n.id));
    // Host/vhost/exchange dropped.
    expect(renderIds.has("host:a")).toBe(false);
    expect(renderIds.has("vhost:a:/")).toBe(false);
    expect(renderIds.has("exchange:a:x1")).toBe(false);
    expect(renderIds.has("queue:a:q1")).toBe(true);
    expect(renderIds.has("queue:b:q2")).toBe(true);

    const flow = toReactFlowElements(renderInput, {
      includeContains: false,
      contextNodes: raw.nodes,
    });
    const q1 = flow.nodes.find((n) => n.id === "queue:a:q1")!;
    const q2 = flow.nodes.find((n) => n.id === "queue:b:q2")!;
    expect(q1.data.vhostContext?.vhostName).toBe("/");
    expect(q1.data.vhostContext?.hostName).toBe("a");
    expect(q2.data.vhostContext?.hostName).toBe("b");
    // Both vhosts named `/` — the badge disambiguates by host discriminator.
    expect(q1.data.vhostContext?.ambiguous).toBe(true);
    expect(q1.data.vhostBadge).toBe("a//");
    expect(q2.data.vhostBadge).toBe("b//");
    expect(q1.data.vhostBadge).not.toBe(q2.data.vhostBadge);
  });

  it("regression: composeFocusedTopology.renderInput === focused when focusNodeId is set, so any wiring that bypasses the clip fails a shared-function assertion", () => {
    const filtered = applyGraphFilters(pipelineFixture());
    const composition = composeFocusedTopology({
      graph: filtered,
      visibility: createEmptyVisibility(),
      focusNodeId: "queue:a:q1",
      focusMaxDepth: 32,
    });
    // Identity check: the render input is the focused-mode result, not the
    // pre-focus `visible` payload. If a future refactor accidentally hands
    // the visible graph to the renderer while focus is active, this fails.
    expect(composition.focused).toBeDefined();
    expect(composition.renderInput).toBe(composition.focused);
    // Without focus, renderInput mirrors the visible graph instead.
    const noFocus = composeFocusedTopology({
      graph: filtered,
      visibility: createEmptyVisibility(),
    });
    expect(noFocus.focused).toBeUndefined();
    expect(noFocus.renderInput.nodes).toBe(noFocus.visible.nodes);
    expect(noFocus.renderInput.edges).toBe(noFocus.visible.edges);
  });
});

/**
 * Fixture that adds a cross-host shovel chain on top of the base pipeline
 * fixture: `exchange:a:x3 → shovel:a:s1 → queue:b:q2`. Lets the shovel-chain
 * regressions exercise a full `exchange → exchange → shovel → queue` message
 * flow through the shared composition (matching the task's canonical
 * `exchange → exchange → shovel → exchange → queue` example, minus the trailing
 * exchange for concision).
 */
function shovelChainFixture(): BuildGraphResult {
  const base = pipelineFixture();
  base.nodes.push({
    id: "shovel:a:s1",
    kind: "shovel",
    label: "a-to-b",
    data: { hostId: "host:a", vhostId: "vhost:a:/" },
  });
  base.edges.push(
    { id: "c:vhost-a->s1", from: "vhost:a:/", to: "shovel:a:s1", kind: "contains" },
    { id: "s:x3->s1", from: "exchange:a:x3", to: "shovel:a:s1", kind: "shovels" },
    { id: "s:s1->q2", from: "shovel:a:s1", to: "queue:b:q2", kind: "shovels" },
  );
  return base;
}

describe("TopologyGraphCanvas pipeline — shovel-chain end-to-end regression via composeFocusedTopology", () => {
  it("focus on the downstream queue (queue:b:q2) walks the full shovel chain upstream: queue:b:q2 ← shovel:a:s1 ← exchange:a:x3 ← exchange:a:x2 ← exchange:a:x1", () => {
    const { focused } = composeFocusedTopology({
      graph: applyGraphFilters(shovelChainFixture()),
      visibility: createEmptyVisibility(),
      focusNodeId: "queue:b:q2",
      focusMaxDepth: 32,
    });
    expect(focused).toBeDefined();
    const ids = new Set(focused!.nodes.map((n) => n.id));
    // Every routing hop upstream of queue:b:q2 survives.
    expect(ids.has("queue:b:q2")).toBe(true);
    expect(ids.has("shovel:a:s1")).toBe(true);
    expect(ids.has("exchange:a:x3")).toBe(true);
    expect(ids.has("exchange:a:x2")).toBe(true);
    expect(ids.has("exchange:a:x1")).toBe(true);
    // Contains ancestry preserved so operators see BOTH hosts + vhosts that
    // participate in the shovel chain.
    expect(ids.has("host:a")).toBe(true);
    expect(ids.has("vhost:a:/")).toBe(true);
    expect(ids.has("host:b")).toBe(true);
    expect(ids.has("vhost:b:/")).toBe(true);
    // Unrelated queue on host:a is not on this shovel chain.
    expect(ids.has("queue:a:q1")).toBe(true); // x3 → q1 is also downstream of x3 — kept
    // Focused edge set includes both `shovels` edges.
    const edgeIds = new Set(focused!.edges.map((e) => e.id));
    expect(edgeIds.has("s:x3->s1")).toBe(true);
    expect(edgeIds.has("s:s1->q2")).toBe(true);
  });

  it("focus on a middle exchange (exchange:a:x2) reaches BOTH upstream (x1) AND downstream (x3, q1, shovel, queue:b:q2) — proves the direction:'both' traversal", () => {
    const { focused } = composeFocusedTopology({
      graph: applyGraphFilters(shovelChainFixture()),
      visibility: createEmptyVisibility(),
      focusNodeId: "exchange:a:x2",
      focusMaxDepth: 32,
    });
    expect(focused).toBeDefined();
    const ids = new Set(focused!.nodes.map((n) => n.id));
    // Upstream from x2: x1
    expect(ids.has("exchange:a:x1")).toBe(true);
    // Downstream from x2: x3 → q1 AND x3 → shovel → queue:b:q2
    expect(ids.has("exchange:a:x3")).toBe(true);
    expect(ids.has("queue:a:q1")).toBe(true);
    expect(ids.has("shovel:a:s1")).toBe(true);
    expect(ids.has("queue:b:q2")).toBe(true);
    // Every routing edge on the chain survives — no dangling handles for
    // React Flow when this focused subgraph is rendered.
    const flow = toReactFlowElements(focused!, { includeContains: false });
    const renderedNodeIds = new Set(flow.nodes.map((n) => n.id));
    for (const e of flow.edges) {
      expect(renderedNodeIds.has(e.source)).toBe(true);
      expect(renderedNodeIds.has(e.target)).toBe(true);
    }
  });

  it("focus on the shovel node (shovel:a:s1) itself walks BOTH the incoming exchange chain and the outgoing destination queue", () => {
    const { focused } = composeFocusedTopology({
      graph: applyGraphFilters(shovelChainFixture()),
      visibility: createEmptyVisibility(),
      focusNodeId: "shovel:a:s1",
      focusMaxDepth: 32,
    });
    expect(focused).toBeDefined();
    const ids = new Set(focused!.nodes.map((n) => n.id));
    // Upstream from the shovel: exchange:a:x3 → x2 → x1
    expect(ids.has("exchange:a:x3")).toBe(true);
    expect(ids.has("exchange:a:x2")).toBe(true);
    expect(ids.has("exchange:a:x1")).toBe(true);
    // Downstream from the shovel: queue:b:q2
    expect(ids.has("queue:b:q2")).toBe(true);
    // The shovel itself is the focus target.
    expect(ids.has("shovel:a:s1")).toBe(true);
    // Focus is not "missing".
    expect(focused!.focusMissing).toBe(false);
  });

  it("branching regression: focus on the source of a fan-out exchange preserves every downstream branch through composeFocusedTopology", () => {
    // Extend the shovel-chain fixture with an alternate downstream queue so
    // exchange:a:x3 branches into TWO destinations — queue:a:q1 (existing) and
    // shovel:a:s1 → queue:b:q2. A focused view rooted at x3 must keep both
    // branches; a wiring bug that only followed the first outgoing edge would
    // drop one and fail this assertion.
    const fixture = shovelChainFixture();
    fixture.nodes.push({
      id: "queue:a:branch",
      kind: "queue",
      label: "branch.q",
      data: { hostId: "host:a", vhostId: "vhost:a:/" },
    });
    fixture.edges.push(
      { id: "c:vhost-a->branch", from: "vhost:a:/", to: "queue:a:branch", kind: "contains" },
      { id: "b:x3->branch", from: "exchange:a:x3", to: "queue:a:branch", kind: "binds", routingKey: "*" },
    );
    const { focused } = composeFocusedTopology({
      graph: applyGraphFilters(fixture),
      visibility: createEmptyVisibility(),
      focusNodeId: "exchange:a:x3",
      focusMaxDepth: 32,
    });
    expect(focused).toBeDefined();
    const ids = new Set(focused!.nodes.map((n) => n.id));
    // All THREE downstream branches survive: queue:a:q1 (original binding),
    // queue:a:branch (the new fan-out), and queue:b:q2 via the shovel.
    expect(ids.has("queue:a:q1")).toBe(true);
    expect(ids.has("queue:a:branch")).toBe(true);
    expect(ids.has("queue:b:q2")).toBe(true);
    expect(ids.has("shovel:a:s1")).toBe(true);
    // Every focused edge id that connects to x3 downstream is present.
    const edgeIds = new Set(focused!.edges.map((e) => e.id));
    expect(edgeIds.has("b:x3->q1")).toBe(true);
    expect(edgeIds.has("b:x3->branch")).toBe(true);
    expect(edgeIds.has("s:x3->s1")).toBe(true);
  });

  it("reset regression: clearing focusNodeId (compose call #2 without it) returns the full-topology renderInput — proves the canvas 'Show full topology' path restores everything", () => {
    const fixture = shovelChainFixture();
    // With focus: rendered subgraph is clipped.
    const focused = composeFocusedTopology({
      graph: applyGraphFilters(fixture),
      visibility: createEmptyVisibility(),
      focusNodeId: "queue:b:q2",
      focusMaxDepth: 32,
    });
    expect(focused.focused).toBeDefined();
    const focusedIds = new Set(focused.renderInput.nodes.map((n) => n.id));
    expect(focusedIds.has("queue:a:q1")).toBe(true); // clipped view still reachable via x3

    // Second compose call with focus cleared — mimics the canvas's
    // "Show full topology" transition (`onFocusChange(undefined)`).
    const unfocused = composeFocusedTopology({
      graph: applyGraphFilters(fixture),
      visibility: createEmptyVisibility(),
    });
    expect(unfocused.focused).toBeUndefined();
    // Every original node is back in the render input — including any host:a
    // entity that wasn't on the shovel chain.
    const unfocusedIds = new Set(unfocused.renderInput.nodes.map((n) => n.id));
    for (const n of fixture.nodes) expect(unfocusedIds.has(n.id)).toBe(true);
    // Identity check: renderInput points at the visible payload when focus
    // is off (not at a stale focused subgraph from the previous compose).
    expect(unfocused.renderInput.nodes).toBe(unfocused.visible.nodes);
    expect(unfocused.renderInput.edges).toBe(unfocused.visible.edges);
  });

  it("depth truncation still applies on shovel chains: focusMaxDepth=1 keeps only the shovel's immediate neighbors and reports truncated=true", () => {
    const { focused } = composeFocusedTopology({
      graph: applyGraphFilters(shovelChainFixture()),
      visibility: createEmptyVisibility(),
      focusNodeId: "shovel:a:s1",
      focusMaxDepth: 1,
    });
    expect(focused).toBeDefined();
    const ids = new Set(focused!.nodes.map((n) => n.id));
    // 1 hop each side: exchange:a:x3 (upstream) + queue:b:q2 (downstream) + focus.
    expect(ids.has("shovel:a:s1")).toBe(true);
    expect(ids.has("exchange:a:x3")).toBe(true);
    expect(ids.has("queue:b:q2")).toBe(true);
    // Excluded by depth cap.
    expect(ids.has("exchange:a:x2")).toBe(false);
    expect(ids.has("exchange:a:x1")).toBe(false);
    expect(focused!.truncated).toBe(true);
  });
});

describe("TopologyGraphCanvas pipeline — bulk visibility hide layered on broad filters composes correctly", () => {
  it("bulk-hiding the ids matching a search substring drops every match from applyVisibility while leaving non-matches + filter-removed nodes untouched", () => {
    // Broad filter to host:a survivors, then bulk-hide the ids whose label
    // contains the substring "x". Simulates the panel's Hide-all-matches path.
    const filtered = applyGraphFilters(pipelineFixture(), {
      hostIds: new Set(["host:a"]),
    });
    const matchIds = filtered.nodes
      .filter((n) => (n.kind === "queue" || n.kind === "exchange"))
      .filter((n) => n.label.toLowerCase().includes("x"))
      .map((n) => n.id);
    // Sanity: matches include the three x1/x2/x3 exchanges on host:a.
    expect(matchIds).toContain("exchange:a:x1");
    expect(matchIds).toContain("exchange:a:x2");
    expect(matchIds).toContain("exchange:a:x3");
    const state = hideNodes(createEmptyVisibility(), matchIds);
    const out = applyVisibility(filtered, state);
    const visibleIds = new Set(out.nodes.map((n) => n.id));
    // Every match is gone from the rendered graph.
    for (const id of matchIds) expect(visibleIds.has(id)).toBe(false);
    // Non-match survivor (queue:a:q1) is still visible.
    expect(visibleIds.has("queue:a:q1")).toBe(true);
    // Filter-removed nodes stay gone (queue:b:q2 was on host:b).
    expect(visibleIds.has("queue:b:q2")).toBe(false);
    // No dangling edges rendered.
    for (const e of out.edges) {
      expect(visibleIds.has(e.from)).toBe(true);
      expect(visibleIds.has(e.to)).toBe(true);
    }
  });

  it("bulk-hide preserves an active isolatedFocus — matches are added to the deny-list on top of isolation, not layered over a cleared focus", () => {
    const filtered = applyGraphFilters(pipelineFixture(), {
      hostIds: new Set(["host:a"]),
    });
    const isolated = isolateNeighborhood(createEmptyVisibility(), "queue:a:q1", {
      depth: 2,
      direction: "both",
    });
    // Bulk-hide "x" matches on top of the isolation. hideNodes never touches
    // isolatedFocus by construction — this pins that invariant end-to-end.
    const state = hideNodes(isolated, ["exchange:a:x3"]);
    expect(state.isolatedFocus?.focusNodeId).toBe("queue:a:q1");
    const out = applyVisibility(filtered, state);
    const visibleIds = new Set(out.nodes.map((n) => n.id));
    expect(visibleIds.has("queue:a:q1")).toBe(true);
    expect(visibleIds.has("exchange:a:x3")).toBe(false);
  });
});

describe("TopologyGraphCanvas pipeline — BIDIRECTIONAL selection highlight composes with filters + visibility + isolation (task 58 canvas-pipeline regression)", () => {
  /**
   * Fixture — the exact task-58 exemplar (`exchange → exchange → shovel →
   * exchange → queue`) with two additions used by the composition tests:
   *   - a downstream fan-out (`queue:b:q2`) that survives the shovel,
   *   - a completely unrelated pair (`exchange:a:noise → queue:a:noise`)
   *     that must NEVER appear in the highlight regardless of pipeline
   *     stage, so the "exclude unrelated edges" contract is observable
   *     at every composition step.
   */
  function bidirectionalCanvasFixture(): BuildGraphResult {
    const base = shovelChainFixture();
    base.nodes.push(
      { id: "exchange:a:noise", kind: "exchange", label: "noise", data: { hostId: "host:a", vhostId: "vhost:a:/", type: "topic" } },
      { id: "queue:a:noise", kind: "queue", label: "noise", data: { hostId: "host:a", vhostId: "vhost:a:/" } },
    );
    base.edges.push(
      { id: "c:vhost-a->noise-x", from: "vhost:a:/", to: "exchange:a:noise", kind: "contains" },
      { id: "c:vhost-a->noise-q", from: "vhost:a:/", to: "queue:a:noise", kind: "contains" },
      { id: "b:noise", from: "exchange:a:noise", to: "queue:a:noise", kind: "binds", routingKey: "n" },
    );
    return base;
  }

  it("full shovel-chain end-to-end: selecting the shovel highlights every chain node upstream (x2, x1) AND downstream (x3, q1, q2) — the task-58 canonical example", () => {
    const graph = applyGraphFilters(bidirectionalCanvasFixture());
    const highlight = computeBidirectionalHighlight(
      { nodes: graph.nodes, edges: graph.edges },
      "shovel:a:s1",
    );
    // Selecting the shovel walks upstream through its inbound `shovels`
    // edge and every exchange-to-exchange binding chain, then downstream
    // through its outbound `shovels` edge. queue:a:q1 is downstream of
    // exchange:a:x3 but NOT downstream of the shovel — it belongs to a
    // different branch and must NOT be highlighted from a shovel selection.
    for (const id of [
      "exchange:a:x1",
      "exchange:a:x2",
      "exchange:a:x3",
      "shovel:a:s1",
      "queue:b:q2",
    ]) {
      expect(highlight.nodeIds.has(id)).toBe(true);
    }
    expect(highlight.nodeIds.has("queue:a:q1")).toBe(false);
    // Every routing edge on the shovel-anchored chain participates.
    for (const id of [
      "b:x1->x2",
      "b:x2->x3",
      "s:x3->s1",
      "s:s1->q2",
    ]) {
      expect(highlight.edgeIds.has(id)).toBe(true);
    }
    // Sibling branch edge (x3 → q1) is NOT on the shovel's own chain and
    // MUST NOT be highlighted from a shovel selection.
    expect(highlight.edgeIds.has("b:x3->q1")).toBe(false);
    expect(highlight.incomingCount).toBe(3); // x3, x2, x1 (all upstream of the shovel)
    expect(highlight.outgoingCount).toBe(1); // queue:b:q2 (shovel destination)
  });

  it("unrelated `exchange:a:noise → queue:a:noise` pair is NEVER highlighted — proves the traversal walks only reachable routing edges from the focus node, and never bleeds into disconnected sub-graphs", () => {
    const graph = applyGraphFilters(bidirectionalCanvasFixture());
    // Try every chain participant as the selection — none of them may drag
    // the noise pair into the highlight.
    for (const target of [
      "exchange:a:x1",
      "exchange:a:x2",
      "exchange:a:x3",
      "shovel:a:s1",
      "queue:a:q1",
      "queue:b:q2",
    ]) {
      const h = computeBidirectionalHighlight(
        { nodes: graph.nodes, edges: graph.edges },
        target,
      );
      expect(h.nodeIds.has("exchange:a:noise")).toBe(false);
      expect(h.nodeIds.has("queue:a:noise")).toBe(false);
      expect(h.edgeIds.has("b:noise")).toBe(false);
    }
  });

  it("bidirectional highlight composes with a BROAD HOST filter: hiding host:b prevents queue:b:q2 (the shovel destination) from being highlighted — the highlight sees only the FILTERED graph, not the raw graph", () => {
    // Broad filter: hide host:b. queue:b:q2 disappears from the pre-filter
    // rawGraph the highlight is computed on — so the shovel's downstream
    // half must be truncated in the highlight.
    const filtered = applyGraphFilters(bidirectionalCanvasFixture(), {
      hostIds: new Set(["host:a"]),
    });
    const h = computeBidirectionalHighlight(
      { nodes: filtered.nodes, edges: filtered.edges },
      "shovel:a:s1",
    );
    // Upstream still intact: exchange:a:x1..x3 all reachable.
    expect(h.nodeIds.has("exchange:a:x1")).toBe(true);
    expect(h.nodeIds.has("exchange:a:x2")).toBe(true);
    expect(h.nodeIds.has("exchange:a:x3")).toBe(true);
    // Downstream half is truncated — queue:b:q2 was removed by the filter
    // and MUST NOT be resurrected by the highlight. The shovel's only
    // outbound routing edge (s1 → q2) is also gone from the filtered edge
    // set, so the shovel has zero downstream reach post-filter.
    expect(h.nodeIds.has("queue:b:q2")).toBe(false);
    expect(h.edgeIds.has("s:s1->q2")).toBe(false);
    expect(h.outgoingCount).toBe(0);
  });

  it("bidirectional highlight composes with VISIBILITY hide: hiding a mid-chain exchange cuts the highlight at that point without resurrecting the hidden node", () => {
    // Hide exchange:a:x3 through the visibility layer. The highlight input
    // is the post-visibility graph, so the pipeline's real behavior is
    // exercised here: applyGraphFilters → applyVisibility → highlight.
    const filtered = applyGraphFilters(bidirectionalCanvasFixture());
    const visibility = hideNodes(createEmptyVisibility(), ["exchange:a:x3"]);
    const visible = applyVisibility(filtered, visibility);
    const h = computeBidirectionalHighlight(
      { nodes: visible.nodes, edges: visible.edges },
      "shovel:a:s1",
    );
    // Hidden node MUST NOT reappear via the highlight.
    expect(h.nodeIds.has("exchange:a:x3")).toBe(false);
    // Downstream half stops at the shovel (the shovel's only downstream
    // path was via x3 → q1) but the direct shovel destination queue:b:q2
    // remains reachable because that path is s1 → q2 directly.
    expect(h.nodeIds.has("queue:b:q2")).toBe(true);
    // queue:a:q1 is now unreachable from the shovel (its only inbound was
    // via the hidden x3), so it MUST NOT be highlighted.
    expect(h.nodeIds.has("queue:a:q1")).toBe(false);
  });

  it("bidirectional highlight composes with ISOLATION: isolating the shovel's neighborhood constrains the highlight universe — nothing outside the isolation set is highlighted", () => {
    // Isolate to depth-2 both directions from the shovel — that keeps the
    // shovel, its immediate neighbors (x3 upstream, q2 downstream), and one
    // hop past each (x2 upstream, none past q2 downstream) plus contains
    // ancestry. Everything else disappears from the visibility overlay,
    // including queue:a:q1 (reachable via x3 → q1 downstream but outside
    // the isolation depth's shovel-anchored slice).
    const filtered = applyGraphFilters(bidirectionalCanvasFixture());
    const isolated = isolateNeighborhood(createEmptyVisibility(), "shovel:a:s1", {
      depth: 1,
      direction: "both",
    });
    const visible = applyVisibility(filtered, isolated);
    const visibleIds = new Set(visible.nodes.map((n) => n.id));
    // Sanity: isolation kept shovel + its immediate neighbors + contains ancestry.
    expect(visibleIds.has("shovel:a:s1")).toBe(true);
    expect(visibleIds.has("exchange:a:x3")).toBe(true);
    expect(visibleIds.has("queue:b:q2")).toBe(true);
    // Now run the bidirectional highlight over the isolated slice.
    const h = computeBidirectionalHighlight(
      { nodes: visible.nodes, edges: visible.edges },
      "shovel:a:s1",
    );
    // The highlight only ever picks up isolation-visible nodes — even the
    // ones structurally reachable in the raw graph (x2, x1, q1, noise pair)
    // are absent because they were excised by isolation.
    for (const id of h.nodeIds) {
      expect(visibleIds.has(id)).toBe(true);
    }
    // The isolation slice may still contain the parent hosts/vhosts (contains
    // ancestry), which do NOT participate in routing edges — so the
    // highlight's node set is exactly the routing participants inside the
    // isolation slice.
    expect(h.nodeIds.has("shovel:a:s1")).toBe(true);
    expect(h.nodeIds.has("exchange:a:x3")).toBe(true);
    expect(h.nodeIds.has("queue:b:q2")).toBe(true);
    // Confirm the noise pair is still absent regardless.
    expect(h.nodeIds.has("exchange:a:noise")).toBe(false);
    expect(h.nodeIds.has("queue:a:noise")).toBe(false);
  });

  it("bidirectional highlight edge set never references a node outside `highlight.nodeIds` (no dangling handles) — the invariant React Flow relies on to render selection-dimmed edges without crashing", () => {
    const graph = applyGraphFilters(bidirectionalCanvasFixture());
    const input = { nodes: graph.nodes, edges: graph.edges };
    // Try every supported selection kind against the fixture and pin the
    // invariant for each — a wiring bug that expanded edges without
    // gating on the highlighted node set would fail here immediately.
    for (const target of [
      "exchange:a:x1",
      "exchange:a:x2",
      "exchange:a:x3",
      "shovel:a:s1",
      "queue:a:q1",
      "queue:b:q2",
    ]) {
      const h = computeBidirectionalHighlight(input, target);
      const edgeById = new Map(input.edges.map((e) => [e.id, e]));
      for (const edgeId of h.edgeIds) {
        const edge = edgeById.get(edgeId);
        expect(edge).toBeDefined();
        expect(h.nodeIds.has(edge!.from)).toBe(true);
        expect(h.nodeIds.has(edge!.to)).toBe(true);
      }
    }
  });
});
