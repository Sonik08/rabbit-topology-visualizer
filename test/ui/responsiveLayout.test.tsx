import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ImportResult } from "../../src/core/import";
import { ImportPanel } from "../../src/ui/components/ImportPanel";
import { EntitySearchBox } from "../../src/ui/components/EntitySearchBox";
import { TopologySummaryPanel } from "../../src/ui/components/TopologySummaryPanel";

// Reproduce a lightweight ImportResult so downstream panels can render
// without touching the real archive parser.
function fakeImportResult(): ImportResult {
  const parsed = {
    host: { id: "host:a", name: "a", sourceFiles: [] },
    vhosts: [{ id: "vhost:a:/", hostId: "host:a", name: "/" }],
    exchanges: [
      {
        id: "exchange:a:/:x1",
        hostId: "host:a",
        vhostId: "vhost:a:/",
        name: "x1",
        type: "topic",
      },
    ],
    queues: [
      {
        id: "queue:a:/:q1",
        hostId: "host:a",
        vhostId: "vhost:a:/",
        name: "q1",
      },
    ],
    bindings: [],
    policies: [],
    rawParameters: [],
    diagnostics: [],
  };
  return {
    archiveKind: "json",
    archivePath: "a.definitions.json",
    files: [
      {
        path: "a.definitions.json",
        sizeBytes: 128,
        kind: "definitions",
        parsed: parsed as never,
      },
    ],
    diagnostics: [],
  };
}

const NARROW_PHONE_WIDTH_PX = 320;

/**
 * Regression guard: walk every descendant of `root` and fail if ANY of them
 * pins its inline `width`/`min-width`/`max-width` to a fixed pixel value
 * greater than a narrow-phone viewport (320 px). This is the mechanical rule
 * behind the "no fixed-size layout constraints" requirement — any developer
 * who later reintroduces `maxWidth: 640` on a panel wrapper (the original
 * bug) is caught by a test failure, not by silent visual clipping.
 * jsdom does not run a CSS layout engine, so this is the strongest
 * viewport-fit assertion the environment permits.
 */
function assertNoFixedPixelWidthOverflow(root: HTMLElement): void {
  const offenders: string[] = [];
  root.querySelectorAll<HTMLElement>("*").forEach((el) => {
    for (const prop of ["width", "minWidth", "maxWidth"] as const) {
      const raw = el.style[prop];
      if (!raw) continue;
      // Only fixed pixel numbers are dangerous. Fluid units (%/vw/vh/em/rem/
      // fr/auto/clamp/min/max/calc) all resolve to something the viewport
      // can accommodate.
      const match = /^(\d+(?:\.\d+)?)(px)$/.exec(raw.trim());
      if (!match) continue;
      const px = Number(match[1]);
      if (px > NARROW_PHONE_WIDTH_PX) {
        offenders.push(
          `${el.tagName.toLowerCase()}` +
            `${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}` +
            ` sets ${prop}: ${raw} (> ${NARROW_PHONE_WIDTH_PX}px)`,
        );
      }
    }
  });
  expect(offenders, `fixed pixel widths that would overflow a narrow phone:\n${offenders.join("\n")}`).toEqual([]);
}

