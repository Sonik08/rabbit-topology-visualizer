import type { BuildGraphResult } from "../../core/graph/buildGraph";
import {
  applyVisibility,
  type ApplyVisibilityResult,
  type VisibilityState,
} from "../../core/graph/visibility";
import {
  pruneNeighborhood,
  type PruneNeighborhoodResult,
} from "../../core/graph/pruneNeighborhood";

/**
 * Shared post-filter render pipeline used by `TopologyGraphCanvas` and
 * pipeline-composition tests. Extracting this composition here (instead of
 * inlining it in the canvas render body) means any reordering or bypass in
 * the canvas's own wiring shows up as a test failure — the tests call the
 * exact same function the canvas does.
 *
 * Order — fixed by the acceptance rule "focused view never resurrects
 * entities the operator has already excluded":
 *   1. `applyVisibility` — main-thread deny-list overlay over the already-
 *      filtered `graph` (filters run inside `useTopologyGraph`).
 *   2. Focused-mode clip AFTER visibility, so a hidden node cannot reappear
 *      in the focused view. In production this clip is precomputed off-
 *      thread by `workerClient.pruneNeighborhood` (via
 *      `useFocusedNeighborhood`) and handed to the pipeline as
 *      `precomputedFocused`; the pipeline only accepts the precomputed
 *      result when its `token` matches ALL of the current pipeline inputs
 *      (`graph`, `visibility`, `focusNodeId`, `focusMaxDepth`) by object
 *      identity — so a same-`focusNodeId` change to any other input (a
 *      visibility toggle, a filter that rebuilds `graph`, or a depth
 *      change) invalidates the precomputed result instead of rendering a
 *      stale subgraph.
 *   3. When focused mode is active but no matching precomputed exists and
 *      `syncFallback` is off, the pipeline returns `focusPending: true`
 *      with an empty focused subgraph so the caller renders an explicit
 *      loading state rather than running the expensive traversal on the
 *      main thread. Tests may opt into the synchronous fallback to
 *      exercise the clip logic without wiring a worker mock.
 *   4. The `renderInput` returned here is what the caller hands to
 *      `toReactFlowElements`.
 */
export interface FocusRequestToken {
  /** Same object reference the pipeline consumed when the worker fired. */
  graph: BuildGraphResult;
  /** Same object reference the pipeline consumed when the worker fired. */
  visibility: VisibilityState;
  /** Focus node id at the time of the worker request. */
  focusNodeId: string;
  /** Focus max depth at the time of the worker request. */
  focusMaxDepth: number | undefined;
}

export interface PrecomputedFocused {
  result: PruneNeighborhoodResult;
  /**
   * Snapshot of the inputs the worker actually saw. All four fields MUST
   * match the pipeline's current inputs by identity for the result to be
   * trusted — otherwise the payload is stale (visibility changed, filter
   * rebuilt the graph, depth changed, or the focus target changed).
   */
  token: FocusRequestToken;
}

export interface ComposeFocusedTopologyInput {
  /** Post-filter graph — the value `useTopologyGraph` exposes as `graph`. */
  graph: BuildGraphResult;
  /** Visibility overlay state driven by the visibility panel. */
  visibility: VisibilityState;
  /** When set, activates focused-mode clipping. */
  focusNodeId?: string;
  /** Passed to `pruneNeighborhood`; defaults to its own default (3). */
  focusMaxDepth?: number;
  /**
   * Precomputed focused-neighborhood result produced off-thread by
   * `workerClient.pruneNeighborhood`. Only trusted when its `token`
   * matches ALL of `graph`, `visibility`, `focusNodeId`, `focusMaxDepth`
   * by identity; any mismatch means the payload is stale and the pipeline
   * falls into the pending state (or the sync fallback, if opted into).
   */
  precomputedFocused?: PrecomputedFocused;
  /**
   * When true, the pipeline falls back to synchronous `pruneNeighborhood`
   * when no matching precomputed result exists. Default false — production
   * canvas leaves this off so the expensive traversal never blocks the
   * main thread; tests may opt in to exercise the clip logic without
   * wiring a worker mock.
   */
  syncFallback?: boolean;
}

export interface ComposeFocusedTopologyResult {
  /** Result of the visibility overlay pass. */
  visible: ApplyVisibilityResult;
  /** Focused-mode result when focused mode is active; `undefined` otherwise. */
  focused: PruneNeighborhoodResult | undefined;
  /**
   * True when focused mode is active but no matching precomputed result
   * exists and `syncFallback` is off. Callers should render an explicit
   * "computing focus subgraph…" loading state — the pipeline's `focused`
   * subgraph is empty in that case (so a stale visible-graph payload is
   * never rendered as if the focus were satisfied).
   */
  focusPending: boolean;
  /**
   * Graph the caller should hand to `toReactFlowElements`. Equals `focused`
   * when focused mode is active (including when pending, in which case it
   * is an empty subgraph), otherwise a plain view of `visible`.
   */
  renderInput: BuildGraphResult;
}

export function composeFocusedTopology(
  input: ComposeFocusedTopologyInput,
): ComposeFocusedTopologyResult {
  const visible = applyVisibility(input.graph, input.visibility);
  const visibleAsGraph: BuildGraphResult = {
    nodes: visible.nodes,
    edges: visible.edges,
    diagnostics: visible.diagnostics,
  };

  if (!input.focusNodeId) {
    return {
      visible,
      focused: undefined,
      focusPending: false,
      renderInput: visibleAsGraph,
    };
  }

  const precomputed = input.precomputedFocused;
  const precomputedMatches =
    precomputed !== undefined &&
    precomputed.token.graph === input.graph &&
    precomputed.token.visibility === input.visibility &&
    precomputed.token.focusNodeId === input.focusNodeId &&
    precomputed.token.focusMaxDepth === input.focusMaxDepth;

  if (precomputedMatches) {
    return {
      visible,
      focused: precomputed!.result,
      focusPending: false,
      renderInput: precomputed!.result,
    };
  }

  if (input.syncFallback === true) {
    const focused = pruneNeighborhood(visibleAsGraph, input.focusNodeId, {
      maxDepth: input.focusMaxDepth,
      direction: "both",
    });
    return {
      visible,
      focused,
      focusPending: false,
      renderInput: focused,
    };
  }

  // Pending: focused mode is active but the worker hasn't produced a
  // matching result yet (either the request is in flight, the previous
  // result was invalidated by an input change, or the worker failed).
  // Return an empty focused subgraph so the caller renders a loading
  // state instead of the pre-focus visible graph. `focusMissing` stays
  // `false` because we do not know yet whether the focus id exists — the
  // caller distinguishes "computing" from "not in graph" via
  // `focusPending`.
  const pendingFocused: PruneNeighborhoodResult = {
    nodes: [],
    edges: [],
    diagnostics: visible.diagnostics,
    focusNodeId: input.focusNodeId,
    focusMissing: false,
    truncated: false,
  };
  return {
    visible,
    focused: pendingFocused,
    focusPending: true,
    renderInput: pendingFocused,
  };
}
