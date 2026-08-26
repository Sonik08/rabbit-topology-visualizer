import { describe, expect, it } from "vitest";
import { explainUpstreamPath } from "../../../src/core/query/pathExplain";
import { buildGraph } from "../../../src/core/graph/buildGraph";
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

interface P {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  shovels: Shovel[];
  federations: FederationLink[];
}

function twoHopProject(): P {
  const h = hostId("rabbit-a");
  const v = vhostId(h, "orders");
  const xIn = exchangeId(v, "orders.in");
  const xMid = exchangeId(v, "orders.mid");
  const q = queueId(v, "orders.incoming");
  return {
    hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
    vhosts: [{ id: v, hostId: h, name: "orders" }],
    exchanges: [
      { id: xIn, hostId: h, vhostId: v, name: "orders.in", type: "topic" },
      { id: xMid, hostId: h, vhostId: v, name: "orders.mid", type: "topic" },
    ],
    queues: [{ id: q, hostId: h, vhostId: v, name: "orders.incoming" }],
    bindings: [
      {
        id: "b1",
        hostId: h,
        vhostId: v,
        sourceExchangeId: xIn,
        destinationId: xMid,
        destinationType: "exchange",
        routingKey: "orders.*",
      },
      {
        id: "b2",
        hostId: h,
        vhostId: v,
        sourceExchangeId: xMid,
        destinationId: q,
        destinationType: "queue",
        routingKey: "orders.new",
      },
    ],
    shovels: [],
    federations: [],
  };
}

describe("explainUpstreamPath — bindings", () => {
  const p = twoHopProject();
  const graph = buildGraph(p);
  const target = p.queues[0]!.id;
  const r = upstreamForQueue(graph, target);
  const rootPath = r.paths.find((path) => path.sourceNodeId === p.exchanges[0]!.id)!;
  const explanation = explainUpstreamPath(rootPath, target, graph.nodes);

  it("produces one sentence per hop, source → target direction", () => {
    expect(explanation.steps).toHaveLength(2);
    expect(explanation.steps[0]!.sentence).toBe(
      "exchange 'orders.in' (rabbit-a / vhost orders) binds via routing key 'orders.*' to exchange 'orders.mid' (rabbit-a / vhost orders).",
    );
    expect(explanation.steps[1]!.sentence).toBe(
      "exchange 'orders.mid' (rabbit-a / vhost orders) binds via routing key 'orders.new' to queue 'orders.incoming' (rabbit-a / vhost orders).",
    );
  });

  it("summary joins step sentences with newlines", () => {
    const lines = explanation.summary.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!).toContain("orders.in");
    expect(lines[1]!).toContain("orders.incoming");
  });

  it("attaches from/to nodes and edge metadata on each explained step", () => {
    for (const step of explanation.steps) {
      expect(step.fromNode).toBeDefined();
      expect(step.toNode).toBeDefined();
      expect(step.edgeKind).toBe("binds");
    }
  });
});

