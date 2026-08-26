import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ImportResult } from "../../../src/core/import";
import type { Diagnostic } from "../../../src/core/model/topology";
import { TopologySummaryPanel } from "../../../src/ui/components/TopologySummaryPanel";

afterEach(() => {
  cleanup();
});

function mkParsed(overrides: Partial<{
  hostId: string;
  vhosts: number;
  exchanges: number;
  queues: number;
  bindings: number;
  policies: number;
  rawParameters: number;
}> = {}) {
  const {
    hostId = "host:rabbit-a",
    vhosts = 1,
    exchanges = 2,
    queues = 3,
    bindings = 4,
    policies = 0,
    rawParameters = 0,
  } = overrides;
  return {
    host: { id: hostId, name: "rabbit-a", vhostIds: [] },
    vhosts: Array.from({ length: vhosts }, (_, i) => ({
      id: `vhost:${hostId}:v${i}`,
      hostId,
      name: `v${i}`,
    })),
    exchanges: Array.from({ length: exchanges }, (_, i) => ({
      id: `exchange:${hostId}:e${i}`,
      name: `e${i}`,
      vhostId: `vhost:${hostId}:v0`,
      type: "topic",
    })),
    queues: Array.from({ length: queues }, (_, i) => ({
      id: `queue:${hostId}:q${i}`,
      name: `q${i}`,
      vhostId: `vhost:${hostId}:v0`,
    })),
    bindings: Array.from({ length: bindings }, (_, i) => ({
      id: `binding:${hostId}:b${i}`,
      vhostId: `vhost:${hostId}:v0`,
      sourceExchangeId: `exchange:${hostId}:e0`,
      destinationQueueId: `queue:${hostId}:q0`,
      routingKey: `k${i}`,
      arguments: {},
    })),
    policies: Array.from({ length: policies }, (_, i) => ({
      id: `policy:${hostId}:p${i}`,
      name: `p${i}`,
      vhostId: `vhost:${hostId}:v0`,
      pattern: "^",
      applyTo: "all" as const,
      priority: 0,
      definition: {},
    })),
    rawParameters: Array.from({ length: rawParameters }, (_, i) => ({
      component: "shovel",
      vhost: "v0",
      name: `p${i}`,
      value: {},
    })),
    diagnostics: [],
  } as unknown as NonNullable<ImportResult["files"][number]["parsed"]>;
}

function mkResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    archiveKind: "json",
    archivePath: "rabbit-a.definitions.json",
    files: [
      {
        path: "rabbit-a.definitions.json",
        sizeBytes: 1024,
        kind: "definitions",
        parsed: mkParsed(),
        runtime: {
          shovels: [{ id: "s1" }, { id: "s2" }],
          federations: [{ id: "f1" }],
          diagnostics: [],
        } as unknown as NonNullable<ImportResult["files"][number]["runtime"]>,
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

describe("TopologySummaryPanel — headline totals", () => {
  it("renders file counts, host/vhost/entity totals, and archive kind badge", () => {
    render(<TopologySummaryPanel result={mkResult()} />);

    expect(screen.getByRole("region", { name: /topology summary/i })).toBeTruthy();
    // Archive kind badge shows the uppercased archive kind (multiple JSON
    // hits render — the archivePath ends in `.json` too).
    expect(screen.getAllByText(/JSON/).length).toBeGreaterThan(0);
    // File counts
    expect(screen.getByText(/Total entries: 1/)).toBeTruthy();
    expect(screen.getByText(/Definitions exports: 1/)).toBeTruthy();
    expect(screen.getByText(/Management-dump files: 0/)).toBeTruthy();
    // Topology counts derived from parsed + runtime
    expect(screen.getByText(/Hosts: 1/)).toBeTruthy();
    expect(screen.getByText(/Vhosts: 1/)).toBeTruthy();
    expect(screen.getByText(/Exchanges: 2/)).toBeTruthy();
    expect(screen.getByText(/Queues: 3/)).toBeTruthy();
    expect(screen.getByText(/Bindings: 4/)).toBeTruthy();
    expect(screen.getByText(/Shovels: 2/)).toBeTruthy();
    expect(screen.getByText(/Federation links: 1/)).toBeTruthy();
  });

  it("de-duplicates hosts across multiple parsed files sharing the same host id", () => {
    const result = mkResult({
      files: [
        {
          path: "a1.json",
          sizeBytes: 1,
          kind: "definitions",
          parsed: mkParsed({ hostId: "host:shared", vhosts: 1, exchanges: 1, queues: 1, bindings: 1 }),
        },
        {
          path: "a2.json",
          sizeBytes: 1,
          kind: "definitions",
          parsed: mkParsed({ hostId: "host:shared", vhosts: 1, exchanges: 1, queues: 1, bindings: 1 }),
        },
      ],
    });
    render(<TopologySummaryPanel result={result} />);
    // Two parsed files, both from host:shared → hosts count is 1, not 2.
    expect(screen.getByText(/Hosts: 1/)).toBeTruthy();
    // Vhosts/exchanges are summed across parsed files (design: two files
    // report two vhosts total). Guards against regression in the reducer.
    expect(screen.getByText(/Vhosts: 2/)).toBeTruthy();
    expect(screen.getByText(/Exchanges: 2/)).toBeTruthy();
  });
});

describe("TopologySummaryPanel — diagnostics", () => {
  it("shows 'No diagnostics' when the result has none, and no toggle button", () => {
    render(<TopologySummaryPanel result={mkResult()} />);
    expect(screen.getByText(/No diagnostics/i)).toBeTruthy();
    expect(screen.queryByTestId("diagnostics-toggle")).toBeNull();
  });

  it("renders severity counts and reveals per-code details when expanded", () => {
    const diagnostics: Diagnostic[] = [
      { severity: "error", code: "parse.malformed-json", message: "bad json", sourceFileId: "file:bad.json" },
      { severity: "error", code: "parse.malformed-json", message: "bad json 2", sourceFileId: "file:bad2.json" },
      { severity: "warning", code: "import.entry-too-large", message: "skipped huge.json" },
      { severity: "info", code: "graph.info-noop", message: "informational" },
    ];
    render(<TopologySummaryPanel result={mkResult({ diagnostics })} />);
    // Summary counts by severity are rendered as coloured text within the
    // heading. Assert on the shared summary node so the exact wrapping stays
    // flexible for future style tweaks.
    const total = screen.getByTestId("diagnostics-total");
    expect(total.textContent).toContain("4 total");
    expect(total.textContent).toContain("2 errors");
    expect(total.textContent).toContain("1 warnings");
    expect(total.textContent).toContain("1 info");

    // Details start collapsed; clicking the toggle reveals the per-code list
    // and per-severity <details> blocks.
    expect(screen.queryByTestId("diagnostics-details")).toBeNull();
    const toggle = screen.getByTestId("diagnostics-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("diagnostics-details")).toBeTruthy();
    expect(screen.getByText(/Counts by code/i)).toBeTruthy();
    // Highest-count code appears first, error severity block is always open.
    expect(screen.getByTestId("diagnostics-error")).toBeTruthy();
    expect(screen.getByText(/bad json 2/)).toBeTruthy();
    // Toggle again hides details.
    fireEvent.click(toggle);
    expect(screen.queryByTestId("diagnostics-details")).toBeNull();
  });

  it("caps per-severity output at maxDiagnosticsPerSeverity and reports the hidden remainder", () => {
    const diagnostics: Diagnostic[] = Array.from({ length: 30 }, (_, i) => ({
      severity: "warning" as const,
      code: `w.code-${i}`,
      message: `warning ${i}`,
    }));
    render(
      <TopologySummaryPanel result={mkResult({ diagnostics })} maxDiagnosticsPerSeverity={3} />,
    );
    fireEvent.click(screen.getByTestId("diagnostics-toggle"));
    // Only the first 3 warnings render as list items; a summary line reports
    // the remaining 27 as hidden.
    const warningBlock = screen.getByTestId("diagnostics-warning");
    // Expand the collapsed warning <details> so its content becomes visible.
    fireEvent.click(warningBlock.querySelector("summary")!);
    expect(warningBlock.textContent).toContain("warning 0");
    expect(warningBlock.textContent).toContain("warning 2");
    expect(warningBlock.textContent).not.toContain("warning 3");
    expect(warningBlock.textContent).toMatch(/27 more not shown/);
  });
});
