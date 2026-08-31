import { useCallback, useMemo, useState, type ChangeEvent } from "react";
import type { ImportResult } from "../../core/import";
import { aggregateImportedTopology } from "../../core/import";
import { buildTopologyIndexes } from "../../core/graph/indexes";
import type { IndexedEntity } from "../../core/graph/indexes";
import { findEntity, type EntitySearchKind } from "../../core/query/findEntity";
import {
  fuzzyFindEntity,
  type FuzzySearchMatch,
} from "../../core/query/fuzzyFindEntity";

export interface EntitySearchBoxProps {
  result: ImportResult;
  /** Maximum results rendered per section. Default 25. */
  limit?: number;
  /** Fires when the user selects an entity from the results list. */
  onSelect?: (entity: IndexedEntity) => void;
}

type KindFilter = EntitySearchKind;

const KIND_LABEL: Record<KindFilter, string> = {
  either: "Queues & exchanges",
  exchange: "Exchanges",
  queue: "Queues",
};

const REASON_LABEL: Record<FuzzySearchMatch["reason"], string> = {
  exact: "exact",
  prefix: "prefix",
  substring: "substring",
  subsequence: "subsequence",
};

/**
 * Search-box UI over a single `ImportResult`. Builds `TopologyIndexes` on
 * demand from the imported topology, then combines the exact `findEntity`
 * result (elevated on top when it exists) with the fuzzy `fuzzyFindEntity`
 * ranking. Kind filter defaults to `either` (queues + exchanges).
 */
