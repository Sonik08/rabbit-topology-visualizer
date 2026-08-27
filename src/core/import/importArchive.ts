import JSZip from "jszip";
import { classifyJson, type JsonClassification } from "../parse/jsonClassifier";
import { parseDefinitionsExport, type ParseDefinitionsResult } from "../parse/definitionsParser";
import { parseSplitManagementDump } from "../parse/splitDumpParser";
import { parseRuntimeParameters, type ParseRuntimeParametersResult } from "../parse/runtimeParameters";
import { safeParseJson } from "../parse/safeJson";
import { loadRarArchive } from "../parse/rarLoader";
import type { Diagnostic } from "../model/topology";

export type ImportedFileKind =
  | "definitions"
  | "management-dump"
  | "unknown-json"
  | "non-json"
  | "load-error";

export interface ImportedFile {
  path: string;
  sizeBytes: number;
  kind: ImportedFileKind;
  classification?: JsonClassification;
  /** Empty when the file wasn't a definitions export. */
  parsed?: ParseDefinitionsResult;
  /** Runtime shovel/federation parse when the file was a definitions export. */
  runtime?: ParseRuntimeParametersResult;
}

export interface ImportResult {
  archiveKind: "rar" | "zip" | "json" | "batch" | "unknown";
  archivePath: string;
  files: ImportedFile[];
  diagnostics: Diagnostic[];
}

export interface BatchFileInput {
  fileName: string;
  bytes: Uint8Array;
  /**
   * The 0-based index of this file in the caller's original picker/drop
   * selection. When present, the batch importer uses it verbatim as the
   * `batch[N]` disambiguator on every emitted `Diagnostic.sourceFileId` for
   * this file, so per-file attribution matches the order the user saw. When
   * absent the batch importer falls back to the file's position within
   * `BatchImportInput.files` — safe for callers that don't split selections
   * into readable / skipped buckets.
   */
  selectionIndex?: number;
}

/**
 * Metadata for a file the caller has chosen to skip before it hits the batch
 * importer (typically because it exceeded a browser-side preflight cap). The
 * batch importer still records these entries in `ImportResult.files` with
 * `kind: "load-error"` so every source filename in the picker selection
 * survives, with a matching diagnostic explaining why the bytes were never
 * loaded.
 */
export interface BatchSkippedInput {
  fileName: string;
  sizeBytes: number;
  reason:
    | "preflight-per-entry-too-large"
    | "preflight-total-size-exceeded"
    | "preflight-unprocessed"
    | "preflight-too-many-files"
    | "preflight-non-json-in-batch"
    | "read-failed";
  /** Optional human-readable elaboration shipped in the emitted diagnostic. */
  detail?: string;
  /**
   * The 0-based index of this file in the caller's original picker/drop
   * selection. Preserved on the skip so `sourceFileId` remains attributable
   * to the exact position the user picked — critical when duplicate filenames
   * exist and skipped/readable files interleave.
   */
  selectionIndex?: number;
}

export interface BatchImportInput {
  files: BatchFileInput[];
  /**
   * Files the caller preflighted and chose not to read. Included in the
   * output `files` with `kind: "load-error"` so per-file attribution is
   * preserved and the picker's filename list is intact.
   */
  skipped?: BatchSkippedInput[];
  limits?: Partial<ImportLimits>;
}

export interface ImportInput {
  /** Original filename or archive name — used only for `archivePath` and to sniff type. */
  fileName: string;
  bytes: Uint8Array;
  /** Optional hint if the caller already knows the file kind. */
  archiveKind?: ImportResult["archiveKind"];
  /** Optional override for the resource limits (see {@link IMPORT_DEFAULT_LIMITS}). */
  limits?: Partial<ImportLimits>;
}

export interface ImportLimits {
  /** Reject the archive outright when its raw compressed size exceeds this. */
  maxArchiveBytes: number;
  /** Stop iterating archive entries once this count is reached. */
  maxEntryCount: number;
  /** Skip any single entry whose decompressed size exceeds this. */
  maxEntryBytes: number;
  /** Stop iterating archive entries once the total decompressed size exceeds this. */
  maxTotalDecompressedBytes: number;
}

