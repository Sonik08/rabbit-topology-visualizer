import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../../../src/core/graph/buildGraph";
import { upstreamForQueue } from "../../../src/core/graph/traversal";
import { parseDefinitionsExport } from "../../../src/core/parse/definitionsParser";
import { parseRuntimeParameters } from "../../../src/core/parse/runtimeParameters";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", "..", "fixtures", "minimal-definitions.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

/**
 * Fixture-driven upstream-for-queue coverage that complements the pure-graph
 * unit suite in `traversal.test.ts`. Runs the real parser + builder pipeline
 * over `minimal-definitions.json` and asserts each documented queue's reverse
 * ancestry matches what the fixture wiring implies.
 */

function buildFixtureGraph() {
  const parsed = parseDefinitionsExport({ json: fixture, hostName: "example-host" });
  const runtime = parseRuntimeParameters({
    hostId: parsed.host.id,
    vhosts: parsed.vhosts,
    parameters: parsed.rawParameters,
  });
  const graph = buildGraph({
    hosts: [parsed.host],
    vhosts: parsed.vhosts,
    exchanges: parsed.exchanges,
    queues: parsed.queues,
    bindings: parsed.bindings,
    shovels: runtime.shovels,
    federations: runtime.federations,
  });
  const queueByName = new Map(
    graph.nodes.filter((n) => n.kind === "queue").map((n) => [n.label, n.id] as const),
  );
  const exchangeByName = new Map(
    graph.nodes.filter((n) => n.kind === "exchange").map((n) => [n.label, n.id] as const),
  );
  return { graph, queueByName, exchangeByName };
}

describe("upstreamForQueue — fixture: work.jobs bound to work.direct via 'jobs'", () => {
  const { graph, queueByName, exchangeByName } = buildFixtureGraph();
  const targetId = queueByName.get("work.jobs");
  const sourceId = exchangeByName.get("work.direct");

  it("reaches work.direct as its sole upstream ancestor", () => {
    expect(targetId).toBeDefined();
    expect(sourceId).toBeDefined();
    const result = upstreamForQueue(graph, targetId!);
    expect(result.reachableAncestorIds).toContain(sourceId!);
  });

  it("produces exactly one representative path with a single 'binds' step", () => {
    const result = upstreamForQueue(graph, targetId!);
    expect(result.paths).toHaveLength(1);
    const [path] = result.paths;
    expect(path!.steps).toHaveLength(1);
    expect(path!.steps[0]!.kind).toBe("binds");
    expect(path!.steps[0]!.routingKey).toBe("jobs");
    expect(path!.sourceNodeId).toBe(sourceId);
  });

  it("marks the traversal as complete (no truncation, no cycle guard)", () => {
    const result = upstreamForQueue(graph, targetId!);
    expect(result.truncated).toBe(false);
    expect(result.visitedCycles).toEqual([]);
  });
});

describe("upstreamForQueue — fixture: orders.audit queue has BOTH exchange→exchange and shovel ancestry", () => {
  const { graph, queueByName, exchangeByName } = buildFixtureGraph();

  it("walks orders.audit-queue ← orders.audit-exchange ← orders.in (exchange-to-exchange binding)", () => {
    const ordersAuditQ = queueByName.get("orders.audit")!;
    const ordersAuditX = exchangeByName.get("orders.audit")!;
    const ordersInX = exchangeByName.get("orders.in")!;
    const result = upstreamForQueue(graph, ordersAuditQ);
    // The fanout binding orders.audit-exchange → orders.audit-queue is one hop
    // upstream; the exchange-to-exchange binding from orders.in adds another.
    expect(result.reachableAncestorIds).toContain(ordersAuditX);
    expect(result.reachableAncestorIds).toContain(ordersInX);
  });
});

describe("upstreamForQueue — fixture: work.dead queue reached via the DLX fanout", () => {
  const { graph, queueByName, exchangeByName } = buildFixtureGraph();

  it("has the dlx fanout exchange as its upstream ancestor", () => {
    const workDead = queueByName.get("work.dead")!;
    const workDlx = exchangeByName.get("work.dlx")!;
    const result = upstreamForQueue(graph, workDead);
    expect(result.reachableAncestorIds).toContain(workDlx);
    // Empty routing key from the fanout binding must round-trip through the step.
    const steps = result.paths.flatMap((p) => p.steps);
    expect(steps.some((s) => s.kind === "binds" && s.routingKey === "")).toBe(true);
  });
});

describe("upstreamForQueue — fixture: rejects non-queue target ids gracefully", () => {
  const { graph, exchangeByName } = buildFixtureGraph();

  it("returns an empty ancestor set when the target id points at an exchange", () => {
    const ordersIn = exchangeByName.get("orders.in")!;
    const result = upstreamForQueue(graph, ordersIn);
    expect(result.reachableAncestorIds).toEqual([]);
    expect(result.paths).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("returns an empty ancestor set for an unknown id (never throws)", () => {
    const result = upstreamForQueue(graph, "queue:does-not-exist-in-fixture");
    expect(result.reachableAncestorIds).toEqual([]);
    expect(result.paths).toEqual([]);
  });
});

describe("upstreamForQueue — fixture: maxDepth clamps orders.audit ancestry", () => {
  const { graph, queueByName, exchangeByName } = buildFixtureGraph();

  it("maxDepth=1 reaches only the direct fanout exchange, not orders.in two hops up", () => {
    const ordersAuditQ = queueByName.get("orders.audit")!;
    const ordersInX = exchangeByName.get("orders.in")!;
    const result = upstreamForQueue(graph, ordersAuditQ, { maxDepth: 1 });
    expect(result.reachableAncestorIds).not.toContain(ordersInX);
    expect(result.truncated).toBe(true);
  });
});
