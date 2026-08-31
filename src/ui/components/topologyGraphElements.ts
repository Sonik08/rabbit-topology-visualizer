import type { BuildGraphResult } from "../../core/graph/buildGraph";
import { describeBoundary } from "../../core/graph/shovelFlow";
import type {
  EndpointRef,
  Exchange,
  ExchangeType,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  LinkFlow,
  Queue,
} from "../../core/model";

export type NodeFlowType =
  | "host"
  | "vhost"
  | "external"
  | "shovel"
  | "federation"
  | `exchange:${string}`
  | `queue:${string}`;

export interface FlowNodeData {
  label: string;
  kind: GraphNodeKind;
  /** Refined subtype for filtering/tooling: exchange type or queue type. */
  flowType: NodeFlowType;
  /** Short badge shown inline before the label (e.g. `[topic]`, `[quorum]`). */
  subtypeBadge?: string;
  /** Highlight role in the current selection, if any. */
  highlightState?: "target" | "on-path" | "off-path";
  /**
   * Resolved host / vhost context for the node, computed from the canonical
   * `vhostId` on the source entity (never parsed from labels or ids). Present
   * on queue, exchange, shovel, and federation nodes when we can resolve the
   * vhost; present on external nodes as an `unknown` fallback when the
   * `EndpointRef` doesn't name a vhost. Not surfaced on host/vhost nodes —
   * host is the top-level container and vhost is its own node label.
   */
  vhostContext?: VhostContext;
  /** Compact, possibly-truncated vhost tag inlined into the display label. */
  vhostBadge?: string;
  /** Full unabbreviated vhost description for accessible label / tooltip. */
  vhostTooltip?: string;
}

/**
 * Resolved host + vhost context for a graph node. Names are the human-readable
 * `Vhost.name` / `Host.name` from the canonical model — the ids remain the
 * stable identity used for cross-references. `ambiguous` is `true` when the
 * vhost's *name* also appears on another host in the current graph, in which
 * case the UI must include host context to disambiguate duplicate entity names
 * across hosts. `unknown` is `true` for external endpoints whose vhost we
 * could not resolve (kept explicit so callers can style/label the fallback
 * without leaking credentials).
 */
export interface VhostContext {
  vhostId?: string;
  vhostName?: string;
  hostId?: string;
  hostName?: string;
  isDefault: boolean;
  ambiguous: boolean;
  unknown: boolean;
  /**
   * Stable, unique-per-host discriminator used in the compact badge when
   * `ambiguous: true` (or forced by test tooling). Resolution order — always
   * yields a stable, per-host string so duplicate entity names never render
   * with identical badges:
   *   1. `hostName` when present AND unique across the loaded graph
   *   2. `hostId`   when present (canonical stable identity)
   *   3. `unknown-host` as a last-resort literal (no host metadata whatsoever)
   * Exposed on the context so callers/tests can verify the choice without
   * re-deriving it from the badge string.
   */
  hostDiscriminator?: string;
}

/** Maximum characters in the compact vhost badge before truncation. */
const VHOST_BADGE_MAX_CHARS = 24;
const NODE_KINDS_WITH_VHOST: ReadonlySet<GraphNodeKind> = new Set([
  "exchange",
  "queue",
  "shovel",
  "federation",
]);

export interface UpstreamHighlightInput {
  /** Node ids that participate in the upstream ancestry (includes the target). */
  nodeIds: Set<string>;
  /** Edge ids that form the reverse path back to the target. */
  edgeIds: Set<string>;
  /** The selected node id; rendered with a stronger outline. */
  targetNodeId?: string;
}

/**
 * React Flow node `type` used for every entity node. TopologyGraphCanvas
 * registers a matching component under this key via `nodeTypes` so the
 * `vhostTooltip` field renders as a real `title`+`aria-label` on the DOM
 * wrapper — accessibility surface for the compact/truncated vhost badge.
 */
export type FlowNodeType = "topology";

export interface FlowNode {
  id: string;
  position: { x: number; y: number };
  data: FlowNodeData;
  type: FlowNodeType;
  style?: React.CSSProperties;
}

export interface FlowEdgeMarker {
  type: "arrowclosed";
  color: string;
  width: number;
  height: number;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  data: { kind: GraphEdge["kind"]; routingKey?: string; flow?: LinkFlow };
  animated?: boolean;
  style?: React.CSSProperties;
  labelStyle?: React.CSSProperties;
  markerEnd?: FlowEdgeMarker;
}

