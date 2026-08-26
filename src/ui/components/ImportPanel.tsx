import { useCallback, useState, type ChangeEvent, type DragEvent } from "react";
import {
  importTopologyArchive,
  type ImportResult,
} from "../../core/import";
import { summarizeDiagnostics } from "../../core/resolve/diagnostics";

export interface ImportPanelProps {
  onImported?: (result: ImportResult) => void;
}

interface ImportState {
  status: "idle" | "loading" | "done" | "error";
  fileName?: string;
  result?: ImportResult;
  error?: string;
}

export function ImportPanel({ onImported }: ImportPanelProps): JSX.Element {
  const [state, setState] = useState<ImportState>({ status: "idle" });
  const [dragActive, setDragActive] = useState(false);

  const runImport = useCallback(
    async (file: File): Promise<void> => {
      setState({ status: "loading", fileName: file.name });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await importTopologyArchive({
          fileName: file.name,
          bytes,
        });
        setState({ status: "done", fileName: file.name, result });
        onImported?.(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState({ status: "error", fileName: file.name, error: msg });
      }
    },
    [onImported],
  );

  const onFilePicked = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0];
      if (file) void runImport(file);
    },
    [runImport],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      setDragActive(false);
      const file = event.dataTransfer.files?.[0];
      if (file) void runImport(file);
    },
    [runImport],
  );

  return (
    <section aria-label="Import topology" style={panelStyle}>
      <h2 style={{ marginTop: 0 }}>Import RabbitMQ topology</h2>
      <div
        data-testid="import-drop-zone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
        style={dropZoneStyle(dragActive)}
      >
        <p style={{ margin: 0 }}>
          Drop a <code>.rar</code>, <code>.zip</code>, or <code>.json</code>{" "}
          file here, or:
        </p>
        <label style={buttonStyle}>
          <input
            type="file"
            accept=".rar,.zip,.json,application/json"
            onChange={onFilePicked}
            style={{ display: "none" }}
          />
          Choose file…
        </label>
      </div>
      {state.status === "loading" && (
        <p>Loading <code>{state.fileName}</code>…</p>
      )}
      {state.status === "error" && (
        <p style={{ color: "#b00020" }}>
          Failed to import <code>{state.fileName}</code>: {state.error}
        </p>
      )}
      {state.status === "done" && state.result && (
        <ImportSummary result={state.result} />
      )}
    </section>
  );
}

function ImportSummary({ result }: { result: ImportResult }): JSX.Element {
  const totals = summarizeImportedTotals(result);
  const diagnosticSummary = summarizeDiagnostics(result.diagnostics);
  return (
    <div>
      <h3>
        Loaded {result.archiveKind.toUpperCase()} <code>{result.archivePath}</code>
      </h3>
      <ul style={{ listStyle: "disc", paddingLeft: "1.25rem" }}>
        <li>Files inside: {result.files.length}</li>
        <li>Definitions exports: {totals.definitionsFiles}</li>
        <li>Management-dump files: {totals.managementFiles}</li>
        <li>Hosts: {totals.hosts}</li>
        <li>Vhosts: {totals.vhosts}</li>
        <li>Exchanges: {totals.exchanges}</li>
        <li>Queues: {totals.queues}</li>
        <li>Bindings: {totals.bindings}</li>
        <li>Shovels: {totals.shovels}</li>
        <li>Federation links: {totals.federations}</li>
        <li>Policies: {totals.policies}</li>
      </ul>
      <p>
        Diagnostics: {diagnosticSummary.total} total (
        {diagnosticSummary.counts.error} errors,{" "}
        {diagnosticSummary.counts.warning} warnings,{" "}
        {diagnosticSummary.counts.info} info)
      </p>
    </div>
  );
}

interface ImportTotals {
  definitionsFiles: number;
  managementFiles: number;
  hosts: number;
  vhosts: number;
  exchanges: number;
  queues: number;
  bindings: number;
  shovels: number;
  federations: number;
  policies: number;
}

function summarizeImportedTotals(result: ImportResult): ImportTotals {
  const totals: ImportTotals = {
    definitionsFiles: 0,
    managementFiles: 0,
    hosts: 0,
    vhosts: 0,
    exchanges: 0,
    queues: 0,
    bindings: 0,
    shovels: 0,
    federations: 0,
    policies: 0,
  };
  const hostIds = new Set<string>();
  for (const file of result.files) {
    if (file.kind === "definitions") totals.definitionsFiles += 1;
    if (file.kind === "management-dump") totals.managementFiles += 1;
    if (file.parsed) {
      hostIds.add(file.parsed.host.id);
      totals.vhosts += file.parsed.vhosts.length;
      totals.exchanges += file.parsed.exchanges.length;
      totals.queues += file.parsed.queues.length;
      totals.bindings += file.parsed.bindings.length;
      totals.policies += file.parsed.policies.length;
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
  padding: "1rem",
  fontFamily: "system-ui, sans-serif",
  maxWidth: 640,
};

const dropZoneStyle = (active: boolean): React.CSSProperties => ({
  border: `2px dashed ${active ? "#4c9aff" : "#bbb"}`,
  borderRadius: 6,
  padding: "1.5rem",
  textAlign: "center",
  background: active ? "#eef4ff" : "#fafafa",
  transition: "background 120ms ease, border-color 120ms ease",
});

const buttonStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: "0.75rem",
  padding: "0.5rem 1rem",
  border: "1px solid #444",
  borderRadius: 4,
  background: "#fff",
  cursor: "pointer",
};
