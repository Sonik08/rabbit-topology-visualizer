import type { GraphEdge, GraphEdgeKind, GraphNode } from "../model";

/** Edge kinds that participate in routing / message flow — the only ones that can form a routing cycle. */
const DEFAULT_CYCLE_EDGE_KINDS: ReadonlySet<GraphEdgeKind> = new Set([
  "binds",
  "routes",
  "alternate-exchange",
  "shovels",
  "federates",
]);

/**
 * Witness for a simple cycle that lives inside an SCC. `nodeIds[i]` is joined
 * to `nodeIds[(i + 1) % nodeIds.length]` by `edgeIds[i]`, so the pairs line up
 * as a closed walk. This is the *smallest useful* proof that the enclosing
 * SCC actually contains routing loops (as opposed to being a set of nodes
 * that just happen to be mutually reachable).
 */
export interface CycleWitness {
  nodeIds: string[];
  edgeIds: string[];
}

/**
 * A routing cycle report. `nodeIds` is the full set of nodes in the SCC
 * (canonical sorted order — a diagnostic of "every node stuck in this loop").
 * `witness` is one concrete simple cycle inside that SCC so callers can
 * highlight a specific loop in the UI without doing their own graph search.
 *
 * For a non-Hamiltonian SCC — e.g. `A↔B, A↔C` where {A, B, C} is one SCC but
 * no single closed walk visits all three — `nodeIds` still contains all three
 * members, and `witness` reports a valid sub-cycle such as `A → B → A`.
 */
export interface Cycle {
  /** All node ids in the SCC, sorted for stable output. */
  nodeIds: string[];
  /** One simple-cycle witness inside the SCC. */
  witness: CycleWitness;
}

export interface FindCyclesInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface FindCyclesOptions {
  /**
   * Restrict cycle detection to these edge kinds. Defaults to the routing
   * edges (`binds`, `routes`, `alternate-exchange`, `shovels`, `federates`);
   * `contains` and `dead-letter` are intentionally excluded because they
   * describe structure or forward-only flow, not routing loops.
   */
  edgeKinds?: ReadonlySet<GraphEdgeKind>;
}

/**
 * Enumerates every strongly-connected component in the graph that contains a
 * routing cycle, using Tarjan's SCC algorithm in `O(V + E)`. Any SCC of size
 * ≥ 2 is reported (every such SCC by definition contains at least one simple
 * cycle); singleton SCCs are reported only when the node has a self-loop.
 *
 * Each `Cycle` carries the full SCC in `nodeIds` (so callers can see which
 * nodes are stuck in the loop) plus a `witness` that is a concrete simple
 * cycle inside the SCC. The witness may cover fewer nodes than the SCC when
 * the SCC is non-Hamiltonian — for instance, an SCC `{A, B, C}` formed by
 * `A↔B` and `A↔C` still yields a valid witness cycle `A → B → A`.
 */
