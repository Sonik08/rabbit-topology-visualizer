import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDefinitionsExport } from "../../src/core/parse/definitionsParser";
import { parseRuntimeParameters } from "../../src/core/parse/runtimeParameters";
import { buildGraph } from "../../src/core/graph/buildGraph";

const here = dirname(fileURLToPath(import.meta.url));

function load(fileName: string): unknown {
  return JSON.parse(readFileSync(resolve(here, fileName), "utf-8"));
}

/**
 * Cross-version regression: RabbitMQ definitions exports drift schema between
 * releases, and this test pins that the parser + graph pipeline tolerate a
 * "legacy 3.8" shape (scalar shovel URIs, `tags` as a string) AND a "current
 * 4.x" shape (rich vhost metadata: `description`, `tags` array,
 * `default_queue_type`, and a nested `metadata` object) alongside the anchor
 * 3.12.6 HA-URI fixture, without regressing on either.
 */

describe("RabbitMQ 3.8 legacy export shape — parser + graph round-trip", () => {
  const parsed = parseDefinitionsExport({
    json: load("rabbit-3.8-legacy.json") as never,
    hostName: "rabbit-legacy",
  });
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

  it("parses the 3.8.35 shape without error-severity diagnostics", () => {
    for (const d of [...parsed.diagnostics, ...runtime.diagnostics]) {
      expect(
        d.severity,
        `unexpected error diagnostic ${d.code}: ${d.message}`,
      ).not.toBe("error");
    }
  });

  it("enumerates both vhosts and reads legacy exchange/queue/binding shapes", () => {
    expect(parsed.vhosts.map((v) => v.name).sort()).toEqual(["/", "legacy"]);
    expect(parsed.exchanges.map((e) => e.name).sort()).toEqual([
      "legacy.in",
      "legacy.out",
    ]);
    expect(parsed.bindings).toHaveLength(1);
  });

  it("resolves the scalar-URI shovel to a redacted endpoint (no HA fallback needed)", () => {
    expect(runtime.shovels).toHaveLength(1);
    const shovel = runtime.shovels[0]!;
    expect(shovel.source.host).toBe("remote-legacy.example.internal");
    expect(shovel.destination.host).toBe("local-legacy.example.internal");
    const serialised = JSON.stringify(shovel);
    expect(serialised).not.toMatch(/amqp:\/\/[^@:"\s]+:[^@:"\s]+@/);
  });

  it("emits nodes for host/vhost/exchange/queue/shovel — the graph pipeline handles legacy shapes end-to-end", () => {
    const kinds = new Set(graph.nodes.map((n) => n.kind));
    for (const k of ["host", "vhost", "exchange", "queue", "shovel"] as const) {
      expect(kinds.has(k)).toBe(true);
    }
  });
});

describe("RabbitMQ 4.0 current export shape — parser + graph round-trip", () => {
  const parsed = parseDefinitionsExport({
    json: load("rabbit-4.0-current.json") as never,
    hostName: "rabbit-current",
  });
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

  it("tolerates additive 4.x vhost fields (`description`, `tags`, `default_queue_type`, `metadata`) without warnings on those fields", () => {
    // We do not surface a diagnostic for additive vhost fields; the parser
    // reads only what it consumes (`name`) and leaves the rest alone. This
    // pins that RabbitMQ can add future vhost properties without breaking us.
    const relevant = parsed.diagnostics.filter(
      (d) => d.code.startsWith("definitions.vhost-"),
    );
    expect(relevant).toEqual([]);
    // But it still enumerates both vhosts.
    expect(parsed.vhosts.map((v) => v.name).sort()).toEqual(["/", "billing"]);
  });

  it("parses quorum-typed queues (4.x default) end-to-end", () => {
    const billingIn = parsed.queues.find((q) => q.name === "billing.in")!;
    expect(billingIn.arguments?.["x-queue-type"]).toBe("quorum");
  });

  it("resolves the shovel with HA `src-uri` array + scalar `dest-uri` on the 4.x shape", () => {
    expect(runtime.shovels).toHaveLength(1);
    const shovel = runtime.shovels[0]!;
    // First URI in the HA array wins for the source endpoint.
    expect(shovel.source.host).toBe("current-primary.example.internal");
    // Scalar dest-uri still works.
    expect(shovel.destination.host).toBe("current-local.example.internal");
    // Alternate HA URI preserved (redacted) in arguments.
    const args = shovel.arguments as Record<string, unknown>;
    expect(args["src-uri"]).toEqual([
      "amqp://REDACTED@current-primary.example.internal:5672/billing",
      "amqp://REDACTED@current-backup.example.internal:5672/billing",
    ]);
  });

  it("emits no error-severity diagnostics and never leaks credentials in the resulting graph", () => {
    for (const d of [...parsed.diagnostics, ...runtime.diagnostics]) {
      expect(d.severity).not.toBe("error");
    }
    const serialised = JSON.stringify({ nodes: graph.nodes, edges: graph.edges });
    expect(serialised).not.toMatch(/amqp:\/\/[^@:"\s]+:[^@:"\s]+@/);
    // Sanitized hostnames survive so the graph still encodes remote context.
    expect(serialised).toContain("current-primary.example.internal");
  });
});
