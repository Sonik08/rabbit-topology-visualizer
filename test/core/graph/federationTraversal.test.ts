import { describe, expect, it } from "vitest";
import { buildGraph } from "../../../src/core/graph/buildGraph";
import { findCycles } from "../../../src/core/graph/cycles";
import {
  traverseUpstream,
  upstreamForExchange,
  upstreamForQueue,
} from "../../../src/core/graph/traversal";
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

interface FederationProject {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  shovels: Shovel[];
  federations: FederationLink[];
}

/**
 * rabbit-a hosts `x.publish`; rabbit-b hosts a federation link that pulls
 * from rabbit-a's exchange into rabbit-b's `x.mirror`, which binds to
 * `q.consume`. Target of every traversal here is `q.consume` on rabbit-b.
 */
function twoHostFederationProject(): FederationProject {
  const hA = hostId("rabbit-a");
  const hB = hostId("rabbit-b");
  const vA = vhostId(hA, "/");
  const vB = vhostId(hB, "/");
  const xPubA = exchangeId(vA, "x.publish");
  const xMirrorB = exchangeId(vB, "x.mirror");
  const qConsumeB = queueId(vB, "q.consume");
  return {
    hosts: [
      { id: hA, name: "rabbit-a", sourceFiles: [] },
      { id: hB, name: "rabbit-b", sourceFiles: [] },
    ],
    vhosts: [
      { id: vA, hostId: hA, name: "/" },
      { id: vB, hostId: hB, name: "/" },
    ],
    exchanges: [
      { id: xPubA, hostId: hA, vhostId: vA, name: "x.publish", type: "topic" },
      { id: xMirrorB, hostId: hB, vhostId: vB, name: "x.mirror", type: "topic" },
    ],
    queues: [{ id: qConsumeB, hostId: hB, vhostId: vB, name: "q.consume" }],
    bindings: [
      {
        id: "b:x.mirror->q.consume",
        hostId: hB,
        vhostId: vB,
        sourceExchangeId: xMirrorB,
        destinationId: qConsumeB,
        destinationType: "queue",
        routingKey: "orders.#",
      },
    ],
    shovels: [],
    federations: [
      {
        id: "federation:rabbit-b//pull-orders",
        hostId: hB,
        vhostId: vB,
        name: "pull-orders",
        upstream: { host: "rabbit-a", vhost: "/", exchange: "x.publish" },
        downstream: { host: "rabbit-b", vhost: "/", exchange: "x.mirror" },
      },
    ],
  };
}

describe("federation traversal — queue target reaches upstream exchange", () => {
  const project = twoHostFederationProject();
  const graph = buildGraph(project);
  const queueTarget = project.queues[0]!.id;
  const upstreamExchange = project.exchanges[0]!.id;
  const mirrorExchange = project.exchanges[1]!.id;
  const federationNode = project.federations[0]!.id;

  it("walks binds → federates(out) → federation → federates(in) → upstream exchange", () => {
    const result = upstreamForQueue(graph, queueTarget);
    expect(result.reachableAncestorIds).toContain(mirrorExchange);
    expect(result.reachableAncestorIds).toContain(federationNode);
    expect(result.reachableAncestorIds).toContain(upstreamExchange);
    // Every path's step kinds contain both binds AND federates
    const stepKinds = new Set(result.paths.flatMap((p) => p.steps.map((s) => s.kind)));
    expect(stepKinds.has("binds")).toBe(true);
    expect(stepKinds.has("federates")).toBe(true);
  });

  it("federates steps carry the federation link's label", () => {
    const result = upstreamForQueue(graph, queueTarget);
    const federatesSteps = result.paths
      .flatMap((p) => p.steps)
      .filter((s) => s.kind === "federates");
    expect(federatesSteps.length).toBeGreaterThan(0);
    for (const s of federatesSteps) expect(s.label).toBe("pull-orders");
  });

  it("routing-key metadata from the mirror binding is preserved on the binds step", () => {
    const result = upstreamForQueue(graph, queueTarget);
    const bindsSteps = result.paths
      .flatMap((p) => p.steps)
      .filter((s) => s.kind === "binds");
    expect(bindsSteps.some((s) => s.routingKey === "orders.#")).toBe(true);
  });
});

describe("federation traversal — exchange target", () => {
  it("walks the federation link upstream when the mirror exchange is the target", () => {
    const project = twoHostFederationProject();
    const graph = buildGraph(project);
    const result = upstreamForExchange(graph, project.exchanges[1]!.id);
    expect(result.reachableAncestorIds).toContain(project.federations[0]!.id);
    expect(result.reachableAncestorIds).toContain(project.exchanges[0]!.id);
  });
});

describe("federation traversal — external upstream endpoint", () => {
  it("produces an external node ancestor when the upstream host is not loaded", () => {
    const project = twoHostFederationProject();
    // Drop rabbit-a from the project so the federation's upstream endpoint
    // cannot resolve to an in-project exchange. buildGraph should emit an
    // `external:` node in its place, and the traversal must still walk to it.
    project.hosts = [project.hosts[1]!];
    project.vhosts = [project.vhosts[1]!];
    project.exchanges = [project.exchanges[1]!];
    const graph = buildGraph(project);
    const result = upstreamForQueue(graph, project.queues[0]!.id);
    const externalAncestors = result.reachableAncestorIds.filter((id) =>
      id.startsWith("external:"),
    );
    expect(externalAncestors.length).toBe(1);
    expect(externalAncestors[0]).toContain("rabbit-a");
  });
});

