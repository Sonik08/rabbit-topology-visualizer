import { useMemo, useState } from "react";
import type { ImportResult } from "../../core/import";
import type { Diagnostic } from "../../core/model/topology";
import {
  groupBySeverity,
  summarizeDiagnostics,
} from "../../core/resolve/diagnostics";

export interface TopologySummaryPanelProps {
  result: ImportResult;
  /** Maximum diagnostics rendered per severity band. Defaults to 25. */
  maxDiagnosticsPerSeverity?: number;
}

interface ImportTotals {
  definitionsFiles: number;
  managementFiles: number;
  nonJsonFiles: number;
  loadErrorFiles: number;
  hosts: number;
  vhosts: number;
  exchanges: number;
  queues: number;
  bindings: number;
  shovels: number;
  federations: number;
  policies: number;
  parameters: number;
}

const DEFAULT_MAX_DIAGNOSTICS = 25;
const SEVERITY_ORDER: ReadonlyArray<Diagnostic["severity"]> = [
  "error",
  "warning",
  "info",
];

const SEVERITY_LABEL: Record<Diagnostic["severity"], string> = {
  error: "Errors",
  warning: "Warnings",
  info: "Info",
};

const SEVERITY_COLOR: Record<Diagnostic["severity"], string> = {
  error: "#b00020",
  warning: "#a56100",
  info: "#00568a",
};

/**
 * Renders a compact topology overview + diagnostics breakdown for one imported
 * archive. Consumers pass an `ImportResult` (typically from `ImportPanel`'s
 * `onImported` callback or its inline render).
 */
