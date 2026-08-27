import { describe, expect, it } from "vitest";
import type { BuildGraphResult } from "../../../src/core/graph/buildGraph";
import type { GraphEdge, GraphNode } from "../../../src/core/model";
import {
  applyVisibility,
  clearIsolation,
  createEmptyVisibility,
  hideNodes,
  isolateNeighborhood,
  resetVisibility,
  restoreNodes,
  showNodes,
  toggleHiddenNode,
} from "../../../src/core/graph/visibility";

function fixture(): BuildGraphResult {
  const nodes: GraphNode[] = [
    { id: "host:h", kind: "host", label: "h", data: { id: "host:h", name: "h", sourceFiles: [] } },
    { id: "vhost:h:/", kind: "vhost", label: "/", data: { id: "vhost:h:/", hostId: "host:h", name: "/" } },
    { id: "exchange:h:x1", kind: "exchange", label: "x1" },
    { id: "exchange:h:x2", kind: "exchange", label: "x2" },
    { id: "exchange:h:x3", kind: "exchange", label: "x3" },
    { id: "queue:h:q1", kind: "queue", label: "q1" },
    { id: "queue:h:q2", kind: "queue", label: "q2" },
  ];
  const edges: GraphEdge[] = [
    { id: "c:host->vhost", from: "host:h", to: "vhost:h:/", kind: "contains" },
    { id: "c:vhost->x1", from: "vhost:h:/", to: "exchange:h:x1", kind: "contains" },
    { id: "c:vhost->x2", from: "vhost:h:/", to: "exchange:h:x2", kind: "contains" },
    { id: "c:vhost->x3", from: "vhost:h:/", to: "exchange:h:x3", kind: "contains" },
    { id: "c:vhost->q1", from: "vhost:h:/", to: "queue:h:q1", kind: "contains" },
    { id: "c:vhost->q2", from: "vhost:h:/", to: "queue:h:q2", kind: "contains" },
    { id: "b:x1->x2", from: "exchange:h:x1", to: "exchange:h:x2", kind: "binds", routingKey: "k" },
    { id: "b:x2->q1", from: "exchange:h:x2", to: "queue:h:q1", kind: "binds", routingKey: "k" },
    { id: "b:x3->q2", from: "exchange:h:x3", to: "queue:h:q2", kind: "binds", routingKey: "k" },
  ];
  return { nodes, edges, diagnostics: [] };
}

describe("visibility — reducer helpers are immutable", () => {
  it("toggleHiddenNode adds a fresh Set (never mutates the input)", () => {
    const state = createEmptyVisibility();
    const original = state.hiddenNodeIds;
    const next = toggleHiddenNode(state, "queue:h:q1");
    expect(next.hiddenNodeIds.has("queue:h:q1")).toBe(true);
    expect(state.hiddenNodeIds).toBe(original);
    expect(original.size).toBe(0);
    // Toggling again removes the id
    const back = toggleHiddenNode(next, "queue:h:q1");
    expect(back.hiddenNodeIds.has("queue:h:q1")).toBe(false);
  });

  it("hideNodes and showNodes bulk-add/remove ids without mutating the input state", () => {
    const state = createEmptyVisibility();
    const hidden = hideNodes(state, ["queue:h:q1", "queue:h:q2"]);
    expect([...hidden.hiddenNodeIds].sort()).toEqual(["queue:h:q1", "queue:h:q2"]);
    const shown = showNodes(hidden, ["queue:h:q1"]);
    expect([...shown.hiddenNodeIds]).toEqual(["queue:h:q2"]);
    expect([...hidden.hiddenNodeIds].sort()).toEqual(["queue:h:q1", "queue:h:q2"]);
  });

  it("resetVisibility returns a fresh empty state", () => {
    const state = hideNodes(createEmptyVisibility(), ["queue:h:q1"]);
    const reset = resetVisibility();
    expect(reset.hiddenNodeIds.size).toBe(0);
    expect(state.hiddenNodeIds.size).toBe(1);
  });

  it("isolateNeighborhood + clearIsolation are reversible", () => {
    const state = createEmptyVisibility();
    const isolated = isolateNeighborhood(state, "queue:h:q1", { depth: 1 });
    expect(isolated.isolatedFocus?.focusNodeId).toBe("queue:h:q1");
    expect(isolated.isolatedFocus?.depth).toBe(1);
    const cleared = clearIsolation(isolated);
    expect(cleared.isolatedFocus).toBeUndefined();
    // Original isolated state is untouched.
    expect(isolated.isolatedFocus).toBeDefined();
  });
});

