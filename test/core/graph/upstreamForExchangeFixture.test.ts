import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../../../src/core/graph/buildGraph";
import { upstreamForExchange } from "../../../src/core/graph/traversal";
import { parseDefinitionsExport } from "../../../src/core/parse/definitionsParser";
import { parseRuntimeParameters } from "../../../src/core/parse/runtimeParameters";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", "..", "fixtures", "minimal-definitions.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

/**
 * Fixture-driven coverage that complements the pure-graph unit suite in
 * `upstreamForExchange.test.ts`. Drives the real parser + builder pipeline
 * over `minimal-definitions.json` and asserts each documented exchange's
 * reverse ancestry matches what the fixture wiring implies — including the
 * exchange-to-exchange binding (`orders.in → orders.audit`) that is the
 * canonical exchange-target traversal scenario.
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
  const exchangeByName = new Map(
    graph.nodes.filter((n) => n.kind === "exchange").map((n) => [n.label, n.id] as const),
  );
  const queueByName = new Map(
    graph.nodes.filter((n) => n.kind === "queue").map((n) => [n.label, n.id] as const),
  );
  return { graph, exchangeByName, queueByName };
}

describe("upstreamForExchange — fixture: orders.audit-exchange has orders.in upstream via e2e binding", () => {
  const { graph, exchangeByName } = buildFixtureGraph();
  const ordersAuditX = exchangeByName.get("orders.audit")!;
  const ordersInX = exchangeByName.get("orders.in")!;

  it("orders.in appears as an upstream ancestor of orders.audit-exchange", () => {
    const result = upstreamForExchange(graph, ordersAuditX);
    expect(result.reachableAncestorIds).toContain(ordersInX);
  });

  it("the representative path from orders.in to orders.audit is exactly one 'binds' step with routing key 'orders.*'", () => {
    const result = upstreamForExchange(graph, ordersAuditX);
    const inPath = result.paths.find((p) => p.sourceNodeId === ordersInX);
    expect(inPath).toBeDefined();
    expect(inPath!.steps).toHaveLength(1);
    expect(inPath!.steps[0]!.kind).toBe("binds");
    expect(inPath!.steps[0]!.routingKey).toBe("orders.*");
  });

  it("the traversal completes without truncation or cycle witnesses", () => {
    const result = upstreamForExchange(graph, ordersAuditX);
    expect(result.truncated).toBe(false);
    expect(result.visitedCycles).toEqual([]);
  });
});

describe("upstreamForExchange — fixture: orders.unrouted has orders.in upstream via alternate-exchange", () => {
  const { graph, exchangeByName } = buildFixtureGraph();
  const ordersUnrouted = exchangeByName.get("orders.unrouted")!;
  const ordersInX = exchangeByName.get("orders.in")!;

  it("orders.in appears as an upstream ancestor because orders.in.alternate-exchange = orders.unrouted", () => {
    const result = upstreamForExchange(graph, ordersUnrouted);
    expect(result.reachableAncestorIds).toContain(ordersInX);
    const stepKinds = new Set(result.paths.flatMap((p) => p.steps.map((s) => s.kind)));
    expect(stepKinds.has("alternate-exchange")).toBe(true);
  });
});

describe("upstreamForExchange — fixture: orders.in traversal is a self-source (no in-project upstream)", () => {
  const { graph, exchangeByName } = buildFixtureGraph();

  it("orders.in has no in-project upstream exchange (fixture wires it only as a downstream target of e2e/alt bindings)", () => {
    const ordersInX = exchangeByName.get("orders.in")!;
    const result = upstreamForExchange(graph, ordersInX);
    // The fixture shovel's `dest-uri` points at localhost which does not
    // resolve to any loaded host, so the shovel routes to an external node
    // rather than back into orders.in — the in-project reverse traversal
    // therefore terminates at orders.in itself with an empty ancestor set.
    expect(result.reachableAncestorIds).toEqual([]);
    expect(result.paths).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe("upstreamForExchange — fixture: target-kind guard", () => {
  const { graph, queueByName } = buildFixtureGraph();

  it("returns an empty ancestor set when the target id is a queue node", () => {
    const workJobs = queueByName.get("work.jobs")!;
    const result = upstreamForExchange(graph, workJobs);
    expect(result.reachableAncestorIds).toEqual([]);
    expect(result.paths).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("returns an empty ancestor set for an unknown exchange id (never throws)", () => {
    const result = upstreamForExchange(graph, "exchange:does-not-exist-in-fixture");
    expect(result.reachableAncestorIds).toEqual([]);
    expect(result.paths).toEqual([]);
  });
});

describe("upstreamForExchange — fixture: root publisher exchange has no upstream", () => {
  const { graph, exchangeByName } = buildFixtureGraph();

  it("work.direct has no upstream exchange ancestry (it is only bound to by queues, never from)", () => {
    const workDirect = exchangeByName.get("work.direct")!;
    const result = upstreamForExchange(graph, workDirect);
    // No routing edges point INTO work.direct in the fixture, so it is its
    // own source with no ancestors.
    expect(result.reachableAncestorIds).toEqual([]);
    expect(result.paths).toEqual([]);
  });
});