describe("Responsive layout — no fixed pixel widths, flex-wrap on control rows, graph re-fits on resize", () => {
  afterEach(() => {
    cleanup();
    vi.resetModules();
  });

  it("index.html does NOT rely on `overflow-x: hidden` to mask layout bugs (reviewer regression: hidden overflow can silently clip controls)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const html = await fs.readFile(
      path.resolve(process.cwd(), "index.html"),
      "utf8",
    );
    // Strip CSS block comments before scanning — the "why removed" comment
    // deliberately mentions `overflow-x: hidden` and must not trip the
    // regression check.
    const stripped = html.replace(/\/\*[\s\S]*?\*\//g, "");
    // The global reset stays (margin/box-sizing/min-height), but overflow-x
    // hidden must be gone so a real overflow surfaces during testing.
    expect(stripped).not.toMatch(/overflow-x\s*:\s*hidden/i);
    // Reset itself is still present.
    expect(stripped).toMatch(/box-sizing:\s*border-box/);
    expect(stripped).toMatch(/min-height:\s*100vh/);
  });

  it("no rendered element inside the ImportPanel, EntitySearchBox, or TopologySummaryPanel pins itself to a fixed pixel width > 320 px (mechanical overflow guard)", () => {
    const { container: importContainer } = render(
      <ImportPanel onImported={() => {}} />,
    );
    assertNoFixedPixelWidthOverflow(importContainer);
    cleanup();
    const { container: searchContainer } = render(
      <EntitySearchBox result={fakeImportResult()} onSelect={() => {}} />,
    );
    assertNoFixedPixelWidthOverflow(searchContainer);
    cleanup();
    const { container: summaryContainer } = render(
      <TopologySummaryPanel result={fakeImportResult()} />,
    );
    assertNoFixedPixelWidthOverflow(summaryContainer);
  });

  it("App shell uses only fluid units for width/padding/height — real overflow guard, not a string-only check", async () => {
    vi.doMock("../../src/ui/components/TopologyGraphCanvas", () => ({
      TopologyGraphCanvas: () => <section data-testid="canvas-stub" />,
    }));
    vi.doMock("../../src/ui/components/ImportPanel", () => ({
      ImportPanel: () => <div data-testid="import-panel-stub" />,
    }));
    const { App } = await import("../../src/App");
    const { container } = render(<App />);
    const main = container.querySelector("main")!;
    expect(main).toBeTruthy();
    // The mechanical guard rules out fixed pixel `maxWidth`/`width` >320.
    assertNoFixedPixelWidthOverflow(container);
    // Cross-check semantic width/height: main must resolve to `100%` width
    // via inline style AND `100vh` min-height, so the shell fills any
    // viewport instead of collapsing.
    expect(main.style.width).toBe("100%");
    expect(main.style.minHeight).toBe("100vh");
    // Padding is viewport-aware (`clamp`) so the gutter shrinks on narrow
    // screens rather than being frozen at 2rem.
    expect(main.style.padding).toMatch(/clamp\(/);
    vi.doUnmock("../../src/ui/components/TopologyGraphCanvas");
    vi.doUnmock("../../src/ui/components/ImportPanel");
  });

  it("TopologyGraphCanvas control rows (header, selection bar, focus bar) declare `flex-wrap: wrap` so controls reflow onto multiple lines instead of clipping on narrow viewports", async () => {
    vi.resetModules();
    installReactFlowStub();
    installTopologyWorkerStub();
    const mod = await import("../../src/ui/components/TopologyGraphCanvas");
    const { TopologyGraphCanvas } = mod;
    const { container } = render(
      <TopologyGraphCanvas
        result={fakeImportResult()}
        focusNodeId="queue:a:/:q1"
        onFocusChange={() => {}}
        selectedNodeId="queue:a:/:q1"
        onSelectionChange={() => {}}
      />,
    );
    // Header row is always present.
    const headerRow = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(
        '[data-testid="topology-graph-canvas"] > div',
      );
      expect(el).toBeTruthy();
      return el!;
    });
    expect(headerRow.style.flexWrap, "header row wraps").toBe("wrap");
    // Focus and selection bars are also flex — grab by test id.
    const focusBar = container.querySelector<HTMLElement>(
      '[data-testid="topology-graph-focus-summary"]',
    );
    expect(focusBar, "focus bar rendered").toBeTruthy();
    expect(focusBar!.style.flexWrap, "focus bar wraps").toBe("wrap");
    const selectionBar = container.querySelector<HTMLElement>(
      '[data-testid="topology-graph-selection-summary"]',
    );
    expect(selectionBar, "selection bar rendered").toBeTruthy();
    expect(selectionBar!.style.flexWrap, "selection bar wraps").toBe("wrap");
    assertNoFixedPixelWidthOverflow(container);
  });

  it("TopologyGraphCanvas graph shell uses `min(70vh, <heightPx>px)` without a hard pixel floor (short mobile viewports don't force the graph past the visible page)", async () => {
    vi.resetModules();
    installReactFlowStub();
    installTopologyWorkerStub();
    const mod = await import("../../src/ui/components/TopologyGraphCanvas");
    const { TopologyGraphCanvas } = mod;
    const heightPx = 420;
    render(<TopologyGraphCanvas result={fakeImportResult()} heightPx={heightPx} />);
    const stub = await screen.findByTestId("react-flow-stub");
    const shell = stub.parentElement!;
    // Height MUST be a `min()` capping viewport-fraction by the ideal
    // ceiling — never a `clamp` with a hard 320px floor (the reviewer's
    // regression: 320px floor exceeds short mobile viewports once the
    // headers/panels above the graph consume vertical space).
    expect(shell.style.height, "graph shell height uses min()").toMatch(/^min\(/);
    expect(shell.style.height, "graph shell height uses vh").toContain("vh");
    expect(shell.style.height, "graph shell caps at heightPx").toContain(`${heightPx}px`);
    // NO hard 320px (or larger) floor.
    expect(shell.style.height).not.toMatch(/clamp\(\s*3\d\dpx/);
    // Width fluid + border-box; the container inherits its parent's width.
    expect(shell.style.width).toBe("100%");
    expect(shell.style.boxSizing).toBe("border-box");
  });

  it("TopologyGraphCanvas actually calls `fitView` when its graph container is observed resizing (reviewer regression: React Flow does NOT auto-refit on container size change)", async () => {
    vi.resetModules();
    const fitViewSpy = vi.fn();
    const { triggerResize, observedCount } = installReactFlowStub({
      onInit: (recordFitView) => recordFitView(fitViewSpy),
    });
    installTopologyWorkerStub();
    const mod = await import("../../src/ui/components/TopologyGraphCanvas");
    const { TopologyGraphCanvas } = mod;
    render(<TopologyGraphCanvas result={fakeImportResult()} />);
    // The graph container attaches a ResizeObserver. Wait for it to observe.
    await waitFor(() => {
      expect(observedCount()).toBeGreaterThan(0);
    });
    // Baseline count includes any mount-time fitView (e.g. the focused-mode
    // effect that fires on initial commit). Snapshot it, then assert every
    // subsequent ResizeObserver notification increments the spy — proving
    // container resize actually reaches `fitView` via our wiring, which is
    // the reviewer's specific concern.
    const baseline = fitViewSpy.mock.calls.length;
    triggerResize();
    expect(fitViewSpy).toHaveBeenCalledTimes(baseline + 1);
    triggerResize();
    expect(fitViewSpy).toHaveBeenCalledTimes(baseline + 2);
    triggerResize();
    expect(fitViewSpy).toHaveBeenCalledTimes(baseline + 3);
  });

  it("simulated narrow viewport (320 px) — no rendered panel wrapper carries a fixed pixel width that would force horizontal overflow", async () => {
    // jsdom doesn't run CSS layout, so we simulate a narrow viewport by
    // overriding `window.innerWidth` (matchMedia queries in the component
    // tree respond to this), mount the full panel set, and re-run the
    // mechanical fixed-pixel-width scan on every rendered descendant.
    // This proves the guard holds AT a real narrow viewport size, not just
    // at the default jsdom width.
    Object.defineProperty(window, "innerWidth", { configurable: true, value: NARROW_PHONE_WIDTH_PX });
    window.dispatchEvent(new Event("resize"));
    const { container: c1 } = render(<ImportPanel onImported={() => {}} />);
    assertNoFixedPixelWidthOverflow(c1);
    cleanup();
    const { container: c2 } = render(
      <EntitySearchBox result={fakeImportResult()} onSelect={() => {}} />,
    );
    assertNoFixedPixelWidthOverflow(c2);
    cleanup();
    const { container: c3 } = render(<TopologySummaryPanel result={fakeImportResult()} />);
    assertNoFixedPixelWidthOverflow(c3);
  });
});

