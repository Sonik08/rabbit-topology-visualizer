import {
  parseDefinitionsExport,
  type ParseDefinitionsResult,
} from "./definitionsParser";
import type { SourceFileId } from "../model/topology";

export type SplitDumpShape =
  | "vhosts"
  | "queues"
  | "exchanges"
  | "bindings"
  | "parameters"
  | "policies";

export interface SplitDumpFile {
  shape: SplitDumpShape;
  json: unknown;
  sourceFileId?: SourceFileId;
}

export interface ParseSplitDumpInput {
  hostName?: string;
  files: SplitDumpFile[];
}

const SYNTHETIC_KEY: Record<SplitDumpShape, string> = {
  vhosts: "vhosts",
  queues: "queues",
  exchanges: "exchanges",
  bindings: "bindings",
  parameters: "parameters",
  policies: "policies",
};

export function parseSplitManagementDump(
  input: ParseSplitDumpInput,
): ParseDefinitionsResult {
  const synthetic: Record<string, unknown[]> = {
    vhosts: [],
    queues: [],
    exchanges: [],
    bindings: [],
    parameters: [],
    policies: [],
  };

  const perShapeSources: Partial<Record<SplitDumpShape, SourceFileId>> = {};
  const sourceFiles = new Set<SourceFileId>();
  const preDiagnostics: ParseDefinitionsResult["diagnostics"] = [];

  for (const file of input.files) {
    if (file.sourceFileId) {
      sourceFiles.add(file.sourceFileId);
      if (perShapeSources[file.shape] === undefined) {
        perShapeSources[file.shape] = file.sourceFileId;
      }
    }
    if (!Array.isArray(file.json)) {
      preDiagnostics.push({
        severity: "warning",
        code: "split-dump.file-not-array",
        message: `Skipped split-dump file for '${file.shape}': payload was not a JSON array.`,
        sourceFileId: file.sourceFileId,
      });
      continue;
    }
    const key = SYNTHETIC_KEY[file.shape];
    synthetic[key]!.push(...file.json);
  }

  const primarySource =
    perShapeSources.vhosts ??
    perShapeSources.exchanges ??
    perShapeSources.queues ??
    perShapeSources.bindings ??
    perShapeSources.parameters ??
    perShapeSources.policies;

  const result = parseDefinitionsExport({
    json: synthetic,
    hostName: input.hostName,
    sourceFileId: primarySource,
  });

  for (const id of sourceFiles) {
    if (!result.host.sourceFiles.includes(id)) {
      result.host.sourceFiles.push(id);
    }
  }

  if (preDiagnostics.length > 0) {
    result.diagnostics = [...preDiagnostics, ...result.diagnostics];
  }

  return result;
}
