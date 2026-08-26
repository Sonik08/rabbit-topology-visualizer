import { describe, expect, it } from "vitest";
import { pruneNeighborhood } from "../../../src/core/graph/pruneNeighborhood";
import type { BuildGraphResult } from "../../../src/core/graph/buildGraph";
import type { GraphEdge, GraphNode } from "../../../src/core/model";

/**
 * Fixture: a 5-hop chain of exchanges into a queue, with structural
 * host → vhost → entity `contains` edges, plus one side-branch exchange that
 * publishes into x3. Layout (routing edges only):
 *
 *   x0 → x1 → x2 → x3 → x4 → q
 *              side ↗
 */
function fixture(): BuildGraphResult {
  const nodes: GraphNode[] = [
    { id: "host:h", kind: "host", label: "h", data: { id: "host:h", name: "h", sourceFiles: [] } },
    { id: "vhost:h:/", kind: "vhost", label: "/", data: { id: "vhost:h:/", hostId: "host:h", name: "/" } },
    { id: "exchange:h:x0", kind: "exchange", label: "x0" },
    { id: "exchange:h:x1", kind: "exchange", label: "x1" },
    { id: "exchange:h:x2", kind: "exchange", label: "x2" },
    { id: "exchange:h:x3", kind: "exchange", label: "x3" },
    { id: "exchange:h:x4", kind: "exchange", label: "x4" },
    { id: "exchange:h:side", kind: "exchange", label: "side" },
    { id: "queue:h:q", kind: "queue", label: "q" },
    { id: "queue:h:orphan", kind: "queue", label: "orphan" },
  ];
  const edges: GraphEdge[] = [
    { id: "c:host->vhost", from: "host:h", to: "vhost:h:/", kind: "contains" },
    { id: "c:vhost->x0", from: "vhost:h:/", to: "exchange:h:x0", kind: "contains" },
    { id: "c:vhost->x1", from: "vhost:h:/", to: "exchange:h:x1", kind: "contains" },
    { id: "c:vhost->x2", from: "vhost:h:/", to: "exchange:h:x2", kind: "contains" },
    { id: "c:vhost->x3", from: "vhost:h:/", to: "exchange:h:x3", kind: "contains" },
    { id: "c:vhost->x4", from: "vhost:h:/", to: "exchange:h:x4", kind: "contains" },
    { id: "c:vhost->side", from: "vhost:h:/", to: "exchange:h:side", kind: "contains" },
    { id: "c:vhost->q", from: "vhost:h:/", to: "queue:h:q", kind: "contains" },
    { id: "c:vhost->orphan", from: "vhost:h:/", to: "queue:h:orphan", kind: "contains" },
    { id: "b:x0->x1", from: "exchange:h:x0", to: "exchange:h:x1", kind: "binds", routingKey: "k" },
    { id: "b:x1->x2", from: "exchange:h:x1", to: "exchange:h:x2", kind: "binds", routingKey: "k" },
    { id: "b:x2->x3", from: "exchange:h:x2", to: "exchange:h:x3", kind: "binds", routingKey: "k" },
    { id: "b:x3->x4", from: "exchange:h:x3", to: "exchange:h:x4", kind: "binds", routingKey: "k" },
    { id: "b:x4->q", from: "exchange:h:x4", to: "queue:h:q", kind: "binds", routingKey: "k" },
    { id: "b:side->x3", from: "exchange:h:side", to: "exchange:h:x3", kind: "binds", routingKey: "s" },
    { id: "dl:x3->q", from: "exchange:h:x3", to: "queue:h:q", kind: "dead-letter" },
  ];
  return { nodes, edges, diagnostics: [] };
}

describe("pruneNeighborhood — focus node handling", () => {
  it("returns focusMissing when focusNodeId is undefined", () => {
    const out = pruneNeighborhood(fixture(), undefined);
    expect(out.focusMissing).toBe(true);
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
  });

  it("returns focusMissing when the focus id is not in the graph", () => {
    const out = pruneNeighborhood(fixture(), "queue:does-not-exist");
    expect(out.focusMissing).toBe(true);
    expect(out.nodes).toEqual([]);
  });
});

