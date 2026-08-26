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

  it("styles exchanges by AMQP type and tags them with a subtype badge", () => {
    const nodes: GraphNode[] = [
      { id: "exchange:a:t", kind: "exchange", label: "orders", data: { type: "topic" } },
      { id: "exchange:a:d", kind: "exchange", label: "logins", data: { type: "direct" } },
      { id: "exchange:a:f", kind: "exchange", label: "broadcast", data: { type: "fanout" } },
      { id: "exchange:a:h", kind: "exchange", label: "custom", data: { type: "headers" } },
      { id: "exchange:a:x", kind: "exchange", label: "delayed", data: { type: "x-delayed-message" } },
    ];
    const byId = new Map(
      toReactFlowElements(graph(nodes, [])).nodes.map((n) => [n.id, n]),
    );
    expect(byId.get("exchange:a:t")!.data.flowType).toBe("exchange:topic");
    expect(byId.get("exchange:a:t")!.data.subtypeBadge).toBe("[topic]");
    expect(byId.get("exchange:a:t")!.data.label).toBe("[topic] orders");
    expect(byId.get("exchange:a:d")!.data.flowType).toBe("exchange:direct");
    expect(byId.get("exchange:a:f")!.data.flowType).toBe("exchange:fanout");
    expect(byId.get("exchange:a:h")!.data.flowType).toBe("exchange:headers");
    // Unknown plugin types keep their raw name in the flow type but fall back
    // to the neutral "other" background.
    expect(byId.get("exchange:a:x")!.data.flowType).toBe("exchange:x-delayed-message");
    expect(byId.get("exchange:a:x")!.data.subtypeBadge).toBe("[x-delayed-message]");
    // Distinct exchange types should get distinct backgrounds.
    expect(byId.get("exchange:a:t")!.style!.background).not.toBe(
      byId.get("exchange:a:d")!.style!.background,
    );
  });

  it("styles queues by x-queue-type and dashes the border for transient queues", () => {
    const nodes: GraphNode[] = [
      { id: "queue:a:c", kind: "queue", label: "orders", data: { durable: true } },
      {
        id: "queue:a:q",
        kind: "queue",
        label: "audit",
        data: { durable: true, arguments: { "x-queue-type": "quorum" } },
      },
      {
        id: "queue:a:s",
        kind: "queue",
        label: "events",
        data: { durable: true, arguments: { "x-queue-type": "stream" } },
      },
      { id: "queue:a:t", kind: "queue", label: "ephemeral", data: { durable: false } },
    ];
    const byId = new Map(
      toReactFlowElements(graph(nodes, [])).nodes.map((n) => [n.id, n]),
    );
    expect(byId.get("queue:a:c")!.data.flowType).toBe("queue:classic");
    // Classic + durable → no badge, label is untouched.
    expect(byId.get("queue:a:c")!.data.subtypeBadge).toBeUndefined();
    expect(byId.get("queue:a:c")!.data.label).toBe("orders");
    expect(byId.get("queue:a:q")!.data.flowType).toBe("queue:quorum");
    expect(byId.get("queue:a:q")!.data.subtypeBadge).toBe("[quorum]");
    expect(byId.get("queue:a:s")!.data.flowType).toBe("queue:stream");
    // Transient queues carry a `transient` marker in the badge AND a dashed
    // border so the visual state is unambiguous.
    expect(byId.get("queue:a:t")!.data.subtypeBadge).toBe("[transient]");
    expect(String(byId.get("queue:a:t")!.style!.border)).toContain("dashed");
    expect(String(byId.get("queue:a:c")!.style!.border)).toContain("solid");
    // Quorum + stream backgrounds should differ from classic.
    expect(byId.get("queue:a:q")!.style!.background).not.toBe(
      byId.get("queue:a:c")!.style!.background,
    );
    expect(byId.get("queue:a:s")!.style!.background).not.toBe(
      byId.get("queue:a:c")!.style!.background,
    );
  });

  it("emits an arrowhead marker matching the edge stroke colour for every rendered edge", () => {
    const nodes: GraphNode[] = [
      { id: "exchange:a:x1", kind: "exchange", label: "x1" },
      { id: "queue:a:q1", kind: "queue", label: "q1" },
      { id: "shovel:a:s1", kind: "shovel", label: "s1" },
    ];
    const edges: GraphEdge[] = [
      { id: "b1", from: "exchange:a:x1", to: "queue:a:q1", kind: "binds" },
      { id: "s-in", from: "exchange:a:x1", to: "shovel:a:s1", kind: "shovels" },
    ];
    const byId = new Map(
      toReactFlowElements(graph(nodes, edges)).edges.map((e) => [e.id, e]),
    );
    expect(byId.get("b1")!.markerEnd?.type).toBe("arrowclosed");
    expect(byId.get("b1")!.markerEnd?.color).toBe(
      (byId.get("b1")!.style as { stroke?: string }).stroke,
    );
    expect(byId.get("s-in")!.markerEnd?.color).toBe(
      (byId.get("s-in")!.style as { stroke?: string }).stroke,
    );
  });

  it("applies highlight styling: target ring, on-path highlight, off-path dim", () => {
    const nodes: GraphNode[] = [
      { id: "exchange:a:x1", kind: "exchange", label: "x1" },
      { id: "exchange:a:x2", kind: "exchange", label: "x2" },
      { id: "queue:a:q1", kind: "queue", label: "q1" },
      { id: "queue:a:q2", kind: "queue", label: "q2" },
    ];
    const edges: GraphEdge[] = [
      { id: "b1", from: "exchange:a:x1", to: "exchange:a:x2", kind: "binds" },
      { id: "b2", from: "exchange:a:x2", to: "queue:a:q1", kind: "binds" },
      { id: "b3", from: "exchange:a:x1", to: "queue:a:q2", kind: "binds" },
    ];
    const highlight = {
      targetNodeId: "queue:a:q1",
      nodeIds: new Set(["queue:a:q1", "exchange:a:x2", "exchange:a:x1"]),
      edgeIds: new Set(["b1", "b2"]),
    };
    const result = toReactFlowElements(graph(nodes, edges), { highlight });
    const nodeById = new Map(result.nodes.map((n) => [n.id, n]));
    const edgeById = new Map(result.edges.map((e) => [e.id, e]));

    expect(nodeById.get("queue:a:q1")!.data.highlightState).toBe("target");
    expect(nodeById.get("exchange:a:x1")!.data.highlightState).toBe("on-path");
    expect(nodeById.get("queue:a:q2")!.data.highlightState).toBe("off-path");
    // Off-path nodes are dimmed via opacity, on-path/target nodes keep full opacity.
    expect(nodeById.get("queue:a:q2")!.style!.opacity).toBeLessThan(0.5);
    expect(nodeById.get("queue:a:q1")!.style!.opacity ?? 1).toBe(1);
    // Target gets a distinct box-shadow ring.
    expect(String(nodeById.get("queue:a:q1")!.style!.boxShadow)).toContain("3px");

    // On-path edges keep normal opacity and get a thicker stroke; off-path
    // edges are dimmed.
    expect(edgeById.get("b1")!.style!.opacity ?? 1).toBe(1);
    expect(edgeById.get("b3")!.style!.opacity).toBeLessThan(0.5);
    const b1Width = Number(edgeById.get("b1")!.style!.strokeWidth ?? 1);
    const b3Width = Number(edgeById.get("b3")!.style!.strokeWidth ?? 1);
    expect(b1Width).toBeGreaterThan(b3Width);
  });

  it("ignores an empty highlight and renders as if no selection is active", () => {
    const nodes: GraphNode[] = [
      { id: "exchange:a:x1", kind: "exchange", label: "x1" },
      { id: "queue:a:q1", kind: "queue", label: "q1" },
    ];
    const edges: GraphEdge[] = [
      { id: "b1", from: "exchange:a:x1", to: "queue:a:q1", kind: "binds" },
    ];
    const result = toReactFlowElements(graph(nodes, edges), {
      highlight: { nodeIds: new Set(), edgeIds: new Set() },
    });
    for (const n of result.nodes) expect(n.data.highlightState).toBeUndefined();
    for (const e of result.edges) expect(e.style!.opacity ?? 1).toBe(1);
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
