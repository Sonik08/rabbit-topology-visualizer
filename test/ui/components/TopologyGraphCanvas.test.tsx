import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BuildGraphResult } from "../../../src/core/graph/buildGraph";
import type { UpstreamTraversalResult } from "../../../src/core/graph/traversal";
import type {
  ImportArchiveWorkerClient,
  ImportResult,
} from "../../../src/core/import";

afterEach(() => {
  cleanup();
  rfState.nodes = [];
  rfState.edges = [];
  rfState.fitViewCalls = 0;
  rfState.onInitCalls = 0;
});

// ReactFlow's real rendering path is heavy in jsdom (measures DOM, wires
// pointer events). Replace it with a minimal shim that surfaces the
// props the canvas depends on — specifically `onNodeClick` and `onPaneClick`
// — via buttons so uncontrolled selection can be simulated without ReactFlow
// itself needing a viewport. The shim also records the last-rendered
// nodes/edges lists and a `fitView` spy so tests can assert exact clipping
// behavior and confirm the canvas triggers a fit-to-view on focus changes.
const rfState = {
  nodes: [] as Array<{ id: string }>,
  edges: [] as Array<{ id: string }>,
  fitViewCalls: 0,
  // Count how many times ReactFlow fires `onInit`. A refit that comes from
  // the ReactFlow subtree unmounting + remounting (which would re-fire
  // onInit and re-spy fitView) is NOT proof that the canvas's
  // `[focused, isFullPage]` effect or the ResizeObserver actually ran —
  // full-page-mode regressions must show fitView incrementing WITHOUT
  // onInit increasing.
  onInitCalls: 0,
};
vi.mock("reactflow", () => {
  const React = require("react");
  interface RFNode {
    id: string;
    type?: string;
    data?: unknown;
  }
  interface RFProps {
    onNodeClick?: (event: unknown, node: { id: string }) => void;
    onPaneClick?: () => void;
    onInit?: (instance: { fitView: (opts?: unknown) => void }) => void;
    nodes?: RFNode[];
    edges?: Array<{ id: string }>;
    nodeTypes?: Record<string, React.ComponentType<{ data: unknown }>>;
  }
  const Rf = (props: RFProps) => {
    // Record for exact-count assertions in the tests. Each render replaces
    // the snapshot so the latest props are what's queried.
    rfState.nodes = [...(props.nodes ?? [])];
    rfState.edges = [...(props.edges ?? [])];
    React.useEffect(() => {
      // Simulate ReactFlow's `onInit` firing once the instance is created.
      // The canvas captures the instance in a ref and calls `fitView()` when
      // focused mode changes — assign a spy so the test can assert the call.
      // Also tick `onInitCalls` so tests can prove the ReactFlow subtree did
      // NOT unmount/remount across a state change (which is what would
      // otherwise silently make a "fitView was called" assertion pass for
      // the wrong reason).
      rfState.onInitCalls += 1;
      props.onInit?.({
        fitView: () => {
          rfState.fitViewCalls += 1;
        },
      });
    }, []);
    // Pick the FIRST queue-like node so the click test lines up with the
    // hook's `upstreamForQueue` path. Host/vhost nodes short-circuit in
    // useTopologyGraph, so choosing them would make the "canvas emitted
    // an id" assertion pass but not exercise the interesting branch.
    const target =
      props.nodes?.find((n) => n.id.startsWith("queue:"))?.id ??
      props.nodes?.[0]?.id ??
      "queue:h:q";
    // Render each node via its registered `nodeType` component (defaulting to
    // a bare label span when no type is registered) so tests can assert on
    // real DOM output — specifically the `title`/`aria-label` accessibility
    // attributes that the topology entity node adds for the vhost tooltip.
    const nodeElements = (props.nodes ?? []).map((node) => {
      const Component = node.type ? props.nodeTypes?.[node.type] : undefined;
      const key = node.id;
      const attrs = { "data-testid": `rf-mock-node-${node.id}`, key };
      if (Component) {
        return React.createElement(
          "div",
          attrs,
          React.createElement(Component, { data: node.data }),
        );
      }
      return React.createElement("div", attrs, String(node.id));
    });
    return React.createElement(
      "div",
      {
        "data-testid": "rf-mock-root",
        "data-rf-node-count": String(props.nodes?.length ?? 0),
        "data-rf-edge-count": String(props.edges?.length ?? 0),
      },
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "rf-mock-click-node",
          onClick: () => props.onNodeClick?.({}, { id: target }),
        },
        "click node",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "rf-mock-click-pane",
          onClick: () => props.onPaneClick?.(),
        },
        "click pane",
      ),
      ...nodeElements,
    );
  };
  return {
    __esModule: true,
    default: Rf,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Handle: () => null,
    Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
  };
});

import { TopologyGraphCanvas } from "../../../src/ui/components/TopologyGraphCanvas";

