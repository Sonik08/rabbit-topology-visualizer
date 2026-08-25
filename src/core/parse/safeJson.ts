import type { Diagnostic, SourceFileId } from "../model/topology";

export interface SafeParseJsonResult {
  value?: unknown;
  diagnostic?: Diagnostic;
}

/**
 * Parses a JSON text without throwing. On failure, returns a `parse.malformed-json`
 * diagnostic that includes the JSON parser's own error message so the offending
 * file can be surfaced in the UI diagnostics panel.
 */
export function safeParseJson(
  text: string,
  sourceFileId?: SourceFileId,
): SafeParseJsonResult {
  if (typeof text !== "string") {
    return {
      diagnostic: {
        severity: "error",
        code: "parse.non-string-input",
        message: "Cannot parse JSON: input was not a string.",
        sourceFileId,
      },
    };
  }
  if (text.length === 0) {
    return {
      diagnostic: {
        severity: "error",
        code: "parse.empty-input",
        message: "Cannot parse JSON: input was empty.",
        sourceFileId,
      },
    };
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      diagnostic: {
        severity: "error",
        code: "parse.malformed-json",
        message: `Malformed JSON: ${detail}`,
        sourceFileId,
      },
    };
  }
}
