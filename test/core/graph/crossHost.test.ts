import { describe, expect, it } from "vitest";
import { buildGraph } from "../../../src/core/graph/buildGraph";
import { summarizeCrossHostAncestry } from "../../../src/core/graph/crossHost";
import { upstreamForQueue } from "../../../src/core/graph/traversal";
import { exchangeId, hostId, queueId, vhostId } from "../../../src/core/model/ids";
import type {
  Binding,
  Exchange,
  FederationLink,
  Host,
  Queue,
  Shovel,
  Vhost,
} from "../../../src/core/model/topology";

interface TwoHostProject {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  shovels: Shovel[];
  federations: FederationLink[];
}

function twoHostProject(): TwoHostProject {
  // rabbit-a publishes into x.out; a shovel moves messages to rabbit-b's x.in,
  // which binds to q.in on rabbit-b. Target is the queue on rabbit-b.
  const hA = hostId("rabbit-a");
  const hB = hostId("rabbit-b");
  const vA = vhostId(hA, "orders");
  const vB = vhostId(hB, "/");
  const xOutA = exchangeId(vA, "x.out");
  const xInB = exchangeId(vB, "x.in");
  const qInB = queueId(vB, "q.in");
  return {
    hosts: [
      { id: hA, name: "rabbit-a", sourceFiles: [] },
      { id: hB, name: "rabbit-b", sourceFiles: [] },
    ],
    vhosts: [
      { id: vA, hostId: hA, name: "orders" },
      { id: vB, hostId: hB, name: "/" },
    ],
    exchanges: [
      { id: xOutA, hostId: hA, vhostId: vA, name: "x.out", type: "topic" },
      { id: xInB, hostId: hB, vhostId: vB, name: "x.in", type: "topic" },
    ],
    queues: [{ id: qInB, hostId: hB, vhostId: vB, name: "q.in" }],
    bindings: [
      {
        id: "b-in-q",
        hostId: hB,
        vhostId: vB,
        sourceExchangeId: xInB,
        destinationId: qInB,
        destinationType: "queue",
        routingKey: "orders.#",
      },
    ],
    shovels: [
      {
        id: "shovel:rabbit-a/orders/a-to-b",
        hostId: hA,
        vhostId: vA,
        name: "a-to-b",
        // Source is rabbit-a's exchange (fully qualified so buildGraph resolves it).
        source: { host: "rabbit-a", vhost: "orders", exchange: "x.out" },
        // Destination is rabbit-b's exchange.
        destination: { host: "rabbit-b", vhost: "/", exchange: "x.in" },
      },
    ],
    federations: [],
  };
}

describe("upstreamForQueue — cross-host via shovel", () => {
  const p = twoHostProject();
  const graph = buildGraph(p);
  const targetId = p.queues[0]!.id;
  const targetHostId = p.hosts[1]!.id; // rabbit-b

  it("walks through the shovel edge into rabbit-a's exchange", () => {
    const r = upstreamForQueue(graph, targetId);
    expect(r.reachableAncestorIds).toContain(p.exchanges[1]!.id); // x.in (rabbit-b)
    expect(r.reachableAncestorIds).toContain("shovel:rabbit-a/orders/a-to-b");
    expect(r.reachableAncestorIds).toContain(p.exchanges[0]!.id); // x.out (rabbit-a)
    const kinds = new Set(r.paths.flatMap((path) => path.steps.map((s) => s.kind)));
    expect(kinds.has("shovels")).toBe(true);
    expect(kinds.has("binds")).toBe(true);
  });

  it("summary correctly identifies rabbit-a as a cross-host ancestor", () => {
    const r = upstreamForQueue(graph, targetId);
    const summary = summarizeCrossHostAncestry(graph, r, targetHostId);
    expect(summary.ancestorHostIds).toEqual([p.hosts[0]!.id]);
    expect(summary.externalHostHints).toEqual([]);
    expect(summary.crossedShovelOrFederation).toBe(true);
  });
});

describe("summarizeCrossHostAncestry — cross-host via federation", () => {
  it("marks a federation-crossing ancestry accordingly", () => {
    const p = twoHostProject();
    // Swap shovel for a federation link with the same shape.
    p.shovels = [];
    p.federations = [
      {
        id: "federation:rabbit-b/fed-from-a",
        hostId: p.hosts[1]!.id,
        vhostId: p.vhosts[1]!.id,
        name: "fed-from-a",
        upstream: { host: "rabbit-a", vhost: "orders", exchange: "x.out" },
        downstream: { host: "rabbit-b", vhost: "/", exchange: "x.in" },
      },
    ];
    const graph = buildGraph(p);
    const targetId = p.queues[0]!.id;
    const targetHostId = p.hosts[1]!.id;
    const r = upstreamForQueue(graph, targetId);
    const summary = summarizeCrossHostAncestry(graph, r, targetHostId);
    expect(summary.ancestorHostIds).toEqual([p.hosts[0]!.id]);
    expect(summary.crossedShovelOrFederation).toBe(true);
  });
});

describe("summarizeCrossHostAncestry — single-host traversal", () => {
  it("reports no ancestor hosts and no crossing when everything lives on one host", () => {
    const h = hostId("rabbit-solo");
    const v = vhostId(h, "/");
    const x = exchangeId(v, "x");
    const q = queueId(v, "q");
    const p: TwoHostProject = {
      hosts: [{ id: h, name: "rabbit-solo", sourceFiles: [] }],
      vhosts: [{ id: v, hostId: h, name: "/" }],
      exchanges: [{ id: x, hostId: h, vhostId: v, name: "x", type: "direct" }],
      queues: [{ id: q, hostId: h, vhostId: v, name: "q" }],
      bindings: [
        {
          id: "b",
          hostId: h,
          vhostId: v,
          sourceExchangeId: x,
          destinationId: q,
          destinationType: "queue",
          routingKey: "",
        },
      ],
      shovels: [],
      federations: [],
    };
    const graph = buildGraph(p);
    const r = upstreamForQueue(graph, q);
    const summary = summarizeCrossHostAncestry(graph, r, h);
    expect(summary.ancestorHostIds).toEqual([]);
    expect(summary.externalHostHints).toEqual([]);
    expect(summary.crossedShovelOrFederation).toBe(false);
  });
});

describe("summarizeCrossHostAncestry — external hostname hint", () => {
  it("surfaces the remote hostname from external endpoint ancestors", () => {
    const p = twoHostProject();
    // Drop the rabbit-a host so the shovel source falls back to an external node
    // labeled with the hostname hint.
    p.hosts = [p.hosts[1]!];
    p.vhosts = [p.vhosts[1]!];
    p.exchanges = [p.exchanges[1]!];
    const graph = buildGraph(p);
    const r = upstreamForQueue(graph, p.queues[0]!.id);
    const summary = summarizeCrossHostAncestry(graph, r, p.hosts[0]!.id);
    // The remote host is no longer part of the project → external hint set.
    expect(summary.externalHostHints).toContain("rabbit-a");
    expect(summary.ancestorHostIds).toEqual([]);
    expect(summary.crossedShovelOrFederation).toBe(true);
  });
});
