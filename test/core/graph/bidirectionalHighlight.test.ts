import { describe, expect, it } from "vitest";
import { bidirectionalForNode } from "../../../src/core/graph/traversal";
import {
  bidirectionalHighlightFromTraversal,
  computeBidirectionalHighlight,
} from "../../../src/core/graph/upstreamHighlight";
import type { GraphEdge, GraphNode } from "../../../src/core/model";

function chainFixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    { id: "exchange:x1", kind: "exchange", label: "x1", data: {} },
    { id: "exchange:x2", kind: "exchange", label: "x2", data: {} },
    { id: "exchange:x3", kind: "exchange", label: "x3", data: {} },
    { id: "shovel:s1", kind: "shovel", label: "s1", data: {} },
    { id: "queue:q1", kind: "queue", label: "q1", data: {} },
    { id: "queue:q.branch", kind: "queue", label: "q.branch", data: {} },
    { id: "exchange:noise", kind: "exchange", label: "noise", data: {} },
    { id: "queue:noise", kind: "queue", label: "noise", data: {} },
  ];
  const edges: GraphEdge[] = [
    { id: "b:x1->x2", from: "exchange:x1", to: "exchange:x2", kind: "binds", routingKey: "k" },
    { id: "b:x2->s1", from: "exchange:x2", to: "shovel:s1", kind: "binds", routingKey: "k" },
    { id: "s:s1->x3", from: "shovel:s1", to: "exchange:x3", kind: "shovels" },
    { id: "b:x3->q1", from: "exchange:x3", to: "queue:q1", kind: "binds", routingKey: "k" },
    { id: "b:x2->branch", from: "exchange:x2", to: "queue:q.branch", kind: "binds", routingKey: "k" },
    // A parallel binding — diamond — so the highlight-expansion contract
    // that includes every routing edge between two highlighted nodes is
    // observable in the tests below.
    { id: "b:x2->branch:alt", from: "exchange:x2", to: "queue:q.branch", kind: "binds", routingKey: "k.alt" },
    { id: "b:noise", from: "exchange:noise", to: "queue:noise", kind: "binds", routingKey: "n" },
  ];
  return { nodes, edges };
}

