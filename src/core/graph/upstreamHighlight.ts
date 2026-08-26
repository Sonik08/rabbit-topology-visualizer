import type { GraphEdge, GraphEdgeKind, GraphNode } from "../model";
import {
  traverseUpstream,
  type UpstreamGraphInput,
  type UpstreamTraversalOptions,
  type UpstreamTraversalResult,
} from "./traversal";

export interface UpstreamHighlight {
  /** The node the user selected. Empty when the id is missing or unsupported. */
  targetNodeId?: string;
  /** All node ids that participate in the upstream ancestry (includes the target). */
  nodeIds: Set<string>;
  /**
   * Every routing edge whose endpoints are both in `nodeIds`. Includes each
   * shortest-path edge from the traversal PLUS parallel branches (diamond
   * bindings, multiple shovels, alternate-exchange short-circuits) so no
   * highlighted ancestor is left visually orphaned behind dimmed edges.
   */
  edgeIds: Set<string>;
  /** Raw traversal result for callers that want to build a details/path panel. */
  traversal?: UpstreamTraversalResult;
}

/**
 * Fresh empty highlight per call — never share mutable Set instances across
 * callers, otherwise a caller that mutates the returned sets would corrupt
 * later results.
 */
function emptyHighlight(): UpstreamHighlight {
  return { nodeIds: new Set(), edgeIds: new Set() };
}

const ROUTING_EDGE_KINDS: ReadonlySet<GraphEdgeKind> = new Set([
  "binds",
  "routes",
  "alternate-exchange",
  "shovels",
  "federates",
]);

/**
 * Compute the highlight sets for a selected queue or exchange node. Returns
 * empty sets when the node is missing, or when the node kind is not one of
 * the two traversal entry points.
 *
 * The returned edge id set includes every routing edge whose endpoints both
 * lie in the highlighted node set — not just the single shortest-path edge
 * per ancestor. This is deliberate: `traverseUpstream` picks one representative
 * path per source, but a diamond (e.g. exchange A → exchange B via two
 * bindings, both landing on the same queue) leaves intermediate ancestors
 * highlighted while the parallel edges connecting them would otherwise be
 * dimmed, making the ancestor look orphaned.
 */
export function computeUpstreamHighlight(
  input: UpstreamGraphInput,
  targetNodeId: string | undefined,
  options: UpstreamTraversalOptions = {},
): UpstreamHighlight {
  if (!targetNodeId) return emptyHighlight();
  const target = findNode(input.nodes, targetNodeId);
  if (!target) return emptyHighlight();
  if (target.kind !== "queue" && target.kind !== "exchange") return emptyHighlight();

  const traversal = traverseUpstream(input, targetNodeId, options);
  const nodeIds = new Set<string>();
  nodeIds.add(targetNodeId);
  for (const id of traversal.reachableAncestorIds) nodeIds.add(id);

  const followedKinds = new Set<GraphEdgeKind>(ROUTING_EDGE_KINDS);
  if (options.followDeadLetter === true) followedKinds.add("dead-letter");

  const edgeIds = new Set<string>();
  // Seed with the shortest-path edges even if they somehow fall outside
  // `followedKinds` (defensive against future traversal changes).
  for (const path of traversal.paths) {
    for (const step of path.steps) edgeIds.add(step.edgeId);
  }
  // Expand to every routing edge that connects two highlighted nodes so
  // diamond/branching ancestries render as a connected sub-graph.
  for (const edge of input.edges) {
    if (!followedKinds.has(edge.kind)) continue;
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) edgeIds.add(edge.id);
  }

  return { targetNodeId, nodeIds, edgeIds, traversal };
}

function findNode(nodes: GraphNode[], id: string): GraphNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
  }
  return undefined;
}

/** Type re-export so callers can `import { GraphEdge } from ".../upstreamHighlight"`. */
export type { GraphEdge };