/**
 * Options controlling the configured-flow animation on shovel / federation
 * edges. This is *configured* topology animation, not live message telemetry —
 * callers should surface that in the surrounding UI.
 */
export interface ConfiguredFlowMotionOptions {
  /** When true, the user paused the animation manually. */
  paused?: boolean;
  /**
   * When true, the environment reports `prefers-reduced-motion: reduce` and
   * the animation must be suppressed regardless of the user's pause state.
   */
  reducedMotion?: boolean;
}

const COLUMN_ORDER: GraphNodeKind[] = [
  "host",
  "vhost",
  "external",
  "exchange",
  "shovel",
  "federation",
  "queue",
];

const COLUMN_X_SPACING = 260;
const ROW_Y_SPACING = 70;

const NODE_BASE_STYLES: Record<GraphNodeKind, React.CSSProperties> = {
  host: { background: "#fef1e5", border: "1px solid #b04d00" },
  vhost: { background: "#f1e9fb", border: "1px solid #6a3fa5" },
  exchange: { background: "#e3edfd", border: "1px solid #2f6feb" },
  queue: { background: "#e5f4ec", border: "1px solid #248559" },
  shovel: { background: "#fff5da", border: "1px solid #8a5c00" },
  federation: { background: "#fbe1ee", border: "1px solid #8a005c" },
  external: { background: "#eeeeee", border: "1px dashed #666" },
};

/**
 * Exchange sub-palette keyed by `Exchange.type`. Only the canonical AMQP types
 * get a distinct background; every other type (consistent-hash, x-random,
 * x-delayed-message, plugin types) falls back to a neutral "other" tone so the
 * exchange column still reads as one family visually.
 */
const EXCHANGE_TYPE_STYLES: Record<string, React.CSSProperties> = {
  topic: { background: "#e3edfd", border: "1px solid #2f6feb" },
  direct: { background: "#e6f2ec", border: "1px solid #1f7a4e" },
  fanout: { background: "#fff2df", border: "1px solid #b06a00" },
  headers: { background: "#f1e5ff", border: "1px solid #6a3fa5" },
  other: { background: "#eef0f4", border: "1px solid #5a6270" },
};

const KNOWN_EXCHANGE_TYPES: ReadonlySet<string> = new Set([
  "topic",
  "direct",
  "fanout",
  "headers",
]);

/** Queue-type sub-palette from `x-queue-type`. Classic is the default. */
const QUEUE_TYPE_STYLES: Record<string, React.CSSProperties> = {
  classic: { background: "#e5f4ec", border: "1px solid #248559" },
  quorum: { background: "#dbe9f7", border: "1px solid #1a5a99" },
  stream: { background: "#f5e5f2", border: "1px solid #7a2a70" },
  other: { background: "#eef4ef", border: "1px solid #4a6656" },
};

const EDGE_COLORS: Record<GraphEdge["kind"], string> = {
  contains: "#bbb",
  binds: "#2f6feb",
  routes: "#5a3fbf",
  "alternate-exchange": "#a56100",
  "dead-letter": "#b00020",
  shovels: "#8a5c00",
  federates: "#8a005c",
};

const EDGE_STYLES: Record<GraphEdge["kind"], React.CSSProperties> = {
  contains: { stroke: EDGE_COLORS.contains, strokeDasharray: "3 2" },
  binds: { stroke: EDGE_COLORS.binds, strokeWidth: 1.5 },
  routes: { stroke: EDGE_COLORS.routes, strokeWidth: 1.5 },
  "alternate-exchange": { stroke: EDGE_COLORS["alternate-exchange"], strokeDasharray: "6 3" },
  "dead-letter": { stroke: EDGE_COLORS["dead-letter"], strokeDasharray: "5 3" },
  shovels: { stroke: EDGE_COLORS.shovels, strokeWidth: 2 },
  federates: { stroke: EDGE_COLORS.federates, strokeWidth: 2 },
};

