import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyJson } from "../../../src/core/parse/jsonClassifier";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", "..", "fixtures", "minimal-definitions.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

describe("classifyJson — definitions", () => {
  it("classifies a real definitions export via rabbit_version + structural fields", () => {
    const result = classifyJson(fixture, "some/path/definitions.json");
    expect(result.shape).toBe("definitions");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.reasons.some((r) => r.includes("rabbit_version"))).toBe(true);
  });

  it("classifies a bare definitions object with only structural fields", () => {
    const result = classifyJson({
      vhosts: [],
      exchanges: [],
      queues: [],
      bindings: [],
    });
    expect(result.shape).toBe("definitions");
  });

  it("uses filename hint to accept a definitions export even without strong content signals", () => {
    const result = classifyJson({ rabbit_version: "3.12.0" }, "definitions.json");
    expect(result.shape).toBe("definitions");
    expect(result.confidence).toBeGreaterThan(0);
  });
});

describe("classifyJson — split management dumps by filename", () => {
  it("uses filename hint for empty arrays", () => {
    for (const [name, shape] of [
      ["queues.json", "management-dump-queues"],
      ["exchanges.json", "management-dump-exchanges"],
      ["bindings.json", "management-dump-bindings"],
      ["parameters.json", "management-dump-parameters"],
      ["policies.json", "management-dump-policies"],
      ["vhosts.json", "management-dump-vhosts"],
    ] as const) {
      const result = classifyJson([], name);
      expect(result.shape, `filename ${name}`).toBe(shape);
    }
  });
});

describe("classifyJson — split management dumps by content", () => {
  it("detects queues array without filename", () => {
    const result = classifyJson([
      { name: "q.a", vhost: "/", durable: true },
      { name: "q.b", vhost: "/", durable: false },
    ]);
    expect(result.shape).toBe("management-dump-queues");
  });

  it("detects exchanges array by presence of type + name", () => {
    const result = classifyJson([
      { name: "x.a", vhost: "/", type: "topic" },
      { name: "x.b", vhost: "/", type: "fanout" },
    ]);
    expect(result.shape).toBe("management-dump-exchanges");
  });

  it("detects bindings array by source/destination/destination_type", () => {
    const result = classifyJson([
      {
        source: "x.a",
        vhost: "/",
        destination: "q.a",
        destination_type: "queue",
        routing_key: "k",
      },
    ]);
    expect(result.shape).toBe("management-dump-bindings");
  });

  it("detects parameters array by component + value", () => {
    const result = classifyJson([
      { component: "shovel", name: "s1", vhost: "/", value: { "src-uri": "amqp://REDACTED@h" } },
    ]);
    expect(result.shape).toBe("management-dump-parameters");
  });

  it("detects policies array by pattern + apply-to + definition", () => {
    const result = classifyJson([
      {
        vhost: "/",
        name: "p1",
        pattern: "^orders\\.",
        "apply-to": "exchanges",
        definition: { "federation-upstream-set": "all" },
      },
    ]);
    expect(result.shape).toBe("management-dump-policies");
  });

  it("detects vhosts array by minimal { name } shape", () => {
    const result = classifyJson([{ name: "/" }, { name: "orders" }]);
    expect(result.shape).toBe("management-dump-vhosts");
  });
});

describe("classifyJson — unknown and ambiguous", () => {
  it("returns unknown for scalars", () => {
    expect(classifyJson("hello").shape).toBe("unknown");
    expect(classifyJson(42).shape).toBe("unknown");
    expect(classifyJson(null).shape).toBe("unknown");
  });

  it("returns unknown for an object without any known shape", () => {
    expect(classifyJson({ arbitrary: true }).shape).toBe("unknown");
  });

  it("returns unknown for an empty array without a filename hint", () => {
    expect(classifyJson([]).shape).toBe("unknown");
  });
});

describe("classifyJson — path host/vhost hints", () => {
  it("extracts host and vhost from nested paths", () => {
    const result = classifyJson([{ name: "/" }], "hosts/rabbit-a/vhosts/orders/vhosts.json");
    expect(result.hostHint).toBe("rabbit-a");
    expect(result.vhostHint).toBe("orders");
    expect(result.shape).toBe("management-dump-vhosts");
  });

  it("returns no hints when path has no host/vhost segments", () => {
    const result = classifyJson(fixture, "definitions.json");
    expect(result.hostHint).toBeUndefined();
    expect(result.vhostHint).toBeUndefined();
  });
});
