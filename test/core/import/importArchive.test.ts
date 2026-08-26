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

  it("passes the importer per-entry limit into RAR preflight without dropping valid entries", async () => {
    const rarBytes = readFileSync(rarFixturePath);
    const r = await importTopologyArchive({
      fileName: "FolderTest.rar",
      bytes: new Uint8Array(rarBytes),
      limits: { maxEntryBytes: 1024 },
    });

    expect(r.files.map((f) => f.path)).toEqual(["Folder1/Folder 中文/2中文.txt"]);
    expect(
      r.diagnostics.some(
        (d) => d.code === "rar.entry-too-large" && d.severity === "warning",
      ),
    ).toBe(true);
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

  it("streams a forged-understated entry to the per-entry cap, then imports a valid entry", async () => {
    const source = new JSZip();
    source.file("bomb.json", JSON.stringify({ filler: "x".repeat(40_000) }));
    source.file("valid.definitions.json", JSON.stringify({ vhosts: [] }));
    const bytes = await source.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const loaded = await JSZip.loadAsync(bytes);
    const bomb = loaded.file("bomb.json")!;
    (bomb as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize = 10;
    const asyncSpy = vi.spyOn(bomb, "async");
    const loadSpy = vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce(loaded);
    try {
      const r = await importTopologyArchive({
        fileName: "bomb.zip",
        bytes,
        limits: { maxEntryBytes: 1024 },
      });
      expect(
        r.diagnostics.some(
          (d) => d.code === "import.entry-too-large" && d.severity === "warning",
        ),
      ).toBe(true);
      expect(r.files.map((f) => f.path)).toEqual(["valid.definitions.json"]);
      expect(asyncSpy).not.toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("counts output from repeatedly skipped forged entries toward the terminal total cap", async () => {
    const source = new JSZip();
    for (let i = 0; i < 3; i += 1) {
      source.file(`bomb-${i}.json`, JSON.stringify({ filler: String(i).repeat(40_000) }));
    }
    const bytes = await source.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const loaded = await JSZip.loadAsync(bytes);
    for (let i = 0; i < 3; i += 1) {
      const entry = loaded.file(`bomb-${i}.json`)!;
      (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize = 10;
    }
    const loadSpy = vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce(loaded);
    try {
      const r = await importTopologyArchive({
        fileName: "repeated-bombs.zip",
        bytes,
        limits: { maxEntryBytes: 1024, maxTotalDecompressedBytes: 100_000 },
      });
      expect(r.diagnostics.filter((d) => d.code === "import.entry-too-large")).toHaveLength(2);
      expect(r.diagnostics.some((d) => d.code === "import.total-size-exceeded")).toBe(true);
      expect(r.files).toEqual([]);
    } finally {
      loadSpy.mockRestore();
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

  it("resolves the pending limit decision when JSZip emits `end` synchronously after an oversized chunk", async () => {
    // Regression: `stopAtLimit()` schedules resolution via `queueMicrotask`.
    // If the JSZip helper emits `end` *before* that microtask runs, the `end`
    // handler must respect `pendingLimitDecision` — otherwise it would resolve
    // `"complete"` with a truncated payload and lose the terminal diagnostic.
    // We can't force this scheduling with the real JSZip pipeline (pako defers
    // to Promise ticks), so we replace `internalStream` on one entry with a
    // rig that emits a giant chunk followed synchronously by `end`.
    const source = new JSZip();
    source.file("bomb.json", JSON.stringify({ filler: "x".repeat(2_000) }));
    source.file("valid.definitions.json", JSON.stringify({ vhosts: [] }));
    const bytes = await source.generateAsync({ type: "uint8array", compression: "STORE" });
    const loaded = await JSZip.loadAsync(bytes);
    const bomb = loaded.file("bomb.json")!;
    // Understate the declared size so preflight admits both entries.
    (bomb as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize = 16;

    // Rig internalStream to fire `data` (oversized) then `end` synchronously
    // in the same tick that `resume()` is invoked — no microtask boundary
    // between them.
    const rig = {
      _dataCbs: [] as Array<(chunk: Uint8Array) => void>,
      _endCbs: [] as Array<() => void>,
      _errorCbs: [] as Array<(err: unknown) => void>,
      on(event: string, cb: (...args: never[]) => void): typeof rig {
        if (event === "data") rig._dataCbs.push(cb as (chunk: Uint8Array) => void);
        else if (event === "end") rig._endCbs.push(cb as () => void);
        else if (event === "error") rig._errorCbs.push(cb as (err: unknown) => void);
        return rig;
      },
      pause() { return rig; },
      resume() {
        // Emit one chunk that already crosses both caps, THEN synchronously
        // emit `end` in the same call stack. If `end` were to run its
        // "complete" branch, it would fire before the queued microtask.
        for (const cb of rig._dataCbs) cb(new Uint8Array(50_000));
        for (const cb of rig._endCbs) cb();
        return rig;
      },
    };
    (bomb as unknown as { internalStream: () => typeof rig }).internalStream = () => rig;

    const loadSpy = vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce(loaded);
    try {
      const r = await importTopologyArchive({
        fileName: "sync-end.zip",
        bytes,
        // Small enough that the 50 KB emit crosses both entry and total caps.
        limits: { maxEntryBytes: 1024, maxTotalDecompressedBytes: 200_000 },
      });

      // The pending limit decision must have won: no truncated `bomb.json`
      // payload leaked through as a complete import.
      expect(r.files.some((f) => f.path === "bomb.json")).toBe(false);
      // The per-entry limit trip is preserved as a warning; iteration continues.
      expect(
        r.diagnostics.some(
          (d) => d.code === "import.entry-too-large" && d.severity === "warning",
        ),
      ).toBe(true);
      // The later valid entry still imports — proves the sync-end resolution
      // returned "entry-exceeded" (skip + continue), not "complete" (append).
      expect(r.files.some((f) => f.path === "valid.definitions.json")).toBe(true);
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("does not add declared preflight bytes to the independently counted actual total", async () => {
    const zip = new JSZip();
    const first = JSON.stringify({ filler: "a".repeat(600) });
    const second = JSON.stringify({ filler: "b".repeat(600) });
    zip.file("first.json", first);
    zip.file("second.json", second);
    const actualTotal = new TextEncoder().encode(first).byteLength
      + new TextEncoder().encode(second).byteLength;
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const r = await importTopologyArchive({
      fileName: "independent-budgets.zip",
      bytes,
      // Above one actual/declaration total, but well below their doubled sum.
      limits: { maxTotalDecompressedBytes: actualTotal + 1 },
    });

    expect(r.diagnostics.some((d) => d.code === "import.total-size-exceeded")).toBe(false);
    expect(r.files.map((f) => f.path).sort()).toEqual(["first.json", "second.json"]);
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

describe("importTopologyArchive — RAR limits", () => {
  it("propagates maxEntryBytes so header-oversized files are excluded before extraction", async () => {
    const rarBytes = readFileSync(rarFixturePath);
    const r = await importTopologyArchive({
      fileName: "FolderTest.rar",
      bytes: new Uint8Array(rarBytes),
      limits: { maxEntryBytes: 50 },
    });
    expect(r.archiveKind).toBe("rar");
    expect(
      r.diagnostics.some(
        (d) => d.code === "rar.entry-too-large" && d.severity === "warning",
      ),
    ).toBe(true);
    expect(r.files.map((f) => f.path)).toEqual(["Folder1/Folder 中文/2中文.txt"]);
  });

  it("propagates maxTotalDecompressedBytes so a cumulative size cap trips before extraction", async () => {
    const rarBytes = readFileSync(rarFixturePath);
    const r = await importTopologyArchive({
      fileName: "FolderTest.rar",
      bytes: new Uint8Array(rarBytes),
      // The fixture includes a ~1 MiB file; 100 bytes guarantees terminal
      // declared-total preflight before node-unrar-js extraction.
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