/**
 * Convert a `BuildGraphResult` into React-Flow-shaped nodes/edges. Layout is
 * deliberately trivial — a column per {@link GraphNodeKind} in {@link COLUMN_ORDER},
 * nodes stacked vertically within each column in insertion order — so this
 * function stays pure and testable without needing a layout engine. Callers
 * can pan/zoom/drag to refine positions.
 *
 * Node styling is refined per entity subtype: exchanges are coloured by AMQP
 * exchange type (topic/direct/fanout/headers), queues by `x-queue-type`
 * (classic/quorum/stream), and non-durable queues render with a dashed border
 * so transient state is visible at a glance. Every edge carries a matching
 * arrowhead marker in the edge's stroke colour and — for shovel/federation —
 * an animated dashed stroke so cross-host message flow reads as movement.
 *
 * `contains` edges are omitted by default because they turn a large topology
 * into hair-ball; pass `includeContains: true` to include them.
 */
export function toReactFlowElements(
  graph: BuildGraphResult,
  options: {
    includeContains?: boolean;
    highlight?: UpstreamHighlightInput;
    configuredFlowMotion?: ConfiguredFlowMotionOptions;
    /**
     * Complete canonical node set used only to resolve host/vhost context.
     * The rendered `graph` may already be filtered, visibility-pruned, or
     * focused; using that reduced set would turn still-visible entities into
     * `unknown vhost` whenever their structural containers are hidden.
     */
    contextNodes?: readonly GraphNode[];
  } = {},
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const vhostLookup = buildVhostLookup(options.contextNodes ?? graph.nodes);
  const positionedNodes = layoutNodes(graph.nodes, options.highlight, vhostLookup);
  const flowEdges: FlowEdge[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const highlight = options.highlight;
  const highlightActive = highlight !== undefined && highlight.nodeIds.size > 0;
  const motion = options.configuredFlowMotion ?? {};
  const configuredFlowStill = Boolean(motion.paused) || Boolean(motion.reducedMotion);
  for (const edge of graph.edges) {
    if (!options.includeContains && edge.kind === "contains") continue;
    // Drop edges whose endpoints aren't present as nodes — these can occur when
    // a partial import references a queue that never got materialized. Silently
    // dropping keeps React Flow from throwing on unresolved handles.
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    const color = EDGE_COLORS[edge.kind];
    const baseStyle = EDGE_STYLES[edge.kind];
    const onPath = highlightActive && highlight!.edgeIds.has(edge.id);
    const style: React.CSSProperties = highlightActive
      ? onPath
        ? { ...baseStyle, strokeWidth: Number(baseStyle.strokeWidth ?? 1.5) + 1 }
        : { ...baseStyle, opacity: 0.15 }
      : baseStyle;
    const isConfiguredFlow =
      edge.kind === "shovels" || edge.kind === "federates";
    flowEdges.push({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: edgeLabel(edge),
      data: { kind: edge.kind, routingKey: edge.routingKey, flow: edge.flow },
      style,
      labelStyle: highlightActive && !onPath
        ? { fontSize: 10, fill: "#333", opacity: 0.15 }
        : { fontSize: 10, fill: "#333" },
      // Configured-flow animation is directional (dashed marching ants). A
      // paused user setting OR `prefers-reduced-motion: reduce` suppresses it
      // — the direction is still readable from the arrowhead + boundary label.
      animated: isConfiguredFlow && !configuredFlowStill,
      markerEnd: {
        type: "arrowclosed",
        color,
        width: 16,
        height: 16,
      },
    });
  }
  return { nodes: positionedNodes, edges: flowEdges };
}

function layoutNodes(
  nodes: GraphNode[],
  highlight: UpstreamHighlightInput | undefined,
  vhostLookup: VhostLookup,
): FlowNode[] {
  const byKind = new Map<GraphNodeKind, GraphNode[]>();
  for (const kind of COLUMN_ORDER) byKind.set(kind, []);
  for (const node of nodes) {
    const bucket = byKind.get(node.kind);
    if (bucket) bucket.push(node);
    else byKind.set(node.kind, [node]);
  }
  // Resolve vhost context once per node, then compute badges as a single
  // collision-safe batch so distinct identities never share a truncated
  // string — even under pathological name prefixes/tails or FNV hash
  // collisions at short hash lengths.
  const contextByNodeId = new Map<string, VhostContext | undefined>();
  for (const node of nodes) {
    contextByNodeId.set(node.id, resolveVhostContext(node, vhostLookup));
  }
  const badgeByNodeId = computeVhostBadgeMap(nodes, contextByNodeId);
  const highlightActive = highlight !== undefined && highlight.nodeIds.size > 0;
  const out: FlowNode[] = [];
  let columnIndex = 0;
  for (const kind of COLUMN_ORDER) {
    const bucket = byKind.get(kind) ?? [];
    if (bucket.length === 0) {
      columnIndex += 1;
      continue;
    }
    bucket.forEach((node, rowIndex) => {
      const { style: baseStyle, flowType, subtypeBadge } = resolveNodeStyle(node);
      const vhostContext = contextByNodeId.get(node.id);
      const vhostBadge = badgeByNodeId.get(node.id);
      const vhostTooltip = renderVhostTooltip(vhostContext, vhostLookup);
      const primaryLabel = subtypeBadge ? `${subtypeBadge} ${node.label}` : node.label;
      const displayLabel = vhostBadge ? `${primaryLabel} · ${vhostBadge}` : primaryLabel;
      let highlightState: FlowNodeData["highlightState"];
      let style: React.CSSProperties = { ...baseStyle };
      if (highlightActive) {
        const isTarget = highlight!.targetNodeId === node.id;
        const isOnPath = highlight!.nodeIds.has(node.id);
        if (isTarget) {
          highlightState = "target";
          style = {
            ...style,
            boxShadow: "0 0 0 3px #f4c542",
            fontWeight: 600,
          };
        } else if (isOnPath) {
          highlightState = "on-path";
          style = { ...style, boxShadow: "0 0 0 2px #f7d977" };
        } else {
          highlightState = "off-path";
          style = { ...style, opacity: 0.2 };
        }
      }
      out.push({
        id: node.id,
        position: {
          x: columnIndex * COLUMN_X_SPACING,
          y: rowIndex * ROW_Y_SPACING,
        },
        data: {
          label: displayLabel,
          kind: node.kind,
          flowType,
          subtypeBadge,
          highlightState,
          vhostContext,
          vhostBadge,
          vhostTooltip,
        },
        type: "topology",
        style: {
          ...style,
          padding: "6px 10px",
          borderRadius: 6,
          fontFamily: "system-ui, sans-serif",
          fontSize: 12,
          minWidth: 160,
        },
      });
    });
    columnIndex += 1;
  }
  return out;
}

interface ResolvedNodeStyle {
  style: React.CSSProperties;
  flowType: NodeFlowType;
  subtypeBadge?: string;
}

function resolveNodeStyle(node: GraphNode): ResolvedNodeStyle {
  if (node.kind === "exchange") {
    const type = normalizeExchangeType(node.data);
    const paletteKey = KNOWN_EXCHANGE_TYPES.has(type) ? type : "other";
    return {
      style: EXCHANGE_TYPE_STYLES[paletteKey],
      flowType: `exchange:${type}`,
      subtypeBadge: `[${type}]`,
    };
  }
  if (node.kind === "queue") {
    const type = normalizeQueueType(node.data);
    const paletteKey = type in QUEUE_TYPE_STYLES ? type : "other";
    const base = QUEUE_TYPE_STYLES[paletteKey];
    const durable = isDurable(node.data);
    // Transient queues get a dashed border so an operator can spot ephemeral
    // state without having to click into the details panel.
    const style: React.CSSProperties = durable
      ? { ...base }
      : { ...base, border: dashifyBorder(typeof base.border === "string" ? base.border : undefined) };
    const badgeParts: string[] = [];
    if (type !== "classic") badgeParts.push(type);
    if (!durable) badgeParts.push("transient");
    return {
      style,
      flowType: `queue:${type}`,
      subtypeBadge: badgeParts.length > 0 ? `[${badgeParts.join(",")}]` : undefined,
    };
  }
  return {
    style: NODE_BASE_STYLES[node.kind],
    flowType: node.kind,
  };
}

function normalizeExchangeType(data: unknown): string {
  const ex = data as Partial<Exchange> | undefined;
  const raw = typeof ex?.type === "string" ? (ex.type as ExchangeType).toString() : undefined;
  if (!raw) return "other";
  return raw.toLowerCase();
}

function normalizeQueueType(data: unknown): string {
  const q = data as Partial<Queue> | undefined;
  const raw = q?.arguments?.["x-queue-type"];
  if (typeof raw !== "string" || raw.length === 0) return "classic";
  return raw.toLowerCase();
}

function isDurable(data: unknown): boolean {
  const entity = data as { durable?: unknown } | undefined;
  // Default to true — RabbitMQ definitions omit `durable` on the canonical
  // durable case, so absence should not visually flag a queue as transient.
  return entity?.durable === undefined ? true : Boolean(entity.durable);
}

function dashifyBorder(border: string | undefined): string {
  if (!border) return "1px dashed #555";
  return border.replace(/\bsolid\b/, "dashed");
}

interface VhostLookup {
  vhostById: Map<string, { name: string; hostId?: string }>;
  hostById: Map<string, { name: string }>;
  /** Vhost names that appear on more than one host across the loaded graph. */
  ambiguousVhostNames: Set<string>;
  /**
   * Host **names** that map to more than one distinct `hostId`. When a host
   * name is duplicated (or missing), the badge cannot rely on `hostName` alone
   * to keep entity identity unambiguous, and falls back to `hostId`.
   */
  duplicateHostNames: Set<string>;
}

function buildVhostLookup(nodes: readonly GraphNode[]): VhostLookup {
  const vhostById = new Map<string, { name: string; hostId?: string }>();
  const hostById = new Map<string, { name: string }>();
  const vhostNameHosts = new Map<string, Set<string>>();
  const hostNameIds = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (node.kind === "host") {
      // Read the human-readable name strictly from the canonical `Host` object
      // on `data`. `label` is a display concern (may be truncated / annotated
      // upstream) and is deliberately NOT used as a fallback — the resolver
      // must operate on the canonical model, not on the display layer.
      const hostData = node.data as { name?: unknown } | undefined;
      if (typeof hostData?.name !== "string") continue;
      hostById.set(node.id, { name: hostData.name });
      const seen = hostNameIds.get(hostData.name) ?? new Set<string>();
      seen.add(node.id);
      hostNameIds.set(hostData.name, seen);
    } else if (node.kind === "vhost") {
      const vhostData = node.data as
        | { name?: unknown; hostId?: unknown }
        | undefined;
      if (typeof vhostData?.name !== "string") continue;
      const name = vhostData.name;
      const hostId = typeof vhostData?.hostId === "string" ? vhostData.hostId : undefined;
      vhostById.set(node.id, { name, hostId });
      const seenHosts = vhostNameHosts.get(name) ?? new Set<string>();
      if (hostId !== undefined) seenHosts.add(hostId);
      vhostNameHosts.set(name, seenHosts);
    }
  }
  const ambiguousVhostNames = new Set<string>();
  for (const [name, hostIds] of vhostNameHosts) {
    if (hostIds.size > 1) ambiguousVhostNames.add(name);
  }
  const duplicateHostNames = new Set<string>();
  for (const [name, ids] of hostNameIds) {
    if (ids.size > 1) duplicateHostNames.add(name);
  }
  return { vhostById, hostById, ambiguousVhostNames, duplicateHostNames };
}

