import { describe, expect, it } from "vitest";
import { upstreamForExchange } from "../../../src/core/graph/traversal";
import { buildGraph } from "../../../src/core/graph/buildGraph";
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

function chain(): {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  shovels: Shovel[];
  federations: FederationLink[];
} {
  // x.in → x.mid → x.leaf, and x.leaf → q.tap (queue, not part of ancestry from x.mid).
  // Focus target is x.leaf so we can assert we walk exchange-to-exchange chains.
  const h = hostId("rabbit-a");
  const v = vhostId(h, "/");
  const xIn = exchangeId(v, "x.in");
  const xMid = exchangeId(v, "x.mid");
  const xLeaf = exchangeId(v, "x.leaf");
  const qTap = queueId(v, "q.tap");
  return {
    hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
    vhosts: [{ id: v, hostId: h, name: "/" }],
    exchanges: [
      { id: xIn, hostId: h, vhostId: v, name: "x.in", type: "topic" },
      { id: xMid, hostId: h, vhostId: v, name: "x.mid", type: "topic" },
      { id: xLeaf, hostId: h, vhostId: v, name: "x.leaf", type: "fanout" },
    ],
    queues: [{ id: qTap, hostId: h, vhostId: v, name: "q.tap" }],
    bindings: [
      { id: "e2e-1", hostId: h, vhostId: v, sourceExchangeId: xIn, destinationId: xMid, destinationType: "exchange", routingKey: "orders.*" },
      { id: "e2e-2", hostId: h, vhostId: v, sourceExchangeId: xMid, destinationId: xLeaf, destinationType: "exchange", routingKey: "" },
      { id: "e2q-1", hostId: h, vhostId: v, sourceExchangeId: xLeaf, destinationId: qTap, destinationType: "queue", routingKey: "" },
    ],
    shovels: [],
    federations: [],
  };
}

describe("upstreamForExchange — exchange-to-exchange chain", () => {
  const p = chain();
  const graph = buildGraph(p);
  const xLeafId = p.exchanges[2]!.id;

  it("finds the full upstream exchange chain", () => {
    const r = upstreamForExchange(graph, xLeafId);
    expect(r.targetNodeId).toBe(xLeafId);
    expect(r.reachableAncestorIds).toContain(p.exchanges[0]!.id); // x.in
    expect(r.reachableAncestorIds).toContain(p.exchanges[1]!.id); // x.mid
    // q.tap is downstream, not upstream.
    expect(r.reachableAncestorIds).not.toContain(p.queues[0]!.id);
  });

  it("returns a representative path from the root source (x.in) through x.mid to x.leaf", () => {
    const r = upstreamForExchange(graph, xLeafId);
    const rootPath = r.paths.find((path) => path.sourceNodeId === p.exchanges[0]!.id);
    expect(rootPath).toBeDefined();
    const nodesOnPath = [rootPath!.sourceNodeId, ...rootPath!.steps.map((s) => s.toNodeId)];
    expect(nodesOnPath).toEqual([
      p.exchanges[0]!.id,
      p.exchanges[1]!.id,
      xLeafId,
    ]);
    expect(rootPath!.steps.map((s) => s.kind)).toEqual(["binds", "binds"]);
  });
});

describe("upstreamForExchange — target-kind guard", () => {
  const p = chain();
  const graph = buildGraph(p);

  it("returns empty when target id is a queue rather than an exchange", () => {
    const r = upstreamForExchange(graph, p.queues[0]!.id);
    expect(r.reachableAncestorIds).toEqual([]);
    expect(r.paths).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("returns empty when target id is unknown", () => {
    const r = upstreamForExchange(graph, "exchange:does-not-exist");
    expect(r.reachableAncestorIds).toEqual([]);
  });

  it("returns empty (not the ancestor set) when the target is a host or vhost node", () => {
    const r = upstreamForExchange(graph, p.hosts[0]!.id);
    expect(r.reachableAncestorIds).toEqual([]);
  });
});

describe("upstreamForExchange — shovel + federation into an exchange", () => {
  it("walks through shovel edges into the shovel node and its external source", () => {
    const p = chain();
    p.shovels.push({
      id: "shovel:local/sx",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "sx",
      source: { host: "remote.example.internal", exchange: "orders.out" },
      destination: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
    });
    p.federations.push({
      id: "federation:local/fed",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "fed",
      upstream: { host: "remote-b.example.internal", vhost: "/", exchange: "orders.out" },
      downstream: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
    });
    const graph = buildGraph(p);
    const r = upstreamForExchange(graph, p.exchanges[2]!.id); // target x.leaf
    expect(r.reachableAncestorIds).toContain("shovel:local/sx");
    expect(r.reachableAncestorIds).toContain("federation:local/fed");
    expect(r.reachableAncestorIds.some((id) => id.startsWith("external:"))).toBe(true);
    const kinds = new Set(r.paths.flatMap((path) => path.steps.map((s) => s.kind)));
    expect(kinds.has("shovels")).toBe(true);
    expect(kinds.has("federates")).toBe(true);
  });
});
