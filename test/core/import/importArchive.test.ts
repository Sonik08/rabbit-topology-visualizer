import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { importTopologyArchive } from "../../../src/core/import/importArchive";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", "..", "fixtures", "minimal-definitions.json");
const rarFixturePath = resolve(here, "..", "..", "fixtures", "rar", "FolderTest.rar");
const definitionsBytes = readFileSync(fixturePath);

describe("importTopologyArchive — JSON single file", () => {
  it("classifies + parses a definitions JSON directly", async () => {
    const r = await importTopologyArchive({
      fileName: "rabbit-a.definitions.json",
      bytes: new Uint8Array(definitionsBytes),
    });
    expect(r.archiveKind).toBe("json");
    expect(r.files).toHaveLength(1);
    const f = r.files[0]!;
    expect(f.kind).toBe("definitions");
    expect(f.parsed?.exchanges.length).toBeGreaterThan(0);
    expect(f.parsed?.queues.length).toBeGreaterThan(0);
    expect(f.runtime?.shovels.length).toBeGreaterThanOrEqual(1);
    expect(f.runtime?.federations.length).toBeGreaterThanOrEqual(1);
  });

  it("emits parse.malformed-json when the bytes are not valid JSON", async () => {
    const r = await importTopologyArchive({
      fileName: "broken.json",
      bytes: new TextEncoder().encode("{not-json"),
    });
    expect(r.files[0]?.kind).toBe("load-error");
    expect(r.diagnostics.some((d) => d.code === "parse.malformed-json")).toBe(true);
  });
});

describe("importTopologyArchive — zip archive", () => {
  it("iterates zip entries, parses each JSON, ignores non-JSON files", async () => {
    const zip = new JSZip();
    zip.file("rabbit-a/definitions.json", definitionsBytes);
    zip.file("README.txt", "just a note");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await importTopologyArchive({
      fileName: "topology.zip",
      bytes,
    });
    expect(r.archiveKind).toBe("zip");
    const kinds = r.files.map((f) => f.kind).sort();
    expect(kinds).toEqual(["definitions", "non-json"]);
    const defFile = r.files.find((f) => f.kind === "definitions")!;
    expect(defFile.parsed?.exchanges.length).toBeGreaterThan(0);
  });

  it("reports zip.open-failed on garbage bytes with a zip extension", async () => {
    const r = await importTopologyArchive({
      fileName: "not-really.zip",
      bytes: new TextEncoder().encode("this is not a zip"),
    });
    expect(r.diagnostics.some((d) => d.code === "zip.open-failed")).toBe(true);
  });
});

describe("importTopologyArchive — rar archive", () => {
  it("opens a real RAR fixture and enumerates its entries", async () => {
    const rarBytes = readFileSync(rarFixturePath);
    const r = await importTopologyArchive({
      fileName: "FolderTest.rar",
      bytes: new Uint8Array(rarBytes),
    });
    expect(r.archiveKind).toBe("rar");
    expect(r.files.length).toBeGreaterThan(0);
    // The fixture contains no JSON, so every entry falls into "non-json".
    for (const f of r.files) expect(f.kind).toBe("non-json");
  });

  it("passes the importer per-entry limit into RAR preflight", async () => {
    const rarBytes = readFileSync(rarFixturePath);
    const r = await importTopologyArchive({
      fileName: "FolderTest.rar",
      bytes: new Uint8Array(rarBytes),
      limits: { maxEntryBytes: 1024 },
    });

    expect(r.files).toEqual([]);
    expect(r.diagnostics.some((d) => d.code === "rar.entry-too-large")).toBe(true);
    expect(r.diagnostics.some((d) => d.code === "import.entry-too-large")).toBe(false);
  });

  it("passes the importer cumulative-size limit into RAR preflight", async () => {
    const rarBytes = readFileSync(rarFixturePath);
    const r = await importTopologyArchive({
      fileName: "FolderTest.rar",
      bytes: new Uint8Array(rarBytes),
      limits: {
        maxEntryBytes: 2_000_000,
        maxTotalDecompressedBytes: 1024,
      },
    });

    expect(r.files).toEqual([]);
    expect(
      r.diagnostics.some((d) => d.code === "rar.total-size-limit-exceeded"),
    ).toBe(true);
    expect(
      r.diagnostics.some((d) => d.code === "import.total-size-exceeded"),
    ).toBe(false);
  });
});

