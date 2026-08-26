import type { BuildGraphResult } from "../../core/graph/buildGraph";
import type {
  Exchange,
  ExchangeType,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
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
}

export interface UpstreamHighlightInput {
  /** Node ids that participate in the upstream ancestry (includes the target). */
  nodeIds: Set<string>;
  /** Edge ids that form the reverse path back to the target. */
  edgeIds: Set<string>;
  /** The selected node id; rendered with a stronger outline. */
  targetNodeId?: string;
}

export interface FlowNode {
  id: string;
  position: { x: number; y: number };
  data: FlowNodeData;
  type: "default";
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
  data: { kind: GraphEdge["kind"]; routingKey?: string };
  animated?: boolean;
  style?: React.CSSProperties;
  labelStyle?: React.CSSProperties;
  markerEnd?: FlowEdgeMarker;
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
  options: { includeContains?: boolean; highlight?: UpstreamHighlightInput } = {},
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const positionedNodes = layoutNodes(graph.nodes, options.highlight);
  const flowEdges: FlowEdge[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const highlight = options.highlight;
  const highlightActive = highlight !== undefined && highlight.nodeIds.size > 0;
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
    flowEdges.push({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: edgeLabel(edge),
      data: { kind: edge.kind, routingKey: edge.routingKey },
      style,
      labelStyle: highlightActive && !onPath
        ? { fontSize: 10, fill: "#333", opacity: 0.15 }
        : { fontSize: 10, fill: "#333" },
      animated: edge.kind === "shovels" || edge.kind === "federates",
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
): FlowNode[] {
  const byKind = new Map<GraphNodeKind, GraphNode[]>();
  for (const kind of COLUMN_ORDER) byKind.set(kind, []);
  for (const node of nodes) {
    const bucket = byKind.get(node.kind);
    if (bucket) bucket.push(node);
    else byKind.set(node.kind, [node]);
  }
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
      const displayLabel = subtypeBadge ? `${subtypeBadge} ${node.label}` : node.label;
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
        },
        type: "default",
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

function edgeLabel(edge: GraphEdge): string | undefined {
  if (edge.label) return edge.label;
  if (edge.kind === "binds" || edge.kind === "routes") {
    return edge.routingKey ? `${edge.kind} "${edge.routingKey}"` : edge.kind;
  }
  if (edge.kind === "contains") return undefined;
  return edge.kind;
}
