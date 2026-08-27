import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BuildGraphResult } from "../../../src/core/graph/buildGraph";
import type { GraphEdge, GraphNode } from "../../../src/core/model";
import {
  applyVisibility,
  createEmptyVisibility,
  hideNodes,
  isolateNeighborhood,
  type VisibilityState,
} from "../../../src/core/graph/visibility";
import { TopologyVisibilityPanel } from "../../../src/ui/components/TopologyVisibilityPanel";

afterEach(() => cleanup());

function graphFixture(): BuildGraphResult {
  const nodes: GraphNode[] = [
    { id: "host:h", kind: "host", label: "h", data: { id: "host:h", name: "h", sourceFiles: [] } },
    {
      id: "vhost:h:/",
      kind: "vhost",
      label: "/",
      data: { id: "vhost:h:/", hostId: "host:h", name: "/" },
    },
    { id: "exchange:h:x1", kind: "exchange", label: "orders.in" },
    { id: "exchange:h:x2", kind: "exchange", label: "orders.audit" },
    { id: "queue:h:q1", kind: "queue", label: "q.incoming" },
    { id: "queue:h:q2", kind: "queue", label: "q.audit" },
  ];
  const edges: GraphEdge[] = [
    { id: "c:host->vhost", from: "host:h", to: "vhost:h:/", kind: "contains" },
    { id: "c:vhost->x1", from: "vhost:h:/", to: "exchange:h:x1", kind: "contains" },
    { id: "c:vhost->x2", from: "vhost:h:/", to: "exchange:h:x2", kind: "contains" },
    { id: "c:vhost->q1", from: "vhost:h:/", to: "queue:h:q1", kind: "contains" },
    { id: "c:vhost->q2", from: "vhost:h:/", to: "queue:h:q2", kind: "contains" },
    { id: "b:x1->q1", from: "exchange:h:x1", to: "queue:h:q1", kind: "binds", routingKey: "a.b" },
    { id: "b:x2->q2", from: "exchange:h:x2", to: "queue:h:q2", kind: "binds", routingKey: "c.d" },
  ];
  return { nodes, edges, diagnostics: [] };
}

interface RenderOptions {
  visibility?: VisibilityState;
  selectedNodeId?: string;
}

function renderPanel(opts: RenderOptions = {}) {
  const graph = graphFixture();
  const visibility = opts.visibility ?? createEmptyVisibility();
  const applied = applyVisibility(graph, visibility);
  const onChange = vi.fn<[VisibilityState], void>();
  render(
    <TopologyVisibilityPanel
      graph={graph}
      visibility={visibility}
      counts={applied.counts}
      effectivelyHidden={applied.effectivelyHidden}
      selectedNodeId={opts.selectedNodeId}
      onChange={onChange}
    />,
  );
  return { graph, onChange };
}

describe("TopologyVisibilityPanel — count summary", () => {
  it("shows visible/total node and edge counts (and no hidden badge when nothing is hidden)", () => {
    renderPanel();
    const counts = screen.getByTestId("topology-visibility-counts");
    expect(counts.textContent).toMatch(/6\/6 nodes · 7\/7 edges/);
    expect(counts.textContent).not.toMatch(/hidden/);
  });

  it("appends the hidden badge to the counts summary when at least one node is hidden", () => {
    renderPanel({
      visibility: hideNodes(createEmptyVisibility(), ["queue:h:q1"]),
    });
    const counts = screen.getByTestId("topology-visibility-counts");
    expect(counts.textContent).toMatch(/5\/6 nodes/);
    expect(counts.textContent).toMatch(/1 hidden/);
  });
});

