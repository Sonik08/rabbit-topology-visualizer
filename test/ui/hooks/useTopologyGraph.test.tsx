import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { BuildGraphResult } from "../../../src/core/graph/buildGraph";
import type {
  BidirectionalTraversalResult,
  UpstreamTraversalResult,
} from "../../../src/core/graph/traversal";
import type {
  ImportArchiveWorkerClient,
  ImportResult,
} from "../../../src/core/import";
import type { PruneNeighborhoodResult } from "../../../src/core/graph/pruneNeighborhood";
import {
  useFocusedNeighborhood,
  useTopologyGraph,
} from "../../../src/ui/hooks/useTopologyGraph";
import { createEmptyFilterState } from "../../../src/ui/components/TopologyFiltersPanel";
import {
  createEmptyVisibility,
  hideNodes,
  type VisibilityState,
} from "../../../src/core/graph/visibility";

afterEach(() => cleanup());

const UPSTREAM_TRAVERSAL: UpstreamTraversalResult = {
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

const BIDIRECTIONAL_TRAVERSAL: BidirectionalTraversalResult = {
  targetNodeId: "queue:h:q",
  upstream: UPSTREAM_TRAVERSAL,
  downstream: {
    targetNodeId: "queue:h:q",
    reachableDescendantIds: [],
    paths: [],
    truncated: false,
    visitedCycles: [],
  },
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
    upstreamForQueue: vi.fn(async () => UPSTREAM_TRAVERSAL),
    upstreamForExchange: vi.fn(async () => UPSTREAM_TRAVERSAL),
    bidirectionalForNode: vi.fn(async (_input, targetNodeId: string) => ({
      ...BIDIRECTIONAL_TRAVERSAL,
      targetNodeId,
      upstream: { ...UPSTREAM_TRAVERSAL, targetNodeId },
      downstream: {
        ...BIDIRECTIONAL_TRAVERSAL.downstream,
        targetNodeId,
      },
    })),
    pruneNeighborhood: vi.fn(async (input, focusNodeId: string) => ({
      nodes: input.nodes,
      edges: input.edges,
      diagnostics: input.diagnostics ?? [],
      focusNodeId,
      truncated: false,
      focusMissing: false,
    })),
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

  it("selecting a queue routes the traversal through workerClient.bidirectionalForNode (single-hop bidirectional call, not the per-direction upstream helpers)", async () => {
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
    rerender({ selectedNodeId: "queue:h:q" });
    await waitFor(() => {
      expect(client.bidirectionalForNode).toHaveBeenCalledTimes(1);
    });
    // The per-direction upstream helpers are NOT consulted on the selection
    // path anymore — the bidirectional worker hop replaces them.
    expect(client.upstreamForQueue).not.toHaveBeenCalled();
    expect(client.upstreamForExchange).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(result.current.highlight.nodeIds.has("exchange:h:x")).toBe(true);
      expect(result.current.highlight.nodeIds.has("queue:h:q")).toBe(true);
      expect(result.current.highlight.edgeIds.has("b:x->q")).toBe(true);
    });
  });

  it("selecting an exchange routes through workerClient.bidirectionalForNode (same single-hop path as a queue selection)", async () => {
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
      expect(client.bidirectionalForNode).toHaveBeenCalledTimes(1);
    });
    expect(client.upstreamForExchange).not.toHaveBeenCalled();
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
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.bidirectionalForNode).not.toHaveBeenCalled();
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
      expect(client.bidirectionalForNode).toHaveBeenCalled();
    });
    const [, , options] = (client.bidirectionalForNode as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0]!;
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
    // Deferred traversals — we control exactly when each bidirectionalForNode
    // call resolves. The first resolves with a highlight targeting q1; the
    // second resolves with a highlight targeting q2. Between the two the
    // stale q1 highlight must NOT remain visible.
    let resolveFirstTraversal: ((r: BidirectionalTraversalResult) => void) | undefined;
    let resolveSecondTraversal: ((r: BidirectionalTraversalResult) => void) | undefined;
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
    const bidirectionalMock = vi
      .fn<[unknown, string, unknown?], Promise<BidirectionalTraversalResult>>()
      .mockImplementationOnce(
        () =>
          new Promise<BidirectionalTraversalResult>((resolve) => {
            resolveFirstTraversal = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<BidirectionalTraversalResult>((resolve) => {
            resolveSecondTraversal = resolve;
          }),
      );
    const client = mockClient({
      buildGraph: vi.fn(async () => graphWithTwoQueues),
      bidirectionalForNode: bidirectionalMock,
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
      expect(client.bidirectionalForNode).toHaveBeenCalledTimes(1);
      expect(result.current.highlightLoading).toBe(true);
    });
    await act(async () => {
      resolveFirstTraversal?.({
        targetNodeId: "queue:h:q1",
        upstream: {
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
        },
        downstream: {
          targetNodeId: "queue:h:q1",
          reachableDescendantIds: [],
          paths: [],
          truncated: false,
          visitedCycles: [],
        },
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
    expect(client.bidirectionalForNode).toHaveBeenCalledTimes(2);
    // Release the second traversal — the hook adopts the q2 highlight.
    await act(async () => {
      resolveSecondTraversal?.({
        targetNodeId: "queue:h:q2",
        upstream: {
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
        },
        downstream: {
          targetNodeId: "queue:h:q2",
          reachableDescendantIds: [],
          paths: [],
          truncated: false,
          visitedCycles: [],
        },
      });
    });
    await waitFor(() => {
      expect(result.current.highlight.nodeIds.has("queue:h:q2")).toBe(true);
      expect(result.current.highlight.edgeIds.has("b:x->q2")).toBe(true);
      expect(result.current.highlightLoading).toBe(false);
    });
  });

  it("selecting a SHOVEL routes through workerClient.bidirectionalForNode and produces a highlight containing every chain node in both directions (task 58 supported-kind expansion)", async () => {
    // Fixture: exchange:h:x1 → exchange:h:x2 → shovel:h:s1 → exchange:h:x3 → queue:h:q1.
    // Selecting the shovel must land a bidirectionalForNode request AND the
    // resulting highlight must expose incomingCount + outgoingCount so the
    // canvas summary can render both sides.
    const chainGraph: BuildGraphResult = {
      nodes: [
        { id: "exchange:h:x1", kind: "exchange", label: "x1", data: {} },
        { id: "exchange:h:x2", kind: "exchange", label: "x2", data: {} },
        { id: "shovel:h:s1", kind: "shovel", label: "s1", data: {} },
        { id: "exchange:h:x3", kind: "exchange", label: "x3", data: {} },
        { id: "queue:h:q1", kind: "queue", label: "q1", data: {} },
      ],
      edges: [
        { id: "b:x1->x2", from: "exchange:h:x1", to: "exchange:h:x2", kind: "binds", routingKey: "k" },
        { id: "b:x2->s1", from: "exchange:h:x2", to: "shovel:h:s1", kind: "binds", routingKey: "k" },
        { id: "s:s1->x3", from: "shovel:h:s1", to: "exchange:h:x3", kind: "shovels" },
        { id: "b:x3->q1", from: "exchange:h:x3", to: "queue:h:q1", kind: "binds", routingKey: "k" },
      ],
      diagnostics: [],
    };
    const client = mockClient({
      buildGraph: vi.fn(async () => chainGraph),
      bidirectionalForNode: vi.fn(async (_input, targetNodeId: string) => ({
        targetNodeId,
        upstream: {
          targetNodeId,
          reachableAncestorIds: ["exchange:h:x1", "exchange:h:x2"],
          paths: [],
          truncated: false,
          visitedCycles: [],
        },
        downstream: {
          targetNodeId,
          reachableDescendantIds: ["exchange:h:x3", "queue:h:q1"],
          paths: [],
          truncated: false,
          visitedCycles: [],
        },
      })),
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
      expect(result.current.rawGraph.nodes.length).toBe(chainGraph.nodes.length);
    });
    rerender({ selectedNodeId: "shovel:h:s1" });
    await waitFor(() => {
      expect(client.bidirectionalForNode).toHaveBeenCalledTimes(1);
    });
    // The bidirectional envelope populates both direction counts and the
    // union of highlighted node ids includes every chain participant.
    await waitFor(() => {
      expect(result.current.highlight.incomingCount).toBe(2);
      expect(result.current.highlight.outgoingCount).toBe(2);
      expect(result.current.highlight.nodeIds.has("shovel:h:s1")).toBe(true);
      expect(result.current.highlight.nodeIds.has("exchange:h:x1")).toBe(true);
      expect(result.current.highlight.nodeIds.has("queue:h:q1")).toBe(true);
    });
    // The per-direction upstream helpers are NOT consulted on the shovel
    // selection path.
    expect(client.upstreamForQueue).not.toHaveBeenCalled();
    expect(client.upstreamForExchange).not.toHaveBeenCalled();
  });

  it("selecting a FEDERATION node routes through workerClient.bidirectionalForNode (federation is the fourth supported entry kind alongside queue/exchange/shovel)", async () => {
    const federationGraph: BuildGraphResult = {
      nodes: [
        { id: "exchange:h:src", kind: "exchange", label: "src", data: {} },
        { id: "federation:h:link", kind: "federation", label: "link", data: {} },
        { id: "queue:h:dest", kind: "queue", label: "dest", data: {} },
      ],
      edges: [
        { id: "f:src->link", from: "exchange:h:src", to: "federation:h:link", kind: "federates" },
        { id: "f:link->dest", from: "federation:h:link", to: "queue:h:dest", kind: "federates" },
      ],
      diagnostics: [],
    };
    const client = mockClient({
      buildGraph: vi.fn(async () => federationGraph),
      bidirectionalForNode: vi.fn(async (_input, targetNodeId: string) => ({
        targetNodeId,
        upstream: {
          targetNodeId,
          reachableAncestorIds: ["exchange:h:src"],
          paths: [],
          truncated: false,
          visitedCycles: [],
        },
        downstream: {
          targetNodeId,
          reachableDescendantIds: ["queue:h:dest"],
          paths: [],
          truncated: false,
          visitedCycles: [],
        },
      })),
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
      expect(result.current.rawGraph.nodes.length).toBe(federationGraph.nodes.length);
    });
    rerender({ selectedNodeId: "federation:h:link" });
    await waitFor(() => {
      expect(client.bidirectionalForNode).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.highlight.incomingCount).toBe(1);
      expect(result.current.highlight.outgoingCount).toBe(1);
      expect(result.current.highlight.nodeIds.has("federation:h:link")).toBe(true);
      expect(result.current.highlight.nodeIds.has("exchange:h:src")).toBe(true);
      expect(result.current.highlight.nodeIds.has("queue:h:dest")).toBe(true);
    });
  });

  it("selecting an UNSUPPORTED kind (host / vhost / external) is a safe no-op — no worker call, empty highlight", async () => {
    // Reuse the tiny graph fixture — its host + vhost nodes are the
    // structural ancestors that must NOT trigger a highlight traversal.
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
    rerender({ selectedNodeId: "host:h" });
    // Yield effects — nothing should call the worker traversal.
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.bidirectionalForNode).not.toHaveBeenCalled();
    expect(result.current.highlight.nodeIds.size).toBe(0);
    expect(result.current.highlight.incomingCount).toBe(0);
    expect(result.current.highlight.outgoingCount).toBe(0);
    // Also try vhost — same safe-no-op path.
    rerender({ selectedNodeId: "vhost:h:/" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.bidirectionalForNode).not.toHaveBeenCalled();
    expect(result.current.highlight.nodeIds.size).toBe(0);
  });

  it("regression: OUT-OF-ORDER worker resolution — a stale earlier-selection traversal that resolves AFTER the newer selection's traversal must NOT overwrite the current highlight (task 53 search-driven staleness protection)", async () => {
    // The existing rapid-selection regression covers first-in-first-out
    // resolution. This test hammers the harder case a search-driven flow can
    // exercise: the user clicks search result A, then immediately picks
    // search result B while A's worker call is still in flight; B's traversal
    // resolves FIRST (fast) and A's resolves LATER (slow). The hook's
    // cancelled-guard must reject A's late arrival so the on-screen highlight
    // keeps pointing at B, not silently regress to the stale A view.
    let resolveA: ((r: BidirectionalTraversalResult) => void) | undefined;
    let resolveB: ((r: BidirectionalTraversalResult) => void) | undefined;
    const graphWithTwoQueues: BuildGraphResult = {
      nodes: [
        { id: "host:h", kind: "host", label: "h", data: { id: "host:h", name: "h", sourceFiles: [] } },
        { id: "vhost:h:/", kind: "vhost", label: "/", data: { id: "vhost:h:/", hostId: "host:h", name: "/" } },
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
    const bidirectionalMock = vi
      .fn<[unknown, string, unknown?], Promise<BidirectionalTraversalResult>>()
      .mockImplementationOnce(
        () =>
          new Promise<BidirectionalTraversalResult>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<BidirectionalTraversalResult>((resolve) => {
            resolveB = resolve;
          }),
      );
    const client = mockClient({
      buildGraph: vi.fn(async () => graphWithTwoQueues),
      bidirectionalForNode: bidirectionalMock,
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
      expect(result.current.rawGraph.nodes.length).toBe(
        graphWithTwoQueues.nodes.length,
      );
    });
    // Search-driven selection A: q1.
    rerender({ selectedNodeId: "queue:h:q1" });
    await waitFor(() => {
      expect(client.bidirectionalForNode).toHaveBeenCalledTimes(1);
    });
    // Search-driven selection B: q2 — while A is still in flight.
    rerender({ selectedNodeId: "queue:h:q2" });
    await waitFor(() => {
      expect(client.bidirectionalForNode).toHaveBeenCalledTimes(2);
    });
    // Resolve B FIRST — the current selection matches so the highlight
    // adopts it and stops loading.
    await act(async () => {
      resolveB?.({
        targetNodeId: "queue:h:q2",
        upstream: {
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
        },
        downstream: {
          targetNodeId: "queue:h:q2",
          reachableDescendantIds: [],
          paths: [],
          truncated: false,
          visitedCycles: [],
        },
      });
    });
    await waitFor(() => {
      expect(result.current.highlight.nodeIds.has("queue:h:q2")).toBe(true);
      expect(result.current.highlight.edgeIds.has("b:x->q2")).toBe(true);
      expect(result.current.highlightLoading).toBe(false);
    });
    // Now resolve A LATE (out of order). The cancelled flag from A's cleanup
    // must reject its `.then` so the q2 highlight survives untouched.
    await act(async () => {
      resolveA?.({
        targetNodeId: "queue:h:q1",
        upstream: {
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
        },
        downstream: {
          targetNodeId: "queue:h:q1",
          reachableDescendantIds: [],
          paths: [],
          truncated: false,
          visitedCycles: [],
        },
      });
      await Promise.resolve();
    });
    // Highlight MUST still be the q2 result — q1's late arrival was rejected.
    expect(result.current.highlight.nodeIds.has("queue:h:q2")).toBe(true);
    expect(result.current.highlight.edgeIds.has("b:x->q2")).toBe(true);
    expect(result.current.highlight.nodeIds.has("queue:h:q1")).toBe(false);
    expect(result.current.highlight.edgeIds.has("b:x->q1")).toBe(false);
  });

  it("useFocusedNeighborhood — regression: focused-mode subgraph is computed on the WORKER (task 53 responsive-worker-path requirement)", async () => {
    // Task 53 acceptance: focused traversal must route through the worker
    // so a large graph with a deep focus radius doesn't stall the UI frame.
    // Assert `workerClient.pruneNeighborhood` is invoked with the exact
    // input graph AND the focus id AND (task 53) `direction: "both"` so
    // both incoming and outgoing message-flow chains land in the subgraph.
    const focusResult: PruneNeighborhoodResult = {
      nodes: [
        { id: "queue:h:q1", kind: "queue", label: "q1", data: {} },
        { id: "exchange:h:x", kind: "exchange", label: "x", data: {} },
      ],
      edges: [
        { id: "b:x->q1", from: "exchange:h:x", to: "queue:h:q1", kind: "binds", routingKey: "k" },
      ],
      diagnostics: [],
      focusNodeId: "queue:h:q1",
      truncated: false,
      focusMissing: false,
    };
    const pruneMock = vi.fn(async () => focusResult);
    const client = mockClient({ pruneNeighborhood: pruneMock });
    const graphFixture: BuildGraphResult = {
      nodes: focusResult.nodes,
      edges: focusResult.edges,
      diagnostics: [],
    };
    const stableVisibility = createEmptyVisibility();
    const { result } = renderHook(() =>
      useFocusedNeighborhood({
        graph: graphFixture,
        visibility: stableVisibility,
        focusNodeId: "queue:h:q1",
        focusMaxDepth: 3,
        workerClient: client,
      }),
    );
    await waitFor(() => {
      expect(pruneMock).toHaveBeenCalledTimes(1);
      expect(result.current.focused?.focusNodeId).toBe("queue:h:q1");
      expect(result.current.focusLoading).toBe(false);
    });
    // Wire-shape check — worker receives the visibility-applied graph
    // (identical content when visibility is empty), the focus id, AND
    // `direction: "both"` so both incoming and outgoing chains land in
    // the subgraph.
    expect(pruneMock).toHaveBeenCalledTimes(1);
    const [passedGraph, passedFocusId, passedOptions] = pruneMock.mock.calls[0]!;
    expect(passedGraph.nodes).toEqual(graphFixture.nodes);
    expect(passedGraph.edges).toEqual(graphFixture.edges);
    expect(passedFocusId).toBe("queue:h:q1");
    expect(passedOptions).toEqual({ maxDepth: 3, direction: "both" });
    // Precomputed token snapshots the exact input identities so the
    // pipeline can invalidate on same-focus visibility/graph/depth flips.
    expect(result.current.precomputed?.token.graph).toBe(graphFixture);
    expect(result.current.precomputed?.token.focusNodeId).toBe("queue:h:q1");
    expect(result.current.precomputed?.token.focusMaxDepth).toBe(3);
  });

  it("useFocusedNeighborhood — regression: OUT-OF-ORDER focus-result resolution never overwrites a newer focus target (task 53 stale-response protection)", async () => {
    // The failure mode the review specifically called out: search-driven
    // focus flips rapidly (queue A → queue B) while A's worker call is
    // still in flight; B's call resolves FIRST (fast subgraph); A's
    // resolves LATE (slow subgraph). The hook's cancelled-guard must
    // reject A's late arrival so the on-screen focused view keeps pointing
    // at B, not silently regress to the stale A subgraph.
    let resolveA: ((r: PruneNeighborhoodResult) => void) | undefined;
    let resolveB: ((r: PruneNeighborhoodResult) => void) | undefined;
    const graphFixture: BuildGraphResult = {
      nodes: [
        { id: "queue:h:qA", kind: "queue", label: "qA", data: {} },
        { id: "queue:h:qB", kind: "queue", label: "qB", data: {} },
      ],
      edges: [],
      diagnostics: [],
    };
    const pruneMock = vi
      .fn<
        [BuildGraphResult, string, unknown?],
        Promise<PruneNeighborhoodResult>
      >()
      .mockImplementationOnce(
        () =>
          new Promise<PruneNeighborhoodResult>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<PruneNeighborhoodResult>((resolve) => {
            resolveB = resolve;
          }),
      );
    const client = mockClient({ pruneNeighborhood: pruneMock });
    const stableVisibility = createEmptyVisibility();
    const { result, rerender } = renderHook(
      (props: { focusNodeId: string | undefined }) =>
        useFocusedNeighborhood({
          graph: graphFixture,
          visibility: stableVisibility,
          focusNodeId: props.focusNodeId,
          focusMaxDepth: 3,
          workerClient: client,
        }),
      { initialProps: { focusNodeId: undefined as string | undefined } },
    );
    // Focus A — first worker call in flight.
    rerender({ focusNodeId: "queue:h:qA" });
    await waitFor(() => {
      expect(pruneMock).toHaveBeenCalledTimes(1);
      expect(result.current.focusLoading).toBe(true);
    });
    // Rapid switch to B — second worker call in flight. Cancelled guard
    // clears the stale focused state synchronously.
    rerender({ focusNodeId: "queue:h:qB" });
    await waitFor(() => {
      expect(pruneMock).toHaveBeenCalledTimes(2);
    });
    expect(result.current.focused).toBeUndefined();
    expect(result.current.focusLoading).toBe(true);
    // Resolve B FIRST — the hook adopts B's subgraph.
    await act(async () => {
      resolveB?.({
        nodes: [{ id: "queue:h:qB", kind: "queue", label: "qB", data: {} }],
        edges: [],
        diagnostics: [],
        focusNodeId: "queue:h:qB",
        truncated: false,
        focusMissing: false,
      });
    });
    await waitFor(() => {
      expect(result.current.focused?.focusNodeId).toBe("queue:h:qB");
      expect(result.current.focusLoading).toBe(false);
    });
    // Resolve A LATE — cancelled guard MUST reject it so the on-screen
    // focused view keeps pointing at B, not silently regress to the stale
    // A subgraph.
    await act(async () => {
      resolveA?.({
        nodes: [{ id: "queue:h:qA", kind: "queue", label: "qA", data: {} }],
        edges: [],
        diagnostics: [],
        focusNodeId: "queue:h:qA",
        truncated: false,
        focusMissing: false,
      });
      await Promise.resolve();
    });
    // Focused state MUST still be B — A's late arrival was rejected.
    expect(result.current.focused?.focusNodeId).toBe("queue:h:qB");
    expect(result.current.focused?.focusNodeId).not.toBe("queue:h:qA");
  });

  it("useFocusedNeighborhood — same focusNodeId + DIFFERENT visibility re-fires the worker AND emits a precomputed token bound to the NEW visibility (reviewer regression)", async () => {
    // Reviewer's specific failure mode: precomputed accepted based only on
    // `focusNodeId`. Prove the hook invalidates precomputed the moment
    // visibility identity changes, refires the worker, and stamps the new
    // response with a token pointing at the NEW visibility — so the
    // pipeline's token check can reject any stale payload.
    let resolveA: ((r: PruneNeighborhoodResult) => void) | undefined;
    let resolveB: ((r: PruneNeighborhoodResult) => void) | undefined;
    const graphFixture: BuildGraphResult = {
      nodes: [
        { id: "queue:h:q", kind: "queue", label: "q", data: {} },
        { id: "exchange:h:x", kind: "exchange", label: "x", data: {} },
      ],
      edges: [
        { id: "b:x->q", from: "exchange:h:x", to: "queue:h:q", kind: "binds", routingKey: "k" },
      ],
      diagnostics: [],
    };
    const pruneMock = vi
      .fn<
        [BuildGraphResult, string, unknown?],
        Promise<PruneNeighborhoodResult>
      >()
      .mockImplementationOnce(
        () =>
          new Promise<PruneNeighborhoodResult>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<PruneNeighborhoodResult>((resolve) => {
            resolveB = resolve;
          }),
      );
    const client = mockClient({ pruneNeighborhood: pruneMock });
    const visibilityA = createEmptyVisibility();
    const visibilityB = hideNodes(createEmptyVisibility(), ["exchange:h:x"]);
    const { result, rerender } = renderHook(
      (props: { visibility: VisibilityState }) =>
        useFocusedNeighborhood({
          graph: graphFixture,
          visibility: props.visibility,
          focusNodeId: "queue:h:q",
          focusMaxDepth: 3,
          workerClient: client,
        }),
      { initialProps: { visibility: visibilityA } },
    );
    // First worker call fires against visibilityA.
    await waitFor(() => {
      expect(pruneMock).toHaveBeenCalledTimes(1);
    });
    // Resolve A — precomputed lands with a token bound to visibilityA.
    await act(async () => {
      resolveA?.({
        nodes: graphFixture.nodes,
        edges: graphFixture.edges,
        diagnostics: [],
        focusNodeId: "queue:h:q",
        truncated: false,
        focusMissing: false,
      });
    });
    await waitFor(() => {
      expect(result.current.precomputed?.token.visibility).toBe(visibilityA);
    });
    // Visibility flips to B — same focusNodeId. Hook MUST invalidate
    // precomputed synchronously AND refire the worker.
    rerender({ visibility: visibilityB });
    expect(result.current.precomputed).toBeUndefined();
    expect(result.current.focusLoading).toBe(true);
    await waitFor(() => {
      expect(pruneMock).toHaveBeenCalledTimes(2);
    });
    // Resolve B — precomputed lands with a token bound to visibilityB
    // (never visibilityA).
    await act(async () => {
      resolveB?.({
        nodes: [{ id: "queue:h:q", kind: "queue", label: "q", data: {} }],
        edges: [],
        diagnostics: [],
        focusNodeId: "queue:h:q",
        truncated: false,
        focusMissing: false,
      });
    });
    await waitFor(() => {
      expect(result.current.precomputed?.token.visibility).toBe(visibilityB);
      expect(result.current.precomputed?.token.visibility).not.toBe(visibilityA);
    });
  });

  it("useFocusedNeighborhood — same focusNodeId + DIFFERENT focusMaxDepth re-fires the worker with the new depth (reviewer regression)", async () => {
    const graphFixture: BuildGraphResult = {
      nodes: [{ id: "queue:h:q", kind: "queue", label: "q", data: {} }],
      edges: [],
      diagnostics: [],
    };
    const pruneMock = vi.fn(async (_input, focusNodeId: string) => ({
      nodes: [],
      edges: [],
      diagnostics: [],
      focusNodeId,
      truncated: false,
      focusMissing: false,
    }));
    const client = mockClient({ pruneNeighborhood: pruneMock });
    const visibility = createEmptyVisibility();
    const { result, rerender } = renderHook(
      (props: { depth: number }) =>
        useFocusedNeighborhood({
          graph: graphFixture,
          visibility,
          focusNodeId: "queue:h:q",
          focusMaxDepth: props.depth,
          workerClient: client,
        }),
      { initialProps: { depth: 3 } },
    );
    await waitFor(() => {
      expect(result.current.precomputed?.token.focusMaxDepth).toBe(3);
    });
    rerender({ depth: 5 });
    await waitFor(() => {
      expect(pruneMock).toHaveBeenCalledTimes(2);
      expect(result.current.precomputed?.token.focusMaxDepth).toBe(5);
    });
    const lastCall = pruneMock.mock.calls.at(-1)!;
    expect(lastCall[2]).toEqual({ maxDepth: 5, direction: "both" });
  });

  it("useFocusedNeighborhood — worker rejection surfaces an actionable focusError with the thrown message AND clears focusLoading (reviewer regression: no permanent pending banner)", async () => {
    const client = mockClient({
      pruneNeighborhood: vi.fn(async () => {
        throw new Error("worker exploded");
      }),
    });
    const graphFixture: BuildGraphResult = {
      nodes: [{ id: "queue:h:q", kind: "queue", label: "q", data: {} }],
      edges: [],
      diagnostics: [],
    };
    const stableVisibility = createEmptyVisibility();
    const { result } = renderHook(() =>
      useFocusedNeighborhood({
        graph: graphFixture,
        visibility: stableVisibility,
        focusNodeId: "queue:h:q",
        focusMaxDepth: 3,
        workerClient: client,
      }),
    );
    // After the worker rejects: focusLoading MUST fall to false (not stay
    // true forever) AND focusError MUST expose the thrown message so the
    // UI can render an actionable failure banner instead of an indefinite
    // "computing…" state.
    await waitFor(() => {
      expect(result.current.focusLoading).toBe(false);
      expect(result.current.focusError).toBe("worker exploded");
    });
    expect(result.current.focused).toBeUndefined();
    expect(result.current.precomputed).toBeUndefined();
  });

  it("useFocusedNeighborhood — retryFocus refires the worker for the SAME focusNodeId after a rejection AND clears the error on success (reviewer recovery-path regression)", async () => {
    let attempt = 0;
    const pruneMock = vi.fn(async (_input, focusNodeId: string) => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient worker failure");
      return {
        nodes: [{ id: focusNodeId, kind: "queue" as const, label: "q", data: {} }],
        edges: [],
        diagnostics: [],
        focusNodeId,
        truncated: false,
        focusMissing: false,
      };
    });
    const client = mockClient({ pruneNeighborhood: pruneMock });
    const graphFixture: BuildGraphResult = {
      nodes: [{ id: "queue:h:q", kind: "queue", label: "q", data: {} }],
      edges: [],
      diagnostics: [],
    };
    const stableVisibility = createEmptyVisibility();
    const { result } = renderHook(() =>
      useFocusedNeighborhood({
        graph: graphFixture,
        visibility: stableVisibility,
        focusNodeId: "queue:h:q",
        focusMaxDepth: 3,
        workerClient: client,
      }),
    );
    // First attempt rejects — error surfaces.
    await waitFor(() => {
      expect(result.current.focusError).toBe("transient worker failure");
      expect(result.current.focusLoading).toBe(false);
    });
    // Operator hits Retry → hook re-fires worker for the SAME focus,
    // clears error while pending, and adopts the second attempt's success
    // subgraph. Precomputed lands with the current focus id.
    await act(async () => {
      result.current.retryFocus();
    });
    await waitFor(() => {
      expect(pruneMock).toHaveBeenCalledTimes(2);
      expect(result.current.focusError).toBeUndefined();
      expect(result.current.focusLoading).toBe(false);
      expect(result.current.precomputed?.result.focusNodeId).toBe("queue:h:q");
    });
  });

  it("useFocusedNeighborhood — non-Error rejection (e.g. a plain string) still surfaces a human-readable focusError (defensive coverage)", async () => {
    const client = mockClient({
      pruneNeighborhood: vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "postMessage aborted";
      }),
    });
    const graphFixture: BuildGraphResult = {
      nodes: [{ id: "queue:h:q", kind: "queue", label: "q", data: {} }],
      edges: [],
      diagnostics: [],
    };
    const stableVisibility = createEmptyVisibility();
    const { result } = renderHook(() =>
      useFocusedNeighborhood({
        graph: graphFixture,
        visibility: stableVisibility,
        focusNodeId: "queue:h:q",
        workerClient: client,
      }),
    );
    await waitFor(() => {
      expect(result.current.focusError).toBe("postMessage aborted");
      expect(result.current.focusLoading).toBe(false);
    });
  });

  it("useFocusedNeighborhood — clearing the focus target drops the previous subgraph (regression: stale focus never lingers)", async () => {
    const client = mockClient();
    const graphFixture: BuildGraphResult = {
      nodes: [{ id: "queue:h:q", kind: "queue", label: "q", data: {} }],
      edges: [],
      diagnostics: [],
    };
    const stableVisibility = createEmptyVisibility();
    const { result, rerender } = renderHook(
      (props: { focusNodeId: string | undefined }) =>
        useFocusedNeighborhood({
          graph: graphFixture,
          visibility: stableVisibility,
          focusNodeId: props.focusNodeId,
          workerClient: client,
        }),
      { initialProps: { focusNodeId: "queue:h:q" as string | undefined } },
    );
    await waitFor(() => {
      expect(result.current.focused?.focusNodeId).toBe("queue:h:q");
    });
    rerender({ focusNodeId: undefined });
    await waitFor(() => {
      expect(result.current.focused).toBeUndefined();
      expect(result.current.focusLoading).toBe(false);
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