describe("pruneNeighborhood — direction and depth", () => {
  it("upstream-only walk from the queue reaches only ancestors (never descendants)", () => {
    const out = pruneNeighborhood(fixture(), "queue:h:q", {
      direction: "upstream",
      maxDepth: 2,
    });
    const kept = new Set(out.nodes.map((n) => n.id));
    // Depth-2 upstream from q: q, x4, x3 (and side via x3? No — side is a
    // sibling ancestor of x3 that would need depth 3 from q).
    expect(kept.has("queue:h:q")).toBe(true);
    expect(kept.has("exchange:h:x4")).toBe(true);
    expect(kept.has("exchange:h:x3")).toBe(true);
    expect(kept.has("exchange:h:x2")).toBe(false);
    expect(kept.has("exchange:h:side")).toBe(false);
    expect(out.truncated).toBe(true);
  });

  it("downstream-only walk from x0 reaches only descendants", () => {
    const out = pruneNeighborhood(fixture(), "exchange:h:x0", {
      direction: "downstream",
      maxDepth: 2,
    });
    const kept = new Set(out.nodes.map((n) => n.id));
    expect(kept.has("exchange:h:x0")).toBe(true);
    expect(kept.has("exchange:h:x1")).toBe(true);
    expect(kept.has("exchange:h:x2")).toBe(true);
    // x3, x4, q are >2 hops downstream from x0 → not included
    expect(kept.has("exchange:h:x3")).toBe(false);
    expect(kept.has("queue:h:q")).toBe(false);
    expect(out.truncated).toBe(true);
  });

  it("both-direction walk (default) from x3 reaches both ancestors AND descendants within depth", () => {
    const out = pruneNeighborhood(fixture(), "exchange:h:x3", { maxDepth: 1 });
    const kept = new Set(out.nodes.map((n) => n.id));
    expect(kept.has("exchange:h:x2")).toBe(true); // one hop upstream
    expect(kept.has("exchange:h:side")).toBe(true); // one hop upstream (branch)
    expect(kept.has("exchange:h:x4")).toBe(true); // one hop downstream
    expect(kept.has("exchange:h:x1")).toBe(false); // 2 hops upstream
    expect(kept.has("queue:h:q")).toBe(false); // 2 hops downstream
  });

  it("maxDepth=0 keeps only the focus (plus structural ancestry) and marks truncated", () => {
    const out = pruneNeighborhood(fixture(), "exchange:h:x3", { maxDepth: 0 });
    const kept = new Set(out.nodes.map((n) => n.id));
    expect(kept.has("exchange:h:x3")).toBe(true);
    expect(kept.has("exchange:h:x2")).toBe(false);
    expect(kept.has("exchange:h:x4")).toBe(false);
    // Structural ancestry preserved by default
    expect(kept.has("vhost:h:/")).toBe(true);
    expect(kept.has("host:h")).toBe(true);
    expect(out.truncated).toBe(true);
  });

  it("truncated stays false when the full depth still reaches every leaf", () => {
    const out = pruneNeighborhood(fixture(), "queue:h:q", {
      direction: "upstream",
      maxDepth: 32,
    });
    // 5-hop chain fully covered; no remaining frontier
    expect(out.truncated).toBe(false);
  });

  it("regression: two-node A→B graph with focus A + direction both + maxDepth=1 is NOT truncated (adjacent endpoint already kept)", () => {
    // Reviewer-supplied edge case: at depth 1 (B), the only incident routing
    // edge points back to A which is already in `keep`. The correct answer
    // is truncated=false because no unvisited node was cut off.
    const twoNode: BuildGraphResult = {
      nodes: [
        { id: "A", kind: "exchange", label: "A" },
        { id: "B", kind: "queue", label: "B" },
      ],
      edges: [{ id: "b:A->B", from: "A", to: "B", kind: "binds", routingKey: "" }],
      diagnostics: [],
    };
    const out = pruneNeighborhood(twoNode, "A", { direction: "both", maxDepth: 1 });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["A", "B"]);
    expect(out.truncated).toBe(false);
  });

  it("regression: truncated stays false when the deepest node in the graph sits exactly at maxDepth", () => {
    // Chain x0 → x1 → x2 → x3 with focus x0, downstream, maxDepth=3.
    // x3 is enqueued at depth 3 = maxDepth. At the cap, x3's only incident
    // edge points back to x2 which is already kept → no truncation.
    const nodes: GraphNode[] = [
      { id: "x0", kind: "exchange", label: "x0" },
      { id: "x1", kind: "exchange", label: "x1" },
      { id: "x2", kind: "exchange", label: "x2" },
      { id: "x3", kind: "exchange", label: "x3" },
    ];
    const edges: GraphEdge[] = [
      { id: "b:x0->x1", from: "x0", to: "x1", kind: "binds", routingKey: "" },
      { id: "b:x1->x2", from: "x1", to: "x2", kind: "binds", routingKey: "" },
      { id: "b:x2->x3", from: "x2", to: "x3", kind: "binds", routingKey: "" },
    ];
    const out = pruneNeighborhood(
      { nodes, edges, diagnostics: [] },
      "x0",
      { direction: "downstream", maxDepth: 3 },
    );
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["x0", "x1", "x2", "x3"]);
    expect(out.truncated).toBe(false);
  });

  it("regression: diamond ancestors at maxDepth do not flip truncated when their shared parent is already kept", () => {
    // A → B, A → C, both B and C bind to D. Focus D upstream, maxDepth=2.
    // At depth 2, B and C both see incoming edges from A which is already
    // kept (also at depth 2) → no truncation, entire diamond is retained.
    const nodes: GraphNode[] = [
      { id: "A", kind: "exchange", label: "A" },
      { id: "B", kind: "exchange", label: "B" },
      { id: "C", kind: "exchange", label: "C" },
      { id: "D", kind: "queue", label: "D" },
    ];
    const edges: GraphEdge[] = [
      { id: "b:A->B", from: "A", to: "B", kind: "binds", routingKey: "" },
      { id: "b:A->C", from: "A", to: "C", kind: "binds", routingKey: "" },
      { id: "b:B->D", from: "B", to: "D", kind: "binds", routingKey: "" },
      { id: "b:C->D", from: "C", to: "D", kind: "binds", routingKey: "" },
    ];
    const out = pruneNeighborhood(
      { nodes, edges, diagnostics: [] },
      "D",
      { direction: "upstream", maxDepth: 2 },
    );
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["A", "B", "C", "D"]);
    expect(out.truncated).toBe(false);
  });
});

