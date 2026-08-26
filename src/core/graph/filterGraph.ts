import type {
  BuildGraphResult,
} from "./buildGraph";
import type {
  Exchange,
  FederationLink,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  Host,
  Queue,
  Shovel,
  Vhost,
} from "../model";

export interface GraphFilters {
  /**
   * Whitelist of host ids the user has selected. Empty → no host filter
   * (every host is included). External nodes never match host filters —
   * they're kept when the entity-kind filter includes `external`.
   */
  hostIds?: ReadonlySet<string>;
  /** Whitelist of vhost ids. Empty → no vhost filter. */
  vhostIds?: ReadonlySet<string>;
  /** Whitelist of node kinds to keep. Empty → all kinds. */
  entityKinds?: ReadonlySet<GraphNodeKind>;
  /** Whitelist of edge kinds to keep. Empty → all edge kinds. */
  edgeKinds?: ReadonlySet<GraphEdgeKind>;
  /**
   * Case-insensitive substring the routing key must contain. Empty/undefined
   * → no routing-key filter. Only affects edges that carry a `routingKey`
   * (binds/routes/dead-letter/etc); other edge kinds pass through.
   */
  routingKeyQuery?: string;
}

/**
 * Applies a set of user-selected filters to a `BuildGraphResult`. The output
 * is a fresh `BuildGraphResult` shape (nodes + edges + diagnostics) so it can
 * be handed straight to `toReactFlowElements` or `computeUpstreamHighlight`.
 *
 * Filtering is a two-pass operation:
 *   1. Nodes are pruned by kind + host + vhost membership.
 *   2. Edges are pruned by kind + routing-key + dangling-endpoint check.
 *
 * Empty filter sets are treated as "no filter" so a caller can pass a partial
 * `GraphFilters` object without knowing every field. `routingKeyQuery` is
 * trimmed and compared case-insensitively; non-routing edges (`contains`,
 * `alternate-exchange`, `shovels`, `federates` without a routing key) pass the
 * routing-key check unconditionally so removing them requires an explicit
 * edge-kind filter.
 */
export function applyGraphFilters(
  graph: BuildGraphResult,
  filters: GraphFilters = {},
): BuildGraphResult {
  const nodes = filterNodes(graph.nodes, filters);
  const keepNodeIds = new Set(nodes.map((n) => n.id));
  const edges = filterEdges(graph.edges, keepNodeIds, filters);
  return { nodes, edges, diagnostics: graph.diagnostics };
}

function filterNodes(nodes: GraphNode[], filters: GraphFilters): GraphNode[] {
  const kinds = normalizeSet(filters.entityKinds);
  const hosts = normalizeSet(filters.hostIds);
  const vhosts = normalizeSet(filters.vhostIds);
  // When a vhost filter is active, a `host` node is only retained if at least
  // one of its child vhosts survives the filter. Otherwise a host with all its
  // vhosts filtered out would linger as an orphan header. Derived from the raw
  // node set (not the vhost whitelist directly) so unknown/dangling vhost ids
  // in the whitelist cannot resurrect a host.
  const retainedHostIdsForVhostFilter = vhosts
    ? collectParentHostIdsOfWhitelistedVhosts(nodes, vhosts)
    : undefined;
  const out: GraphNode[] = [];
  for (const node of nodes) {
    if (kinds && !kinds.has(node.kind)) continue;
    if (node.kind === "external") {
      // External nodes are anchored outside the loaded topology — they don't
      // carry an in-project host/vhost id, so host/vhost filters don't apply.
      out.push(node);
      continue;
    }
    if (hosts) {
      const hostId = nodeHostId(node);
      if (!hostId || !hosts.has(hostId)) continue;
    }
    if (vhosts) {
      if (node.kind === "host") {
        // Keep only hosts that parent at least one whitelisted vhost —
        // pruning a host whose vhosts are all filtered out avoids leaving
        // an orphan header, while still preserving each surviving vhost's
        // parent so container edges + column layout stay intact.
        if (!retainedHostIdsForVhostFilter!.has(node.id)) continue;
      } else {
        const vhostId = nodeVhostId(node);
        if (!vhostId || !vhosts.has(vhostId)) continue;
      }
    }
    out.push(node);
  }
  return out;
}

function collectParentHostIdsOfWhitelistedVhosts(
  nodes: GraphNode[],
  vhosts: ReadonlySet<string>,
): Set<string> {
  const hostIds = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== "vhost") continue;
    if (!vhosts.has(node.id)) continue;
    const parentHostId = (node.data as Partial<Vhost> | undefined)?.hostId;
    if (parentHostId) hostIds.add(parentHostId);
  }
  return hostIds;
}

function filterEdges(
  edges: GraphEdge[],
  keepNodeIds: Set<string>,
  filters: GraphFilters,
): GraphEdge[] {
  const edgeKinds = normalizeSet(filters.edgeKinds);
  const routingQuery = filters.routingKeyQuery?.trim().toLowerCase();
  const out: GraphEdge[] = [];
  for (const edge of edges) {
    if (edgeKinds && !edgeKinds.has(edge.kind)) continue;
    if (!keepNodeIds.has(edge.from) || !keepNodeIds.has(edge.to)) continue;
    if (routingQuery && routingQuery.length > 0) {
      // Only filter edges that actually carry a routing key. Kinds without
      // one (contains, alternate-exchange without rk, shovels/federates
      // without rk) pass through — removing them requires an explicit
      // edge-kind filter.
      if (edge.routingKey !== undefined) {
        if (!edge.routingKey.toLowerCase().includes(routingQuery)) continue;
      }
    }
    out.push(edge);
  }
  return out;
}

function normalizeSet<T>(set: ReadonlySet<T> | undefined): ReadonlySet<T> | undefined {
  if (!set || set.size === 0) return undefined;
  return set;
}

function nodeHostId(node: GraphNode): string | undefined {
  switch (node.kind) {
    case "host": {
      const host = node.data as Partial<Host> | undefined;
      return host?.id ?? node.id;
    }
    case "vhost": {
      const vhost = node.data as Partial<Vhost> | undefined;
      return vhost?.hostId;
    }
    case "exchange": {
      const ex = node.data as Partial<Exchange> | undefined;
      return ex?.hostId;
    }
    case "queue": {
      const q = node.data as Partial<Queue> | undefined;
      return q?.hostId;
    }
    case "shovel": {
      const s = node.data as Partial<Shovel> | undefined;
      return s?.hostId;
    }
    case "federation": {
      const f = node.data as Partial<FederationLink> | undefined;
      return f?.hostId;
    }
    default:
      return undefined;
  }
}

function nodeVhostId(node: GraphNode): string | undefined {
  switch (node.kind) {
    case "vhost": {
      const vhost = node.data as Partial<Vhost> | undefined;
      return vhost?.id ?? node.id;
    }
    case "exchange": {
      const ex = node.data as Partial<Exchange> | undefined;
      return ex?.vhostId;
    }
    case "queue": {
      const q = node.data as Partial<Queue> | undefined;
      return q?.vhostId;
    }
    case "shovel": {
      const s = node.data as Partial<Shovel> | undefined;
      return s?.vhostId;
    }
    case "federation": {
      const f = node.data as Partial<FederationLink> | undefined;
      return f?.vhostId;
    }
    default:
      return undefined;
  }
}