function resolveVhostContext(
  node: GraphNode,
  lookup: VhostLookup,
): VhostContext | undefined {
  if (node.kind === "external") {
    const ref = node.data as EndpointRef | undefined;
    const rawVhost = typeof ref?.vhost === "string" ? ref.vhost.trim() : "";
    if (!rawVhost) {
      return {
        isDefault: false,
        ambiguous: false,
        unknown: true,
      };
    }
    return {
      vhostName: rawVhost,
      isDefault: rawVhost === "/",
      ambiguous: false,
      unknown: false,
    };
  }
  if (!NODE_KINDS_WITH_VHOST.has(node.kind)) return undefined;
  const data = node.data as
    | { vhostId?: unknown; hostId?: unknown }
    | undefined;
  const vhostId = typeof data?.vhostId === "string" ? data.vhostId : undefined;
  const dataHostId = typeof data?.hostId === "string" ? data.hostId : undefined;
  if (!vhostId) {
    // Entity carries no canonical vhostId — surface an explicit `unknown vhost`
    // fallback so the badge/tooltip always render for every routing-relevant
    // node kind. A silently-missing badge is worse than an explicit gap: it
    // hides the fact that the source data is incomplete and lets a duplicate
    // queue/exchange name look "clean" when it is actually unresolved.
    const hostEntry = dataHostId ? lookup.hostById.get(dataHostId) : undefined;
    const context: VhostContext = {
      hostId: dataHostId,
      hostName: hostEntry?.name,
      isDefault: false,
      ambiguous: false,
      unknown: true,
    };
    context.hostDiscriminator = pickHostDiscriminator(context, lookup);
    return context;
  }
  const vhostEntry = lookup.vhostById.get(vhostId);
  if (!vhostEntry) {
    const hostId = dataHostId;
    const hostEntry = hostId ? lookup.hostById.get(hostId) : undefined;
    const context: VhostContext = {
      vhostId,
      hostId,
      hostName: hostEntry?.name,
      isDefault: false,
      ambiguous: false,
      unknown: true,
    };
    context.hostDiscriminator = pickHostDiscriminator(context, lookup);
    return context;
  }
  const hostId = vhostEntry.hostId ?? dataHostId;
  const hostEntry = hostId ? lookup.hostById.get(hostId) : undefined;
  const ambiguous = lookup.ambiguousVhostNames.has(vhostEntry.name);
  const context: VhostContext = {
    vhostId,
    vhostName: vhostEntry.name,
    hostId,
    hostName: hostEntry?.name,
    isDefault: vhostEntry.name === "/",
    ambiguous,
    unknown: false,
  };
  context.hostDiscriminator = pickHostDiscriminator(context, lookup);
  return context;
}

