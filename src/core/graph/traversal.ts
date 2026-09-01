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

/**
 * Reverse-traverses the graph from `targetExchangeId` following routing edges
 * (`binds`, `routes`, `alternate-exchange`, `shovels`, `federates`, optionally
 * `dead-letter`) to enumerate every upstream ancestor node.
 *
 * Same semantics as `upstreamForQueue` but validates that the target is an
 * exchange node. Useful when the user selects an exchange (rather than a
 * queue) as the "where do messages arriving here come from?" starting point —
 * for example, to trace publishers of a fan-out or an exchange-to-exchange
 * downstream point.
 */
export function upstreamForExchange(
  input: UpstreamGraphInput,
  targetExchangeId: string,
  options: UpstreamTraversalOptions = {},
): UpstreamTraversalResult {
  const nodeById = new Map<string, GraphNode>();
  for (const n of input.nodes) nodeById.set(n.id, n);

  const target = nodeById.get(targetExchangeId);
  if (target === undefined || target.kind !== "exchange") {
    return {
      targetNodeId: targetExchangeId,
      reachableAncestorIds: [],
      paths: [],
      truncated: false,
      visitedCycles: [],
    };
  }

  return traverseUpstream(input, targetExchangeId, options);
}

/** Shared reverse-traversal used by both queue and exchange entry points. */
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

    let expandedAny = false;
    let closesAncestryCycle = false;
    for (const edge of inbound) {
      const upstream = edge.from;
      if (distance.has(upstream)) {
        // Already reached via an equal-or-shorter path — either a cycle
        // (upstream is on the ancestry chain toward target) or a diamond
        // (same node reachable via two branches). Either way, don't
        // re-expand; each node is processed at most once.
        visitedCycles.add(upstream);
        if (isOnAncestryChain(currentId, upstream, parent, targetNodeId)) {
          closesAncestryCycle = true;
        }
        continue;
      }
      distance.set(upstream, currentDepth + 1);
      parent.set(upstream, { parentId: currentId, edge });
      queue.push(upstream);
      expandedAny = true;
    }
    // BFS-tree leaf that closed a cycle back onto its own ancestry: enumerate
    // it as a representative source so `paths` is not empty when
    // `reachableAncestorIds` is non-empty. A diamond merge (already-visited
    // node reached via a sibling branch, NOT on the current ancestry chain)
    // is intentionally excluded — its ancestry was already emitted via the
    // sibling and adding a duplicate source would mislead the operator.
    if (!expandedAny && closesAncestryCycle && currentId !== targetNodeId) {
      sourceNodes.add(currentId);
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

/**
 * One outgoing hop discovered while walking downstream from the target
 * toward one of the descendant sinks. Mirrors {@link UpstreamStep} but the
 * traversal direction points AWAY from the target.
 */
export interface DownstreamStep {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: GraphEdgeKind;
  routingKey?: string;
  label?: string;
}

/**
 * Downstream path — ordered edges from the target toward one ultimate sink
 * (a queue with no further outgoing edges, an unresolved external endpoint,
 * or any node cut off at `maxDepth`).
 */
export interface DownstreamPath {
  sinkNodeId: string;
  steps: DownstreamStep[];
}

export interface DownstreamTraversalResult {
  targetNodeId: string;
  reachableDescendantIds: string[];
  paths: DownstreamPath[];
  truncated: boolean;
  visitedCycles: string[];
}

/**
 * Forward-traverse the graph from `targetNodeId` following routing edges
 * (`binds`, `routes`, `alternate-exchange`, `shovels`, `federates`, optionally
 * `dead-letter`) to enumerate every descendant node the target can reach.
 *
 * BFS with a global visited set — same complexity guarantee as
 * {@link traverseUpstream}: each node is expanded at most once, so total cost
 * is `O(V + E)` and diamonds / fan-outs do not blow up traversal time. Each
 * sink is reported with its shortest forward path from the target.
 */
export function traverseDownstream(
  input: UpstreamGraphInput,
  targetNodeId: string,
  options: UpstreamTraversalOptions = {},
): DownstreamTraversalResult {
  const maxDepth = normalizeMaxDepth(options.maxDepth);
  const includeDeadLetter = options.followDeadLetter === true;
  const followedKinds = new Set<GraphEdgeKind>(ROUTING_EDGE_KINDS);
  if (includeDeadLetter) followedKinds.add(DEAD_LETTER_EDGE_KIND);

  const outgoing = new Map<string, GraphEdge[]>();
  for (const e of input.edges) {
    if (!followedKinds.has(e.kind)) continue;
    const bucket = outgoing.get(e.from);
    if (bucket === undefined) outgoing.set(e.from, [e]);
    else bucket.push(e);
  }

  interface Parent {
    parentId: string; // upstream node (one step closer to the target)
    edge: GraphEdge;
  }
  const distance = new Map<string, number>();
  const parent = new Map<string, Parent>();
  const sinkNodes = new Set<string>();
  const visitedCycles = new Set<string>();
  let truncated = false;

  distance.set(targetNodeId, 0);
  const queue: string[] = [targetNodeId];
  let head = 0;
  while (head < queue.length) {
    const currentId = queue[head]!;
    head += 1;
    const currentDepth = distance.get(currentId)!;
    const out = outgoing.get(currentId) ?? [];
    if (out.length === 0) {
      if (currentId !== targetNodeId) sinkNodes.add(currentId);
      continue;
    }
    if (currentDepth >= maxDepth) {
      truncated = true;
      if (currentId !== targetNodeId) sinkNodes.add(currentId);
      continue;
    }
    let expandedAny = false;
    let closesAncestryCycle = false;
    for (const edge of out) {
      const next = edge.to;
      if (distance.has(next)) {
        visitedCycles.add(next);
        if (isOnAncestryChain(currentId, next, parent, targetNodeId)) {
          closesAncestryCycle = true;
        }
        continue;
      }
      distance.set(next, currentDepth + 1);
      parent.set(next, { parentId: currentId, edge });
      queue.push(next);
      expandedAny = true;
    }
    // Same rule as `traverseUpstream`: only emit a representative sink when
    // the BFS-tree leaf actually closes a cycle back onto its own ancestry to
    // the target — never for diamond merges, whose ancestry is already
    // covered by the sibling branch that reached the merge point first.
    if (!expandedAny && closesAncestryCycle && currentId !== targetNodeId) {
      sinkNodes.add(currentId);
    }
  }

  const reachableDescendantIds = [...distance.keys()]
    .filter((id) => id !== targetNodeId)
    .sort();

  const paths: DownstreamPath[] = [];
  for (const sinkId of sinkNodes) {
    // Walk the parent chain from sink back to target, then reverse so the
    // reported steps flow target → sink (natural reading direction for a
    // downstream path).
    const reverseSteps: DownstreamStep[] = [];
    let cursor = sinkId;
    while (cursor !== targetNodeId) {
      const p = parent.get(cursor);
      if (!p) break;
      reverseSteps.push({
        edgeId: p.edge.id,
        fromNodeId: p.parentId,
        toNodeId: cursor,
        kind: p.edge.kind,
        routingKey: p.edge.routingKey,
        label: p.edge.label,
      });
      cursor = p.parentId;
    }
    reverseSteps.reverse();
    paths.push({ sinkNodeId: sinkId, steps: reverseSteps });
  }
  paths.sort((a, b) => a.sinkNodeId.localeCompare(b.sinkNodeId));

  return {
    targetNodeId,
    reachableDescendantIds,
    paths,
    truncated,
    visitedCycles: [...visitedCycles].sort(),
  };
}

/**
 * Combined upstream + downstream traversal from a single target. Used by the
 * bidirectional selection-highlight path: selecting a queue/exchange/shovel/
 * federation node exposes every reachable incoming AND outgoing routing chain
 * so the operator can see the full end-to-end message flow at a glance.
 *
 * Target kinds outside {`queue`, `exchange`, `shovel`, `federation`} produce
 * an empty result — safe no-op for host/vhost/external selections (the UI
 * treats those as structural, not routing, entry points).
 */
export interface BidirectionalTraversalResult {
  targetNodeId: string;
  upstream: UpstreamTraversalResult;
  downstream: DownstreamTraversalResult;
}

const BIDIRECTIONAL_SUPPORTED_KINDS: ReadonlySet<GraphNode["kind"]> = new Set<GraphNode["kind"]>([
  "queue",
  "exchange",
  "shovel",
  "federation",
]);

export function bidirectionalForNode(
  input: UpstreamGraphInput,
  targetNodeId: string,
  options: UpstreamTraversalOptions = {},
): BidirectionalTraversalResult {
  const target = findTargetNode(input.nodes, targetNodeId);
  const emptyUp: UpstreamTraversalResult = {
    targetNodeId,
    reachableAncestorIds: [],
    paths: [],
    truncated: false,
    visitedCycles: [],
  };
  const emptyDown: DownstreamTraversalResult = {
    targetNodeId,
    reachableDescendantIds: [],
    paths: [],
    truncated: false,
    visitedCycles: [],
  };
  if (!target || !BIDIRECTIONAL_SUPPORTED_KINDS.has(target.kind)) {
    return { targetNodeId, upstream: emptyUp, downstream: emptyDown };
  }
  return {
    targetNodeId,
    upstream: traverseUpstream(input, targetNodeId, options),
    downstream: traverseDownstream(input, targetNodeId, options),
  };
}

function findTargetNode(nodes: GraphNode[], id: string): GraphNode | undefined {
  for (const n of nodes) if (n.id === id) return n;
  return undefined;
}

/**
 * True when `candidateId` is on `startId`'s BFS-parent chain back to
 * `targetNodeId` (inclusive of both endpoints). Used by both traversal
 * directions to distinguish a cycle-back (the already-visited node is an
 * ancestor of the current node in the BFS tree) from a diamond merge (the
 * already-visited node is a sibling/cousin reached via a different branch).
 *
 * Only cycle-backs promote a BFS-tree leaf to a representative source/sink;
 * diamond merges do not, because the sibling branch already carries the
 * merged node's ancestry.
 */
function isOnAncestryChain(
  startId: string,
  candidateId: string,
  parent: Map<string, { parentId: string; edge: GraphEdge }>,
  targetNodeId: string,
): boolean {
  if (candidateId === startId) return true;
  if (candidateId === targetNodeId) return true;
  let cursor = startId;
  while (cursor !== targetNodeId) {
    const p = parent.get(cursor);
    if (!p) return false;
    if (p.parentId === candidateId) return true;
    cursor = p.parentId;
  }
  return false;
}
