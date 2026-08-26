import type { GraphNode } from "../../core/model";
import { describeEntity } from "./entityDetails";

export interface EntityDetailsPanelProps {
  node?: GraphNode;
}

/**
 * Renders a structured details view for the currently selected topology node.
 * Content is derived from `describeEntity` — a pure function — so the panel
 * itself is thin markup around a validated table of key/value rows. Every
 * value is already sanitized by `buildGraph` (deep AMQP-URI redaction) before
 * it lands on `GraphNode.data`, so nothing here needs its own redaction pass.
 */
export function EntityDetailsPanel({ node }: EntityDetailsPanelProps): JSX.Element {
  if (!node) {
    return (
      <aside
        aria-label="Entity details"
        data-testid="entity-details-panel"
        style={emptyPanelStyle}
      >
        <em>Select a node to see its details.</em>
      </aside>
    );
  }
  const view = describeEntity(node);
  return (
    <aside
      aria-label="Entity details"
      data-testid="entity-details-panel"
      style={panelStyle}
    >
      <header style={headerStyle}>
        <span style={kindBadgeStyle} data-testid="entity-details-kind">
          {view.kindLabel}
        </span>
        <strong data-testid="entity-details-title">{view.title}</strong>
      </header>
      {view.sections.map((section) => (
        <section
          key={section.heading}
          style={sectionStyle}
          data-testid={`entity-details-section-${section.heading.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <h4 style={sectionHeadingStyle}>{section.heading}</h4>
          <dl style={dlStyle}>
            {section.rows.map((row) => (
              <div key={row.key} style={rowStyle}>
                <dt style={dtStyle}>{row.key}</dt>
                <dd style={ddStyle}>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </aside>
  );
}

const panelStyle: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 6,
  padding: "0.75rem 1rem",
  fontFamily: "system-ui, sans-serif",
  fontSize: "0.85rem",
  marginTop: "0.75rem",
  background: "#fafafa",
};

const emptyPanelStyle: React.CSSProperties = {
  ...panelStyle,
  color: "#666",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginBottom: "0.5rem",
};

const kindBadgeStyle: React.CSSProperties = {
  background: "#e6e6ef",
  border: "1px solid #b7b7cc",
  padding: "0.05rem 0.4rem",
  borderRadius: 4,
  fontSize: "0.7rem",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
};

const sectionStyle: React.CSSProperties = {
  marginTop: "0.4rem",
};

const sectionHeadingStyle: React.CSSProperties = {
  margin: "0.2rem 0 0.3rem",
  fontSize: "0.75rem",
  color: "#555",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const dlStyle: React.CSSProperties = {
  margin: 0,
  display: "grid",
  gridTemplateColumns: "12rem 1fr",
  rowGap: "0.15rem",
  columnGap: "0.5rem",
};

const rowStyle: React.CSSProperties = {
  display: "contents",
};

const dtStyle: React.CSSProperties = {
  fontWeight: 500,
  color: "#333",
};

const ddStyle: React.CSSProperties = {
  margin: 0,
  color: "#111",
  wordBreak: "break-word",
};