/**
 * Resolves the stable per-host discriminator used when a vhost name alone
 * cannot keep entity identity unambiguous. Prefers the human `hostName` when
 * it maps to a unique `hostId`; otherwise falls back to the canonical `hostId`
 * (guaranteed unique per host); otherwise a literal `"unknown-host"` marker
 * so the ambiguous-vhost badge never collapses to just the vhost name.
 */
function pickHostDiscriminator(
  context: VhostContext,
  lookup: VhostLookup,
): string | undefined {
  const nameIsSafe =
    typeof context.hostName === "string" &&
    context.hostName.length > 0 &&
    !lookup.duplicateHostNames.has(context.hostName);
  if (nameIsSafe) return context.hostName;
  if (typeof context.hostId === "string" && context.hostId.length > 0) {
    return context.hostId;
  }
  if (typeof context.hostName === "string" && context.hostName.length > 0) {
    // Host name is the only signal but it's duplicated — surface it anyway
    // rather than "unknown-host", because at least it names the machine class
    // even if the specific host id is missing. Callers that need strict
    // uniqueness can inspect `hostDiscriminator === hostName` alongside the
    // absent `hostId`.
    return context.hostName;
  }
  return undefined;
}

/**
 * Compute a vhost badge for every node with a resolved context, guaranteeing
 * that any two nodes with **distinct** identity disambiguators receive
 * **distinct** truncated badges. Same-disambiguator nodes (e.g. two queues in
 * the same vhost) intentionally share the same badge — that's the correct
 * "same vhost" signal, not a collision.
 *
 * Algorithm:
 *   1. For each node, build `(text, disambiguator)`.
 *   2. If the text fits the budget, the badge is the text (no truncation
 *      needed — text equality across distinct disambiguators is impossible
 *      because `vhostBadgeText` always incorporates the discriminating
 *      identity for the ambiguous/unknown cases).
 *   3. Otherwise, apply hash-suffixed truncation with an **adaptive** hash
 *      length: start at `HASH_LEN_MIN` (4 hex / 16 bits) and — if any two
 *      distinct disambiguators produce the same truncated string — retry
 *      with a longer hash. Cap at `HASH_LEN_MAX` (8 hex / 32-bit FNV).
 *   4. If the 32-bit FNV space itself collides for two distinct
 *      disambiguators (birthday-bound ≈ 65k distinct identities; practically
 *      never for topology metadata), append a deterministic ordinal suffix
 *      to break the remaining ties.
 *
 * The batch approach means small graphs keep the compact 4-hex suffix (the
 * documented `…[0-9a-f]{4}$` format the tests pin) while pathological large
 * graphs transparently step up to a longer hash to preserve uniqueness.
 */
