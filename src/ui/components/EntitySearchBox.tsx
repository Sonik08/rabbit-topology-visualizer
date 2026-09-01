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
      return {
        exact: [] as IndexedEntity[],
        fuzzy: [] as FuzzySearchMatch[],
        ambiguity: undefined as AmbiguityDescriptor | undefined,
        fuzzyTruncated: false,
      };
    }
    const exactResult = findEntity(indexes, trimmed, { kind });
    const exactIds = new Set(exactResult.matches.map((e) => e.id));
    // Fuzzy results always exclude entities already surfaced by the exact
    // block so the same name doesn't appear twice in the list.
    //
    // Truncation detection: request `limit + exactIds.size + 1` from the
    // scorer so that AFTER excluding every exact match we still have at least
    // `limit + 1` fuzzy candidates left. Naively asking for `limit + 1` here
    // was wrong — an exact match that also scored well would occupy one of
    // those `limit + 1` slots, get filtered out, and leave the truncation
    // check comparing a shrunken post-filter length against `limit`, silently
    // missing genuine truncation (regression: 3 exact + 5 real fuzzy at
    // limit=3 would return `limit+1=4` fuzzy, remove the 3 exact overlaps,
    // leave 1 fuzzy — `truncated` reads false even though 4 fuzzy matches
    // were dropped by the cap). The +1 on top of the exact budget preserves
    // the sentinel-slot rule that distinguishes "exactly `limit` matches"
    // from "at least one candidate was dropped."
    const oversampled = fuzzyFindEntity(indexes, trimmed, {
      kind,
      limit: limit + exactIds.size + 1,
    }).filter((m) => !exactIds.has(m.entity.id));
    const fuzzy = oversampled.slice(0, limit);
    const fuzzyTruncated = oversampled.length > fuzzy.length;
    return {
      exact: exactResult.matches,
      fuzzy,
      ambiguity: describeAmbiguity(exactResult.matches),
      fuzzyTruncated,
    };
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
          {searchState.ambiguity && (
            <AmbiguityBanner
              descriptor={searchState.ambiguity}
              onSelect={onSelect}
            />
          )}
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
              {searchState.fuzzyTruncated && (
                <p
                  style={truncatedHintStyle}
                  data-testid="entity-search-fuzzy-truncated"
                >
                  Showing the top {searchState.fuzzy.length} fuzzy matches —
                  more results were truncated. Narrow your query or raise the
                  result limit to see the rest.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Describes when a user-typed name resolves to more than one entity so the
 * search UI can surface an actionable disambiguation prompt instead of
 * silently letting the operator pick an arbitrary duplicate. Two distinct
 * shapes matter:
 *
 * - `same-kind`: the same name+kind appears across multiple hosts/vhosts
 *   (e.g. queue `orders.in` on host A AND host B). This is the classic
 *   "which cluster did you mean?" ambiguity — the strongest signal.
 * - `cross-kind`: the same name resolves to entities of different kinds
 *   (e.g. exchange `audit` AND queue `audit`). Less severe but still worth
 *   surfacing so the operator picks the right kind.
 * - `mixed`: both conditions hold at once.
 *
 * Ambiguity is only reported when there are ≥2 exact matches; a single
 * unique exact hit is by definition unambiguous.
 */
interface AmbiguityDescriptor {
  severity: "same-kind" | "cross-kind" | "mixed";
  totalMatches: number;
  duplicateName: string;
  /**
   * Full `IndexedEntity` per variant — the banner renders one clickable
   * chooser button per variant and forwards the entity to `onSelect`, so a
   * search-driven focused-flow pick never has to walk back through the
   * generic result list when the name is ambiguous.
   */
  variants: IndexedEntity[];
}

function describeAmbiguity(
  matches: IndexedEntity[],
): AmbiguityDescriptor | undefined {
  if (matches.length < 2) return undefined;
  // Group by (name, kind) — a same-kind duplicate lives in a group of size >1.
  const byNameKind = new Map<string, IndexedEntity[]>();
  for (const m of matches) {
    const key = `${m.name}|${m.kind}`;
    const bucket = byNameKind.get(key);
    if (bucket) bucket.push(m);
    else byNameKind.set(key, [m]);
  }
  const hasSameKindDuplicates = [...byNameKind.values()].some(
    (bucket) => bucket.length > 1,
  );
  const kinds = new Set(matches.map((m) => m.kind));
  const hasCrossKindDuplicates = kinds.size > 1;
  if (!hasSameKindDuplicates && !hasCrossKindDuplicates) return undefined;
  const severity: AmbiguityDescriptor["severity"] =
    hasSameKindDuplicates && hasCrossKindDuplicates
      ? "mixed"
      : hasSameKindDuplicates
        ? "same-kind"
        : "cross-kind";
  return {
    severity,
    totalMatches: matches.length,
    // Every exact match shares the typed query text; use the first entity's
    // canonical name for the human message so we don't surface `.trim()`d
    // input verbatim.
    duplicateName: matches[0]!.name,
    variants: matches,
  };
}

function AmbiguityBanner({
  descriptor,
  onSelect,
}: {
  descriptor: AmbiguityDescriptor;
  onSelect?: (entity: IndexedEntity) => void;
}): JSX.Element {
  const heading =
    descriptor.severity === "cross-kind"
      ? `Ambiguous name '${descriptor.duplicateName}': matches ${descriptor.totalMatches} entities across kinds`
      : descriptor.severity === "same-kind"
        ? `Ambiguous name '${descriptor.duplicateName}': ${descriptor.totalMatches} matches across hosts/vhosts`
        : `Ambiguous name '${descriptor.duplicateName}': ${descriptor.totalMatches} matches across kinds AND hosts/vhosts`;
  return (
    <aside
      role="alert"
      data-testid="entity-search-ambiguity"
      data-severity={descriptor.severity}
      style={ambiguityBannerStyle}
    >
      <strong>{heading}.</strong>{" "}
      <span>
        Pick a specific host/vhost variant below — the focused-flow view can
        only walk one target at a time and will never silently choose one for
        you.
      </span>
      <ul style={ambiguityListStyle} data-testid="entity-search-ambiguity-choices">
        {descriptor.variants.map((variant) => (
          <li key={variant.id}>
            <button
              type="button"
              onClick={onSelect ? () => onSelect(variant) : undefined}
              disabled={!onSelect}
              style={ambiguityChoiceStyle}
              data-testid={`entity-search-ambiguity-choice-${variant.id}`}
            >
              <span style={kindBadgeStyle(variant.kind)}>{variant.kind}</span>
              <code style={{ fontWeight: 600 }}>{variant.name}</code>
              {variant.hostId && (
                <span style={ambiguityMetaStyle}>
                  · host <code>{variant.hostId}</code>
                </span>
              )}
              {variant.vhostId && variant.vhostId !== variant.hostId && (
                <span style={ambiguityMetaStyle}>
                  · vhost <code>{variant.vhostId}</code>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </aside>
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

const ambiguityBannerStyle: React.CSSProperties = {
  border: "1px solid #b58900",
  background: "#fff8e1",
  color: "#5a4400",
  padding: "0.5rem 0.75rem",
  borderRadius: 4,
  margin: "0.25rem 0 0.5rem",
  fontSize: "0.85rem",
};

const ambiguityListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "0.5rem 0 0",
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

const ambiguityChoiceStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
  width: "100%",
  padding: "0.35rem 0.5rem",
  border: "1px solid #b58900",
  borderRadius: 4,
  background: "#fff",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: "0.85rem",
  textAlign: "left",
};

const ambiguityMetaStyle: React.CSSProperties = {
  color: "#5a4400",
  fontSize: "0.75rem",
};

const truncatedHintStyle: React.CSSProperties = {
  color: "#555",
  fontSize: "0.8rem",
  fontStyle: "italic",
  margin: "0.35rem 0 0",
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