export function TopologySummaryPanel({
  result,
  maxDiagnosticsPerSeverity = DEFAULT_MAX_DIAGNOSTICS,
}: TopologySummaryPanelProps): JSX.Element {
  const totals = useMemo(() => summarizeImportedTotals(result), [result]);
  const diagnosticSummary = useMemo(
    () => summarizeDiagnostics(result.diagnostics),
    [result.diagnostics],
  );
  const grouped = useMemo(
    () => groupBySeverity(result.diagnostics),
    [result.diagnostics],
  );
  const [expanded, setExpanded] = useState(false);

  return (
    <section
      aria-label="Topology summary"
      data-testid="topology-summary-panel"
      style={panelStyle}
    >
      <h2 style={{ marginTop: 0 }}>
        Topology summary — <code>{result.archivePath}</code>{" "}
        <span style={archiveKindBadge}>{result.archiveKind.toUpperCase()}</span>
      </h2>

      <div style={sectionsGrid}>
        <div>
          <h3 style={subHeadingStyle}>Files</h3>
          <ul style={listStyle}>
            <li>Total entries: {result.files.length}</li>
            <li>Definitions exports: {totals.definitionsFiles}</li>
            <li>Management-dump files: {totals.managementFiles}</li>
            <li>Non-JSON entries: {totals.nonJsonFiles}</li>
            <li>Load errors: {totals.loadErrorFiles}</li>
          </ul>
        </div>
        <div>
          <h3 style={subHeadingStyle}>Topology</h3>
          <ul style={listStyle}>
            <li>Hosts: {totals.hosts}</li>
            <li>Vhosts: {totals.vhosts}</li>
            <li>Exchanges: {totals.exchanges}</li>
            <li>Queues: {totals.queues}</li>
            <li>Bindings: {totals.bindings}</li>
            <li>Shovels: {totals.shovels}</li>
            <li>Federation links: {totals.federations}</li>
            <li>Policies: {totals.policies}</li>
            <li>Runtime parameters: {totals.parameters}</li>
          </ul>
        </div>
      </div>

      <div>
        <h3 style={subHeadingStyle}>
          Diagnostics:{" "}
          <span data-testid="diagnostics-total" style={diagnosticsSummaryStyle}>
            {diagnosticSummary.total} total —{" "}
            <span style={{ color: SEVERITY_COLOR.error }}>
              {diagnosticSummary.counts.error} errors
            </span>
            ,{" "}
            <span style={{ color: SEVERITY_COLOR.warning }}>
              {diagnosticSummary.counts.warning} warnings
            </span>
            ,{" "}
            <span style={{ color: SEVERITY_COLOR.info }}>
              {diagnosticSummary.counts.info} info
            </span>
          </span>
        </h3>
        {diagnosticSummary.total === 0 ? (
          <p style={{ margin: "0.25rem 0" }}>No diagnostics — clean import.</p>
        ) : (
          <>
            <button
              type="button"
              data-testid="diagnostics-toggle"
              onClick={() => setExpanded((v) => !v)}
              style={toggleButtonStyle}
              aria-expanded={expanded}
            >
              {expanded ? "Hide details" : "Show details"}
            </button>
            {expanded && (
              <div data-testid="diagnostics-details">
                <details open>
                  <summary style={{ cursor: "pointer" }}>
                    Counts by code
                  </summary>
                  <ul style={listStyle}>
                    {diagnosticSummary.byCode.map(({ code, count }) => (
                      <li key={code}>
                        <code>{code}</code>: {count}
                      </li>
                    ))}
                  </ul>
                </details>
                {SEVERITY_ORDER.map((severity) => {
                  const list = grouped[severity];
                  if (list.length === 0) return null;
                  const shown = list.slice(0, maxDiagnosticsPerSeverity);
                  const hidden = list.length - shown.length;
                  return (
                    <details
                      key={severity}
                      open={severity === "error"}
                      data-testid={`diagnostics-${severity}`}
                    >
                      <summary
                        style={{
                          cursor: "pointer",
                          color: SEVERITY_COLOR[severity],
                        }}
                      >
                        {SEVERITY_LABEL[severity]} ({list.length})
                      </summary>
                      <ul style={listStyle}>
                        {shown.map((d, i) => (
                          <li key={`${d.code}-${i}`}>
                            <code>{d.code}</code>: {d.message}
                            {d.sourceFileId && (
                              <span style={{ color: "#666" }}>
                                {" "}
                                — <code>{d.sourceFileId}</code>
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                      {hidden > 0 && (
                        <p style={{ fontStyle: "italic", margin: "0.25rem 0" }}>
                          … and {hidden} more not shown.
                        </p>
                      )}
                    </details>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function summarizeImportedTotals(result: ImportResult): ImportTotals {
  const totals: ImportTotals = {
    definitionsFiles: 0,
    managementFiles: 0,
    nonJsonFiles: 0,
    loadErrorFiles: 0,
    hosts: 0,
    vhosts: 0,
    exchanges: 0,
    queues: 0,
    bindings: 0,
    shovels: 0,
    federations: 0,
    policies: 0,
    parameters: 0,
  };
  const hostIds = new Set<string>();
  for (const file of result.files) {
    if (file.kind === "definitions") totals.definitionsFiles += 1;
    if (file.kind === "management-dump") totals.managementFiles += 1;
    if (file.kind === "non-json") totals.nonJsonFiles += 1;
    if (file.kind === "load-error") totals.loadErrorFiles += 1;
    if (file.parsed) {
      hostIds.add(file.parsed.host.id);
      totals.vhosts += file.parsed.vhosts.length;
      totals.exchanges += file.parsed.exchanges.length;
      totals.queues += file.parsed.queues.length;
      totals.bindings += file.parsed.bindings.length;
      totals.policies += file.parsed.policies.length;
      totals.parameters += file.parsed.rawParameters.length;
    }
    if (file.runtime) {
      totals.shovels += file.runtime.shovels.length;
      totals.federations += file.runtime.federations.length;
    }
  }
  totals.hosts = hostIds.size;
  return totals;
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

const sectionsGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "1rem",
  marginBottom: "0.5rem",
};

const subHeadingStyle: React.CSSProperties = {
  fontSize: "1rem",
  margin: "0 0 0.25rem",
};

const listStyle: React.CSSProperties = {
  listStyle: "disc",
  paddingLeft: "1.25rem",
  margin: "0.25rem 0",
};

const diagnosticsSummaryStyle: React.CSSProperties = {
  fontWeight: "normal",
  fontSize: "0.9rem",
};

const toggleButtonStyle: React.CSSProperties = {
  marginTop: "0.25rem",
  padding: "0.25rem 0.6rem",
  border: "1px solid #666",
  borderRadius: 4,
  background: "#fff",
  cursor: "pointer",
  fontSize: "0.85rem",
};

const archiveKindBadge: React.CSSProperties = {
  display: "inline-block",
  padding: "0.1rem 0.4rem",
  border: "1px solid #999",
  borderRadius: 4,
  background: "#f2f2f2",
  fontSize: "0.75rem",
  fontFamily: "system-ui, sans-serif",
  marginLeft: "0.25rem",
  verticalAlign: "middle",
};
