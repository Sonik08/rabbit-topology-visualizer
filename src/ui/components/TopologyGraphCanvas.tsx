import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "reactflow";
import "reactflow/dist/style.css";
import type { FlowNodeData } from "./topologyGraphElements";
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
  createEmptyVisibility,
  type VisibilityState,
} from "../../core/graph/visibility";
import { composeFocusedTopology } from "./topologyRenderPipeline";
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
  /**
   * When set, the canvas switches into **focused mode** and clips the
   * rendered graph to the routing-edge neighborhood around `focusNodeId`
   * (via {@link pruneNeighborhood}). Structural `contains` ancestry of the
   * kept nodes is preserved so hosts/vhosts stay visible above their child
   * entities. Selection highlighting still runs on top of the focused
   * subgraph. Omit the prop to render the full topology.
   */
  focusNodeId?: string;
  /**
   * Fires when the user activates the "Show full topology" action in the
   * focused-mode banner. Callers should clear `focusNodeId` in response.
   * When absent, the button is not rendered and the caller retains full
   * control of when to exit focused mode.
   */
  onFocusChange?: (id: string | undefined) => void;
  /**
   * Maximum hop count for focused-mode clipping. Defaults to 3 (matches
   * `pruneNeighborhood`'s own default). Ignored when `focusNodeId` is absent.
   */
  focusMaxDepth?: number;
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
    focusNodeId,
    onFocusChange,
    focusMaxDepth,
  } = props;
  const [showContains, setShowContains] = useState(includeContains);
  // Full-page mode — when true, the canvas overlays the whole viewport via
  // `position: fixed` styling. State (selection, focus, filters, visibility,
  // configured-flow pause) is held in this component's own `useState` hooks,
  // so entering / leaving full-page mode does NOT unmount the canvas and
  // therefore does NOT reset any of that state.
  const [isFullPage, setIsFullPage] = useState(false);
  const toggleFullPage = useCallback(() => setIsFullPage((prev) => !prev), []);
  const exitFullPage = useCallback(() => setIsFullPage(false), []);
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

  // Post-filter render pipeline: visibility overlay → optional focused-mode
  // clip → shape for React Flow. Extracted into `composeFocusedTopology` so
  // pipeline-composition tests can call the exact same function the canvas
  // does — reordering or bypassing a stage in the canvas's wiring shows up
  // as a regression against `composeFocusedTopology`.
  const composition = useMemo(
    () =>
      composeFocusedTopology({
        graph,
        visibility,
        focusNodeId,
        focusMaxDepth,
      }),
    [graph, visibility, focusNodeId, focusMaxDepth],
  );
  const visible = composition.visible;
  const focused = composition.focused;

  const flowGraph = useMemo(
    () =>
      toReactFlowElements(composition.renderInput, {
        includeContains: showContains,
        highlight: highlight.nodeIds.size > 0 ? highlight : undefined,
        configuredFlowMotion,
        // Resolve entity badges from the complete canonical graph, not the
        // post-filter/post-visibility render graph. Hiding a host or vhost
        // container must not erase context from a still-visible queue.
        contextNodes: rawGraph.nodes,
      }),
    [composition, showContains, highlight, configuredFlowMotion, rawGraph.nodes],
  );

  const onNodeClick = useCallback<NodeMouseHandler>((_, node) => {
    setSelectedNodeId((prev) => (prev === node.id ? undefined : node.id));
  }, []);

  const clearSelection = useCallback(() => setSelectedNodeId(undefined), []);

  // Capture the ReactFlow instance so we can call `fitView()` whenever the
  // focused subgraph changes — the task specifically calls out that a
  // focused result must "fit the resulting graph into view" so a search that
  // clips the graph doesn't leave the viewport zoomed/panned to the wrong
  // spot from before the clip.
  const rfInstanceRef = useRef<ReactFlowInstance | undefined>(undefined);
  const handleReactFlowInit = useCallback((instance: ReactFlowInstance) => {
    rfInstanceRef.current = instance;
  }, []);
  useEffect(() => {
    // Refit whenever focused mode changes (activation, target change, or
    // deactivation) OR the full-page overlay toggles — both mutate the
    // effective graph area and the ReactFlow viewport would otherwise stay
    // panned/zoomed to the pre-change size. The initial mount is already
    // handled by ReactFlow's `fitView` prop; extra idempotent calls here
    // are invisible to the user. `focused` is a memo keyed on focusNodeId
    // + graph, so its identity change captures both "user opened focus"
    // and "graph rebuilt while focused" transitions.
    if (!rfInstanceRef.current) return;
    rfInstanceRef.current.fitView({ duration: 0 });
  }, [focused, isFullPage]);
  // Explicit fit-on-resize wiring. React Flow does not guarantee a fit-view
  // refresh when its container's box changes size (only when nodes/edges
  // do) — a browser resize that reflows the fluid graph shell would
  // otherwise leave the viewport panned/zoomed to the pre-resize size.
  // Attach a `ResizeObserver` to the graph container and call `fitView` on
  // every observed size change. `fitView` is idempotent when the graph is
  // already fit, so we don't need to filter the initial notification —
  // an extra call at mount is invisible to the user. This same observer
  // handles the full-page-mode toggle: entering / leaving the mode changes
  // the graph shell size, the observer fires, the graph refits.
  const graphContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = graphContainerRef.current;
    if (!container) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      rfInstanceRef.current?.fitView({ duration: 0 });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  // Full-page mode: bind Escape to exit and lock body scroll so the user
  // interacts only with the overlay. `document`/`body` guards keep this
  // resilient to non-DOM test environments.
  useEffect(() => {
    if (!isFullPage) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        exitFullPage();
      }
    };
    document.addEventListener("keydown", handleKey);
    const previousBodyOverflow = document.body?.style.overflow;
    if (document.body) document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      if (document.body) document.body.style.overflow = previousBodyOverflow ?? "";
    };
  }, [isFullPage, exitFullPage]);

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
      data-fullpage={isFullPage ? "true" : "false"}
      style={isFullPage ? fullPagePanelStyle : panelStyle}
    >
      <div style={headerRowStyle}>
        <h2 style={{ margin: 0 }}>Topology graph</h2>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
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
          <button
            type="button"
            onClick={toggleFullPage}
            aria-pressed={isFullPage}
            aria-label={isFullPage ? "Exit full-page graph" : "Enter full-page graph"}
            data-testid="topology-graph-fullpage-toggle"
            style={fullPageToggleStyle}
          >
            {isFullPage ? "Exit full page (Esc)" : "Full page"}
          </button>
        </div>
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
      {focused && (
        <div style={focusBarStyle} data-testid="topology-graph-focus-summary">
          <span>
            {focused.focusMissing
              ? `Focus target '${focused.focusNodeId}' is not in the current graph — showing an empty focused view.`
              : `Focused on ${focused.focusNodeId}: ${focused.nodes.length} node${
                  focused.nodes.length === 1 ? "" : "s"
                }, ${focused.edges.length} edge${focused.edges.length === 1 ? "" : "s"}${
                  focused.truncated ? " (truncated at max depth)" : ""
                }.`}
          </span>
          {onFocusChange && (
            <button
              type="button"
              onClick={() => onFocusChange(undefined)}
              data-testid="topology-graph-clear-focus"
              style={clearButtonStyle}
            >
              Show full topology
            </button>
          )}
        </div>
      )}
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
      <div
        ref={graphContainerRef}
        style={isFullPage ? fullPageGraphShellStyle : graphContainerStyle(heightPx)}
      >
        <ReactFlow
          nodes={flowGraph.nodes as unknown as Node[]}
          edges={flowGraph.edges as unknown as Edge[]}
          nodeTypes={TOPOLOGY_NODE_TYPES}
          fitView
          onInit={handleReactFlowInit}
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
  padding: "clamp(0.75rem, 2vw, 1rem)",
  fontFamily: "system-ui, sans-serif",
  // Fluid — the graph shell fills its parent container width at every
  // breakpoint. React Flow inside a fluid container observes its own size,
  // so the graph re-fits automatically on viewport resize.
  width: "100%",
  maxWidth: "100%",
  boxSizing: "border-box",
  marginTop: "1rem",
};

