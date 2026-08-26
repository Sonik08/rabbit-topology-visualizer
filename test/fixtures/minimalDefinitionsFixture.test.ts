import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDefinitionsExport } from "../../src/core/parse/definitionsParser";
import { parseRuntimeParameters } from "../../src/core/parse/runtimeParameters";
import { buildGraph } from "../../src/core/graph/buildGraph";
import { upstreamForQueue } from "../../src/core/graph/traversal";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "minimal-definitions.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

/**
 * End-to-end fixture-driven coverage for the parser stack — asserts that every
 * shape called out in test/fixtures/README.md round-trips through
 * `parseDefinitionsExport → parseRuntimeParameters → buildGraph` with no
 * credential leaks, no unresolved-endpoint diagnostics, and the exact graph
 * relationships the fixture is documented to exercise.
 *
 * These tests would fail if a parser regressed on any of:
 *   - vhost enumeration (`/`, `orders`)
 *   - exchange-type parsing (direct/topic/fanout)
 *   - exchange→exchange binding (orders.in → orders.audit)
 *   - alternate-exchange arg extraction (orders.in → orders.unrouted)
 *   - dead-letter policy propagation to work.* queues
 *   - shovel/federation runtime-parameter parsing
 *   - AMQP-URI redaction on shovel/federation nodes
 */

describe("minimal-definitions.json fixture — parser round-trip", () => {
  const parsed = parseDefinitionsExport({ json: fixture, hostName: "example-host" });

  it("parses without error-severity diagnostics", () => {
    for (const d of parsed.diagnostics) {
      expect(d.severity, `unexpected error diagnostic ${d.code}: ${d.message}`).not.toBe("error");
    }
  });

  it("enumerates both vhosts documented in the fixture", () => {
    expect(parsed.vhosts.map((v) => v.name).sort()).toEqual(["/", "orders"]);
  });

  it("parses exchange types (direct, topic, fanout)", () => {
    const byName = new Map(parsed.exchanges.map((e) => [e.name, e]));
    expect(byName.get("work.direct")?.type).toBe("direct");
    expect(byName.get("orders.in")?.type).toBe("topic");
    expect(byName.get("work.dlx")?.type).toBe("fanout");
    expect(byName.get("orders.audit")?.type).toBe("fanout");
    expect(byName.get("orders.unrouted")?.type).toBe("fanout");
  });

  it("extracts the alternate-exchange argument on orders.in", () => {
    const ordersIn = parsed.exchanges.find((e) => e.name === "orders.in");
    expect(ordersIn?.alternateExchange).toBe("orders.unrouted");
  });

  it("preserves both queue-destination and exchange-destination bindings", () => {
    const kinds = parsed.bindings.map((b) => b.destinationType).sort();
    expect(kinds).toContain("queue");
    expect(kinds).toContain("exchange");
    // Specifically the exchange-to-exchange binding orders.in → orders.audit
    const e2e = parsed.bindings.find(
      (b) => b.destinationType === "exchange" && b.routingKey === "orders.*",
    );
    expect(e2e).toBeTruthy();
  });

  it("captures the dead-letter policy verbatim (policy application is a runtime concern)", () => {
    // The fixture models DLX via a policy rather than per-queue `x-dead-letter-*`
    // arguments. Our parser preserves the policy definition rather than
    // synthesizing per-queue DLX metadata (which is a RabbitMQ runtime step).
    const dlxPolicy = parsed.policies.find((p) => p.name === "dlx-default");
    expect(dlxPolicy).toBeTruthy();
    expect(dlxPolicy?.pattern).toBe("^work\\.");
    expect(dlxPolicy?.definition["dead-letter-exchange"]).toBe("work.dlx");
    expect(dlxPolicy?.definition["dead-letter-routing-key"]).toBe("dead");
    // Queues themselves carry no explicit x-dead-letter-* argument in the
    // fixture, so the parser leaves per-queue DLX metadata unset.
    const workJobs = parsed.queues.find((q) => q.name === "work.jobs");
    expect(workJobs?.deadLetterExchange).toBeUndefined();
  });

  it("keeps runtime parameter shapes (shovel + federation-upstream + set)", () => {
    const components = parsed.rawParameters.map((p) => p.component).sort();
    expect(components).toEqual(["federation-upstream", "shovel"]);
  });

  it("never surfaces raw AMQP credentials in any parsed field", () => {
    // Fixture uses `REDACTED@…` explicitly — assert the parsed side keeps
    // that shape and never contains a plausible user:pass@ substring.
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toMatch(/amqp:\/\/[^@:"\s]+:[^@:"\s]+@/);
  });
});

