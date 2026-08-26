import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GraphNode } from "../../../src/core/model";
import type { UpstreamTraversalResult } from "../../../src/core/graph/traversal";
import { PathExplanationPanel } from "../../../src/ui/components/PathExplanationPanel";

afterEach(() => {
  cleanup();
});

const nodes: GraphNode[] = [
  { id: "exchange:a:x1", kind: "exchange", label: "x1", data: { name: "x1", type: "topic" } },
  { id: "exchange:a:x2", kind: "exchange", label: "x2", data: { name: "x2", type: "topic" } },
  { id: "queue:a:q1", kind: "queue", label: "q1", data: { name: "q1" } },
];

describe("PathExplanationPanel", () => {
  it("shows an empty-state hint when no traversal is provided", () => {
    render(<PathExplanationPanel nodes={nodes} />);
    expect(screen.getByTestId("path-explanation-panel").textContent).toMatch(
      /Select a queue or exchange/i,
    );
  });

  it("shows a no-publishers hint when the traversal has zero paths", () => {
    const traversal: UpstreamTraversalResult = {
      targetNodeId: "queue:a:q1",
      reachableAncestorIds: [],
      paths: [],
      truncated: false,
      visitedCycles: [],
    };
    render(<PathExplanationPanel nodes={nodes} traversal={traversal} />);
    expect(screen.getByTestId("path-explanation-panel").textContent).toMatch(
      /No upstream publishers/i,
    );
  });

  it("renders one section per path with a sentence per step", () => {
    const traversal: UpstreamTraversalResult = {
      targetNodeId: "queue:a:q1",
      reachableAncestorIds: ["exchange:a:x1", "exchange:a:x2"],
      paths: [
        {
          sourceNodeId: "exchange:a:x1",
          steps: [
            {
              edgeId: "b:x1->x2",
              fromNodeId: "exchange:a:x1",
              toNodeId: "exchange:a:x2",
              kind: "binds",
              routingKey: "a.b",
            },
            {
              edgeId: "b:x2->q1",
              fromNodeId: "exchange:a:x2",
              toNodeId: "queue:a:q1",
              kind: "binds",
              routingKey: "a.b",
            },
          ],
        },
      ],
      truncated: false,
      visitedCycles: [],
    };
    render(<PathExplanationPanel nodes={nodes} traversal={traversal} />);
    expect(screen.getByTestId("path-explanation-count").textContent).toMatch(/1 path/);
    const step0 = screen.getByTestId("path-explanation-item-0-step-0");
    const step1 = screen.getByTestId("path-explanation-item-0-step-1");
    // Each step renders as a human sentence containing the routing key.
    expect(step0.textContent).toMatch(/a\.b/);
    expect(step1.textContent).toMatch(/a\.b/);
  });

  it("renders distinct sections for two paths sharing source and target endpoints", () => {
    // Regression: keys must uniquely identify each path so React reconciliation
    // doesn't collapse parallel routes with identical endpoints into one entry
    // and doesn't emit a duplicate-key console warning.
    const traversal: UpstreamTraversalResult = {
      targetNodeId: "queue:a:q1",
      reachableAncestorIds: ["exchange:a:x1", "exchange:a:x2"],
      paths: [
        {
          sourceNodeId: "exchange:a:x1",
          steps: [
            {
              edgeId: "b:x1->x2:route-a",
              fromNodeId: "exchange:a:x1",
              toNodeId: "exchange:a:x2",
              kind: "binds",
              routingKey: "route.a",
            },
            {
              edgeId: "b:x2->q1",
              fromNodeId: "exchange:a:x2",
              toNodeId: "queue:a:q1",
              kind: "binds",
              routingKey: "route.a",
            },
          ],
        },
        {
          // Same source/target endpoints as the previous path — a caller
          // that emits both branches (e.g. after expanding a diamond) must
          // still render two independent list items.
          sourceNodeId: "exchange:a:x1",
          steps: [
            {
              edgeId: "b:x1->x2:route-b",
              fromNodeId: "exchange:a:x1",
              toNodeId: "exchange:a:x2",
              kind: "binds",
              routingKey: "route.b",
            },
            {
              edgeId: "b:x2->q1",
              fromNodeId: "exchange:a:x2",
              toNodeId: "queue:a:q1",
              kind: "binds",
              routingKey: "route.b",
            },
          ],
        },
      ],
      truncated: false,
      visitedCycles: [],
    };
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PathExplanationPanel nodes={nodes} traversal={traversal} />);
    // Both items rendered as siblings — no React collapse.
    expect(screen.getByTestId("path-explanation-item-0")).toBeTruthy();
    expect(screen.getByTestId("path-explanation-item-1")).toBeTruthy();
    // Distinct routing keys land in distinct sections.
    expect(screen.getByTestId("path-explanation-item-0").textContent).toMatch(/route\.a/);
    expect(screen.getByTestId("path-explanation-item-1").textContent).toMatch(/route\.b/);
    // React should NOT have logged a duplicate-key warning.
    const duplicateKeyWarnings = warn.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === "string" && /Encountered two children with the same key/i.test(arg)),
    );
    expect(duplicateKeyWarnings).toEqual([]);
    warn.mockRestore();
  });

  it("normalizes maxPaths: negative → 0 shows no paths, fractional → floor, non-finite → default", () => {
    const traversal: UpstreamTraversalResult = {
      targetNodeId: "queue:a:q1",
      reachableAncestorIds: ["s0", "s1", "s2"],
      paths: [
        { sourceNodeId: "s0", steps: [] },
        { sourceNodeId: "s1", steps: [] },
        { sourceNodeId: "s2", steps: [] },
      ],
      truncated: false,
      visitedCycles: [],
    };
    // Negative cap: zero paths rendered, all 3 flagged as hidden.
    const { unmount: u1 } = render(
      <PathExplanationPanel nodes={nodes} traversal={traversal} maxPaths={-5} />,
    );
    expect(screen.queryByTestId("path-explanation-item-0")).toBeNull();
    expect(screen.getByTestId("path-explanation-hidden").textContent).toMatch(
      /3 more paths not shown \(cap: 0\)/,
    );
    u1();
    // Fractional cap 1.9 → floor to 1: one path rendered.
    const { unmount: u2 } = render(
      <PathExplanationPanel nodes={nodes} traversal={traversal} maxPaths={1.9} />,
    );
    expect(screen.getByTestId("path-explanation-item-0")).toBeTruthy();
    expect(screen.queryByTestId("path-explanation-item-1")).toBeNull();
    expect(screen.getByTestId("path-explanation-hidden").textContent).toMatch(
      /2 more paths not shown \(cap: 1\)/,
    );
    u2();
    // NaN → default (12), all 3 shown, no hidden note.
    render(
      <PathExplanationPanel nodes={nodes} traversal={traversal} maxPaths={NaN} />,
    );
    expect(screen.getByTestId("path-explanation-item-0")).toBeTruthy();
    expect(screen.getByTestId("path-explanation-item-2")).toBeTruthy();
    expect(screen.queryByTestId("path-explanation-hidden")).toBeNull();
  });

  it("caps rendered paths at maxPaths and reports how many were hidden", () => {
    const traversal: UpstreamTraversalResult = {
      targetNodeId: "queue:a:q1",
      reachableAncestorIds: ["s0", "s1", "s2"],
      paths: [
        { sourceNodeId: "s0", steps: [] },
        { sourceNodeId: "s1", steps: [] },
        { sourceNodeId: "s2", steps: [] },
      ],
      truncated: true,
      visitedCycles: [],
    };
    render(<PathExplanationPanel nodes={nodes} traversal={traversal} maxPaths={2} />);
    expect(screen.getByTestId("path-explanation-count").textContent).toMatch(
      /3 paths.*truncated/,
    );
    expect(screen.getByTestId("path-explanation-item-0")).toBeTruthy();
    expect(screen.getByTestId("path-explanation-item-1")).toBeTruthy();
    expect(screen.queryByTestId("path-explanation-item-2")).toBeNull();
    expect(screen.getByTestId("path-explanation-hidden").textContent).toMatch(
      /1 more path not shown/,
    );
  });
});