function computeVhostBadgeMap(
  nodes: readonly GraphNode[],
  contextByNodeId: ReadonlyMap<string, VhostContext | undefined>,
): Map<string, string | undefined> {
  interface Entry {
    nodeId: string;
    text: string;
    disambiguator?: string;
  }
  const entries: Entry[] = [];
  for (const node of nodes) {
    const ctx = contextByNodeId.get(node.id);
    if (!ctx) continue;
    entries.push({
      nodeId: node.id,
      text: vhostBadgeText(ctx),
      disambiguator: badgeDisambiguator(ctx),
    });
  }
  const HASH_LEN_MIN = 4;
  const HASH_LEN_MAX = 8;
  for (let hashLen = HASH_LEN_MIN; hashLen <= HASH_LEN_MAX; hashLen += 1) {
    const attempt = new Map<string, string>();
    const disambiguatorForBadge = new Map<string, string | undefined>();
    let collided = false;
    for (const { nodeId, text, disambiguator } of entries) {
      const badge = truncateForBadge(
        text,
        VHOST_BADGE_MAX_CHARS,
        disambiguator,
        hashLen,
      );
      if (disambiguatorForBadge.has(badge)) {
        const prior = disambiguatorForBadge.get(badge);
        // A real collision is two distinct identities sharing the same badge.
        // Same-identity duplicates (two entities in the same vhost) are fine.
        if (prior !== disambiguator) {
          collided = true;
          break;
        }
      } else {
        disambiguatorForBadge.set(badge, disambiguator);
      }
      attempt.set(nodeId, badge);
    }
    if (!collided) return attempt;
  }
  // Astronomical fallback: 32-bit FNV space itself collided for two distinct
  // disambiguators. Assign deterministically by (disambiguator, nodeId) order
  // and append a `-N` ordinal so the final surface is still unique.
  const ordered = [...entries].sort((a, b) => {
    const ad = a.disambiguator ?? "";
    const bd = b.disambiguator ?? "";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.nodeId < b.nodeId ? -1 : 1;
  });
  const usedForDisambiguator = new Map<string, string | undefined>();
  const out = new Map<string, string>();
  for (const { nodeId, text, disambiguator } of ordered) {
    const base = truncateForBadge(
      text,
      VHOST_BADGE_MAX_CHARS,
      disambiguator,
      HASH_LEN_MAX,
    );
    let candidate = base;
    let n = 2;
    while (
      usedForDisambiguator.has(candidate) &&
      usedForDisambiguator.get(candidate) !== disambiguator
    ) {
      const suffix = `-${n}`;
      const keep = Math.max(1, VHOST_BADGE_MAX_CHARS - suffix.length);
      candidate = `${base.slice(0, keep)}${suffix}`;
      n += 1;
    }
    usedForDisambiguator.set(candidate, disambiguator);
    out.set(nodeId, candidate);
  }
  return out;
}

