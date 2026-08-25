import { describe, expect, it } from "vitest";
import { buildGraph } from "../../../src/core/graph/buildGraph";
import { parseDefinitionsExport } from "../../../src/core/parse/definitionsParser";
import { parseRuntimeParameters } from "../../../src/core/parse/runtimeParameters";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", "..", "fixtures", "minimal-definitions.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

function tinyProject(): {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  shovels: Shovel[];
  federations: FederationLink[];
} {
  const h = hostId("rabbit-a");
  const v = vhostId(h, "/");
  const xIn = exchangeId(v, "x.in");
  const xAlt = exchangeId(v, "x.unrouted");
  const q1 = queueId(v, "q.one");
  const qDlx = queueId(v, "q.dead");
  return {
    hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
    vhosts: [{ id: v, hostId: h, name: "/" }],
    exchanges: [
      {
        id: xIn,
        hostId: h,
        vhostId: v,
        name: "x.in",
        type: "topic",
        alternateExchange: "x.unrouted",
      },
      { id: xAlt, hostId: h, vhostId: v, name: "x.unrouted", type: "fanout" },
    ],
    queues: [
      {
        id: q1,
        hostId: h,
        vhostId: v,
        name: "q.one",
        deadLetterExchange: "x.unrouted",
        deadLetterRoutingKey: "dead",
      },
      { id: qDlx, hostId: h, vhostId: v, name: "q.dead" },
    ],
    bindings: [
      {
        id: "binding:test-1",
        hostId: h,
        vhostId: v,
        sourceExchangeId: xIn,
        destinationId: q1,
        destinationType: "queue",
        routingKey: "orders.*",
      },
    ],
    shovels: [],
    federations: [],
  };
}

describe("buildGraph — containment and bindings", () => {
  const project = tinyProject();
  const graph = buildGraph(project);

  it("emits a node for every host, vhost, exchange, and queue", () => {
    const kinds = graph.nodes.map((n) => n.kind).sort();
    expect(kinds).toEqual(["exchange", "exchange", "host", "queue", "queue", "vhost"]);
  });

  it("emits contains edges from host→vhost and vhost→entity", () => {
    const contains = graph.edges.filter((e) => e.kind === "contains");
    expect(contains).toHaveLength(1 + 2 + 2); // 1 host→vhost, 2 exchanges, 2 queues
    const hostToVhost = contains.find(
      (e) => e.from === project.hosts[0]!.id && e.to === project.vhosts[0]!.id,
    );
    expect(hostToVhost).toBeDefined();
  });

  it("emits a binds edge with routing key", () => {
    const binds = graph.edges.filter((e) => e.kind === "binds");
    expect(binds).toHaveLength(1);
    expect(binds[0]!.routingKey).toBe("orders.*");
  });

  it("emits an alternate-exchange edge when the exchange exists", () => {
    const alt = graph.edges.find((e) => e.kind === "alternate-exchange");
    expect(alt).toBeDefined();
    expect(alt!.from).toBe(project.exchanges[0]!.id);
    expect(alt!.to).toBe(project.exchanges[1]!.id);
  });

  it("emits a dead-letter edge with routing key", () => {
    const dlx = graph.edges.find((e) => e.kind === "dead-letter");
    expect(dlx).toBeDefined();
    expect(dlx!.routingKey).toBe("dead");
  });
});

describe("buildGraph — unresolved alt/dlx exchanges emit diagnostics", () => {
  it("warns when alternate-exchange target is missing", () => {
    const p = tinyProject();
    p.exchanges[0]!.alternateExchange = "missing.alt";
    const graph = buildGraph(p);
    expect(
      graph.diagnostics.some((d) => d.code === "graph.alternate-exchange-unresolved"),
    ).toBe(true);
    expect(graph.edges.find((e) => e.kind === "alternate-exchange")).toBeUndefined();
  });

  it("warns when dead-letter-exchange target is missing", () => {
    const p = tinyProject();
    p.queues[0]!.deadLetterExchange = "missing.dlx";
    const graph = buildGraph(p);
    expect(
      graph.diagnostics.some((d) => d.code === "graph.dead-letter-exchange-unresolved"),
    ).toBe(true);
    expect(graph.edges.find((e) => e.kind === "dead-letter")).toBeUndefined();
  });
});

