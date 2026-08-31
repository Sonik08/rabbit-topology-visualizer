import { describe, expect, it } from "vitest";
import type { BuildGraphResult } from "../../../src/core/graph/buildGraph";
import type { EndpointRef, GraphEdge, GraphNode } from "../../../src/core/model";
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
    // Labels are carried through and node kind is preserved. The fixture
    // omits canonical `vhostId` on the queue, so the safe `unknown vhost`
    // fallback appears as a suffix — the badge is always emitted for a
    // queue/exchange/shovel/federation node so missing metadata is visible.
    expect(byId.get("queue:a:q1")!.data.label).toBe("q1 · unknown vhost");
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
    // Fixture omits `vhostId` → the safe `unknown vhost` fallback appears as
    // a badge suffix so the operator sees the missing metadata explicitly.
    expect(byId.get("exchange:a:t")!.data.label).toBe("[topic] orders · unknown vhost");
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
    // Classic + durable → no subtype badge; fixture omits `vhostId` so the
    // safe `unknown vhost` fallback suffix appears on the label.
    expect(byId.get("queue:a:c")!.data.subtypeBadge).toBeUndefined();
    expect(byId.get("queue:a:c")!.data.label).toBe("orders · unknown vhost");
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

describe("toReactFlowElements — configured-flow rendering (boundary label + pause/reduced-motion)", () => {
  function scenarioGraph(): BuildGraphResult {
    const nodes: GraphNode[] = [
      { id: "exchange:a:x1", kind: "exchange", label: "x1" },
      { id: "shovel:b:s1", kind: "shovel", label: "s1" },
      { id: "queue:b:q1", kind: "queue", label: "q1" },
      { id: "federation:a:f1", kind: "federation", label: "f1" },
      { id: "exchange:a:x2", kind: "exchange", label: "x2" },
    ];
    const edges: GraphEdge[] = [
      {
        id: "s-in",
        from: "exchange:a:x1",
        to: "shovel:b:s1",
        kind: "shovels",
        label: "a-to-b",
        flow: {
          linkKind: "shovel",
          linkName: "a-to-b",
          role: "in",
          boundary: "cross-host",
          sourceHostName: "rabbit-a",
          sourceVhostName: "/",
          destinationHostName: "rabbit-b",
          destinationVhostName: "/",
        },
      },
      {
        id: "s-out",
        from: "shovel:b:s1",
        to: "queue:b:q1",
        kind: "shovels",
        label: "a-to-b",
        flow: {
          linkKind: "shovel",
          linkName: "a-to-b",
          role: "out",
          boundary: "cross-host",
          sourceHostName: "rabbit-a",
          sourceVhostName: "/",
          destinationHostName: "rabbit-b",
          destinationVhostName: "/",
        },
      },
      {
        id: "f-in",
        from: "exchange:a:x1",
        to: "federation:a:f1",
        kind: "federates",
        label: "orders→audit",
        flow: {
          linkKind: "federation",
          linkName: "orders→audit",
          role: "in",
          boundary: "cross-vhost-same-host",
          sourceHostName: "rabbit-a",
          sourceVhostName: "orders",
          destinationHostName: "rabbit-a",
          destinationVhostName: "audit",
        },
      },
      {
        id: "f-out",
        from: "federation:a:f1",
        to: "exchange:a:x2",
        kind: "federates",
        label: "orders→audit",
        flow: {
          linkKind: "federation",
          linkName: "orders→audit",
          role: "out",
          boundary: "cross-vhost-same-host",
          sourceHostName: "rabbit-a",
          sourceVhostName: "orders",
          destinationHostName: "rabbit-a",
          destinationVhostName: "audit",
        },
      },
    ];
    return { nodes, edges, diagnostics: [] };
  }

  it("labels shovel & federation edges with link name AND boundary tag", () => {
    const g = scenarioGraph();
    const byId = new Map(toReactFlowElements(g).edges.map((e) => [e.id, e]));
    expect(byId.get("s-in")!.label).toBe(`shovel "a-to-b" · cross-host`);
    expect(byId.get("f-in")!.label).toBe(
      `federation "orders→audit" · cross-vhost, same host`,
    );
  });

  it("carries the LinkFlow through to FlowEdge.data so downstream code (details panel, path explanation) can inspect it", () => {
    const g = scenarioGraph();
    const byId = new Map(toReactFlowElements(g).edges.map((e) => [e.id, e]));
    expect(byId.get("s-in")!.data.flow?.boundary).toBe("cross-host");
    expect(byId.get("s-in")!.data.flow?.role).toBe("in");
    expect(byId.get("s-out")!.data.flow?.role).toBe("out");
    expect(byId.get("f-in")!.data.flow?.boundary).toBe("cross-vhost-same-host");
  });

  it("preserves direction — 'in' edges terminate at the shovel/federation node, 'out' edges leave it", () => {
    const g = scenarioGraph();
    const byId = new Map(toReactFlowElements(g).edges.map((e) => [e.id, e]));
    expect(byId.get("s-in")!.target).toBe("shovel:b:s1");
    expect(byId.get("s-out")!.source).toBe("shovel:b:s1");
    expect(byId.get("f-in")!.target).toBe("federation:a:f1");
    expect(byId.get("f-out")!.source).toBe("federation:a:f1");
  });

  it("animation defaults to ON for shovel & federation edges (marching-ants direction cue)", () => {
    const g = scenarioGraph();
    const byId = new Map(toReactFlowElements(g).edges.map((e) => [e.id, e]));
    expect(byId.get("s-in")!.animated).toBe(true);
    expect(byId.get("f-out")!.animated).toBe(true);
  });

  it("user pause suppresses shovel & federation animation but keeps arrowheads visible", () => {
    const g = scenarioGraph();
    const byId = new Map(
      toReactFlowElements(g, {
        configuredFlowMotion: { paused: true },
      }).edges.map((e) => [e.id, e]),
    );
    expect(byId.get("s-in")!.animated).toBe(false);
    expect(byId.get("s-out")!.animated).toBe(false);
    expect(byId.get("f-in")!.animated).toBe(false);
    // Arrowheads still present so direction remains readable.
    expect(byId.get("s-in")!.markerEnd?.type).toBe("arrowclosed");
    expect(byId.get("f-out")!.markerEnd?.type).toBe("arrowclosed");
  });

  it("prefers-reduced-motion suppresses shovel & federation animation independently of the pause toggle", () => {
    const g = scenarioGraph();
    const byId = new Map(
      toReactFlowElements(g, {
        configuredFlowMotion: { paused: false, reducedMotion: true },
      }).edges.map((e) => [e.id, e]),
    );
    expect(byId.get("s-in")!.animated).toBe(false);
    expect(byId.get("f-out")!.animated).toBe(false);
  });
});

