import { describe, expect, it, vi } from "vitest";

// This test suite exercises the RAR loader's post-extraction cumulative-size
// enforcement using a mocked `createExtractorFromData` from `node-unrar-js`.
// A real RAR with faithful headers can't exercise the "preflight accepts,
// extraction exceeds" path — headers already report `unpSize` truthfully, so
// the preflight would reject or admit consistently with extraction. Mocking
// lets us build headers that lie: preflight sums to a small number while
// actual `extraction.byteLength` blows past `maxTotalBytes`.

interface FakeHeader {
  name: string;
  unpSize: number;
  flags: { directory: boolean; encrypted: boolean; solid: boolean };
  method: string;
  packSize: number;
  crc: number;
  time: string;
  unpVer: string;
  comment: string;
}

interface FakeArcFile {
  fileHeader: FakeHeader;
  extraction?: Uint8Array;
}

function mkHeader(name: string, unpSize: number): FakeHeader {
  return {
    name,
    unpSize,
    packSize: unpSize,
    flags: { directory: false, encrypted: false, solid: false },
    crc: 0,
    time: "",
    unpVer: "5.0",
    method: "Storing",
    comment: "",
  };
}

vi.mock("node-unrar-js", () => {
  const mockCreate = vi.fn();
  return {
    createExtractorFromData: mockCreate,
  };
});

// Import AFTER vi.mock so the loader picks up the mocked module.
const { loadRarArchive } = await import("../../../src/core/parse/rarLoader");
const { createExtractorFromData } = (await import("node-unrar-js")) as unknown as {
  createExtractorFromData: ReturnType<typeof vi.fn>;
};

function riggedExtractor(
  headers: FakeHeader[],
  actualBytesByName: Record<string, Uint8Array>,
): unknown {
  return {
    getFileList: () => ({
      arcHeader: { comment: "", flags: {} },
      fileHeaders: (function* () {
        for (const h of headers) yield h;
      })(),
    }),
    extract: () => ({
      arcHeader: { comment: "", flags: {} },
      files: (function* (): Generator<FakeArcFile> {
        for (const h of headers) {
          yield { fileHeader: h, extraction: actualBytesByName[h.name] };
        }
      })(),
    }),
  };
}

describe("loadRarArchive — actual cumulative bytes exceed maxTotalBytes after preflight admits", () => {
  it("clears the file list and emits rar.total-size-limit-exceeded when a late entry crosses the cumulative cap", async () => {
    // Headers claim tiny sizes so preflight admits both entries. Actual
    // extraction returns much larger buffers, and the second entry crosses
    // maxTotalBytes = 5 000.
    const smallData = new TextEncoder().encode("small file OK");
    const bigData = new Uint8Array(10_000); // 10 KB, doubles the cap on its own
    const headers = [
      mkHeader("small.json", 20), // preflight thinks 20 bytes
      mkHeader("big.json", 20), // preflight also thinks 20 bytes
    ];
    createExtractorFromData.mockResolvedValueOnce(
      riggedExtractor(headers, {
        "small.json": smallData,
        "big.json": bigData,
      }),
    );

    const r = await loadRarArchive({
      bytes: new Uint8Array(16),
      maxTotalBytes: 5_000,
      // Very generous per-entry cap so ONLY the cumulative check can trip.
      maxEntryBytes: 100_000,
      maxEntries: 100,
      maxArchiveBytes: 10_000_000,
    });

    // Terminal cumulative-size diagnostic must fire.
    expect(
      r.diagnostics.some((d) => d.code === "rar.total-size-limit-exceeded"),
    ).toBe(true);
    // No partial file list is returned even though `small.json` was appended
    // before the breach — the caller must never see an incomplete topology
    // as "successfully imported".
    expect(r.files).toEqual([]);
  });

  it("clears the file list when actual per-entry bytes exceed maxEntryBytes after preflight admits (belt-and-suspenders)", async () => {
    // Header claims tiny, actual is huge; per-entry check is a warning that
    // continues, but this proves the total-limit path is what carries the
    // 'no partial results' guarantee for terminal breaches.
    const bigData = new Uint8Array(10_000);
    const headers = [mkHeader("big.json", 20)];
    createExtractorFromData.mockResolvedValueOnce(
      riggedExtractor(headers, { "big.json": bigData }),
    );

    const r = await loadRarArchive({
      bytes: new Uint8Array(16),
      maxTotalBytes: 100_000, // generous total
      maxEntryBytes: 5_000, // per-entry cap
      maxEntries: 100,
      maxArchiveBytes: 10_000_000,
    });

    // Per-entry check is a warning and continues; total limit is not hit.
    // The one oversized entry is skipped → files stays empty.
    expect(r.files).toEqual([]);
    expect(
      r.diagnostics.some(
        (d) => d.code === "rar.entry-too-large" && d.severity === "warning",
      ),
    ).toBe(true);
  });
});
