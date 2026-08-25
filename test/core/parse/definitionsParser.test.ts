import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDefinitionsExport } from "../../../src/core/parse/definitionsParser";
import { parseRuntimeParameters } from "../../../src/core/parse/runtimeParameters";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", "..", "fixtures", "minimal-definitions.json");
const fixtureJson = JSON.parse(readFileSync(fixturePath, "utf-8"));
const USER_PLACEHOLDER = "USERNAME_PLACEHOLDER";
const PASSWORD_PLACEHOLDER = "PASSWORD_PLACEHOLDER";

describe("parseDefinitionsExport — fixture", () => {
  const result = parseDefinitionsExport({
    json: fixtureJson,
    hostName: "rabbit-a",
    sourceFileId: "file:test",
  });

  it("creates a Host with cluster hint from global_parameters", () => {
    expect(result.host.name).toBe("rabbit-a");
    expect(result.host.clusterName).toBe("example-cluster-local");
    expect(result.host.sourceFiles).toEqual(["file:test"]);
  });

  it("preserves both vhosts", () => {
    expect(result.vhosts.map((v) => v.name).sort()).toEqual(["/", "orders"]);
  });

  it("parses all five exchanges", () => {
    expect(result.exchanges).toHaveLength(5);
    const ordersIn = result.exchanges.find((e) => e.name === "orders.in");
    expect(ordersIn?.type).toBe("topic");
    expect(ordersIn?.alternateExchange).toBe("orders.unrouted");
  });

  it("parses all four queues", () => {
    expect(result.queues).toHaveLength(4);
    const names = result.queues.map((q) => q.name).sort();
    expect(names).toEqual(["orders.audit", "orders.incoming", "work.dead", "work.jobs"]);
  });

  it("resolves all bindings to internal entity ids and preserves e2e vs e2q", () => {
    expect(result.bindings).toHaveLength(5);
    const kinds = result.bindings.map((b) => b.destinationType).sort();
    expect(kinds).toEqual(["exchange", "queue", "queue", "queue", "queue"]);
    for (const b of result.bindings) {
      expect(b.sourceExchangeId.startsWith("exchange:")).toBe(true);
      expect(b.destinationId.length).toBeGreaterThan(0);
    }
  });

  it("preserves both policies", () => {
    expect(result.policies).toHaveLength(2);
    const federate = result.policies.find((p) => p.name === "federate-orders-exchanges");
    expect(federate?.appliesTo).toBe("exchanges");
    expect(federate?.definition["federation-upstream-set"]).toBe("all");
  });

  it("keeps raw parameters for downstream shovel/federation parser", () => {
    expect(result.rawParameters).toHaveLength(2);
    const components = result.rawParameters.map((p) => p.component).sort();
    expect(components).toEqual(["federation-upstream", "shovel"]);
  });

  it("redacts AMQP credentials before parameters can be serialized", () => {
    const r = parseDefinitionsExport({
      json: {
        parameters: [
          {
            vhost: "/",
            component: "shovel",
            name: "safe-serialization",
            value: {
              "src-uri": `amqp://${USER_PLACEHOLDER}:${PASSWORD_PLACEHOLDER}@remote.example.internal/orders`,
              nested: {
                uri: `amqps://${USER_PLACEHOLDER}:${PASSWORD_PLACEHOLDER}@nested.example.internal/orders`,
              },
            },
          },
        ],
      },
    });

    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(USER_PLACEHOLDER);
    expect(serialized).not.toContain(PASSWORD_PLACEHOLDER);
    expect(r.rawParameters[0]?.value["src-uri"]).toBe(
      "amqp://REDACTED@remote.example.internal/orders",
    );
    expect(serialized).toContain("amqps://REDACTED@nested.example.internal/orders");
  });

  it("preserves array-valued federation upstream sets for runtime parsing", () => {
    const parsed = parseDefinitionsExport({
      json: {
        vhosts: [{ name: "/" }],
        parameters: [
          {
            vhost: "/",
            component: "federation-upstream-set",
            name: "all",
            value: [{ upstream: "remote-a" }, { upstream: "remote-b" }],
          },
        ],
      },
      hostName: "rabbit-a",
    });
    const runtime = parseRuntimeParameters({
      hostId: parsed.host.id,
      vhosts: parsed.vhosts,
      parameters: parsed.rawParameters,
    });

    expect(runtime.federationUpstreamSets).toHaveLength(1);
    expect(runtime.federationUpstreamSets[0]?.upstreams).toEqual([
      "remote-a",
      "remote-b",
    ]);
  });

  it("produces no diagnostics for the sanitized fixture", () => {
    expect(result.diagnostics).toEqual([]);
  });
});