describe("buildGraph — shovels and external endpoints", () => {
  it("creates an external node when a shovel source references an unknown host", () => {
    const p = tinyProject();
    p.shovels.push({
      id: "shovel:rabbit-a/orders/sx",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "sx",
      source: {
        host: "remote-b.example.internal",
        vhost: "orders",
        exchange: "orders.out",
        uri: "amqp://REDACTED@remote-b.example.internal/orders",
      },
      destination: { exchange: "x.in" },
    });
    const graph = buildGraph(p);

    const shovelNode = graph.nodes.find((n) => n.kind === "shovel");
    expect(shovelNode?.label).toBe("sx");

    const externalNodes = graph.nodes.filter((n) => n.kind === "external");
    expect(externalNodes).toHaveLength(1);
    expect(externalNodes[0]!.label).toContain("remote-b.example.internal");

    const shovelsEdges = graph.edges.filter((e) => e.kind === "shovels");
    expect(shovelsEdges).toHaveLength(2);
    // one in-edge from external to shovel, one out-edge from shovel to local exchange
    expect(shovelsEdges[0]!.to).toBe(shovelNode!.id);
    expect(shovelsEdges[1]!.from).toBe(shovelNode!.id);
  });

  it("resolves a shovel destination to a local exchange when host+vhost+name match", () => {
    const p = tinyProject();
    p.shovels.push({
      id: "shovel:local",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "sx-local",
      source: { host: "external.example.internal", exchange: "remote-x" },
      destination: {
        host: "rabbit-a",
        vhost: "/",
        exchange: "x.in",
      },
    });
    const graph = buildGraph(p);
    const outEdge = graph.edges.find(
      (e) => e.kind === "shovels" && e.from === "shovel:local",
    );
    expect(outEdge?.to).toBe(p.exchanges[0]!.id);
  });
});

describe("buildGraph — federation", () => {
  it("emits a federation node with in/out edges to upstream and downstream", () => {
    const p = tinyProject();
    p.federations.push({
      id: "federation:local/fed",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "fed",
      upstream: { host: "remote.example.internal", vhost: "/", exchange: "orders.out" },
      downstream: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
    });
    const graph = buildGraph(p);
    const fedEdges = graph.edges.filter((e) => e.kind === "federates");
    expect(fedEdges).toHaveLength(2);
    expect(graph.nodes.find((n) => n.kind === "federation")?.label).toBe("fed");
    expect(fedEdges.find((e) => e.to === p.exchanges[0]!.id)).toBeDefined();
  });
});

describe("buildGraph — vhost containment for shovel and federation nodes", () => {
  it("emits a contains edge from vhost to shovel node", () => {
    const p = tinyProject();
    p.shovels.push({
      id: "shovel:local/sx",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "sx",
      source: { host: "external.example.internal", exchange: "remote-x" },
      destination: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
    });
    const graph = buildGraph(p);
    const contains = graph.edges.filter(
      (e) => e.kind === "contains" && e.from === p.vhosts[0]!.id && e.to === "shovel:local/sx",
    );
    expect(contains).toHaveLength(1);
  });

  it("emits a contains edge from vhost to federation node", () => {
    const p = tinyProject();
    p.federations.push({
      id: "federation:local/fed",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "fed",
      upstream: { host: "remote.example.internal", vhost: "/", exchange: "orders.out" },
      downstream: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
    });
    const graph = buildGraph(p);
    const contains = graph.edges.filter(
      (e) =>
        e.kind === "contains" &&
        e.from === p.vhosts[0]!.id &&
        e.to === "federation:local/fed",
    );
    expect(contains).toHaveLength(1);
  });
});

