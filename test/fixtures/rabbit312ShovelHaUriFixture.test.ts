import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDefinitionsExport } from "../../src/core/parse/definitionsParser";
import { parseRuntimeParameters } from "../../src/core/parse/runtimeParameters";
import { buildGraph } from "../../src/core/graph/buildGraph";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "rabbit-3.12-shovel-ha-uri.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

/**
 * Sanitized reproduction of the RabbitMQ 3.12.6 export shape that motivated
 * the shovel-HA-URI compatibility fix. The real production export cannot be
 * committed (it embeds credentials in every URI); this fixture preserves the
 * exact FAILING STRUCTURE — `parameters[*].value["src-uri"]` and `["dest-uri"]`
 * as JSON arrays — while every URI already reads `amqp://REDACTED@…`.
 *
 * If any of these assertions regress, the parser has fallen back to the
 * pre-fix behaviour where array-valued URIs were silently discarded.
 */

describe("rabbit-3.12 shovel HA URI fixture — parser round-trip", () => {
  const parsed = parseDefinitionsExport({ json: fixture, hostName: "rabbit-ha-prod" });

  it("parses the RabbitMQ 3.12.6 export shape without error-severity diagnostics", () => {
    for (const d of parsed.diagnostics) {
      expect(
        d.severity,
        `unexpected error diagnostic ${d.code}: ${d.message}`,
      ).not.toBe("error");
    }
  });

  it("captures both shovel runtime parameters (HA and mixed-shape) verbatim", () => {
    const shovelParams = parsed.rawParameters.filter((p) => p.component === "shovel");
    expect(shovelParams.map((p) => p.name).sort()).toEqual([
      "audit-shovel-mixed-shape",
      "orders-shovel-ha",
    ]);
  });
});

describe("rabbit-3.12 shovel HA URI fixture — runtime parameters", () => {
  const parsed = parseDefinitionsExport({ json: fixture, hostName: "rabbit-ha-prod" });
  const runtime = parseRuntimeParameters({
    hostId: parsed.host.id,
    vhosts: parsed.vhosts,
    parameters: parsed.rawParameters,
  });

  it("materialises the HA shovel with source/destination endpoints derived from the FIRST URI in each array", () => {
    const ha = runtime.shovels.find((s) => s.name === "orders-shovel-ha");
    expect(ha).toBeTruthy();
    // First entry in the HA list becomes the primary endpoint host/vhost.
    expect(ha!.source.host).toBe("primary.example.internal");
    expect(ha!.source.vhost).toBe("orders");
    expect(ha!.destination.host).toBe("local-a.example.internal");
    expect(ha!.destination.vhost).toBe("orders");
  });

  it("preserves the alternate HA URIs (redacted) in Shovel.arguments so the operator can still see the failover list", () => {
    const ha = runtime.shovels.find((s) => s.name === "orders-shovel-ha")!;
    const args = ha.arguments as Record<string, unknown>;
    expect(Array.isArray(args["src-uri"])).toBe(true);
    expect(args["src-uri"]).toEqual([
      "amqp://REDACTED@primary.example.internal:5672/orders",
      "amqp://REDACTED@backup.example.internal:5672/orders",
    ]);
    expect(args["dest-uri"]).toEqual([
      "amqp://REDACTED@local-a.example.internal:5672/orders",
      "amqp://REDACTED@local-b.example.internal:5672/orders",
    ]);
  });

  it("handles mixed shape (scalar src-uri + single-entry dest-uri array) without regression", () => {
    const mixed = runtime.shovels.find((s) => s.name === "audit-shovel-mixed-shape");
    expect(mixed).toBeTruthy();
    expect(mixed!.source.host).toBe("single.example.internal");
    expect(mixed!.destination.host).toBe("dest-only-ha.example.internal");
  });

  it("emits no shovel-uri-empty-list / -invalid-list / -mixed-list diagnostics on the clean HA payload", () => {
    const codes = new Set(runtime.diagnostics.map((d) => d.code));
    expect(codes.has("runtime-params.shovel-uri-empty-list")).toBe(false);
    expect(codes.has("runtime-params.shovel-uri-invalid-list")).toBe(false);
    expect(codes.has("runtime-params.shovel-uri-mixed-list")).toBe(false);
  });

  it("never leaks raw AMQP credentials through any parsed shovel", () => {
    const serialized = JSON.stringify(runtime.shovels);
    expect(serialized).not.toMatch(/amqp:\/\/[^@:"\s]+:[^@:"\s]+@/);
  });
});

describe("rabbit-3.12 shovel HA URI fixture — buildGraph end-to-end", () => {
  const parsed = parseDefinitionsExport({ json: fixture, hostName: "rabbit-ha-prod" });
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

  it("emits a shovel node for every HA-URI runtime parameter (regression: pre-fix pipeline dropped these silently)", () => {
    const shovelNodes = graph.nodes.filter((n) => n.kind === "shovel");
    expect(shovelNodes).toHaveLength(2);
  });

  it("never leaks raw AMQP credentials through any node or edge", () => {
    const serialized = JSON.stringify({ nodes: graph.nodes, edges: graph.edges });
    expect(serialized).not.toMatch(/amqp:\/\/[^@:"\s]+:[^@:"\s]+@/);
    // Positive check — the sanitized hostnames DO survive so the graph still
    // encodes remote endpoint context for the operator.
    expect(serialized).toContain("primary.example.internal");
    expect(serialized).toContain("local-a.example.internal");
  });
});
