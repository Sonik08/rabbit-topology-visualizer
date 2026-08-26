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

interface ShovelProject {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  shovels: Shovel[];
  federations: FederationLink[];
}

/**
 * Extra cross-host shovel scenarios that complement `crossHost.test.ts` — pins
 * multi-hop chains, queue-source shovels, cross-vhost same-host shovels,
 * multiple shovels fanning into one downstream exchange, and both external +
 * mixed-project shovel ancestries.
 */

describe("cross-host shovel — three-host chain A → B → C", () => {
  it("walks the full chain up to the shovel spanning A and B", () => {
    const hA = hostId("rabbit-a");
    const hB = hostId("rabbit-b");
    const hC = hostId("rabbit-c");
    const vA = vhostId(hA, "/");
    const vB = vhostId(hB, "/");
    const vC = vhostId(hC, "/");
    const xA = exchangeId(vA, "x.a");
    const xB = exchangeId(vB, "x.b");
    const xC = exchangeId(vC, "x.c");
    const qC = queueId(vC, "q.c");
    const project: ShovelProject = {
      hosts: [
        { id: hA, name: "rabbit-a", sourceFiles: [] },
        { id: hB, name: "rabbit-b", sourceFiles: [] },
        { id: hC, name: "rabbit-c", sourceFiles: [] },
      ],
      vhosts: [
        { id: vA, hostId: hA, name: "/" },
        { id: vB, hostId: hB, name: "/" },
        { id: vC, hostId: hC, name: "/" },
      ],
      exchanges: [
        { id: xA, hostId: hA, vhostId: vA, name: "x.a", type: "topic" },
        { id: xB, hostId: hB, vhostId: vB, name: "x.b", type: "topic" },
        { id: xC, hostId: hC, vhostId: vC, name: "x.c", type: "topic" },
      ],
      queues: [{ id: qC, hostId: hC, vhostId: vC, name: "q.c" }],
      bindings: [
        {
          id: "b:x.c->q.c",
          hostId: hC,
          vhostId: vC,
          sourceExchangeId: xC,
          destinationId: qC,
          destinationType: "queue",
          routingKey: "",
        },
      ],
      shovels: [
        {
          id: "shovel:rabbit-b//a-to-b",
          hostId: hB,
          vhostId: vB,
          name: "a-to-b",
          source: { host: "rabbit-a", vhost: "/", exchange: "x.a" },
          destination: { host: "rabbit-b", vhost: "/", exchange: "x.b" },
        },
        {
          id: "shovel:rabbit-c//b-to-c",
          hostId: hC,
          vhostId: vC,
          name: "b-to-c",
          source: { host: "rabbit-b", vhost: "/", exchange: "x.b" },
          destination: { host: "rabbit-c", vhost: "/", exchange: "x.c" },
        },
      ],
      federations: [],
    };
    const graph = buildGraph(project);
    const result = upstreamForQueue(graph, qC);
    // Every intermediate exchange + both shovels + the original source
    // exchange must be in the reachable ancestor set.
    for (const id of [xA, xB, xC, "shovel:rabbit-b//a-to-b", "shovel:rabbit-c//b-to-c"]) {
      expect(result.reachableAncestorIds).toContain(id);
    }
    const summary = summarizeCrossHostAncestry(graph, result, hC);
    expect(summary.ancestorHostIds.sort()).toEqual([hA, hB].sort());
    expect(summary.crossedShovelOrFederation).toBe(true);
  });
});