/**
 * Stable identity used to disambiguate truncated badges. Two contexts with
 * different vhost/host identities MUST produce different disambiguators so
 * that the collision-safe truncation guarantees unique output — even for
 * pathological cases where the vhost and host names share a long prefix AND
 * a long suffix. Prefers the canonical `vhostId`; falls back to the compound
 * `host|vhost` name pair for unresolved-vhost contexts (which have no
 * vhostId) so the fallback fills the same "identity" role.
 */
function badgeDisambiguator(context: VhostContext): string | undefined {
  if (context.vhostId) return context.vhostId;
  if (context.hostId || context.hostName) {
    return `${context.hostId ?? ""}|${context.hostName ?? ""}|${context.vhostName ?? ""}`;
  }
  if (context.vhostName || context.hostDiscriminator) {
    return `${context.hostDiscriminator ?? ""}|${context.vhostName ?? ""}`;
  }
  return undefined;
}

function renderVhostTooltip(
  context: VhostContext | undefined,
  lookup: VhostLookup,
): string | undefined {
  if (!context) return undefined;
  const hostSuffix = tooltipHostSuffix(context, lookup);
  if (context.unknown && !context.vhostName) {
    return hostSuffix ? `unknown vhost${hostSuffix}` : "unknown vhost";
  }
  const vhostName = context.vhostName ?? "unknown";
  return hostSuffix ? `vhost ${vhostName}${hostSuffix}` : `vhost ${vhostName}`;
}

function tooltipHostSuffix(context: VhostContext, lookup: VhostLookup): string {
  // When we have a unique human host name, that's enough — the tooltip is the
  // accessible full-value presentation for the compact badge, not an audit
  // dump. When the host name is duplicated across hosts, we ALSO include the
  // canonical `hostId` in parentheses so two badges that would otherwise say
  // the same thing become distinguishable in assistive tech.
  if (context.hostName) {
    const duplicated = lookup.duplicateHostNames.has(context.hostName);
    if (duplicated && context.hostId) {
      return ` on host ${context.hostName} (${context.hostId})`;
    }
    return ` on host ${context.hostName}`;
  }
  if (context.hostId) return ` on host ${context.hostId}`;
  return "";
}