/**
 * Conservative browser-friendly defaults tuned to keep any single import from
 * exhausting memory or freezing the UI even on adversarial "zip bomb" inputs.
 * Callers can override any subset via `ImportInput.limits`.
 */
export const IMPORT_DEFAULT_LIMITS: ImportLimits = {
  maxArchiveBytes: 50 * 1024 * 1024, // 50 MB compressed
  maxEntryCount: 5_000,
  maxEntryBytes: 25 * 1024 * 1024, // 25 MB per file after decompression
  maxTotalDecompressedBytes: 100 * 1024 * 1024, // 100 MB total
};

/**
 * Top-level import driver. Sniffs the archive type from the filename (RAR/zip
 * extension) or falls back to treating the payload as a single JSON file.
 * Delegates parsing to the existing single-file loaders, then classifies each
 * entry and runs the definitions parser when applicable.
 *
 * Framework-agnostic — the React ImportPanel calls this after reading a File
 * with `FileReader`/`file.arrayBuffer()`, so the panel stays UI-only.
 */
export async function importTopologyArchive(input: ImportInput): Promise<ImportResult> {
  const kind = input.archiveKind ?? sniffArchiveKind(input.fileName, input.bytes);
  const diagnostics: Diagnostic[] = [];
  const limits: ImportLimits = { ...IMPORT_DEFAULT_LIMITS, ...input.limits };

  if (input.bytes.byteLength > limits.maxArchiveBytes) {
    diagnostics.push({
      severity: "error",
      code: "import.archive-too-large",
      message: `Archive '${input.fileName}' is ${input.bytes.byteLength} bytes; the limit is ${limits.maxArchiveBytes}. Refusing to import.`,
      sourceFileId: `file:${input.fileName}`,
    });
    return {
      archiveKind: kind === "unknown" ? "unknown" : kind,
      archivePath: input.fileName,
      files: [],
      diagnostics,
    };
  }

  if (kind === "rar") {
    return await importRar(input, diagnostics, limits);
  }
  if (kind === "zip") {
    return await importZip(input, diagnostics, limits);
  }
  if (kind === "json") {
    return importSingleJson(input, diagnostics, limits);
  }
  diagnostics.push({
    severity: "error",
    code: "import.unknown-archive",
    message: `Unrecognised archive type for '${input.fileName}'. Expected .rar, .zip, or .json.`,
  });
  return {
    archiveKind: "unknown",
    archivePath: input.fileName,
    files: [],
    diagnostics,
  };
}

function sniffArchiveKind(fileName: string, bytes: Uint8Array): ImportResult["archiveKind"] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".rar")) return "rar";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".json")) return "json";
  // Magic-byte fallback: RAR archives start with `Rar!`, PK zip with `PK\x03\x04`.
  if (bytes.length >= 4) {
    if (bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21) return "rar";
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "zip";
  }
  return "unknown";
}

interface RawJsonEntry {
  path: string;
  sizeBytes: number;
  bytes: Uint8Array;
  /**
   * Explicit disambiguator for `Diagnostic.sourceFileId`. When present, it is
   * used verbatim instead of `file:${path}`; the batch importer uses this to
   * keep the visible `path` (used by heuristics like `deriveHostFromPath`)
   * clean while still generating unique ids for duplicate filenames.
   */
  sourceFileId?: string;
}

async function importRar(
  input: ImportInput,
  diagnostics: Diagnostic[],
  limits: ImportLimits,
): Promise<ImportResult> {
  const rar = await loadRarArchive({
    bytes: input.bytes,
    sourceFileId: `file:${input.fileName}`,
    // Enforce the public importer limits while the RAR loader is still
    // inspecting headers, before extraction allocates decompressed entries.
    maxArchiveBytes: limits.maxArchiveBytes,
    maxEntries: limits.maxEntryCount,
    maxEntryBytes: limits.maxEntryBytes,
    maxTotalBytes: limits.maxTotalDecompressedBytes,
  });
  diagnostics.push(...rar.diagnostics);
  const entries: RawJsonEntry[] = [];
  const nonJson: ImportedFile[] = [];
  for (const entry of rar.files) {
    if (entry.path.toLowerCase().endsWith(".json")) {
      entries.push({ path: entry.path, sizeBytes: entry.sizeBytes, bytes: entry.data });
    } else {
      nonJson.push({ path: entry.path, sizeBytes: entry.sizeBytes, kind: "non-json" });
    }
  }
  const files = processJsonEntries(entries, diagnostics);
  return {
    archiveKind: "rar",
    archivePath: input.fileName,
    files: [...files, ...nonJson],
    diagnostics,
  };
}