describe("cross-host shovel — queue-source (moves messages FROM a queue on A INTO an exchange on B)", () => {
  it("resolves the source queue on rabbit-a and marks the traversal as cross-host", () => {
    const hA = hostId("rabbit-a");
    const hB = hostId("rabbit-b");
    const vA = vhostId(hA, "/");
    const vB = vhostId(hB, "/");
    const qOut = queueId(vA, "q.out");
    const xIn = exchangeId(vB, "x.in");
    const qDown = queueId(vB, "q.down");
    const project: ShovelProject = {
      hosts: [
        { id: hA, name: "rabbit-a", sourceFiles: [] },
        { id: hB, name: "rabbit-b", sourceFiles: [] },
      ],
      vhosts: [
        { id: vA, hostId: hA, name: "/" },
        { id: vB, hostId: hB, name: "/" },
      ],
      exchanges: [{ id: xIn, hostId: hB, vhostId: vB, name: "x.in", type: "topic" }],
      queues: [
        { id: qOut, hostId: hA, vhostId: vA, name: "q.out" },
        { id: qDown, hostId: hB, vhostId: vB, name: "q.down" },
      ],
      bindings: [
        {
          id: "b:x.in->q.down",
          hostId: hB,
          vhostId: vB,
          sourceExchangeId: xIn,
          destinationId: qDown,
          destinationType: "queue",
          routingKey: "",
        },
      ],
      shovels: [
        {
          id: "shovel:rabbit-b//drain",
          hostId: hB,
          vhostId: vB,
          name: "drain",
          source: { host: "rabbit-a", vhost: "/", queue: "q.out" },
          destination: { host: "rabbit-b", vhost: "/", exchange: "x.in" },
        },
      ],
      federations: [],
    };
    const graph = buildGraph(project);
    const result = upstreamForQueue(graph, qDown);
    expect(result.reachableAncestorIds).toContain(qOut);
    expect(result.reachableAncestorIds).toContain("shovel:rabbit-b//drain");
    const summary = summarizeCrossHostAncestry(graph, result, hB);
    expect(summary.ancestorHostIds).toEqual([hA]);
    expect(summary.crossedShovelOrFederation).toBe(true);
  });
});

describe("cross-host shovel — same host, two vhosts", () => {
  it("is NOT reported as cross-host but still surfaces the shovel step", () => {
    const h = hostId("rabbit-solo");
    const vSrc = vhostId(h, "src");
    const vDst = vhostId(h, "dst");
    const xSrc = exchangeId(vSrc, "x.src");
    const xDst = exchangeId(vDst, "x.dst");
    const q = queueId(vDst, "q.dst");
    const project: ShovelProject = {
      hosts: [{ id: h, name: "rabbit-solo", sourceFiles: [] }],
      vhosts: [
        { id: vSrc, hostId: h, name: "src" },
        { id: vDst, hostId: h, name: "dst" },
      ],
      exchanges: [
        { id: xSrc, hostId: h, vhostId: vSrc, name: "x.src", type: "topic" },
        { id: xDst, hostId: h, vhostId: vDst, name: "x.dst", type: "topic" },
      ],
      queues: [{ id: q, hostId: h, vhostId: vDst, name: "q.dst" }],
      bindings: [
        {
          id: "b:x.dst->q.dst",
          hostId: h,
          vhostId: vDst,
          sourceExchangeId: xDst,
          destinationId: q,
          destinationType: "queue",
          routingKey: "",
        },
      ],
      shovels: [
        {
          id: "shovel:rabbit-solo/dst/cross-vhost",
          hostId: h,
          vhostId: vDst,
          name: "cross-vhost",
          source: { host: "rabbit-solo", vhost: "src", exchange: "x.src" },
          destination: { host: "rabbit-solo", vhost: "dst", exchange: "x.dst" },
        },
      ],
      federations: [],
    };
    const graph = buildGraph(project);
    const result = upstreamForQueue(graph, q);
    expect(result.reachableAncestorIds).toContain(xSrc);
    expect(result.reachableAncestorIds).toContain("shovel:rabbit-solo/dst/cross-vhost");
    // Everything lives on rabbit-solo, so ancestorHostIds must exclude the
    // target host and contain no OTHER hosts → empty set.
    const summary = summarizeCrossHostAncestry(graph, result, h);
    expect(summary.ancestorHostIds).toEqual([]);
    expect(summary.crossedShovelOrFederation).toBe(true);
  });
});

