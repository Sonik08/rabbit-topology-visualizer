import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  importTopologyBatch,
  type BatchFileInput,
} from "../../../src/core/import/importArchive";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", "..", "fixtures", "minimal-definitions.json");
const definitionsBytes = readFileSync(fixturePath);

function bytesOf(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

describe("importTopologyBatch — happy paths", () => {
  it("returns archiveKind='batch' with an empty summary when called with no files", async () => {
    const result = await importTopologyBatch({ files: [] });
    expect(result.archiveKind).toBe("batch");
    expect(result.files).toEqual([]);
    expect(result.diagnostics.some((d) => d.code === "import.batch-empty")).toBe(true);
  });

  it("parses a single definitions file the same way importTopologyArchive would", async () => {
    const result = await importTopologyBatch({
      files: [{ fileName: "rabbit-a.definitions.json", bytes: new Uint8Array(definitionsBytes) }],
    });
    expect(result.archiveKind).toBe("batch");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.kind).toBe("definitions");
    expect(result.files[0]!.parsed?.exchanges.length).toBeGreaterThan(0);
  });

  it("group-parses related split-dump files (queues + exchanges + bindings) into one host result", async () => {
    // Two split-dump files that share a host derived from the filename.
    const files: BatchFileInput[] = [
      {
        fileName: "rabbit-a.queues.json",
        bytes: bytesOf([
          { name: "q.one", vhost: "/", durable: true },
          { name: "q.two", vhost: "/", durable: true },
        ]),
      },
      {
        fileName: "rabbit-a.exchanges.json",
        bytes: bytesOf([
          { name: "x.in", vhost: "/", type: "topic", durable: true },
        ]),
      },
      {
        fileName: "rabbit-a.bindings.json",
        bytes: bytesOf([
          {
            source: "x.in",
            vhost: "/",
            destination: "q.one",
            destination_type: "queue",
            routing_key: "a.b",
          },
        ]),
      },
    ];
    const result = await importTopologyBatch({ files });
    expect(result.archiveKind).toBe("batch");
    // All three files present; the first management-dump file carries the
    // aggregated parsed shape, the rest are recorded with no parsed payload.
    const managementDumps = result.files.filter((f) => f.kind === "management-dump");
    expect(managementDumps).toHaveLength(3);
    const withParse = managementDumps.filter((f) => f.parsed);
    expect(withParse).toHaveLength(1);
    const parsed = withParse[0]!.parsed!;
    expect(parsed.exchanges.map((e) => e.name)).toContain("x.in");
    expect(parsed.queues.map((q) => q.name).sort()).toEqual(["q.one", "q.two"]);
    expect(parsed.bindings).toHaveLength(1);
    // Path stays as the plain filename so heuristics like
    // `deriveHostFromPath` continue to work; batch-index disambiguation
    // lives on the per-diagnostic `sourceFileId` instead.
    for (const f of result.files) {
      expect(f.path).not.toMatch(/^batch\[/);
    }
  });

  it("honours caller-supplied `selectionIndex` on files and skipped inputs so interleaved duplicates keep picker-order attribution", async () => {
    // Selection order (picker): index 0 & 2 are readable but malformed
    // queues.json, index 1 is a skipped queues.zip. Even though the batch
    // importer sees `files = [file@0, file@2]` and `skipped = [skip@1]` (the
    // two arrays are split by the UI), the sourceFileIds MUST match the
    // original picker positions.
    const result = await importTopologyBatch({
      files: [
        {
          fileName: "queues.json",
          bytes: new TextEncoder().encode("{not-json-first"),
          selectionIndex: 0,
        },
        {
          fileName: "queues.json",
          bytes: new TextEncoder().encode("{not-json-third"),
          selectionIndex: 2,
        },
      ],
      skipped: [
        {
          fileName: "queues.zip",
          sizeBytes: 4,
          reason: "preflight-non-json-in-batch",
          selectionIndex: 1,
        },
      ],
    });
    const sourceIds = new Set(
      result.diagnostics.map((d) => d.sourceFileId).filter((id): id is string => Boolean(id)),
    );
    // The two malformed queues.json diagnostics must land on batch[0] and
    // batch[2] — NOT batch[0] and batch[1] (which would be the naive
    // "position in the files array" behaviour that pre-dates this fix).
    expect(sourceIds.has("batch[0]:queues.json")).toBe(true);
    expect(sourceIds.has("batch[2]:queues.json")).toBe(true);
    expect(sourceIds.has("batch[1]:queues.zip")).toBe(true);
    // And the ZIP slot must never collide with either queues.json entry.
    expect(sourceIds.has("batch[1]:queues.json")).toBe(false);
    expect(sourceIds.has("batch[2]:queues.zip")).toBe(false);
  });

  it("disambiguates duplicate filenames via a batch-index prefix on the diagnostic sourceFileId (not the display path)", async () => {
    // Two files with the same displayed name but malformed bytes each produce
    // a load-error diagnostic; the two diagnostics must carry distinct
    // sourceFileIds so per-file attribution is reliable.
    const files: BatchFileInput[] = [
      { fileName: "queues.json", bytes: new TextEncoder().encode("{not-json-1") },
      { fileName: "queues.json", bytes: new TextEncoder().encode("{not-json-2") },
    ];
    const result = await importTopologyBatch({ files });
    const parseDiags = result.diagnostics.filter((d) => d.sourceFileId?.endsWith(":queues.json"));
    const uniqueSourceIds = new Set(parseDiags.map((d) => d.sourceFileId));
    expect(uniqueSourceIds.size).toBe(2);
    expect([...uniqueSourceIds].sort()).toEqual([
      "batch[0]:queues.json",
      "batch[1]:queues.json",
    ]);
    // Display path is still the plain filename (duplicates are allowed there
    // because the UI shows them as separate rows anyway).
    const loadErrors = result.files.filter((f) => f.kind === "load-error");
    expect(loadErrors.every((f) => f.path === "queues.json")).toBe(true);
  });

  it("mixed valid + malformed batch produces load-error entries for the malformed files without failing the batch", async () => {
    const files: BatchFileInput[] = [
      { fileName: "rabbit-a.definitions.json", bytes: new Uint8Array(definitionsBytes) },
      { fileName: "broken.json", bytes: new TextEncoder().encode("{not-json") },
    ];
    const result = await importTopologyBatch({ files });
    expect(result.files.some((f) => f.kind === "definitions")).toBe(true);
    expect(result.files.some((f) => f.kind === "load-error")).toBe(true);
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("non-JSON files are recorded as `non-json` and skipped rather than aborting the batch", async () => {
    const files: BatchFileInput[] = [
      { fileName: "readme.txt", bytes: new TextEncoder().encode("hello") },
      { fileName: "rabbit-a.definitions.json", bytes: new Uint8Array(definitionsBytes) },
    ];
    const result = await importTopologyBatch({ files });
    expect(result.files.some((f) => f.kind === "non-json")).toBe(true);
    expect(result.files.some((f) => f.kind === "definitions")).toBe(true);
  });
});

describe("importTopologyBatch — limits", () => {
  it("rejects when the batch entry count exceeds maxEntryCount but still records every source filename", async () => {
    const files: BatchFileInput[] = Array.from({ length: 3 }, (_, i) => ({
      fileName: `f${i}.json`,
      bytes: new TextEncoder().encode("{}"),
    }));
    const result = await importTopologyBatch({
      files,
      limits: { maxEntryCount: 2 },
    });
    // Every filename still surfaces as a load-error so the picker's
    // selection list remains visible in the summary.
    expect(result.files).toHaveLength(3);
    expect(result.files.every((f) => f.kind === "load-error")).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "import.too-many-entries")).toBe(true);
  });

  it("skips files exceeding the per-entry byte cap and continues with the rest, recording the oversized file as load-error", async () => {
    const big = new Uint8Array(200);
    big.fill(0x7b); // "{"
    const small = new TextEncoder().encode("{}");
    const result = await importTopologyBatch({
      files: [
        { fileName: "huge.json", bytes: big },
        { fileName: "small.json", bytes: small },
      ],
      limits: { maxEntryBytes: 50 },
    });
    expect(result.diagnostics.some((d) => d.code === "import.entry-too-large")).toBe(true);
    // Both filenames appear in the output; the oversized one is recorded as
    // load-error so per-file attribution is preserved.
    const huge = result.files.find((f) => f.path === "huge.json");
    const smallEntry = result.files.find((f) => f.path === "small.json");
    expect(huge?.kind).toBe("load-error");
    expect(smallEntry).toBeTruthy();
  });

  it("caller-preflighted `skipped` inputs surface in ImportResult.files with load-error kind and preflight diagnostics", async () => {
    const result = await importTopologyBatch({
      files: [{ fileName: "small.json", bytes: new TextEncoder().encode("{}") }],
      skipped: [
        {
          fileName: "too-big.json",
          sizeBytes: 1_000_000,
          reason: "preflight-per-entry-too-large",
          detail: "1 000 000 > cap",
        },
        {
          fileName: "unread.json",
          sizeBytes: 500,
          reason: "preflight-unprocessed",
        },
      ],
    });
    // Both preflight-skipped filenames appear as load-error records.
    expect(result.files.some((f) => f.path === "too-big.json" && f.kind === "load-error")).toBe(true);
    expect(result.files.some((f) => f.path === "unread.json" && f.kind === "load-error")).toBe(true);
    // Diagnostics carry the preflight codes.
    expect(
      result.diagnostics.some((d) => d.code === "import.preflight-entry-too-large"),
    ).toBe(true);
    expect(
      result.diagnostics.some((d) => d.code === "import.preflight-unprocessed"),
    ).toBe(true);
    // The parsed small.json still made it through.
    expect(result.files.some((f) => f.path === "small.json" && f.kind !== "load-error")).toBe(true);
  });

  it("stops iterating and reports total-size-exceeded when cumulative bytes cross the cap, recording the unprocessed files as load-error", async () => {
    const a = new TextEncoder().encode("{}");
    const b = new TextEncoder().encode("[]");
    const c = new TextEncoder().encode("[]");
    const result = await importTopologyBatch({
      files: [
        { fileName: "a.json", bytes: a },
        { fileName: "b.json", bytes: b },
        { fileName: "c.json", bytes: c },
      ],
      limits: { maxTotalDecompressedBytes: a.byteLength + b.byteLength },
    });
    expect(result.diagnostics.some((d) => d.code === "import.total-size-exceeded")).toBe(true);
    // The last file's filename must still appear in the result (as a
    // load-error) so per-file attribution is preserved.
    const cRecord = result.files.find((f) => f.path === "c.json");
    expect(cRecord?.kind).toBe("load-error");
  });
});
