import { describe, expect, it } from "vitest";
import type { BuildGraphResult } from "../../../src/core/graph/buildGraph";
import type { GraphEdge, GraphNode } from "../../../src/core/model";
import { toReactFlowElements } from "../../../src/ui/components/topologyGraphElements";

function graph(nodes: GraphNode[], edges: GraphEdge[]): BuildGraphResult {
  return { nodes, edges, diagnostics: [] };
}

describe("toReactFlowElements", () => {
  it("assigns a column x-position per node kind and stacks nodes vertically within each column", () => {
    const nodes: GraphNode[] = [
      { id: "host:a", kind: "host", label: "a" },
      { id: "vhost:a:/", kind: "vhost", label: "/" },
      { id: "exchange:a:x1", kind: "exchange", label: "x1" },
      { id: "exchange:a:x2", kind: "exchange", label: "x2" },
      { id: "queue:a:q1", kind: "queue", label: "q1" },
    ];
    const { nodes: flow } = toReactFlowElements(graph(nodes, []));
    const byId = new Map(flow.map((n) => [n.id, n]));
    // Same-kind nodes share the same x; different rows have distinct y.
    expect(byId.get("exchange:a:x1")!.position.x).toBe(
      byId.get("exchange:a:x2")!.position.x,
    );
    expect(byId.get("exchange:a:x1")!.position.y).not.toBe(
      byId.get("exchange:a:x2")!.position.y,
    );
    // Column order host < vhost < exchange < queue.
    expect(byId.get("host:a")!.position.x).toBeLessThan(
      byId.get("vhost:a:/")!.position.x,
    );
    expect(byId.get("vhost:a:/")!.position.x).toBeLessThan(
      byId.get("exchange:a:x1")!.position.x,
    );
    expect(byId.get("exchange:a:x1")!.position.x).toBeLessThan(
      byId.get("queue:a:q1")!.position.x,
    );
    // Labels are carried through and node kind is preserved.
    expect(byId.get("queue:a:q1")!.data.label).toBe("q1");
    expect(byId.get("queue:a:q1")!.data.kind).toBe("queue");
  });

  it("omits contains edges by default and includes them when opted in", () => {
    const nodes: GraphNode[] = [
      { id: "vhost:a:/", kind: "vhost", label: "/" },
      { id: "exchange:a:x1", kind: "exchange", label: "x1" },
    ];
    const edges: GraphEdge[] = [
      {
        id: "contains:vhost:a:/->exchange:a:x1",
        from: "vhost:a:/",
        to: "exchange:a:x1",
        kind: "contains",
      },
    ];
    expect(toReactFlowElements(graph(nodes, edges)).edges).toHaveLength(0);
    expect(
      toReactFlowElements(graph(nodes, edges), { includeContains: true }).edges,
    ).toHaveLength(1);
  });

  it("drops edges whose endpoints are not present in the node set", () => {
    const nodes: GraphNode[] = [
      { id: "exchange:a:x1", kind: "exchange", label: "x1" },
    ];
    const edges: GraphEdge[] = [
      {
        id: "b1",
        from: "exchange:a:x1",
        to: "queue:missing",
        kind: "binds",
      },
    ];
    expect(toReactFlowElements(graph(nodes, edges)).edges).toEqual([]);
  });

  it("renders binding routing keys in the edge label", () => {
    const nodes: GraphNode[] = [
      { id: "exchange:a:x1", kind: "exchange", label: "x1" },
      { id: "queue:a:q1", kind: "queue", label: "q1" },
    ];
    const edges: GraphEdge[] = [
      {
        id: "b1",
        from: "exchange:a:x1",
        to: "queue:a:q1",
        kind: "binds",
        routingKey: "orders.#",
      },
    ];
    const [edge] = toReactFlowElements(graph(nodes, edges)).edges;
    expect(edge.label).toContain("orders.#");
    expect(edge.data.routingKey).toBe("orders.#");
  });

  it("animates shovel/federation edges but not binds/routes", () => {
    const nodes: GraphNode[] = [
      { id: "exchange:a:x1", kind: "exchange", label: "x1" },
      { id: "shovel:a:s1", kind: "shovel", label: "s1" },
      { id: "queue:a:q1", kind: "queue", label: "q1" },
      { id: "federation:a:f1", kind: "federation", label: "f1" },
    ];
    const edges: GraphEdge[] = [
      { id: "b1", from: "exchange:a:x1", to: "queue:a:q1", kind: "binds" },
      { id: "s-in", from: "exchange:a:x1", to: "shovel:a:s1", kind: "shovels" },
      { id: "s-out", from: "shovel:a:s1", to: "queue:a:q1", kind: "shovels" },
      { id: "f-in", from: "exchange:a:x1", to: "federation:a:f1", kind: "federates" },
      { id: "f-out", from: "federation:a:f1", to: "queue:a:q1", kind: "federates" },
    ];
    const byId = new Map(
      toReactFlowElements(graph(nodes, edges)).edges.map((e) => [e.id, e]),
    );
    expect(byId.get("b1")!.animated).toBe(false);
    expect(byId.get("s-in")!.animated).toBe(true);
    expect(byId.get("f-out")!.animated).toBe(true);
  });
});
