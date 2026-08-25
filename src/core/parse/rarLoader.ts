import { createExtractorFromData } from "node-unrar-js";
import type { FileHeader } from "node-unrar-js";
import type { Diagnostic } from "../model/topology";

export interface RarEntry {
  /** Relative path inside the archive. */
  path: string;
  /** Uncompressed size in bytes, as reported by the archive header. */
  sizeBytes: number;
  /** Raw file contents. */
  data: Uint8Array;
}

export interface LoadRarInput {
  /** Raw RAR archive bytes. */
  bytes: Uint8Array | ArrayBuffer;
  /**
   * Optional filter — either a list of paths to extract, or a predicate against
   * each path. When omitted, every file entry is considered for extraction.
   */
  filter?: string[] | ((path: string) => boolean);
  /** Optional password for encrypted archives. */
  password?: string;
  /** Optional source label used to attribute diagnostics. */
  sourceFileId?: string;
  /** Maximum compressed archive size accepted in memory. Default: 100 MiB. */
  maxArchiveBytes?: number;
  /** Maximum matching file entries to extract. Default: 1000. */
  maxEntries?: number;
  /** Maximum uncompressed bytes for one entry. Default: 50 MiB. */
  maxEntryBytes?: number;
  /** Maximum total uncompressed bytes for all extracted entries. Default: 200 MiB. */
  maxTotalBytes?: number;
}

export interface LoadRarResult {
  files: RarEntry[];
  diagnostics: Diagnostic[];
}

const DEFAULT_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

function toArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  const view = bytes as Uint8Array;
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

export async function loadRarArchive(input: LoadRarInput): Promise<LoadRarResult> {
  const diagnostics: Diagnostic[] = [];
  const files: RarEntry[] = [];
  const limits = readLimits(input);

  const buffer = toArrayBuffer(input.bytes);
  if (buffer.byteLength === 0) {
    diagnostics.push({
      severity: "error",
      code: "rar.empty-buffer",
      message: "RAR archive buffer was empty.",
      sourceFileId: input.sourceFileId,
    });
    return { files, diagnostics };
  }

  if (buffer.byteLength > limits.maxArchiveBytes) {
    diagnostics.push({
      severity: "error",
      code: "rar.archive-too-large",
      message: `RAR archive is ${buffer.byteLength} bytes, exceeding the configured ${limits.maxArchiveBytes} byte limit.`,
      sourceFileId: input.sourceFileId,
    });
    return { files, diagnostics };
  }

  const extractor = await createExtractor(buffer, input, diagnostics);
  if (!extractor) return { files, diagnostics };

  const { allHeaders, selectedHeaders } = listSafeHeaders(extractor, input, diagnostics);
  if (diagnostics.some((d) => d.severity === "error")) {
    return { files, diagnostics };
  }

  if (!validateLimits(allHeaders, limits, input.sourceFileId, diagnostics)) {
    return { files, diagnostics };
  }

  if (selectedHeaders.length === 0) {
    return { files, diagnostics };
  }

  let extraction;
  try {
    extraction = extractor.extract({
      files: selectedHeaders.map((header) => header.name),
      password: input.password,
    });
  } catch (err) {
    diagnostics.push({
      severity: "error",
      code: "rar.extract-failed",
      message: `RAR extraction failed: ${describeError(err)}`,
      sourceFileId: input.sourceFileId,
    });
    return { files, diagnostics };
  }

  try {
    let totalBytes = 0;
    for (const file of extraction.files) {
      const header = file.fileHeader;
      if (header.flags.directory) continue;
      if (header.flags.encrypted) {
        diagnostics.push({
          severity: "warning",
          code: "rar.entry-encrypted",
          message: `Skipping encrypted entry '${header.name}' (no password provided or wrong password).`,
          sourceFileId: input.sourceFileId,
        });
        continue;
      }
      const data = file.extraction;
      if (!(data instanceof Uint8Array)) {
        diagnostics.push({
          severity: "warning",
          code: "rar.entry-empty",
          message: `Entry '${header.name}' produced no data during extraction.`,
          sourceFileId: input.sourceFileId,
        });
        continue;
      }
      if (data.byteLength > limits.maxEntryBytes) {
        diagnostics.push({
          severity: "error",
          code: "rar.entry-too-large",
          message: `Entry '${header.name}' extracted to ${data.byteLength} bytes, exceeding the configured ${limits.maxEntryBytes} byte limit.`,
          sourceFileId: input.sourceFileId,
        });
        break;
      }
      totalBytes += data.byteLength;
      if (totalBytes > limits.maxTotalBytes) {
        diagnostics.push({
          severity: "error",
          code: "rar.total-size-limit-exceeded",
          message: `RAR extraction exceeded the configured ${limits.maxTotalBytes} byte total limit.`,
          sourceFileId: input.sourceFileId,
        });
        break;
      }
      files.push({
        path: header.name,
        sizeBytes: header.unpSize,
        data,
      });
    }
  } catch (err) {
    diagnostics.push({
      severity: "error",
      code: "rar.iterate-failed",
      message: `Iterating RAR entries failed: ${describeError(err)}`,
      sourceFileId: input.sourceFileId,
    });
  }

  if (diagnostics.some((d) => d.severity === "error")) {
    return { files: [], diagnostics };
  }

  return { files, diagnostics };
}

