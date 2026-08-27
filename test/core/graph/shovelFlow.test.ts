import { describe, expect, it } from "vitest";
import {
  buildLinkFlow,
  classifyBoundary,
  describeBoundary,
  describeLinkFlow,
  resolveEndpointNames,
} from "../../../src/core/graph/shovelFlow";
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

/**
 * These tests pin the *configured* message-flow classification for shovel /
 * federation edges: direction, host/vhost boundary, and label content. They
 * are the mandatory regression floor for the "visualize configured flow"
 * task in TASKS.md, so a rename or default-drift will fail here before the
 * UI test does.
 *
 * Nothing in this file mentions live message rates — the metadata under
 * test is a static declaration of intended flow, not a telemetry feed.
 */

describe("shovelFlow — resolveEndpointNames applies the link's own vhost as default", () => {
  it("uses ref.host / ref.vhost when present", () => {
    const names = resolveEndpointNames(
      { host: "far-host", vhost: "orders", exchange: "x" },
      { linkHostName: "local-host", linkVhostName: "/" },
    );
    expect(names.hostName).toBe("far-host");
    expect(names.vhostName).toBe("orders");
  });

  it("falls back to the link's own host+vhost when ref omits them", () => {
    const names = resolveEndpointNames(
      { queue: "q" },
      { linkHostName: "local-host", linkVhostName: "orders" },
    );
    expect(names.hostName).toBe("local-host");
    expect(names.vhostName).toBe("orders");
  });

  it("treats an empty/whitespace ref field as absent", () => {
    const names = resolveEndpointNames(
      { host: "   ", vhost: "" },
      { linkHostName: "local-host", linkVhostName: "billing" },
    );
    expect(names.hostName).toBe("local-host");
    expect(names.vhostName).toBe("billing");
  });
});

describe("shovelFlow — classifyBoundary distinguishes cross-host, cross-vhost, same-vhost", () => {
  it("same host + same vhost => same-vhost", () => {
    expect(
      classifyBoundary(
        { hostName: "h1", vhostName: "/" },
        { hostName: "h1", vhostName: "/" },
      ),
    ).toBe("same-vhost");
  });
  it("same host + different vhost => cross-vhost-same-host", () => {
    expect(
      classifyBoundary(
        { hostName: "h1", vhostName: "orders" },
        { hostName: "h1", vhostName: "audit" },
      ),
    ).toBe("cross-vhost-same-host");
  });
  it("different host => cross-host regardless of vhost", () => {
    expect(
      classifyBoundary(
        { hostName: "h1", vhostName: "/" },
        { hostName: "h2", vhostName: "/" },
      ),
    ).toBe("cross-host");
    expect(
      classifyBoundary(
        { hostName: "h1", vhostName: "orders" },
        { hostName: "h2", vhostName: "audit" },
      ),
    ).toBe("cross-host");
  });
  it("case-insensitive host comparison catches trivial casing drift", () => {
    expect(
      classifyBoundary(
        { hostName: "Rabbit-A", vhostName: "/" },
        { hostName: "rabbit-a", vhostName: "/" },
      ),
    ).toBe("same-vhost");
  });
});

describe("shovelFlow — buildLinkFlow populates every field for both roles", () => {
  it("cross-host shovel with omitted destination host uses the link's own host as the destination default", () => {
    const flowIn = buildLinkFlow({
      source: { host: "rabbit-a", vhost: "/", exchange: "x.a" },
      destination: { vhost: "/", queue: "q.b" },
      context: { linkHostName: "rabbit-b", linkVhostName: "/" },
      linkKind: "shovel",
      linkName: "a-to-b",
      role: "in",
    });
    expect(flowIn.boundary).toBe("cross-host");
    expect(flowIn.sourceHostName).toBe("rabbit-a");
    expect(flowIn.destinationHostName).toBe("rabbit-b");
    expect(flowIn.role).toBe("in");
    const flowOut = buildLinkFlow({
      source: { host: "rabbit-a", vhost: "/", exchange: "x.a" },
      destination: { vhost: "/", queue: "q.b" },
      context: { linkHostName: "rabbit-b", linkVhostName: "/" },
      linkKind: "shovel",
      linkName: "a-to-b",
      role: "out",
    });
    expect(flowOut.role).toBe("out");
    expect(flowOut.boundary).toBe("cross-host");
  });

  it("same-host cross-vhost federation is classified as cross-vhost-same-host", () => {
    const flow = buildLinkFlow({
      source: { vhost: "orders", exchange: "orders.in" },
      destination: { vhost: "audit", exchange: "audit.in" },
      context: { linkHostName: "rabbit-a", linkVhostName: "audit" },
      linkKind: "federation",
      linkName: "orders→audit",
      role: "in",
    });
    expect(flow.boundary).toBe("cross-vhost-same-host");
    expect(flow.sourceHostName).toBe("rabbit-a");
    expect(flow.destinationHostName).toBe("rabbit-a");
    expect(flow.sourceVhostName).toBe("orders");
    expect(flow.destinationVhostName).toBe("audit");
  });
});