// Fixture chosen so focused-mode clipping is observable: focus on `queue:h:q`
// must exclude the unrelated `unrelated.exchange` / `unrelated.queue` chain
// (they share a host + vhost but no routing edge reaches the focus target).
const GRAPH_FIXTURE: BuildGraphResult = {
  nodes: [
    { id: "host:h", kind: "host", label: "h", data: { id: "host:h", name: "h", sourceFiles: [] } },
    {
      id: "vhost:h:/",
      kind: "vhost",
      label: "/",
      data: { id: "vhost:h:/", hostId: "host:h", name: "/" },
    },
    { id: "exchange:h:x", kind: "exchange", label: "x", data: { hostId: "host:h", vhostId: "vhost:h:/", type: "topic" } },
    { id: "queue:h:q", kind: "queue", label: "q", data: { hostId: "host:h", vhostId: "vhost:h:/" } },
    { id: "exchange:h:unrelated", kind: "exchange", label: "unrelated.exchange", data: { hostId: "host:h", vhostId: "vhost:h:/", type: "topic" } },
    { id: "queue:h:unrelated", kind: "queue", label: "unrelated.queue", data: { hostId: "host:h", vhostId: "vhost:h:/" } },
  ],
  edges: [
    { id: "c:host->vhost", from: "host:h", to: "vhost:h:/", kind: "contains" },
    { id: "c:vhost->x", from: "vhost:h:/", to: "exchange:h:x", kind: "contains" },
    { id: "c:vhost->q", from: "vhost:h:/", to: "queue:h:q", kind: "contains" },
    { id: "c:vhost->xu", from: "vhost:h:/", to: "exchange:h:unrelated", kind: "contains" },
    { id: "c:vhost->qu", from: "vhost:h:/", to: "queue:h:unrelated", kind: "contains" },
    { id: "b:x->q", from: "exchange:h:x", to: "queue:h:q", kind: "binds", routingKey: "k" },
    { id: "b:unrelated", from: "exchange:h:unrelated", to: "queue:h:unrelated", kind: "binds", routingKey: "k" },
  ],
  diagnostics: [],
};

const TRAVERSAL: UpstreamTraversalResult = {
  targetNodeId: "queue:h:q",
  reachableAncestorIds: ["exchange:h:x"],
  paths: [
    {
      sourceNodeId: "exchange:h:x",
      steps: [
        {
          edgeId: "b:x->q",
          fromNodeId: "exchange:h:x",
          toNodeId: "queue:h:q",
          kind: "binds",
          routingKey: "k",
        },
      ],
    },
  ],
  truncated: false,
  visitedCycles: [],
};

function mockClient(): ImportArchiveWorkerClient {
  return {
    importArchive: vi.fn(),
    buildGraph: vi.fn(async () => GRAPH_FIXTURE),
    upstreamForQueue: vi.fn(async () => TRAVERSAL),
    upstreamForExchange: vi.fn(async () => TRAVERSAL),
    // The hook now calls `bidirectionalForNode` for the selection-highlight
    // path — return the upstream traversal as the upstream half of the
    // bidirectional envelope. Empty downstream keeps existing selection-only
    // assertions stable.
    bidirectionalForNode: vi.fn(async (_input, targetNodeId: string) => ({
      targetNodeId,
      upstream: { ...TRAVERSAL, targetNodeId },
      downstream: {
        targetNodeId,
        reachableDescendantIds: [],
        paths: [],
        truncated: false,
        visitedCycles: [],
      },
    })),
    terminate: vi.fn(),
  } as unknown as ImportArchiveWorkerClient;
}

function emptyImportResult(): ImportResult {
  return {
    archiveKind: "json",
    archivePath: "test.json",
    files: [],
    diagnostics: [],
  };
}

describe("TopologyGraphCanvas — bidirectional selection summary (task 58)", () => {
  it("selection summary reports incoming AND outgoing counts as separate segments so the operator can tell direction at a glance", async () => {
    const client = mockClient();
    // Override the mock so bidirectional traversal returns BOTH upstream
    // and downstream reach with distinct counts — proving the summary
    // renders both directions separately, not just one composite count.
    (client.bidirectionalForNode as unknown as { mockImplementation: (fn: unknown) => void })
      .mockImplementation(async () => ({
        targetNodeId: "queue:h:q",
        upstream: {
          targetNodeId: "queue:h:q",
          reachableAncestorIds: ["exchange:h:x"],
          paths: [],
          truncated: false,
          visitedCycles: [],
        },
        downstream: {
          targetNodeId: "queue:h:q",
          // Fabricate two downstream descendants so the outgoing counter
          // is distinguishable from the incoming counter.
          reachableDescendantIds: ["exchange:h:unrelated", "queue:h:unrelated"],
          paths: [],
          truncated: false,
          visitedCycles: [],
        },
      }));
    render(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        selectedNodeId="queue:h:q"
        onSelectionChange={() => {}}
      />,
    );
    const summary = await waitFor(() =>
      screen.getByTestId("topology-graph-selection-summary"),
    );
    // Both direction words appear in the summary text.
    await waitFor(() => {
      expect(summary.textContent).toMatch(/incoming/);
      expect(summary.textContent).toMatch(/outgoing/);
    });
    // Incoming count is 1 (exchange:h:x). Outgoing count is 2 (the two
    // fabricated descendants). The distinct numbers prove the counts are
    // routed to their intended sides.
    await waitFor(() => {
      expect(summary.textContent).toMatch(/1 incoming/);
      expect(summary.textContent).toMatch(/2 outgoing/);
    });
  });

  it("selecting a host / vhost / external node — kinds outside the four supported entry points — surfaces the safe-no-op message instead of a bidirectional highlight", async () => {
    const client = mockClient();
    render(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        selectedNodeId="host:h"
        onSelectionChange={() => {}}
      />,
    );
    const summary = await waitFor(() =>
      screen.getByTestId("topology-graph-selection-summary"),
    );
    expect(summary.textContent).toMatch(
      /bidirectional highlight only supports queues, exchanges, shovels, and federation links/,
    );
  });
});