export function filterJsonEntries(files: RarEntry[]): RarEntry[] {
  return files.filter((f) => f.path.toLowerCase().endsWith(".json"));
}

interface RarLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

function readLimits(input: LoadRarInput): RarLimits {
  return {
    maxArchiveBytes: boundedNumber(input.maxArchiveBytes, DEFAULT_MAX_ARCHIVE_BYTES),
    maxEntries: boundedNumber(input.maxEntries, DEFAULT_MAX_ENTRIES),
    maxEntryBytes: boundedNumber(input.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES),
    maxTotalBytes: boundedNumber(input.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
  };
}

function boundedNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

async function createExtractor(
  buffer: ArrayBuffer,
  input: LoadRarInput,
  diagnostics: Diagnostic[],
) {
  try {
    return await createExtractorFromData({
      data: buffer,
      password: input.password,
    });
  } catch (err) {
    diagnostics.push({
      severity: "error",
      code: "rar.open-failed",
      message: `Could not open RAR archive: ${describeError(err)}`,
      sourceFileId: input.sourceFileId,
    });
    return undefined;
  }
}

function listSafeHeaders(
  extractor: Awaited<ReturnType<typeof createExtractorFromData>>,
  input: LoadRarInput,
  diagnostics: Diagnostic[],
): { allHeaders: FileHeader[]; selectedHeaders: FileHeader[] } {
  let listing;
  try {
    listing = extractor.getFileList();
  } catch (err) {
    diagnostics.push({
      severity: "error",
      code: "rar.list-failed",
      message: `Could not list RAR archive: ${describeError(err)}`,
      sourceFileId: input.sourceFileId,
    });
    return { allHeaders: [], selectedHeaders: [] };
  }

  const allHeaders: FileHeader[] = [];
  const selected: FileHeader[] = [];
  try {
    for (const header of listing.fileHeaders) {
      allHeaders.push(header);
      if (!isSafeRelativePath(header.name)) {
        diagnostics.push({
          severity: "warning",
          code: "rar.entry-path-unsafe",
          message: `Skipping unsafe archive entry path '${header.name}'.`,
          sourceFileId: input.sourceFileId,
        });
        continue;
      }
      if (header.flags.directory) continue;
      if (!matchesFilter(header.name, input.filter)) continue;
      if (header.flags.encrypted && !input.password) {
        diagnostics.push({
          severity: "warning",
          code: "rar.entry-encrypted",
          message: `Skipping encrypted entry '${header.name}' (no password provided).`,
          sourceFileId: input.sourceFileId,
        });
        continue;
      }
      selected.push(header);
    }
  } catch (err) {
    diagnostics.push({
      severity: "error",
      code: "rar.list-failed",
      message: `Could not list RAR archive entries: ${describeError(err)}`,
      sourceFileId: input.sourceFileId,
    });
  }
  return { allHeaders, selectedHeaders: selected };
}

function matchesFilter(path: string, filter: LoadRarInput["filter"]): boolean {
  if (Array.isArray(filter)) return filter.includes(path);
  if (typeof filter === "function") return filter(path);
  return true;
}

function isSafeRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  return !path
    .split(/[\\/]+/)
    .some((part) => part === ".." || part.length === 0);
}

function validateLimits(
  headers: FileHeader[],
  limits: RarLimits,
  sourceFileId: string | undefined,
  diagnostics: Diagnostic[],
): boolean {
  if (headers.length > limits.maxEntries) {
    diagnostics.push({
      severity: "error",
      code: "rar.entry-limit-exceeded",
      message: `RAR archive contains ${headers.length} entries, exceeding the configured ${limits.maxEntries} entry limit.`,
      sourceFileId,
    });
    return false;
  }

  let totalBytes = 0;
  for (const header of headers) {
    const entrySize = safeSize(header.unpSize);
    if (entrySize > limits.maxEntryBytes) {
      diagnostics.push({
        severity: "error",
        code: "rar.entry-too-large",
        message: `Entry '${header.name}' reports ${entrySize} uncompressed bytes, exceeding the configured ${limits.maxEntryBytes} byte limit.`,
        sourceFileId,
      });
      return false;
    }
    totalBytes += entrySize;
    if (totalBytes > limits.maxTotalBytes) {
      diagnostics.push({
        severity: "error",
        code: "rar.total-size-limit-exceeded",
        message: `RAR archive reports ${totalBytes} total uncompressed bytes, exceeding the configured ${limits.maxTotalBytes} byte limit.`,
        sourceFileId,
      });
      return false;
    }
  }
  return true;
}

function safeSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
