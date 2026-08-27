import type { BuildGraphResult } from "./buildGraph";
import type { GraphEdge, GraphNode } from "../model";
import { pruneNeighborhood, type NeighborhoodDirection } from "./pruneNeighborhood";

/**
 * User-facing visibility overrides applied on top of the filtered topology
 * graph. Modelled as a reversible state so nothing gets destroyed — every
 * "hide" is undoable by removing the id from `hiddenNodeIds` (or by clearing
 * `isolatedFocus`), and the underlying imported topology is left untouched.
 *
 * Two independent axes:
 *   - `hiddenNodeIds` — an explicit deny-list; every id here is dropped from
 *     the rendered graph plus every edge incident to it (no dangling edges
 *     ever leak through).
 *   - `isolatedFocus` — an opt-in allow-list keyed by a single node id. When
 *     set, only that node plus its `neighborhoodDepth`-hop
 *     `direction`-restricted neighborhood survives; every other node is
 *     rendered hidden. `hiddenNodeIds` is still respected on top of the
 *     isolation set so users can further prune within a neighborhood.
 */
export interface VisibilityState {
  hiddenNodeIds: ReadonlySet<string>;
  isolatedFocus?: {
    focusNodeId: string;
    /** Default 3 — matches `pruneNeighborhood`'s default. */
    depth?: number;
    /** Default `both` — matches `pruneNeighborhood`'s default. */
    direction?: NeighborhoodDirection;
  };
}

export interface VisibilityCounts {
  visibleNodes: number;
  totalNodes: number;
  visibleEdges: number;
  totalEdges: number;
  hiddenNodeCount: number;
}

export interface ApplyVisibilityResult extends BuildGraphResult {
  counts: VisibilityCounts;
  /**
   * The full list of hidden ids AFTER applying isolation (i.e. `hiddenNodeIds`
   * ∪ "everyone not in the isolated neighborhood"). Useful for a UI panel
   * that wants to show a "restore one of these" list.
   */
  effectivelyHidden: ReadonlySet<string>;
}

export function createEmptyVisibility(): VisibilityState {
  return { hiddenNodeIds: new Set() };
}

/**
 * Toggle a single node in the deny-list, returning a fresh `VisibilityState`.
 * Never mutates the input — safe to use as a React state reducer.
 */
export function toggleHiddenNode(
  state: VisibilityState,
  nodeId: string,
): VisibilityState {
  const next = new Set(state.hiddenNodeIds);
  if (next.has(nodeId)) next.delete(nodeId);
  else next.add(nodeId);
  return { ...state, hiddenNodeIds: next };
}

export function hideNodes(
  state: VisibilityState,
  nodeIds: Iterable<string>,
): VisibilityState {
  const next = new Set(state.hiddenNodeIds);
  for (const id of nodeIds) next.add(id);
  return { ...state, hiddenNodeIds: next };
}

export function showNodes(
  state: VisibilityState,
  nodeIds: Iterable<string>,
): VisibilityState {
  const next = new Set(state.hiddenNodeIds);
  for (const id of nodeIds) next.delete(id);
  return { ...state, hiddenNodeIds: next };
}

/**
 * Force one or more nodes back to visible from ANY source of hiding —
 * whether they were on the explicit `hiddenNodeIds` deny-list or hidden
 * implicitly because a `isolatedFocus` neighborhood excluded them.
 *
 * If the id is in `hiddenNodeIds`, it is removed (identical to `showNodes`).
 * If ANY of the requested ids is currently isolation-hidden, `isolatedFocus`
 * is cleared entirely — there is no per-id way to widen a neighborhood
 * without changing what "isolation" means, so the least-surprising behaviour
 * is to fall back to the un-isolated view (still respecting the remaining
 * explicit deny-list). Callers should read `applyVisibility(...).effectivelyHidden`
 * to decide when to invoke this helper.
 */