async function importZip(
  input: ImportInput,
  diagnostics: Diagnostic[],
  limits: ImportLimits,
): Promise<ImportResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input.bytes);
  } catch (err) {
    diagnostics.push({
      severity: "error",
      code: "zip.open-failed",
      message: `Could not open zip archive: ${err instanceof Error ? err.message : String(err)}`,
      sourceFileId: `file:${input.fileName}`,
    });
    return { archiveKind: "zip", archivePath: input.fileName, files: [], diagnostics };
  }
  const entries: RawJsonEntry[] = [];
  const nonJson: ImportedFile[] = [];
  const zipEntries = Object.values(zip.files);
  const preflight = preflightZipEntries(zipEntries, limits, diagnostics, input.fileName);
  if (preflight.terminal) {
    return { archiveKind: "zip", archivePath: input.fileName, files: [], diagnostics };
  }

  // This total is deliberately independent from the declared-size preflight:
  // archive metadata is advisory and must not be added to actual output. Every
  // chunk produced by JSZip is counted here, including chunks from entries
  // later skipped for exceeding the per-entry cap.
  let actualProducedBytes = 0;
  for (const candidate of preflight.entries) {
    if (candidate.entry.dir || candidate.skip) continue;

    const remainingTotalBytes = limits.maxTotalDecompressedBytes - actualProducedBytes;
    let streamed: ZipStreamResult;
    try {
      streamed = await streamZipEntryBounded(
        candidate.entry,
        candidate.declaredSize,
        limits.maxEntryBytes,
        remainingTotalBytes,
      );
    } catch (err) {
      diagnostics.push({
        severity: "warning",
        code: "zip.entry-extract-failed",
        message: `Could not extract zip entry '${candidate.entry.name}': ${err instanceof Error ? err.message : String(err)}`,
        sourceFileId: `file:${input.fileName}`,
      });
      continue;
    }

    actualProducedBytes += streamed.producedBytes;
    if (streamed.decision === "total-exceeded") {
      diagnostics.push({
        severity: "error",
        code: "import.total-size-exceeded",
        message: `Archive '${input.fileName}' exceeded the total-decompressed-size limit (${limits.maxTotalDecompressedBytes}). Stopping iteration.`,
        sourceFileId: `file:${input.fileName}`,
      });
      break;
    }
    if (streamed.decision === "entry-exceeded") {
      diagnostics.push({
        severity: "warning",
        code: "import.entry-too-large",
        message: `Skipped '${candidate.entry.name}' after it produced ${streamed.producedBytes} bytes; the per-entry decompressed limit is ${limits.maxEntryBytes}.`,
        sourceFileId: `file:${input.fileName}`,
      });
      continue;
    }
    if (streamed.decision === "failed") {
      diagnostics.push({
        severity: "warning",
        code: "zip.entry-extract-failed",
        message: `Could not extract zip entry '${candidate.entry.name}': ${streamed.error instanceof Error ? streamed.error.message : String(streamed.error)}`,
        sourceFileId: `file:${input.fileName}`,
      });
      continue;
    }

    const bytes = streamed.bytes;

    if (candidate.entry.name.toLowerCase().endsWith(".json")) {
      entries.push({ path: candidate.entry.name, sizeBytes: bytes.byteLength, bytes });
    } else {
      nonJson.push({ path: candidate.entry.name, sizeBytes: bytes.byteLength, kind: "non-json" });
    }
  }
  const files = processJsonEntries(entries, diagnostics);
  return {
    archiveKind: "zip",
    archivePath: input.fileName,
    files: [...files, ...nonJson],
    diagnostics,
  };
}