export function EntitySearchBox({
  result,
  limit = 25,
  onSelect,
}: EntitySearchBoxProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("either");

  const indexes = useMemo(
    () => buildTopologyIndexes(aggregateImportedTopology(result)),
    [result],
  );

  const trimmed = query.trim();
  const searchState = useMemo(() => {
    if (trimmed.length === 0) {
      return { exact: [] as IndexedEntity[], fuzzy: [] as FuzzySearchMatch[] };
    }
    const exactResult = findEntity(indexes, trimmed, { kind });
    const exactIds = new Set(exactResult.matches.map((e) => e.id));
    // Fuzzy results always exclude entities already surfaced by the exact
    // block so the same name doesn't appear twice in the list.
    const fuzzy = fuzzyFindEntity(indexes, trimmed, { kind, limit })
      .filter((m) => !exactIds.has(m.entity.id));
    return { exact: exactResult.matches, fuzzy };
  }, [indexes, trimmed, kind, limit]);

  const onQueryChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
    [],
  );
  const onKindChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => setKind(e.target.value as KindFilter),
    [],
  );

  const total = searchState.exact.length + searchState.fuzzy.length;

  return (
    <section aria-label="Search topology" data-testid="entity-search-box" style={panelStyle}>
      <h2 style={{ marginTop: 0 }}>Search queues & exchanges</h2>
      <div style={controlsStyle}>
        <label style={{ flex: 1 }}>
          <span style={{ display: "block", fontSize: "0.85rem" }}>Query</span>
          <input
            type="search"
            aria-label="Search query"
            data-testid="entity-search-query"
            value={query}
            onChange={onQueryChange}
            placeholder="e.g. orders.in"
            style={inputStyle}
          />
        </label>
        <label>
          <span style={{ display: "block", fontSize: "0.85rem" }}>Kind</span>
          <select
            aria-label="Kind filter"
            data-testid="entity-search-kind"
            value={kind}
            onChange={onKindChange}
            style={selectStyle}
          >
            <option value="either">{KIND_LABEL.either}</option>
            <option value="exchange">{KIND_LABEL.exchange}</option>
            <option value="queue">{KIND_LABEL.queue}</option>
          </select>
        </label>
      </div>

      {trimmed.length === 0 ? (
        <p style={hintStyle} data-testid="entity-search-hint">
          Type a name to search {KIND_LABEL[kind].toLowerCase()} across the
          imported topology.
        </p>
      ) : total === 0 ? (
        <p style={hintStyle} data-testid="entity-search-empty">
          No matches for <code>{trimmed}</code>.
        </p>
      ) : (
        <div data-testid="entity-search-results">
          {searchState.exact.length > 0 && (
            <div>
              <h3 style={sectionHeadingStyle}>
                Exact matches ({searchState.exact.length})
              </h3>
              <ul style={listStyle} data-testid="entity-search-exact">
                {searchState.exact.map((entity) => (
                  <li key={entity.id}>
                    <ResultRow entity={entity} onSelect={onSelect} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {searchState.fuzzy.length > 0 && (
            <div>
              <h3 style={sectionHeadingStyle}>
                Fuzzy matches ({searchState.fuzzy.length})
              </h3>
              <ul style={listStyle} data-testid="entity-search-fuzzy">
                {searchState.fuzzy.map((match) => (
                  <li key={match.entity.id}>
                    <ResultRow
                      entity={match.entity}
                      onSelect={onSelect}
                      trailing={
                        <span style={fuzzyMetaStyle}>
                          {REASON_LABEL[match.reason]} · score{" "}
                          {match.score.toFixed(2)}
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface ResultRowProps {
  entity: IndexedEntity;
  onSelect?: (entity: IndexedEntity) => void;
  trailing?: React.ReactNode;
}

function ResultRow({ entity, onSelect, trailing }: ResultRowProps): JSX.Element {
  const body = (
    <span style={rowBodyStyle}>
      <span style={kindBadgeStyle(entity.kind)}>{entity.kind}</span>
      <code style={{ fontWeight: 600 }}>{entity.name}</code>
      {entity.hostId && (
        <span style={{ color: "#666" }}>· host <code>{entity.hostId}</code></span>
      )}
      {entity.vhostId && entity.vhostId !== entity.hostId && (
        <span style={{ color: "#666" }}>· vhost <code>{entity.vhostId}</code></span>
      )}
      {trailing}
    </span>
  );
  if (onSelect) {
    return (
      <button
        type="button"
        onClick={() => onSelect(entity)}
        style={rowButtonStyle}
        data-testid={`entity-search-result-${entity.id}`}
      >
        {body}
      </button>
    );
  }
  return <span data-testid={`entity-search-result-${entity.id}`}>{body}</span>;
}

const panelStyle: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 6,
  padding: "clamp(0.75rem, 2vw, 1rem)",
  fontFamily: "system-ui, sans-serif",
  // Fluid width — see ImportPanel.tsx `panelStyle` for the shared rationale.
  width: "100%",
  maxWidth: "100%",
  boxSizing: "border-box",
  marginTop: "1rem",
};

const controlsStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  alignItems: "flex-end",
  flexWrap: "wrap",
  marginBottom: "0.5rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.4rem 0.6rem",
  border: "1px solid #999",
  borderRadius: 4,
  fontSize: "0.95rem",
  boxSizing: "border-box",
};

const selectStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #999",
  borderRadius: 4,
  fontSize: "0.95rem",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "0.25rem 0",
};

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: "0.95rem",
  margin: "0.5rem 0 0.25rem",
};

const hintStyle: React.CSSProperties = {
  color: "#555",
  fontStyle: "italic",
  margin: "0.5rem 0",
};

const rowBodyStyle: React.CSSProperties = {
  display: "inline-flex",
  gap: "0.5rem",
  alignItems: "center",
  flexWrap: "wrap",
};

const rowButtonStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.35rem 0.5rem",
  border: "1px solid transparent",
  borderRadius: 4,
  background: "transparent",
  textAlign: "left",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: "0.95rem",
};

const fuzzyMetaStyle: React.CSSProperties = {
  color: "#666",
  fontSize: "0.8rem",
};

function kindBadgeStyle(kind: IndexedEntity["kind"]): React.CSSProperties {
  const palette: Record<string, string> = {
    exchange: "#2f6feb",
    queue: "#248559",
    host: "#8a3f00",
    vhost: "#6a3fa5",
    shovel: "#8a5c00",
    federation: "#8a005c",
    policy: "#555",
  };
  return {
    display: "inline-block",
    padding: "0.1rem 0.4rem",
    borderRadius: 4,
    background: palette[kind] ?? "#555",
    color: "#fff",
    fontSize: "0.7rem",
    textTransform: "uppercase",
  };
}