describe("computeBidirectionalHighlight — task 58 selection highlight", () => {
  it("selecting the shovel in the middle of the chain highlights EVERY chain node incoming AND outgoing — the shovel-in-the-middle canonical case", () => {
    const input = chainFixture();
    const h = computeBidirectionalHighlight(input, "shovel:s1");
    // Every chain participant is present.
    for (const id of ["exchange:x1", "exchange:x2", "shovel:s1", "exchange:x3", "queue:q1"]) {
      expect(h.nodeIds.has(id)).toBe(true);
    }
    // The unrelated noise pair is NOT highlighted.
    expect(h.nodeIds.has("exchange:noise")).toBe(false);
    expect(h.nodeIds.has("queue:noise")).toBe(false);
    // Every chain edge (routing kinds only) participates.
    for (const id of ["b:x1->x2", "b:x2->s1", "s:s1->x3", "b:x3->q1"]) {
      expect(h.edgeIds.has(id)).toBe(true);
    }
    // The task explicitly requires distinguishing incoming vs outgoing —
    // the highlight envelope carries the per-direction counts so the summary
    // bar can render them separately.
    expect(h.incomingCount).toBe(2); // x2, x1
    expect(h.outgoingCount).toBe(2); // x3, q1
    // Downstream branch (queue:q.branch) is NOT included — the shovel only
    // walks the exchange chain that flows through it; the fan-out from x2
    // to q.branch is upstream of the shovel's OUTPUT side but not on the
    // shovel's own upstream path.
    expect(h.nodeIds.has("queue:q.branch")).toBe(false);
  });

  it("selecting a mid-chain EXCHANGE (x2) reaches upstream x1 AND every downstream branch — shovel chain, its terminal queue, AND the fan-out branch", () => {
    const input = chainFixture();
    const h = computeBidirectionalHighlight(input, "exchange:x2");
    expect(h.nodeIds.has("exchange:x1")).toBe(true);
    expect(h.nodeIds.has("shovel:s1")).toBe(true);
    expect(h.nodeIds.has("exchange:x3")).toBe(true);
    expect(h.nodeIds.has("queue:q1")).toBe(true);
    expect(h.nodeIds.has("queue:q.branch")).toBe(true);
    // Diamond expansion: both parallel bindings to q.branch survive because
    // the highlight expansion adds every routing edge whose endpoints both
    // sit in the highlighted node set.
    expect(h.edgeIds.has("b:x2->branch")).toBe(true);
    expect(h.edgeIds.has("b:x2->branch:alt")).toBe(true);
  });

  it("selecting an unsupported node kind (host / vhost / external) is a safe no-op — target-only highlight, no crash, empty counts", () => {
    const input = chainFixture();
    input.nodes.push({ id: "host:a", kind: "host", label: "a", data: {} });
    const h = computeBidirectionalHighlight(input, "host:a");
    expect(h.nodeIds.size).toBe(0);
    expect(h.edgeIds.size).toBe(0);
    expect(h.incomingCount).toBe(0);
    expect(h.outgoingCount).toBe(0);
  });

  it("missing targetNodeId returns empty highlight (guard against undefined selection)", () => {
    const input = chainFixture();
    const h = computeBidirectionalHighlight(input, undefined);
    expect(h.nodeIds.size).toBe(0);
    expect(h.edgeIds.size).toBe(0);
    expect(h.incomingCount).toBe(0);
    expect(h.outgoingCount).toBe(0);
  });

  it("respects `maxDepth` — a shallow cap surfaces `truncated: true` and clips both directions", () => {
    const input = chainFixture();
    const h = computeBidirectionalHighlight(input, "shovel:s1", { maxDepth: 1 });
    expect(h.truncated).toBe(true);
    // With maxDepth 1 the shovel reaches exchange:x2 (upstream) and
    // exchange:x3 (downstream), but not x1 or q1.
    expect(h.nodeIds.has("exchange:x2")).toBe(true);
    expect(h.nodeIds.has("exchange:x3")).toBe(true);
    expect(h.nodeIds.has("exchange:x1")).toBe(false);
    expect(h.nodeIds.has("queue:q1")).toBe(false);
  });

  it("`bidirectionalHighlightFromTraversal` yields the same node/edge sets as computeBidirectionalHighlight — the worker-thread envelope is a drop-in for the main-thread computation", () => {
    const input = chainFixture();
    const traversal = bidirectionalForNode(input, "exchange:x2");
    const fromWorker = bidirectionalHighlightFromTraversal(input, traversal);
    const local = computeBidirectionalHighlight(input, "exchange:x2");
    expect([...fromWorker.nodeIds].sort()).toEqual([...local.nodeIds].sort());
    expect([...fromWorker.edgeIds].sort()).toEqual([...local.edgeIds].sort());
    expect(fromWorker.incomingCount).toBe(local.incomingCount);
    expect(fromWorker.outgoingCount).toBe(local.outgoingCount);
  });

  it("respects a filtered graph: hidden mid-chain nodes prevent the highlight from resurrecting them (compose-with-filters/visibility contract)", () => {
    const input = chainFixture();
    // Simulate the visibility layer stripping shovel:s1 + its incident
    // routing edges from the input handed to the highlight computation.
    const filtered = {
      nodes: input.nodes.filter((n) => n.id !== "shovel:s1"),
      edges: input.edges.filter((e) => e.from !== "shovel:s1" && e.to !== "shovel:s1"),
    };
    const h = computeBidirectionalHighlight(filtered, "queue:q1");
    // shovel:s1 must NOT appear even though it was in the original graph.
    expect(h.nodeIds.has("shovel:s1")).toBe(false);
    // The chain is cut — no ancestors reachable through the shovel gap.
    expect(h.nodeIds.has("exchange:x1")).toBe(false);
    expect(h.nodeIds.has("exchange:x2")).toBe(false);
  });
});
