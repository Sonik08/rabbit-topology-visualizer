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
};
vi.mock("reactflow", () => {
  const React = require("react");
  interface RFProps {
    onNodeClick?: (event: unknown, node: { id: string }) => void;
    onPaneClick?: () => void;
    onInit?: (instance: { fitView: (opts?: unknown) => void }) => void;
    nodes?: Array<{ id: string }>;
    edges?: Array<{ id: string }>;
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
    );
  };
  return {
    __esModule: true,
    default: Rf,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
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