/**
 * Full-page overlay style. When the user activates the full-page toggle
 * the canvas becomes a `position: fixed` overlay spanning the entire
 * viewport, above the App shell. Uses column flex so the graph shell can
 * consume `flex: 1` and fill remaining space after the header / bars /
 * filter/visibility panels. `background: #fff` avoids see-through onto the
 * page underneath; `overflow: auto` keeps auxiliary panels reachable when
 * their combined height exceeds the viewport.
 */
const fullPagePanelStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  padding: "clamp(0.75rem, 2vw, 1rem)",
  fontFamily: "system-ui, sans-serif",
  background: "#fff",
  boxSizing: "border-box",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

/**
 * In full-page mode the graph consumes all remaining vertical space after
 * the header, bars, and panels above it. `flex: 1 1 auto` + a small
 * `minHeight` guard means the container is always at least tall enough for
 * React Flow's own controls to remain reachable on very short viewports.
 */
const fullPageGraphShellStyle: React.CSSProperties = {
  flex: "1 1 auto",
  minHeight: "50vh",
  width: "100%",
  border: "1px solid #ddd",
  borderRadius: 6,
  boxSizing: "border-box",
};

const fullPageToggleStyle: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  border: "1px solid #4a80cc",
  background: "#eaf3ff",
  color: "#1e3a72",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: "0.8rem",
};

