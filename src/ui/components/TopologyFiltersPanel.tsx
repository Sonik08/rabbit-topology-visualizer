import { useMemo, type ChangeEvent } from "react";
import type {
  BuildGraphResult,
} from "../../core/graph/buildGraph";
import type { GraphFilters } from "../../core/graph/filterGraph";
import type { GraphEdgeKind, GraphNodeKind } from "../../core/model";

export interface FilterState {
  hostIds: Set<string>;
  vhostIds: Set<string>;
  entityKinds: Set<GraphNodeKind>;
  edgeKinds: Set<GraphEdgeKind>;
  routingKeyQuery: string;
  maxDepth: number;
}

export const DEFAULT_MAX_DEPTH = 32;
export const MAX_DEPTH_ABSOLUTE = 128;

export function createEmptyFilterState(): FilterState {
  return {
    hostIds: new Set(),
    vhostIds: new Set(),
    entityKinds: new Set(),
    edgeKinds: new Set(),
    routingKeyQuery: "",
    maxDepth: DEFAULT_MAX_DEPTH,
  };
}

/**
 * Projects the raw {@link FilterState} into a {@link GraphFilters} object that
 * is safe to hand to `applyGraphFilters`. Empty routing-key query becomes
 * undefined so a whitespace-only field never accidentally excludes every edge.
 */
export function toGraphFilters(state: FilterState): GraphFilters {
  const trimmed = state.routingKeyQuery.trim();
  return {
    hostIds: state.hostIds,
    vhostIds: state.vhostIds,
    entityKinds: state.entityKinds,
    edgeKinds: state.edgeKinds,
    routingKeyQuery: trimmed.length > 0 ? trimmed : undefined,
  };
}

export interface TopologyFiltersPanelProps {
  graph: BuildGraphResult;
  filters: FilterState;
  onChange: (next: FilterState) => void;
}

const ALL_NODE_KINDS: GraphNodeKind[] = [
  "host",
  "vhost",
  "exchange",
  "queue",
  "shovel",
  "federation",
  "external",
];

const ALL_EDGE_KINDS: GraphEdgeKind[] = [
  "contains",
  "binds",
  "routes",
  "shovels",
  "federates",
  "alternate-exchange",
  "dead-letter",
];

/**
 * Compact filter bar for the topology graph. All controls are checkboxes +
 * a text input + a numeric depth slider, so keyboard-only use works out of
 * the box. Selection state is fully controlled — the panel calls `onChange`
 * with a fresh {@link FilterState} on every user interaction, never mutating
 * the passed-in Set instances.
 */
