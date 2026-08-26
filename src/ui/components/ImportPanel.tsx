import { useCallback, useState, type ChangeEvent, type DragEvent } from "react";
import {
  importTopologyArchive,
  type ImportResult,
} from "../../core/import";
import { TopologySummaryPanel } from "./TopologySummaryPanel";

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
        <div>
          <p style={{ margin: "0.5rem 0" }}>
            Loaded {state.result.archiveKind.toUpperCase()}{" "}
            <code>{state.result.archivePath}</code>.
          </p>
          <TopologySummaryPanel result={state.result} />
        </div>
      )}
    </section>
  );
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
