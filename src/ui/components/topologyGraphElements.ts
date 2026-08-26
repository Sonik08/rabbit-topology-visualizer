import type { BuildGraphResult } from "../../core/graph/buildGraph";
import type { GraphEdge, GraphNode, GraphNodeKind } from "../../core/model";

export interface FlowNode {
  id: string;
  position: { x: number; y: number };
  data: { label: string; kind: GraphNodeKind };
  type: "default";
  style?: React.CSSProperties;
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

const EDGE_STYLES: Record<GraphEdge["kind"], React.CSSProperties> = {
  contains: { stroke: "#bbb", strokeDasharray: "3 2" },
  binds: { stroke: "#2f6feb" },
  routes: { stroke: "#2f6feb" },
  "alternate-exchange": { stroke: "#a56100" },
  "dead-letter": { stroke: "#b00020", strokeDasharray: "5 3" },
  shovels: { stroke: "#8a5c00", strokeWidth: 2 },
  federates: { stroke: "#8a005c", strokeWidth: 2 },
};

/**
 * Convert a `BuildGraphResult` into React-Flow-shaped nodes/edges. Layout is
 * deliberately trivial — a column per {@link GraphNodeKind} in {@link COLUMN_ORDER},
 * nodes stacked vertically within each column in insertion order — so this
 * function stays pure and testable without needing a layout engine. Callers
 * can pan/zoom/drag to refine positions.
 *
 * `contains` edges are omitted by default because they turn a large topology
 * into hair-ball; pass `includeContains: true` to include them.
 */
export function toReactFlowElements(
  graph: BuildGraphResult,
  options: { includeContains?: boolean } = {},
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const positionedNodes = layoutNodes(graph.nodes);
  const flowEdges: FlowEdge[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.edges) {
    if (!options.includeContains && edge.kind === "contains") continue;
    // Drop edges whose endpoints aren't present as nodes — these can occur when
    // a partial import references a queue that never got materialized. Silently
    // dropping keeps React Flow from throwing on unresolved handles.
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    flowEdges.push({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: edgeLabel(edge),
      data: { kind: edge.kind, routingKey: edge.routingKey },
      style: EDGE_STYLES[edge.kind],
      labelStyle: { fontSize: 10, fill: "#333" },
      animated: edge.kind === "shovels" || edge.kind === "federates",
    });
  }
  return { nodes: positionedNodes, edges: flowEdges };
}

function layoutNodes(nodes: GraphNode[]): FlowNode[] {
  const byKind = new Map<GraphNodeKind, GraphNode[]>();
  for (const kind of COLUMN_ORDER) byKind.set(kind, []);
  for (const node of nodes) {
    const bucket = byKind.get(node.kind);
    if (bucket) bucket.push(node);
    else byKind.set(node.kind, [node]);
  }
  const out: FlowNode[] = [];
  let columnIndex = 0;
  for (const kind of COLUMN_ORDER) {
    const bucket = byKind.get(kind) ?? [];
    if (bucket.length === 0) {
      columnIndex += 1;
      continue;
    }
    bucket.forEach((node, rowIndex) => {
      out.push({
        id: node.id,
        position: {
          x: columnIndex * COLUMN_X_SPACING,
          y: rowIndex * ROW_Y_SPACING,
        },
        data: { label: node.label, kind: node.kind },
        type: "default",
        style: {
          ...NODE_BASE_STYLES[kind],
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

function edgeLabel(edge: GraphEdge): string | undefined {
  if (edge.label) return edge.label;
  if (edge.kind === "binds" || edge.kind === "routes") {
    return edge.routingKey ? `${edge.kind} "${edge.routingKey}"` : edge.kind;
  }
  if (edge.kind === "contains") return undefined;
  return edge.kind;
}