describe("parseDefinitionsExport — malformed input", () => {
  it("returns an error diagnostic when json is not an object", () => {
    const r = parseDefinitionsExport({ json: "not-an-object" });
    expect(r.diagnostics[0]?.code).toBe("definitions.not-an-object");
    expect(r.vhosts).toEqual([]);
    expect(r.exchanges).toEqual([]);
  });

  it("skips a vhost entry without a name and records a diagnostic", () => {
    const r = parseDefinitionsExport({
      json: { vhosts: [{ name: "/" }, { notName: 1 }] },
    });
    expect(r.vhosts.map((v) => v.name)).toEqual(["/"]);
    expect(r.diagnostics.some((d) => d.code === "definitions.vhost-missing-name")).toBe(true);
  });

  it("infers a missing vhost when an exchange references it", () => {
    const r = parseDefinitionsExport({
      json: {
        vhosts: [{ name: "/" }],
        exchanges: [{ name: "x1", vhost: "other", type: "direct" }],
      },
    });
    expect(r.vhosts.map((v) => v.name).sort()).toEqual(["/", "other"]);
    expect(
      r.diagnostics.some((d) => d.code === "definitions.vhost-inferred"),
    ).toBe(true);
  });

  it("skips a binding when its source exchange is missing", () => {
    const r = parseDefinitionsExport({
      json: {
        vhosts: [{ name: "/" }],
        exchanges: [{ name: "x1", vhost: "/", type: "direct" }],
        queues: [{ name: "q1", vhost: "/" }],
        bindings: [
          {
            source: "not-there",
            vhost: "/",
            destination: "q1",
            destination_type: "queue",
            routing_key: "",
          },
        ],
      },
    });
    expect(r.bindings).toEqual([]);
    expect(
      r.diagnostics.some((d) => d.code === "definitions.binding-source-unresolved"),
    ).toBe(true);
  });

  it("skips a binding with an unknown destination_type", () => {
    const r = parseDefinitionsExport({
      json: {
        vhosts: [{ name: "/" }],
        exchanges: [{ name: "x1", vhost: "/", type: "direct" }],
        bindings: [
          {
            source: "x1",
            vhost: "/",
            destination: "x1",
            destination_type: "spooky",
            routing_key: "",
          },
        ],
      },
    });
    expect(r.bindings).toEqual([]);
    expect(
      r.diagnostics.some(
        (d) => d.code === "definitions.binding-unknown-destination-type",
      ),
    ).toBe(true);
  });

  it("detects duplicate exchange names in the same vhost", () => {
    const r = parseDefinitionsExport({
      json: {
        vhosts: [{ name: "/" }],
        exchanges: [
          { name: "x1", vhost: "/", type: "direct" },
          { name: "x1", vhost: "/", type: "fanout" },
        ],
      },
    });
    expect(r.exchanges).toHaveLength(1);
    expect(
      r.diagnostics.some((d) => d.code === "definitions.exchange-duplicate"),
    ).toBe(true);
  });

  it("extracts dead-letter args from queue arguments", () => {
    const r = parseDefinitionsExport({
      json: {
        vhosts: [{ name: "/" }],
        queues: [
          {
            name: "work.jobs",
            vhost: "/",
            arguments: {
              "x-dead-letter-exchange": "work.dlx",
              "x-dead-letter-routing-key": "dead",
            },
          },
        ],
      },
    });
    expect(r.queues[0]?.deadLetterExchange).toBe("work.dlx");
    expect(r.queues[0]?.deadLetterRoutingKey).toBe("dead");
  });
});
