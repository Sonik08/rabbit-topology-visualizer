import type { GraphEdge, GraphEdgeKind, GraphNode } from "../model";
import {
  bidirectionalForNode,
  traverseUpstream,
  type BidirectionalTraversalResult,
  type DownstreamTraversalResult,
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
  return highlightFromTraversal(input, targetNodeId, traversal, options.followDeadLetter === true);
}

/**
 * Build a highlight from a pre-computed traversal. Used by the Web Worker
 * pipeline in `TopologyGraphCanvas` — the worker runs the (potentially
 * expensive) `upstreamForQueue`/`upstreamForExchange` off-thread and returns
 * an `UpstreamTraversalResult`; this helper turns that into the same
 * `UpstreamHighlight` shape `computeUpstreamHighlight` produces on the main
 * thread.
 */
export function highlightFromTraversal(
  input: UpstreamGraphInput,
  targetNodeId: string,
  traversal: UpstreamTraversalResult,
  followDeadLetter = false,
): UpstreamHighlight {
  const nodeIds = new Set<string>();
  nodeIds.add(targetNodeId);
  for (const id of traversal.reachableAncestorIds) nodeIds.add(id);

  const followedKinds = new Set<GraphEdgeKind>(ROUTING_EDGE_KINDS);
  if (followDeadLetter) followedKinds.add("dead-letter");

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

/**
 * Bidirectional selection highlight — the union of the upstream ancestor
 * set and the downstream descendant set for a queue / exchange / shovel /
 * federation target.
 *
 * `nodeIds` / `edgeIds` are the union so the existing rendering path (which
 * dims anything NOT in these sets) lights up the full incoming + outgoing
 * chain without duplicating work per direction. `upstream` and `downstream`
 * carry the underlying traversals so path panels can render the two
 * directions as separate, labelled sections.
 *
 * `truncated` collapses truncation from either direction into a single flag
 * the summary bar can surface as `truncated at max depth`.
 */
export interface BidirectionalHighlight {
  targetNodeId?: string;
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  /** Number of ancestors (excludes target). */
  incomingCount: number;
  /** Number of descendants (excludes target). */
  outgoingCount: number;
  truncated: boolean;
  upstream?: UpstreamTraversalResult;
  downstream?: DownstreamTraversalResult;
}

function emptyBidirectionalHighlight(): BidirectionalHighlight {
  return {
    nodeIds: new Set(),
    edgeIds: new Set(),
    incomingCount: 0,
    outgoingCount: 0,
    truncated: false,
  };
}

/**
 * Compute the bidirectional highlight for a target node. Returns an empty
 * highlight when the node is missing, or when the node kind is not one of the
 * four supported entry points (`queue`, `exchange`, `shovel`, `federation`).
 *
 * `edgeIds` includes every routing edge whose endpoints both lie in the
 * highlighted node set — same expansion logic as
 * {@link computeUpstreamHighlight} — so diamonds, parallel bindings, and
 * fan-out branches all render as a connected sub-graph rather than isolated
 * pieces separated by dimmed edges.
 */
export function computeBidirectionalHighlight(
  input: UpstreamGraphInput,
  targetNodeId: string | undefined,
  options: UpstreamTraversalOptions = {},
): BidirectionalHighlight {
  if (!targetNodeId) return emptyBidirectionalHighlight();
  const target = findNode(input.nodes, targetNodeId);
  if (!target) return emptyBidirectionalHighlight();
  const bidirectional = bidirectionalForNode(input, targetNodeId, options);
  // bidirectionalForNode returns empty payloads for unsupported kinds — the
  // reachable id arrays being empty means the highlight is a bare target-only
  // set, which is exactly the "safe no-op" contract we want for host/vhost/
  // external selections.
  if (
    bidirectional.upstream.reachableAncestorIds.length === 0 &&
    bidirectional.downstream.reachableDescendantIds.length === 0 &&
    target.kind !== "queue" &&
    target.kind !== "exchange" &&
    target.kind !== "shovel" &&
    target.kind !== "federation"
  ) {
    return emptyBidirectionalHighlight();
  }
  return bidirectionalHighlightFromTraversal(
    input,
    bidirectional,
    options.followDeadLetter === true,
  );
}

/**
 * Same shape as {@link highlightFromTraversal} but for the bidirectional
 * result: expands the union of upstream + downstream reachable ids into the
 * full highlight sets. Used by the worker-backed hook, which runs the
 * traversal off-thread and needs to turn the resulting envelope into a
 * highlight on the main thread.
 */
export function bidirectionalHighlightFromTraversal(
  input: UpstreamGraphInput,
  traversal: BidirectionalTraversalResult,
  followDeadLetter = false,
): BidirectionalHighlight {
  const nodeIds = new Set<string>();
  nodeIds.add(traversal.targetNodeId);
  for (const id of traversal.upstream.reachableAncestorIds) nodeIds.add(id);
  for (const id of traversal.downstream.reachableDescendantIds) nodeIds.add(id);

  const followedKinds = new Set<GraphEdgeKind>(ROUTING_EDGE_KINDS);
  if (followDeadLetter) followedKinds.add("dead-letter");

  const edgeIds = new Set<string>();
  // Seed with the traversal's own shortest-path edges (defensive against a
  // future traversal change that returns kinds outside `followedKinds`).
  for (const path of traversal.upstream.paths) {
    for (const step of path.steps) edgeIds.add(step.edgeId);
  }
  for (const path of traversal.downstream.paths) {
    for (const step of path.steps) edgeIds.add(step.edgeId);
  }
  // Expand to every routing edge that connects two highlighted nodes so
  // branching / diamond ancestries render as a connected sub-graph.
  for (const edge of input.edges) {
    if (!followedKinds.has(edge.kind)) continue;
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) edgeIds.add(edge.id);
  }

  return {
    targetNodeId: traversal.targetNodeId,
    nodeIds,
    edgeIds,
    incomingCount: traversal.upstream.reachableAncestorIds.length,
    outgoingCount: traversal.downstream.reachableDescendantIds.length,
    truncated: traversal.upstream.truncated || traversal.downstream.truncated,
    upstream: traversal.upstream,
    downstream: traversal.downstream,
  };
}

// Explicit re-exports so downstream consumers can pull the whole set from a
// single import line — the traversal types are opaque envelopes we only ever
// pass through, so co-locating them keeps call sites concise.
export { traverseDownstream } from "./traversal";
export type {
  BidirectionalTraversalResult,
  DownstreamPath,
  DownstreamStep,
  DownstreamTraversalResult,
} from "./traversal";

/** Type re-export so callers can `import { GraphEdge } from ".../upstreamHighlight"`. */
export type { GraphEdge };
