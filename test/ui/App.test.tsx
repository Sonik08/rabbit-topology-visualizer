import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ImportResult } from "../../src/core/import";

afterEach(() => {
  cleanup();
});

// TopologyGraphCanvas depends on ReactFlow + the worker client, which are
// heavy for a plain jsdom test that only cares about state hoisting between
// EntitySearchBox and the canvas. Replace the canvas with a lightweight
// test double that surfaces its incoming `selectedNodeId` prop so we can
// assert the wiring end-to-end without mounting ReactFlow.
vi.mock("../../src/ui/components/TopologyGraphCanvas", () => ({
  TopologyGraphCanvas: (props: {
    selectedNodeId?: string;
    onSelectionChange?: (id: string | undefined) => void;
    focusNodeId?: string;
    onFocusChange?: (id: string | undefined) => void;
  }) => (
    <section data-testid="canvas-stub">
      <span data-testid="canvas-stub-selected">{props.selectedNodeId ?? ""}</span>
      <span data-testid="canvas-stub-focused">{props.focusNodeId ?? ""}</span>
      <button
        type="button"
        data-testid="canvas-stub-clear"
        onClick={() => props.onSelectionChange?.(undefined)}
      >
        clear
      </button>
      <button
        type="button"
        data-testid="canvas-stub-clear-focus"
        onClick={() => props.onFocusChange?.(undefined)}
      >
        clear focus
      </button>
    </section>
  ),
}));

// ImportPanel is fine in jsdom, but we don't want to run the actual archive
// importer in this suite — we only want to drive `onImported` with a fake
// ImportResult and then check the resulting search/selection wiring.
vi.mock("../../src/ui/components/ImportPanel", () => ({
  ImportPanel: ({ onImported }: { onImported?: (r: ImportResult) => void }) => (
    <button
      type="button"
      data-testid="import-panel-stub"
      onClick={() => onImported?.(fakeImportResult())}
    >
      trigger import
    </button>
  ),
}));

import { App } from "../../src/App";

function fakeImportResult(): ImportResult {
  const parsed = {
    host: { id: "host:rabbit-a", name: "rabbit-a", sourceFiles: [] },
    vhosts: [{ id: "vhost:rabbit-a:/", hostId: "host:rabbit-a", name: "/" }],
    exchanges: [
      {
        id: "exchange:rabbit-a:/:orders.in",
        hostId: "host:rabbit-a",
        vhostId: "vhost:rabbit-a:/",
        name: "orders.in",
        type: "topic",
      },
    ],
    queues: [
      {
        id: "queue:rabbit-a:/:orders.q",
        hostId: "host:rabbit-a",
        vhostId: "vhost:rabbit-a:/",
        name: "orders.q",
      },
    ],
    bindings: [],
    policies: [],
    rawParameters: [],
    diagnostics: [],
  };
  return {
    archiveKind: "json",
    archivePath: "rabbit-a.definitions.json",
    files: [
      {
        path: "rabbit-a.definitions.json",
        sizeBytes: 1024,
        kind: "definitions",
        parsed: parsed as never,
      },
    ],
    diagnostics: [],
  };
}

