import { useCallback, useState, type ChangeEvent, type DragEvent } from "react";
import {
  getSharedTopologyWorkerClient,
  IMPORT_DEFAULT_LIMITS,
  type BatchFileInput,
  type BatchSkippedInput,
  type ImportResult,
} from "../../core/import";
import { TopologySummaryPanel } from "./TopologySummaryPanel";

export interface ImportPanelProps {
  onImported?: (result: ImportResult) => void;
}

interface ImportState {
  status: "idle" | "loading" | "done" | "error";
  fileName?: string;
  fileCount?: number;
  result?: ImportResult;
  error?: string;
}

async function fileToBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Route a single-file selection through the existing `importArchive` API
 * (backwards compatible — preserves `archiveKind: "rar"|"zip"|"json"` and its
 * summary labels). Multi-file selections go through `importBatch` so related
 * split-dump files are group-parsed via the two-phase importer.
 */
function isSingleFileSelection(files: File[]): boolean {
  return files.length === 1;
}

export function ImportPanel({ onImported }: ImportPanelProps): JSX.Element {
  const [state, setState] = useState<ImportState>({ status: "idle" });
  const [dragActive, setDragActive] = useState(false);

  const runImport = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) return;
      const client = getSharedTopologyWorkerClient();
      const displayName =
        files.length === 1 ? files[0]!.name : `${files.length} files`;
      setState({ status: "loading", fileName: displayName, fileCount: files.length });
      try {
        let result: ImportResult;
        if (isSingleFileSelection(files)) {
          const only = files[0]!;
          const bytes = await fileToBytes(only);
          result = await client.importArchive({ fileName: only.name, bytes });
        } else {
          // Multi-file preflight — all checks below inspect `File` metadata
          // ONLY (no I/O) so no memory is allocated for any file that will be
          // rejected. Every failing file is captured as a `BatchSkippedInput`
          // (carrying its ORIGINAL picker-order `selectionIndex`) and
          // forwarded to the batch importer, which surfaces it in
          // `ImportResult.files` with `kind: "load-error"` and a matching
          // diagnostic keyed by that original index — so the picker's
          // selection list always survives in the final summary AND every
          // per-file diagnostic maps back to the exact position the user
          // saw, even when readable and skipped files interleave.
          interface Readable {
            file: File;
            selectionIndex: number;
          }
          const readable: Readable[] = [];
          const skipped: BatchSkippedInput[] = [];

          // Entry-count preflight FIRST — reject the whole batch (record
          // every filename as skipped) before touching any bytes.
          if (files.length > IMPORT_DEFAULT_LIMITS.maxEntryCount) {
            for (let i = 0; i < files.length; i += 1) {
              const f = files[i]!;
              skipped.push({
                fileName: f.name,
                sizeBytes: f.size,
                reason: "preflight-too-many-files",
                detail: `Selection of ${files.length} files exceeds the batch entry-count cap ${IMPORT_DEFAULT_LIMITS.maxEntryCount}; no files were read.`,
                selectionIndex: i,
              });
            }
          } else {
            let cumulative = 0;
            let cumulativeCapCrossed = false;
            for (let i = 0; i < files.length; i += 1) {
              const f = files[i]!;
              // Multi-file mode is JSON-only — archives (.rar/.zip) are
              // clearly rejected with a preflight diagnostic instead of
              // being silently marked non-JSON and skipped downstream.
              const isJson = f.name.toLowerCase().endsWith(".json");
              if (!isJson) {
                skipped.push({
                  fileName: f.name,
                  sizeBytes: f.size,
                  reason: "preflight-non-json-in-batch",
                  detail: `Multi-file batch imports accept .json files only; drop archives (.rar/.zip) individually.`,
                  selectionIndex: i,
                });
                continue;
              }
              if (f.size > IMPORT_DEFAULT_LIMITS.maxEntryBytes) {
                skipped.push({
                  fileName: f.name,
                  sizeBytes: f.size,
                  reason: "preflight-per-entry-too-large",
                  detail: `File.size ${f.size} bytes exceeds the per-entry cap ${IMPORT_DEFAULT_LIMITS.maxEntryBytes}.`,
                  selectionIndex: i,
                });
                continue;
              }
              if (cumulativeCapCrossed) {
                skipped.push({
                  fileName: f.name,
                  sizeBytes: f.size,
                  reason: "preflight-unprocessed",
                  detail: `The batch already crossed the total-size cap; file was not read.`,
                  selectionIndex: i,
                });
                continue;
              }
              if (cumulative + f.size > IMPORT_DEFAULT_LIMITS.maxTotalDecompressedBytes) {
                cumulativeCapCrossed = true;
                skipped.push({
                  fileName: f.name,
                  sizeBytes: f.size,
                  reason: "preflight-total-size-exceeded",
                  detail: `Adding File.size ${f.size} would exceed the total cap ${IMPORT_DEFAULT_LIMITS.maxTotalDecompressedBytes}.`,
                  selectionIndex: i,
                });
                continue;
              }
              cumulative += f.size;
              readable.push({ file: f, selectionIndex: i });
            }
          }

          // Read the surviving files sequentially — never Promise.all — so
          // the process only holds one File's ArrayBuffer at a time in
          // addition to the accumulated `batchFiles` buffer. A per-file
          // read failure NEVER aborts the whole batch: the failing file is
          // captured as a `read-failed` skip and the loop continues so
          // every other valid file still contributes. The original picker
          // `selectionIndex` travels through unchanged so per-file
          // diagnostics stay attributable.
          const batchFiles: BatchFileInput[] = [];
          for (const r of readable) {
            try {
              const bytes = await fileToBytes(r.file);
              batchFiles.push({
                fileName: r.file.name,
                bytes,
                selectionIndex: r.selectionIndex,
              });
            } catch (readErr) {
              const detail = readErr instanceof Error ? readErr.message : String(readErr);
              skipped.push({
                fileName: r.file.name,
                sizeBytes: r.file.size,
                reason: "read-failed",
                detail,
                selectionIndex: r.selectionIndex,
              });
            }
          }
          result = await client.importBatch({ files: batchFiles, skipped });
        }
        setState({
          status: "done",
          fileName: displayName,
          fileCount: files.length,
          result,
        });
        onImported?.(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState({
          status: "error",
          fileName: displayName,
          fileCount: files.length,
          error: msg,
        });
      }
    },
    [onImported],
  );

  const onFilePicked = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const list = event.target.files;
      if (!list || list.length === 0) return;
      const files = Array.from(list);
      void runImport(files);
    },
    [runImport],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      setDragActive(false);
      const list = event.dataTransfer.files;
      if (!list || list.length === 0) return;
      const files = Array.from(list);
      void runImport(files);
    },
    [runImport],
  );

  const loadingLabel =
    state.fileCount && state.fileCount > 1
      ? `Loading ${state.fileCount} files…`
      : `Loading `;
  const doneLabel = state.result
    ? state.result.archiveKind === "batch"
      ? `Loaded batch of ${state.fileCount ?? state.result.files.length} files`
      : `Loaded ${state.result.archiveKind.toUpperCase()}`
    : "";

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
          Drop one or more <code>.rar</code>, <code>.zip</code>, or{" "}
          <code>.json</code> files here, or:
        </p>
        <label style={buttonStyle}>
          <input
            type="file"
            multiple
            accept=".rar,.zip,.json,application/json"
            onChange={onFilePicked}
            data-testid="import-file-input"
            style={{ display: "none" }}
          />
          Choose file(s)…
        </label>
      </div>
      {state.status === "loading" && (
        <p data-testid="import-loading">
          {state.fileCount && state.fileCount > 1 ? (
            loadingLabel
          ) : (
            <>
              {loadingLabel}
              <code>{state.fileName}</code>…
            </>
          )}
        </p>
      )}
      {state.status === "error" && (
        <p style={{ color: "#b00020" }}>
          Failed to import <code>{state.fileName}</code>: {state.error}
        </p>
      )}
      {state.status === "done" && state.result && (
        <div>
          <p style={{ margin: "0.5rem 0" }} data-testid="import-completed">
            {doneLabel} <code>{state.result.archivePath}</code>.
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
  padding: "clamp(0.75rem, 2vw, 1rem)",
  fontFamily: "system-ui, sans-serif",
  // Fluid width — panel fills its parent container at every breakpoint. The
  // App shell owns the outer inset; a fixed `maxWidth` here would clip on
  // narrow viewports and leave dead space on wide ones.
  width: "100%",
  maxWidth: "100%",
  boxSizing: "border-box",
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
