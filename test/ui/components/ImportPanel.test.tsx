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
