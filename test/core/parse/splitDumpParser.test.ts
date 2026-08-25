import { describe, expect, it } from "vitest";
import { parseSplitManagementDump } from "../../../src/core/parse/splitDumpParser";

describe("parseSplitManagementDump — combines per-shape files", () => {
  it("parses a full split dump equivalent to a single definitions export", () => {
    const r = parseSplitManagementDump({
      hostName: "rabbit-a",
      files: [
        { shape: "vhosts", json: [{ name: "/" }, { name: "orders" }] },
        {
          shape: "exchanges",
          json: [
            { name: "orders.in", vhost: "orders", type: "topic" },
            { name: "orders.audit", vhost: "orders", type: "fanout" },
          ],
        },
        {
          shape: "queues",
          json: [
            { name: "orders.incoming", vhost: "orders", durable: true },
            { name: "orders.audit", vhost: "orders", durable: true },
          ],
        },
        {
          shape: "bindings",
          json: [
            {
              source: "orders.in",
              vhost: "orders",
              destination: "orders.incoming",
              destination_type: "queue",
              routing_key: "orders.#",
            },
            {
              source: "orders.in",
              vhost: "orders",
              destination: "orders.audit",
              destination_type: "exchange",
              routing_key: "orders.*",
            },
          ],
        },
        {
          shape: "policies",
          json: [
            {
              vhost: "orders",
              name: "federate-orders",
              pattern: "^orders\\.",
              "apply-to": "exchanges",
              definition: { "federation-upstream-set": "all" },
            },
          ],
        },
        {
          shape: "parameters",
          json: [
            {
              vhost: "orders",
              component: "shovel",
              name: "s1",
              value: { "src-uri": "amqp://REDACTED@remote.example.internal" },
            },
          ],
        },
      ],
    });

    expect(r.host.name).toBe("rabbit-a");
    expect(r.vhosts.map((v) => v.name).sort()).toEqual(["/", "orders"]);
    expect(r.exchanges).toHaveLength(2);
    expect(r.queues).toHaveLength(2);
    expect(r.bindings).toHaveLength(2);
    expect(r.policies).toHaveLength(1);
    expect(r.rawParameters).toHaveLength(1);
    expect(r.diagnostics).toEqual([]);
  });

  it("accepts missing shapes and produces empty collections without diagnostics", () => {
    const r = parseSplitManagementDump({
      hostName: "rabbit-a",
      files: [
        { shape: "vhosts", json: [{ name: "/" }] },
        { shape: "queues", json: [{ name: "q1", vhost: "/" }] },
      ],
    });
    expect(r.queues).toHaveLength(1);
    expect(r.exchanges).toEqual([]);
    expect(r.bindings).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("records all provided sourceFileIds on the host", () => {
    const r = parseSplitManagementDump({
      hostName: "rabbit-a",
      files: [
        { shape: "vhosts", json: [{ name: "/" }], sourceFileId: "file:vhosts.json" },
        {
          shape: "exchanges",
          json: [{ name: "x", vhost: "/", type: "direct" }],
          sourceFileId: "file:exchanges.json",
        },
        {
          shape: "queues",
          json: [{ name: "q", vhost: "/" }],
          sourceFileId: "file:queues.json",
        },
      ],
    });
    expect(r.host.sourceFiles.sort()).toEqual([
      "file:exchanges.json",
      "file:queues.json",
      "file:vhosts.json",
    ]);
  });

  it("emits a diagnostic for a split-dump file whose payload is not an array", () => {
    const r = parseSplitManagementDump({
      hostName: "rabbit-a",
      files: [
        { shape: "vhosts", json: { not: "an-array" }, sourceFileId: "file:vhosts.json" },
        { shape: "queues", json: [{ name: "q", vhost: "/" }] },
      ],
    });
    expect(
      r.diagnostics.some(
        (d) => d.code === "split-dump.file-not-array" && d.sourceFileId === "file:vhosts.json",
      ),
    ).toBe(true);
    expect(r.queues).toHaveLength(1);
  });

  it("still emits binding-source-unresolved diagnostics across files", () => {
    const r = parseSplitManagementDump({
      hostName: "rabbit-a",
      files: [
        { shape: "vhosts", json: [{ name: "/" }] },
        { shape: "queues", json: [{ name: "q1", vhost: "/" }] },
        {
          shape: "bindings",
          json: [
            {
              source: "missing",
              vhost: "/",
              destination: "q1",
              destination_type: "queue",
              routing_key: "",
            },
          ],
        },
      ],
    });
    expect(r.bindings).toEqual([]);
    expect(
      r.diagnostics.some((d) => d.code === "definitions.binding-source-unresolved"),
    ).toBe(true);
  });

  it("returns an empty result when files list is empty (no crash)", () => {
    const r = parseSplitManagementDump({ hostName: "rabbit-a", files: [] });
    expect(r.vhosts).toEqual([]);
    expect(r.exchanges).toEqual([]);
    expect(r.queues).toEqual([]);
    expect(r.bindings).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });
});