interface ZipEntryWithInternals extends JSZip.JSZipObject {
  _data?: { uncompressedSize?: number };
  internalStream(type: "uint8array"): ZipStreamHelper;
}

interface ZipStreamHelper {
  on(event: "data", callback: (chunk: Uint8Array) => void): ZipStreamHelper;
  on(event: "end", callback: () => void): ZipStreamHelper;
  on(event: "error", callback: (error: unknown) => void): ZipStreamHelper;
  pause(): ZipStreamHelper;
  resume(): ZipStreamHelper;
}

interface ZipPreflightEntry {
  entry: ZipEntryWithInternals;
  declaredSize: number;
  skip: boolean;
}

function preflightZipEntries(
  zipEntries: JSZip.JSZipObject[],
  limits: ImportLimits,
  diagnostics: Diagnostic[],
  archiveName: string,
): { entries: ZipPreflightEntry[]; terminal: boolean } {
  if (zipEntries.length > limits.maxEntryCount) {
    diagnostics.push({
      severity: "error",
      code: "import.too-many-entries",
      message: `Archive '${archiveName}' exceeded the entry-count limit (${limits.maxEntryCount}). Stopping iteration.`,
      sourceFileId: `file:${archiveName}`,
    });
    return { entries: [], terminal: true };
  }

  const entries: ZipPreflightEntry[] = [];
  let declaredTotalBytes = 0;
  for (const rawEntry of zipEntries) {
    const entry = rawEntry as ZipEntryWithInternals;
    const declaredSize = safeZipSize(entry._data?.uncompressedSize);
    if (!entry.dir) declaredTotalBytes += declaredSize;
    if (declaredTotalBytes > limits.maxTotalDecompressedBytes) {
      diagnostics.push({
        severity: "error",
        code: "import.total-size-exceeded",
        message: `Archive '${archiveName}' reports more than the total-decompressed-size limit (${limits.maxTotalDecompressedBytes}). Refusing to extract it.`,
        sourceFileId: `file:${archiveName}`,
      });
      return { entries: [], terminal: true };
    }

    const skip = !entry.dir && declaredSize > limits.maxEntryBytes;
    if (skip) {
      diagnostics.push({
        severity: "warning",
        code: "import.entry-too-large",
        message: `Skipped '${entry.name}' (${declaredSize} declared bytes); the per-entry decompressed limit is ${limits.maxEntryBytes}.`,
        sourceFileId: `file:${archiveName}`,
      });
    }
    entries.push({ entry, declaredSize, skip });
  }
  return { entries, terminal: false };
}

