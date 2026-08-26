import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ImportResult } from "../../../src/core/import";
import { EntitySearchBox } from "../../../src/ui/components/EntitySearchBox";

afterEach(() => {
  cleanup();
});

function mkResult(): ImportResult {
  const parsed = {
    host: { id: "host:rabbit-a", name: "rabbit-a", sourceFiles: [] },
    vhosts: [{ id: "vhost:rabbit-a:/", hostId: "host:rabbit-a", name: "/" }],
    exchanges: [
      { id: "exchange:rabbit-a:/:orders.in", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "orders.in", type: "topic" },
      { id: "exchange:rabbit-a:/:orders.dlx", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "orders.dlx", type: "fanout" },
      { id: "exchange:rabbit-a:/:audit", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "audit", type: "fanout" },
    ],
    queues: [
      { id: "queue:rabbit-a:/:orders.queue", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "orders.queue" },
      { id: "queue:rabbit-a:/:audit", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "audit" },
      { id: "queue:rabbit-a:/:billing.queue", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "billing.queue" },
    ],
    bindings: [],
    policies: [],
    rawParameters: [],
    diagnostics: [],
  };
  return {
    archiveKind: "json",
    archivePath: "rabbit-a.definitions.json",
    files: [{ path: "rabbit-a.definitions.json", sizeBytes: 1024, kind: "definitions", parsed: parsed as never }],
    diagnostics: [],
  };
}

describe("EntitySearchBox — idle + kind filter", () => {
  it("renders the input, kind selector, and hint text on mount", () => {
    render(<EntitySearchBox result={mkResult()} />);
    expect(screen.getByRole("region", { name: /search topology/i })).toBeTruthy();
    expect(screen.getByTestId("entity-search-query")).toBeTruthy();
    expect(screen.getByTestId("entity-search-kind")).toBeTruthy();
    expect(screen.getByTestId("entity-search-hint")).toBeTruthy();
  });
});

describe("EntitySearchBox — exact + fuzzy blocks", () => {
  it("elevates exact matches above fuzzy results and de-dupes overlap", () => {
    render(<EntitySearchBox result={mkResult()} />);
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "audit" },
    });

    // Exact matches: exchange "audit" + queue "audit" (across kinds).
    const exact = screen.getByTestId("entity-search-exact");
    expect(exact.textContent).toContain("audit");
    // Fuzzy list either doesn't exist (all matches were exact) or does not
    // repeat the exact "audit" entities.
    const fuzzy = screen.queryByTestId("entity-search-fuzzy");
    if (fuzzy) {
      // Fuzzy hits must be distinct from the exact ones — no repeated ids.
      const exactAudit = exact.querySelector('[data-testid$=":audit"]');
      const fuzzyAudit = fuzzy.querySelector('[data-testid$=":audit"]');
      expect(exactAudit).toBeTruthy();
      expect(fuzzyAudit).toBeNull();
    }
  });

  it("returns fuzzy substring matches when no exact match exists", () => {
    render(<EntitySearchBox result={mkResult()} />);
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "orders" },
    });
    expect(screen.queryByTestId("entity-search-exact")).toBeNull();
    const fuzzy = screen.getByTestId("entity-search-fuzzy");
    expect(fuzzy.textContent).toContain("orders.in");
    expect(fuzzy.textContent).toContain("orders.dlx");
    expect(fuzzy.textContent).toContain("orders.queue");
  });

  it("kind=queue filters exchanges out of the fuzzy results", () => {
    render(<EntitySearchBox result={mkResult()} />);
    fireEvent.change(screen.getByTestId("entity-search-kind"), {
      target: { value: "queue" },
    });
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "orders" },
    });
    const fuzzy = screen.getByTestId("entity-search-fuzzy");
    expect(fuzzy.textContent).toContain("orders.queue");
    expect(fuzzy.textContent).not.toContain("orders.in");
    expect(fuzzy.textContent).not.toContain("orders.dlx");
  });

  it("shows an empty state when the query matches nothing", () => {
    render(<EntitySearchBox result={mkResult()} />);
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "zzzzz-no-such-name" },
    });
    expect(screen.getByTestId("entity-search-empty")).toBeTruthy();
    expect(screen.queryByTestId("entity-search-results")).toBeNull();
  });

  it("invokes onSelect when a result row is clicked", () => {
    const onSelect = vi.fn();
    render(<EntitySearchBox result={mkResult()} onSelect={onSelect} />);
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "billing" },
    });
    const row = screen.getByTestId("entity-search-result-queue:rabbit-a:/:billing.queue");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].id).toBe("queue:rabbit-a:/:billing.queue");
  });
});
