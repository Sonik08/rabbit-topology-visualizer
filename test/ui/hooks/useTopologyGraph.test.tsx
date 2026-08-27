import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { BuildGraphResult } from "../../../src/core/graph/buildGraph";
import type { UpstreamTraversalResult } from "../../../src/core/graph/traversal";
import type {
  ImportArchiveWorkerClient,
  ImportResult,
} from "../../../src/core/import";
import { useTopologyGraph } from "../../../src/ui/hooks/useTopologyGraph";
import { createEmptyFilterState } from "../../../src/ui/components/TopologyFiltersPanel";

afterEach(() => cleanup());

const EMPTY_TRAVERSAL: UpstreamTraversalResult = {
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

const GRAPH_FIXTURE: BuildGraphResult = {
  nodes: [
    { id: "host:h", kind: "host", label: "h", data: { id: "host:h", name: "h", sourceFiles: [] } },
    {
      id: "vhost:h:/",
      kind: "vhost",
      label: "/",
      data: { id: "vhost:h:/", hostId: "host:h", name: "/" },
    },
    { id: "exchange:h:x", kind: "exchange", label: "x", data: {} },
    { id: "queue:h:q", kind: "queue", label: "q", data: {} },
  ],
  edges: [
    { id: "c:host->vhost", from: "host:h", to: "vhost:h:/", kind: "contains" },
    { id: "c:vhost->x", from: "vhost:h:/", to: "exchange:h:x", kind: "contains" },
    { id: "c:vhost->q", from: "vhost:h:/", to: "queue:h:q", kind: "contains" },
    { id: "b:x->q", from: "exchange:h:x", to: "queue:h:q", kind: "binds", routingKey: "k" },
  ],
  diagnostics: [],
};

function mockClient(overrides?: Partial<ImportArchiveWorkerClient>): ImportArchiveWorkerClient {
  return {
    importArchive: vi.fn(),
    buildGraph: vi.fn(async () => GRAPH_FIXTURE),
    upstreamForQueue: vi.fn(async () => EMPTY_TRAVERSAL),
    upstreamForExchange: vi.fn(async () => EMPTY_TRAVERSAL),
    terminate: vi.fn(),
    ...overrides,
  } as ImportArchiveWorkerClient;
}

function emptyImportResult(): ImportResult {
  return {
    archiveKind: "json",
    archivePath: "test.json",
    files: [],
    diagnostics: [],
  };
}

describe("useTopologyGraph — production wiring through the worker client", () => {
  it("calls workerClient.buildGraph on mount and updates state with its result", async () => {
    const client = mockClient();
    const stableResult = emptyImportResult();
    const stableFilters = createEmptyFilterState();
    const { result } = renderHook(() =>
      useTopologyGraph({
        result: stableResult,
        filters: stableFilters,
        selectedNodeId: undefined,
        workerClient: client,
      }),
    );
    // Effect fires after render — wait for buildGraph to resolve and state to update.
    await waitFor(() => {
      expect(result.current.rawGraph.nodes.length).toBe(GRAPH_FIXTURE.nodes.length);
    });
    expect(client.buildGraph).toHaveBeenCalledTimes(1);
    expect(result.current.buildLoading).toBe(false);
    // Filter pipeline still runs synchronously on top of the worker result.
    expect(result.current.graph.nodes.length).toBe(GRAPH_FIXTURE.nodes.length);
  });

  it("selecting a queue routes the traversal through workerClient.upstreamForQueue", async () => {
    const client = mockClient();
    const stableResult = emptyImportResult();
    const stableFilters = createEmptyFilterState();
    const { result, rerender } = renderHook(
      (props: { selectedNodeId: string | undefined }) =>
        useTopologyGraph({
          result: stableResult,
          filters: stableFilters,
          selectedNodeId: props.selectedNodeId,
          workerClient: client,
        }),
      { initialProps: { selectedNodeId: undefined } },
    );
    await waitFor(() => {
      expect(result.current.rawGraph.nodes.length).toBe(GRAPH_FIXTURE.nodes.length);
    });
    // Now select the queue — hook must call upstreamForQueue (NOT upstreamForExchange).
    rerender({ selectedNodeId: "queue:h:q" });
    await waitFor(() => {
      expect(client.upstreamForQueue).toHaveBeenCalledTimes(1);
    });
    expect(client.upstreamForExchange).not.toHaveBeenCalled();
    // Highlight is built from the traversal locally.
    await waitFor(() => {
      expect(result.current.highlight.nodeIds.has("exchange:h:x")).toBe(true);
      expect(result.current.highlight.nodeIds.has("queue:h:q")).toBe(true);
      expect(result.current.highlight.edgeIds.has("b:x->q")).toBe(true);
    });
  });

  it("selecting an exchange routes through workerClient.upstreamForExchange (not the queue variant)", async () => {
    const client = mockClient();
    const stableResult = emptyImportResult();
    const stableFilters = createEmptyFilterState();
    const { rerender } = renderHook(
      (props: { selectedNodeId: string | undefined }) =>
        useTopologyGraph({
          result: stableResult,
          filters: stableFilters,
          selectedNodeId: props.selectedNodeId,
          workerClient: client,
        }),
      { initialProps: { selectedNodeId: undefined } },
    );
    await waitFor(() => {
      expect(client.buildGraph).toHaveBeenCalledTimes(1);
    });
    rerender({ selectedNodeId: "exchange:h:x" });
    await waitFor(() => {
      expect(client.upstreamForExchange).toHaveBeenCalledTimes(1);
    });
    expect(client.upstreamForQueue).not.toHaveBeenCalled();
  });

  it("does not call the traversal client at all when no node is selected", async () => {
    const client = mockClient();
    const stableResult = emptyImportResult();
    const stableFilters = createEmptyFilterState();
    const { result } = renderHook(() =>
      useTopologyGraph({
        result: stableResult,
        filters: stableFilters,
        selectedNodeId: undefined,
        workerClient: client,
      }),
    );
    await waitFor(() => {
      expect(client.buildGraph).toHaveBeenCalledTimes(1);
    });
    // Give queued effects a chance to run — no traversal should fire.
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.upstreamForQueue).not.toHaveBeenCalled();
    expect(client.upstreamForExchange).not.toHaveBeenCalled();
    expect(result.current.highlight.nodeIds.size).toBe(0);
  });

  it("passes filters.maxDepth through to the worker as UpstreamTraversalOptions", async () => {
    const client = mockClient();
    const stableResult = emptyImportResult();
    const filters = { ...createEmptyFilterState(), maxDepth: 5 };
    renderHook(() =>
      useTopologyGraph({
        result: stableResult,
        filters,
        selectedNodeId: "queue:h:q",
        workerClient: client,
      }),
    );
    await waitFor(() => {
      expect(client.upstreamForQueue).toHaveBeenCalled();
    });
    const [, , options] = (client.upstreamForQueue as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]!;
    expect(options).toEqual({ maxDepth: 5 });
  });

  it("regression: switching `result` immediately clears the old topology so nothing stale renders while the new build is in flight", async () => {
    // Deferred build: we control exactly when the worker resolves each
    // buildGraph call so we can observe the intermediate state.
    let resolveFirst: ((g: BuildGraphResult) => void) | undefined;
    let resolveSecond: ((g: BuildGraphResult) => void) | undefined;
    const secondGraph: BuildGraphResult = {
      nodes: [{ id: "queue:h:new-target", kind: "queue", label: "new-target", data: {} }],
      edges: [],
      diagnostics: [],
    };
    const buildGraphMock = vi
      .fn<[unknown], Promise<BuildGraphResult>>()
      .mockImplementationOnce(
        () =>
          new Promise<BuildGraphResult>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<BuildGraphResult>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const client = mockClient({
      buildGraph: buildGraphMock,
    });
    const firstResult = emptyImportResult();
    const secondResult: ImportResult = { ...emptyImportResult(), archivePath: "second.json" };
    const stableFilters = createEmptyFilterState();
    const { result, rerender } = renderHook(
      (props: { result: ImportResult; selectedNodeId: string | undefined }) =>
        useTopologyGraph({
          result: props.result,
          filters: stableFilters,
          selectedNodeId: props.selectedNodeId,
          workerClient: client,
        }),
      { initialProps: { result: firstResult, selectedNodeId: undefined } },
    );
    // Resolve the first buildGraph so the hook has real state to display.
    await act(async () => {
      resolveFirst?.(GRAPH_FIXTURE);
    });
    await waitFor(() => {
      expect(result.current.rawGraph.nodes.length).toBe(GRAPH_FIXTURE.nodes.length);
    });
    // User selects a queue from the first topology — highlight fires and
    // resolves through the mocked traversal.
    rerender({ result: firstResult, selectedNodeId: "queue:h:q" });
    await waitFor(() => {
      expect(result.current.highlight.nodeIds.has("queue:h:q")).toBe(true);
    });
    // Now swap in a NEW result. The second buildGraph is still pending, so
    // the hook MUST NOT expose the previous topology (or the previous
    // highlight) while the build is in flight.
    rerender({ result: secondResult, selectedNodeId: "queue:h:q" });
    // At this point, no useEffect has resolved the new build yet. Verify
    // the stale topology is cleared synchronously via the setState calls.
    await waitFor(() => {
      expect(result.current.rawGraph.nodes.length).toBe(0);
      expect(result.current.buildLoading).toBe(true);
      expect(result.current.highlight.nodeIds.size).toBe(0);
    });
    // The old first-topology graph must not be visible any longer.
    expect(result.current.graph.nodes.some((n) => n.id === "queue:h:q")).toBe(false);
    // Now let the new build resolve — the hook should adopt the new graph.
    await act(async () => {
      resolveSecond?.(secondGraph);
    });
    await waitFor(() => {
      expect(result.current.rawGraph.nodes.some((n) => n.id === "queue:h:new-target")).toBe(true);
      expect(result.current.buildLoading).toBe(false);
    });
    // Both buildGraph calls were issued (one per distinct result).
    expect(buildGraphMock).toHaveBeenCalledTimes(2);
  });

  it("regression: rapid selection change immediately clears the stale highlight so the previous node/edge highlight never shines through while the new traversal is pending", async () => {
    // Deferred traversals — we control exactly when each upstreamForQueue
    // call resolves. The first resolves with a highlight targeting q1; the
    // second resolves with a highlight targeting q2. Between the two the
    // stale q1 highlight must NOT remain visible.
    let resolveFirstTraversal: ((r: UpstreamTraversalResult) => void) | undefined;
    let resolveSecondTraversal: ((r: UpstreamTraversalResult) => void) | undefined;
    const graphWithTwoQueues: BuildGraphResult = {
      nodes: [
        { id: "host:h", kind: "host", label: "h", data: { id: "host:h", name: "h", sourceFiles: [] } },
        {
          id: "vhost:h:/",
          kind: "vhost",
          label: "/",
          data: { id: "vhost:h:/", hostId: "host:h", name: "/" },
        },
        { id: "exchange:h:x", kind: "exchange", label: "x", data: {} },
        { id: "queue:h:q1", kind: "queue", label: "q1", data: {} },
        { id: "queue:h:q2", kind: "queue", label: "q2", data: {} },
      ],
      edges: [
        { id: "c:host->vhost", from: "host:h", to: "vhost:h:/", kind: "contains" },
        { id: "c:vhost->x", from: "vhost:h:/", to: "exchange:h:x", kind: "contains" },
        { id: "c:vhost->q1", from: "vhost:h:/", to: "queue:h:q1", kind: "contains" },
        { id: "c:vhost->q2", from: "vhost:h:/", to: "queue:h:q2", kind: "contains" },
        { id: "b:x->q1", from: "exchange:h:x", to: "queue:h:q1", kind: "binds", routingKey: "k" },
        { id: "b:x->q2", from: "exchange:h:x", to: "queue:h:q2", kind: "binds", routingKey: "k" },
      ],
      diagnostics: [],
    };
    const upstreamForQueueMock = vi
      .fn<[unknown, string, unknown?], Promise<UpstreamTraversalResult>>()
      .mockImplementationOnce(
        () =>
          new Promise<UpstreamTraversalResult>((resolve) => {
            resolveFirstTraversal = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<UpstreamTraversalResult>((resolve) => {
            resolveSecondTraversal = resolve;
          }),
      );
    const client = mockClient({
      buildGraph: vi.fn(async () => graphWithTwoQueues),
      upstreamForQueue: upstreamForQueueMock,
    });
    const stableResult = emptyImportResult();
    const stableFilters = createEmptyFilterState();
    const { result, rerender } = renderHook(
      (props: { selectedNodeId: string | undefined }) =>
        useTopologyGraph({
          result: stableResult,
          filters: stableFilters,
          selectedNodeId: props.selectedNodeId,
          workerClient: client,
        }),
      { initialProps: { selectedNodeId: undefined } },
    );
    await waitFor(() => {
      expect(result.current.rawGraph.nodes.length).toBe(graphWithTwoQueues.nodes.length);
    });
    // Select q1 — first traversal starts, resolves with a q1-centric highlight.
    rerender({ selectedNodeId: "queue:h:q1" });
    await waitFor(() => {
      expect(client.upstreamForQueue).toHaveBeenCalledTimes(1);
      expect(result.current.highlightLoading).toBe(true);
    });
    await act(async () => {
      resolveFirstTraversal?.({
        targetNodeId: "queue:h:q1",
        reachableAncestorIds: ["exchange:h:x"],
        paths: [
          {
            sourceNodeId: "exchange:h:x",
            steps: [
              {
                edgeId: "b:x->q1",
                fromNodeId: "exchange:h:x",
                toNodeId: "queue:h:q1",
                kind: "binds",
                routingKey: "k",
              },
            ],
          },
        ],
        truncated: false,
        visitedCycles: [],
      });
    });
    await waitFor(() => {
      expect(result.current.highlight.nodeIds.has("queue:h:q1")).toBe(true);
      expect(result.current.highlight.edgeIds.has("b:x->q1")).toBe(true);
      expect(result.current.highlightLoading).toBe(false);
    });
    // Now rapidly switch to q2. The second traversal is deferred — the hook
    // must clear the q1 highlight synchronously so nothing stale renders.
    rerender({ selectedNodeId: "queue:h:q2" });
    await waitFor(() => {
      // Highlight cleared immediately when the new traversal begins.
      expect(result.current.highlight.nodeIds.size).toBe(0);
      expect(result.current.highlight.edgeIds.size).toBe(0);
      expect(result.current.highlightLoading).toBe(true);
    });
    // Stale q1 highlights must NOT still be visible.
    expect(result.current.highlight.nodeIds.has("queue:h:q1")).toBe(false);
    expect(result.current.highlight.edgeIds.has("b:x->q1")).toBe(false);
    expect(client.upstreamForQueue).toHaveBeenCalledTimes(2);
    // Release the second traversal — the hook adopts the q2 highlight.
    await act(async () => {
      resolveSecondTraversal?.({
        targetNodeId: "queue:h:q2",
        reachableAncestorIds: ["exchange:h:x"],
        paths: [
          {
            sourceNodeId: "exchange:h:x",
            steps: [
              {
                edgeId: "b:x->q2",
                fromNodeId: "exchange:h:x",
                toNodeId: "queue:h:q2",
                kind: "binds",
                routingKey: "k",
              },
            ],
          },
        ],
        truncated: false,
        visitedCycles: [],
      });
    });
    await waitFor(() => {
      expect(result.current.highlight.nodeIds.has("queue:h:q2")).toBe(true);
      expect(result.current.highlight.edgeIds.has("b:x->q2")).toBe(true);
      expect(result.current.highlightLoading).toBe(false);
    });
  });

  it("recovers gracefully when the worker rejects buildGraph (falls back to empty graph, not crash)", async () => {
    const client = mockClient({
      buildGraph: vi.fn(async () => {
        throw new Error("worker crashed");
      }),
    });
    const stableResult = emptyImportResult();
    const stableFilters = createEmptyFilterState();
    const { result } = renderHook(() =>
      useTopologyGraph({
        result: stableResult,
        filters: stableFilters,
        selectedNodeId: undefined,
        workerClient: client,
      }),
    );
    await waitFor(() => {
      expect(result.current.buildLoading).toBe(false);
    });
    expect(result.current.rawGraph.nodes.length).toBe(0);
    expect(result.current.graph.nodes.length).toBe(0);
  });
});