describe("TopologyGraphCanvas — controlled selection mode", () => {
  it("uses the `selectedNodeId` prop as the authoritative selection and surfaces the selection summary once the highlight resolves", async () => {
    const client = mockClient();
    render(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        selectedNodeId="queue:h:q"
        onSelectionChange={() => {}}
      />,
    );
    // Once the async build settles, the selection bar shows for the id
    // passed in as `selectedNodeId`. This is the observable proof that the
    // canvas treats the prop as authoritative — no click needed.
    await waitFor(() => {
      expect(screen.getByTestId("topology-graph-selection-summary")).toBeTruthy();
    });
  });

  it("clicking 'Clear selection' in controlled mode reports the change via onSelectionChange(undefined) rather than touching internal state", async () => {
    const client = mockClient();
    const onSelectionChange = vi.fn();
    render(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        selectedNodeId="queue:h:q"
        onSelectionChange={onSelectionChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("topology-graph-clear-selection")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("topology-graph-clear-selection"));
    expect(onSelectionChange).toHaveBeenCalledWith(undefined);
  });

  it("clicking a graph node in controlled mode reports the change through onSelectionChange (canvas does NOT flip its own internal state)", async () => {
    const client = mockClient();
    const onSelectionChange = vi.fn();
    render(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        selectedNodeId={undefined}
        onSelectionChange={onSelectionChange}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("rf-mock-click-node")).toBeTruthy());
    fireEvent.click(screen.getByTestId("rf-mock-click-node"));
    // Canvas emitted the node id via onSelectionChange; the callback stays
    // authoritative because the prop presence (even undefined) marks the
    // canvas as controlled.
    expect(onSelectionChange).toHaveBeenCalledWith("queue:h:q");
    // Selection summary stays hidden because the parent hasn't yet propagated
    // the value back through the prop — proving no internal state was flipped.
    expect(screen.queryByTestId("topology-graph-selection-summary")).toBeNull();
  });

  it("regression: presence of `selectedNodeId` — not `onSelectionChange` — decides controlled mode", async () => {
    // Passing only `selectedNodeId` (no callback) still makes the canvas
    // controlled. Canvas-initiated changes silently no-op because there is
    // no listener; the prop remains authoritative.
    const client = mockClient();
    render(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        selectedNodeId="queue:h:q"
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("topology-graph-selection-summary")).toBeTruthy();
    });
    // Clicking Clear does not throw and does not surface any internal state.
    fireEvent.click(screen.getByTestId("topology-graph-clear-selection"));
    // Selection summary is still driven by the prop, so it remains visible.
    expect(screen.getByTestId("topology-graph-selection-summary")).toBeTruthy();
  });
});