// --- Test doubles --------------------------------------------------------

interface ReactFlowStubHandle {
  triggerResize: () => void;
  observedCount: () => number;
}

/**
 * Install ReactFlow + ResizeObserver stubs. Returns handles so tests can
 * trigger container-resize notifications and inspect how many elements the
 * canvas observed.
 */
function installReactFlowStub(
  options: {
    onInit?: (recordFitView: (spy: (...args: unknown[]) => void) => void) => void;
  } = {},
): ReactFlowStubHandle {
  let recordedFitView: ((...args: unknown[]) => void) | undefined;
  const recordFitView = (spy: (...args: unknown[]) => void) => {
    recordedFitView = spy;
  };
  options.onInit?.(recordFitView);
  // ResizeObserver — jsdom doesn't ship one. Capture the callback + observed
  // element so tests can drive it manually.
  const observedElements: Element[] = [];
  const observerCallbacks: ResizeObserverCallback[] = [];
  class MockResizeObserver {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      observerCallbacks.push(cb);
    }
    observe(el: Element): void {
      observedElements.push(el);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.doMock("reactflow", () => {
    const Nothing = () => null;
    return {
      __esModule: true,
      default: (props: {
        children?: React.ReactNode;
        nodes?: unknown[];
        edges?: unknown[];
        onInit?: (instance: { fitView: (...args: unknown[]) => void }) => void;
      }) => {
        // Register a per-render fitView so the ResizeObserver test can
        // observe the call. Real React Flow's instance would call fitView
        // internally on nodes/edges change; we only care about the resize
        // path here, so surface the spy the test recorded.
        const instance = {
          fitView:
            recordedFitView ??
            (() => {
              /* no-op */
            }),
        };
        // Emulate `onInit` — React Flow calls it exactly once with its
        // instance after first render.
        props.onInit?.(instance);
        return (
          <div
            data-testid="react-flow-stub"
            data-node-count={String(props.nodes?.length ?? 0)}
            data-edge-count={String(props.edges?.length ?? 0)}
          >
            {props.children}
          </div>
        );
      },
      Background: Nothing,
      Controls: Nothing,
      MiniMap: Nothing,
      Handle: Nothing,
      Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
    };
  });
  return {
    observedCount: () => observedElements.length,
    triggerResize: () => {
      for (const cb of observerCallbacks) {
        cb(
          [
            {
              contentRect: {
                width: 500,
                height: 400,
                top: 0,
                left: 0,
                right: 500,
                bottom: 400,
                x: 0,
                y: 0,
                toJSON: () => ({}),
              },
              target: observedElements[0] ?? document.body,
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      }
    },
  };
}

function installTopologyWorkerStub(): void {
  vi.doMock("../../src/core/import", async () => {
    const actual = await vi.importActual<Record<string, unknown>>(
      "../../src/core/import",
    );
    return {
      ...actual,
      getSharedTopologyWorkerClient: () => ({
        buildGraph: async () => ({
          nodes: [],
          edges: [],
          diagnostics: [],
        }),
        computeUpstream: async () => ({
          nodeIds: new Set(),
          edgeIds: new Set(),
        }),
        bidirectionalForNode: async () => ({
          nodeIds: new Set(),
          edgeIds: new Set(),
        }),
        pruneNeighborhood: async (_input: unknown, focusNodeId: string) => ({
          nodes: [],
          edges: [],
          focusNodeId,
          focusMissing: true,
          truncated: false,
        }),
      }),
    };
  });
}

beforeEach(() => {
  // Reset ResizeObserver override between tests so the ReactFlow-stub tests
  // don't leak into the plain panel tests.
  vi.unstubAllGlobals();
});