describe("App — EntitySearchBox → TopologyGraphCanvas selection wiring", () => {
  it("initially renders with no selection propagated to the canvas", () => {
    render(<App />);
    // Canvas + search are only shown once an import completes.
    fireEvent.click(screen.getByTestId("import-panel-stub"));
    expect(screen.getByTestId("canvas-stub-selected").textContent).toBe("");
  });

  it("clicking an exact search result sets the canvas selectedNodeId to that entity's id", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("import-panel-stub"));
    // Type an exact match to elevate the entity into the exact block.
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "orders.q" },
    });
    // Click the queue result row — its testid is `entity-search-result-<id>`.
    const row = screen.getByTestId(
      "entity-search-result-queue:rabbit-a:/:orders.q",
    );
    fireEvent.click(row);
    expect(screen.getByTestId("canvas-stub-selected").textContent).toBe(
      "queue:rabbit-a:/:orders.q",
    );
  });

  it("controlled canvas selection flows back through onSelectionChange — clearing from the canvas resets state visible to future search-result clicks", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("import-panel-stub"));
    // Prime the state via search selection.
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "orders.q" },
    });
    fireEvent.click(
      screen.getByTestId("entity-search-result-queue:rabbit-a:/:orders.q"),
    );
    expect(screen.getByTestId("canvas-stub-selected").textContent).toBe(
      "queue:rabbit-a:/:orders.q",
    );
    // Canvas signals a clear via onSelectionChange(undefined) — App must
    // update its hoisted state so the next selection round-trip starts clean.
    fireEvent.click(screen.getByTestId("canvas-stub-clear"));
    expect(screen.getByTestId("canvas-stub-selected").textContent).toBe("");
    // Selecting a different entity after the clear still works.
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "orders.in" },
    });
    fireEvent.click(
      screen.getByTestId("entity-search-result-exchange:rabbit-a:/:orders.in"),
    );
    expect(screen.getByTestId("canvas-stub-selected").textContent).toBe(
      "exchange:rabbit-a:/:orders.in",
    );
  });

  it("clicking a search result switches the canvas into FOCUSED MODE — sets focusNodeId in addition to selectedNodeId (task 53 review acceptance)", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("import-panel-stub"));
    // Nothing focused before a pick.
    expect(screen.getByTestId("canvas-stub-focused").textContent).toBe("");
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "orders.q" },
    });
    fireEvent.click(
      screen.getByTestId("entity-search-result-queue:rabbit-a:/:orders.q"),
    );
    // BOTH selection and focus land — the operator's intent when picking
    // from a name-driven search is "walk THIS entity's flow," which is
    // focused mode, not just a highlight in the full topology.
    expect(screen.getByTestId("canvas-stub-selected").textContent).toBe(
      "queue:rabbit-a:/:orders.q",
    );
    expect(screen.getByTestId("canvas-stub-focused").textContent).toBe(
      "queue:rabbit-a:/:orders.q",
    );
    // Canvas-driven `Show full topology` clears focus without touching the
    // highlight — user can keep inspecting the same entity in unfocused
    // context.
    fireEvent.click(screen.getByTestId("canvas-stub-clear-focus"));
    expect(screen.getByTestId("canvas-stub-focused").textContent).toBe("");
    expect(screen.getByTestId("canvas-stub-selected").textContent).toBe(
      "queue:rabbit-a:/:orders.q",
    );
  });

  it("re-importing invalidates the current selection AND focus so neither can linger against a freshly built graph", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("import-panel-stub"));
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "orders.q" },
    });
    fireEvent.click(
      screen.getByTestId("entity-search-result-queue:rabbit-a:/:orders.q"),
    );
    expect(screen.getByTestId("canvas-stub-focused").textContent).toBe(
      "queue:rabbit-a:/:orders.q",
    );
    // Re-import: focus id must also be dropped, not only selection.
    fireEvent.click(screen.getByTestId("import-panel-stub"));
    expect(screen.getByTestId("canvas-stub-selected").textContent).toBe("");
    expect(screen.getByTestId("canvas-stub-focused").textContent).toBe("");
  });

  it("re-importing invalidates the current selection so a stale node id from a previous import cannot linger", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("import-panel-stub"));
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "orders.q" },
    });
    fireEvent.click(
      screen.getByTestId("entity-search-result-queue:rabbit-a:/:orders.q"),
    );
    expect(screen.getByTestId("canvas-stub-selected").textContent).toBe(
      "queue:rabbit-a:/:orders.q",
    );
    // Fire another import — App must reset the selection so the next graph
    // build does not receive a dangling id.
    fireEvent.click(screen.getByTestId("import-panel-stub"));
    expect(screen.getByTestId("canvas-stub-selected").textContent).toBe("");
  });
});
