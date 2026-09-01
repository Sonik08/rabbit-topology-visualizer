import { useEffect, useMemo, useState } from "react";
import type { BuildGraphResult } from "../../core/graph/buildGraph";
import { applyGraphFilters } from "../../core/graph/filterGraph";
import type { GraphNode } from "../../core/model";
import type { BidirectionalTraversalResult } from "../../core/graph/traversal";
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