export function TopologyFiltersPanel({
  graph,
  filters,
  onChange,
}: TopologyFiltersPanelProps): JSX.Element {
  const availableHosts = useMemo(
    () => collectHosts(graph),
    [graph],
  );
  const availableVhosts = useMemo(
    () => collectVhosts(graph),
    [graph],
  );

  const toggleFrom = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const onHostToggle = (id: string) =>
    onChange({ ...filters, hostIds: toggleFrom(filters.hostIds, id) });
  const onVhostToggle = (id: string) =>
    onChange({ ...filters, vhostIds: toggleFrom(filters.vhostIds, id) });
  const onEntityKindToggle = (kind: GraphNodeKind) =>
    onChange({ ...filters, entityKinds: toggleFrom(filters.entityKinds, kind) });
  const onEdgeKindToggle = (kind: GraphEdgeKind) =>
    onChange({ ...filters, edgeKinds: toggleFrom(filters.edgeKinds, kind) });
  const onRoutingKeyChange = (e: ChangeEvent<HTMLInputElement>) =>
    onChange({ ...filters, routingKeyQuery: e.target.value });
  const onDepthChange = (e: ChangeEvent<HTMLInputElement>) =>
    onChange({ ...filters, maxDepth: clampDepth(Number(e.target.value)) });
  const onReset = () => onChange(createEmptyFilterState());

  return (
    <section
      aria-label="Topology filters"
      data-testid="topology-filters-panel"
      style={panelStyle}
    >
      <header style={headerStyle}>
        <h4 style={{ margin: 0 }}>Filters</h4>
        <button
          type="button"
          onClick={onReset}
          data-testid="topology-filters-reset"
          style={resetButtonStyle}
        >
          Reset
        </button>
      </header>

      {availableHosts.length > 0 && (
        <fieldset style={fieldsetStyle} data-testid="topology-filters-hosts">
          <legend style={legendStyle}>Host</legend>
          {availableHosts.map((h) => (
            <label key={h.id} style={checkboxStyle}>
              <input
                type="checkbox"
                checked={filters.hostIds.has(h.id)}
                onChange={() => onHostToggle(h.id)}
                data-testid={`topology-filters-host-${h.id}`}
              />
              {h.label}
            </label>
          ))}
        </fieldset>
      )}

      {availableVhosts.length > 0 && (
        <fieldset style={fieldsetStyle} data-testid="topology-filters-vhosts">
          <legend style={legendStyle}>Vhost</legend>
          {availableVhosts.map((v) => (
            <label key={v.id} style={checkboxStyle}>
              <input
                type="checkbox"
                checked={filters.vhostIds.has(v.id)}
                onChange={() => onVhostToggle(v.id)}
                data-testid={`topology-filters-vhost-${v.id}`}
              />
              {v.label}
            </label>
          ))}
        </fieldset>
      )}

      <fieldset style={fieldsetStyle} data-testid="topology-filters-entity-kinds">
        <legend style={legendStyle}>Entity type</legend>
        {ALL_NODE_KINDS.map((kind) => (
          <label key={kind} style={checkboxStyle}>
            <input
              type="checkbox"
              checked={filters.entityKinds.has(kind)}
              onChange={() => onEntityKindToggle(kind)}
              data-testid={`topology-filters-entity-${kind}`}
            />
            {kind}
          </label>
        ))}
      </fieldset>

      <fieldset style={fieldsetStyle} data-testid="topology-filters-edge-kinds">
        <legend style={legendStyle}>Edge type</legend>
        {ALL_EDGE_KINDS.map((kind) => (
          <label key={kind} style={checkboxStyle}>
            <input
              type="checkbox"
              checked={filters.edgeKinds.has(kind)}
              onChange={() => onEdgeKindToggle(kind)}
              data-testid={`topology-filters-edge-${kind}`}
            />
            {kind}
          </label>
        ))}
      </fieldset>

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Routing key</legend>
        <input
          type="text"
          value={filters.routingKeyQuery}
          onChange={onRoutingKeyChange}
          placeholder="substring, case-insensitive"
          data-testid="topology-filters-routing-key"
          style={textInputStyle}
        />
      </fieldset>

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>
          Upstream depth ({filters.maxDepth}
          {filters.maxDepth === DEFAULT_MAX_DEPTH ? " · default" : ""})
        </legend>
        <input
          type="range"
          min={0}
          max={MAX_DEPTH_ABSOLUTE}
          step={1}
          value={filters.maxDepth}
          onChange={onDepthChange}
          data-testid="topology-filters-max-depth"
        />
      </fieldset>
    </section>
  );
}

function clampDepth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_DEPTH;
  if (value < 0) return 0;
  if (value > MAX_DEPTH_ABSOLUTE) return MAX_DEPTH_ABSOLUTE;
  return Math.floor(value);
}

function collectHosts(graph: BuildGraphResult): Array<{ id: string; label: string }> {
  const seen = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind !== "host") continue;
    if (!seen.has(node.id)) seen.set(node.id, node.label);
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
}

function collectVhosts(graph: BuildGraphResult): Array<{ id: string; label: string }> {
  const seen = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind !== "vhost") continue;
    if (!seen.has(node.id)) seen.set(node.id, node.label);
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
}

const panelStyle: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 6,
  padding: "0.6rem 0.9rem",
  fontFamily: "system-ui, sans-serif",
  fontSize: "0.8rem",
  marginBottom: "0.6rem",
  background: "#f8f8fb",
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const fieldsetStyle: React.CSSProperties = {
  border: "1px solid #e0e0e6",
  borderRadius: 4,
  padding: "0.2rem 0.4rem",
  margin: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: "0.35rem",
  alignItems: "center",
};

const legendStyle: React.CSSProperties = {
  padding: "0 0.2rem",
  color: "#555",
  fontSize: "0.7rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const checkboxStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.15rem",
  cursor: "pointer",
};

const textInputStyle: React.CSSProperties = {
  padding: "0.2rem 0.4rem",
  border: "1px solid #ccc",
  borderRadius: 4,
  minWidth: 200,
};

const resetButtonStyle: React.CSSProperties = {
  padding: "0.2rem 0.5rem",
  border: "1px solid #999",
  background: "#fff",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: "0.75rem",
};