describe("federation traversal — multiple upstream sources fan into one downstream", () => {
  it("collects every distinct upstream exchange when two federations feed the same mirror", () => {
    const project = twoHostFederationProject();
    const hC = hostId("rabbit-c");
    const vC = vhostId(hC, "/");
    const xPubC = exchangeId(vC, "x.publish");
    project.hosts.push({ id: hC, name: "rabbit-c", sourceFiles: [] });
    project.vhosts.push({ id: vC, hostId: hC, name: "/" });
    project.exchanges.push({ id: xPubC, hostId: hC, vhostId: vC, name: "x.publish", type: "topic" });
    project.federations.push({
      id: "federation:rabbit-b//pull-orders-c",
      hostId: project.hosts[1]!.id,
      vhostId: project.vhosts[1]!.id,
      name: "pull-orders-c",
      upstream: { host: "rabbit-c", vhost: "/", exchange: "x.publish" },
      downstream: { host: "rabbit-b", vhost: "/", exchange: "x.mirror" },
    });
    const graph = buildGraph(project);
    const result = upstreamForQueue(graph, project.queues[0]!.id);
    expect(result.reachableAncestorIds).toContain(project.exchanges[0]!.id);
    expect(result.reachableAncestorIds).toContain(xPubC);
    expect(result.reachableAncestorIds).toContain("federation:rabbit-b//pull-orders");
    expect(result.reachableAncestorIds).toContain("federation:rabbit-b//pull-orders-c");
    // Two distinct sources → two reported paths
    const sourceIds = new Set(result.paths.map((p) => p.sourceNodeId));
    expect(sourceIds.has(project.exchanges[0]!.id)).toBe(true);
    expect(sourceIds.has(xPubC)).toBe(true);
  });
});

describe("federation traversal — cross-vhost on the same host", () => {
  it("walks a federation link between two vhosts of the same host", () => {
    const h = hostId("rabbit-solo");
    const vA = vhostId(h, "src");
    const vB = vhostId(h, "dst");
    const xSrc = exchangeId(vA, "x.src");
    const xDst = exchangeId(vB, "x.dst");
    const q = queueId(vB, "q.dst");
    const project: FederationProject = {
      hosts: [{ id: h, name: "rabbit-solo", sourceFiles: [] }],
      vhosts: [
        { id: vA, hostId: h, name: "src" },
        { id: vB, hostId: h, name: "dst" },
      ],
      exchanges: [
        { id: xSrc, hostId: h, vhostId: vA, name: "x.src", type: "topic" },
        { id: xDst, hostId: h, vhostId: vB, name: "x.dst", type: "topic" },
      ],
      queues: [{ id: q, hostId: h, vhostId: vB, name: "q.dst" }],
      bindings: [
        {
          id: "b:x.dst->q.dst",
          hostId: h,
          vhostId: vB,
          sourceExchangeId: xDst,
          destinationId: q,
          destinationType: "queue",
          routingKey: "",
        },
      ],
      shovels: [],
      federations: [
        {
          id: "federation:rabbit-solo/dst/vhost-fed",
          hostId: h,
          vhostId: vB,
          name: "vhost-fed",
          upstream: { host: "rabbit-solo", vhost: "src", exchange: "x.src" },
          downstream: { host: "rabbit-solo", vhost: "dst", exchange: "x.dst" },
        },
      ],
    };
    const graph = buildGraph(project);
    const result = upstreamForQueue(graph, q);
    expect(result.reachableAncestorIds).toContain(xSrc);
    expect(result.reachableAncestorIds).toContain(xDst);
    expect(result.reachableAncestorIds).toContain("federation:rabbit-solo/dst/vhost-fed");
  });
});

describe("federation traversal — max depth truncates federation ancestry", () => {
  it("maxDepth=1 stops before reaching the upstream exchange", () => {
    const project = twoHostFederationProject();
    const graph = buildGraph(project);
    const result = traverseUpstream(graph, project.queues[0]!.id, { maxDepth: 1 });
    expect(result.reachableAncestorIds).toContain(project.exchanges[1]!.id);
    // Federation node + upstream exchange are >1 hop away → not reached
    expect(result.reachableAncestorIds).not.toContain(project.exchanges[0]!.id);
    expect(result.truncated).toBe(true);
  });
});

describe("federation traversal — cycle detection through a federation loop", () => {
  it("detects a cycle when downstream feeds back into upstream via a bind", () => {
    const project = twoHostFederationProject();
    // Add a binding from x.mirror BACK to x.publish (simulating a
    // pathological same-host echo topology) so mirror → publish → federation
    // → mirror forms a cycle spanning `binds` + `federates` edges.
    const hA = project.hosts[0]!.id;
    const vA = project.vhosts[0]!.id;
    project.bindings.push({
      id: "b:x.mirror->x.publish",
      hostId: hA,
      vhostId: vA,
      sourceExchangeId: project.exchanges[1]!.id, // x.mirror
      destinationId: project.exchanges[0]!.id, // x.publish
      destinationType: "exchange",
      routingKey: "loop.*",
    });
    const graph = buildGraph(project);
    const cycles = findCycles(graph);
    expect(cycles.length).toBeGreaterThan(0);
    // Cycle SCC contains both exchanges + the federation node
    const scc = cycles.flatMap((c) => c.nodeIds);
    expect(scc).toContain(project.exchanges[0]!.id);
    expect(scc).toContain(project.exchanges[1]!.id);
    expect(scc).toContain(project.federations[0]!.id);
    // Traversal is still bounded (cycle is guarded)
    const result = upstreamForQueue(graph, project.queues[0]!.id, { maxDepth: 32 });
    expect(result.reachableAncestorIds.length).toBeLessThanOrEqual(project.exchanges.length + 1);
  });
});