describe("TopologyGraphCanvas — focused mode", () => {
  it("without `focusNodeId` the focus banner is not rendered", async () => {
    const client = mockClient();
    render(
      <TopologyGraphCanvas result={emptyImportResult()} workerClient={client} />,
    );
    await waitFor(() => expect(screen.getByTestId("rf-mock-click-node")).toBeTruthy());
    expect(screen.queryByTestId("topology-graph-focus-summary")).toBeNull();
  });

  it("passing `focusNodeId` for a real node clips the rendered graph to the routing neighborhood — exact counts confirm the unrelated chain was removed", async () => {
    const client = mockClient();
    // First: verify the FULL fixture size (6 nodes, 2 non-contains edges) so
    // the focused-view count is compared against a known baseline.
    const { unmount } = render(
      <TopologyGraphCanvas result={emptyImportResult()} workerClient={client} />,
    );
    await waitFor(() => {
      expect(rfState.nodes.length).toBe(6);
      expect(rfState.edges.length).toBe(2);
    });
    unmount();
    // Reset the shim state so the next mount's ReactFlow render is captured cleanly.
    rfState.nodes = [];
    rfState.edges = [];
    rfState.fitViewCalls = 0;

    render(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        focusNodeId="queue:h:q"
        onFocusChange={() => {}}
      />,
    );
    await waitFor(() => {
      // Focused-mode neighborhood: queue:h:q (focus) + exchange:h:x (via
      // incoming binds edge) + contains ancestry (vhost:h:/, host:h) = 4 nodes.
      // The unrelated chain (exchange:h:unrelated, queue:h:unrelated) is
      // dropped because no routing edge reaches queue:h:q.
      expect(rfState.nodes.length).toBe(4);
      expect(rfState.edges.length).toBe(1);
    });
    const nodeIds = rfState.nodes.map((n) => n.id).sort();
    expect(nodeIds).toEqual([
      "exchange:h:x",
      "host:h",
      "queue:h:q",
      "vhost:h:/",
    ]);
    expect(rfState.edges.map((e) => e.id)).toEqual(["b:x->q"]);
    // Focus banner reflects the clipped subgraph's TOTAL edge count
    // (including the surviving contains edges — 1 binds + 3 contains = 4),
    // even though React Flow renders only the 1 non-contains edge by
    // default. This intentional discrepancy tells the operator how big
    // the underlying focused subgraph actually is.
    const summary = screen.getByTestId("topology-graph-focus-summary");
    expect(summary.textContent).toContain("Focused on queue:h:q");
    expect(summary.textContent).toContain("4 nodes");
    expect(summary.textContent).toContain("4 edges");
  });

  it("regression: changing `focusNodeId` triggers ReactFlow.fitView() so the newly clipped subgraph fits the viewport", async () => {
    const client = mockClient();
    // Start unfocused so the initial onInit + one baseline render happen.
    const { rerender } = render(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        onFocusChange={() => {}}
      />,
    );
    await waitFor(() => expect(rfState.nodes.length).toBe(6));
    // Baseline: onInit ran once (which itself does not call fitView; the
    // canvas's fit-on-focus effect only fires when `focused` becomes truthy).
    const baseline = rfState.fitViewCalls;

    // Activate focused mode — fitView() must fire so the viewport reframes
    // onto the clipped subgraph.
    rerender(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        focusNodeId="queue:h:q"
        onFocusChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(rfState.fitViewCalls).toBeGreaterThan(baseline);
    });
    const afterFocus = rfState.fitViewCalls;

    // Switching to a DIFFERENT focus target must fit again.
    rerender(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        focusNodeId="queue:h:unrelated"
        onFocusChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(rfState.fitViewCalls).toBeGreaterThan(afterFocus);
    });
    const afterSwitch = rfState.fitViewCalls;

    // Clearing focused mode must also refit (deactivation transition).
    rerender(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        onFocusChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(rfState.fitViewCalls).toBeGreaterThan(afterSwitch);
    });
  });

  it("clicking the 'Show full topology' button calls onFocusChange(undefined) so the parent can exit focused mode", async () => {
    const client = mockClient();
    const onFocusChange = vi.fn();
    render(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        focusNodeId="queue:h:q"
        onFocusChange={onFocusChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("topology-graph-clear-focus")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("topology-graph-clear-focus"));
    expect(onFocusChange).toHaveBeenCalledWith(undefined);
  });

  it("passing a focusNodeId that does not exist in the graph surfaces an empty-focused-view banner (does NOT throw or render a stale full graph)", async () => {
    const client = mockClient();
    render(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        focusNodeId="queue:does-not-exist"
        onFocusChange={() => {}}
      />,
    );
    await waitFor(() => {
      const summary = screen.getByTestId("topology-graph-focus-summary");
      expect(summary.textContent).toMatch(/Focus target 'queue:does-not-exist' is not in the current graph/);
    });
  });

  it("omitting onFocusChange keeps the focus banner visible but hides the clear button (parent retains sole control)", async () => {
    const client = mockClient();
    render(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        focusNodeId="queue:h:q"
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("topology-graph-focus-summary")).toBeTruthy();
    });
    expect(screen.queryByTestId("topology-graph-clear-focus")).toBeNull();
  });
});