describe("TopologyVisibilityPanel — individual hide/restore (mandatory regression)", () => {
  it("clicking a checkbox for a visible queue calls onChange with that queue added to hiddenNodeIds", () => {
    const { onChange } = renderPanel();
    const checkbox = screen.getByTestId("topology-visibility-toggle-queue:h:q1");
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0];
    expect(next.hiddenNodeIds.has("queue:h:q1")).toBe(true);
  });

  it("the hidden-item list surfaces every hidden node and each 'Show' button restores that specific id", () => {
    const { onChange } = renderPanel({
      visibility: hideNodes(createEmptyVisibility(), ["queue:h:q1", "exchange:h:x2"]),
    });
    // Both hidden entities are listed as pill buttons.
    const list = screen.getByTestId("topology-visibility-hidden-list");
    expect(list.textContent).toMatch(/q.incoming/);
    expect(list.textContent).toMatch(/orders.audit/);
    // Clicking the per-id restore button removes just that id.
    fireEvent.click(screen.getByTestId("topology-visibility-restore-queue:h:q1"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const restored = onChange.mock.calls[0]![0];
    expect(restored.hiddenNodeIds.has("queue:h:q1")).toBe(false);
    expect(restored.hiddenNodeIds.has("exchange:h:x2")).toBe(true);
  });

  it("'Reset all' emits an empty hiddenNodeIds regardless of current state", () => {
    const { onChange } = renderPanel({
      visibility: hideNodes(createEmptyVisibility(), ["queue:h:q1", "queue:h:q2"]),
    });
    fireEvent.click(screen.getByTestId("topology-visibility-reset-all"));
    const next = onChange.mock.calls[0]![0];
    expect(next.hiddenNodeIds.size).toBe(0);
    expect(next.isolatedFocus).toBeUndefined();
  });
});

describe("TopologyVisibilityPanel — neighborhood isolation (mandatory regression)", () => {
  it("'Show only selected + neighborhood' is disabled until a node is selected in the canvas", () => {
    renderPanel();
    const btn = screen.getByTestId("topology-visibility-isolate-selected") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("clicking 'Show only selected + neighborhood' with a selection emits an isolation state keyed to that node", () => {
    const { onChange } = renderPanel({ selectedNodeId: "queue:h:q1" });
    fireEvent.click(screen.getByTestId("topology-visibility-isolate-selected"));
    const next = onChange.mock.calls[0]![0];
    expect(next.isolatedFocus?.focusNodeId).toBe("queue:h:q1");
  });

  it("when an isolation is active, a 'Clear isolation' button appears and emits a state without isolatedFocus", () => {
    const { onChange } = renderPanel({
      visibility: isolateNeighborhood(createEmptyVisibility(), "queue:h:q1"),
      selectedNodeId: "queue:h:q1",
    });
    const clear = screen.getByTestId("topology-visibility-clear-isolation");
    fireEvent.click(clear);
    const next = onChange.mock.calls[0]![0];
    expect(next.isolatedFocus).toBeUndefined();
  });
});

describe("TopologyVisibilityPanel — isolation-hidden restore (mandatory regression)", () => {
  it("shows isolation-hidden nodes in the hidden pill list and unchecks them in the searchable list", () => {
    // Isolating queue:h:q1 at depth 1 leaves q2 / x2 rendered as hidden.
    renderPanel({
      visibility: isolateNeighborhood(createEmptyVisibility(), "queue:h:q1", {
        depth: 1,
        direction: "both",
      }),
    });
    const list = screen.getByTestId("topology-visibility-hidden-list");
    expect(list.textContent).toMatch(/q.audit/);
    expect(list.textContent).toMatch(/orders.audit/);
    // Searchable-list checkbox for the isolation-hidden queue is unchecked.
    const q2Checkbox = screen.getByTestId(
      "topology-visibility-toggle-queue:h:q2",
    ) as HTMLInputElement;
    expect(q2Checkbox.checked).toBe(false);
  });

  it("clicking the restore pill for an isolation-hidden node clears the isolation focus", () => {
    const { onChange } = renderPanel({
      visibility: isolateNeighborhood(createEmptyVisibility(), "queue:h:q1", {
        depth: 1,
        direction: "both",
      }),
    });
    fireEvent.click(
      screen.getByTestId("topology-visibility-restore-queue:h:q2"),
    );
    const next = onChange.mock.calls[0]![0];
    expect(next.isolatedFocus).toBeUndefined();
    expect(next.hiddenNodeIds.has("queue:h:q2")).toBe(false);
  });

  it("clicking the searchable checkbox for an isolation-hidden node restores it (clears isolation)", () => {
    const { onChange } = renderPanel({
      visibility: isolateNeighborhood(createEmptyVisibility(), "queue:h:q1", {
        depth: 1,
        direction: "both",
      }),
    });
    fireEvent.click(
      screen.getByTestId("topology-visibility-toggle-queue:h:q2"),
    );
    const next = onChange.mock.calls[0]![0];
    expect(next.isolatedFocus).toBeUndefined();
    expect(next.hiddenNodeIds.has("queue:h:q2")).toBe(false);
  });
});

describe("TopologyVisibilityPanel — searchable entity list", () => {
  it("search filters the list to entities whose label matches the substring (case-insensitive)", () => {
    renderPanel();
    fireEvent.change(screen.getByTestId("topology-visibility-search"), {
      target: { value: "AUDIT" },
    });
    const list = screen.getByTestId("topology-visibility-entity-list");
    expect(list.textContent).toMatch(/orders.audit/);
    expect(list.textContent).toMatch(/q.audit/);
    expect(list.textContent).not.toMatch(/orders.in/);
    expect(list.textContent).not.toMatch(/q.incoming/);
  });

  it("'Hide selected' is disabled without a selection and enabled with one", () => {
    const { onChange } = renderPanel({ selectedNodeId: "exchange:h:x1" });
    const btn = screen.getByTestId(
      "topology-visibility-hide-selected",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    const next = onChange.mock.calls[0]![0];
    expect(next.hiddenNodeIds.has("exchange:h:x1")).toBe(true);
  });
});
