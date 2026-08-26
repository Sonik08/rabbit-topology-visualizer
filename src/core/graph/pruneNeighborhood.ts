import type { BuildGraphResult } from "./buildGraph";
import type { GraphEdge, GraphEdgeKind, GraphNode } from "../model";

/** Which direction(s) BFS follows out of the focus node. */
export type NeighborhoodDirection = "upstream" | "downstream" | "both";

/**
 * Edges we treat as "routing edges" for neighborhood purposes — the same set
 * `traverseUpstream` and `computeUpstreamHighlight` use. `contains` structural
 * edges are kept when their endpoints survive (so a queue's parent vhost/host
 * stays visible even when pruned), but they never contribute to the BFS
 * frontier.
 */
const ROUTING_EDGE_KINDS: ReadonlySet<GraphEdgeKind> = new Set([
  "binds",
  "routes",
  "alternate-exchange",
  "shovels",
  "federates",
]);

const DEAD_LETTER_EDGE_KIND: GraphEdgeKind = "dead-letter";
const CONTAINS_EDGE_KIND: GraphEdgeKind = "contains";

const DEFAULT_MAX_DEPTH = 3;

export interface PruneNeighborhoodOptions {
  /**
   * Maximum hop count from the focus node. Non-finite (NaN/±Infinity) or
   * missing → default 3. Negative → 0 (only the focus node is kept, plus its
   * structural `contains` ancestry). Fractional values are floored.
   */
  maxDepth?: number;
  /**
   * BFS direction. `upstream` follows edges backwards (like traverseUpstream);
   * `downstream` follows them forwards; `both` follows in both directions.
   * Defaults to `both` because a "neighborhood" reasonably means "everything
   * within N hops in either direction of the focus node".
   */
  direction?: NeighborhoodDirection;
  /**
   * When true, `dead-letter` edges participate in the BFS frontier alongside
   * the routing edges. Off by default because dead-letter flow is a forward
   * consequence rather than a routing path — matches the `computeUpstreamHighlight`
   * convention.
   */
  followDeadLetter?: boolean;
  /**
   * When true (default), `contains` structural ancestry of every surviving
   * node is preserved so hosts/vhosts stay visible above their child nodes.
   * Set to false to strip structural context entirely — useful when the caller
   * wants just the routing subgraph.
   */
  keepContainsAncestry?: boolean;
}

export interface PruneNeighborhoodResult extends BuildGraphResult {
  /** The focus node id passed to the pruner (echoed for downstream tooling). */
  focusNodeId: string;
  /** True when the BFS was cut off by maxDepth (at least one candidate remained). */
  truncated: boolean;
  /** Set to true when the focus node was not found in the input graph. */
  focusMissing: boolean;
}

/**
 * Restricts a full topology graph to the N-hop neighborhood around a focus
 * node — the visualization equivalent of "zoom into just this queue and
 * everything that connects to it within 3 hops". Complements
 * `applyGraphFilters` (kind/host/vhost predicates) by focusing on a single
 * anchor node instead of a global filter.
 *
 * Algorithm:
 *   1. BFS from the focus node over routing edges (respecting `direction` and
 *      `followDeadLetter`), bounded by `maxDepth`.
 *   2. Optionally add the structural `contains` ancestry of every surviving
 *      node so the visible sub-graph still shows which host/vhost each entity
 *      belongs to.
 *   3. Emit every input edge whose endpoints both survive — no dangling edges
 *      leak through.
 *
 * Returns a fresh `PruneNeighborhoodResult` (a `BuildGraphResult` plus focus
 * metadata) that can be handed straight to `toReactFlowElements` or
 * `computeUpstreamHighlight`.
 */