describe("TopologyGraphCanvas — uncontrolled selection fallback", () => {
  it("without a `selectedNodeId` prop the canvas manages its own selection: initial render shows no summary bar", async () => {
    const client = mockClient();
    render(
      <TopologyGraphCanvas result={emptyImportResult()} workerClient={client} />,
    );
    // Wait for buildGraph to settle so the initial idle state is stable.
    await waitFor(() => {
      expect(screen.getByTestId("rf-mock-click-node")).toBeTruthy();
    });
    expect(screen.queryByTestId("topology-graph-selection-summary")).toBeNull();
  });

  it("clicking a graph node in uncontrolled mode flips internal state and surfaces the selection summary", async () => {
    const client = mockClient();
    render(
      <TopologyGraphCanvas result={emptyImportResult()} workerClient={client} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("rf-mock-click-node")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("rf-mock-click-node"));
    await waitFor(() => {
      expect(screen.getByTestId("topology-graph-selection-summary")).toBeTruthy();
    });
    // Clicking Clear resets the internal selection.
    fireEvent.click(screen.getByTestId("topology-graph-clear-selection"));
    await waitFor(() => {
      expect(screen.queryByTestId("topology-graph-selection-summary")).toBeNull();
    });
  });

  it("clicking the pane in uncontrolled mode clears the internal selection", async () => {
    const client = mockClient();
    render(
      <TopologyGraphCanvas result={emptyImportResult()} workerClient={client} />,
    );
    await waitFor(() => expect(screen.getByTestId("rf-mock-click-node")).toBeTruthy());
    fireEvent.click(screen.getByTestId("rf-mock-click-node"));
    await waitFor(() => {
      expect(screen.getByTestId("topology-graph-selection-summary")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("rf-mock-click-pane"));
    await waitFor(() => {
      expect(screen.queryByTestId("topology-graph-selection-summary")).toBeNull();
    });
  });
});

describe("TopologyGraphCanvas — vhost badge accessibility & pipeline composition", () => {
  it("composes entity identity + resolved vhost context in the accessible name (aria-label MUST retain the entity label; tooltip stays as `title`)", async () => {
    const client = mockClient();
    render(
      <TopologyGraphCanvas result={emptyImportResult()} workerClient={client} />,
    );
    // Wait until the ReactFlow mock has been fed the built graph so the
    // topology entity nodes actually reach the DOM through `nodeTypes`.
    await waitFor(() => {
      expect(screen.getByTestId("rf-mock-node-queue:h:q")).toBeTruthy();
    });
    const queueNode = screen.getByTestId("rf-mock-node-queue:h:q");
    const inner = queueNode.querySelector<HTMLElement>(
      '[data-testid="topology-graph-node"]',
    );
    expect(inner).not.toBeNull();
    // Fixture: queue:h:q is on vhost "/" of host "h".
    // `title` = tooltip alone (hover popover surface).
    expect(inner!.getAttribute("title")).toBe("vhost / on host h");
    // `aria-label` MUST retain entity identity (the visible label) — a screen
    // reader that reads only the vhost tooltip loses the queue/exchange name.
    // The composed form is `<visible label>, <tooltip>`.
    const ariaLabel = inner!.getAttribute("aria-label")!;
    expect(ariaLabel).toContain("q · /"); // entity label (with vhost badge suffix)
    expect(ariaLabel).toContain("vhost / on host h"); // full disambiguating context
    expect(ariaLabel).toBe("q · /, vhost / on host h");
    // The compact visible label carries the badge suffix so operators can spot
    // the vhost without hovering.
    expect(inner!.textContent).toContain("· /");

    // The exchange node — same accessibility contract — retains its identity
    // (including the `[topic]` subtype badge) AND appends the vhost context.
    const exchangeNode = screen.getByTestId("rf-mock-node-exchange:h:x");
    const exchangeInner = exchangeNode.querySelector<HTMLElement>(
      '[data-testid="topology-graph-node"]',
    );
    expect(exchangeInner!.getAttribute("title")).toBe("vhost / on host h");
    const exchangeAria = exchangeInner!.getAttribute("aria-label")!;
    expect(exchangeAria).toContain("[topic]");
    expect(exchangeAria).toContain("x");
    expect(exchangeAria).toContain("vhost / on host h");
    expect(exchangeAria).toBe("[topic] x · /, vhost / on host h");

    // Host/vhost nodes have no vhost context → tooltip absent and `aria-label`
    // is left off so the a11y tree falls back to the visible text (the entity
    // label itself). This keeps host/vhost identifiable without fabricating
    // tooltip text.
    const hostNode = screen.getByTestId("rf-mock-node-host:h");
    const hostInner = hostNode.querySelector<HTMLElement>(
      '[data-testid="topology-graph-node"]',
    );
    expect(hostInner!.getAttribute("title")).toBeNull();
    expect(hostInner!.getAttribute("aria-label")).toBeNull();
    expect(hostInner!.textContent).toContain("h");
  });

  it("keeps canonical vhost context when filtering hides host/vhost containers but leaves queues visible", async () => {
    const client = mockClient();
    render(
      <TopologyGraphCanvas result={emptyImportResult()} workerClient={client} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("rf-mock-node-queue:h:q")).toBeTruthy();
    });

    // A non-empty entity-kind set is an allow-list. Selecting only `queue`
    // removes the host and vhost structural nodes while retaining queues.
    fireEvent.click(screen.getByTestId("topology-filters-entity-queue"));
    await waitFor(() => {
      expect(screen.queryByTestId("rf-mock-node-host:h")).toBeNull();
      expect(screen.queryByTestId("rf-mock-node-vhost:h:/")).toBeNull();
      expect(screen.getByTestId("rf-mock-node-queue:h:q")).toBeTruthy();
    });

    // Badge resolution must still use the complete canonical graph supplied
    // by the canvas, not degrade to `unknown vhost` from the filtered graph.
    const queueNode = screen.getByTestId("rf-mock-node-queue:h:q");
    const inner = queueNode.querySelector<HTMLElement>(
      '[data-testid="topology-graph-node"]',
    );
    expect(inner!.getAttribute("title")).toBe("vhost / on host h");
    expect(inner!.getAttribute("aria-label")).toBe("q · /, vhost / on host h");
    expect(inner!.textContent).toContain("· /");
    expect(inner!.textContent).not.toContain("unknown vhost");
  });

  it("composes with the visibility panel: hiding a specific queue removes that node while the surviving exchange keeps its vhost badge/tooltip intact", async () => {
    const client = mockClient();
    render(
      <TopologyGraphCanvas result={emptyImportResult()} workerClient={client} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("rf-mock-node-queue:h:q")).toBeTruthy();
    });
    // Hide `queue:h:q` via the visibility panel's per-entity toggle. The
    // toggle is a checkbox — clicking it flips the node into the hidden set.
    const toggle = screen.getByTestId("topology-visibility-toggle-queue:h:q");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.queryByTestId("rf-mock-node-queue:h:q")).toBeNull();
    });
    // The unrelated exchange still renders WITH the vhost tooltip — proving
    // the badge/tooltip surface didn't get lost when the pipeline dropped a
    // sibling node.
    const exchangeNode = screen.getByTestId("rf-mock-node-exchange:h:x");
    const inner = exchangeNode.querySelector<HTMLElement>(
      '[data-testid="topology-graph-node"]',
    );
    expect(inner!.getAttribute("title")).toBe("vhost / on host h");
    // Accessible name retains the entity identity (`[topic] x · /`) alongside
    // the tooltip so screen readers still hear which entity this is.
    expect(inner!.getAttribute("aria-label")).toBe("[topic] x · /, vhost / on host h");
  });

  it("composes with the visibility panel's ISOLATE-neighborhood action: entities outside the neighborhood are removed while the isolated entity keeps its full canonical badge/tooltip", async () => {
    const client = mockClient();
    render(
      <TopologyGraphCanvas result={emptyImportResult()} workerClient={client} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("rf-mock-node-queue:h:q")).toBeTruthy();
    });
    // The isolate action requires a selection — click a queue via the mock
    // click-node button so the canvas selects `queue:h:q` (uncontrolled).
    fireEvent.click(screen.getByTestId("rf-mock-click-node"));
    await waitFor(() => {
      expect(screen.getByTestId("topology-graph-selection-summary")).toBeTruthy();
    });
    // Now trigger `isolateNeighborhood` for the selected queue.
    fireEvent.click(screen.getByTestId("topology-visibility-isolate-selected"));
    await waitFor(() => {
      // The unrelated queue+exchange chain must fall outside the neighborhood
      // of `queue:h:q` and drop from the render.
      expect(screen.queryByTestId("rf-mock-node-queue:h:unrelated")).toBeNull();
      expect(screen.queryByTestId("rf-mock-node-exchange:h:unrelated")).toBeNull();
    });
    // The isolated queue is still visible and — critically — its accessible
    // name is UNCHANGED even though the vhost/host containers may have been
    // pruned by isolation. This proves `contextNodes` (pre-filter/pre-vis) is
    // consulted by the resolver rather than the post-isolation render graph.
    const queueNode = screen.getByTestId("rf-mock-node-queue:h:q");
    const inner = queueNode.querySelector<HTMLElement>(
      '[data-testid="topology-graph-node"]',
    );
    expect(inner!.getAttribute("title")).toBe("vhost / on host h");
    expect(inner!.getAttribute("aria-label")).toBe("q · /, vhost / on host h");
    // Visible label still carries the compact badge (never degrades to
    // `unknown vhost` even if the vhost node was excluded by isolation).
    expect(inner!.textContent).toContain("· /");
    expect(inner!.textContent).not.toContain("unknown vhost");
  });
});

