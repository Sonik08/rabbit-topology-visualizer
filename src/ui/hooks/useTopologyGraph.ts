import { useCallback, useEffect, useMemo, useState } from "react";
import type { BuildGraphResult } from "../../core/graph/buildGraph";
import { applyGraphFilters } from "../../core/graph/filterGraph";
import type { GraphNode } from "../../core/model";
import type { BidirectionalTraversalResult } from "../../core/graph/traversal";
import type { PruneNeighborhoodResult } from "../../core/graph/pruneNeighborhood";
import {
  applyVisibility,
  type VisibilityState,
} from "../../core/graph/visibility";
import {
  bidirectionalHighlightFromTraversal,
  type BidirectionalHighlight,
} from "../../core/graph/upstreamHighlight";
import { aggregateImportedTopology } from "../../core/import";
import type {
  ImportArchiveWorkerClient,
  ImportResult,
} from "../../core/import";
import { toGraphFilters, type FilterState } from "../components/TopologyFiltersPanel";
import type { PrecomputedFocused } from "../components/topologyRenderPipeline";

const EMPTY_GRAPH: BuildGraphResult = { nodes: [], edges: [], diagnostics: [] };
const EMPTY_HIGHLIGHT: BidirectionalHighlight = {
  nodeIds: new Set(),
  edgeIds: new Set(),
  incomingCount: 0,
  outgoingCount: 0,
  truncated: false,
};

// Kinds the selection highlight actually resolves against — matches the
// worker-side supported-kind set in `bidirectionalForNode`. UI selection of
// a host/vhost/external node is a safe no-op (empty highlight) so those are
// intentionally excluded.
const SELECTION_SUPPORTED_KINDS: ReadonlySet<GraphNode["kind"]> = new Set<
  GraphNode["kind"]
>(["queue", "exchange", "shovel", "federation"]);

export interface UseTopologyGraphInput {
  result: ImportResult;
  filters: FilterState;
  selectedNodeId: string | undefined;
  workerClient: ImportArchiveWorkerClient;
}

export interface UseTopologyGraphState {
  /** Unfiltered graph produced by the worker's `buildGraph`. */
  rawGraph: BuildGraphResult;
  /** `rawGraph` after `applyGraphFilters` (synchronous, main-thread). */
  graph: BuildGraphResult;
  /**
   * Async highlight for the selected node — computed via a single
   * bidirectional worker traversal that unions the upstream ancestry and
   * downstream reach of the target node. `nodeIds`/`edgeIds` remain the
   * combined highlight set the renderer already dimmed against; the
   * `upstream`/`downstream` fields expose the per-direction traversal for
   * summary bars and the dual-section path panel.
   */
  highlight: BidirectionalHighlight;
  /** True while the worker is computing `buildGraph` for the current result. */
  buildLoading: boolean;
  /** True while the worker is computing the traversal for the current selection. */
  highlightLoading: boolean;
  /** Selected node from the un-filtered graph so details survive filter hides. */
  selectedNode: GraphNode | undefined;
}

/**
 * Off-main-thread topology hook — the entire heavy pipeline runs through the
 * shared Web Worker client:
 *   1. `workerClient.buildGraph(aggregatedTopology)` produces `rawGraph`.
 *   2. `applyGraphFilters` runs synchronously on the main thread because it
 *      is cheap and needs to react to filter checkboxes instantly.
 *   3. `workerClient.upstreamForQueue` / `upstreamForExchange` compute the
 *      traversal for the selected node; the resulting highlight is built
 *      locally with `highlightFromTraversal`.
 *
 * Each async call cancels its predecessor via a local `cancelled` flag so a
 * fast follow-up selection or filter change never resolves stale state onto
 * the component. The hook always returns a usable shape (empty defaults)
 * while work is in flight, so the UI never renders `undefined`.
 */
