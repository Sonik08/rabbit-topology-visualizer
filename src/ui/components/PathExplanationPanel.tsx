import { useMemo } from "react";
import type { GraphNode } from "../../core/model";
import {
  explainDownstreamPath,
  explainUpstreamPath,
  type PathExplanation,
} from "../../core/query/pathExplain";
import type {
  DownstreamTraversalResult,
  UpstreamTraversalResult,
} from "../../core/graph/traversal";

export interface PathExplanationPanelProps {
  /**
   * Upstream traversal result for the currently selected queue / exchange /
   * shovel / federation. When absent, undefined, or with no paths the panel
   * renders the empty-state hint for the incoming section.
   */
  traversal?: UpstreamTraversalResult;
  /**
   * Downstream traversal result — populated when the selection is one of the
   * four supported entry points. When present, the panel renders a second
   * "Downstream paths" section so the operator sees the full incoming +
   * outgoing chain in one view.
   */
  downstream?: DownstreamTraversalResult;
  /** Graph nodes, used to resolve labels/host/vhost context for each step. */
  nodes: readonly GraphNode[];
  /** Cap the number of rendered path sections per direction. Default 12. */
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
  downstream,
  nodes,
  maxPaths,
}: PathExplanationPanelProps): JSX.Element {
  const cap = normalizeMaxPaths(maxPaths);
  const upstreamExplanations = useMemo<PathExplanation[]>(() => {
    if (!traversal || traversal.paths.length === 0) return [];
    return traversal.paths.map((p) => explainUpstreamPath(p, traversal.targetNodeId, nodes));
  }, [traversal, nodes]);
  const downstreamExplanations = useMemo<PathExplanation[]>(() => {
    if (!downstream || downstream.paths.length === 0) return [];
    return downstream.paths.map((p) =>
      explainDownstreamPath(p, downstream.targetNodeId, nodes),
    );
  }, [downstream, nodes]);

  if (!traversal && !downstream) {
    return (
      <aside
        aria-label="Message-flow path explanation"
        data-testid="path-explanation-panel"
        style={emptyPanelStyle}
      >
        <em>Select a queue, exchange, shovel, or federation link to see how messages flow through it.</em>
      </aside>
    );
  }

  const hasUpstream = upstreamExplanations.length > 0;
  const hasDownstream = downstreamExplanations.length > 0;
  const upstreamReach = traversal?.reachableAncestorIds.length ?? 0;
  const downstreamReach = downstream?.reachableDescendantIds.length ?? 0;
  if (!hasUpstream && !hasDownstream) {
    // Fully-cyclic ancestries/descendants can still surface a non-zero reach
    // via the highlight even after the traversal cycle-terminator fix — for
    // example a target whose only reach is a queue → exchange → queue loop
    // where every discovered node is on the cycle. Contradicting the
    // highlight ("no publishers/consumers found" while N nodes glow) misleads
    // the operator, so surface the cycle-aware reach instead.
    if (upstreamReach > 0 || downstreamReach > 0) {
      return (
        <aside
          aria-label="Message-flow path explanation"
          data-testid="path-explanation-panel"
          style={emptyPanelStyle}
        >
          <em data-testid="path-explanation-cycle-reach">
            Reachable through a closed cycle: {upstreamReach} upstream node
            {upstreamReach === 1 ? "" : "s"} · {downstreamReach} downstream node
            {downstreamReach === 1 ? "" : "s"}. No terminal source or sink to
            explain — see the highlight for the cycle shape.
          </em>
        </aside>
      );
    }
    return (
      <aside
        aria-label="Message-flow path explanation"
        data-testid="path-explanation-panel"
        style={emptyPanelStyle}
      >
        <em>No upstream publishers or downstream consumers found for this node.</em>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Message-flow path explanation"
      data-testid="path-explanation-panel"
      style={panelStyle}
    >
      {hasUpstream && (
        <PathSection
          heading="Upstream paths"
          direction="upstream"
          explanations={upstreamExplanations}
          truncated={traversal?.truncated === true}
          cap={cap}
        />
      )}
      {hasDownstream && (
        <PathSection
          heading="Downstream paths"
          direction="downstream"
          explanations={downstreamExplanations}
          truncated={downstream?.truncated === true}
          cap={cap}
        />
      )}
    </aside>
  );
}

interface PathSectionProps {
  heading: string;
  direction: "upstream" | "downstream";
  explanations: PathExplanation[];
  truncated: boolean;
  cap: number;
}

function PathSection({
  heading,
  direction,
  explanations,
  truncated,
  cap,
}: PathSectionProps): JSX.Element {
  const shown = explanations.slice(0, cap);
  const hidden = explanations.length - shown.length;
  const emptyStepMessage =
    direction === "upstream"
      ? "Source is the target — no upstream hops."
      : "Target is the sink — no downstream hops.";
  return (
    <section data-testid={`path-explanation-${direction}`} style={sectionStyle}>
      <header style={headerRowStyle}>
        <h4 style={headingStyle}>{heading}</h4>
        <span
          style={countStyle}
          data-testid={`path-explanation-${direction}-count`}
        >
          {explanations.length} path{explanations.length === 1 ? "" : "s"}
          {truncated ? " · truncated at max depth" : ""}
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
            data-testid={`path-explanation-${direction}-item-${index}`}
          >
            <div style={pathHeaderStyle}>
              <span style={pathIndexStyle}>Path {index + 1}</span>
              <span style={pathRangeStyle}>
                {shortenId(explanation.sourceNodeId)} → {shortenId(explanation.targetNodeId)}
              </span>
            </div>
            {explanation.steps.length === 0 ? (
              <p style={emptyStepStyle}>{emptyStepMessage}</p>
            ) : (
              <ol style={stepListStyle}>
                {explanation.steps.map((step, stepIndex) => (
                  <li
                    key={step.edgeId}
                    style={stepStyle}
                    data-testid={`path-explanation-${direction}-item-${index}-step-${stepIndex}`}
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
        <p
          style={hiddenNoteStyle}
          data-testid={`path-explanation-${direction}-hidden`}
        >
          {hidden} more path{hidden === 1 ? "" : "s"} not shown (cap: {cap}).
        </p>
      )}
    </section>
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
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
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
