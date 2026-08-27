import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ImportPanel } from "../../../src/ui/components/ImportPanel";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", "..", "fixtures", "minimal-definitions.json");
const definitionsBytes = readFileSync(fixturePath);

function makeFile(name: string, bytes: Uint8Array | string): File {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const file = new File([data], name, { type: "application/octet-stream" });
  // jsdom's File doesn't implement Blob.arrayBuffer — the ImportPanel calls
  // `await file.arrayBuffer()` internally, so we polyfill it per-file so the
  // test doesn't have to touch global prototypes.
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", {
      value: async (): Promise<ArrayBuffer> => {
        const view = new Uint8Array(data);
        const copy = new ArrayBuffer(view.byteLength);
        new Uint8Array(copy).set(view);
        return copy;
      },
    });
  }
  return file;
}

describe("ImportPanel — initial render", () => {
  it("renders the region, drop zone, and file picker in the idle state", () => {
    render(<ImportPanel />);
    expect(screen.getByRole("region", { name: /import topology/i })).toBeTruthy();
    expect(screen.getByTestId("import-drop-zone")).toBeTruthy();
    expect(screen.getByText(/Choose file/i)).toBeTruthy();
  });
});

describe("ImportPanel — file picker success flow", () => {
  it("shows the summary and calls onImported when a valid definitions file is picked", async () => {
    const onImported = vi.fn();
    const { container } = render(<ImportPanel onImported={onImported} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    expect(input).toBeTruthy();

    const file = makeFile("rabbit-a.definitions.json", new Uint8Array(definitionsBytes));
    fireEvent.change(input, { target: { files: [file] } });

    // `findByText` polls until match or times out — bumping the timeout so
    // the async import (File.arrayBuffer + safeParseJson + parsers) has time
    // to finish in jsdom.
    const heading = await screen.findByText(/Loaded JSON/i, {}, { timeout: 5000 });
    expect(heading).toBeTruthy();

    expect(onImported).toHaveBeenCalledTimes(1);
    const result = onImported.mock.calls[0]![0];
    expect(result.archiveKind).toBe("json");
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files[0].kind).toBe("definitions");

    // Summary shows some expected counts (fixture has 5 exchanges, 4 queues).
    expect(screen.getByText(/Exchanges: 5/)).toBeTruthy();
    expect(screen.getByText(/Queues: 4/)).toBeTruthy();
  });
});

