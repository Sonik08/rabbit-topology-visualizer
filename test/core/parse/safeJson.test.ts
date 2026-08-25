import { describe, expect, it } from "vitest";
import { safeParseJson } from "../../../src/core/parse/safeJson";

describe("safeParseJson", () => {
  it("returns the parsed value for valid JSON", () => {
    const r = safeParseJson('{"a":1,"b":[2,3]}');
    expect(r.diagnostic).toBeUndefined();
    expect(r.value).toEqual({ a: 1, b: [2, 3] });
  });

  it("returns a parse.malformed-json diagnostic for invalid JSON", () => {
    const r = safeParseJson("{not-json", "file:bad.json");
    expect(r.value).toBeUndefined();
    expect(r.diagnostic?.code).toBe("parse.malformed-json");
    expect(r.diagnostic?.severity).toBe("error");
    expect(r.diagnostic?.sourceFileId).toBe("file:bad.json");
    expect(r.diagnostic?.message).toContain("Malformed JSON");
  });

  it("returns a parse.empty-input diagnostic for empty strings", () => {
    const r = safeParseJson("", "file:empty");
    expect(r.diagnostic?.code).toBe("parse.empty-input");
    expect(r.diagnostic?.sourceFileId).toBe("file:empty");
  });

  it("returns a parse.non-string-input diagnostic for non-string input", () => {
    const r = safeParseJson(123 as unknown as string);
    expect(r.diagnostic?.code).toBe("parse.non-string-input");
  });
});
