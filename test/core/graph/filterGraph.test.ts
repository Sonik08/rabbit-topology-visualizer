import { describe, expect, it } from "vitest";
import { applyGraphFilters } from "../../../src/core/graph/filterGraph";
import type { BuildGraphResult } from "../../../src/core/graph/buildGraph";
import type { GraphEdge, GraphNode } from "../../../src/core/model";

function fixture(): BuildGraphResult {
  const nodes: GraphNode[] = [
    { id: "host:a", kind: "host", label: "a", data: { id: "host:a", name: "a", sourceFiles: [] } },
    { id: "host:b", kind: "host", label: "b", data: { id: "host:b", name: "b", sourceFiles: [] } },
    { id: "vhost:a:/", kind: "vhost", label: "/", data: { id: "vhost:a:/", hostId: "host:a", name: "/" } },
    { id: "vhost:b:/", kind: "vhost", label: "/", data: { id: "vhost:b:/", hostId: "host:b", name: "/" } },
    { id: "exchange:a:x1", kind: "exchange", label: "x1", data: { hostId: "host:a", vhostId: "vhost:a:/" } },
    { id: "queue:a:q1", kind: "queue", label: "q1", data: { hostId: "host:a", vhostId: "vhost:a:/" } },
    { id: "queue:b:q2", kind: "queue", label: "q2", data: { hostId: "host:b", vhostId: "vhost:b:/" } },
    { id: "external:foo", kind: "external", label: "external", data: {} },
  ];
  const edges: GraphEdge[] = [
    { id: "c:host-a->vhost", from: "host:a", to: "vhost:a:/", kind: "contains" },
    { id: "c:vhost-a->x1", from: "vhost:a:/", to: "exchange:a:x1", kind: "contains" },
    { id: "c:vhost-a->q1", from: "vhost:a:/", to: "queue:a:q1", kind: "contains" },
    { id: "b:x1->q1:a.b", from: "exchange:a:x1", to: "queue:a:q1", kind: "binds", routingKey: "a.b" },
    { id: "b:x1->q1:x.y", from: "exchange:a:x1", to: "queue:a:q1", kind: "binds", routingKey: "x.y" },
    { id: "b:x1->external:foo", from: "exchange:a:x1", to: "external:foo", kind: "binds", routingKey: "ext" },
  ];
  return { nodes, edges, diagnostics: [] };
}