describe("ImportPanel — file picker error flow", () => {
  it("surfaces a parse-error diagnostic in the summary for malformed JSON", async () => {
    const { container } = render(<ImportPanel />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    const file = makeFile("broken.json", "{not-json");
    fireEvent.change(input, { target: { files: [file] } });

    // Even a broken file returns a completed summary (with a load-error kind)
    // — no exception should surface at the UI layer.
    await screen.findByText(/Loaded JSON/i, {}, { timeout: 5000 });
    const errorsLine = screen.getByText(/Diagnostics:/i);
    expect(errorsLine.textContent).toMatch(/[1-9]\d* errors/);
  });
});

describe("ImportPanel — multi-file batch import", () => {
  it("the file input has `multiple` set so the picker can select more than one file", () => {
    const { container } = render(<ImportPanel />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    expect(input).toBeTruthy();
    expect(input.multiple).toBe(true);
  });

  it("selecting two related split-dump files produces one combined batch import that contributes entities from BOTH files", async () => {
    const onImported = vi.fn();
    const { container } = render(<ImportPanel onImported={onImported} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;

    const queuesFile = makeFile(
      "rabbit-a.queues.json",
      JSON.stringify([
        { name: "q.batch-one", vhost: "/", durable: true },
        { name: "q.batch-two", vhost: "/", durable: true },
      ]),
    );
    const exchangesFile = makeFile(
      "rabbit-a.exchanges.json",
      JSON.stringify([
        { name: "x.batch", vhost: "/", type: "topic", durable: true },
      ]),
    );

    fireEvent.change(input, { target: { files: [queuesFile, exchangesFile] } });

    // Loading indicator confirms batch mode is engaged.
    await screen.findByText(/Loading 2 files/i, {}, { timeout: 5000 });

    // Completion message uses the batch label.
    await screen.findByText(/Loaded batch of 2 files/i, {}, { timeout: 5000 });

    expect(onImported).toHaveBeenCalledTimes(1);
    const result = onImported.mock.calls[0]![0];
    expect(result.archiveKind).toBe("batch");
    // Both files contributed entities to the combined ImportResult.
    const allExchangeNames = result.files
      .filter((f: { parsed?: { exchanges: Array<{ name: string }> } }) => f.parsed)
      .flatMap((f: { parsed?: { exchanges: Array<{ name: string }> } }) => f.parsed!.exchanges.map((e) => e.name));
    const allQueueNames = result.files
      .filter((f: { parsed?: { queues: Array<{ name: string }> } }) => f.parsed)
      .flatMap((f: { parsed?: { queues: Array<{ name: string }> } }) => f.parsed!.queues.map((q) => q.name));
    expect(allExchangeNames).toContain("x.batch");
    expect(allQueueNames).toEqual(expect.arrayContaining(["q.batch-one", "q.batch-two"]));
  });

  it("drag-dropping two JSON files uses the same batch pipeline", async () => {
    const onImported = vi.fn();
    render(<ImportPanel onImported={onImported} />);
    const dropZone = screen.getByTestId("import-drop-zone");

    const queuesFile = makeFile(
      "rabbit-b.queues.json",
      JSON.stringify([{ name: "q.dropped", vhost: "/", durable: true }]),
    );
    const bindingsFile = makeFile(
      "rabbit-b.bindings.json",
      JSON.stringify([]),
    );

    fireEvent.drop(dropZone, {
      dataTransfer: { files: [queuesFile, bindingsFile] },
    });

    await screen.findByText(/Loaded batch of 2 files/i, {}, { timeout: 5000 });
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported.mock.calls[0]![0].archiveKind).toBe("batch");
  });

  it("preflights File.size and reads files sequentially — the oversized file is never opened but still appears in the result", async () => {
    // Craft one file whose reported `size` exceeds the default per-entry cap
    // (25 MB) while its actual byte payload is tiny. If the UI preflight
    // works, `file.arrayBuffer()` is NEVER called on this file — asserted
    // via a spy that throws — and the file is still surfaced in the
    // ImportResult with `kind: "load-error"` (via the `skipped` payload).
    const onImported = vi.fn();
    const { container } = render(<ImportPanel onImported={onImported} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;

    const smallJson = makeFile(
      "rabbit-a.queues.json",
      JSON.stringify([{ name: "q.small", vhost: "/", durable: true }]),
    );

    // Build the oversized file WITHOUT the polyfill helper so its
    // `arrayBuffer` can be redefined as a throwing spy that fails the test
    // if the preflight-skipped file ever gets read.
    const massiveBytes = new TextEncoder().encode("{}");
    const massive = new File([massiveBytes], "massive.json", {
      type: "application/octet-stream",
    });
    Object.defineProperty(massive, "size", {
      configurable: true,
      value: 100 * 1024 * 1024, // 100 MB — well past the 25 MB per-entry cap
    });
    const massiveArrayBufferSpy = vi.fn(async (): Promise<ArrayBuffer> => {
      throw new Error("preflight-skipped file must not be read");
    });
    Object.defineProperty(massive, "arrayBuffer", {
      configurable: true,
      value: massiveArrayBufferSpy,
    });

    fireEvent.change(input, { target: { files: [smallJson, massive] } });
    await screen.findByText(/Loaded batch of 2 files/i, {}, { timeout: 5000 });

    // The oversized file must never have been read.
    expect(massiveArrayBufferSpy).not.toHaveBeenCalled();
    expect(onImported).toHaveBeenCalledTimes(1);
    const result = onImported.mock.calls[0]![0];
    // Both filenames appear in the result — the oversized one as load-error.
    const massiveEntry = result.files.find((f: { path: string }) => f.path === "massive.json");
    expect(massiveEntry?.kind).toBe("load-error");
    // A preflight diagnostic explains why the oversized file was not loaded.
    expect(
      result.diagnostics.some(
        (d: { code: string }) => d.code === "import.preflight-entry-too-large",
      ),
    ).toBe(true);
    // The small file still parsed normally.
    expect(
      result.files.some(
        (f: { path: string; kind: string }) =>
          f.path === "rabbit-a.queues.json" && f.kind === "management-dump",
      ),
    ).toBe(true);
  });

  it("regression: entry-count preflight rejects an over-cap selection without reading any bytes", async () => {
    // The default entry-count cap is 5 000. Build 3 files each carrying a
    // throwing `arrayBuffer` spy, then override `Object.defineProperty` on
    // `input.files` to appear as if 6 000 files were selected. The cheapest
    // way to prove no reads occur is: any read call throws, and the test
    // observes that no throw surfaces because the preflight bailed out first.
    const onImported = vi.fn();
    const { container } = render(<ImportPanel onImported={onImported} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;

    const buildTripwireFile = (name: string): File => {
      const f = new File([new TextEncoder().encode("{}")], name, {
        type: "application/octet-stream",
      });
      Object.defineProperty(f, "arrayBuffer", {
        configurable: true,
        value: vi.fn(async (): Promise<ArrayBuffer> => {
          throw new Error(`must not read ${name} — preflight should have stopped this`);
        }),
      });
      return f;
    };

    // Two files is enough to exercise multi-file mode; we override the count
    // cap via a spied preflight by using a synthetic FileList with .length
    // exceeding the cap. Easiest reproducible path: shrink the cap by using
    // a tiny selection but overriding the limit-checking logic — instead,
    // use two files and assert the tripwire never fires when we simulate an
    // over-cap batch via a stub selection > 5000.
    const many: File[] = Array.from({ length: 5001 }, (_, i) =>
      buildTripwireFile(`f${i}.json`),
    );

    fireEvent.change(input, { target: { files: many } });

    // The batch must complete without any of the tripwire spies firing —
    // every file becomes a preflight-too-many-files load-error record.
    await screen.findByText(/Loaded batch of 5001 files/i, {}, { timeout: 8000 });
    expect(onImported).toHaveBeenCalledTimes(1);
    const result = onImported.mock.calls[0]![0];
    // Every file appears as load-error.
    expect(result.files.every((f: { kind: string }) => f.kind === "load-error")).toBe(true);
    // Diagnostic explains why.
    expect(
      result.diagnostics.some(
        (d: { code: string }) => d.code === "import.preflight-too-many-files",
      ),
    ).toBe(true);
    // None of the tripwire arrayBuffer spies were called.
    for (const f of many) {
      const spy = (f as unknown as { arrayBuffer: ReturnType<typeof vi.fn> }).arrayBuffer;
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("regression: a per-file read failure does NOT abort the batch — other valid files still contribute", async () => {
    const onImported = vi.fn();
    const { container } = render(<ImportPanel onImported={onImported} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;

    const good = makeFile(
      "rabbit-a.queues.json",
      JSON.stringify([{ name: "q.good", vhost: "/", durable: true }]),
    );

    // A file whose arrayBuffer throws mid-read — the batch must still
    // complete with the good file's entities intact.
    const brokenBytes = new TextEncoder().encode("{}");
    const broken = new File([brokenBytes], "broken-read.json", {
      type: "application/octet-stream",
    });
    Object.defineProperty(broken, "arrayBuffer", {
      configurable: true,
      value: vi.fn(async (): Promise<ArrayBuffer> => {
        throw new Error("simulated read failure");
      }),
    });

    fireEvent.change(input, { target: { files: [good, broken] } });
    await screen.findByText(/Loaded batch of 2 files/i, {}, { timeout: 5000 });

    expect(onImported).toHaveBeenCalledTimes(1);
    const result = onImported.mock.calls[0]![0];
    // The broken file is a load-error entry with an `import.read-failed`
    // diagnostic; the good file still contributed its queue.
    expect(
      result.files.some(
        (f: { path: string; kind: string }) =>
          f.path === "broken-read.json" && f.kind === "load-error",
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some((d: { code: string }) => d.code === "import.read-failed"),
    ).toBe(true);
    const allQueueNames = result.files
      .filter((f: { parsed?: { queues: Array<{ name: string }> } }) => f.parsed)
      .flatMap((f: { parsed?: { queues: Array<{ name: string }> } }) =>
        f.parsed!.queues.map((q) => q.name),
      );
    expect(allQueueNames).toContain("q.good");
  });

  it("regression: interleaved skipped/readable duplicate filenames each get a diagnostic keyed to their ORIGINAL picker index", async () => {
    // Selection order: [0] queues.json (readable, malformed), [1] queues.json
    // (skipped by preflight — archive), [2] queues.json (readable, malformed).
    // Even though readable/skipped are split into separate arrays inside the
    // UI, every diagnostic must carry a sourceFileId that matches the
    // original picker position — batch[0], batch[1], batch[2] respectively.
    const onImported = vi.fn();
    const { container } = render(<ImportPanel onImported={onImported} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;

    // Two malformed JSONs at index 0 and 2 with identical filenames — the
    // duplicate names are exactly the case the reviewer flagged.
    const firstMalformed = makeFile("queues.json", "{not-json-first");
    const middleZip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "queues.json", {
      type: "application/zip",
    });
    // Rename to a .zip extension so the middle file is skipped as non-JSON.
    Object.defineProperty(middleZip, "name", { configurable: true, value: "queues.zip" });
    const thirdMalformed = makeFile("queues.json", "{not-json-third");

    fireEvent.change(input, {
      target: { files: [firstMalformed, middleZip, thirdMalformed] },
    });
    await screen.findByText(/Loaded batch of 3 files/i, {}, { timeout: 5000 });

    const result = onImported.mock.calls[0]![0];
    // Diagnostic sourceFileIds must be indexed by the ORIGINAL picker
    // position, not by the array position after the readable/skipped split.
    const idsByName = new Map<string, Set<string>>();
    for (const d of result.diagnostics as Array<{ code: string; sourceFileId?: string }>) {
      if (!d.sourceFileId) continue;
      const name = d.sourceFileId.split(":").slice(1).join(":");
      const existing = idsByName.get(name) ?? new Set<string>();
      existing.add(d.sourceFileId);
      idsByName.set(name, existing);
    }
    // The middle file (queues.zip at index 1) must carry `batch[1]:queues.zip`.
    expect(idsByName.get("queues.zip")).toEqual(new Set(["batch[1]:queues.zip"]));
    // The two malformed queues.json files at index 0 and 2 must carry
    // exactly the batch[0] and batch[2] disambiguators — never batch[1]
    // (which is the zip's slot) and never collapsed onto the same id.
    const queuesIds = idsByName.get("queues.json");
    expect(queuesIds).toBeDefined();
    expect([...queuesIds!].sort()).toEqual([
      "batch[0]:queues.json",
      "batch[2]:queues.json",
    ]);
    // And explicitly: batch[1]:queues.json must NOT appear (that slot is
    // owned by queues.zip, not by either malformed queues.json).
    expect(queuesIds!.has("batch[1]:queues.json")).toBe(false);
  });

  it("regression: drag-dropping interleaved duplicate filenames preserves picker-order attribution end-to-end", async () => {
    const onImported = vi.fn();
    render(<ImportPanel onImported={onImported} />);
    const dropZone = screen.getByTestId("import-drop-zone");

    const a = makeFile("dump.json", "{not-json-a");
    const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "dump.zip", {
      type: "application/zip",
    });
    const c = makeFile("dump.json", "{not-json-c");

    fireEvent.drop(dropZone, {
      dataTransfer: { files: [a, zip, c] },
    });
    await screen.findByText(/Loaded batch of 3 files/i, {}, { timeout: 5000 });

    const result = onImported.mock.calls[0]![0];
    const sourceIds = new Set(
      (result.diagnostics as Array<{ sourceFileId?: string }>).map((d) => d.sourceFileId ?? ""),
    );
    expect(sourceIds.has("batch[0]:dump.json")).toBe(true);
    expect(sourceIds.has("batch[1]:dump.zip")).toBe(true);
    expect(sourceIds.has("batch[2]:dump.json")).toBe(true);
  });

  it("regression: an archive (.zip) selected alongside a JSON in multi-file mode is clearly rejected via preflight, not silently treated as non-json", async () => {
    const onImported = vi.fn();
    const { container } = render(<ImportPanel onImported={onImported} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;

    const good = makeFile(
      "rabbit-a.queues.json",
      JSON.stringify([{ name: "q.only", vhost: "/", durable: true }]),
    );
    // Archive that would decompress in single-file mode but has no meaning
    // in a multi-file batch.
    const archive = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "topology.zip", {
      type: "application/zip",
    });
    Object.defineProperty(archive, "arrayBuffer", {
      configurable: true,
      value: vi.fn(async (): Promise<ArrayBuffer> => {
        throw new Error("archives must not be read in multi-file mode");
      }),
    });

    fireEvent.change(input, { target: { files: [good, archive] } });
    await screen.findByText(/Loaded batch of 2 files/i, {}, { timeout: 5000 });
    expect(onImported).toHaveBeenCalledTimes(1);
    const result = onImported.mock.calls[0]![0];
    expect(
      result.files.some(
        (f: { path: string; kind: string }) =>
          f.path === "topology.zip" && f.kind === "load-error",
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some(
        (d: { code: string }) => d.code === "import.preflight-non-json-in-batch",
      ),
    ).toBe(true);
  });

  it("mixed valid + malformed batch still completes with per-file diagnostics", async () => {
    const onImported = vi.fn();
    const { container } = render(<ImportPanel onImported={onImported} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;

    const valid = makeFile(
      "rabbit-a.queues.json",
      JSON.stringify([{ name: "q.valid", vhost: "/", durable: true }]),
    );
    const broken = makeFile("broken.json", "{not-json");

    fireEvent.change(input, { target: { files: [valid, broken] } });
    await screen.findByText(/Loaded batch of 2 files/i, {}, { timeout: 5000 });
    expect(onImported).toHaveBeenCalledTimes(1);
    const result = onImported.mock.calls[0]![0];
    expect(result.files.some((f: { kind: string }) => f.kind === "load-error")).toBe(true);
  });
});

describe("ImportPanel — drag-and-drop", () => {
  it("accepts a file dropped on the drop zone and runs the same import path", async () => {
    const onImported = vi.fn();
    render(<ImportPanel onImported={onImported} />);
    const dropZone = screen.getByTestId("import-drop-zone");

    const file = makeFile("rabbit-a.definitions.json", new Uint8Array(definitionsBytes));
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [file] },
    });

    await screen.findByText(/Loaded JSON/i, {}, { timeout: 5000 });
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported.mock.calls[0]![0].archiveKind).toBe("json");
  });

  it("toggles a drag-active style during dragover and clears it on dragleave", () => {
    render(<ImportPanel />);
    const dropZone = screen.getByTestId("import-drop-zone") as HTMLElement;
    const initialBg = dropZone.style.background;
    fireEvent.dragOver(dropZone, { preventDefault: () => {} });
    expect(dropZone.style.background).not.toBe(initialBg);
    fireEvent.dragLeave(dropZone);
    expect(dropZone.style.background).toBe(initialBg);
  });
});
