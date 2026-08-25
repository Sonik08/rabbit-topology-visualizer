import type { GraphEdge, GraphEdgeKind, GraphNode } from "../model";

/** Reverse traversal follows these edge kinds when finding upstream sources. */
const ROUTING_EDGE_KINDS: ReadonlySet<GraphEdgeKind> = new Set([
  "binds",
  "routes",
  "alternate-exchange",
  "shovels",
  "federates",
]);

const DEAD_LETTER_EDGE_KIND: GraphEdgeKind = "dead-letter";

const DEFAULT_MAX_DEPTH = 32;

export interface UpstreamStep {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: GraphEdgeKind;
  routingKey?: string;
  label?: string;
}

export interface UpstreamPath {
  /** Node id of the ultimate source (no more upstream routing edges, or at maxDepth). */
  sourceNodeId: string;
  /** Ordered steps from source → target. */
  steps: UpstreamStep[];
}

export interface UpstreamTraversalResult {
  targetNodeId: string;
  /** Set of every ancestor node id reachable from the target, excluding the target itself. */
  reachableAncestorIds: string[];
  /** One representative path per distinct source, using the shortest hop count from target. */
  paths: UpstreamPath[];
  /** True when a branch was cut off by `maxDepth`. */
  truncated: boolean;
  /** Nodes whose ancestry was skipped because the edge would revisit an already-seen node. */
  visitedCycles: string[];
}

export interface UpstreamTraversalOptions {
  /**
   * Cap the number of reverse-edge hops. Non-finite (NaN/±Infinity) or missing
   * → default 32. Negative → 0 (returns the target with `truncated=true`).
   * Fractional values are floored.
   */
  maxDepth?: number;
  /**
   * When true, reverse-follow `dead-letter` edges too — useful for debugging
   * where poison messages come from. Off by default because dead-letter flow
   * is a *forward* consequence rather than a publish path.
   */
  followDeadLetter?: boolean;
}

export interface UpstreamGraphInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function normalizeMaxDepth(input: number | undefined): number {
  if (input === undefined) return DEFAULT_MAX_DEPTH;
  if (!Number.isFinite(input)) return DEFAULT_MAX_DEPTH;
  if (input < 0) return 0;
  return Math.floor(input);
}

/**
 * Reverse-traverses the graph from `targetQueueId` following routing edges
 * (`binds`, `routes`, `alternate-exchange`, `shovels`, `federates`, optionally
 * `dead-letter`) to enumerate every upstream ancestor node.
 *
 * Implemented as BFS with a global visited set, so each node is expanded at
 * most once and the total cost is `O(V + E)` regardless of how densely
 * connected the topology is or how many diamond patterns exist. Each source
 * is reported with its shortest reverse path back to the target.
 *
 * Nodes with no further incoming routing edges — publisher exchanges, external
 * endpoints, shovels/federations whose upstream side was not resolved — are
 * treated as sources. Nodes cut off at `maxDepth` are also reported as
 * (truncated) sources so the UI can show incomplete data explicitly.
 */
export function upstreamForQueue(
  input: UpstreamGraphInput,
  targetQueueId: string,
  options: UpstreamTraversalOptions = {},
): UpstreamTraversalResult {
  const nodeById = new Map<string, GraphNode>();
  for (const n of input.nodes) nodeById.set(n.id, n);

  const target = nodeById.get(targetQueueId);
  if (target === undefined || target.kind !== "queue") {
    return {
      targetNodeId: targetQueueId,
      reachableAncestorIds: [],
      paths: [],
      truncated: false,
      visitedCycles: [],
    };
  }

  return traverseUpstream(input, targetQueueId, options);
}

/** Shared reverse-traversal used by queue and (later) exchange entry points. */
export function traverseUpstream(
  input: UpstreamGraphInput,
  targetNodeId: string,
  options: UpstreamTraversalOptions = {},
): UpstreamTraversalResult {
  const maxDepth = normalizeMaxDepth(options.maxDepth);
  const includeDeadLetter = options.followDeadLetter === true;

  const followedKinds = new Set<GraphEdgeKind>(ROUTING_EDGE_KINDS);
  if (includeDeadLetter) followedKinds.add(DEAD_LETTER_EDGE_KIND);

  const incoming = new Map<string, GraphEdge[]>();
  for (const e of input.edges) {
    if (!followedKinds.has(e.kind)) continue;
    const bucket = incoming.get(e.to);
    if (bucket === undefined) incoming.set(e.to, [e]);
    else bucket.push(e);
  }

  interface Parent {
    parentId: string; // downstream node (one step closer to the target)
    edge: GraphEdge;
  }
  const distance = new Map<string, number>();
  const parent = new Map<string, Parent>();
  const sourceNodes = new Set<string>();
  const visitedCycles = new Set<string>();
  let truncated = false;

  distance.set(targetNodeId, 0);
  const queue: string[] = [targetNodeId];
  let head = 0;

  while (head < queue.length) {
    const currentId = queue[head]!;
    head += 1;
    const currentDepth = distance.get(currentId)!;
    const inbound = incoming.get(currentId) ?? [];

    if (inbound.length === 0) {
      if (currentId !== targetNodeId) sourceNodes.add(currentId);
      continue;
    }

    if (currentDepth >= maxDepth) {
      truncated = true;
      if (currentId !== targetNodeId) sourceNodes.add(currentId);
      continue;
    }

    for (const edge of inbound) {
      const upstream = edge.from;
      if (distance.has(upstream)) {
        // Already reached via an equal-or-shorter path — either a cycle
        // (upstream is on the ancestry chain toward target) or a diamond
        // (same node reachable via two branches). Either way, don't
        // re-expand; each node is processed at most once.
        visitedCycles.add(upstream);
        continue;
      }
      distance.set(upstream, currentDepth + 1);
      parent.set(upstream, { parentId: currentId, edge });
      queue.push(upstream);
    }
  }

  const reachableAncestorIds = [...distance.keys()]
    .filter((id) => id !== targetNodeId)
    .sort();

  const paths: UpstreamPath[] = [];
  for (const sourceId of sourceNodes) {
    const steps: UpstreamStep[] = [];
    let cursor = sourceId;
    // Walk the parent chain from source down to target, one step at a time.
    // Each `parent` entry gives us the next hop closer to the target.
    while (cursor !== targetNodeId) {
      const p = parent.get(cursor);
      if (!p) break;
      steps.push({
        edgeId: p.edge.id,
        fromNodeId: cursor,
        toNodeId: p.parentId,
        kind: p.edge.kind,
        routingKey: p.edge.routingKey,
        label: p.edge.label,
      });
      cursor = p.parentId;
    }
    paths.push({ sourceNodeId: sourceId, steps });
  }
  paths.sort((a, b) => a.sourceNodeId.localeCompare(b.sourceNodeId));

  return {
    targetNodeId,
    reachableAncestorIds,
    paths,
    truncated,
    visitedCycles: [...visitedCycles].sort(),
  };
}
