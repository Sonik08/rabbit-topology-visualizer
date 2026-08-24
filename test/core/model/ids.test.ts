import { describe, expect, it } from "vitest";
import {
  bindingId,
  canonicalArgsSignature,
  exchangeId,
  federationId,
  hostId,
  policyId,
  queueId,
  shovelId,
  sourceFileId,
  vhostId,
} from "../../../src/core/model/ids";

describe("hostId", () => {
  it("lowercases and encodes host names", () => {
    expect(hostId("Rabbit-01.example.internal")).toBe(
      "host:rabbit-01.example.internal",
    );
  });

  it("collapses blank/missing host to a reserved sentinel", () => {
    expect(hostId(undefined)).toBe("host:__unknown_host__");
    expect(hostId(null)).toBe("host:__unknown_host__");
    expect(hostId("   ")).toBe("host:__unknown_host__");
  });

  it("percent-encodes unsafe characters", () => {
    expect(hostId("host with space")).toBe("host:host%20with%20space");
  });
});

describe("vhostId", () => {
  it("nests under the host id", () => {
    const h = hostId("rabbit-a");
    expect(vhostId(h, "orders")).toBe("vhost:host:rabbit-a/orders");
  });

  it("defaults empty/missing vhost name to '/'", () => {
    const h = hostId("rabbit-a");
    expect(vhostId(h, undefined)).toBe("vhost:host:rabbit-a/%2F");
    expect(vhostId(h, "")).toBe("vhost:host:rabbit-a/%2F");
  });
});

describe("exchange/queue/shovel/federation/policy ids", () => {
  const h = hostId("rabbit-a");
  const v = vhostId(h, "orders");

  it("produces distinct kind-prefixed ids with the same name", () => {
    const ex = exchangeId(v, "orders.in");
    const q = queueId(v, "orders.in");
    const sh = shovelId(v, "orders.in");
    const fed = federationId(v, "orders.in");
    const pol = policyId(v, "orders.in");

    expect(new Set([ex, q, sh, fed, pol]).size).toBe(5);
    expect(ex.startsWith("exchange:")).toBe(true);
    expect(q.startsWith("queue:")).toBe(true);
    expect(sh.startsWith("shovel:")).toBe(true);
    expect(fed.startsWith("federation:")).toBe(true);
    expect(pol.startsWith("policy:")).toBe(true);
  });

  it("encodes special characters inside entity names", () => {
    expect(exchangeId(v, "orders/in")).toContain("orders%2Fin");
    expect(queueId(v, "orders in")).toContain("orders%20in");
  });
});

describe("sourceFileId", () => {
  it("encodes the file path", () => {
    expect(sourceFileId("hosts/rabbit-a/definitions.json")).toBe(
      "file:hosts%2Frabbit-a%2Fdefinitions.json",
    );
  });
});

describe("bindingId", () => {
  const h = hostId("rabbit-a");
  const v = vhostId(h, "orders");
  const src = exchangeId(v, "orders.in");
  const dest = queueId(v, "orders.incoming");

  it("changes when routing key changes", () => {
    const a = bindingId({
      vhost: v,
      sourceExchange: src,
      destination: dest,
      destinationType: "queue",
      routingKey: "orders.new",
    });
    const b = bindingId({
      vhost: v,
      sourceExchange: src,
      destination: dest,
      destinationType: "queue",
      routingKey: "orders.paid",
    });
    expect(a).not.toBe(b);
  });

  it("is invariant to argument key order", () => {
    const a = bindingId({
      vhost: v,
      sourceExchange: src,
      destination: dest,
      destinationType: "queue",
      routingKey: "orders.new",
      arguments: { "x-match": "all", region: "eu" },
    });
    const b = bindingId({
      vhost: v,
      sourceExchange: src,
      destination: dest,
      destinationType: "queue",
      routingKey: "orders.new",
      arguments: { region: "eu", "x-match": "all" },
    });
    expect(a).toBe(b);
  });

  it("distinguishes exchange vs queue destinations with the same name", () => {
    const destExchange = exchangeId(v, "orders.audit");
    const destQueue = queueId(v, "orders.audit");
    const a = bindingId({
      vhost: v,
      sourceExchange: src,
      destination: destExchange,
      destinationType: "exchange",
      routingKey: "orders.*",
    });
    const b = bindingId({
      vhost: v,
      sourceExchange: src,
      destination: destQueue,
      destinationType: "queue",
      routingKey: "orders.*",
    });
    expect(a).not.toBe(b);
  });
});

describe("canonicalArgsSignature", () => {
  it("returns empty string for missing/empty args", () => {
    expect(canonicalArgsSignature(undefined)).toBe("");
    expect(canonicalArgsSignature({})).toBe("");
  });

  it("sorts keys deeply for stable output", () => {
    const sig = canonicalArgsSignature({
      b: [{ z: 1, a: 2 }],
      a: 1,
    });
    expect(sig).toBe('{"a":1,"b":[{"a":2,"z":1}]}');
  });
});