/**
 * Fluid graph-container height. Uses `min(70vh, heightPx)` — the graph
 * takes 70 % of the viewport height, capped at the caller's ideal ceiling
 * (`heightPx`, default 520). No hard pixel floor: on a short mobile
 * viewport (e.g. 400 px tall) 70 vh resolves to 280 px, well within the
 * viewport, instead of being pinned to a 320 px minimum that could exceed
 * the remaining space after headers/panels. The graph itself remains
 * usable at any size because React Flow scales its rendering with the
 * container.
 */
function graphContainerStyle(heightPx: number): React.CSSProperties {
  return {
    height: `min(70vh, ${heightPx}px)`,
    width: "100%",
    border: "1px solid #ddd",
    borderRadius: 6,
    boxSizing: "border-box",
  };
}

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  // Allow controls to wrap onto multiple lines at narrow widths instead of
  // clipping past the panel edge.
  flexWrap: "wrap",
  gap: "0.5rem",
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
  // Wrap on narrow viewports so the "Clear selection" button drops onto its
  // own line instead of being clipped or forcing horizontal overflow.
  flexWrap: "wrap",
  gap: "0.5rem",
  padding: "0.4rem 0.6rem",
  marginBottom: "0.5rem",
  background: "#fffbe6",
  border: "1px solid #f4c542",
  borderRadius: 4,
  fontSize: "0.8rem",
};

const focusBarStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  // Wrap on narrow viewports — see `selectionBarStyle`.
  flexWrap: "wrap",
  gap: "0.5rem",
  padding: "0.4rem 0.6rem",
  marginBottom: "0.5rem",
  background: "#eaf3ff",
  border: "1px solid #4a80cc",
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

/**
 * Custom React Flow node that renders the entity label AND surfaces the
 * resolved vhost context as a real `title`+`aria-label` on the wrapper.
 * This is the accessibility path for the compact vhost badge: the visible
 * badge is truncated at 24 chars, but the full unabbreviated tooltip text
 * (`vhost <name> on host <host>`, or the `unknown vhost` fallback) always
 * reaches assistive tech and mouse-hover tooltips without an extra popover.
 */
const TopologyEntityNode = memo(function TopologyEntityNode({
  data,
}: NodeProps<FlowNodeData>): JSX.Element {
  const tooltip = data.vhostTooltip;
  // Accessibility contract: the accessible name MUST identify the entity by
  // its full label (name + subtype badge + compact vhost badge) — never the
  // vhost context alone. `aria-label` overrides the visible text, so if we
  // set it to just the tooltip, a screen reader would only hear the vhost
  // and lose the queue/exchange/shovel/federation identity. Compose both:
  // "<visible label>, <full vhost context>" so users hear entity identity
  // FIRST, then the disambiguating full-context announcement. When there is
  // no tooltip (host/vhost nodes), `aria-label` is omitted so the visible
  // text remains the accessible name via the default a11y-tree rules.
  const accessibleName = tooltip ? `${data.label}, ${tooltip}` : undefined;
  // React Flow's default node ships with `<Handle>` connectors so edges can
  // attach. We replicate that (source at bottom, target at top) so the graph
  // continues to render with the same visual affordances after switching to a
  // custom node type. Only the `topology` node type is used, so both handles
  // are always safe to expose.
  return (
    <div
      data-testid="topology-graph-node"
      data-vhost-tooltip={tooltip ?? ""}
      title={tooltip}
      aria-label={accessibleName}
      style={nodeInnerStyle}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span>{data.label}</span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});

const nodeInnerStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  lineHeight: 1.2,
};

const TOPOLOGY_NODE_TYPES: NodeTypes = {
  topology: TopologyEntityNode,
};