export function useTopologyGraph({
  result,
  filters,
  selectedNodeId,
  workerClient,
}: UseTopologyGraphInput): UseTopologyGraphState {
  const [rawGraph, setRawGraph] = useState<BuildGraphResult>(EMPTY_GRAPH);
  const [buildLoading, setBuildLoading] = useState(false);
  const [highlight, setHighlight] = useState<BidirectionalHighlight>(EMPTY_HIGHLIGHT);
  const [highlightLoading, setHighlightLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Immediately clear the old topology so the UI never renders a stale
    // graph from the previous `result` while the new one is being built —
    // without this, the previous import's nodes/edges would remain visible
    // (and traversable) until the deferred worker.buildGraph resolved or
    // rejected. Also clear any lingering highlight so a previously-selected
    // node from the old topology can't shine through onto the new one.
    setRawGraph(EMPTY_GRAPH);
    setHighlight(EMPTY_HIGHLIGHT);
    setHighlightLoading(false);
    setBuildLoading(true);
    const aggregated = aggregateImportedTopology(result);
    workerClient
      .buildGraph(aggregated)
      .then((next) => {
        if (cancelled) return;
        setRawGraph(next);
      })
      .catch(() => {
        if (cancelled) return;
        // Fallback to an empty graph rather than crashing the UI. The worker
        // client already surfaced the failure to any awaiter; here we just
        // avoid rendering a stale graph from a previous result.
        setRawGraph(EMPTY_GRAPH);
      })
      .finally(() => {
        if (!cancelled) setBuildLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [result, workerClient]);

  const graph = useMemo(
    () => applyGraphFilters(rawGraph, toGraphFilters(filters)),
    [rawGraph, filters],
  );

  const selectedNode = useMemo(
    () => (selectedNodeId ? rawGraph.nodes.find((n) => n.id === selectedNodeId) : undefined),
    [rawGraph, selectedNodeId],
  );

  useEffect(() => {
    if (!selectedNodeId) {
      setHighlight(EMPTY_HIGHLIGHT);
      setHighlightLoading(false);
      return;
    }
    const target = graph.nodes.find((n) => n.id === selectedNodeId);
    if (!target || !SELECTION_SUPPORTED_KINDS.has(target.kind)) {
      setHighlight(EMPTY_HIGHLIGHT);
      setHighlightLoading(false);
      return;
    }
    let cancelled = false;
    // Clear the previous highlight synchronously the moment a new traversal
    // starts. Without this, a stale highlight from the prior selection/filter
    // would remain rendered on the graph until the worker resolves or
    // rejects — even though the underlying selection has already changed.
    setHighlight(EMPTY_HIGHLIGHT);
    setHighlightLoading(true);
    const traversalOptions = { maxDepth: filters.maxDepth };
    const input = { nodes: graph.nodes, edges: graph.edges };
    const traversalPromise: Promise<BidirectionalTraversalResult> =
      workerClient.bidirectionalForNode(input, selectedNodeId, traversalOptions);
    traversalPromise
      .then((traversal) => {
        if (cancelled) return;
        setHighlight(bidirectionalHighlightFromTraversal(input, traversal));
      })
      .catch(() => {
        if (cancelled) return;
        setHighlight(EMPTY_HIGHLIGHT);
      })
      .finally(() => {
        if (!cancelled) setHighlightLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [graph, selectedNodeId, filters.maxDepth, workerClient]);

  return { rawGraph, graph, highlight, buildLoading, highlightLoading, selectedNode };
}

/**
 * Off-main-thread focused-mode subgraph hook. Takes the same `graph` +
 * `visibility` the pipeline consumes, applies visibility once to feed the
 * worker (a hidden mid-chain node cannot be resurrected by the focused-mode
 * subgraph — the worker sees the already-reduced graph), and stamps the
 * result with a token capturing the exact input identities so
 * `composeFocusedTopology` can reject the payload the moment any of those
 * inputs shifts (visibility toggle, filter rebuild, depth change, focus
 * target change).
 *
 * Cancelled-flag guard drops late-arriving responses when any input changes
 * rapidly (search → search → search, visibility toggle → toggle → toggle):
 * a stale response from an earlier request cannot overwrite the state after
 * a newer request has already been made. Combined with the pipeline's token
 * check this gives BOTH out-of-order stale-response protection AND
 * same-focus-different-visibility stale-render protection — the failure
 * modes the reviewer specifically called out.
 */
export interface UseFocusedNeighborhoodInput {
  /** Post-filter graph — the same reference the pipeline receives. */
  graph: BuildGraphResult;
  /** Visibility overlay state — the same reference the pipeline receives. */
  visibility: VisibilityState;
  focusNodeId: string | undefined;
  focusMaxDepth?: number;
  workerClient: ImportArchiveWorkerClient;
}

export interface UseFocusedNeighborhoodState {
  focused: PruneNeighborhoodResult | undefined;
  focusLoading: boolean;
  /**
   * Human-readable error message when the worker's `pruneNeighborhood`
   * call rejected. `undefined` while the call is pending or succeeded.
   * Callers should surface this alongside a `retryFocus` action so the
   * user has a recovery path instead of a permanently-pending banner.
   */
  focusError: string | undefined;
  /**
   * Idempotent retry action: reruns the worker call for the CURRENT
   * `focusNodeId` (no-op when focus is off). Callers wire this to a
   * "Retry" button in the error banner so the operator has an explicit
   * recovery path without needing to toggle the focus or reload the
   * page.
   */
  retryFocus: () => void;
  /**
   * Bundle to hand to `composeFocusedTopology` as `precomputedFocused`. The
   * token embedded here matches the inputs the worker actually saw, so the
   * pipeline can reject it whenever the current inputs have drifted.
   */
  precomputed: PrecomputedFocused | undefined;
}

export function useFocusedNeighborhood({
  graph,
  visibility,
  focusNodeId,
  focusMaxDepth,
  workerClient,
}: UseFocusedNeighborhoodInput): UseFocusedNeighborhoodState {
  const [precomputed, setPrecomputed] = useState<PrecomputedFocused | undefined>(undefined);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusError, setFocusError] = useState<string | undefined>(undefined);
  // Manual-retry epoch — bumped by `retryFocus` to force the effect to
  // re-fire the worker without needing the operator to toggle the focus
  // target off/on. Any other input change (graph/visibility/depth/focus)
  // already re-fires the effect, so this only matters for the
  // same-inputs-refresh-after-error path.
  const [retryEpoch, setRetryEpoch] = useState(0);
  const retryFocus = useCallback(() => {
    setRetryEpoch((prev) => prev + 1);
  }, []);
  useEffect(() => {
    if (!focusNodeId) {
      setPrecomputed(undefined);
      setFocusLoading(false);
      setFocusError(undefined);
      return;
    }
    let cancelled = false;
    // Synchronously clear a stale precomputed result the moment ANY input
    // changes — same-focus visibility/graph/depth flips must invalidate the
    // previous payload just as aggressively as a focus-target change.
    // Without this, the pipeline would render the stale payload for one
    // frame until the worker resolved. (The pipeline's token check is the
    // structural backstop; this clear is the fast path.)
    setPrecomputed(undefined);
    setFocusError(undefined);
    setFocusLoading(true);
    const visible = applyVisibility(graph, visibility);
    const visibleGraph: BuildGraphResult = {
      nodes: visible.nodes,
      edges: visible.edges,
      diagnostics: visible.diagnostics,
    };
    workerClient
      .pruneNeighborhood(visibleGraph, focusNodeId, {
        maxDepth: focusMaxDepth,
        direction: "both",
      })
      .then((result) => {
        if (cancelled) return;
        setPrecomputed({
          result,
          token: { graph, visibility, focusNodeId, focusMaxDepth },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Surface a human-readable error message alongside a cleared
        // precomputed so the caller can render an explicit failure banner
        // with a Retry action — task requirement is an actionable
        // unresolved/failure state, not an indefinite pending banner.
        setPrecomputed(undefined);
        setFocusError(extractErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setFocusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [graph, visibility, focusNodeId, focusMaxDepth, workerClient, retryEpoch]);
  return {
    focused: precomputed?.result,
    focusLoading,
    focusError,
    retryFocus,
    precomputed,
  };
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  return "Focus subgraph computation failed.";
}
