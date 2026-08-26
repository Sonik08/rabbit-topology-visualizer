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
  archiveKind: "rar" | "zip" | "json" | "unknown";
  archivePath: string;
  files: ImportedFile[];
  diagnostics: Diagnostic[];
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
    const text = new TextDecoder("utf-8", { fatal: false }).decode(entry.bytes);
    const parsed = safeParseJson(text, `file:${entry.path}`);
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
        sourceFileId: `file:${entry.path}`,
      });
      diagnostics.push(...definitions.diagnostics);
      const runtime = parseRuntimeParameters({
        hostId: definitions.host.id,
        vhosts: definitions.vhosts,
        parameters: definitions.rawParameters,
        sourceFileId: `file:${entry.path}`,
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
        sourceFileId: `file:${s.path}`,
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
