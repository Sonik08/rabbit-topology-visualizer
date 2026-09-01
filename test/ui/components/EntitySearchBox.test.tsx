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

describe("EntitySearchBox — ambiguity disambiguation UI (task 53 TODO)", () => {
  function mkAmbiguousMultiHostResult(): ImportResult {
    // Same queue name `orders.in` on TWO different hosts — the canonical
    // "which cluster did you mean?" ambiguity that must never be resolved by
    // silently picking the first arbitrary duplicate.
    const hostA = {
      host: { id: "host:rabbit-a", name: "rabbit-a", sourceFiles: [] },
      vhosts: [{ id: "vhost:rabbit-a:/", hostId: "host:rabbit-a", name: "/" }],
      exchanges: [],
      queues: [
        { id: "queue:rabbit-a:/:orders.in", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "orders.in" },
      ],
      bindings: [],
      policies: [],
      rawParameters: [],
      diagnostics: [],
    };
    const hostB = {
      host: { id: "host:rabbit-b", name: "rabbit-b", sourceFiles: [] },
      vhosts: [{ id: "vhost:rabbit-b:/", hostId: "host:rabbit-b", name: "/" }],
      exchanges: [],
      queues: [
        { id: "queue:rabbit-b:/:orders.in", hostId: "host:rabbit-b", vhostId: "vhost:rabbit-b:/", name: "orders.in" },
      ],
      bindings: [],
      policies: [],
      rawParameters: [],
      diagnostics: [],
    };
    return {
      archiveKind: "batch",
      archivePath: "batch",
      files: [
        { path: "rabbit-a.definitions.json", sizeBytes: 1, kind: "definitions", parsed: hostA as never },
        { path: "rabbit-b.definitions.json", sizeBytes: 1, kind: "definitions", parsed: hostB as never },
      ],
      diagnostics: [],
    };
  }

  it("renders a same-kind ambiguity banner when the SAME queue name lives on multiple hosts (never silently picks one)", () => {
    render(<EntitySearchBox result={mkAmbiguousMultiHostResult()} />);
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "orders.in" },
    });
    const banner = screen.getByTestId("entity-search-ambiguity");
    expect(banner.getAttribute("data-severity")).toBe("same-kind");
    expect(banner.textContent).toMatch(/Ambiguous name 'orders.in'/);
    expect(banner.textContent).toMatch(/2 matches across hosts\/vhosts/);
    // Both variants are still selectable — the UI never silently drops one.
    expect(
      screen.getByTestId("entity-search-result-queue:rabbit-a:/:orders.in"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("entity-search-result-queue:rabbit-b:/:orders.in"),
    ).toBeTruthy();
  });

  it("renders a cross-kind ambiguity banner when the same name lives on an exchange AND a queue on the same host", () => {
    render(<EntitySearchBox result={mkResult()} />);
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "audit" },
    });
    const banner = screen.getByTestId("entity-search-ambiguity");
    expect(banner.getAttribute("data-severity")).toBe("cross-kind");
    expect(banner.textContent).toMatch(/matches 2 entities across kinds/);
  });

  it("omits the ambiguity banner when a single exact match is unambiguous", () => {
    render(<EntitySearchBox result={mkResult()} />);
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "billing.queue" },
    });
    expect(screen.queryByTestId("entity-search-ambiguity")).toBeNull();
  });

  it("renders one explicit host/vhost chooser button per variant and invokes onSelect(entity) with the picked variant — the disambiguation is a control, not just a warning", () => {
    // Task 53 acceptance: ambiguity UI must PROVIDE the disambiguation
    // choice — a text-only banner would still leave the user picking from
    // the generic result list, which is what the review rejected.
    const onSelect = vi.fn();
    render(
      <EntitySearchBox
        result={mkAmbiguousMultiHostResult()}
        onSelect={onSelect}
      />,
    );
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "orders.in" },
    });
    // Both variants are rendered as chooser buttons inside the banner.
    const chooserA = screen.getByTestId(
      "entity-search-ambiguity-choice-queue:rabbit-a:/:orders.in",
    );
    const chooserB = screen.getByTestId(
      "entity-search-ambiguity-choice-queue:rabbit-b:/:orders.in",
    );
    expect(chooserA.tagName).toBe("BUTTON");
    expect(chooserB.tagName).toBe("BUTTON");
    // Clicking a chooser forwards THAT specific entity id — not the first
    // duplicate, not an arbitrary one — so a focused-flow view can walk the
    // host the operator actually meant.
    fireEvent.click(chooserB);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].id).toBe(
      "queue:rabbit-b:/:orders.in",
    );
  });
});