describe("importTopologyArchive — split management-dump grouping", () => {
  it("groups queues.json/exchanges.json/bindings.json for the same host and resolves bindings across files", async () => {
    const zip = new JSZip();
    // All three files live under hosts/rabbit-a/vhosts/orders/, so the
    // classifier's path hint pins them to the same host key.
    zip.file(
      "hosts/rabbit-a/vhosts/orders/exchanges.json",
      JSON.stringify([{ name: "orders.in", vhost: "/", type: "topic" }]),
    );
    zip.file(
      "hosts/rabbit-a/vhosts/orders/queues.json",
      JSON.stringify([{ name: "orders.incoming", vhost: "/" }]),
    );
    zip.file(
      "hosts/rabbit-a/vhosts/orders/bindings.json",
      JSON.stringify([
        {
          source: "orders.in",
          vhost: "/",
          destination: "orders.incoming",
          destination_type: "queue",
          routing_key: "orders.#",
        },
      ]),
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await importTopologyArchive({
      fileName: "split-dump.zip",
      bytes,
    });
    expect(r.archiveKind).toBe("zip");

    // Aggregated parse lives on the FIRST management-dump entry for the host.
    const dumpFiles = r.files.filter((f) => f.kind === "management-dump");
    expect(dumpFiles).toHaveLength(3);
    const parsedFiles = dumpFiles.filter((f) => f.parsed);
    expect(parsedFiles).toHaveLength(1);
    const parsed = parsedFiles[0]!.parsed!;

    // Cross-file resolution: the binding must resolve to the exchange + queue
    // that live in a different file. If we still parsed each file separately,
    // the binding's source and destination would be unresolved.
    expect(parsed.exchanges).toHaveLength(1);
    expect(parsed.queues).toHaveLength(1);
    expect(parsed.bindings).toHaveLength(1);
    expect(parsed.bindings[0]!.routingKey).toBe("orders.#");
    // No unresolved-source/destination diagnostics should fire.
    expect(
      r.diagnostics.some(
        (d) =>
          d.code === "definitions.binding-source-unresolved" ||
          d.code === "definitions.binding-destination-unresolved",
      ),
    ).toBe(false);
  });

  it("groups root-level split dump files under one unknown host instead of host names from filenames", async () => {
    const zip = new JSZip();
    zip.file(
      "exchanges.json",
      JSON.stringify([{ name: "orders.in", vhost: "/", type: "topic" }]),
    );
    zip.file(
      "queues.json",
      JSON.stringify([{ name: "orders.incoming", vhost: "/" }]),
    );
    zip.file(
      "bindings.json",
      JSON.stringify([
        {
          source: "orders.in",
          vhost: "/",
          destination: "orders.incoming",
          destination_type: "queue",
          routing_key: "orders.#",
        },
      ]),
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await importTopologyArchive({
      fileName: "root-level-split-dump.zip",
      bytes,
    });

    const dumpFiles = r.files.filter((f) => f.kind === "management-dump");
    expect(dumpFiles).toHaveLength(3);
    const parsedFiles = dumpFiles.filter((f) => f.parsed);
    expect(parsedFiles).toHaveLength(1);
    const parsed = parsedFiles[0]!.parsed!;
    expect(parsed.host.name).toBe("unknown-host");
    expect(parsed.exchanges).toHaveLength(1);
    expect(parsed.queues).toHaveLength(1);
    expect(parsed.bindings).toHaveLength(1);
    expect(
      r.diagnostics.some(
        (d) =>
          d.code === "definitions.binding-source-unresolved" ||
          d.code === "definitions.binding-destination-unresolved",
      ),
    ).toBe(false);
  });

  it("does not infer a host named definitions for a root-level definitions.json", async () => {
    const r = await importTopologyArchive({
      fileName: "definitions.json",
      bytes: new Uint8Array(definitionsBytes),
    });
    expect(r.files[0]?.kind).toBe("definitions");
    expect(r.files[0]?.parsed?.host.name).toBe("unknown-host");
  });

  it("groups parameters.json alongside vhost/queue files and resolves shovel runtime params", async () => {
    const zip = new JSZip();
    zip.file(
      "hosts/rabbit-a/vhosts.json",
      JSON.stringify([{ name: "orders" }]),
    );
    zip.file(
      "hosts/rabbit-a/parameters.json",
      JSON.stringify([
        {
          vhost: "orders",
          component: "shovel",
          name: "orders-shovel",
          value: {
            "src-uri": "amqp://REDACTED@remote.example.internal/orders",
            "src-queue": "orders.out",
            "dest-uri": "amqp://REDACTED@localhost/orders",
            "dest-queue": "orders.in",
          },
        },
      ]),
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await importTopologyArchive({
      fileName: "with-params.zip",
      bytes,
    });

    // Runtime params were resolved because parameters.json + vhosts.json were
    // parsed together — the shovel's `vhost: "orders"` matches the loaded
    // "orders" vhost, so we get exactly one shovel and no
    // "runtime-params.vhost-unresolved" diagnostic.
    const parsedFiles = r.files.filter((f) => f.parsed);
    expect(parsedFiles).toHaveLength(1);
    expect(parsedFiles[0]!.runtime?.shovels).toHaveLength(1);
    expect(parsedFiles[0]!.runtime?.shovels[0]!.name).toBe("orders-shovel");
    expect(
      r.diagnostics.some((d) => d.code === "runtime-params.vhost-unresolved"),
    ).toBe(false);
  });

  it("groups root-level split files (no hosts/ prefix) as one host bucket", async () => {
    // Layout that matches the RabbitMQ management-plugin export defaults:
    // just queues.json / exchanges.json / bindings.json at the archive root.
    // The old heuristic would derive host names "queues", "exchanges",
    // "bindings" from the filename stem and split them into three separate
    // pseudo-hosts, breaking cross-file resolution.
    const zip = new JSZip();
    zip.file(
      "exchanges.json",
      JSON.stringify([{ name: "orders.in", vhost: "/", type: "topic" }]),
    );
    zip.file(
      "queues.json",
      JSON.stringify([{ name: "orders.incoming", vhost: "/" }]),
    );
    zip.file(
      "bindings.json",
      JSON.stringify([
        {
          source: "orders.in",
          vhost: "/",
          destination: "orders.incoming",
          destination_type: "queue",
          routing_key: "orders.#",
        },
      ]),
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await importTopologyArchive({
      fileName: "root-dump.zip",
      bytes,
    });

    const dumpFiles = r.files.filter((f) => f.kind === "management-dump");
    expect(dumpFiles).toHaveLength(3);
    // Exactly ONE dump entry carries the aggregated parse — all three files
    // shared the same host bucket, not three pseudo-hosts.
    const parsedFiles = dumpFiles.filter((f) => f.parsed);
    expect(parsedFiles).toHaveLength(1);
    const parsed = parsedFiles[0]!.parsed!;
    expect(parsed.exchanges).toHaveLength(1);
    expect(parsed.queues).toHaveLength(1);
    expect(parsed.bindings).toHaveLength(1);
    expect(parsed.bindings[0]!.routingKey).toBe("orders.#");
    expect(
      r.diagnostics.some(
        (d) =>
          d.code === "definitions.binding-source-unresolved" ||
          d.code === "definitions.binding-destination-unresolved",
      ),
    ).toBe(false);
  });

  it("keeps two different hosts' split dumps separate", async () => {
    const zip = new JSZip();
    zip.file(
      "hosts/rabbit-a/exchanges.json",
      JSON.stringify([{ name: "a.x", vhost: "/", type: "topic" }]),
    );
    zip.file(
      "hosts/rabbit-b/exchanges.json",
      JSON.stringify([{ name: "b.x", vhost: "/", type: "topic" }]),
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await importTopologyArchive({
      fileName: "two-hosts.zip",
      bytes,
    });
    const parsedFiles = r.files.filter((f) => f.parsed);
    expect(parsedFiles).toHaveLength(2);
    const hostNames = parsedFiles.map((f) => f.parsed!.host.name).sort();
    expect(hostNames).toEqual(["rabbit-a", "rabbit-b"]);
    for (const f of parsedFiles) expect(f.parsed!.exchanges).toHaveLength(1);
  });
});

describe("importTopologyArchive — resource limits", () => {
  it("rejects an archive whose raw byte size exceeds maxArchiveBytes", async () => {
    // 1 KB of bytes with a 512-byte cap.
    const bytes = new Uint8Array(1024);
    const r = await importTopologyArchive({
      fileName: "big.zip",
      bytes,
      limits: { maxArchiveBytes: 512 },
    });
    expect(r.diagnostics.some((d) => d.code === "import.archive-too-large")).toBe(true);
    expect(r.files).toEqual([]);
  });

  it("stops iterating a zip when maxEntryCount is exceeded", async () => {
    const zip = new JSZip();
    zip.file("a.json", JSON.stringify({ vhosts: [] }));
    zip.file("b.json", JSON.stringify({ vhosts: [] }));
    zip.file("c.json", JSON.stringify({ vhosts: [] }));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await importTopologyArchive({
      fileName: "many.zip",
      bytes,
      limits: { maxEntryCount: 2 },
    });
    expect(r.diagnostics.some((d) => d.code === "import.too-many-entries")).toBe(true);
    // Some entries may still have been admitted before the limit tripped.
    expect(r.files.length).toBeLessThanOrEqual(2);
  });

  it("skips oversized zip entries but keeps processing subsequent valid entries", async () => {
    // Regression: an entry that trips `maxEntryBytes` must not abort the loop.
    const zip = new JSZip();
    zip.file("big.json", JSON.stringify({ filler: "x".repeat(4096) }));
    // A tiny valid definitions file that comes AFTER the oversized one.
    zip.file(
      "small.definitions.json",
      JSON.stringify({
        vhosts: [{ name: "/" }],
        exchanges: [{ name: "x.small", vhost: "/", type: "topic" }],
      }),
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await importTopologyArchive({
      fileName: "mixed.zip",
      bytes,
      limits: { maxEntryBytes: 1024 },
    });
    // The oversized entry was skipped with a warning-severity diagnostic.
    expect(
      r.diagnostics.some(
        (d) => d.code === "import.entry-too-large" && d.severity === "warning",
      ),
    ).toBe(true);
    // The smaller entry that came after DID make it through — proves
    // iteration continued past the per-entry breach.
    const parsedFiles = r.files.filter((f) => f.parsed);
    expect(parsedFiles.length).toBeGreaterThanOrEqual(1);
    const smallDefs = parsedFiles.find((f) => f.path === "small.definitions.json");
    expect(smallDefs).toBeDefined();
    expect(smallDefs!.parsed!.exchanges.map((e) => e.name)).toContain("x.small");
    // No terminal-budget diagnostic should have fired.
    expect(
      r.diagnostics.some(
        (d) =>
          d.code === "import.too-many-entries" ||
          d.code === "import.total-size-exceeded",
      ),
    ).toBe(false);
  });

  it("catches an entry whose decompressed bytes exceed maxEntryBytes even when metadata under-reports", async () => {
    // Adversarial: mock JSZip.loadAsync to return an entry whose
    // `_data.uncompressedSize` claims 10 bytes while `entry.async()`
    // actually yields 4 KB. If the importer trusted the metadata, this
    // would slip past a `maxEntryBytes: 1024` cap. The post-decompression
    // `actualBudget` check must catch it.
    const actualBytes = new Uint8Array(4096);
    // Fill with valid JSON just in case something downstream tries to parse it.
    const jsonText = JSON.stringify({ vhosts: [], filler: "x".repeat(3900) });
    actualBytes.set(new TextEncoder().encode(jsonText));
    const rigged = {
      files: {
        "bomb.json": {
          dir: false,
          name: "bomb.json",
          _data: { uncompressedSize: 10 }, // lies — actual is 4096
          async: async (_type: string): Promise<Uint8Array> => actualBytes,
        },
      },
    };
    const spy = vi
      .spyOn(JSZip, "loadAsync")
      .mockResolvedValueOnce(rigged as unknown as JSZip);
    try {
      const r = await importTopologyArchive({
        fileName: "bomb.zip",
        bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]), // magic bytes → sniffs as zip
        limits: { maxEntryBytes: 1024 },
      });
      // Actual-size check must fire — the entry-too-large diagnostic must
      // reference the actual byte count, not the fabricated metadata.
      expect(
        r.diagnostics.some(
          (d) => d.code === "import.entry-too-large" && d.severity === "warning",
        ),
      ).toBe(true);
      // The rigged entry must NOT appear in the successfully-parsed files —
      // it was rejected by the actual-byte check after decompression.
      expect(r.files.every((f) => f.kind !== "definitions")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("catches cumulative decompressed size when per-entry metadata under-reports totals", async () => {
    // Two entries each claim 10 bytes in metadata but actually decompress
    // to 4 KB apiece. A `maxTotalDecompressedBytes: 5000` cap must stop
    // iteration after the actual bytes accumulate past the cap.
    const bigBytes = new Uint8Array(4096);
    bigBytes.set(new TextEncoder().encode(JSON.stringify({ filler: "x".repeat(3900) })));
    const makeLyingEntry = (name: string) => ({
      dir: false,
      name,
      _data: { uncompressedSize: 10 },
      async: async (_t: string): Promise<Uint8Array> => bigBytes,
    });
    const rigged = {
      files: {
        "a.json": makeLyingEntry("a.json"),
        "b.json": makeLyingEntry("b.json"),
      },
    };
    const spy = vi
      .spyOn(JSZip, "loadAsync")
      .mockResolvedValueOnce(rigged as unknown as JSZip);
    try {
      const r = await importTopologyArchive({
        fileName: "cumulative-bomb.zip",
        bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]),
        limits: { maxTotalDecompressedBytes: 5000 },
      });
      expect(
        r.diagnostics.some((d) => d.code === "import.total-size-exceeded"),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("skips a zip entry whose decompressed size exceeds maxEntryBytes", async () => {
    const zip = new JSZip();
    // 4 KB of JSON in one entry, cap set at 1 KB.
    zip.file("big.json", JSON.stringify({ vhosts: [], filler: "x".repeat(4096) }));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await importTopologyArchive({
      fileName: "one-big.zip",
      bytes,
      limits: { maxEntryBytes: 1024 },
    });
    expect(r.diagnostics.some((d) => d.code === "import.entry-too-large")).toBe(true);
  });

  it("continues importing valid zip entries after an oversized entry", async () => {
    const zip = new JSZip();
    zip.file("oversized.json", JSON.stringify({ filler: "x".repeat(4096) }));
    zip.file("valid.definitions.json", JSON.stringify({ vhosts: [] }));
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const r = await importTopologyArchive({
      fileName: "oversized-then-valid.zip",
      bytes,
      limits: { maxEntryBytes: 1024 },
    });

    expect(r.diagnostics.some((d) => d.code === "import.entry-too-large")).toBe(true);
    expect(r.files.map((f) => f.path)).toEqual(["valid.definitions.json"]);
    expect(r.files[0]?.kind).toBe("definitions");
  });

  it("rejects an entry when ZIP metadata understates its actual size", async () => {
    const oversized = new TextEncoder().encode(
      JSON.stringify({ filler: "x".repeat(4096) }),
    );
    const valid = new TextEncoder().encode(JSON.stringify({ vhosts: [] }));
    const fakeZip = {
      files: {
        "forged.json": {
          name: "forged.json",
          dir: false,
          _data: { uncompressedSize: 1 },
          async: async () => oversized,
        },
        "valid.definitions.json": {
          name: "valid.definitions.json",
          dir: false,
          _data: { uncompressedSize: 1 },
          async: async () => valid,
        },
      },
    };
    vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce(fakeZip as unknown as JSZip);

    const r = await importTopologyArchive({
      fileName: "forged-metadata.zip",
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      limits: { maxEntryBytes: 1024 },
    });

    expect(r.diagnostics.some((d) => d.code === "import.entry-too-large")).toBe(true);
    expect(r.files.map((f) => f.path)).toEqual(["valid.definitions.json"]);
  });

  it("uses actual bytes for cumulative limits when ZIP metadata is understated", async () => {
    const first = new TextEncoder().encode(JSON.stringify({ filler: "a".repeat(600) }));
    const second = new TextEncoder().encode(JSON.stringify({ filler: "b".repeat(600) }));
    const fakeZip = {
      files: {
        "first.json": {
          name: "first.json",
          dir: false,
          _data: { uncompressedSize: 1 },
          async: async () => first,
        },
        "second.json": {
          name: "second.json",
          dir: false,
          _data: { uncompressedSize: 1 },
          async: async () => second,
        },
      },
    };
    vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce(fakeZip as unknown as JSZip);

    const r = await importTopologyArchive({
      fileName: "forged-total.zip",
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      limits: { maxTotalDecompressedBytes: 1000 },
    });

    expect(r.diagnostics.some((d) => d.code === "import.total-size-exceeded")).toBe(true);
    expect(r.files.map((f) => f.path)).toEqual(["first.json"]);
  });

  it("stops iterating when total decompressed size exceeds maxTotalDecompressedBytes", async () => {
    const zip = new JSZip();
    for (let i = 0; i < 5; i += 1) {
      // Each entry ~2 KB of decompressed content.
      zip.file(`e${i}.json`, JSON.stringify({ filler: "x".repeat(2000) }));
    }
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await importTopologyArchive({
      fileName: "cumulative.zip",
      bytes,
      limits: { maxTotalDecompressedBytes: 5000 },
    });
    expect(r.diagnostics.some((d) => d.code === "import.total-size-exceeded")).toBe(true);
  });

  it("rejects a single JSON file whose byte size exceeds maxEntryBytes", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ filler: "x".repeat(4096) }),
    );
    const r = await importTopologyArchive({
      fileName: "big.json",
      bytes,
      limits: { maxEntryBytes: 1024 },
    });
    expect(r.diagnostics.some((d) => d.code === "import.entry-too-large")).toBe(true);
    expect(r.files).toEqual([]);
  });
});

describe("importTopologyArchive — RAR limits enforced BEFORE extraction", () => {
  it("propagates maxEntryBytes to the RAR loader so oversized entries never decompress", async () => {
    const rarBytes = readFileSync(rarFixturePath);
    // The FolderTest.rar fixture contains entries far larger than 50 bytes;
    // this cap must trip the RAR loader's own preflight
    // (`rar.entry-too-large`), NOT the outer EntryBudget which only sees
    // already-decompressed data.
    const r = await importTopologyArchive({
      fileName: "FolderTest.rar",
      bytes: new Uint8Array(rarBytes),
      limits: { maxEntryBytes: 50 },
    });
    expect(r.archiveKind).toBe("rar");
    expect(r.diagnostics.some((d) => d.code === "rar.entry-too-large")).toBe(true);
    // Preflight rejects the archive → no file made it through decompression.
    expect(r.files.every((f) => f.kind !== "management-dump" && f.kind !== "definitions")).toBe(true);
  });

  it("propagates maxTotalDecompressedBytes so a cumulative size cap trips before extraction", async () => {
    const rarBytes = readFileSync(rarFixturePath);
    const r = await importTopologyArchive({
      fileName: "FolderTest.rar",
      bytes: new Uint8Array(rarBytes),
      // Total decompressed size of the fixture is a few KB; 100 bytes total
      // guarantees the preflight sum exceeds the cap.
      limits: { maxTotalDecompressedBytes: 100 },
    });
    expect(
      r.diagnostics.some(
        (d) =>
          d.code === "rar.total-size-limit-exceeded" ||
          d.code === "rar.entry-too-large",
      ),
    ).toBe(true);
    expect(r.files.every((f) => f.parsed === undefined)).toBe(true);
  });

  it("propagates maxEntries so header-count preflight refuses to iterate", async () => {
    const rarBytes = readFileSync(rarFixturePath);
    const r = await importTopologyArchive({
      fileName: "FolderTest.rar",
      bytes: new Uint8Array(rarBytes),
      limits: { maxEntryCount: 1 },
    });
    // FolderTest.rar has multiple entries → preflight tripped.
    expect(r.diagnostics.some((d) => d.code === "rar.entry-limit-exceeded")).toBe(true);
    expect(r.files.every((f) => f.parsed === undefined)).toBe(true);
  });
});

describe("importTopologyArchive — unknown archive kind", () => {
  it("returns an import.unknown-archive diagnostic for an unrecognised extension", async () => {
    const r = await importTopologyArchive({
      fileName: "topology.tar",
      bytes: new TextEncoder().encode("nope"),
    });
    expect(r.archiveKind).toBe("unknown");
    expect(r.diagnostics.some((d) => d.code === "import.unknown-archive")).toBe(true);
  });

  it("uses magic bytes to detect RAR when the extension is wrong", async () => {
    const rarBytes = readFileSync(rarFixturePath);
    const r = await importTopologyArchive({
      fileName: "unnamed-archive",
      bytes: new Uint8Array(rarBytes),
    });
    expect(r.archiveKind).toBe("rar");
  });
});