export function restoreNodes(
  graph: BuildGraphResult,
  state: VisibilityState,
  nodeIds: Iterable<string>,
): VisibilityState {
  const targetIds = new Set(nodeIds);
  const hiddenNodeIds = new Set(state.hiddenNodeIds);
  for (const id of targetIds) hiddenNodeIds.delete(id);
  if (!state.isolatedFocus) {
    return { ...state, hiddenNodeIds };
  }
  // Determine whether any target id is currently isolation-hidden. If so,
  // clear the isolation focus so those nodes render again.
  const visibleUnderIsolation = new Set(
    pruneNeighborhood(graph, state.isolatedFocus.focusNodeId, {
      maxDepth: state.isolatedFocus.depth,
      direction: state.isolatedFocus.direction,
    }).nodes.map((n) => n.id),
  );
  let clearsIsolation = false;
  for (const id of targetIds) {
    if (!visibleUnderIsolation.has(id)) {
      clearsIsolation = true;
      break;
    }
  }
  if (clearsIsolation) {
    const { isolatedFocus, ...rest } = state;
    void isolatedFocus;
    return { ...rest, hiddenNodeIds };
  }
  return { ...state, hiddenNodeIds };
}

export function resetVisibility(): VisibilityState {
  return createEmptyVisibility();
}

export function isolateNeighborhood(
  state: VisibilityState,
  focusNodeId: string,
  options: { depth?: number; direction?: NeighborhoodDirection } = {},
): VisibilityState {
  return {
    ...state,
    isolatedFocus: {
      focusNodeId,
      depth: options.depth,
      direction: options.direction,
    },
  };
}

export function clearIsolation(state: VisibilityState): VisibilityState {
  const { isolatedFocus, ...rest } = state;
  void isolatedFocus;
  return rest;
}

/**
 * Applies a visibility state to a graph.
 *   1. If `isolatedFocus` is set, compute the neighborhood via
 *      `pruneNeighborhood` — only nodes inside that neighborhood are
 *      candidates for visibility.
 *   2. Then apply `hiddenNodeIds` on top: any id in the set is dropped even
 *      if it survived isolation.
 *   3. Every edge whose endpoints are no longer both visible is dropped —
 *      no dangling edges reach the renderer.
 *
 * Returns visible-vs-total counts so a UI can render `12 / 340 nodes`
 * summaries, plus the full effective deny-list so a "hidden items" panel can
 * offer per-id restore actions.
 */
export function applyVisibility(
  graph: BuildGraphResult,
  state: VisibilityState,
): ApplyVisibilityResult {
  const totalNodes = graph.nodes.length;
  const totalEdges = graph.edges.length;

  let candidateNodeIds: Set<string>;
  if (state.isolatedFocus) {
    const pruned = pruneNeighborhood(graph, state.isolatedFocus.focusNodeId, {
      maxDepth: state.isolatedFocus.depth,
      direction: state.isolatedFocus.direction,
    });
    candidateNodeIds = new Set(pruned.nodes.map((n) => n.id));
    if (candidateNodeIds.size === 0) {
      // Isolation focus id not found — degrade gracefully to no isolation so
      // the graph doesn't disappear entirely on a stale selection.
      candidateNodeIds = new Set(graph.nodes.map((n) => n.id));
    }
  } else {
    candidateNodeIds = new Set(graph.nodes.map((n) => n.id));
  }

  const visibleNodeIds = new Set<string>();
  for (const id of candidateNodeIds) {
    if (state.hiddenNodeIds.has(id)) continue;
    visibleNodeIds.add(id);
  }

  const nodes: GraphNode[] = [];
  for (const n of graph.nodes) if (visibleNodeIds.has(n.id)) nodes.push(n);
  const edges: GraphEdge[] = [];
  for (const e of graph.edges) {
    if (!visibleNodeIds.has(e.from) || !visibleNodeIds.has(e.to)) continue;
    edges.push(e);
  }

  // The effective deny-list is every id NOT in `visibleNodeIds`, so a UI can
  // enumerate "these are hidden right now, click to restore".
  const effectivelyHidden = new Set<string>();
  for (const n of graph.nodes) {
    if (!visibleNodeIds.has(n.id)) effectivelyHidden.add(n.id);
  }

  return {
    nodes,
    edges,
    diagnostics: graph.diagnostics,
    counts: {
      visibleNodes: nodes.length,
      totalNodes,
      visibleEdges: edges.length,
      totalEdges,
      hiddenNodeCount: effectivelyHidden.size,
    },
    effectivelyHidden,
  };
}