describe("toReactFlowElements — vhost badge & context", () => {
  function baseGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [
      { id: "host:a", kind: "host", label: "rabbit-a", data: { id: "host:a", name: "rabbit-a" } },
      {
        id: "vhost:a:/",
        kind: "vhost",
        label: "/",
        data: { id: "vhost:a:/", hostId: "host:a", name: "/" },
      },
      {
        id: "vhost:a:orders",
        kind: "vhost",
        label: "orders",
        data: { id: "vhost:a:orders", hostId: "host:a", name: "orders" },
      },
      {
        id: "exchange:a:x1",
        kind: "exchange",
        label: "x1",
        data: {
          id: "exchange:a:x1",
          hostId: "host:a",
          vhostId: "vhost:a:/",
          name: "x1",
          type: "topic",
        },
      },
      {
        id: "queue:a:q1",
        kind: "queue",
        label: "q1",
        data: {
          id: "queue:a:q1",
          hostId: "host:a",
          vhostId: "vhost:a:orders",
          name: "q1",
          durable: true,
        },
      },
      {
        id: "shovel:a:s1",
        kind: "shovel",
        label: "s1",
        data: {
          id: "shovel:a:s1",
          hostId: "host:a",
          vhostId: "vhost:a:orders",
          name: "s1",
          source: {},
          destination: {},
        },
      },
      {
        id: "federation:a:f1",
        kind: "federation",
        label: "f1",
        data: {
          id: "federation:a:f1",
          hostId: "host:a",
          vhostId: "vhost:a:/",
          name: "f1",
          upstream: {},
          downstream: {},
        },
      },
    ];
    return { nodes, edges: [] };
  }

  it("resolves a compact vhost badge on queue, exchange, shovel, and federation nodes and exposes context in data", () => {
    const g = baseGraph();
    const byId = new Map(
      toReactFlowElements({ ...g, diagnostics: [] }).nodes.map((n) => [n.id, n]),
    );
    const exchange = byId.get("exchange:a:x1")!;
    expect(exchange.data.vhostBadge).toBe("/");
    expect(exchange.data.vhostContext).toMatchObject({
      vhostId: "vhost:a:/",
      vhostName: "/",
      hostId: "host:a",
      hostName: "rabbit-a",
      isDefault: true,
      ambiguous: false,
      unknown: false,
    });
    expect(exchange.data.vhostTooltip).toBe("vhost / on host rabbit-a");
    // Label includes badge as a compact suffix without disturbing subtype badge.
    expect(exchange.data.label).toBe("[topic] x1 · /");

    const queue = byId.get("queue:a:q1")!;
    expect(queue.data.vhostBadge).toBe("orders");
    expect(queue.data.vhostContext?.isDefault).toBe(false);
    expect(queue.data.label).toBe("q1 · orders");

    const shovel = byId.get("shovel:a:s1")!;
    expect(shovel.data.vhostBadge).toBe("orders");
    expect(shovel.data.vhostContext?.vhostName).toBe("orders");

    const federation = byId.get("federation:a:f1")!;
    expect(federation.data.vhostBadge).toBe("/");
    expect(federation.data.vhostContext?.hostName).toBe("rabbit-a");
  });

  it("skips vhost badge/context on host and vhost nodes (they have no ambient vhost to surface)", () => {
    const g = baseGraph();
    const byId = new Map(
      toReactFlowElements({ ...g, diagnostics: [] }).nodes.map((n) => [n.id, n]),
    );
    expect(byId.get("host:a")!.data.vhostContext).toBeUndefined();
    expect(byId.get("host:a")!.data.vhostBadge).toBeUndefined();
    expect(byId.get("vhost:a:/")!.data.vhostContext).toBeUndefined();
    expect(byId.get("vhost:a:orders")!.data.vhostBadge).toBeUndefined();
  });

  it("includes host prefix in the badge only when the same vhost name exists on multiple hosts", () => {
    const nodes: GraphNode[] = [
      { id: "host:a", kind: "host", label: "rabbit-a", data: { name: "rabbit-a" } },
      { id: "host:b", kind: "host", label: "rabbit-b", data: { name: "rabbit-b" } },
      {
        id: "vhost:a:orders",
        kind: "vhost",
        label: "orders",
        data: { hostId: "host:a", name: "orders" },
      },
      {
        id: "vhost:b:orders",
        kind: "vhost",
        label: "orders",
        data: { hostId: "host:b", name: "orders" },
      },
      {
        id: "vhost:a:audit",
        kind: "vhost",
        label: "audit",
        data: { hostId: "host:a", name: "audit" },
      },
      {
        id: "queue:a:orders:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:a", vhostId: "vhost:a:orders", name: "q" },
      },
      {
        id: "queue:b:orders:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:b", vhostId: "vhost:b:orders", name: "q" },
      },
      {
        id: "queue:a:audit:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:a", vhostId: "vhost:a:audit", name: "q" },
      },
    ];
    const byId = new Map(
      toReactFlowElements({ nodes, edges: [], diagnostics: [] }).nodes.map((n) => [n.id, n]),
    );
    // Ambiguous vhost 'orders' → badge includes host prefix on both sides.
    expect(byId.get("queue:a:orders:q")!.data.vhostBadge).toBe("rabbit-a/orders");
    expect(byId.get("queue:a:orders:q")!.data.vhostContext?.ambiguous).toBe(true);
    expect(byId.get("queue:b:orders:q")!.data.vhostBadge).toBe("rabbit-b/orders");
    expect(byId.get("queue:b:orders:q")!.data.vhostContext?.ambiguous).toBe(true);
    // Unique vhost 'audit' → badge stays compact (no host prefix).
    expect(byId.get("queue:a:audit:q")!.data.vhostBadge).toBe("audit");
    expect(byId.get("queue:a:audit:q")!.data.vhostContext?.ambiguous).toBe(false);
    // Tooltip always spells out the host, even when the badge omits it.
    expect(byId.get("queue:a:audit:q")!.data.vhostTooltip).toBe(
      "vhost audit on host rabbit-a",
    );
  });

  it("truncates long badge text with a collision-safe suffix while keeping the full name in the tooltip", () => {
    const longName = "a".repeat(40);
    const nodes: GraphNode[] = [
      { id: "host:a", kind: "host", label: "rabbit-a", data: { name: "rabbit-a" } },
      {
        id: `vhost:a:${longName}`,
        kind: "vhost",
        label: longName,
        data: { hostId: "host:a", name: longName },
      },
      {
        id: "queue:a:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:a", vhostId: `vhost:a:${longName}`, name: "q" },
      },
    ];
    const byId = new Map(
      toReactFlowElements({ nodes, edges: [], diagnostics: [] }).nodes.map((n) => [n.id, n]),
    );
    const q = byId.get("queue:a:q")!;
    expect(q.data.vhostBadge!.length).toBeLessThanOrEqual(24);
    // Truncated badges carry an ellipsis followed by a 4-hex-char stable hash
    // suffix so distinct vhostIds never collide even when the human text
    // shares a common prefix AND tail.
    expect(q.data.vhostBadge).toMatch(/…[0-9a-f]{4}$/);
    expect(q.data.vhostTooltip).toBe(`vhost ${longName} on host rabbit-a`);
  });

  it("produces distinct truncated badges for two long vhost names that share a common prefix on the same host (collision-safe suffix)", () => {
    // Long vhost names on the same host that share the first ~30 characters.
    // A naive `<prefix>…` truncation would collapse both to the SAME string.
    const prefix = "org_service_orderprocessing_pipeline_";
    const nameA = `${prefix}alpha_v1_release_20260831`;
    const nameB = `${prefix}beta_v1_release_20260831`;
    const nodes: GraphNode[] = [
      { id: "host:a", kind: "host", label: "rabbit-a", data: { name: "rabbit-a" } },
      {
        id: "vhost:a:alpha",
        kind: "vhost",
        label: nameA,
        data: { hostId: "host:a", name: nameA },
      },
      {
        id: "vhost:a:beta",
        kind: "vhost",
        label: nameB,
        data: { hostId: "host:a", name: nameB },
      },
      {
        id: "queue:a:alpha:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:a", vhostId: "vhost:a:alpha", name: "q" },
      },
      {
        id: "queue:a:beta:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:a", vhostId: "vhost:a:beta", name: "q" },
      },
    ];
    const byId = new Map(
      toReactFlowElements({ nodes, edges: [], diagnostics: [] }).nodes.map((n) => [n.id, n]),
    );
    const qa = byId.get("queue:a:alpha:q")!;
    const qb = byId.get("queue:a:beta:q")!;
    // Both must fit in the 24-char budget.
    expect(qa.data.vhostBadge!.length).toBeLessThanOrEqual(24);
    expect(qb.data.vhostBadge!.length).toBeLessThanOrEqual(24);
    // And they must NOT be equal — the reviewer's specific regression pin.
    expect(qa.data.vhostBadge).not.toBe(qb.data.vhostBadge);
    // Each carries the stable hash-suffix form so identity is retained.
    expect(qa.data.vhostBadge).toMatch(/…[0-9a-f]{4}$/);
    expect(qb.data.vhostBadge).toMatch(/…[0-9a-f]{4}$/);
    // Tooltips carry the full unabbreviated names — the truncation is a
    // display concern only.
    expect(qa.data.vhostTooltip).toBe(`vhost ${nameA} on host rabbit-a`);
    expect(qb.data.vhostTooltip).toBe(`vhost ${nameB} on host rabbit-a`);
  });

  it("produces distinct truncated badges for host-prefixed contexts that share prefix AND tail (ambiguous vhost on two hosts with common surrounding text)", () => {
    // Same vhost name on two distinct hosts whose LONG names share both
    // prefix ("rabbit-cluster-region-eu-") and suffix ("-primary"), plus a
    // shared vhost name — the badge would be `<hostDisc>/<vhostName>` and
    // both would collapse to the same truncation without a stable identifier.
    const hostAName = "rabbit-cluster-region-eu-alpha-primary";
    const hostBName = "rabbit-cluster-region-eu-beta-primary";
    const sharedVhost = "long-service-vhost-name";
    const nodes: GraphNode[] = [
      { id: "host:a", kind: "host", label: hostAName, data: { name: hostAName } },
      { id: "host:b", kind: "host", label: hostBName, data: { name: hostBName } },
      {
        id: "vhost:a:svc",
        kind: "vhost",
        label: sharedVhost,
        data: { hostId: "host:a", name: sharedVhost },
      },
      {
        id: "vhost:b:svc",
        kind: "vhost",
        label: sharedVhost,
        data: { hostId: "host:b", name: sharedVhost },
      },
      {
        id: "queue:a:svc:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:a", vhostId: "vhost:a:svc", name: "q" },
      },
      {
        id: "queue:b:svc:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:b", vhostId: "vhost:b:svc", name: "q" },
      },
    ];
    const byId = new Map(
      toReactFlowElements({ nodes, edges: [], diagnostics: [] }).nodes.map((n) => [n.id, n]),
    );
    const qa = byId.get("queue:a:svc:q")!;
    const qb = byId.get("queue:b:svc:q")!;
    // Ambiguous vhost on both sides.
    expect(qa.data.vhostContext?.ambiguous).toBe(true);
    expect(qb.data.vhostContext?.ambiguous).toBe(true);
    // Budget respected on both.
    expect(qa.data.vhostBadge!.length).toBeLessThanOrEqual(24);
    expect(qb.data.vhostBadge!.length).toBeLessThanOrEqual(24);
    // Distinct badges — the truncation MUST NOT collapse them into a single
    // "rabbit-cluster-region-e…" string.
    expect(qa.data.vhostBadge).not.toBe(qb.data.vhostBadge);
    // Tooltip surface is unabbreviated and appends the hostId in parens for
    // the ambiguous-host-name path, ensuring the full-context announcement
    // stays disambiguated for assistive tech.
    expect(qa.data.vhostTooltip).toContain(hostAName);
    expect(qb.data.vhostTooltip).toContain(hostBName);
  });

  it("guarantees unique truncated badges across a large batch of distinct disambiguators (collision-safe at topology scale, not just the 16-bit birthday bound)", () => {
    // Regression pin for the reviewer's rejection: `shortStableHash(..., 4)`
    // alone is 16-bit — the birthday bound is ~256 identities, so a topology
    // with thousands of vhosts under a shared long prefix WILL collide with
    // near-certainty under a naive per-context truncation. The batch pipeline
    // MUST detect this and step the hash length up until every distinct
    // disambiguator receives a distinct badge. 3000 items comfortably exceeds
    // the 16-bit collision threshold and stays well under the 32-bit one.
    const N = 3000;
    // Long shared prefix so every generated name overflows the 24-char budget
    // and forces truncation with the hash-suffixed strategy.
    const prefix = "org-service-orderprocessing-pipeline-";
    const nodes: GraphNode[] = [
      { id: "host:a", kind: "host", label: "rabbit-a", data: { name: "rabbit-a" } },
    ];
    for (let i = 0; i < N; i += 1) {
      const name = `${prefix}${i}`;
      const vhostId = `vhost:a:${i}`;
      nodes.push({
        id: vhostId,
        kind: "vhost",
        label: name,
        data: { hostId: "host:a", name },
      });
      nodes.push({
        id: `queue:a:${i}`,
        kind: "queue",
        label: "q",
        data: { hostId: "host:a", vhostId, name: "q" },
      });
    }
    const { nodes: flow } = toReactFlowElements({ nodes, edges: [], diagnostics: [] });
    const queueBadges = flow
      .filter((n) => n.id.startsWith("queue:a:"))
      .map((n) => n.data.vhostBadge);
    // Every queue must have a badge, every badge must fit the budget, and —
    // the whole point — every badge must be unique across the N distinct
    // vhostIds. A 16-bit-only implementation cannot satisfy this line.
    expect(queueBadges).toHaveLength(N);
    for (const b of queueBadges) {
      expect(b).toBeDefined();
      expect(b!.length).toBeLessThanOrEqual(24);
    }
    expect(new Set(queueBadges).size).toBe(N);
  });

  it("keeps the compact 4-hex hash suffix for small graphs where no collision is possible (stability contract for React reconciliation and screenshot tests)", () => {
    // Small graph, distinct disambiguators. The adaptive-length algorithm
    // should stay at the minimum 4-hex hash and NOT preemptively bloat the
    // suffix — that would churn every existing snapshot / a11y test.
    const nameA = "org-service-orderprocessing-pipeline-alpha-v1";
    const nameB = "org-service-orderprocessing-pipeline-beta-v1";
    const nodes: GraphNode[] = [
      { id: "host:a", kind: "host", label: "rabbit-a", data: { name: "rabbit-a" } },
      {
        id: "vhost:a:alpha",
        kind: "vhost",
        label: nameA,
        data: { hostId: "host:a", name: nameA },
      },
      {
        id: "vhost:a:beta",
        kind: "vhost",
        label: nameB,
        data: { hostId: "host:a", name: nameB },
      },
      {
        id: "queue:a:alpha:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:a", vhostId: "vhost:a:alpha", name: "q" },
      },
      {
        id: "queue:a:beta:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:a", vhostId: "vhost:a:beta", name: "q" },
      },
    ];
    const byId = new Map(
      toReactFlowElements({ nodes, edges: [], diagnostics: [] }).nodes.map((n) => [n.id, n]),
    );
    expect(byId.get("queue:a:alpha:q")!.data.vhostBadge).toMatch(/…[0-9a-f]{4}$/);
    expect(byId.get("queue:a:beta:q")!.data.vhostBadge).toMatch(/…[0-9a-f]{4}$/);
  });

  it("stable hash suffix in the truncated badge is deterministic across renders (same input → same output, so React reconciliation doesn't churn)", () => {
    const longName = "org-service-".repeat(4) + "unique";
    const build = () => {
      const nodes: GraphNode[] = [
        { id: "host:a", kind: "host", label: "rabbit-a", data: { name: "rabbit-a" } },
        {
          id: `vhost:a:${longName}`,
          kind: "vhost",
          label: longName,
          data: { hostId: "host:a", name: longName },
        },
        {
          id: "queue:a:q",
          kind: "queue",
          label: "q",
          data: { hostId: "host:a", vhostId: `vhost:a:${longName}`, name: "q" },
        },
      ];
      return toReactFlowElements({ nodes, edges: [], diagnostics: [] }).nodes;
    };
    const first = build().find((n) => n.id === "queue:a:q")!;
    const second = build().find((n) => n.id === "queue:a:q")!;
    expect(first.data.vhostBadge).toBe(second.data.vhostBadge);
    expect(first.data.vhostBadge).toMatch(/…[0-9a-f]{4}$/);
  });

  it("renders an 'unknown vhost' fallback for external endpoint nodes with no resolvable vhost", () => {
    const nodes: GraphNode[] = [
      {
        id: "external:remote//x:target",
        kind: "external",
        label: "exchange target @ remote",
        data: { host: "remote", exchange: "target" } satisfies EndpointRef,
      },
      {
        id: "external:remote/orders/x:t",
        kind: "external",
        label: "exchange t @ remote/orders",
        data: { host: "remote", vhost: "orders", exchange: "t" } satisfies EndpointRef,
      },
    ];
    const byId = new Map(
      toReactFlowElements({ nodes, edges: [], diagnostics: [] }).nodes.map((n) => [n.id, n]),
    );
    const unresolved = byId.get("external:remote//x:target")!;
    expect(unresolved.data.vhostContext?.unknown).toBe(true);
    expect(unresolved.data.vhostBadge).toBe("unknown vhost");
    expect(unresolved.data.vhostTooltip).toBe("unknown vhost");

    const known = byId.get("external:remote/orders/x:t")!;
    expect(known.data.vhostContext?.unknown).toBe(false);
    expect(known.data.vhostBadge).toBe("orders");
    expect(known.data.vhostTooltip).toBe("vhost orders");
  });

  it("surfaces vhostId as unknown when the entity's vhostId does not match any loaded vhost node", () => {
    const nodes: GraphNode[] = [
      { id: "host:a", kind: "host", label: "rabbit-a", data: { name: "rabbit-a" } },
      {
        id: "queue:a:orphan",
        kind: "queue",
        label: "orphan",
        data: {
          id: "queue:a:orphan",
          hostId: "host:a",
          vhostId: "vhost:a:missing",
          name: "orphan",
        },
      },
    ];
    const byId = new Map(
      toReactFlowElements({ nodes, edges: [], diagnostics: [] }).nodes.map((n) => [n.id, n]),
    );
    const q = byId.get("queue:a:orphan")!;
    // Missing-vhost context now also carries the entity's `hostId` (and the
    // resolved `hostName`/`hostDiscriminator` when the host node is loaded)
    // so downstream code can still disambiguate the same orphaned name across
    // multiple hosts.
    expect(q.data.vhostContext).toEqual({
      vhostId: "vhost:a:missing",
      hostId: "host:a",
      hostName: "rabbit-a",
      hostDiscriminator: "rabbit-a",
      isDefault: false,
      ambiguous: false,
      unknown: true,
    });
    // Even when the vhost name is unresolved, the badge prefixes with the
    // host discriminator so two orphans on two different hosts render with
    // distinct badges (this test only has one host, but the prefix is the
    // same code path).
    expect(q.data.vhostBadge).toBe("rabbit-a/unknown vhost");
    expect(q.data.vhostTooltip).toBe("unknown vhost on host rabbit-a");
    expect(q.data.label).toBe("orphan · rabbit-a/unknown vhost");
  });

  it("uses hostId as the badge discriminator when two hosts share the same name (so ambiguous vhosts stay unambiguous)", () => {
    // Two distinct hosts (`host:a` / `host:b`) but both labelled `"rabbit"`.
    // A vhost named `orders` exists on both hosts. Naively prefixing with
    // `hostName` would collapse both badges to `"rabbit/orders"`. The
    // discriminator falls back to the canonical `hostId` in that case.
    const nodes: GraphNode[] = [
      { id: "host:a", kind: "host", label: "rabbit-a", data: { name: "rabbit" } },
      { id: "host:b", kind: "host", label: "rabbit-b", data: { name: "rabbit" } },
      {
        id: "vhost:a:orders",
        kind: "vhost",
        label: "orders",
        data: { hostId: "host:a", name: "orders" },
      },
      {
        id: "vhost:b:orders",
        kind: "vhost",
        label: "orders",
        data: { hostId: "host:b", name: "orders" },
      },
      {
        id: "queue:a:orders:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:a", vhostId: "vhost:a:orders", name: "q" },
      },
      {
        id: "queue:b:orders:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:b", vhostId: "vhost:b:orders", name: "q" },
      },
    ];
    const byId = new Map(
      toReactFlowElements({ nodes, edges: [], diagnostics: [] }).nodes.map((n) => [n.id, n]),
    );
    const qa = byId.get("queue:a:orders:q")!;
    const qb = byId.get("queue:b:orders:q")!;
    // Badges MUST differ so duplicate entity names stay unambiguous.
    expect(qa.data.vhostBadge).not.toBe(qb.data.vhostBadge);
    expect(qa.data.vhostBadge).toBe("host:a/orders");
    expect(qb.data.vhostBadge).toBe("host:b/orders");
    // Context records both the human name and the hostId that was ultimately
    // chosen as the discriminator, so downstream tooling can build a
    // "rabbit (host:a) vs rabbit (host:b)" affordance without re-deriving it.
    expect(qa.data.vhostContext?.hostName).toBe("rabbit");
    expect(qa.data.vhostContext?.hostDiscriminator).toBe("host:a");
    expect(qb.data.vhostContext?.hostDiscriminator).toBe("host:b");
    // The tooltip spells out both to keep the assistive-tech surface
    // unambiguous, appending the hostId in parentheses when the host name
    // itself is duplicated.
    expect(qa.data.vhostTooltip).toBe("vhost orders on host rabbit (host:a)");
    expect(qb.data.vhostTooltip).toBe("vhost orders on host rabbit (host:b)");
  });

  it("falls back to hostId in both badge and tooltip when the host node is missing (no name metadata resolvable)", () => {
    // No host node loaded for `host:orphan`, but the queue references it via
    // `data.hostId`. The badge must still disambiguate the entity from any
    // other unresolved-host entity elsewhere in the graph.
    const nodes: GraphNode[] = [
      // A properly-loaded second host so `ambiguous` machinery is exercised.
      { id: "host:a", kind: "host", label: "rabbit-a", data: { name: "rabbit-a" } },
      {
        id: "vhost:a:orders",
        kind: "vhost",
        label: "orders",
        data: { hostId: "host:a", name: "orders" },
      },
      {
        id: "vhost:orphan:orders",
        kind: "vhost",
        label: "orders",
        data: { hostId: "host:orphan", name: "orders" },
      },
      {
        id: "queue:a:orders:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:a", vhostId: "vhost:a:orders", name: "q" },
      },
      {
        id: "queue:orphan:orders:q",
        kind: "queue",
        label: "q",
        data: { hostId: "host:orphan", vhostId: "vhost:orphan:orders", name: "q" },
      },
    ];
    const byId = new Map(
      toReactFlowElements({ nodes, edges: [], diagnostics: [] }).nodes.map((n) => [n.id, n]),
    );
    const known = byId.get("queue:a:orders:q")!;
    const orphan = byId.get("queue:orphan:orders:q")!;
    // Both are `ambiguous` (vhost `orders` appears on two host IDs). The
    // orphan branch has no `hostName` — the discriminator falls back to the
    // canonical `hostId`.
    expect(known.data.vhostContext?.ambiguous).toBe(true);
    expect(orphan.data.vhostContext?.ambiguous).toBe(true);
    expect(orphan.data.vhostContext?.hostName).toBeUndefined();
    expect(orphan.data.vhostContext?.hostDiscriminator).toBe("host:orphan");
    expect(orphan.data.vhostBadge).toBe("host:orphan/orders");
    // Tooltip falls back to `on host <hostId>` when there is no hostName.
    expect(orphan.data.vhostTooltip).toBe("vhost orders on host host:orphan");
    // Sanity: the loaded host still renders with its human name in the badge.
    expect(known.data.vhostBadge).toBe("rabbit-a/orders");
  });

  it("emits `unknown vhost` fallback for a queue/exchange/shovel/federation node with no `vhostId` and disambiguates by hostId when the host is known", () => {
    const nodes: GraphNode[] = [
      { id: "host:a", kind: "host", label: "rabbit-a", data: { name: "rabbit-a" } },
      // Queue with hostId but NO vhostId
      {
        id: "queue:a:missing-vhost",
        kind: "queue",
        label: "q1",
        data: { hostId: "host:a", name: "q1" },
      },
      // Exchange on a different host, also missing vhostId — badges must
      // differ so the duplicate name doesn't collapse to the same string.
      {
        id: "exchange:b:missing-vhost",
        kind: "exchange",
        label: "q1",
        data: { hostId: "host:b", name: "q1", type: "topic" },
      },
      // Shovel with no host or vhost data at all — pure fallback path.
      {
        id: "shovel:orphan",
        kind: "shovel",
        label: "s1",
        data: { name: "s1", source: {}, destination: {} },
      },
      // Federation missing vhostId but with hostId.
      {
        id: "federation:a:missing-vhost",
        kind: "federation",
        label: "f1",
        data: { hostId: "host:a", name: "f1", upstream: {}, downstream: {} },
      },
    ];
    const byId = new Map(
      toReactFlowElements({ nodes, edges: [], diagnostics: [] }).nodes.map((n) => [n.id, n]),
    );
    const q = byId.get("queue:a:missing-vhost")!;
    expect(q.data.vhostContext).toEqual({
      hostId: "host:a",
      hostName: "rabbit-a",
      hostDiscriminator: "rabbit-a",
      isDefault: false,
      ambiguous: false,
      unknown: true,
    });
    expect(q.data.vhostBadge).toBe("rabbit-a/unknown vhost");
    expect(q.data.vhostTooltip).toBe("unknown vhost on host rabbit-a");
    expect(q.data.label).toBe("q1 · rabbit-a/unknown vhost");

    // Exchange on the un-loaded host `host:b` — hostName is undefined so the
    // hostId anchors the badge and tooltip.
    const x = byId.get("exchange:b:missing-vhost")!;
    expect(x.data.vhostContext?.hostName).toBeUndefined();
    expect(x.data.vhostContext?.hostDiscriminator).toBe("host:b");
    expect(x.data.vhostBadge).toBe("host:b/unknown vhost");
    expect(x.data.vhostTooltip).toBe("unknown vhost on host host:b");
    // Duplicate queue/exchange name `q1` on two hosts now renders with two
    // distinct badges — the regression contract.
    expect(q.data.vhostBadge).not.toBe(x.data.vhostBadge);

    // Shovel with no host data whatsoever — the badge is the bare fallback,
    // matching the "no metadata to disambiguate" case.
    const s = byId.get("shovel:orphan")!;
    expect(s.data.vhostContext?.hostDiscriminator).toBeUndefined();
    expect(s.data.vhostBadge).toBe("unknown vhost");
    expect(s.data.vhostTooltip).toBe("unknown vhost");

    // Federation without vhostId gets the same treatment as the queue.
    const f = byId.get("federation:a:missing-vhost")!;
    expect(f.data.vhostBadge).toBe("rabbit-a/unknown vhost");
  });

  it("resolves badges from complete context nodes when the rendered graph omits host and vhost containers", () => {
    const full = baseGraph();
    const renderedNodes = full.nodes.filter(
      (node) => node.id === "queue:a:q1" || node.id === "exchange:a:x1",
    );
    const result = toReactFlowElements(
      { nodes: renderedNodes, edges: [], diagnostics: [] },
      { contextNodes: full.nodes },
    );
    const byId = new Map(result.nodes.map((node) => [node.id, node]));

    // Structural containers remain excluded from the render graph.
    expect(byId.has("host:a")).toBe(false);
    expect(byId.has("vhost:a:/")).toBe(false);
    expect(byId.has("vhost:a:orders")).toBe(false);

    // Still-visible entities retain canonical context from the complete graph.
    expect(byId.get("queue:a:q1")!.data.vhostBadge).toBe("orders");
    expect(byId.get("queue:a:q1")!.data.vhostTooltip).toBe(
      "vhost orders on host rabbit-a",
    );
    expect(byId.get("exchange:a:x1")!.data.vhostBadge).toBe("/");
    expect(byId.get("exchange:a:x1")!.data.vhostContext?.unknown).toBe(false);
  });

  it("preserves highlight styling on nodes that carry a vhost badge", () => {
    const g = baseGraph();
    const result = toReactFlowElements(
      { ...g, diagnostics: [] },
      {
        highlight: {
          targetNodeId: "queue:a:q1",
          nodeIds: new Set(["queue:a:q1", "exchange:a:x1"]),
          edgeIds: new Set(),
        },
      },
    );
    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    const q = byId.get("queue:a:q1")!;
    // Selection target styling AND the vhost context both survive.
    expect(q.data.highlightState).toBe("target");
    expect(String(q.style!.boxShadow)).toContain("3px");
    expect(q.data.vhostBadge).toBe("orders");
    // Off-path node keeps its badge too so identity remains readable while dimmed.
    const shovel = byId.get("shovel:a:s1")!;
    expect(shovel.data.highlightState).toBe("off-path");
    expect(shovel.data.vhostBadge).toBe("orders");
  });
});
