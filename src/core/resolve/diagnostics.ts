import type { Diagnostic, DiagnosticSeverity } from "../model/topology";

export interface DiagnosticSummary {
  total: number;
  counts: Record<DiagnosticSeverity, number>;
  byCode: Array<{ code: string; count: number }>;
}

/**
 * Removes duplicate diagnostics. Two diagnostics are considered duplicate when
 * their severity, code, message, sourceFileId, hostId, vhostId, and entityId
 * are all equal. Order of first appearance is preserved.
 */
export function dedupeDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of diagnostics) {
    const key = [
      d.severity,
      d.code,
      d.message,
      d.sourceFileId ?? "",
      d.hostId ?? "",
      d.vhostId ?? "",
      d.entityId ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** Buckets diagnostics by severity, returning an object with typed arrays. */
export function groupBySeverity(
  diagnostics: readonly Diagnostic[],
): Record<DiagnosticSeverity, Diagnostic[]> {
  const out: Record<DiagnosticSeverity, Diagnostic[]> = {
    info: [],
    warning: [],
    error: [],
  };
  for (const d of diagnostics) {
    out[d.severity].push(d);
  }
  return out;
}

/** Produces a compact counts summary suitable for the UI diagnostics panel. */
export function summarizeDiagnostics(
  diagnostics: readonly Diagnostic[],
): DiagnosticSummary {
  const counts: Record<DiagnosticSeverity, number> = {
    info: 0,
    warning: 0,
    error: 0,
  };
  const codeCounts = new Map<string, number>();
  for (const d of diagnostics) {
    counts[d.severity] += 1;
    codeCounts.set(d.code, (codeCounts.get(d.code) ?? 0) + 1);
  }
  const byCode = [...codeCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return {
    total: diagnostics.length,
    counts,
    byCode,
  };
}

/** Convenience filter: highest severity first. */
export function sortBySeverity(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const rank: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };
  return [...diagnostics].sort((a, b) => rank[a.severity] - rank[b.severity]);
}