describe("EntitySearchBox — cross-file aggregate resolution (task 53 TODO)", () => {
  it("resolves search matches from EVERY parsed file in the ImportResult, not just the first one", () => {
    // Two distinct files under a single batch import, each contributing an
    // entity with the same fuzzy substring `orders` but from separate hosts.
    // A regression here (e.g. reading only files[0]) would surface only one.
    const fileA = {
      host: { id: "host:rabbit-a", name: "rabbit-a", sourceFiles: [] },
      vhosts: [{ id: "vhost:rabbit-a:/", hostId: "host:rabbit-a", name: "/" }],
      exchanges: [
        { id: "exchange:rabbit-a:/:orders.in", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "orders.in", type: "topic" },
      ],
      queues: [],
      bindings: [],
      policies: [],
      rawParameters: [],
      diagnostics: [],
    };
    const fileB = {
      host: { id: "host:rabbit-b", name: "rabbit-b", sourceFiles: [] },
      vhosts: [{ id: "vhost:rabbit-b:/", hostId: "host:rabbit-b", name: "/" }],
      exchanges: [],
      queues: [
        { id: "queue:rabbit-b:/:orders.out", hostId: "host:rabbit-b", vhostId: "vhost:rabbit-b:/", name: "orders.out" },
      ],
      bindings: [],
      policies: [],
      rawParameters: [],
      diagnostics: [],
    };
    const result: ImportResult = {
      archiveKind: "batch",
      archivePath: "cross-file",
      files: [
        { path: "rabbit-a.definitions.json", sizeBytes: 1, kind: "definitions", parsed: fileA as never },
        { path: "rabbit-b.definitions.json", sizeBytes: 1, kind: "definitions", parsed: fileB as never },
      ],
      diagnostics: [],
    };
    render(<EntitySearchBox result={result} />);
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "orders" },
    });
    const fuzzy = screen.getByTestId("entity-search-fuzzy");
    // Entities from BOTH files are surfaced by the aggregate.
    expect(fuzzy.textContent).toContain("orders.in");
    expect(fuzzy.textContent).toContain("orders.out");
    expect(
      screen.getByTestId("entity-search-result-exchange:rabbit-a:/:orders.in"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("entity-search-result-queue:rabbit-b:/:orders.out"),
    ).toBeTruthy();
  });
});

