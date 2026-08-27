import { useMemo, useState, type ChangeEvent } from "react";
import type { BuildGraphResult } from "../../core/graph/buildGraph";
import type { GraphNode } from "../../core/model";
import {
  clearIsolation,
  hideNodes,
  isolateNeighborhood,
  resetVisibility,
  restoreNodes,
  type VisibilityCounts,
  type VisibilityState,
} from "../../core/graph/visibility";

export interface TopologyVisibilityPanelProps {
  /**
   * The post-filter, pre-visibility graph — same input `applyVisibility` runs
   * over. Passing the raw un-filtered graph here would make the searchable
   * list surface entities that broad filters have already removed from the
   * canvas, and would make `restoreNodes` compute isolation membership
   * against a different node set than the overlay uses.
   */
  graph: BuildGraphResult;
  visibility: VisibilityState;
  counts: VisibilityCounts;
  /** The full list of ids that are hidden right now (from applyVisibility). */
  effectivelyHidden: ReadonlySet<string>;
  /** Currently selected node id in the canvas, if any. Powers "hide this" / "isolate this". */
  selectedNodeId: string | undefined;
  onChange: (next: VisibilityState) => void;
}

/**
 * Compact per-entity visibility bar. Renders:
 *   - A visible-vs-total count summary.
 *   - Actions on the current selection: "Hide selected" and
 *     "Show only selected + neighborhood".
 *   - A hidden-item list with per-item "Show" buttons and a "Reset all" action.
 *   - A searchable checkbox list of every queue/exchange in the graph so a
 *     user can pick individual entities to hide without going through the
 *     canvas.
 */
