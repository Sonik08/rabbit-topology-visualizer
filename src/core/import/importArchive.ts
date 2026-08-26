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
    // EntryBudget below remains a defence-in-depth check over returned data.
    maxArchiveBytes: limits.maxArchiveBytes,
    maxEntries: limits.maxEntryCount,
    maxEntryBytes: limits.maxEntryBytes,
    maxTotalBytes: limits.maxTotalDecompressedBytes,
  });
  diagnostics.push(...rar.diagnostics);
  const entries: RawJsonEntry[] = [];
  const nonJson: ImportedFile[] = [];
  const budget = new EntryBudget(limits, diagnostics, input.fileName);
  for (const entry of rar.files) {
    const decision = budget.admit(entry.path, entry.sizeBytes);
    if (decision === "stop") break;
    if (decision === "skip") continue;
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
  // Keep declared-size preflight separate from actual decompressed-byte
  // accounting. ZIP metadata is useful for refusing obvious bombs before
  // allocation, but it is not trusted: every extracted entry is admitted
  // again against an independent budget using its real byte length.
  const preflightBudget = new EntryBudget(limits, diagnostics, input.fileName);
  const actualBudget = new EntryBudget(
    { ...limits, maxEntryCount: Number.MAX_SAFE_INTEGER },
    diagnostics,
    input.fileName,
  );
  const zipEntries = Object.values(zip.files).filter((f) => !f.dir);
  for (const entry of zipEntries) {
    // JSZip's public interface exposes `_data.uncompressedSize` on internal
    // entries; when present we can pre-check the per-entry limit BEFORE
    // decompressing (blocks zip bombs). When absent, fall back to admitting
    // with a sentinel size and re-checking after decompression.
    const rawSize = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize) || 0;
    const preflightDecision = preflightBudget.admit(entry.name, rawSize);
    if (preflightDecision === "stop") break;
    if (preflightDecision === "skip") continue;

    const bytes = await entry.async("uint8array");
    const actualDecision = actualBudget.admit(entry.name, bytes.byteLength);
    if (actualDecision === "stop") break;
    if (actualDecision === "skip") continue;

    if (entry.name.toLowerCase().endsWith(".json")) {
      entries.push({ path: entry.name, sizeBytes: bytes.byteLength, bytes });
    } else {
      nonJson.push({ path: entry.name, sizeBytes: bytes.byteLength, kind: "non-json" });
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

/**
 * Enforces per-entry, per-count, and total-decompressed-size limits during
 * archive iteration. `admit(path, size)` returns a tri-state so callers can
 * distinguish "keep this entry" from "skip this entry, keep iterating" from
 * "hit a terminal budget, stop iterating".
 *
 *   - `"admit"` — the entry is within all limits; include it.
 *   - `"skip"`  — this entry alone violates `maxEntryBytes`; drop it but keep
 *                 processing later entries (they may be smaller and valid).
 *   - `"stop"`  — a terminal budget was breached (`maxEntryCount` or
 *                 `maxTotalDecompressedBytes`); the caller must `break` and
 *                 stop scanning further entries.
 *
 * One diagnostic is emitted per breach.
 */
export type EntryBudgetDecision = "admit" | "skip" | "stop";

class EntryBudget {
  private entryCount = 0;
  private totalBytes = 0;
  private stopped = false;

  constructor(
    private readonly limits: ImportLimits,
    private readonly diagnostics: Diagnostic[],
    private readonly archiveName: string,
  ) {}

  admit(path: string, sizeBytes: number): EntryBudgetDecision {
    if (this.stopped) return "stop";
    if (this.entryCount >= this.limits.maxEntryCount) {
      this.diagnostics.push({
        severity: "error",
        code: "import.too-many-entries",
        message: `Archive '${this.archiveName}' exceeded the entry-count limit (${this.limits.maxEntryCount}). Stopping iteration.`,
        sourceFileId: `file:${this.archiveName}`,
      });
      this.stopped = true;
      return "stop";
    }
    if (sizeBytes > this.limits.maxEntryBytes) {
      this.diagnostics.push({
        severity: "warning",
        code: "import.entry-too-large",
        message: `Skipped '${path}' (${sizeBytes} bytes); the per-entry decompressed limit is ${this.limits.maxEntryBytes}.`,
        sourceFileId: `file:${this.archiveName}`,
      });
      this.entryCount += 1;
      return "skip";
    }
    if (this.totalBytes + sizeBytes > this.limits.maxTotalDecompressedBytes) {
      this.diagnostics.push({
        severity: "error",
        code: "import.total-size-exceeded",
        message: `Archive '${this.archiveName}' exceeded the total-decompressed-size limit (${this.limits.maxTotalDecompressedBytes}). Stopping iteration.`,
        sourceFileId: `file:${this.archiveName}`,
      });
      this.stopped = true;
      return "stop";
    }
    this.entryCount += 1;
    this.totalBytes += sizeBytes;
    return "admit";
  }
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
