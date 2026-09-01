import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GraphNode } from "../../../src/core/model";
import type {
  DownstreamTraversalResult,
  UpstreamTraversalResult,
} from "../../../src/core/graph/traversal";
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
      /Select a queue, exchange, shovel, or federation link/i,
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
      /No upstream publishers or downstream consumers/i,
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
    expect(screen.getByTestId("path-explanation-upstream-count").textContent).toMatch(/1 path/);
    const step0 = screen.getByTestId("path-explanation-upstream-item-0-step-0");
    const step1 = screen.getByTestId("path-explanation-upstream-item-0-step-1");
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
    expect(screen.getByTestId("path-explanation-upstream-item-0")).toBeTruthy();
    expect(screen.getByTestId("path-explanation-upstream-item-1")).toBeTruthy();
    // Distinct routing keys land in distinct sections.
    expect(screen.getByTestId("path-explanation-upstream-item-0").textContent).toMatch(/route\.a/);
    expect(screen.getByTestId("path-explanation-upstream-item-1").textContent).toMatch(/route\.b/);
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
    expect(screen.queryByTestId("path-explanation-upstream-item-0")).toBeNull();
    expect(screen.getByTestId("path-explanation-upstream-hidden").textContent).toMatch(
      /3 more paths not shown \(cap: 0\)/,
    );
    u1();
    // Fractional cap 1.9 → floor to 1: one path rendered.
    const { unmount: u2 } = render(
      <PathExplanationPanel nodes={nodes} traversal={traversal} maxPaths={1.9} />,
    );
    expect(screen.getByTestId("path-explanation-upstream-item-0")).toBeTruthy();
    expect(screen.queryByTestId("path-explanation-upstream-item-1")).toBeNull();
    expect(screen.getByTestId("path-explanation-upstream-hidden").textContent).toMatch(
      /2 more paths not shown \(cap: 1\)/,
    );
    u2();
    // NaN → default (12), all 3 shown, no hidden note.
    render(
      <PathExplanationPanel nodes={nodes} traversal={traversal} maxPaths={NaN} />,
    );
    expect(screen.getByTestId("path-explanation-upstream-item-0")).toBeTruthy();
    expect(screen.getByTestId("path-explanation-upstream-item-2")).toBeTruthy();
    expect(screen.queryByTestId("path-explanation-upstream-hidden")).toBeNull();
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
    expect(screen.getByTestId("path-explanation-upstream-count").textContent).toMatch(
      /3 paths.*truncated/,
    );
    expect(screen.getByTestId("path-explanation-upstream-item-0")).toBeTruthy();
    expect(screen.getByTestId("path-explanation-upstream-item-1")).toBeTruthy();
    expect(screen.queryByTestId("path-explanation-upstream-item-2")).toBeNull();
    expect(screen.getByTestId("path-explanation-upstream-hidden").textContent).toMatch(
      /1 more path not shown/,
    );
  });

  it("renders BOTH an upstream section AND a downstream section when both directions have paths (task 58: distinguish incoming vs outgoing)", () => {
    const upstream: UpstreamTraversalResult = {
      targetNodeId: "exchange:a:x2",
      reachableAncestorIds: ["exchange:a:x1"],
      paths: [
        {
          sourceNodeId: "exchange:a:x1",
          steps: [
            {
              edgeId: "b:x1->x2",
              fromNodeId: "exchange:a:x1",
              toNodeId: "exchange:a:x2",
              kind: "binds",
              routingKey: "route.up",
            },
          ],
        },
      ],
      truncated: false,
      visitedCycles: [],
    };
    const downstream: DownstreamTraversalResult = {
      targetNodeId: "exchange:a:x2",
      reachableDescendantIds: ["queue:a:q1"],
      paths: [
        {
          sinkNodeId: "queue:a:q1",
          steps: [
            {
              edgeId: "b:x2->q1",
              fromNodeId: "exchange:a:x2",
              toNodeId: "queue:a:q1",
              kind: "binds",
              routingKey: "route.down",
            },
          ],
        },
      ],
      truncated: false,
      visitedCycles: [],
    };
    render(
      <PathExplanationPanel
        nodes={nodes}
        traversal={upstream}
        downstream={downstream}
      />,
    );
    // Distinct sections rendered.
    expect(screen.getByTestId("path-explanation-upstream")).toBeTruthy();
    expect(screen.getByTestId("path-explanation-downstream")).toBeTruthy();
    // Upstream section carries the incoming routing key.
    expect(
      screen.getByTestId("path-explanation-upstream-item-0-step-0").textContent,
    ).toMatch(/route\.up/);
    // Downstream section carries the outgoing routing key.
    expect(
      screen.getByTestId("path-explanation-downstream-item-0-step-0").textContent,
    ).toMatch(/route\.down/);
    // Per-direction counts are independent.
    expect(
      screen.getByTestId("path-explanation-upstream-count").textContent,
    ).toMatch(/1 path/);
    expect(
      screen.getByTestId("path-explanation-downstream-count").textContent,
    ).toMatch(/1 path/);
  });

  it("hides the downstream section when only the upstream traversal is provided (backwards-compatible with pre-bidirectional callers)", () => {
    const upstream: UpstreamTraversalResult = {
      targetNodeId: "queue:a:q1",
      reachableAncestorIds: ["exchange:a:x1"],
      paths: [
        {
          sourceNodeId: "exchange:a:x1",
          steps: [
            {
              edgeId: "b:x1->q1",
              fromNodeId: "exchange:a:x1",
              toNodeId: "queue:a:q1",
              kind: "binds",
              routingKey: "k",
            },
          ],
        },
      ],
      truncated: false,
      visitedCycles: [],
    };
    render(<PathExplanationPanel nodes={nodes} traversal={upstream} />);
    expect(screen.getByTestId("path-explanation-upstream")).toBeTruthy();
    expect(screen.queryByTestId("path-explanation-downstream")).toBeNull();
  });

  it("renders a cycle-aware reach indication when paths are empty but reach is non-empty (regression: pre-fix the panel said 'no publishers/consumers found' while the highlight glowed with cycle nodes)", () => {
    // A defensive rendering path — with the traversal-side BFS-tree-leaf
    // fix the panel normally gets representative paths for cycle reach, but
    // a hand-crafted traversal envelope (worker returned empty paths, or a
    // future upstream change) with non-empty reach must NOT contradict the
    // on-screen highlight. Assert the fallback message instead of the plain
    // "not found" empty state.
    const cyclicUpstream: UpstreamTraversalResult = {
      targetNodeId: "exchange:a:x1",
      reachableAncestorIds: ["exchange:a:x2", "exchange:a:x3"],
      paths: [],
      truncated: false,
      visitedCycles: ["exchange:a:x1"],
    };
    const cyclicDownstream: DownstreamTraversalResult = {
      targetNodeId: "exchange:a:x1",
      reachableDescendantIds: ["exchange:a:x2"],
      paths: [],
      truncated: false,
      visitedCycles: ["exchange:a:x1"],
    };
    render(
      <PathExplanationPanel
        nodes={nodes}
        traversal={cyclicUpstream}
        downstream={cyclicDownstream}
      />,
    );
    const message = screen.getByTestId("path-explanation-cycle-reach");
    expect(message.textContent).toMatch(/closed cycle/i);
    // Per-direction reach counts are surfaced so the number cannot silently
    // disagree with the highlight badge in the summary bar.
    expect(message.textContent).toMatch(/2 upstream nodes/);
    expect(message.textContent).toMatch(/1 downstream node[^s]/);
    // The pre-fix "no publishers/consumers" copy is NOT rendered in this case.
    expect(message.textContent).not.toMatch(/No upstream publishers/i);
  });

  it("hides the upstream section when only the downstream traversal has paths — asymmetric selections stay uncluttered", () => {
    const emptyUpstream: UpstreamTraversalResult = {
      targetNodeId: "exchange:a:x1",
      reachableAncestorIds: [],
      paths: [],
      truncated: false,
      visitedCycles: [],
    };
    const downstream: DownstreamTraversalResult = {
      targetNodeId: "exchange:a:x1",
      reachableDescendantIds: ["queue:a:q1"],
      paths: [
        {
          sinkNodeId: "queue:a:q1",
          steps: [
            {
              edgeId: "b:x1->q1",
              fromNodeId: "exchange:a:x1",
              toNodeId: "queue:a:q1",
              kind: "binds",
              routingKey: "k",
            },
          ],
        },
      ],
      truncated: false,
      visitedCycles: [],
    };
    render(
      <PathExplanationPanel
        nodes={nodes}
        traversal={emptyUpstream}
        downstream={downstream}
      />,
    );
    // No upstream paths → no upstream section rendered.
    expect(screen.queryByTestId("path-explanation-upstream")).toBeNull();
    expect(screen.getByTestId("path-explanation-downstream")).toBeTruthy();
    expect(
      screen.getByTestId("path-explanation-downstream-item-0").textContent,
    ).toMatch(/binds/);
  });

  it("renders a per-step 'Applies when' condition line so the chain never implies every message follows the route", () => {
    // Task 40 acceptance: each chain step must surface binding/routing
    // restrictions and conditional semantics. This regression pins the
    // condition annotation into the DOM so a future panel refactor that
    // drops the second <div> silently regresses the acceptance criterion.
    const traversal: UpstreamTraversalResult = {
      targetNodeId: "queue:a:q1",
      reachableAncestorIds: ["exchange:a:x1"],
      paths: [
        {
          sourceNodeId: "exchange:a:x1",
          steps: [
            {
              edgeId: "b:x1->q1",
              fromNodeId: "exchange:a:x1",
              toNodeId: "queue:a:q1",
              kind: "binds",
              routingKey: "orders.*",
            },
          ],
        },
      ],
      truncated: false,
      visitedCycles: [],
    };
    render(<PathExplanationPanel nodes={nodes} traversal={traversal} />);
    const condition = screen.getByTestId(
      "path-explanation-upstream-item-0-step-0-condition",
    );
    // Prefix is the hedge signal — operators read "Applies when: …" and
    // understand the route is conditional, not guaranteed for every msg.
    expect(condition.textContent).toMatch(/^Applies when:/);
    // Topic exchange in the fixture → wording must mention topic pattern
    // and the specific routing key so the operator sees WHY it's hedged.
    expect(condition.textContent).toMatch(/topic pattern/);
    expect(condition.textContent).toContain("'orders.*'");
  });

  it("renders an 'Unresolved endpoint' badge on paths that traverse an external node so unresolved links are visible at a glance", () => {
    // Task 40 acceptance: "clearly report cycles, truncation, ambiguity,
    // and unresolved links." The per-step condition already hedges
    // routing outcome when a shovel/federation touches an external node,
    // but the operator must be able to spot such paths WITHOUT reading
    // every condition line. This pins the per-path badge into the DOM.
    const nodesWithExternal: GraphNode[] = [
      ...nodes,
      {
        id: "external:remote/%2F/x%3Aremote",
        kind: "external",
        label: "exchange remote @ remote-broker//",
        data: {},
      },
      { id: "shovel:a:s1", kind: "shovel", label: "s1", data: { name: "s1" } },
    ];
    const traversal: UpstreamTraversalResult = {
      targetNodeId: "queue:a:q1",
      reachableAncestorIds: ["exchange:a:x1", "shovel:a:s1", "external:remote/%2F/x%3Aremote"],
      paths: [
        {
          sourceNodeId: "external:remote/%2F/x%3Aremote",
          steps: [
            {
              edgeId: "shovel-in:s1<-ext",
              fromNodeId: "external:remote/%2F/x%3Aremote",
              toNodeId: "shovel:a:s1",
              kind: "shovels",
              label: "s1",
            },
            {
              edgeId: "shovel-out:s1->x1",
              fromNodeId: "shovel:a:s1",
              toNodeId: "exchange:a:x1",
              kind: "shovels",
              label: "s1",
            },
            {
              edgeId: "b:x1->q1",
              fromNodeId: "exchange:a:x1",
              toNodeId: "queue:a:q1",
              kind: "binds",
              routingKey: "orders.*",
            },
          ],
        },
      ],
      truncated: false,
      visitedCycles: [],
    };
    render(<PathExplanationPanel nodes={nodesWithExternal} traversal={traversal} />);
    const badge = screen.getByTestId(
      "path-explanation-upstream-item-0-unresolved",
    );
    expect(badge.textContent).toMatch(/Unresolved endpoint/i);
  });

  it("does NOT render the unresolved-endpoint badge for paths whose steps resolve to loaded brokers", () => {
    // Regression: the badge must not fire spuriously on ordinary
    // fully-resolved paths, or every chain in the topology would carry a
    // permanent "unresolved" warning that operators learn to ignore.
    const traversal: UpstreamTraversalResult = {
      targetNodeId: "queue:a:q1",
      reachableAncestorIds: ["exchange:a:x1"],
      paths: [
        {
          sourceNodeId: "exchange:a:x1",
          steps: [
            {
              edgeId: "b:x1->q1",
              fromNodeId: "exchange:a:x1",
              toNodeId: "queue:a:q1",
              kind: "binds",
              routingKey: "orders.*",
            },
          ],
        },
      ],
      truncated: false,
      visitedCycles: [],
    };
    render(<PathExplanationPanel nodes={nodes} traversal={traversal} />);
    expect(
      screen.queryByTestId("path-explanation-upstream-item-0-unresolved"),
    ).toBeNull();
  });

  it("surfaces a section-level unresolved-paths COUNT in the section header so operators can triage without scanning every path", () => {
    // Task 40 acceptance: "clearly report … unresolved links." The
    // per-path badge lets the operator spot ONE path; a section-level
    // count in the header answers "how many of my paths depend on
    // brokers the visualizer couldn't verify" at a glance.
    const external: GraphNode = {
      id: "external:remote/%2F/x%3Aremote",
      kind: "external",
      label: "exchange remote @ remote-broker//",
      data: {},
    };
    const shovel: GraphNode = {
      id: "shovel:a:s1",
      kind: "shovel",
      label: "s1",
      data: { name: "s1" },
    };
    const nodesWithExternal: GraphNode[] = [...nodes, external, shovel];
    const traversal: UpstreamTraversalResult = {
      targetNodeId: "queue:a:q1",
      reachableAncestorIds: [
        "exchange:a:x1",
        "exchange:a:x2",
        "shovel:a:s1",
        "external:remote/%2F/x%3Aremote",
      ],
      paths: [
        {
          // Path 1: fully-resolved binding chain, no external endpoint.
          sourceNodeId: "exchange:a:x1",
          steps: [
            {
              edgeId: "b:x1->q1",
              fromNodeId: "exchange:a:x1",
              toNodeId: "queue:a:q1",
              kind: "binds",
              routingKey: "a",
            },
          ],
        },
        {
          // Path 2: traverses the external → shovel → local exchange chain.
          sourceNodeId: "external:remote/%2F/x%3Aremote",
          steps: [
            {
              edgeId: "shovel-in:s1<-ext",
              fromNodeId: "external:remote/%2F/x%3Aremote",
              toNodeId: "shovel:a:s1",
              kind: "shovels",
              label: "s1",
            },
            {
              edgeId: "shovel-out:s1->x2",
              fromNodeId: "shovel:a:s1",
              toNodeId: "exchange:a:x2",
              kind: "shovels",
              label: "s1",
            },
            {
              edgeId: "b:x2->q1",
              fromNodeId: "exchange:a:x2",
              toNodeId: "queue:a:q1",
              kind: "binds",
              routingKey: "b",
            },
          ],
        },
      ],
      truncated: false,
      visitedCycles: [],
    };
    render(<PathExplanationPanel nodes={nodesWithExternal} traversal={traversal} />);
    const count = screen.getByTestId("path-explanation-upstream-count");
    // Total path count still first.
    expect(count.textContent).toMatch(/^2 paths/);
    // Section-level unresolved count reads "1 of 2 traverses an
    // unresolved external endpoint" — singular verb because 1 path.
    expect(count.textContent).toMatch(
      /1 of 2 traverses an unresolved external endpoint/,
    );
    // Regression: the per-path badge is still present on the affected
    // path (index 1) and absent from the fully-resolved path (index 0).
    expect(
      screen.queryByTestId("path-explanation-upstream-item-0-unresolved"),
    ).toBeNull();
    expect(
      screen.getByTestId("path-explanation-upstream-item-1-unresolved"),
    ).toBeTruthy();
  });

  it("uses PLURAL 'traverse' in the section-level count when multiple paths are unresolved", () => {
    const external: GraphNode = {
      id: "external:remote/%2F/x%3Aremote",
      kind: "external",
      label: "external",
      data: {},
    };
    const shovel: GraphNode = {
      id: "shovel:a:s1",
      kind: "shovel",
      label: "s1",
      data: { name: "s1" },
    };
    const nodesWithExternal: GraphNode[] = [...nodes, external, shovel];
    const mkExternalPath = (dstEdgeId: string, dstBindingKey: string, dstExchangeId: string): UpstreamTraversalResult["paths"][number] => ({
      sourceNodeId: "external:remote/%2F/x%3Aremote",
      steps: [
        {
          edgeId: `shovel-in:${dstEdgeId}`,
          fromNodeId: "external:remote/%2F/x%3Aremote",
          toNodeId: "shovel:a:s1",
          kind: "shovels",
          label: "s1",
        },
        {
          edgeId: `shovel-out:${dstEdgeId}`,
          fromNodeId: "shovel:a:s1",
          toNodeId: dstExchangeId,
          kind: "shovels",
          label: "s1",
        },
        {
          edgeId: `b:${dstEdgeId}`,
          fromNodeId: dstExchangeId,
          toNodeId: "queue:a:q1",
          kind: "binds",
          routingKey: dstBindingKey,
        },
      ],
    });
    const traversal: UpstreamTraversalResult = {
      targetNodeId: "queue:a:q1",
      reachableAncestorIds: [
        "exchange:a:x1",
        "exchange:a:x2",
        "shovel:a:s1",
        "external:remote/%2F/x%3Aremote",
      ],
      paths: [
        mkExternalPath("p1", "a", "exchange:a:x1"),
        mkExternalPath("p2", "b", "exchange:a:x2"),
      ],
      truncated: false,
      visitedCycles: [],
    };
    render(<PathExplanationPanel nodes={nodesWithExternal} traversal={traversal} />);
    const count = screen.getByTestId("path-explanation-upstream-count");
    expect(count.textContent).toMatch(
      /2 of 2 traverse an unresolved external endpoint/,
    );
    // Singular verb-form ("traverses") must not appear when count > 1.
    expect(count.textContent).not.toMatch(/traverses an unresolved/);
  });
});