describe("cross-host shovel — two shovels fan into one downstream exchange", () => {
  it("both shovels + their distinct source exchanges appear as ancestors", () => {
    const hA = hostId("rabbit-a");
    const hB = hostId("rabbit-b");
    const hC = hostId("rabbit-c");
    const vA = vhostId(hA, "/");
    const vB = vhostId(hB, "/");
    const vC = vhostId(hC, "/");
    const xA = exchangeId(vA, "x.a");
    const xB = exchangeId(vB, "x.b");
    const xIn = exchangeId(vC, "x.in");
    const q = queueId(vC, "q.consume");
    const project: ShovelProject = {
      hosts: [
        { id: hA, name: "rabbit-a", sourceFiles: [] },
        { id: hB, name: "rabbit-b", sourceFiles: [] },
        { id: hC, name: "rabbit-c", sourceFiles: [] },
      ],
      vhosts: [
        { id: vA, hostId: hA, name: "/" },
        { id: vB, hostId: hB, name: "/" },
        { id: vC, hostId: hC, name: "/" },
      ],
      exchanges: [
        { id: xA, hostId: hA, vhostId: vA, name: "x.a", type: "topic" },
        { id: xB, hostId: hB, vhostId: vB, name: "x.b", type: "topic" },
        { id: xIn, hostId: hC, vhostId: vC, name: "x.in", type: "topic" },
      ],
      queues: [{ id: q, hostId: hC, vhostId: vC, name: "q.consume" }],
      bindings: [
        {
          id: "b:x.in->q.consume",
          hostId: hC,
          vhostId: vC,
          sourceExchangeId: xIn,
          destinationId: q,
          destinationType: "queue",
          routingKey: "#",
        },
      ],
      shovels: [
        {
          id: "shovel:rabbit-c//from-a",
          hostId: hC,
          vhostId: vC,
          name: "from-a",
          source: { host: "rabbit-a", vhost: "/", exchange: "x.a" },
          destination: { host: "rabbit-c", vhost: "/", exchange: "x.in" },
        },
        {
          id: "shovel:rabbit-c//from-b",
          hostId: hC,
          vhostId: vC,
          name: "from-b",
          source: { host: "rabbit-b", vhost: "/", exchange: "x.b" },
          destination: { host: "rabbit-c", vhost: "/", exchange: "x.in" },
        },
      ],
      federations: [],
    };
    const graph = buildGraph(project);
    const result = upstreamForQueue(graph, q);
    expect(result.reachableAncestorIds).toContain(xA);
    expect(result.reachableAncestorIds).toContain(xB);
    expect(result.reachableAncestorIds).toContain("shovel:rabbit-c//from-a");
    expect(result.reachableAncestorIds).toContain("shovel:rabbit-c//from-b");
    // Two distinct source ancestors → two representative paths
    const sourceIds = new Set(result.paths.map((p) => p.sourceNodeId));
    expect(sourceIds.has(xA)).toBe(true);
    expect(sourceIds.has(xB)).toBe(true);
    const summary = summarizeCrossHostAncestry(graph, result, hC);
    expect(summary.ancestorHostIds.sort()).toEqual([hA, hB].sort());
  });
});

describe("cross-host shovel — source resolves to an external node when the remote host is not loaded", () => {
  it("produces an external ancestor with the remote hostname surfaced through the summary", () => {
    const hB = hostId("rabbit-b");
    const vB = vhostId(hB, "/");
    const xIn = exchangeId(vB, "x.in");
    const q = queueId(vB, "q.consume");
    const project: ShovelProject = {
      hosts: [{ id: hB, name: "rabbit-b", sourceFiles: [] }],
      vhosts: [{ id: vB, hostId: hB, name: "/" }],
      exchanges: [{ id: xIn, hostId: hB, vhostId: vB, name: "x.in", type: "topic" }],
      queues: [{ id: q, hostId: hB, vhostId: vB, name: "q.consume" }],
      bindings: [
        {
          id: "b:x.in->q.consume",
          hostId: hB,
          vhostId: vB,
          sourceExchangeId: xIn,
          destinationId: q,
          destinationType: "queue",
          routingKey: "",
        },
      ],
      shovels: [
        {
          id: "shovel:rabbit-b//from-unknown",
          hostId: hB,
          vhostId: vB,
          name: "from-unknown",
          source: { host: "remote-only.example.com", vhost: "/", exchange: "x.remote" },
          destination: { host: "rabbit-b", vhost: "/", exchange: "x.in" },
        },
      ],
      federations: [],
    };
    const graph = buildGraph(project);
    const result = upstreamForQueue(graph, q);
    // The remote source is not in the loaded topology → external ancestor.
    const externalAncestors = result.reachableAncestorIds.filter((id) =>
      id.startsWith("external:"),
    );
    expect(externalAncestors.length).toBe(1);
    const summary = summarizeCrossHostAncestry(graph, result, hB);
    expect(summary.externalHostHints).toContain("remote-only.example.com");
    expect(summary.ancestorHostIds).toEqual([]);
    expect(summary.crossedShovelOrFederation).toBe(true);
  });
});