describe("applyGraphFilters", () => {
  it("returns the graph unchanged when no filters are set", () => {
    const g = fixture();
    const out = applyGraphFilters(g);
    expect(out.nodes.length).toBe(g.nodes.length);
    expect(out.edges.length).toBe(g.edges.length);
    expect(out.diagnostics).toBe(g.diagnostics);
  });

  it("treats empty Sets as no filter", () => {
    const g = fixture();
    const out = applyGraphFilters(g, {
      hostIds: new Set(),
      vhostIds: new Set(),
      entityKinds: new Set(),
      edgeKinds: new Set(),
      routingKeyQuery: "",
    });
    expect(out.nodes.length).toBe(g.nodes.length);
    expect(out.edges.length).toBe(g.edges.length);
  });

  it("keeps only nodes belonging to whitelisted hosts and drops dangling edges", () => {
    const out = applyGraphFilters(fixture(), { hostIds: new Set(["host:a"]) });
    const ids = out.nodes.map((n) => n.id).sort();
    expect(ids).toContain("host:a");
    expect(ids).toContain("vhost:a:/");
    expect(ids).toContain("exchange:a:x1");
    expect(ids).toContain("queue:a:q1");
    expect(ids).not.toContain("host:b");
    expect(ids).not.toContain("queue:b:q2");
    for (const e of out.edges) {
      expect(ids).toContain(e.from);
      expect(ids).toContain(e.to);
    }
  });

  it("keeps external nodes regardless of host filter (their host is out-of-project)", () => {
    const out = applyGraphFilters(fixture(), { hostIds: new Set(["host:a"]) });
    expect(out.nodes.some((n) => n.kind === "external")).toBe(true);
  });

  it("filters by entity kind — dropping every node not in the whitelist", () => {
    const out = applyGraphFilters(fixture(), {
      entityKinds: new Set(["exchange", "queue"]),
    });
    for (const n of out.nodes) {
      expect(["exchange", "queue"]).toContain(n.kind);
    }
    // edges into hosts/vhosts should be pruned along with their endpoints
    for (const e of out.edges) {
      expect(out.nodes.some((n) => n.id === e.from)).toBe(true);
      expect(out.nodes.some((n) => n.id === e.to)).toBe(true);
    }
  });

  it("filters by edge kind (contains-only)", () => {
    const out = applyGraphFilters(fixture(), {
      edgeKinds: new Set(["contains"]),
    });
    for (const e of out.edges) expect(e.kind).toBe("contains");
    // At least the three contains edges from the fixture survive
    expect(out.edges.length).toBeGreaterThanOrEqual(3);
  });

  it("routing-key filter matches case-insensitive substring only on edges with a routing key", () => {
    const out = applyGraphFilters(fixture(), { routingKeyQuery: "A.B" });
    const routingEdges = out.edges.filter((e) => e.routingKey !== undefined);
    expect(routingEdges.length).toBe(1);
    expect(routingEdges[0]!.id).toBe("b:x1->q1:a.b");
    // Non-routing edges (contains) pass through unaffected
    expect(out.edges.some((e) => e.kind === "contains")).toBe(true);
  });

  it("whitespace-only routing-key query is ignored (no edges dropped)", () => {
    const before = fixture();
    const out = applyGraphFilters(before, { routingKeyQuery: "   " });
    expect(out.edges.length).toBe(before.edges.length);
  });

  it("combined host + edge-kind filters compose (no dangling edges left)", () => {
    const out = applyGraphFilters(fixture(), {
      hostIds: new Set(["host:a"]),
      edgeKinds: new Set(["binds"]),
    });
    const nodeIds = new Set(out.nodes.map((n) => n.id));
    for (const e of out.edges) {
      expect(e.kind).toBe("binds");
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }
  });

  it("vhost filter keeps only the parent hosts of surviving vhosts (drops unrelated hosts)", () => {
    const out = applyGraphFilters(fixture(), {
      vhostIds: new Set(["vhost:a:/"]),
    });
    // Only host:a survives — host:b's only vhost was filtered out, so the
    // host itself is pruned rather than left as an orphan header.
    expect(out.nodes.some((n) => n.id === "host:a")).toBe(true);
    expect(out.nodes.some((n) => n.id === "host:b")).toBe(false);
    // Only vhost:a:/ and its entities remain
    expect(out.nodes.some((n) => n.id === "vhost:a:/")).toBe(true);
    expect(out.nodes.some((n) => n.id === "vhost:b:/")).toBe(false);
    expect(out.nodes.some((n) => n.id === "queue:b:q2")).toBe(false);
    // External nodes still bypass host/vhost filtering
    expect(out.nodes.some((n) => n.kind === "external")).toBe(true);
    // No dangling edges left after unrelated host is pruned
    const nodeIds = new Set(out.nodes.map((n) => n.id));
    for (const e of out.edges) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }
  });

  it("vhost whitelist referencing an unknown vhost prunes every host (no orphan headers)", () => {
    const out = applyGraphFilters(fixture(), {
      vhostIds: new Set(["vhost:does-not-exist"]),
    });
    // No vhost matches → no host has a surviving child → every host is pruned
    expect(out.nodes.some((n) => n.kind === "host")).toBe(false);
    expect(out.nodes.some((n) => n.kind === "vhost")).toBe(false);
    // External nodes still bypass host/vhost filtering
    expect(out.nodes.some((n) => n.kind === "external")).toBe(true);
  });
});
