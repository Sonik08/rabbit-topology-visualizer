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
 *   2. `pruneNeighborhood` — focused-mode clip AFTER visibility, so a
 *      hidden node cannot reappear in the focused view.
 *   3. The `renderInput` returned here is what the caller hands to
 *      `toReactFlowElements`.
 */
export interface ComposeFocusedTopologyInput {
  /** Post-filter graph — the value `useTopologyGraph` exposes as `graph`. */
  graph: BuildGraphResult;
  /** Visibility overlay state driven by the visibility panel. */
  visibility: VisibilityState;
  /** When set, activates focused-mode clipping. */
  focusNodeId?: string;
  /** Passed to `pruneNeighborhood`; defaults to its own default (3). */
  focusMaxDepth?: number;
}

export interface ComposeFocusedTopologyResult {
  /** Result of the visibility overlay pass. */
  visible: ApplyVisibilityResult;
  /** `pruneNeighborhood` result when focused mode is active; `undefined` otherwise. */
  focused: PruneNeighborhoodResult | undefined;
  /**
   * Graph the caller should hand to `toReactFlowElements`. Equals `focused`
   * when focused mode is active, otherwise a plain view of `visible`.
   */
  renderInput: BuildGraphResult;
}

export function composeFocusedTopology(
  input: ComposeFocusedTopologyInput,
): ComposeFocusedTopologyResult {
  const visible = applyVisibility(input.graph, input.visibility);
  const focused = input.focusNodeId
    ? pruneNeighborhood(
        {
          nodes: visible.nodes,
          edges: visible.edges,
          diagnostics: visible.diagnostics,
        },
        input.focusNodeId,
        { maxDepth: input.focusMaxDepth, direction: "both" },
      )
    : undefined;
  const renderInput: BuildGraphResult = focused ?? {
    nodes: visible.nodes,
    edges: visible.edges,
    diagnostics: visible.diagnostics,
  };
  return { visible, focused, renderInput };
}