export function pruneNeighborhood(
  graph: BuildGraphResult,
  focusNodeId: string | undefined,
  options: PruneNeighborhoodOptions = {},
): PruneNeighborhoodResult {
  const direction: NeighborhoodDirection = options.direction ?? "both";
  const maxDepth = normalizeMaxDepth(options.maxDepth);
  const keepContainsAncestry = options.keepContainsAncestry !== false;

  if (!focusNodeId) {
    return emptyResult("", true, false, graph.diagnostics);
  }

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  if (!nodeById.has(focusNodeId)) {
    return emptyResult(focusNodeId, true, false, graph.diagnostics);
  }

  const followed = new Set<GraphEdgeKind>(ROUTING_EDGE_KINDS);
  if (options.followDeadLetter === true) followed.add(DEAD_LETTER_EDGE_KIND);

  const followsUpstream = direction === "upstream" || direction === "both";
  const followsDownstream = direction === "downstream" || direction === "both";

  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    if (!followed.has(e.kind)) continue;
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) continue;
    push(outgoing, e.from, e);
    push(incoming, e.to, e);
  }

  const keep = new Set<string>();
  keep.add(focusNodeId);
  const distance = new Map<string, number>();
  distance.set(focusNodeId, 0);

  const queue: string[] = [focusNodeId];
  let head = 0;
  let truncated = false;

  while (head < queue.length) {
    const current = queue[head]!;
    head += 1;
    const depth = distance.get(current)!;
    if (depth >= maxDepth) {
      // A next step would exceed maxDepth. Only mark truncated if there is
      // an incident routing edge whose OTHER endpoint has not already been
      // kept — otherwise the graph is complete at this depth and no work
      // was actually cut off. Checking "edge exists" alone would incorrectly
      // flip the flag for a diamond/cycle whose neighbours are already in.
      const hasUnseenUpstream =
        followsUpstream &&
        (incoming.get(current) ?? []).some((edge) => !keep.has(edge.from));
      const hasUnseenDownstream =
        followsDownstream &&
        (outgoing.get(current) ?? []).some((edge) => !keep.has(edge.to));
      if (hasUnseenUpstream || hasUnseenDownstream) truncated = true;
      continue;
    }
    if (followsUpstream) {
      for (const edge of incoming.get(current) ?? []) {
        if (!keep.has(edge.from)) {
          keep.add(edge.from);
          distance.set(edge.from, depth + 1);
          queue.push(edge.from);
        }
      }
    }
    if (followsDownstream) {
      for (const edge of outgoing.get(current) ?? []) {
        if (!keep.has(edge.to)) {
          keep.add(edge.to);
          distance.set(edge.to, depth + 1);
          queue.push(edge.to);
        }
      }
    }
  }

  if (keepContainsAncestry) {
    // Walk `contains` edges backwards from every kept node to gather each
    // node's structural ancestry (host, vhost). Done as a second pass to
    // avoid inflating the BFS frontier with structural nodes.
    const containsParent = new Map<string, string>();
    for (const e of graph.edges) {
      if (e.kind !== CONTAINS_EDGE_KIND) continue;
      if (!nodeById.has(e.from) || !nodeById.has(e.to)) continue;
      containsParent.set(e.to, e.from);
    }
    for (const seed of [...keep]) {
      let cursor: string | undefined = seed;
      // Deliberate cap: no vhost tree is deeper than a handful of levels;
      // stop after 8 walks to avoid infinite loops on pathological input.
      for (let i = 0; i < 8 && cursor !== undefined; i += 1) {
        const parent: string | undefined = containsParent.get(cursor);
        if (parent === undefined) break;
        if (keep.has(parent)) break;
        keep.add(parent);
        cursor = parent;
      }
    }
  }

  const nodes: GraphNode[] = [];
  for (const n of graph.nodes) if (keep.has(n.id)) nodes.push(n);
  const edges: GraphEdge[] = [];
  for (const e of graph.edges) {
    if (!keep.has(e.from) || !keep.has(e.to)) continue;
    edges.push(e);
  }

  return {
    nodes,
    edges,
    diagnostics: graph.diagnostics,
    focusNodeId,
    truncated,
    focusMissing: false,
  };
}

function emptyResult(
  focusNodeId: string,
  focusMissing: boolean,
  truncated: boolean,
  diagnostics: BuildGraphResult["diagnostics"],
): PruneNeighborhoodResult {
  return {
    nodes: [],
    edges: [],
    diagnostics,
    focusNodeId,
    focusMissing,
    truncated,
  };
}

function normalizeMaxDepth(input: number | undefined): number {
  if (input === undefined) return DEFAULT_MAX_DEPTH;
  if (!Number.isFinite(input)) return DEFAULT_MAX_DEPTH;
  if (input < 0) return 0;
  return Math.floor(input);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}
