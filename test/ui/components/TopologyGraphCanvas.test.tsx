import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BuildGraphResult } from "../../../src/core/graph/buildGraph";
import type { UpstreamTraversalResult } from "../../../src/core/graph/traversal";
import type {
  ImportArchiveWorkerClient,
  ImportResult,
} from "../../../src/core/import";

afterEach(() => cleanup());

// ReactFlow's real rendering path is heavy in jsdom (measures DOM, wires
// pointer events). Replace it with a minimal shim that surfaces the
// props the canvas depends on — specifically `onNodeClick` and `onPaneClick`
// — via buttons so uncontrolled selection can be simulated without ReactFlow
// itself needing a viewport.
vi.mock("reactflow", () => {
  const React = require("react");
  interface RFProps {
    onNodeClick?: (event: unknown, node: { id: string }) => void;
    onPaneClick?: () => void;
    nodes?: Array<{ id: string }>;
  }
  return {
    __esModule: true,
    default: (props: RFProps) => {
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
        { "data-testid": "rf-mock-root" },
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
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
  };
});

import { TopologyGraphCanvas } from "../../../src/ui/components/TopologyGraphCanvas";

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
  ],
  edges: [
    { id: "b:x->q", from: "exchange:h:x", to: "queue:h:q", kind: "binds", routingKey: "k" },
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