describe("visibility — applyVisibility hide + restore", () => {
  it("no-op when the state has no overrides — every node/edge stays visible", () => {
    const g = fixture();
    const out = applyVisibility(g, createEmptyVisibility());
    expect(out.nodes.length).toBe(g.nodes.length);
    expect(out.edges.length).toBe(g.edges.length);
    expect(out.counts.hiddenNodeCount).toBe(0);
    expect(out.effectivelyHidden.size).toBe(0);
  });

  it("hiding a queue drops both the node and every edge incident to it (no dangling edges)", () => {
    const g = fixture();
    const state = hideNodes(createEmptyVisibility(), ["queue:h:q1"]);
    const out = applyVisibility(g, state);
    expect(out.nodes.some((n) => n.id === "queue:h:q1")).toBe(false);
    for (const e of out.edges) {
      expect(e.from).not.toBe("queue:h:q1");
      expect(e.to).not.toBe("queue:h:q1");
    }
    // Counts reflect the hide.
    expect(out.counts.visibleNodes).toBe(g.nodes.length - 1);
    expect(out.counts.totalNodes).toBe(g.nodes.length);
    expect(out.counts.hiddenNodeCount).toBe(1);
    // Effective deny-list contains exactly the hidden queue.
    expect([...out.effectivelyHidden]).toEqual(["queue:h:q1"]);
  });

  it("restoring a previously-hidden queue (via showNodes) brings it back", () => {
    const g = fixture();
    const hidden = hideNodes(createEmptyVisibility(), ["queue:h:q1"]);
    const restored = showNodes(hidden, ["queue:h:q1"]);
    const out = applyVisibility(g, restored);
    expect(out.nodes.length).toBe(g.nodes.length);
    expect(out.edges.length).toBe(g.edges.length);
    expect(out.counts.hiddenNodeCount).toBe(0);
  });
});

describe("visibility — neighborhood isolation", () => {
  it("isolating queue:h:q1 at depth=1 shows only q1 + its immediate upstream/structural neighbours", () => {
    const g = fixture();
    const state = isolateNeighborhood(createEmptyVisibility(), "queue:h:q1", {
      depth: 1,
      direction: "both",
    });
    const out = applyVisibility(g, state);
    const kept = new Set(out.nodes.map((n) => n.id));
    // Focus + one-hop upstream (x2 through binds) + structural ancestors
    // (vhost, host) — the pruneNeighborhood default keeps `contains` ancestry.
    expect(kept.has("queue:h:q1")).toBe(true);
    expect(kept.has("exchange:h:x2")).toBe(true);
    expect(kept.has("host:h")).toBe(true);
    expect(kept.has("vhost:h:/")).toBe(true);
    // Two-hop-away nodes (x1) are NOT in the neighborhood.
    expect(kept.has("exchange:h:x1")).toBe(false);
    // q2 and its branch are NOT in the neighborhood either.
    expect(kept.has("queue:h:q2")).toBe(false);
    expect(kept.has("exchange:h:x3")).toBe(false);
    // No dangling edges.
    for (const e of out.edges) {
      expect(kept.has(e.from)).toBe(true);
      expect(kept.has(e.to)).toBe(true);
    }
  });

  it("hidden ids are still respected inside the isolated neighborhood", () => {
    const g = fixture();
    let state = isolateNeighborhood(createEmptyVisibility(), "queue:h:q1", { depth: 2 });
    state = hideNodes(state, ["exchange:h:x1"]);
    const out = applyVisibility(g, state);
    const kept = new Set(out.nodes.map((n) => n.id));
    expect(kept.has("queue:h:q1")).toBe(true);
    expect(kept.has("exchange:h:x2")).toBe(true);
    // x1 was inside the depth-2 neighborhood but explicitly hidden.
    expect(kept.has("exchange:h:x1")).toBe(false);
  });

  it("degrades gracefully when the focus node id is missing (renders the full graph instead of blank)", () => {
    const g = fixture();
    const state = isolateNeighborhood(createEmptyVisibility(), "queue:missing");
    const out = applyVisibility(g, state);
    expect(out.nodes.length).toBe(g.nodes.length);
  });
});

describe("visibility — restoreNodes handles both explicit and isolation-hidden ids", () => {
  it("restores an explicitly-hidden id (identical to showNodes) without touching isolation", () => {
    const g = fixture();
    let state = isolateNeighborhood(createEmptyVisibility(), "queue:h:q1", { depth: 3 });
    state = hideNodes(state, ["exchange:h:x2"]);
    const restored = restoreNodes(g, state, ["exchange:h:x2"]);
    expect(restored.hiddenNodeIds.has("exchange:h:x2")).toBe(false);
    // Isolation focus is unaffected because x2 was inside the depth-3 neighborhood.
    expect(restored.isolatedFocus?.focusNodeId).toBe("queue:h:q1");
  });

  it("clears isolatedFocus when the requested id was isolation-hidden (not in the neighborhood)", () => {
    const g = fixture();
    const state = isolateNeighborhood(createEmptyVisibility(), "queue:h:q1", {
      depth: 1,
      direction: "both",
    });
    // queue:h:q2 is outside the depth-1 neighborhood => isolation-hidden.
    const restored = restoreNodes(g, state, ["queue:h:q2"]);
    expect(restored.isolatedFocus).toBeUndefined();
    // After clearing isolation the id renders again — verify via applyVisibility.
    const out = applyVisibility(g, restored);
    expect(out.nodes.some((n) => n.id === "queue:h:q2")).toBe(true);
  });
});

describe("visibility — visible-vs-total counts and effectivelyHidden", () => {
  it("counts report totals plus the exact number of hidden nodes and the effective deny-list", () => {
    const g = fixture();
    const state = hideNodes(createEmptyVisibility(), ["queue:h:q1", "exchange:h:x3"]);
    const out = applyVisibility(g, state);
    expect(out.counts.totalNodes).toBe(g.nodes.length);
    expect(out.counts.visibleNodes).toBe(g.nodes.length - 2);
    expect(out.counts.hiddenNodeCount).toBe(2);
    expect([...out.effectivelyHidden].sort()).toEqual([
      "exchange:h:x3",
      "queue:h:q1",
    ]);
  });
});
