import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  filterJsonEntries,
  loadRarArchive,
} from "../../../src/core/parse/rarLoader";

const here = dirname(fileURLToPath(import.meta.url));
const folderTestRar = resolve(here, "..", "..", "fixtures", "rar", "FolderTest.rar");

describe("loadRarArchive — happy path (FolderTest.rar)", () => {
  it("extracts every file entry with a name and non-negative size", async () => {
    const bytes = readFileSync(folderTestRar);
    const { files, diagnostics } = await loadRarArchive({ bytes });

    expect(diagnostics).toEqual([]);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(typeof f.path).toBe("string");
      expect(f.path.length).toBeGreaterThan(0);
      expect(f.sizeBytes).toBeGreaterThanOrEqual(0);
      expect(f.data).toBeInstanceOf(Uint8Array);
    }
  });

  it("honours a filter that matches no files (returns empty file list, no diagnostics)", async () => {
    const bytes = readFileSync(folderTestRar);
    const { files, diagnostics } = await loadRarArchive({
      bytes,
      filter: (path) => path.endsWith(".definitely-not-real"),
    });
    expect(files).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("accepts ArrayBuffer inputs equivalently to Uint8Array", async () => {
    const view = readFileSync(folderTestRar);
    const ab = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    const { files } = await loadRarArchive({ bytes: ab });
    expect(files.length).toBeGreaterThan(0);
  });
});

describe("loadRarArchive — error paths", () => {
  it("returns an rar.empty-buffer diagnostic for zero-length input", async () => {
    const { files, diagnostics } = await loadRarArchive({
      bytes: new Uint8Array(0),
      sourceFileId: "file:empty",
    });
    expect(files).toEqual([]);
    expect(diagnostics[0]?.code).toBe("rar.empty-buffer");
    expect(diagnostics[0]?.sourceFileId).toBe("file:empty");
  });

  it("returns an rar.open-failed diagnostic when the bytes are not a valid RAR", async () => {
    const junk = new TextEncoder().encode('{"not":"a-rar"}');
    const { files, diagnostics } = await loadRarArchive({
      bytes: junk,
      sourceFileId: "file:junk",
    });
    expect(files).toEqual([]);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "rar.open-failed" ||
          d.code === "rar.list-failed" ||
          d.code === "rar.iterate-failed" ||
          d.code === "rar.extract-failed",
      ),
    ).toBe(true);
  });

  it("rejects archives above the compressed archive size limit before opening", async () => {
    const bytes = readFileSync(folderTestRar);
    const { files, diagnostics } = await loadRarArchive({
      bytes,
      maxArchiveBytes: 1,
      sourceFileId: "file:too-large",
    });
    expect(files).toEqual([]);
    expect(diagnostics[0]?.code).toBe("rar.archive-too-large");
    expect(diagnostics[0]?.sourceFileId).toBe("file:too-large");
  });

  it("rejects archives whose total file count exceeds the configured limit before filtering", async () => {
    const bytes = readFileSync(folderTestRar);
    const { files, diagnostics } = await loadRarArchive({
      bytes,
      maxEntries: 4,
      filter: (path) => path.endsWith(".definitely-not-real"),
    });
    expect(files).toEqual([]);
    expect(diagnostics.some((d) => d.code === "rar.entry-limit-exceeded")).toBe(true);
  });

  it("skips a selected header-oversized entry and still extracts a later valid entry", async () => {
    const bytes = readFileSync(folderTestRar);
    const { files, diagnostics } = await loadRarArchive({
      bytes,
      maxEntryBytes: 1024,
    });
    expect(files.map((file) => file.path)).toEqual(["Folder1/Folder 中文/2中文.txt"]);
    expect(files[0]?.sizeBytes).toBe(files[0]?.data.byteLength);
    expect(
      diagnostics.some(
        (d) => d.code === "rar.entry-too-large" && d.severity === "warning",
      ),
    ).toBe(true);
  });

  it("rejects archives whose reported total uncompressed size exceeds the total limit", async () => {
    const bytes = readFileSync(folderTestRar);
    const { files, diagnostics } = await loadRarArchive({
      bytes,
      maxEntryBytes: 2_000_000,
      maxTotalBytes: 1024,
      filter: (path) => path.endsWith(".definitely-not-real"),
    });
    expect(files).toEqual([]);
    expect(diagnostics.some((d) => d.code === "rar.total-size-limit-exceeded")).toBe(true);
  });
});

describe("filterJsonEntries", () => {
  it("keeps only .json entries (case-insensitive)", () => {
    const files = [
      { path: "a.json", sizeBytes: 1, data: new Uint8Array() },
      { path: "b/c.JSON", sizeBytes: 1, data: new Uint8Array() },
      { path: "d.txt", sizeBytes: 1, data: new Uint8Array() },
      { path: "no-ext", sizeBytes: 1, data: new Uint8Array() },
    ];
    expect(filterJsonEntries(files).map((f) => f.path)).toEqual([
      "a.json",
      "b/c.JSON",
    ]);
  });
});