describe("pruneNeighborhood — normalized maxDepth edge cases", () => {
  it("negative maxDepth → 0 (only the focus + structural ancestry)", () => {
    const out = pruneNeighborhood(fixture(), "exchange:h:x3", { maxDepth: -5 });
    expect(out.nodes.some((n) => n.id === "exchange:h:x3")).toBe(true);
    expect(out.nodes.some((n) => n.id === "exchange:h:x2")).toBe(false);
  });

  it("fractional maxDepth is floored", () => {
    const out = pruneNeighborhood(fixture(), "exchange:h:x3", {
      direction: "upstream",
      maxDepth: 1.9,
    });
    // Behaves as depth 1 → only x2 + side are one hop upstream.
    const kept = new Set(out.nodes.map((n) => n.id));
    expect(kept.has("exchange:h:x2")).toBe(true);
    expect(kept.has("exchange:h:x1")).toBe(false);
  });

  it("non-finite maxDepth falls back to default (3)", () => {
    const outDefault = pruneNeighborhood(fixture(), "queue:h:q", {
      direction: "upstream",
      maxDepth: NaN,
    });
    const outExplicit = pruneNeighborhood(fixture(), "queue:h:q", {
      direction: "upstream",
      maxDepth: 3,
    });
    expect(outDefault.nodes.length).toBe(outExplicit.nodes.length);
  });
});