describe("EntitySearchBox — truncated fuzzy-result indicator (task 53 TODO)", () => {
  it("surfaces a truncation hint when fuzzy matches exceed the limit and hides it when they do not", () => {
    // Build 6 queues sharing the `pay` substring; a limit of 3 must truncate
    // three of them and render the hint. A limit of 25 (default) fits all six
    // and must NOT render the hint (false-positive regression: previously the
    // hint could fire whenever the returned list happened to equal the limit,
    // even when nothing had been truncated).
    const parsed = {
      host: { id: "host:rabbit-a", name: "rabbit-a", sourceFiles: [] },
      vhosts: [{ id: "vhost:rabbit-a:/", hostId: "host:rabbit-a", name: "/" }],
      exchanges: [],
      queues: Array.from({ length: 6 }, (_, i) => ({
        id: `queue:rabbit-a:/:pay.q${i}`,
        hostId: "host:rabbit-a",
        vhostId: "vhost:rabbit-a:/",
        name: `pay.q${i}`,
      })),
      bindings: [],
      policies: [],
      rawParameters: [],
      diagnostics: [],
    };
    const result: ImportResult = {
      archiveKind: "json",
      archivePath: "rabbit-a.definitions.json",
      files: [{ path: "rabbit-a.definitions.json", sizeBytes: 1024, kind: "definitions", parsed: parsed as never }],
      diagnostics: [],
    };
    const { unmount } = render(<EntitySearchBox result={result} limit={3} />);
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "pay" },
    });
    const truncated = screen.getByTestId("entity-search-fuzzy-truncated");
    expect(truncated.textContent).toMatch(/top 3 fuzzy matches/);
    expect(truncated.textContent).toMatch(/truncated/i);
    unmount();
    render(<EntitySearchBox result={result} limit={25} />);
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "pay" },
    });
    expect(screen.queryByTestId("entity-search-fuzzy-truncated")).toBeNull();
  });

  it("regression: exact matches that also score highly in the fuzzy pass do NOT cause truncation detection to false-negative (task 53 review acceptance)", () => {
    // Two entities named exactly "orders" (queue AND exchange — both are
    // exact matches for the query, and both would score highest in the
    // fuzzy pass) PLUS five more `orders.*` entities that only fuzzy-match.
    // Requesting `limit + 1` from the fuzzy scorer would have burnt those
    // top two slots on the exact overlaps, leaving too few post-filter
    // candidates to detect truncation. The oversample budget must include
    // room for the excluded exact ids so a genuine truncation still fires.
    const queues = [
      { id: "queue:rabbit-a:/:orders", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "orders" },
      { id: "queue:rabbit-a:/:orders.a", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "orders.a" },
      { id: "queue:rabbit-a:/:orders.b", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "orders.b" },
      { id: "queue:rabbit-a:/:orders.c", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "orders.c" },
      { id: "queue:rabbit-a:/:orders.d", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "orders.d" },
      { id: "queue:rabbit-a:/:orders.e", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "orders.e" },
    ];
    const exchanges = [
      { id: "exchange:rabbit-a:/:orders", hostId: "host:rabbit-a", vhostId: "vhost:rabbit-a:/", name: "orders", type: "topic" },
    ];
    const parsed = {
      host: { id: "host:rabbit-a", name: "rabbit-a", sourceFiles: [] },
      vhosts: [{ id: "vhost:rabbit-a:/", hostId: "host:rabbit-a", name: "/" }],
      exchanges,
      queues,
      bindings: [],
      policies: [],
      rawParameters: [],
      diagnostics: [],
    };
    const result: ImportResult = {
      archiveKind: "json",
      archivePath: "rabbit-a.definitions.json",
      files: [{ path: "rabbit-a.definitions.json", sizeBytes: 1024, kind: "definitions", parsed: parsed as never }],
      diagnostics: [],
    };
    // limit=3 → 5 fuzzy-only candidates (`orders.a..e`) exceed the cap.
    // 2 exact matches (queue `orders` + exchange `orders`) sit in the exact
    // block. Truncation MUST fire; the exact list must NOT be starved.
    render(<EntitySearchBox result={result} limit={3} />);
    fireEvent.change(screen.getByTestId("entity-search-query"), {
      target: { value: "orders" },
    });
    // Both exact matches still surface — the disambiguation is preserved.
    expect(
      screen.getByTestId("entity-search-result-queue:rabbit-a:/:orders"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("entity-search-result-exchange:rabbit-a:/:orders"),
    ).toBeTruthy();
    // Fuzzy list caps at 3 entries — a naive `limit + 1` oversample would
    // have returned `{orders(queue), orders(exchange), orders.a, orders.b}`,
    // filtered the two exact overlaps, and left only 2 fuzzy items — below
    // `limit`, so `truncated` would silently read false. With the +exactIds
    // budget the fuzzy pass returns enough candidates to trigger the flag.
    expect(screen.getByTestId("entity-search-fuzzy-truncated")).toBeTruthy();
  });
});