export function findCycles(
  input: FindCyclesInput,
  options: FindCyclesOptions = {},
): Cycle[] {
  const edgeKinds = options.edgeKinds ?? DEFAULT_CYCLE_EDGE_KINDS;

  const outgoing = new Map<string, GraphEdge[]>();
  const nodeIds = new Set<string>();
  for (const n of input.nodes) nodeIds.add(n.id);
  for (const e of input.edges) {
    if (!edgeKinds.has(e.kind)) continue;
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    const bucket = outgoing.get(e.from);
    if (bucket === undefined) outgoing.set(e.from, [e]);
    else bucket.push(e);
  }

  // Tarjan's SCC.
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const sccs: string[][] = [];

  // Iterative DFS to avoid blowing the JS call stack on wide graphs.
  interface Frame {
    node: string;
    edgesIter: number;
    edges: GraphEdge[];
  }

  const strongconnect = (start: string): void => {
    const startEdges = outgoing.get(start) ?? [];
    index.set(start, counter);
    lowlink.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    const frames: Frame[] = [{ node: start, edgesIter: 0, edges: startEdges }];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (frame.edgesIter < frame.edges.length) {
        const edge = frame.edges[frame.edgesIter]!;
        frame.edgesIter += 1;
        const w = edge.to;
        if (!index.has(w)) {
          const wEdges = outgoing.get(w) ?? [];
          index.set(w, counter);
          lowlink.set(w, counter);
          counter += 1;
          stack.push(w);
          onStack.add(w);
          frames.push({ node: w, edgesIter: 0, edges: wEdges });
        } else if (onStack.has(w)) {
          const cur = lowlink.get(frame.node)!;
          const wIndex = index.get(w)!;
          if (wIndex < cur) lowlink.set(frame.node, wIndex);
        }
        continue;
      }
      // All outgoing edges processed — settle this node.
      const v = frame.node;
      frames.pop();
      if (lowlink.get(v) === index.get(v)) {
        const scc: string[] = [];
        while (stack.length > 0) {
          const top = stack.pop()!;
          onStack.delete(top);
          scc.push(top);
          if (top === v) break;
        }
        sccs.push(scc);
      }
      if (frames.length > 0) {
        const parent = frames[frames.length - 1]!;
        const parentLow = lowlink.get(parent.node)!;
        const vLow = lowlink.get(v)!;
        if (vLow < parentLow) lowlink.set(parent.node, vLow);
      }
    }
  };

  for (const id of nodeIds) {
    if (!index.has(id)) strongconnect(id);
  }

  const cycles: Cycle[] = [];
  for (const scc of sccs) {
    if (scc.length > 1) {
      const sccSet = new Set(scc);
      const sortedNodes = [...scc].sort();
      // Deterministic starting node so the witness output is stable across runs.
      const witness = findWitnessCycle(sortedNodes[0]!, sccSet, outgoing);
      if (witness) {
        cycles.push({ nodeIds: sortedNodes, witness });
      }
      continue;
    }
    // Singleton — check for self-loop.
    const only = scc[0]!;
    const selfEdge = (outgoing.get(only) ?? []).find((e) => e.to === only);
    if (selfEdge) {
      cycles.push({
        nodeIds: [only],
        witness: { nodeIds: [only], edgeIds: [selfEdge.id] },
      });
    }
  }
  cycles.sort((a, b) => a.nodeIds[0]!.localeCompare(b.nodeIds[0]!));
  return cycles;
}

/**
 * BFS inside `sccMembers` from `start`, finding the shortest cycle that
 * returns to `start`. Uses a **globally-visited** frontier + parent pointers,
 * so every node in the SCC is dequeued at most once and every edge is
 * inspected at most once — total `O(|SCC| + |E within SCC|)` per call.
 *
 * The witness returned is a simple cycle: nodes never repeat, and the closing
 * edge from the last node back to `start` is appended so `nodeIds[i]` is
 * joined to `nodeIds[(i + 1) % nodeIds.length]` by `edgeIds[i]`.
 *
 * A valid SCC of size ≥ 2 is guaranteed by definition to contain such a
 * cycle, so this function returns `undefined` only when its input is
 * malformed (e.g. an SCC whose edges were filtered out of `outgoing`).
 */
function findWitnessCycle(
  start: string,
  sccMembers: ReadonlySet<string>,
  outgoing: Map<string, GraphEdge[]>,
): CycleWitness | undefined {
  interface Parent {
    node: string;
    edge: GraphEdge;
  }
  const parent = new Map<string, Parent>();
  const visited = new Set<string>([start]);
  const queue: string[] = [start];
  let head = 0;
  let closingEdge: GraphEdge | undefined;
  let closerNode: string | undefined;

  bfs: while (head < queue.length) {
    const u = queue[head]!;
    head += 1;
    const outs = outgoing.get(u) ?? [];
    for (const edge of outs) {
      if (!sccMembers.has(edge.to)) continue;
      if (edge.to === start && u !== start) {
        closingEdge = edge;
        closerNode = u;
        break bfs;
      }
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      parent.set(edge.to, { node: u, edge });
      queue.push(edge.to);
    }
  }

  if (closingEdge === undefined || closerNode === undefined) return undefined;

  // Reconstruct start → … → closerNode by walking parent pointers backward.
  const forwardNodes: string[] = [closerNode];
  const forwardEdges: GraphEdge[] = [];
  let cursor = closerNode;
  while (cursor !== start) {
    const p = parent.get(cursor);
    if (!p) break;
    forwardNodes.unshift(p.node);
    forwardEdges.unshift(p.edge);
    cursor = p.node;
  }
  forwardEdges.push(closingEdge);
  return {
    nodeIds: forwardNodes,
    edgeIds: forwardEdges.map((e) => e.id),
  };
}