function safeZipSize(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

type ZipStreamResult =
  | { decision: "complete"; producedBytes: number; bytes: Uint8Array }
  | { decision: "failed"; producedBytes: number; error: unknown }
  | { decision: "entry-exceeded"; producedBytes: number }
  | { decision: "total-exceeded"; producedBytes: number };

/**
 * Decompress one JSZip entry chunk-by-chunk. The backing buffer is never
 * larger than the trustworthy declared size bounded by both configured caps;
 * JSZip may hand us one additional chunk, but that chunk is not retained once
 * either limit is crossed. Pausing the helper stops further inflate work.
 */
function streamZipEntryBounded(
  entry: ZipEntryWithInternals,
  declaredSize: number,
  maxEntryBytes: number,
  remainingTotalBytes: number,
): Promise<ZipStreamResult> {
  return new Promise((resolve) => {
    const capacity = Math.min(declaredSize, maxEntryBytes, remainingTotalBytes);
    const output = new Uint8Array(Math.max(0, capacity));
    const stream = entry.internalStream("uint8array");
    let producedBytes = 0;
    let settled = false;
    let materializable = true;
    let pendingLimitDecision: "entry-exceeded" | "total-exceeded" | undefined;
    let limitResolutionScheduled = false;

    const finish = (result: ZipStreamResult): void => {
      if (settled) return;
      settled = true;
      stream.pause();
      resolve(result);
    };

    const stopAtLimit = (decision: "entry-exceeded" | "total-exceeded"): void => {
      // Pako may synchronously emit several output chunks for the compressed
      // input chunk already in flight. Pause now, keep counting those chunks,
      // and resolve in a microtask after that synchronous work unwinds.
      if (decision === "total-exceeded" || !pendingLimitDecision) {
        pendingLimitDecision = decision;
      }
      stream.pause();
      if (limitResolutionScheduled) return;
      limitResolutionScheduled = true;
      queueMicrotask(() => {
        if (!settled && pendingLimitDecision) {
          finish({ decision: pendingLimitDecision, producedBytes });
        }
      });
    };

    stream
      .on("data", (chunk) => {
        if (settled) return;
        const chunkStart = producedBytes;
        producedBytes += chunk.byteLength;

        if (producedBytes > remainingTotalBytes) {
          stopAtLimit("total-exceeded");
          return;
        }
        if (producedBytes > maxEntryBytes) {
          stopAtLimit("entry-exceeded");
          return;
        }

        if (materializable && producedBytes <= output.byteLength) {
          output.set(chunk, chunkStart);
        } else {
          // A declared-size mismatch cannot be safely grown without exceeding
          // the configured retained-memory bound. JSZip will report the corrupt
          // size at end; meanwhile continue counting output toward both caps.
          materializable = false;
        }
      })
      .on("error", (error) => {
        if (settled) return;
        settled = true;
        resolve({ decision: "failed", producedBytes, error });
      })
      .on("end", () => {
        if (settled) return;
        // A pending limit decision beats any success/failure path: if a chunk
        // pushed `producedBytes` past a cap and stream `end` fires synchronously
        // before the microtask-scheduled `stopAtLimit` resolution runs, the
        // caller must still see the terminal limit diagnostic — not a partial
        // `complete` payload nor a generic "exceeded declared size" failure.
        if (pendingLimitDecision) {
          settled = true;
          resolve({ decision: pendingLimitDecision, producedBytes });
          return;
        }
        if (!materializable) {
          settled = true;
          resolve({
            decision: "failed",
            producedBytes,
            error: new Error("decompressed data exceeded its declared size"),
          });
          return;
        }
        settled = true;
        resolve({
          decision: "complete",
          producedBytes,
          bytes: output.subarray(0, producedBytes),
        });
      })
      .resume();
  });
}

function importSingleJson(
  input: ImportInput,
  diagnostics: Diagnostic[],
  limits: ImportLimits,
): ImportResult {
  if (input.bytes.byteLength > limits.maxEntryBytes) {
    diagnostics.push({
      severity: "error",
      code: "import.entry-too-large",
      message: `File '${input.fileName}' is ${input.bytes.byteLength} bytes; the per-entry limit is ${limits.maxEntryBytes}. Skipping.`,
      sourceFileId: `file:${input.fileName}`,
    });
    return { archiveKind: "json", archivePath: input.fileName, files: [], diagnostics };
  }
  const files = processJsonEntries(
    [{ path: input.fileName, sizeBytes: input.bytes.byteLength, bytes: input.bytes }],
    diagnostics,
  );
  return {
    archiveKind: "json",
    archivePath: input.fileName,
    files,
    diagnostics,
  };
}

type SplitShape = "queues" | "exchanges" | "bindings" | "parameters" | "policies" | "vhosts";

interface StagedDump {
  shape: SplitShape;
  json: unknown;
  path: string;
  sizeBytes: number;
  classification: import("../parse/jsonClassifier").JsonClassification;
  sourceFileId: string;
}

/**
 * Two-phase importer:
 * 1. Classify every JSON file. Definitions exports are parsed immediately
 *    (each definitions file is already a complete-per-host snapshot).
 *    Management-dump files are *staged* by host so their queues, exchanges,
 *    bindings, parameters, and policies can be resolved together.
 * 2. For each host with staged dumps, call `parseSplitManagementDump` once
 *    with all its files so binding source/destination references and runtime
 *    parameter vhost lookups resolve across files — the same way the split
 *    parser has always worked when called manually.
 *
 * The aggregated parse + runtime result is attached to the *first* dump entry
 * per host, so per-file totals in the UI aren't inflated by counting the same
 * host's entities once per split file.
 */
function processJsonEntries(
  entries: RawJsonEntry[],
  diagnostics: Diagnostic[],
): ImportedFile[] {
  const files: ImportedFile[] = [];
  const dumpsByHost = new Map<string, StagedDump[]>();

  for (const entry of entries) {
    const sourceFileId = entry.sourceFileId ?? `file:${entry.path}`;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(entry.bytes);
    const parsed = safeParseJson(text, sourceFileId);
    if (parsed.diagnostic) {
      diagnostics.push(parsed.diagnostic);
      files.push({ path: entry.path, sizeBytes: entry.sizeBytes, kind: "load-error" });
      continue;
    }
    const classification = classifyJson(parsed.value, entry.path);

    if (classification.shape === "definitions") {
      const hostName = classification.hostHint ?? deriveHostFromPath(entry.path);
      const definitions = parseDefinitionsExport({
        json: parsed.value,
        hostName,
        sourceFileId,
      });
      diagnostics.push(...definitions.diagnostics);
      const runtime = parseRuntimeParameters({
        hostId: definitions.host.id,
        vhosts: definitions.vhosts,
        parameters: definitions.rawParameters,
        sourceFileId,
      });
      diagnostics.push(...runtime.diagnostics);
      files.push({
        path: entry.path,
        sizeBytes: entry.sizeBytes,
        kind: "definitions",
        classification,
        parsed: definitions,
        runtime,
      });
      continue;
    }

    if (classification.shape.startsWith("management-dump-")) {
      const shape = classification.shape.slice("management-dump-".length) as SplitShape;
      const hostKey =
        classification.hostHint ?? deriveHostFromPath(entry.path) ?? "__unknown_host__";
      const bucket = dumpsByHost.get(hostKey);
      const staged: StagedDump = {
        shape,
        json: parsed.value,
        path: entry.path,
        sizeBytes: entry.sizeBytes,
        classification,
        sourceFileId,
      };
      if (bucket) bucket.push(staged);
      else dumpsByHost.set(hostKey, [staged]);
      continue;
    }

    files.push({
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      kind: "unknown-json",
      classification,
    });
  }

  // Phase 2: group-parse each host's staged management-dump files.
  for (const [hostKey, staged] of dumpsByHost) {
    const hostName = hostKey === "__unknown_host__" ? undefined : hostKey;
    const split = parseSplitManagementDump({
      hostName,
      files: staged.map((s) => ({
        shape: s.shape,
        json: s.json,
        sourceFileId: s.sourceFileId,
      })),
    });
    diagnostics.push(...split.diagnostics);
    const runtime = parseRuntimeParameters({
      hostId: split.host.id,
      vhosts: split.vhosts,
      parameters: split.rawParameters,
    });
    diagnostics.push(...runtime.diagnostics);

    // Attach the aggregated parsed + runtime result to the FIRST staged entry
    // only — the totals summary sums per-file `parsed.*.length`, and every
    // entry sharing the same reference would inflate the counts.
    for (let i = 0; i < staged.length; i += 1) {
      const dump = staged[i]!;
      files.push({
        path: dump.path,
        sizeBytes: dump.sizeBytes,
        kind: "management-dump",
        classification: dump.classification,
        ...(i === 0 ? { parsed: split, runtime } : {}),
      });
    }
  }

  return files;
}

function deriveHostFromPath(path: string): string | undefined {
  // Simple heuristic: for paths like "hosts/rabbit-a/definitions.json" the
  // classifier already surfaced this via `hostHint`. As a fallback, use the
  // basename's leading segment before a dot when the caller doesn't provide
  // anything else (e.g. "rabbit-a.definitions.json" → "rabbit-a"). Keep
  // canonical root-level dump names unhinted: "queues.json" is a shape, not a
  // host called "queues".
  const segments = path.split(/[\\/]/);
  const base = segments[segments.length - 1] ?? "";
  if (CANONICAL_ROOT_FILENAMES.has(base.toLowerCase())) return undefined;
  const dot = base.indexOf(".");
  return dot > 0 ? base.slice(0, dot) : undefined;
}

const CANONICAL_ROOT_FILENAMES = new Set([
  "definitions.json",
  "queues.json",
  "exchanges.json",
  "bindings.json",
  "parameters.json",
  "policies.json",
  "vhosts.json",
]);

/**
 * Import a batch of individually-selected files as one coherent topology.
 * Reuses the archive two-phase pipeline (`processJsonEntries`) so that related
 * split-dump files (`queues.json`, `exchanges.json`, `bindings.json`,
 * `parameters.json`, `policies.json`, `vhosts.json`) picked together are
 * group-parsed via `parseSplitManagementDump` — the same way a folder of dumps
 * dropped into a ZIP archive would be resolved.
 *
 * Limits work per-file (`maxEntryBytes`), per-batch cumulative
 * (`maxTotalDecompressedBytes`), and per-count (`maxEntryCount`). Non-JSON
 * files are recorded but skipped rather than aborting the batch — mirrors
 * archive-import semantics.
 */
export async function importTopologyBatch(
  input: BatchImportInput,
): Promise<ImportResult> {
  const diagnostics: Diagnostic[] = [];
  const limits: ImportLimits = { ...IMPORT_DEFAULT_LIMITS, ...input.limits };
  const files = input.files;
  const preSkipped = input.skipped ?? [];
  const totalFileCount = files.length + preSkipped.length;
  const archivePath =
    totalFileCount === 0
      ? "batch (empty)"
      : totalFileCount === 1
        ? `batch: ${(files[0] ?? preSkipped[0])!.fileName}`
        : `batch: ${totalFileCount} files`;

  if (totalFileCount === 0) {
    diagnostics.push({
      severity: "warning",
      code: "import.batch-empty",
      message: "Batch import was called with no files.",
    });
    return { archiveKind: "batch", archivePath, files: [], diagnostics };
  }

  if (totalFileCount > limits.maxEntryCount) {
    diagnostics.push({
      severity: "error",
      code: "import.too-many-entries",
      message: `Batch of ${totalFileCount} files exceeds the entry-count limit (${limits.maxEntryCount}). Refusing to import.`,
    });
    // Even in the reject path we surface every filename the caller supplied
    // so the picker's selection list stays visible in the UI summary, and
    // any preflight diagnostics the caller attached to `skipped` entries are
    // preserved (not overwritten by the top-level reject).
    for (let i = 0; i < preSkipped.length; i += 1) {
      const s = preSkipped[i]!;
      const idx = s.selectionIndex ?? files.length + i;
      const sourceFileId = `${indexKey(idx)}:${s.fileName}`;
      diagnostics.push({
        severity:
          s.reason === "preflight-total-size-exceeded" ||
          s.reason === "preflight-too-many-files" ||
          s.reason === "read-failed"
            ? "error"
            : "warning",
        code: preflightCodeFor(s.reason),
        message: `File '${s.fileName}' (${s.sizeBytes} bytes) was skipped by the caller before load${s.detail ? `: ${s.detail}` : "."}`,
        sourceFileId,
      });
    }
    const rejectedFiles: ImportedFile[] = [
      ...files.map((f) => ({
        path: f.fileName,
        sizeBytes: f.bytes.byteLength,
        kind: "load-error" as const,
      })),
      ...preSkipped.map((s) => ({
        path: s.fileName,
        sizeBytes: s.sizeBytes,
        kind: "load-error" as const,
      })),
    ];
    return { archiveKind: "batch", archivePath, files: rejectedFiles, diagnostics };
  }

  const jsonEntries: RawJsonEntry[] = [];
  const skippedRecords: ImportedFile[] = [];
  const nonJson: ImportedFile[] = [];
  let cumulativeBytes = 0;
  let totalCapCrossedAt: number | undefined;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    // Prefer the caller-supplied `selectionIndex` (the file's original
    // position in the picker) over the array position — otherwise a UI that
    // separates readable and skipped files into different buckets would end
    // up assigning `batch[N]` ids out of picker order, and duplicate
    // filenames would collide with misleading attribution.
    const idx = file.selectionIndex ?? i;
    // `sourceFileId` gets the batch-index disambiguator so duplicate filenames
    // in the picker (`queues.json` from two different hosts, say) yield
    // distinct diagnostic ids; the visible `path` stays as the plain
    // filename so host-derivation heuristics in `processJsonEntries` (e.g.
    // `rabbit-a.queues.json` → host `rabbit-a`) keep working.
    const sourceFileId = `${indexKey(idx)}:${file.fileName}`;
    if (file.bytes.byteLength > limits.maxEntryBytes) {
      diagnostics.push({
        severity: "warning",
        code: "import.entry-too-large",
        message: `File '${file.fileName}' is ${file.bytes.byteLength} bytes; the per-entry limit is ${limits.maxEntryBytes}. Skipping.`,
        sourceFileId,
      });
      skippedRecords.push({
        path: file.fileName,
        sizeBytes: file.bytes.byteLength,
        kind: "load-error",
      });
      continue;
    }
    if (
      totalCapCrossedAt === undefined &&
      cumulativeBytes + file.bytes.byteLength > limits.maxTotalDecompressedBytes
    ) {
      diagnostics.push({
        severity: "error",
        code: "import.total-size-exceeded",
        message: `Batch exceeded the total-size limit (${limits.maxTotalDecompressedBytes}) at '${file.fileName}'. Stopping iteration.`,
        sourceFileId,
      });
      totalCapCrossedAt = i;
    }
    if (totalCapCrossedAt !== undefined) {
      skippedRecords.push({
        path: file.fileName,
        sizeBytes: file.bytes.byteLength,
        kind: "load-error",
      });
      continue;
    }
    cumulativeBytes += file.bytes.byteLength;
    if (file.fileName.toLowerCase().endsWith(".json")) {
      jsonEntries.push({
        path: file.fileName,
        sizeBytes: file.bytes.byteLength,
        bytes: file.bytes,
        sourceFileId,
      });
    } else {
      nonJson.push({
        path: file.fileName,
        sizeBytes: file.bytes.byteLength,
        kind: "non-json",
      });
    }
  }

  // Merge caller-preflighted skips with the same load-error treatment.
  for (let i = 0; i < preSkipped.length; i += 1) {
    const s = preSkipped[i]!;
    // Same rule as above — honour the caller-supplied `selectionIndex` so
    // skipped files keep their picker-order attribution when a UI splits
    // its selection into separate readable / skipped arrays.
    const idx = s.selectionIndex ?? files.length + i;
    const sourceFileId = `${indexKey(idx)}:${s.fileName}`;
    diagnostics.push({
      severity:
        s.reason === "preflight-total-size-exceeded" ||
        s.reason === "preflight-too-many-files" ||
        s.reason === "read-failed"
          ? "error"
          : "warning",
      code: preflightCodeFor(s.reason),
      message: `File '${s.fileName}' (${s.sizeBytes} bytes) was skipped by the caller before load${s.detail ? `: ${s.detail}` : "."}`,
      sourceFileId,
    });
    skippedRecords.push({
      path: s.fileName,
      sizeBytes: s.sizeBytes,
      kind: "load-error",
    });
  }

  const parsed = processJsonEntries(jsonEntries, diagnostics);
  return {
    archiveKind: "batch",
    archivePath,
    files: [...parsed, ...nonJson, ...skippedRecords],
    diagnostics,
  };
}

function indexKey(index: number): string {
  return `batch[${index}]`;
}

function preflightCodeFor(reason: BatchSkippedInput["reason"]): string {
  switch (reason) {
    case "preflight-per-entry-too-large":
      return "import.preflight-entry-too-large";
    case "preflight-total-size-exceeded":
      return "import.preflight-total-size-exceeded";
    case "preflight-too-many-files":
      return "import.preflight-too-many-files";
    case "preflight-non-json-in-batch":
      return "import.preflight-non-json-in-batch";
    case "read-failed":
      return "import.read-failed";
    case "preflight-unprocessed":
    default:
      return "import.preflight-unprocessed";
  }
}
