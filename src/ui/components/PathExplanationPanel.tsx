import { useMemo } from "react";
import type { GraphNode } from "../../core/model";
import { explainUpstreamPath, type PathExplanation } from "../../core/query/pathExplain";
import type { UpstreamTraversalResult } from "../../core/graph/traversal";

export interface PathExplanationPanelProps {
  /**
   * Traversal result for the currently selected queue or exchange. When
   * absent, undefined, or with no paths the panel renders an empty-state hint.
   */
  traversal?: UpstreamTraversalResult;
  /** Graph nodes, used to resolve labels/host/vhost context for each step. */
  nodes: readonly GraphNode[];
  /** Cap the number of rendered path sections. Default 12. */
  maxPaths?: number;
}

/**
 * Renders one section per upstream path (source → target), listing each hop as
 * a human-readable sentence produced by `explainUpstreamPath`. The panel is
 * purely presentational — no interactivity — so it works well for skimming or
 * copy-pasting into an incident report.
 */
const DEFAULT_MAX_PATHS = 12;

/**
 * Coerces the caller-supplied cap to a non-negative integer. Negative,
 * fractional, or non-finite values would produce surprising `slice()`
 * semantics (negative slices count from the end), so anything invalid falls
 * back to the default and negatives are floored to zero.
 */
function normalizeMaxPaths(input: number | undefined): number {
  if (input === undefined) return DEFAULT_MAX_PATHS;
  if (!Number.isFinite(input)) return DEFAULT_MAX_PATHS;
  if (input < 0) return 0;
  return Math.floor(input);
}

export function PathExplanationPanel({
  traversal,
  nodes,
  maxPaths,
}: PathExplanationPanelProps): JSX.Element {
  const cap = normalizeMaxPaths(maxPaths);
  const explanations = useMemo<PathExplanation[]>(() => {
    if (!traversal || traversal.paths.length === 0) return [];
    return traversal.paths.map((p) => explainUpstreamPath(p, traversal.targetNodeId, nodes));
  }, [traversal, nodes]);

  if (!traversal) {
    return (
      <aside
        aria-label="Upstream path explanation"
        data-testid="path-explanation-panel"
        style={emptyPanelStyle}
      >
        <em>Select a queue or exchange to see how messages reach it.</em>
      </aside>
    );
  }

  if (explanations.length === 0) {
    return (
      <aside
        aria-label="Upstream path explanation"
        data-testid="path-explanation-panel"
        style={emptyPanelStyle}
      >
        <em>No upstream publishers found for this node.</em>
      </aside>
    );
  }

  const shown = explanations.slice(0, cap);
  const hidden = explanations.length - shown.length;

  return (
    <aside
      aria-label="Upstream path explanation"
      data-testid="path-explanation-panel"
      style={panelStyle}
    >
      <header style={headerRowStyle}>
        <h4 style={headingStyle}>Upstream paths</h4>
        <span style={countStyle} data-testid="path-explanation-count">
          {explanations.length} path{explanations.length === 1 ? "" : "s"}
          {traversal.truncated ? " · truncated at max depth" : ""}
        </span>
      </header>
      <ol style={listStyle}>
        {shown.map((explanation, index) => (
          <li
            // Compose the key from source/target IDs PLUS the ordered edge
            // sequence so two paths that share endpoints but traverse
            // different intermediate edges (e.g. multi-key parallel bindings)
            // don't collide during React reconciliation. Index is included as
            // a final tiebreaker in case two paths happen to share source,
            // target, AND edge sequence (rare, but cheap to guard against).
            key={`${explanation.sourceNodeId}->${explanation.targetNodeId}|${explanation.steps.map((s) => s.edgeId).join(">")}#${index}`}
            style={pathItemStyle}
            data-testid={`path-explanation-item-${index}`}
          >
            <div style={pathHeaderStyle}>
              <span style={pathIndexStyle}>Path {index + 1}</span>
              <span style={pathRangeStyle}>
                {shortenId(explanation.sourceNodeId)} → {shortenId(explanation.targetNodeId)}
              </span>
            </div>
            {explanation.steps.length === 0 ? (
              <p style={emptyStepStyle}>Source is the target — no upstream hops.</p>
            ) : (
              <ol style={stepListStyle}>
                {explanation.steps.map((step, stepIndex) => (
                  <li
                    key={step.edgeId}
                    style={stepStyle}
                    data-testid={`path-explanation-item-${index}-step-${stepIndex}`}
                  >
                    {step.sentence}
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>
      {hidden > 0 && (
        <p style={hiddenNoteStyle} data-testid="path-explanation-hidden">
          {hidden} more path{hidden === 1 ? "" : "s"} not shown (cap: {cap}).
        </p>
      )}
    </aside>
  );
}

/**
 * Compresses long canonical ids like `exchange:host:a:vhost:/:orders` to
 * `…:orders` when the id is longer than a short glance. Cosmetic only — the
 * panel's authoritative content is the per-step sentences, which already
 * carry human labels.
 */
function shortenId(id: string): string {
  if (id.length <= 42) return id;
  const tail = id.slice(-38);
  return `…${tail}`;
}

const panelStyle: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 6,
  padding: "0.75rem 1rem",
  fontFamily: "system-ui, sans-serif",
  fontSize: "0.85rem",
  marginTop: "0.75rem",
  background: "#fbfbff",
};

const emptyPanelStyle: React.CSSProperties = {
  ...panelStyle,
  color: "#666",
};

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  marginBottom: "0.4rem",
};

const headingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.9rem",
};

const countStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "#555",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};

const pathItemStyle: React.CSSProperties = {
  border: "1px solid #e2e6f0",
  borderRadius: 4,
  padding: "0.35rem 0.55rem",
  background: "#fff",
};

const pathHeaderStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "baseline",
  marginBottom: "0.2rem",
};

const pathIndexStyle: React.CSSProperties = {
  fontWeight: 600,
};

const pathRangeStyle: React.CSSProperties = {
  color: "#666",
  fontSize: "0.75rem",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  wordBreak: "break-all",
};

const stepListStyle: React.CSSProperties = {
  paddingLeft: "1.2rem",
  margin: "0.2rem 0",
};

const stepStyle: React.CSSProperties = {
  margin: "0.1rem 0",
};

const emptyStepStyle: React.CSSProperties = {
  margin: "0.1rem 0",
  color: "#666",
  fontStyle: "italic",
};

const hiddenNoteStyle: React.CSSProperties = {
  marginTop: "0.4rem",
  marginBottom: 0,
  color: "#666",
  fontSize: "0.75rem",
};
