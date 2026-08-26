import { useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
} from "reactflow";
import "reactflow/dist/style.css";
import { buildGraph } from "../../core/graph/buildGraph";
import { aggregateImportedTopology } from "../../core/import";
import type { ImportResult } from "../../core/import";
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

  const flowGraph = useMemo(() => {
    const aggregated = aggregateImportedTopology(result);
    const graph = buildGraph(aggregated);
    return toReactFlowElements(graph, { includeContains: showContains });
  }, [result, showContains]);

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
      </p>
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
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
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