function vhostBadgeText(context: VhostContext): string {
  if (context.unknown && !context.vhostName) {
    // Even the fallback should carry the host discriminator when we have one,
    // so two unresolved queues on two different hosts don't render identically.
    return context.hostDiscriminator
      ? `${context.hostDiscriminator}/unknown vhost`
      : "unknown vhost";
  }
  const vhostName = context.vhostName ?? "unknown";
  // Duplicate vhost names across hosts require the host prefix to keep entity
  // identity unambiguous in a single-line badge; otherwise the vhost alone is
  // enough context and the host stays only in the tooltip. When a host name
  // is itself duplicated (or missing), `hostDiscriminator` falls back to the
  // stable `hostId` so the badge remains unique per-host.
  if (context.ambiguous && context.hostDiscriminator) {
    return `${context.hostDiscriminator}/${vhostName}`;
  }
  return vhostName;
}

/**
 * Collision-safe badge truncation. When the text fits, returns it verbatim.
 * When truncation is needed, applies a stable strategy so any two contexts
 * with distinct `disambiguator` values produce distinct truncated strings:
 *
 *   1. If a disambiguator is provided and the budget can fit a `…<hash>`
 *      suffix, append a `hashLen`-hex-char deterministic hash of the
 *      disambiguator so that distinct identities produce visibly-different
 *      badges — even when the prefix AND suffix of the human text collide.
 *      Caller picks `hashLen` (see {@link computeVhostBadgeMap}); the
 *      adaptive-length batch pass raises it whenever a shorter hash
 *      collides across the current graph's disambiguator set.
 *   2. Otherwise, use middle-out truncation (`<prefix>…<tail>`) so a shared
 *      leading prefix (e.g. `rabbit-cluster-…/orders` vs `…/audit`) still
 *      exposes the discriminating tail.
 *   3. As a last resort (very small budget), tail-truncate with an ellipsis.
 *
 * The hash is deterministic — same `disambiguator` in ⇒ same hash out — so
 * badges stay stable across renders and across sessions.
 */
function truncateForBadge(
  text: string,
  max: number,
  disambiguator: string | undefined,
  hashLen: number,
): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  const OVERHEAD = 1 + hashLen; // "…" + hash
  if (disambiguator && max >= OVERHEAD + 1) {
    const hash = shortStableHash(disambiguator, hashLen);
    const prefixLen = max - OVERHEAD;
    return `${text.slice(0, prefixLen)}…${hash}`;
  }
  if (max >= 3) {
    // Middle-out truncation preserves the tail so common prefixes still
    // leave visually distinct badges when no disambiguator is available.
    const keep = max - 1; // reserve 1 for the ellipsis
    const suffixLen = Math.max(1, Math.floor(keep / 2));
    const prefixLen = Math.max(1, keep - suffixLen);
    return `${text.slice(0, prefixLen)}…${text.slice(-suffixLen)}`;
  }
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Deterministic short hash used purely as a per-context suffix so truncated
 * badges never collide across distinct identities. Uses a simple FNV-1a
 * 32-bit variant — cheap, stable across runs, and adequate for the tiny
 * value space (thousands of vhost contexts per topology). NOT a security
 * hash — never use for anything requiring collision resistance under
 * adversarial input.
 */
function shortStableHash(input: string, hexLen: number): string {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply.
    h = Math.imul(h, 0x01000193);
  }
  // Force to unsigned 32-bit before formatting so `.toString(16)` doesn't
  // produce a stray leading `-` for negative signed values.
  const unsigned = h >>> 0;
  const hex = unsigned.toString(16).padStart(8, "0");
  return hex.slice(-hexLen);
}

function edgeLabel(edge: GraphEdge): string | undefined {
  if (edge.kind === "shovels" || edge.kind === "federates") {
    // Prefer the boundary-annotated label so the operator sees "shovel foo
    // (cross-host)" without hovering. Never treat this as a live rate — the
    // label describes the *configured* flow direction, not observed traffic.
    if (edge.flow) {
      const linkTag = edge.kind === "shovels" ? "shovel" : "federation";
      const name = edge.flow.linkName || edge.label || "";
      return name
        ? `${linkTag} "${name}" · ${describeBoundary(edge.flow.boundary)}`
        : `${linkTag} · ${describeBoundary(edge.flow.boundary)}`;
    }
    if (edge.label) return edge.label;
    return edge.kind;
  }
  if (edge.label) return edge.label;
  if (edge.kind === "binds" || edge.kind === "routes") {
    return edge.routingKey ? `${edge.kind} "${edge.routingKey}"` : edge.kind;
  }
  if (edge.kind === "contains") return undefined;
  return edge.kind;
}