describe("pruneNeighborhood — dead-letter opt-in", () => {
  it("dead-letter edges are excluded from the frontier by default", () => {
    const out = pruneNeighborhood(fixture(), "exchange:h:x3", {
      direction: "downstream",
      maxDepth: 1,
    });
    // The dead-letter dl:x3->q edge is NOT followed by default, so q must
    // not be in the neighborhood (there is no `binds` from x3 to q directly).
    expect(out.nodes.some((n) => n.id === "queue:h:q")).toBe(false);
  });

  it("dead-letter edges are followed when followDeadLetter=true", () => {
    const out = pruneNeighborhood(fixture(), "exchange:h:x3", {
      direction: "downstream",
      maxDepth: 1,
      followDeadLetter: true,
    });
    expect(out.nodes.some((n) => n.id === "queue:h:q")).toBe(true);
  });
});

describe("pruneNeighborhood — structural ancestry", () => {
  it("keeps host + vhost above every surviving entity by default", () => {
    const out = pruneNeighborhood(fixture(), "exchange:h:x3", { maxDepth: 1 });
    const kept = new Set(out.nodes.map((n) => n.id));
    expect(kept.has("host:h")).toBe(true);
    expect(kept.has("vhost:h:/")).toBe(true);
    // But NOT the orphan queue that isn't in the neighborhood
    expect(kept.has("queue:h:orphan")).toBe(false);
  });

  it("strips structural ancestry when keepContainsAncestry=false", () => {
    const out = pruneNeighborhood(fixture(), "exchange:h:x3", {
      maxDepth: 0,
      keepContainsAncestry: false,
    });
    const kept = new Set(out.nodes.map((n) => n.id));
    expect(kept.has("exchange:h:x3")).toBe(true);
    expect(kept.has("host:h")).toBe(false);
    expect(kept.has("vhost:h:/")).toBe(false);
  });
});

describe("pruneNeighborhood — no dangling edges leak through", () => {
  it("every edge in the output has both endpoints in the kept node set", () => {
    const out = pruneNeighborhood(fixture(), "exchange:h:x3", { maxDepth: 1 });
    const kept = new Set(out.nodes.map((n) => n.id));
    for (const e of out.edges) {
      expect(kept.has(e.from)).toBe(true);
      expect(kept.has(e.to)).toBe(true);
    }
  });

  it("diagnostics are passed through unchanged (byRef so callers see the same list)", () => {
    const input = fixture();
    const out = pruneNeighborhood(input, "exchange:h:x3");
    expect(out.diagnostics).toBe(input.diagnostics);
  });
});

describe("pruneNeighborhood — large-graph performance", () => {
  it("N=2000 chain neighborhood at depth 10 completes well under 100 ms", () => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 2000; i += 1) {
      nodes.push({ id: `x${i}`, kind: "exchange", label: `x${i}` });
      if (i > 0) {
        edges.push({
          id: `b:${i - 1}->${i}`,
          from: `x${i - 1}`,
          to: `x${i}`,
          kind: "binds",
          routingKey: "k",
        });
      }
    }
    const graph: BuildGraphResult = { nodes, edges, diagnostics: [] };
    const t0 = performance.now();
    const out = pruneNeighborhood(graph, "x1000", { maxDepth: 10 });
    const elapsed = performance.now() - t0;
    // 21 nodes: focus + 10 upstream + 10 downstream
    expect(out.nodes.length).toBe(21);
    expect(elapsed).toBeLessThan(100);
    expect(out.truncated).toBe(true);
  });
});
