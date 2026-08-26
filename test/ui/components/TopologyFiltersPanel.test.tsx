import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BuildGraphResult } from "../../../src/core/graph/buildGraph";
import type { GraphEdge, GraphNode } from "../../../src/core/model";
import {
  createEmptyFilterState,
  DEFAULT_MAX_DEPTH,
  MAX_DEPTH_ABSOLUTE,
  toGraphFilters,
  TopologyFiltersPanel,
  type FilterState,
} from "../../../src/ui/components/TopologyFiltersPanel";

afterEach(() => cleanup());

function graphFixture(): BuildGraphResult {
  const nodes: GraphNode[] = [
    { id: "host:a", kind: "host", label: "rabbit-a" },
    { id: "host:b", kind: "host", label: "rabbit-b" },
    { id: "vhost:a:/", kind: "vhost", label: "/" },
    { id: "exchange:a:x1", kind: "exchange", label: "x1" },
    { id: "queue:a:q1", kind: "queue", label: "q1" },
  ];
  const edges: GraphEdge[] = [];
  return { nodes, edges, diagnostics: [] };
}

describe("TopologyFiltersPanel", () => {
  it("renders host, vhost, entity-kind, edge-kind, routing-key, and depth controls", () => {
    render(
      <TopologyFiltersPanel
        graph={graphFixture()}
        filters={createEmptyFilterState()}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("topology-filters-panel")).toBeTruthy();
    expect(screen.getByTestId("topology-filters-hosts")).toBeTruthy();
    expect(screen.getByTestId("topology-filters-vhosts")).toBeTruthy();
    expect(screen.getByTestId("topology-filters-entity-kinds")).toBeTruthy();
    expect(screen.getByTestId("topology-filters-edge-kinds")).toBeTruthy();
    expect(screen.getByTestId("topology-filters-routing-key")).toBeTruthy();
    expect(screen.getByTestId("topology-filters-max-depth")).toBeTruthy();
    expect(screen.getByTestId("topology-filters-host-host:a")).toBeTruthy();
    expect(screen.getByTestId("topology-filters-host-host:b")).toBeTruthy();
  });

  it("toggles a host id on and off via onChange with a fresh Set (never mutates the input)", () => {
    const filters = createEmptyFilterState();
    const originalHostIds = filters.hostIds;
    const onChange = vi.fn<[FilterState], void>();
    render(
      <TopologyFiltersPanel graph={graphFixture()} filters={filters} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("topology-filters-host-host:a"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0];
    expect([...next.hostIds]).toEqual(["host:a"]);
    // Input Set never mutated
    expect([...originalHostIds]).toEqual([]);
    expect(next.hostIds).not.toBe(filters.hostIds);
  });

  it("routing-key changes propagate the raw string (trimming happens in toGraphFilters)", () => {
    const onChange = vi.fn<[FilterState], void>();
    render(
      <TopologyFiltersPanel
        graph={graphFixture()}
        filters={createEmptyFilterState()}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId("topology-filters-routing-key"), {
      target: { value: "  orders.  " },
    });
    expect(onChange.mock.calls[0]![0].routingKeyQuery).toBe("  orders.  ");
  });

  it("depth slider clamps to [0, MAX_DEPTH_ABSOLUTE] and floors fractional values", () => {
    const onChange = vi.fn<[FilterState], void>();
    render(
      <TopologyFiltersPanel
        graph={graphFixture()}
        filters={createEmptyFilterState()}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId("topology-filters-max-depth"), {
      target: { value: `${MAX_DEPTH_ABSOLUTE + 500}` },
    });
    expect(onChange.mock.calls[0]![0].maxDepth).toBe(MAX_DEPTH_ABSOLUTE);
    fireEvent.change(screen.getByTestId("topology-filters-max-depth"), {
      target: { value: "-5" },
    });
    expect(onChange.mock.calls[1]![0].maxDepth).toBe(0);
    fireEvent.change(screen.getByTestId("topology-filters-max-depth"), {
      target: { value: "3.7" },
    });
    expect(onChange.mock.calls[2]![0].maxDepth).toBe(3);
  });

  it("reset button emits a fresh empty filter state (maxDepth = DEFAULT_MAX_DEPTH)", () => {
    const filters: FilterState = {
      hostIds: new Set(["host:a"]),
      vhostIds: new Set(["vhost:a:/"]),
      entityKinds: new Set(["queue"]),
      edgeKinds: new Set(["binds"]),
      routingKeyQuery: "orders",
      maxDepth: 8,
    };
    const onChange = vi.fn<[FilterState], void>();
    render(<TopologyFiltersPanel graph={graphFixture()} filters={filters} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("topology-filters-reset"));
    const next = onChange.mock.calls[0]![0];
    expect(next.hostIds.size).toBe(0);
    expect(next.vhostIds.size).toBe(0);
    expect(next.entityKinds.size).toBe(0);
    expect(next.edgeKinds.size).toBe(0);
    expect(next.routingKeyQuery).toBe("");
    expect(next.maxDepth).toBe(DEFAULT_MAX_DEPTH);
  });

  it("toGraphFilters trims whitespace-only routingKeyQuery down to undefined", () => {
    const projection = toGraphFilters({
      ...createEmptyFilterState(),
      routingKeyQuery: "   \t  ",
    });
    expect(projection.routingKeyQuery).toBeUndefined();
    const projectionWithValue = toGraphFilters({
      ...createEmptyFilterState(),
      routingKeyQuery: "  a.b  ",
    });
    expect(projectionWithValue.routingKeyQuery).toBe("a.b");
  });

  it("hides host/vhost fieldsets when the graph carries no such nodes", () => {
    render(
      <TopologyFiltersPanel
        graph={{ nodes: [], edges: [], diagnostics: [] }}
        filters={createEmptyFilterState()}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByTestId("topology-filters-hosts")).toBeNull();
    expect(screen.queryByTestId("topology-filters-vhosts")).toBeNull();
    // Always-visible controls still render
    expect(screen.getByTestId("topology-filters-entity-kinds")).toBeTruthy();
    expect(screen.getByTestId("topology-filters-edge-kinds")).toBeTruthy();
  });
});
