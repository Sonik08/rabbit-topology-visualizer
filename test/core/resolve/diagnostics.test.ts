import { describe, expect, it } from "vitest";
import {
  dedupeDiagnostics,
  groupBySeverity,
  sortBySeverity,
  summarizeDiagnostics,
} from "../../../src/core/resolve/diagnostics";
import type { Diagnostic } from "../../../src/core/model/topology";

const d = (partial: Partial<Diagnostic> & Pick<Diagnostic, "code" | "message">): Diagnostic => ({
  severity: "warning",
  ...partial,
});

describe("dedupeDiagnostics", () => {
  it("removes exact duplicates and preserves first-seen order", () => {
    const list: Diagnostic[] = [
      d({ code: "a", message: "first" }),
      d({ code: "b", message: "other" }),
      d({ code: "a", message: "first" }),
      d({ code: "a", message: "different message" }),
    ];
    const out = dedupeDiagnostics(list);
    expect(out.map((x) => x.message)).toEqual(["first", "other", "different message"]);
  });

  it("treats diagnostics with different sourceFileId/hostId as distinct", () => {
    const list: Diagnostic[] = [
      d({ code: "a", message: "x", sourceFileId: "f1" }),
      d({ code: "a", message: "x", sourceFileId: "f2" }),
      d({ code: "a", message: "x", hostId: "host:one" }),
    ];
    const out = dedupeDiagnostics(list);
    expect(out).toHaveLength(3);
  });
});

describe("groupBySeverity", () => {
  it("buckets diagnostics into info/warning/error arrays", () => {
    const list: Diagnostic[] = [
      d({ code: "a", message: "1", severity: "info" }),
      d({ code: "b", message: "2", severity: "warning" }),
      d({ code: "c", message: "3", severity: "error" }),
      d({ code: "d", message: "4", severity: "warning" }),
    ];
    const grouped = groupBySeverity(list);
    expect(grouped.info).toHaveLength(1);
    expect(grouped.warning).toHaveLength(2);
    expect(grouped.error).toHaveLength(1);
  });
});

describe("summarizeDiagnostics", () => {
  it("counts by severity and returns most-frequent codes first", () => {
    const list: Diagnostic[] = [
      d({ code: "a", message: "1", severity: "warning" }),
      d({ code: "a", message: "2", severity: "warning" }),
      d({ code: "b", message: "3", severity: "info" }),
      d({ code: "c", message: "4", severity: "error" }),
      d({ code: "a", message: "5", severity: "error" }),
    ];
    const summary = summarizeDiagnostics(list);
    expect(summary.total).toBe(5);
    expect(summary.counts).toEqual({ info: 1, warning: 2, error: 2 });
    expect(summary.byCode[0]).toEqual({ code: "a", count: 3 });
    expect(summary.byCode.map((x) => x.code)).toEqual(["a", "b", "c"]);
  });

  it("returns zeros for an empty list", () => {
    const summary = summarizeDiagnostics([]);
    expect(summary.total).toBe(0);
    expect(summary.counts).toEqual({ info: 0, warning: 0, error: 0 });
    expect(summary.byCode).toEqual([]);
  });
});

describe("sortBySeverity", () => {
  it("puts errors first, then warnings, then info; stable within a severity", () => {
    const list: Diagnostic[] = [
      d({ code: "i1", message: "1", severity: "info" }),
      d({ code: "e1", message: "2", severity: "error" }),
      d({ code: "w1", message: "3", severity: "warning" }),
      d({ code: "e2", message: "4", severity: "error" }),
    ];
    const sorted = sortBySeverity(list);
    expect(sorted.map((x) => x.code)).toEqual(["e1", "e2", "w1", "i1"]);
  });
});