describe("buildGraph — external node data is credential-safe", () => {
  it("redacts AMQP URI userinfo before storing an endpoint on GraphNode.data", () => {
    const USER = "USERNAME_PLACEHOLDER";
    const PASS = "PASSWORD_PLACEHOLDER";
    const p = tinyProject();
    p.shovels.push({
      id: "shovel:local/leaky",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "leaky",
      source: {
        host: "remote-b.example.internal",
        vhost: "orders",
        exchange: "orders.out",
        uri: `amqp://${USER}:${PASS}@remote-b.example.internal/orders`,
      },
      destination: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
    });
    const graph = buildGraph(p);
    const external = graph.nodes.find((n) => n.kind === "external");
    expect(external).toBeDefined();

    const serialised = JSON.stringify(external);
    expect(serialised).not.toContain(USER);
    expect(serialised).not.toContain(PASS);
    expect(serialised).toContain("REDACTED");
  });

  it("redacts AMQP credentials on shovel node data", () => {
    const USER = "USERNAME_PLACEHOLDER";
    const PASS = "PASSWORD_PLACEHOLDER";
    const p = tinyProject();
    p.shovels.push({
      id: "shovel:local/leaky-shovel",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "leaky-shovel",
      source: {
        host: "remote.example.internal",
        exchange: "orders.out",
        uri: `amqp://${USER}:${PASS}@remote.example.internal/orders`,
      },
      destination: {
        host: "rabbit-a",
        vhost: "/",
        exchange: "x.in",
        uri: `amqp://${USER}:${PASS}@localhost/`,
      },
      arguments: {
        "src-uri": `amqp://${USER}:${PASS}@remote.example.internal/orders`,
      },
    });
    const graph = buildGraph(p);
    const shovelNode = graph.nodes.find((n) => n.kind === "shovel");
    const serialised = JSON.stringify(shovelNode);
    expect(serialised).not.toContain(USER);
    expect(serialised).not.toContain(PASS);
    expect(serialised).toContain("REDACTED");
  });

  it("redacts AMQP credentials on federation node data", () => {
    const USER = "USERNAME_PLACEHOLDER";
    const PASS = "PASSWORD_PLACEHOLDER";
    const p = tinyProject();
    p.federations.push({
      id: "federation:local/leaky-fed",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "leaky-fed",
      upstream: {
        host: "remote.example.internal",
        exchange: "orders.out",
        uri: `amqps://${USER}:${PASS}@remote.example.internal:5671/orders`,
      },
      downstream: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
      arguments: {
        uri: `amqps://${USER}:${PASS}@remote.example.internal:5671/orders`,
      },
    });
    const graph = buildGraph(p);
    const fedNode = graph.nodes.find((n) => n.kind === "federation");
    const serialised = JSON.stringify(fedNode);
    expect(serialised).not.toContain(USER);
    expect(serialised).not.toContain(PASS);
    expect(serialised).toContain("REDACTED");
  });

  it("the full serialized graph never contains raw credentials across every node/edge kind, at any nesting depth", () => {
    const USER = "USERNAME_PLACEHOLDER";
    const PASS = "PASSWORD_PLACEHOLDER";
    const raw = `amqp://${USER}:${PASS}@leaky.example.internal/orders`;
    const rawS = `amqps://${USER}:${PASS}@leaky.example.internal:5671/orders`;
    const p = tinyProject();
    // Poison host, vhost, exchange, and queue nodes via their entity data.
    p.hosts[0]!.clusterName = `see ${raw}`;
    p.exchanges[0]!.arguments = {
      "x-shovel-hint": raw,
      nested: { list: [rawS, { alt: raw }] },
      "leading-whitespace": `   ${raw}`,
    };
    p.queues[0]!.arguments = {
      "x-source-uri": raw,
      nested: { deeper: { alt: rawS } },
    };
    // Force a diagnostic whose message would embed the URI.
    p.exchanges[0]!.alternateExchange = raw;
    // Poison binding arguments (nested + embedded) + routing key.
    p.bindings[0]!.routingKey = `mirror-of ${raw}`;
    p.bindings[0]!.arguments = {
      "x-external-uri": raw,
      note: `see ${raw} for details`,
      nested: { list: [raw, { alt: rawS }] },
    };
    p.shovels.push({
      id: "shovel:local/kitchen-sink-s",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "kitchen-sink-s",
      source: {
        host: "remote-a.example.internal",
        vhost: "orders",
        exchange: "orders.out",
        uri: raw,
      },
      destination: {
        host: "rabbit-a",
        vhost: "/",
        exchange: "x.in",
        uri: `amqp://${USER}:${PASS}@localhost/`,
      },
      arguments: {
        "src-uri": raw,
        "dest-uri": `amqp://${USER}:${PASS}@localhost/`,
        nested: { deeper: { alt: rawS } },
        arr: [raw, { note: `mirror to ${raw}` }],
        "leading-whitespace": `   ${raw}`,
      },
    });
    p.federations.push({
      id: "federation:local/kitchen-sink-f",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "kitchen-sink-f",
      upstream: {
        host: "remote-b.example.internal",
        exchange: "orders.out",
        uri: rawS,
      },
      downstream: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
      arguments: {
        uri: rawS,
        nested: { list: [rawS] },
      },
    });
    const graph = buildGraph(p);
    // Confirm we actually exercised every relevant node kind + every edge kind
    // that this test poisons, plus at least one diagnostic.
    const nodeKinds = new Set(graph.nodes.map((n) => n.kind));
    expect(nodeKinds).toEqual(
      new Set(["host", "vhost", "exchange", "queue", "shovel", "federation", "external"]),
    );
    const edgeKinds = new Set(graph.edges.map((e) => e.kind));
    for (const k of ["contains", "binds", "dead-letter", "shovels", "federates"]) {
      expect(edgeKinds).toContain(k);
    }
    expect(graph.diagnostics.length).toBeGreaterThan(0);
    const full = JSON.stringify(graph);
    expect(full).not.toContain(USER);
    expect(full).not.toContain(PASS);
    expect(full).toContain("REDACTED");
  });

  it("redacts credentials embedded deeper than one level in shovel arguments (nested objects, arrays, whitespace, embedded)", () => {
    const USER = "USERNAME_PLACEHOLDER";
    const PASS = "PASSWORD_PLACEHOLDER";
    const raw = `amqp://${USER}:${PASS}@remote.example.internal/orders`;
    const p = tinyProject();
    p.shovels.push({
      id: "shovel:local/deep-leak",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "deep-leak",
      source: { host: "remote.example.internal", exchange: "orders.out" },
      destination: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
      arguments: {
        nested: { inner: { deeper: raw } },
        siblings: [raw, { alt: raw }],
        "leading-whitespace": `   ${raw}`,
        embedded: `see ${raw} for details`,
      },
    });
    const graph = buildGraph(p);
    const shovelNode = graph.nodes.find((n) => n.kind === "shovel");
    const serialised = JSON.stringify(shovelNode);
    expect(serialised).not.toContain(USER);
    expect(serialised).not.toContain(PASS);
    expect(serialised).toContain("REDACTED");
    // Sanity: the embedded prose is preserved (only the URI itself is rewritten).
    expect(serialised).toContain("see amqp://REDACTED@remote.example.internal/orders");
  });

  it("redacts credentials that appear inside binding.arguments on binds edges", () => {
    const USER = "USERNAME_PLACEHOLDER";
    const PASS = "PASSWORD_PLACEHOLDER";
    const raw = `amqp://${USER}:${PASS}@remote.example.internal/orders`;
    const p = tinyProject();
    p.bindings[0]!.arguments = {
      "x-external-uri": raw,
      note: `mirror to ${raw}`,
      nested: { extras: [raw] },
    };
    const graph = buildGraph(p);
    const bindsEdge = graph.edges.find((e) => e.kind === "binds");
    const serialised = JSON.stringify(bindsEdge);
    expect(serialised).not.toContain(USER);
    expect(serialised).not.toContain(PASS);
    expect(serialised).toContain("REDACTED");
  });

  it("redacts credentials that appear inside exchange.arguments on the exchange node", () => {
    const USER = "USERNAME_PLACEHOLDER";
    const PASS = "PASSWORD_PLACEHOLDER";
    const raw = `amqp://${USER}:${PASS}@remote.example.internal/orders`;
    const p = tinyProject();
    p.exchanges[0]!.arguments = {
      "x-shovel-hint": raw,
      nested: { note: `see ${raw}` },
    };
    const graph = buildGraph(p);
    const exNode = graph.nodes.find(
      (n) => n.kind === "exchange" && n.id === p.exchanges[0]!.id,
    );
    const serialised = JSON.stringify(exNode);
    expect(serialised).not.toContain(USER);
    expect(serialised).not.toContain(PASS);
    expect(serialised).toContain("REDACTED");
  });

  it("redacts credentials that appear inside queue.arguments on the queue node", () => {
    const USER = "USERNAME_PLACEHOLDER";
    const PASS = "PASSWORD_PLACEHOLDER";
    const raw = `amqp://${USER}:${PASS}@remote.example.internal/orders`;
    const p = tinyProject();
    p.queues[0]!.arguments = {
      "x-source-uri": raw,
      nested: { list: [raw] },
    };
    const graph = buildGraph(p);
    const qNode = graph.nodes.find(
      (n) => n.kind === "queue" && n.id === p.queues[0]!.id,
    );
    const serialised = JSON.stringify(qNode);
    expect(serialised).not.toContain(USER);
    expect(serialised).not.toContain(PASS);
    expect(serialised).toContain("REDACTED");
  });

  it("redacts credentials that appear inside a binding routing key on the binds edge", () => {
    const USER = "USERNAME_PLACEHOLDER";
    const PASS = "PASSWORD_PLACEHOLDER";
    const raw = `amqp://${USER}:${PASS}@remote.example.internal/orders`;
    const p = tinyProject();
    p.bindings[0]!.routingKey = `mirror-of ${raw}`;
    const graph = buildGraph(p);
    const bindsEdge = graph.edges.find((e) => e.kind === "binds");
    const serialised = JSON.stringify(bindsEdge);
    expect(serialised).not.toContain(USER);
    expect(serialised).not.toContain(PASS);
    expect(serialised).toContain("REDACTED");
  });

  it("redacts credentials embedded in diagnostic messages", () => {
    const USER = "USERNAME_PLACEHOLDER";
    const PASS = "PASSWORD_PLACEHOLDER";
    const raw = `amqp://${USER}:${PASS}@remote.example.internal/orders`;
    const p = tinyProject();
    // Force a graph.alternate-exchange-unresolved diagnostic whose message
    // reflects the malformed alternate-exchange name — proving that even if a
    // parser were to embed a URI in a diagnostic message, it would be redacted
    // at the boundary.
    p.exchanges[0]!.alternateExchange = raw;
    const graph = buildGraph(p);
    const diag = graph.diagnostics.find(
      (d) => d.code === "graph.alternate-exchange-unresolved",
    );
    expect(diag).toBeDefined();
    const serialised = JSON.stringify(diag);
    expect(serialised).not.toContain(USER);
    expect(serialised).not.toContain(PASS);
    expect(serialised).toContain("REDACTED");
  });

  it("redacts credentials embedded in every external-ID source field before percent-encoding", () => {
    const USER = "USERNAME_PLACEHOLDER";
    const PASS = "PASSWORD_PLACEHOLDER";
    const rawUri = `amqp://${USER}:${PASS}@example`;
    const p = tinyProject();
    // Poison every field that flows into `externalNodeId` and `externalNodeLabel`:
    // host + vhost + exchange (via one shovel), and queue (via a second shovel).
    p.shovels.push({
      id: "shovel:local/leaky-fields-ex",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "leaky-fields-ex",
      source: {
        host: rawUri,
        vhost: rawUri,
        exchange: rawUri,
      },
      destination: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
    });
    p.shovels.push({
      id: "shovel:local/leaky-fields-q",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "leaky-fields-q",
      source: {
        host: rawUri,
        vhost: rawUri,
        queue: rawUri,
      },
      destination: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
    });
    const graph = buildGraph(p);
    const externals = graph.nodes.filter((n) => n.kind === "external");
    expect(externals.length).toBeGreaterThanOrEqual(2);
    for (const ext of externals) {
      // Percent-encoded USER/PASS would still be readable — assert both raw and
      // percent-encoded forms are absent, and the redaction marker is present.
      expect(ext.id).not.toContain(USER);
      expect(ext.id).not.toContain(PASS);
      expect(ext.id).not.toContain(encodeURIComponent(USER));
      expect(ext.id).not.toContain(encodeURIComponent(PASS));
      expect(ext.id).toContain("REDACTED");
      const serialised = JSON.stringify(ext);
      expect(serialised).not.toContain(USER);
      expect(serialised).not.toContain(PASS);
    }
    const full = JSON.stringify(graph);
    expect(full).not.toContain(USER);
    expect(full).not.toContain(PASS);
    expect(full).not.toContain(encodeURIComponent(USER));
    expect(full).not.toContain(encodeURIComponent(PASS));
  });

  it("leaves an external endpoint without a URI unchanged", () => {
    const p = tinyProject();
    p.shovels.push({
      id: "shovel:local/no-uri",
      hostId: p.hosts[0]!.id,
      vhostId: p.vhosts[0]!.id,
      name: "no-uri",
      source: { host: "remote.example.internal", exchange: "remote-x" },
      destination: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
    });
    const graph = buildGraph(p);
    const external = graph.nodes.find((n) => n.kind === "external");
    expect(external?.data).toEqual({
      host: "remote.example.internal",
      exchange: "remote-x",
    });
  });
});

describe("buildGraph — end-to-end with fixture", () => {
  it("builds a coherent graph from the sanitized fixture (definitions + runtime params)", () => {
    const parsed = parseDefinitionsExport({ json: fixture, hostName: "rabbit-a" });
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
    expect(graph.nodes.filter((n) => n.kind === "host")).toHaveLength(1);
    expect(graph.nodes.filter((n) => n.kind === "vhost")).toHaveLength(2);
    expect(graph.nodes.filter((n) => n.kind === "exchange")).toHaveLength(5);
    expect(graph.nodes.filter((n) => n.kind === "queue")).toHaveLength(4);
    expect(graph.edges.filter((e) => e.kind === "binds")).toHaveLength(5);
    expect(graph.edges.filter((e) => e.kind === "shovels").length).toBeGreaterThanOrEqual(2);
    expect(graph.edges.filter((e) => e.kind === "federates").length).toBeGreaterThanOrEqual(2);
    // The shovel source references remote-host-a.example.internal, which is not a loaded host,
    // so the graph should include at least one external node.
    expect(graph.nodes.some((n) => n.kind === "external")).toBe(true);
  });
});