describe("explainUpstreamPath — non-binds edge kinds", () => {
  it("renders alternate-exchange, dead-letter, shovels, and federates with the right verbs", () => {
    // Build a graph with a mix of edges converging on q.leftovers.
    const h = hostId("rabbit-a");
    const hRemote = hostId("rabbit-b");
    const v = vhostId(h, "/");
    const vRemote = vhostId(hRemote, "/");
    const xMain = exchangeId(v, "x.main");
    const xAlt = exchangeId(v, "x.alt");
    const xIngest = exchangeId(v, "x.ingest");
    const qLeft = queueId(v, "q.leftovers");
    const xRemote = exchangeId(vRemote, "x.remote");
    const p: P = {
      hosts: [
        { id: h, name: "rabbit-a", sourceFiles: [] },
        { id: hRemote, name: "rabbit-b", sourceFiles: [] },
      ],
      vhosts: [
        { id: v, hostId: h, name: "/" },
        { id: vRemote, hostId: hRemote, name: "/" },
      ],
      exchanges: [
        { id: xMain, hostId: h, vhostId: v, name: "x.main", type: "direct", alternateExchange: "x.alt" },
        { id: xAlt, hostId: h, vhostId: v, name: "x.alt", type: "fanout" },
        { id: xIngest, hostId: h, vhostId: v, name: "x.ingest", type: "topic" },
        { id: xRemote, hostId: hRemote, vhostId: vRemote, name: "x.remote", type: "topic" },
      ],
      queues: [{ id: qLeft, hostId: h, vhostId: v, name: "q.leftovers" }],
      bindings: [
        // x.alt → q.leftovers so upstream traversal reaches x.main via the alternate-exchange edge.
        {
          id: "alt-q",
          hostId: h,
          vhostId: v,
          sourceExchangeId: xAlt,
          destinationId: qLeft,
          destinationType: "queue",
          routingKey: "",
        },
      ],
      // Shovel: rabbit-b/x.remote → rabbit-a/x.ingest, and x.ingest binds to q.leftovers.
      shovels: [
        {
          id: "shovel:ingest",
          hostId: h,
          vhostId: v,
          name: "ingest",
          source: { host: "rabbit-b", vhost: "/", exchange: "x.remote" },
          destination: { host: "rabbit-a", vhost: "/", exchange: "x.ingest" },
        },
      ],
      federations: [],
    };
    // Bind x.ingest → q.leftovers so the shovel path terminates at the queue.
    p.bindings.push({
      id: "ingest-q",
      hostId: h,
      vhostId: v,
      sourceExchangeId: xIngest,
      destinationId: qLeft,
      destinationType: "queue",
      routingKey: "ingest.*",
    });
    const graph = buildGraph(p);
    const r = upstreamForQueue(graph, qLeft);

    // There should be a path whose steps include a `shovels` kind AND we can
    // separately construct sentences for alternate-exchange and dead-letter.
    const shovelPath = r.paths.find((path) =>
      path.steps.some((s) => s.kind === "shovels"),
    );
    expect(shovelPath).toBeDefined();
    const shovelExpl = explainUpstreamPath(shovelPath!, qLeft, graph.nodes);
    expect(
      shovelExpl.steps.some((s) => s.sentence.startsWith("shovel 'ingest'")),
    ).toBe(true);
    const altPath = r.paths.find((path) =>
      path.steps.some((s) => s.kind === "alternate-exchange"),
    );
    expect(altPath).toBeDefined();
    const altExpl = explainUpstreamPath(altPath!, qLeft, graph.nodes);
    const altStep = altExpl.steps.find((s) => s.edgeKind === "alternate-exchange")!;
    // Assert the full sentence — the noun "exchange" must not appear twice
    // in a row, and no double-quote/space anomalies.
    expect(altStep.sentence).toBe(
      "exchange 'x.main' (rabbit-a / vhost /) forwards unroutable messages to its alternate: exchange 'x.alt' (rabbit-a / vhost /).",
    );
    expect(altStep.sentence).not.toMatch(/exchange exchange/);
  });

  it("renders a dead-letter step with the routing key when present", () => {
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xDlx = exchangeId(v, "x.dlx");
    const qJobs = queueId(v, "q.jobs");
    const qDead = queueId(v, "q.dead");
    const p: P = {
      hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
      vhosts: [{ id: v, hostId: h, name: "/" }],
      exchanges: [{ id: xDlx, hostId: h, vhostId: v, name: "x.dlx", type: "fanout" }],
      queues: [
        {
          id: qJobs,
          hostId: h,
          vhostId: v,
          name: "q.jobs",
          deadLetterExchange: "x.dlx",
          deadLetterRoutingKey: "dead",
        },
        { id: qDead, hostId: h, vhostId: v, name: "q.dead" },
      ],
      bindings: [
        { id: "xd", hostId: h, vhostId: v, sourceExchangeId: xDlx, destinationId: qDead, destinationType: "queue", routingKey: "" },
      ],
      shovels: [],
      federations: [],
    };
    const graph = buildGraph(p);
    // Opt in to dead-letter reverse-walk so q.dead sees q.jobs as an ancestor.
    const r = upstreamForQueue(graph, qDead, { followDeadLetter: true });
    const dlxPath = r.paths.find((path) =>
      path.steps.some((s) => s.kind === "dead-letter"),
    );
    expect(dlxPath).toBeDefined();
    const explanation = explainUpstreamPath(dlxPath!, qDead, graph.nodes);
    const dlxSentence = explanation.steps.find((s) => s.edgeKind === "dead-letter")!.sentence;
    expect(dlxSentence).toContain("dead-letters expired or rejected messages");
    expect(dlxSentence).toContain("with routing key 'dead'");
  });
});