describe("minimal-definitions.json fixture — runtime parameters → graph", () => {
  const parsed = parseDefinitionsExport({ json: fixture, hostName: "example-host" });
  const runtime = parseRuntimeParameters({
    hostId: parsed.host.id,
    vhosts: parsed.vhosts,
    parameters: parsed.rawParameters,
  });

  it("materializes the shovel runtime parameter with sanitized endpoints", () => {
    expect(runtime.shovels).toHaveLength(1);
    const [shovel] = runtime.shovels;
    expect(shovel!.name).toBe("orders-shovel-from-remote-a");
    // Sanitized endpoints — source host hint present, credentials never leak.
    const serialized = JSON.stringify(shovel);
    expect(serialized).not.toMatch(/amqp:\/\/[^@:"\s]+:[^@:"\s]+@/);
    expect(serialized.toLowerCase()).toContain("remote-host-a.example.internal");
  });

  it("materializes the federation upstream with a redacted uri", () => {
    expect(runtime.federations).toHaveLength(1);
    const [fed] = runtime.federations;
    expect(fed!.name).toBe("orders-federation-upstream-b");
    const serialized = JSON.stringify(fed);
    expect(serialized).not.toMatch(/amqp:\/\/[^@:"\s]+:[^@:"\s]+@/);
    expect(serialized.toLowerCase()).toContain("remote-host-b.example.internal");
  });

  it("has no error-severity diagnostics from the runtime parameter parser", () => {
    for (const d of runtime.diagnostics) {
      expect(d.severity, `unexpected error diagnostic ${d.code}: ${d.message}`).not.toBe("error");
    }
  });
});

describe("minimal-definitions.json fixture — buildGraph end-to-end", () => {
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

  it("emits nodes for every kind exercised by the fixture", () => {
    const kinds = new Set(graph.nodes.map((n) => n.kind));
    for (const k of ["host", "vhost", "exchange", "queue", "shovel", "federation"] as const) {
      expect(kinds.has(k)).toBe(true);
    }
  });

  it("emits every edge kind the fixture is documented to exercise", () => {
    const kinds = new Set(graph.edges.map((e) => e.kind));
    // Documented in test/fixtures/README.md: alternate-exchange arg on
    // orders.in, exchange-to-exchange binding, shovel runtime parameter,
    // federation upstream (contributes `federates` edges to external node).
    for (const k of [
      "contains",
      "binds",
      "alternate-exchange",
      "shovels",
      "federates",
    ] as const) {
      expect(kinds.has(k), `missing edge kind ${k}`).toBe(true);
    }
  });

  it("upstream traversal from orders.incoming reaches orders.in via the topic binding", () => {
    const ordersIncoming = graph.nodes.find(
      (n) => n.kind === "queue" && n.label === "orders.incoming",
    );
    expect(ordersIncoming).toBeTruthy();
    const ordersInExchange = graph.nodes.find(
      (n) => n.kind === "exchange" && n.label === "orders.in",
    );
    expect(ordersInExchange).toBeTruthy();
    const result = upstreamForQueue(graph, ordersIncoming!.id);
    expect(result.reachableAncestorIds).toContain(ordersInExchange!.id);
    // The traversal must include at least one `binds` step (from orders.in
    // down to orders.incoming).
    const stepKinds = new Set(result.paths.flatMap((p) => p.steps.map((s) => s.kind)));
    expect(stepKinds.has("binds")).toBe(true);
  });

  it("emits a shovel node whose destination endpoint references orders.in (fixture routes shovel → orders.in)", () => {
    const shovelNode = graph.nodes.find((n) => n.kind === "shovel");
    expect(shovelNode).toBeTruthy();
    const serialized = JSON.stringify(shovelNode);
    // Fixture wires the shovel destination to exchange 'orders.in'.
    expect(serialized).toContain("orders.in");
    // And the shovel node data must never leak the raw amqp credentials.
    expect(serialized).not.toMatch(/amqp:\/\/[^@:"\s]+:[^@:"\s]+@/);
  });

  it("never leaks raw AMQP credentials through any node or edge", () => {
    const serialized = JSON.stringify({ nodes: graph.nodes, edges: graph.edges });
    expect(serialized).not.toMatch(/amqp:\/\/[^@:"\s]+:[^@:"\s]+@/);
  });
});