describe("TopologyGraphCanvas — full-page mode", () => {
  async function mountWithGraph() {
    const client = mockClient();
    const view = render(
      <TopologyGraphCanvas result={emptyImportResult()} workerClient={client} />,
    );
    // Wait for the graph build to reach the ReactFlow mock.
    await waitFor(() => {
      expect(screen.getByTestId("rf-mock-click-node")).toBeTruthy();
    });
    return view;
  }

  it("renders an accessible toggle button that starts un-pressed and flips `aria-pressed` on activation (enter regression)", async () => {
    await mountWithGraph();
    const toggle = screen.getByTestId("topology-graph-fullpage-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // Section is NOT full-page at rest.
    const section = screen.getByTestId("topology-graph-canvas");
    expect(section.getAttribute("data-fullpage")).toBe("false");
    expect(section.style.position).not.toBe("fixed");
    // Activate.
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    // Section overlays the viewport via position:fixed + inset:0.
    expect(section.getAttribute("data-fullpage")).toBe("true");
    expect(section.style.position).toBe("fixed");
    // jsdom may serialize `inset: 0` as either "0" or "0px" depending on
    // its CSSOM version; accept both.
    expect(["0", "0px"]).toContain(section.style.inset);
    // Overlay establishes a stacking context above the App.
    expect(Number(section.style.zIndex)).toBeGreaterThanOrEqual(100);
  });

  it("graph shell grows into remaining space when full-page (flex 1) so the graph itself fills the viewport, not just the section", async () => {
    await mountWithGraph();
    const toggle = screen.getByTestId("topology-graph-fullpage-toggle");
    // Baseline: graph shell uses the fluid `min(70vh, ...)` height.
    const rfRoot = screen.getByTestId("rf-mock-root");
    const baselineShell = rfRoot.parentElement!;
    expect(baselineShell.style.height).toContain("min(");
    // Enter full-page.
    fireEvent.click(toggle);
    const fullShell = rfRoot.parentElement!;
    // In full-page mode the shell uses flex to consume remaining height —
    // no `min(70vh,…)` cap.
    expect(fullShell.style.flex).toContain("1");
    expect(fullShell.style.height).not.toContain("min(");
    // A `minHeight` floor keeps React Flow's own controls reachable on
    // very short viewports.
    expect(fullShell.style.minHeight).toMatch(/vh|px/);
  });

  it("pressing Escape exits full-page mode (accessible exit action)", async () => {
    await mountWithGraph();
    const toggle = screen.getByTestId("topology-graph-fullpage-toggle");
    fireEvent.click(toggle); // enter
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    // Dispatch a real keydown on document — the canvas binds its Escape
    // handler at document level while full-page.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
    });
    const section = screen.getByTestId("topology-graph-canvas");
    expect(section.style.position).not.toBe("fixed");
  });

  it("toggle button also exits when clicked a second time", async () => {
    await mountWithGraph();
    const toggle = screen.getByTestId("topology-graph-fullpage-toggle");
    fireEvent.click(toggle); // enter
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle); // exit
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    const section = screen.getByTestId("topology-graph-canvas");
    expect(section.style.position).not.toBe("fixed");
  });

  it("entering full-page mode locks body scroll; exiting restores the previous overflow (prevents dual-scrollbar UX)", async () => {
    // Assert a known baseline so the restore contract is verifiable.
    document.body.style.overflow = "auto";
    await mountWithGraph();
    const toggle = screen.getByTestId("topology-graph-fullpage-toggle");
    fireEvent.click(toggle);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(toggle);
    expect(document.body.style.overflow).toBe("auto");
  });

  it("selection, focus, filter, visibility, contains-toggle, and configured-flow pause ALL persist across enter/exit (no unmount)", async () => {
    // Focus is a prop, so we drive it via a controlled harness so the enter/
    // exit toggle does not cause React to clear it. This is the honest
    // representation of the App-level integration: parent owns focus, canvas
    // owns filters/visibility/pause/selection/showContains.
    const client = mockClient();
    render(
      <TopologyGraphCanvas
        result={emptyImportResult()}
        workerClient={client}
        focusNodeId="queue:h:q"
        onFocusChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("rf-mock-click-node")).toBeTruthy();
    });
    // ── Prime EVERY piece of state the canvas owns internally ─────────────
    // 1. showContains (contains-toggle)
    const containsToggle = screen.getByTestId(
      "topology-graph-contains-toggle",
    ) as HTMLInputElement;
    expect(containsToggle.checked).toBe(false);
    fireEvent.click(containsToggle);
    expect(containsToggle.checked).toBe(true);
    // 2. selection (uncontrolled)
    fireEvent.click(screen.getByTestId("rf-mock-click-node"));
    await waitFor(() => {
      expect(screen.getByTestId("topology-graph-selection-summary")).toBeTruthy();
    });
    // 3. filters — set a routing-key filter to a non-default value.
    const routingKeyInput = screen.getByTestId(
      "topology-filters-routing-key",
    ) as HTMLInputElement;
    fireEvent.change(routingKeyInput, { target: { value: "primed-filter-value" } });
    expect(routingKeyInput.value).toBe("primed-filter-value");
    // 4. visibility — hide an entity so the visibility hidden-list is
    //    non-empty. The visibility panel's "hide selected" shortcut acts on
    //    the current selection, which we just primed above.
    const hideSelected = screen.getByTestId("topology-visibility-hide-selected");
    fireEvent.click(hideSelected);
    await waitFor(() => {
      expect(screen.getByTestId("topology-visibility-hidden-list")).toBeTruthy();
    });
    // 5. configured-flow pause — flip the pause button to "Resume".
    const pauseBtn = screen.getByTestId(
      "topology-configured-flow-pause",
    ) as HTMLButtonElement;
    // Only assert on non-reduced-motion environments (the button is disabled
    // when the OS forces reduced motion, which our test env does NOT do).
    expect(pauseBtn.disabled).toBe(false);
    expect(pauseBtn.textContent).toContain("Pause");
    fireEvent.click(pauseBtn);
    expect(pauseBtn.textContent).toContain("Resume");
    // 6. focus is already active (prop passed above).
    expect(screen.getByTestId("topology-graph-focus-summary")).toBeTruthy();

    // Snapshot the ReactFlow subtree init count. Entering / exiting full-page
    // MUST NOT remount the subtree; if it did, every child would reset
    // (selection would drop, pause would revert, filter input would lose its
    // value). We assert onInitCalls stays constant to prove the tree stayed
    // mounted — the necessary structural precondition for state persistence.
    const initCountBeforeToggle = rfState.onInitCalls;
    expect(initCountBeforeToggle).toBeGreaterThan(0);

    // ── Enter full-page ───────────────────────────────────────────────────
    const fullPageToggle = screen.getByTestId("topology-graph-fullpage-toggle");
    fireEvent.click(fullPageToggle);
    // No remount.
    expect(rfState.onInitCalls).toBe(initCountBeforeToggle);
    // Every piece of state survives, verified by observable UI:
    expect(
      (screen.getByTestId("topology-graph-contains-toggle") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.getByTestId("topology-graph-selection-summary")).toBeTruthy();
    expect(
      (screen.getByTestId("topology-filters-routing-key") as HTMLInputElement)
        .value,
    ).toBe("primed-filter-value");
    expect(screen.getByTestId("topology-visibility-hidden-list")).toBeTruthy();
    expect(
      (screen.getByTestId("topology-configured-flow-pause") as HTMLButtonElement)
        .textContent,
    ).toContain("Resume");
    // focused mode from prop is still active in full-page.
    expect(screen.getByTestId("topology-graph-focus-summary")).toBeTruthy();

    // ── Exit full-page ────────────────────────────────────────────────────
    fireEvent.click(fullPageToggle);
    // Still no remount across the exit transition.
    expect(rfState.onInitCalls).toBe(initCountBeforeToggle);
    // All state still there after coming back to inline mode:
    expect(
      (screen.getByTestId("topology-graph-contains-toggle") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.getByTestId("topology-graph-selection-summary")).toBeTruthy();
    expect(
      (screen.getByTestId("topology-filters-routing-key") as HTMLInputElement)
        .value,
    ).toBe("primed-filter-value");
    expect(screen.getByTestId("topology-visibility-hidden-list")).toBeTruthy();
    expect(
      (screen.getByTestId("topology-configured-flow-pause") as HTMLButtonElement)
        .textContent,
    ).toContain("Resume");
    expect(screen.getByTestId("topology-graph-focus-summary")).toBeTruthy();
  });

  it("entering / exiting full-page mode calls fitView via the `[focused, isFullPage]` effect — WITHOUT remounting the ReactFlow subtree (would otherwise reset all child state and only spuriously look like a refit)", async () => {
    await mountWithGraph();
    // Baseline: the mount-time flow fired `onInit` exactly once, seeded the
    // ref, and (per the effect on `[focused, isFullPage]`) already called
    // fitView once at mount. Capture both counters so we can prove the
    // toggle-driven increment is NOT a byproduct of a remount.
    const baselineFit = rfState.fitViewCalls;
    const baselineInit = rfState.onInitCalls;
    expect(baselineInit).toBeGreaterThan(0);

    const toggle = screen.getByTestId("topology-graph-fullpage-toggle");

    // ── Enter full-page ───────────────────────────────────────────────────
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(rfState.fitViewCalls).toBeGreaterThan(baselineFit);
    });
    // Regression guard: if the enter transition had unmounted / remounted
    // the ReactFlow subtree, onInit would tick up and fitView's "increment"
    // would be attributable to the remount rather than to the size-change
    // refit path in production. onInit MUST stay flat.
    expect(rfState.onInitCalls).toBe(baselineInit);
    const afterEnterFit = rfState.fitViewCalls;

    // ── Exit full-page ────────────────────────────────────────────────────
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(rfState.fitViewCalls).toBeGreaterThan(afterEnterFit);
    });
    expect(rfState.onInitCalls).toBe(baselineInit);
  });

  it("regression: fitView is called STRICTLY after the isFullPage state change, not just because ReactFlow re-rendered — asserted by exact increment count", async () => {
    await mountWithGraph();
    const baselineFit = rfState.fitViewCalls;
    const baselineInit = rfState.onInitCalls;
    const toggle = screen.getByTestId("topology-graph-fullpage-toggle");

    // Trigger an unrelated re-render that does NOT change isFullPage or
    // focused: flip the "Show contains" toggle. This changes `showContains`,
    // which flows through the flowGraph memo and re-renders ReactFlow — but
    // the `[focused, isFullPage]` effect must NOT fire. If it does, our
    // wiring would be spuriously refitting on any prop change and the
    // reviewer-flagged concern would be legitimate.
    const containsToggle = screen.getByTestId(
      "topology-graph-contains-toggle",
    ) as HTMLInputElement;
    fireEvent.click(containsToggle);
    // Yield a tick to let effects flush.
    await Promise.resolve();
    expect(rfState.onInitCalls).toBe(baselineInit);
    // Contains-toggle should not fire the focus/full-page refit effect.
    expect(rfState.fitViewCalls).toBe(baselineFit);

    // Now toggle full-page. The size-change refit effect must fire — EXACTLY
    // once per state flip — and onInit must not tick.
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(rfState.fitViewCalls).toBe(baselineFit + 1);
    });
    expect(rfState.onInitCalls).toBe(baselineInit);
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(rfState.fitViewCalls).toBe(baselineFit + 2);
    });
    expect(rfState.onInitCalls).toBe(baselineInit);
  });
});