export function TopologyVisibilityPanel({
  graph,
  visibility,
  counts,
  effectivelyHidden,
  selectedNodeId,
  onChange,
}: TopologyVisibilityPanelProps): JSX.Element {
  const [query, setQuery] = useState("");

  const searchableEntities = useMemo(
    () =>
      graph.nodes.filter(
        (n) => n.kind === "queue" || n.kind === "exchange",
      ),
    [graph],
  );

  const normalizedQuery = useMemo(() => query.trim().toLowerCase(), [query]);
  const hasActiveQuery = normalizedQuery.length > 0;

  const filteredEntities = useMemo(() => {
    if (!hasActiveQuery) return searchableEntities;
    return searchableEntities.filter(
      (n) =>
        n.label.toLowerCase().includes(normalizedQuery) ||
        n.id.toLowerCase().includes(normalizedQuery),
    );
  }, [hasActiveQuery, normalizedQuery, searchableEntities]);

  const hiddenList: GraphNode[] = useMemo(() => {
    const list: GraphNode[] = [];
    for (const n of graph.nodes) {
      if (effectivelyHidden.has(n.id)) list.push(n);
    }
    return list;
  }, [graph, effectivelyHidden]);

  const onSearch = (e: ChangeEvent<HTMLInputElement>): void => setQuery(e.target.value);
  const onToggle = (nodeId: string): void => {
    if (effectivelyHidden.has(nodeId)) {
      onChange(restoreNodes(graph, visibility, [nodeId]));
    } else {
      onChange(hideNodes(visibility, [nodeId]));
    }
  };
  const onHideSelected = (): void => {
    if (!selectedNodeId) return;
    onChange(hideNodes(visibility, [selectedNodeId]));
  };
  const onIsolateSelected = (): void => {
    if (!selectedNodeId) return;
    onChange(isolateNeighborhood(visibility, selectedNodeId));
  };
  const onClearIsolation = (): void => onChange(clearIsolation(visibility));
  const onRestore = (nodeId: string): void =>
    onChange(restoreNodes(graph, visibility, [nodeId]));
  const onResetAll = (): void => onChange(resetVisibility());
  /**
   * Bulk-hide every queue/exchange that matches the active search across the
   * ENTIRE searchable list (not just the first 100 rendered by the capped
   * checkbox list). Guarded to no-op on an empty/whitespace query so nothing
   * can trigger an accidental hide-all. The reducer used is the same
   * immutable `hideNodes(state, ids)` powering the checkbox toggle — no
   * mutation, so `visibility.hiddenNodeIds` on the caller's side is
   * unaffected, and any active `isolatedFocus` is preserved (the hides
   * layer on top of isolation, same as an individual checkbox hide).
   */
  const onHideAllMatches = (): void => {
    if (!hasActiveQuery) return;
    const ids = filteredEntities.map((n) => n.id);
    if (ids.length === 0) return;
    onChange(hideNodes(visibility, ids));
  };
  const hiddenMatchingEntityIds = useMemo(
    () =>
      filteredEntities
        .filter((n) => effectivelyHidden.has(n.id))
        .map((n) => n.id),
    [effectivelyHidden, filteredEntities],
  );

  /**
   * Companion action: bulk-restore every hidden match — useful after a
   * "Hide all matches" or when the user searches for a substring shared by a
   * batch of already-hidden nodes. Unlike bulk hide, an empty search is safe:
   * it means "show every hidden queue/exchange" and cannot remove data. Reuses
   * `restoreNodes` so isolation-hidden matches also come back (clearing
   * `isolatedFocus` when needed, same semantics as the per-pill Show button).
   */
  const onShowAllMatches = (): void => {
    if (hiddenMatchingEntityIds.length === 0) return;
    onChange(restoreNodes(graph, visibility, hiddenMatchingEntityIds));
  };

  return (
    <section
      aria-label="Topology visibility"
      data-testid="topology-visibility-panel"
      style={panelStyle}
    >
      <header style={headerRowStyle}>
        <h4 style={{ margin: 0 }}>Visibility</h4>
        <span data-testid="topology-visibility-counts" style={countsStyle}>
          {counts.visibleNodes}/{counts.totalNodes} nodes · {counts.visibleEdges}/{counts.totalEdges} edges
          {counts.hiddenNodeCount > 0 ? ` · ${counts.hiddenNodeCount} hidden` : ""}
        </span>
      </header>

      <div style={actionsRowStyle}>
        <button
          type="button"
          onClick={onHideSelected}
          disabled={!selectedNodeId}
          data-testid="topology-visibility-hide-selected"
          style={buttonStyle}
        >
          Hide selected
        </button>
        <button
          type="button"
          onClick={onIsolateSelected}
          disabled={!selectedNodeId}
          data-testid="topology-visibility-isolate-selected"
          style={buttonStyle}
        >
          Show only selected + neighborhood
        </button>
        {visibility.isolatedFocus && (
          <button
            type="button"
            onClick={onClearIsolation}
            data-testid="topology-visibility-clear-isolation"
            style={buttonStyle}
          >
            Clear isolation
          </button>
        )}
        <button
          type="button"
          onClick={onResetAll}
          data-testid="topology-visibility-reset-all"
          style={buttonStyle}
        >
          Reset all
        </button>
      </div>

      {hiddenList.length > 0 && (
        <div data-testid="topology-visibility-hidden-list" style={hiddenListStyle}>
          <span style={hiddenListHeaderStyle}>Hidden ({hiddenList.length}):</span>
          {hiddenList.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => onRestore(n.id)}
              data-testid={`topology-visibility-restore-${n.id}`}
              style={pillButtonStyle}
              title={`Restore ${n.label}`}
            >
              {n.label} ✕
            </button>
          ))}
        </div>
      )}

      <fieldset style={searchFieldsetStyle}>
        <legend style={legendStyle}>Search queues/exchanges</legend>
        <div style={searchRowStyle}>
          <input
            type="text"
            value={query}
            onChange={onSearch}
            placeholder="substring, case-insensitive"
            data-testid="topology-visibility-search"
            style={searchInputStyle}
          />
          <button
            type="button"
            onClick={onHideAllMatches}
            disabled={!hasActiveQuery || filteredEntities.length === 0}
            data-testid="topology-visibility-hide-all-matches"
            title={
              hasActiveQuery
                ? `Hide every queue/exchange matching "${normalizedQuery}" (${filteredEntities.length} match${filteredEntities.length === 1 ? "" : "es"})`
                : "Enter a search term to enable bulk hide"
            }
            style={bulkButtonStyle}
          >
            Hide all matches ({hasActiveQuery ? filteredEntities.length : 0})
          </button>
          <button
            type="button"
            onClick={onShowAllMatches}
            disabled={hiddenMatchingEntityIds.length === 0}
            data-testid="topology-visibility-show-all-matches"
            title={
              hasActiveQuery
                ? `Restore every hidden queue/exchange matching "${normalizedQuery}" (${hiddenMatchingEntityIds.length})`
                : `Restore every hidden queue/exchange (${hiddenMatchingEntityIds.length})`
            }
            style={bulkButtonStyle}
          >
            Show all matches ({hiddenMatchingEntityIds.length})
          </button>
        </div>
        <div data-testid="topology-visibility-entity-list" style={entityListStyle}>
          {filteredEntities.slice(0, 100).map((n) => {
            const hidden = effectivelyHidden.has(n.id);
            return (
              <label
                key={n.id}
                style={entityRowStyle}
                data-testid={`topology-visibility-entity-${n.id}`}
              >
                <input
                  type="checkbox"
                  checked={!hidden}
                  onChange={() => onToggle(n.id)}
                  data-testid={`topology-visibility-toggle-${n.id}`}
                />
                <span style={{ opacity: hidden ? 0.4 : 1 }}>
                  {n.kind === "queue" ? "🟦" : "🟩"} {n.label}
                </span>
              </label>
            );
          })}
          {filteredEntities.length > 100 && (
            <p style={truncatedStyle}>
              …{filteredEntities.length - 100} more. Refine the search to see the rest.
            </p>
          )}
        </div>
      </fieldset>
    </section>
  );
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
  gap: "0.4rem",
};

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const countsStyle: React.CSSProperties = {
  color: "#555",
  fontSize: "0.75rem",
};

const actionsRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.35rem",
  flexWrap: "wrap",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.2rem 0.5rem",
  border: "1px solid #999",
  background: "#fff",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: "0.75rem",
};

const hiddenListStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.3rem",
  alignItems: "center",
  padding: "0.3rem 0.4rem",
  background: "#fff4e0",
  borderRadius: 4,
  border: "1px solid #f0c060",
};

const hiddenListHeaderStyle: React.CSSProperties = {
  color: "#7a5010",
  fontSize: "0.7rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const pillButtonStyle: React.CSSProperties = {
  padding: "0.15rem 0.45rem",
  border: "1px solid #b0862a",
  background: "#fff9ec",
  borderRadius: 12,
  cursor: "pointer",
  fontSize: "0.72rem",
};

const searchFieldsetStyle: React.CSSProperties = {
  border: "1px solid #e0e0e6",
  borderRadius: 4,
  padding: "0.2rem 0.4rem",
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

const legendStyle: React.CSSProperties = {
  padding: "0 0.2rem",
  color: "#555",
  fontSize: "0.7rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const searchInputStyle: React.CSSProperties = {
  padding: "0.2rem 0.4rem",
  border: "1px solid #ccc",
  borderRadius: 4,
  minWidth: 200,
};

const searchRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.35rem",
  alignItems: "center",
  flexWrap: "wrap",
};

const bulkButtonStyle: React.CSSProperties = {
  padding: "0.2rem 0.5rem",
  border: "1px solid #7a5010",
  background: "#fff9ec",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: "0.72rem",
};

const entityListStyle: React.CSSProperties = {
  maxHeight: 160,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
  padding: "0.2rem 0.1rem",
};

const entityRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.35rem",
  cursor: "pointer",
};

const truncatedStyle: React.CSSProperties = {
  margin: "0.2rem 0 0",
  color: "#777",
  fontSize: "0.72rem",
};