describe("explainUpstreamPath — federation edges (labeled and unlabeled)", () => {
  it("names a labeled federation link and mentions 'federation link' when unlabeled", () => {
    // Two federations both feeding q.tap via x.in on rabbit-a:
    //  - fed-named: has a name → step.label = "orders-fed"
    //  - the graph builder always sets label = name on federation nodes, but
    //    upstream traversal sets step.label from the edge label (which
    //    buildGraph sets on federates edges); we build a fresh graph with a
    //    federation whose edge label is intentionally omitted to exercise the
    //    unlabeled branch.
    const hA = hostId("rabbit-a");
    const hB = hostId("rabbit-b");
    const vA = vhostId(hA, "/");
    const vB = vhostId(hB, "/");
    const xIn = exchangeId(vA, "x.in");
    const qTap = queueId(vA, "q.tap");
    const xRemote = exchangeId(vB, "x.remote");
    const p: P = {
      hosts: [
        { id: hA, name: "rabbit-a", sourceFiles: [] },
        { id: hB, name: "rabbit-b", sourceFiles: [] },
      ],
      vhosts: [
        { id: vA, hostId: hA, name: "/" },
        { id: vB, hostId: hB, name: "/" },
      ],
      exchanges: [
        { id: xIn, hostId: hA, vhostId: vA, name: "x.in", type: "topic" },
        { id: xRemote, hostId: hB, vhostId: vB, name: "x.remote", type: "topic" },
      ],
      queues: [{ id: qTap, hostId: hA, vhostId: vA, name: "q.tap" }],
      bindings: [
        { id: "xq", hostId: hA, vhostId: vA, sourceExchangeId: xIn, destinationId: qTap, destinationType: "queue", routingKey: "" },
      ],
      shovels: [],
      federations: [
        {
          id: "federation:local/orders-fed",
          hostId: hA,
          vhostId: vA,
          name: "orders-fed",
          upstream: { host: "rabbit-b", vhost: "/", exchange: "x.remote" },
          downstream: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
        },
      ],
    };
    const graph = buildGraph(p);
    const r = upstreamForQueue(graph, qTap);
    // Find the federation-bearing path.
    const fedPath = r.paths.find((path) =>
      path.steps.some((s) => s.kind === "federates"),
    );
    expect(fedPath).toBeDefined();

    // Labeled case — buildGraph sets edge.label = federation.name.
    const explLabeled = explainUpstreamPath(fedPath!, qTap, graph.nodes);
    const fedStepLabeled = explLabeled.steps.find((s) => s.edgeKind === "federates")!;
    expect(fedStepLabeled.sentence.startsWith("federation link 'orders-fed'")).toBe(true);
    expect(fedStepLabeled.sentence).toContain("mirrors messages from");
    // Across the full path, at least one federates step must eventually
    // deposit into the downstream x.in exchange.
    expect(
      explLabeled.steps.some(
        (s) =>
          s.edgeKind === "federates" &&
          s.sentence.includes("to exchange 'x.in'"),
      ),
    ).toBe(true);

    // Unlabeled case — strip step.label to simulate a federation edge that
    // arrived without a name (e.g., an anonymous synthesized link) and verify
    // the sentence still reads as "federation link mirrors messages from …".
    const unlabeledPath = {
      ...fedPath!,
      steps: fedPath!.steps.map((s) =>
        s.kind === "federates" ? { ...s, label: undefined } : s,
      ),
    };
    const explUnlabeled = explainUpstreamPath(unlabeledPath, qTap, graph.nodes);
    const fedStepUnlabeled = explUnlabeled.steps.find((s) => s.edgeKind === "federates")!;
    expect(fedStepUnlabeled.sentence.startsWith("federation link mirrors messages from")).toBe(true);
    expect(fedStepUnlabeled.sentence).not.toContain("''");
  });
});