describe("shovelFlow — describeBoundary / describeLinkFlow render human summaries", () => {
  it("returns stable boundary strings", () => {
    expect(describeBoundary("same-vhost")).toBe("same vhost");
    expect(describeBoundary("cross-vhost-same-host")).toBe("cross-vhost, same host");
    expect(describeBoundary("cross-host")).toBe("cross-host");
  });

  it("describeLinkFlow calls out CONFIGURED flow (not live) and includes the host/vhost path", () => {
    const flow = buildLinkFlow({
      source: { host: "rabbit-a", vhost: "/", exchange: "x.a" },
      destination: { host: "rabbit-b", vhost: "/", queue: "q.b" },
      context: { linkHostName: "rabbit-b", linkVhostName: "/" },
      linkKind: "shovel",
      linkName: "a-to-b",
      role: "in",
    });
    const text = describeLinkFlow(flow);
    expect(text).toMatch(/configured shovel "a-to-b"/);
    expect(text).toMatch(/cross-host/);
    expect(text).toMatch(/rabbit-a\/\/ → rabbit-b\/\//);
  });
});

// --- Integration fixtures: buildGraph attaches `flow` to shovel/fed edges ---

describe("shovelFlow — buildGraph attaches configured-flow metadata to shovel & federation edges", () => {
  it("cross-host shovel: both shovel-in and shovel-out edges carry boundary=cross-host with correct host names", () => {
    const hA = hostId("rabbit-a");
    const hB = hostId("rabbit-b");
    const vA = vhostId(hA, "/");
    const vB = vhostId(hB, "/");
    const xA = exchangeId(vA, "x.a");
    const qB = queueId(vB, "q.b");
    const hosts: Host[] = [
      { id: hA, name: "rabbit-a", sourceFiles: [] },
      { id: hB, name: "rabbit-b", sourceFiles: [] },
    ];
    const vhosts: Vhost[] = [
      { id: vA, hostId: hA, name: "/" },
      { id: vB, hostId: hB, name: "/" },
    ];
    const exchanges: Exchange[] = [
      { id: xA, hostId: hA, vhostId: vA, name: "x.a", type: "topic" },
    ];
    const queues: Queue[] = [{ id: qB, hostId: hB, vhostId: vB, name: "q.b" }];
    const bindings: Binding[] = [];
    const shovels: Shovel[] = [
      {
        id: "shovel:rabbit-b//a-to-b",
        hostId: hB,
        vhostId: vB,
        name: "a-to-b",
        source: { host: "rabbit-a", vhost: "/", exchange: "x.a" },
        destination: { host: "rabbit-b", vhost: "/", queue: "q.b" },
      },
    ];
    const federations: FederationLink[] = [];
    const graph = buildGraph({ hosts, vhosts, exchanges, queues, bindings, shovels, federations });
    const shovelEdges = graph.edges.filter((e) => e.kind === "shovels");
    expect(shovelEdges).toHaveLength(2);
    for (const edge of shovelEdges) {
      expect(edge.flow).toBeDefined();
      expect(edge.flow!.linkKind).toBe("shovel");
      expect(edge.flow!.linkName).toBe("a-to-b");
      expect(edge.flow!.boundary).toBe("cross-host");
      expect(edge.flow!.sourceHostName).toBe("rabbit-a");
      expect(edge.flow!.destinationHostName).toBe("rabbit-b");
    }
    const roles = shovelEdges.map((e) => e.flow!.role).sort();
    expect(roles).toEqual(["in", "out"]);
    // Direction is preserved by the from/to pointers — in-edges land on the
    // shovel node, out-edges leave it.
    const shovelId = "shovel:rabbit-b//a-to-b";
    for (const edge of shovelEdges) {
      if (edge.flow!.role === "in") expect(edge.to).toBe(shovelId);
      if (edge.flow!.role === "out") expect(edge.from).toBe(shovelId);
    }
  });

  it("same-host cross-vhost federation is classified cross-vhost-same-host", () => {
    const h = hostId("rabbit-a");
    const vOrders = vhostId(h, "orders");
    const vAudit = vhostId(h, "audit");
    const xOrders = exchangeId(vOrders, "orders.in");
    const xAudit = exchangeId(vAudit, "audit.in");
    const hosts: Host[] = [{ id: h, name: "rabbit-a", sourceFiles: [] }];
    const vhosts: Vhost[] = [
      { id: vOrders, hostId: h, name: "orders" },
      { id: vAudit, hostId: h, name: "audit" },
    ];
    const exchanges: Exchange[] = [
      { id: xOrders, hostId: h, vhostId: vOrders, name: "orders.in", type: "topic" },
      { id: xAudit, hostId: h, vhostId: vAudit, name: "audit.in", type: "topic" },
    ];
    const federations: FederationLink[] = [
      {
        id: "fed:rabbit-a/audit/o2a",
        hostId: h,
        vhostId: vAudit,
        name: "orders-to-audit",
        upstream: { vhost: "orders", exchange: "orders.in" },
        downstream: { vhost: "audit", exchange: "audit.in" },
      },
    ];
    const graph = buildGraph({
      hosts,
      vhosts,
      exchanges,
      queues: [],
      bindings: [],
      shovels: [],
      federations,
    });
    const fedEdges = graph.edges.filter((e) => e.kind === "federates");
    expect(fedEdges).toHaveLength(2);
    for (const edge of fedEdges) {
      expect(edge.flow!.boundary).toBe("cross-vhost-same-host");
      expect(edge.flow!.sourceHostName).toBe("rabbit-a");
      expect(edge.flow!.destinationHostName).toBe("rabbit-a");
      expect(edge.flow!.sourceVhostName).toBe("orders");
      expect(edge.flow!.destinationVhostName).toBe("audit");
      expect(edge.flow!.linkKind).toBe("federation");
    }
  });

  it("does not leak AMQP credentials through configured-flow metadata even when the shovel endpoint URI carries userinfo", () => {
    const hA = hostId("rabbit-a");
    const hB = hostId("rabbit-b");
    const vA = vhostId(hA, "/");
    const vB = vhostId(hB, "/");
    const xA = exchangeId(vA, "x.a");
    const qB = queueId(vB, "q.b");
    const hosts: Host[] = [
      { id: hA, name: "rabbit-a", sourceFiles: [] },
      { id: hB, name: "rabbit-b", sourceFiles: [] },
    ];
    const vhosts: Vhost[] = [
      { id: vA, hostId: hA, name: "/" },
      { id: vB, hostId: hB, name: "/" },
    ];
    const exchanges: Exchange[] = [
      { id: xA, hostId: hA, vhostId: vA, name: "x.a", type: "topic" },
    ];
    const queues: Queue[] = [{ id: qB, hostId: hB, vhostId: vB, name: "q.b" }];
    const USER = "shoveler";
    const PASS = "s3cret-pw";
    const rawSourceUri = `amqps://${USER}:${PASS}@rabbit-a:5671/`;
    const shovels: Shovel[] = [
      {
        id: "shovel:rabbit-b//with-creds",
        hostId: hB,
        vhostId: vB,
        name: "with-creds",
        source: {
          host: "rabbit-a",
          vhost: "/",
          exchange: "x.a",
          uri: rawSourceUri,
        },
        destination: { host: "rabbit-b", vhost: "/", queue: "q.b" },
      },
    ];
    const graph = buildGraph({
      hosts,
      vhosts,
      exchanges,
      queues,
      bindings: [],
      shovels,
      federations: [],
    });
    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain(USER);
    expect(serialized).not.toContain(PASS);
    expect(serialized).not.toContain(`${USER}:${PASS}`);
    expect(serialized).not.toContain(`${PASS}@rabbit-a`);
  });
});
