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
import {
  getSharedTopologyWorkerClient,
  type ImportArchiveWorkerClient,
  type ImportResult,
} from "../../core/import";
import { EntityDetailsPanel } from "./EntityDetailsPanel";
import { PathExplanationPanel } from "./PathExplanationPanel";
import {
  createEmptyFilterState,
  TopologyFiltersPanel,
  type FilterState,
} from "./TopologyFiltersPanel";
import { TopologyVisibilityPanel } from "./TopologyVisibilityPanel";
import {
  ConfiguredFlowLegend,
  usePrefersReducedMotion,
} from "./ConfiguredFlowLegend";
import {
  applyVisibility,
  createEmptyVisibility,
  type VisibilityState,
} from "../../core/graph/visibility";
import { toReactFlowElements, type FlowEdge, type FlowNode } from "./topologyGraphElements";
import { useTopologyGraph } from "../hooks/useTopologyGraph";

export interface TopologyGraphCanvasProps {
  result: ImportResult;
  /** Whether to render `contains` edges (host→vhost→entity). Off by default; they clutter big graphs. */
  includeContains?: boolean;
  /** Canvas height in pixels. Default 520. */
  heightPx?: number;
  /**
   * Worker client used for the off-main-thread graph build + upstream
   * traversal calls. Defaults to the process-wide shared client (which
   * transparently falls back to a same-thread implementation when `Worker`
   * is unavailable). Test injection point.
   */
  workerClient?: ImportArchiveWorkerClient;
  /**
   * Controlled selection input. Presence of the prop (even set to
   * `undefined`) puts the canvas in controlled mode: this value is
   * authoritative, the internal fallback state is bypassed, and every
   * canvas-initiated selection change is reported through
   * {@link onSelectionChange}. Omitting the prop entirely leaves the canvas
   * in uncontrolled mode with its own internal selection state. Wire from
   * `App.tsx` to let sibling components (e.g. `EntitySearchBox`) drive the
   * highlighted node.
   */
  selectedNodeId?: string;
  /**
   * Fires when the canvas would change the selection — clicking a node,
   * clicking the pane, pressing "Clear selection". Callers running in
   * controlled mode should update their state here; controlled-mode canvases
   * with no callback silently no-op on canvas-initiated changes.
   */
  onSelectionChange?: (id: string | undefined) => void;
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
export function TopologyGraphCanvas(props: TopologyGraphCanvasProps): JSX.Element {
  // Detect controlled mode from the presence of the `selectedNodeId` prop
  // BEFORE destructuring — passing `selectedNodeId={undefined}` explicitly
  // still counts as controlled, matching the documented contract. If the
  // parent controls the selection but forgets to wire `onSelectionChange`,
  // canvas-initiated changes silently no-op (rather than corrupting an
  // uncontrolled internal state); this is the same footgun as React's own
  // controlled-input pattern.
  const isControlled = Object.prototype.hasOwnProperty.call(props, "selectedNodeId");
  const {
    result,
    includeContains = false,
    heightPx = 520,
    workerClient,
    selectedNodeId: selectedNodeIdProp,
    onSelectionChange,
  } = props;
  const [showContains, setShowContains] = useState(includeContains);
  const [internalSelectedNodeId, setInternalSelectedNodeId] = useState<string | undefined>(undefined);
  const selectedNodeId = isControlled ? selectedNodeIdProp : internalSelectedNodeId;
  const setSelectedNodeId = useCallback(
    (updater: string | undefined | ((prev: string | undefined) => string | undefined)) => {
      if (isControlled) {
        const next =
          typeof updater === "function" ? updater(selectedNodeIdProp) : updater;
        onSelectionChange?.(next);
      } else {
        setInternalSelectedNodeId(updater);
      }
    },
    [isControlled, onSelectionChange, selectedNodeIdProp],
  );
  const [filters, setFilters] = useState<FilterState>(() => createEmptyFilterState());
  const [visibility, setVisibility] = useState<VisibilityState>(() => createEmptyVisibility());
  const [configuredFlowPaused, setConfiguredFlowPaused] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const configuredFlowMotion = useMemo(
    () => ({ paused: configuredFlowPaused, reducedMotion }),
    [configuredFlowPaused, reducedMotion],
  );

  // Resolve the worker client once so the hook effect deps stay stable —
  // `getSharedTopologyWorkerClient()` is a lazy singleton so this is free.
  const client = useMemo(
    () => workerClient ?? getSharedTopologyWorkerClient(),
    [workerClient],
  );

  const { rawGraph, graph, highlight, buildLoading, highlightLoading, selectedNode } =
    useTopologyGraph({ result, filters, selectedNodeId, workerClient: client });

  // Visibility overlay runs synchronously on top of the filtered graph — it
  // is a pure user-driven allow/deny list so an off-thread trip isn't worth
  // the state-management cost. `applyVisibility` is O(V+E) and reversible.
  const visible = useMemo(() => applyVisibility(graph, visibility), [graph, visibility]);

  const flowGraph = useMemo(
    () =>
      toReactFlowElements(
        {
          nodes: visible.nodes,
          edges: visible.edges,
          diagnostics: visible.diagnostics,
        },
        {
          includeContains: showContains,
          highlight: highlight.nodeIds.size > 0 ? highlight : undefined,
          configuredFlowMotion,
        },
      ),
    [visible, showContains, highlight, configuredFlowMotion],
  );

  const onNodeClick = useCallback<NodeMouseHandler>((_, node) => {
    setSelectedNodeId((prev) => (prev === node.id ? undefined : node.id));
  }, []);

  const clearSelection = useCallback(() => setSelectedNodeId(undefined), []);

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
        {flowGraph.nodes.length} nodes · {flowGraph.edges.length} edges (of {rawGraph.nodes.length} · {rawGraph.edges.length})
        {buildLoading ? " · building graph…" : ""}
        {highlightLoading ? " · computing upstream…" : ""}
        {!buildLoading && !highlightLoading && (selectedNodeId ? " · click background or the same node again to clear selection" : " · click a queue or exchange to highlight its upstream path")}
      </p>
      <ConfiguredFlowLegend
        paused={configuredFlowPaused}
        reducedMotion={reducedMotion}
        onTogglePause={() => setConfiguredFlowPaused((prev) => !prev)}
      />
      <TopologyFiltersPanel graph={rawGraph} filters={filters} onChange={setFilters} />
      <TopologyVisibilityPanel
        graph={graph}
        visibility={visibility}
        counts={visible.counts}
        effectivelyHidden={visible.effectivelyHidden}
        selectedNodeId={selectedNodeId}
        onChange={setVisibility}
      />
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
