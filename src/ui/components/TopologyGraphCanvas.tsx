import { useCallback, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "reactflow";
import "reactflow/dist/style.css";
import { buildGraph } from "../../core/graph/buildGraph";
import { computeUpstreamHighlight } from "../../core/graph/upstreamHighlight";
import { aggregateImportedTopology } from "../../core/import";
import type { ImportResult } from "../../core/import";
import { EntityDetailsPanel } from "./EntityDetailsPanel";
import { PathExplanationPanel } from "./PathExplanationPanel";
import { toReactFlowElements, type FlowEdge, type FlowNode } from "./topologyGraphElements";

export interface TopologyGraphCanvasProps {
  result: ImportResult;
  /** Whether to render `contains` edges (host→vhost→entity). Off by default; they clutter big graphs. */
  includeContains?: boolean;
  /** Canvas height in pixels. Default 520. */
  heightPx?: number;
}

/**
 * Interactive React Flow canvas showing the imported RabbitMQ topology.
 * Nodes are grouped into vertical columns by kind (`host` → `vhost` →
 * `external` → `exchange` → `shovel`/`federation` → `queue`) so the
 * intuition-flow reads left-to-right; users can pan/zoom/drag to refine.
 *
 * Purely presentational — no selection/highlight state yet (that's the next
 * task); this component just renders the graph and exposes React Flow's
 * built-in controls + minimap for navigation.
 */
export function TopologyGraphCanvas({
  result,
  includeContains = false,
  heightPx = 520,
}: TopologyGraphCanvasProps): JSX.Element {
  const [showContains, setShowContains] = useState(includeContains);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);

  const graph = useMemo(() => {
    const aggregated = aggregateImportedTopology(result);
    return buildGraph(aggregated);
  }, [result]);

  const highlight = useMemo(
    () => computeUpstreamHighlight(graph, selectedNodeId),
    [graph, selectedNodeId],
  );

  const flowGraph = useMemo(
    () =>
      toReactFlowElements(graph, {
        includeContains: showContains,
        highlight: highlight.nodeIds.size > 0 ? highlight : undefined,
      }),
    [graph, showContains, highlight],
  );

  const onNodeClick = useCallback<NodeMouseHandler>((_, node) => {
    setSelectedNodeId((prev) => (prev === node.id ? undefined : node.id));
  }, []);

  const clearSelection = useCallback(() => setSelectedNodeId(undefined), []);

  const selectedNode = useMemo(
    () => (selectedNodeId ? graph.nodes.find((n) => n.id === selectedNodeId) : undefined),
    [graph, selectedNodeId],
  );

  const selectionSummary = useMemo(() => {
    if (!selectedNodeId) return undefined;
    if (!selectedNode) return `Selected: ${selectedNodeId} (not in graph)`;
    if (selectedNode.kind !== "queue" && selectedNode.kind !== "exchange") {
      return `Selected ${selectedNode.kind}: ${selectedNode.label} — upstream highlight only supports queues and exchanges.`;
    }
    const ancestorCount = highlight.nodeIds.size > 0 ? highlight.nodeIds.size - 1 : 0;
    const truncated = highlight.traversal?.truncated ? " (truncated at max depth)" : "";
    return `Upstream of ${selectedNode.kind} '${selectedNode.label}': ${ancestorCount} ancestor${
      ancestorCount === 1 ? "" : "s"
    }, ${highlight.edgeIds.size} edge${highlight.edgeIds.size === 1 ? "" : "s"}${truncated}.`;
  }, [selectedNodeId, selectedNode, highlight]);

  return (
    <section
      aria-label="Topology graph"
      data-testid="topology-graph-canvas"
      style={panelStyle}
    >
      <div style={headerRowStyle}>
        <h2 style={{ margin: 0 }}>Topology graph</h2>
        <label style={{ fontSize: "0.85rem", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={showContains}
            onChange={(e) => setShowContains(e.target.checked)}
            data-testid="topology-graph-contains-toggle"
            style={{ marginRight: "0.35rem" }}
          />
          Show <code>contains</code> edges
        </label>
      </div>
      <p style={statsLineStyle} data-testid="topology-graph-stats">
        {flowGraph.nodes.length} nodes · {flowGraph.edges.length} edges
        {selectedNodeId ? " · click background or the same node again to clear selection" : " · click a queue or exchange to highlight its upstream path"}
      </p>
      {selectionSummary && (
        <div style={selectionBarStyle} data-testid="topology-graph-selection-summary">
          <span>{selectionSummary}</span>
          <button
            type="button"
            onClick={clearSelection}
            data-testid="topology-graph-clear-selection"
            style={clearButtonStyle}
          >
            Clear selection
          </button>
        </div>
      )}
      <div style={{ height: heightPx, border: "1px solid #ddd", borderRadius: 6 }}>
        <ReactFlow
          nodes={flowGraph.nodes as unknown as Node[]}
          edges={flowGraph.edges as unknown as Edge[]}
          fitView
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          nodesConnectable={false}
          minZoom={0.1}
          maxZoom={2}
          onNodeClick={onNodeClick}
          onPaneClick={clearSelection}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <EntityDetailsPanel node={selectedNode} />
      <PathExplanationPanel traversal={highlight.traversal} nodes={graph.nodes} />
    </section>
  );
}

export type { FlowNode, FlowEdge };

const panelStyle: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 6,
  padding: "1rem",
  fontFamily: "system-ui, sans-serif",
  maxWidth: 1080,
  marginTop: "1rem",
};

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "0.25rem",
};

const statsLineStyle: React.CSSProperties = {
  margin: "0.25rem 0 0.5rem",
  color: "#555",
  fontSize: "0.85rem",
};

const selectionBarStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "0.4rem 0.6rem",
  marginBottom: "0.5rem",
  background: "#fffbe6",
  border: "1px solid #f4c542",
  borderRadius: 4,
  fontSize: "0.8rem",
};

const clearButtonStyle: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  border: "1px solid #b08a20",
  background: "#fff",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: "0.75rem",
};