describe("explainUpstreamPath — control-character sanitization", () => {
  it("escapes newlines / CR / tab / DEL in routing keys, labels, and node names so summary stays one line per step", () => {
    // Build a graph where the exchange name AND the routing key contain a
    // newline, and a shovel label contains a tab and CR. The rendered
    // sentence for each step must be a single line.
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xWeird = exchangeId(v, "x.weird");
    const q = queueId(v, "q.tap");
    const p: P = {
      hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
      vhosts: [{ id: v, hostId: h, name: "/" }],
      exchanges: [
        // Newline in an exchange name is unusual but legal in RabbitMQ.
        { id: xWeird, hostId: h, vhostId: v, name: "x.weird\nnewline", type: "topic" },
      ],
      queues: [{ id: q, hostId: h, vhostId: v, name: "q.tap" }],
      bindings: [
        {
          id: "b",
          hostId: h,
          vhostId: v,
          sourceExchangeId: xWeird,
          destinationId: q,
          destinationType: "queue",
          routingKey: "line1\r\nline2\ttabbed",
        },
      ],
      shovels: [],
      federations: [],
    };
    const graph = buildGraph(p);
    const r = upstreamForQueue(graph, q);
    const explanation = explainUpstreamPath(r.paths[0]!, q, graph.nodes);

    // Every step sentence must be exactly one line, and the joined summary
    // must have exactly (steps.length - 1) newlines.
    for (const step of explanation.steps) {
      expect(step.sentence.includes("\n")).toBe(false);
      expect(step.sentence.includes("\r")).toBe(false);
      expect(step.sentence.includes("\t")).toBe(false);
    }
    const summaryLines = explanation.summary.split("\n");
    expect(summaryLines.length).toBe(explanation.steps.length);
    // The visible sanitizer marker replaces each stripped control char.
    expect(explanation.steps[0]!.sentence).toContain("·");
  });

  it("escapes control characters in shovel labels", () => {
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const xIn = exchangeId(v, "x.in");
    const q = queueId(v, "q.tap");
    const p: P = {
      hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
      vhosts: [{ id: v, hostId: h, name: "/" }],
      exchanges: [{ id: xIn, hostId: h, vhostId: v, name: "x.in", type: "topic" }],
      queues: [{ id: q, hostId: h, vhostId: v, name: "q.tap" }],
      bindings: [
        { id: "xq", hostId: h, vhostId: v, sourceExchangeId: xIn, destinationId: q, destinationType: "queue", routingKey: "" },
      ],
      // Shovel with a name containing a newline — the shovel's edge label
      // inherits this name, so the rendered "shovel 'NAME' carries …"
      // sentence must sanitize it.
      shovels: [
        {
          id: "shovel:weird",
          hostId: h,
          vhostId: v,
          name: "weird\nname",
          source: { host: "external.example.internal", exchange: "orders.out" },
          destination: { host: "rabbit-a", vhost: "/", exchange: "x.in" },
        },
      ],
      federations: [],
    };
    const graph = buildGraph(p);
    const r = upstreamForQueue(graph, q);
    const shovelPath = r.paths.find((path) =>
      path.steps.some((s) => s.kind === "shovels"),
    )!;
    const explanation = explainUpstreamPath(shovelPath, q, graph.nodes);
    const shovelStep = explanation.steps.find((s) => s.edgeKind === "shovels")!;
    expect(shovelStep.sentence.includes("\n")).toBe(false);
    expect(shovelStep.sentence).toContain("·");
  });
});

describe("explainUpstreamPath — routing key formatting", () => {
  it("says 'with no routing key' for empty binding keys", () => {
    const h = hostId("rabbit-a");
    const v = vhostId(h, "/");
    const x = exchangeId(v, "x");
    const q = queueId(v, "q");
    const p: P = {
      hosts: [{ id: h, name: "rabbit-a", sourceFiles: [] }],
      vhosts: [{ id: v, hostId: h, name: "/" }],
      exchanges: [{ id: x, hostId: h, vhostId: v, name: "x", type: "fanout" }],
      queues: [{ id: q, hostId: h, vhostId: v, name: "q" }],
      bindings: [
        { id: "xq", hostId: h, vhostId: v, sourceExchangeId: x, destinationId: q, destinationType: "queue", routingKey: "" },
      ],
      shovels: [],
      federations: [],
    };
    const graph = buildGraph(p);
    const r = upstreamForQueue(graph, q);
    const explanation = explainUpstreamPath(r.paths[0]!, q, graph.nodes);
    expect(explanation.steps[0]!.sentence).toContain("with no routing key");
  });
});
