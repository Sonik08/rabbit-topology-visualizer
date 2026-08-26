import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../../src/core/model";
import { describeEntity } from "../../../src/ui/components/entityDetails";

function rowMap(view: ReturnType<typeof describeEntity>): Map<string, string> {
  const out = new Map<string, string>();
  for (const section of view.sections) {
    for (const row of section.rows) out.set(`${section.heading}/${row.key}`, row.value);
  }
  return out;
}

describe("describeEntity", () => {
  it("renders a host with cluster, environment, and source-file count", () => {
    const node: GraphNode = {
      id: "host:a",
      kind: "host",
      label: "rabbit-a",
      data: {
        id: "host:a",
        name: "rabbit-a",
        clusterName: "primary",
        environment: "prod",
        sourceFiles: ["sf:1", "sf:2", "sf:3"],
      },
    };
    const view = describeEntity(node);
    expect(view.kindLabel).toBe("Host");
    const rows = rowMap(view);
    expect(rows.get("Host/Name")).toBe("rabbit-a");
    expect(rows.get("Host/Cluster")).toBe("primary");
    expect(rows.get("Host/Environment")).toBe("prod");
    expect(rows.get("Host/Source files")).toBe("3");
  });

  it("renders an exchange with type, defaults, alternate-exchange, and arguments", () => {
    const node: GraphNode = {
      id: "exchange:a:x1",
      kind: "exchange",
      label: "orders",
      data: {
        id: "exchange:a:x1",
        hostId: "host:a",
        vhostId: "vhost:a:/",
        name: "orders",
        type: "topic",
        durable: true,
        alternateExchange: "orders.dlx",
        arguments: { "x-delayed-type": "topic" },
      },
    };
    const view = describeEntity(node);
    expect(view.kindLabel).toBe("Exchange");
    expect(view.sections.map((s) => s.heading)).toEqual(["Exchange", "Arguments"]);
    const rows = rowMap(view);
    expect(rows.get("Exchange/Type")).toBe("topic");
    expect(rows.get("Exchange/Durable")).toBe("true");
    // Undefined booleans render with an explicit default marker.
    expect(rows.get("Exchange/Auto-delete")).toBe("false (default)");
    expect(rows.get("Exchange/Alternate exchange")).toBe("orders.dlx");
    expect(rows.get("Arguments/x-delayed-type")).toBe("topic");
  });

  it("renders a queue with dead-letter details and typed arguments", () => {
    const node: GraphNode = {
      id: "queue:a:q1",
      kind: "queue",
      label: "audit",
      data: {
        id: "queue:a:q1",
        hostId: "host:a",
        vhostId: "vhost:a:/",
        name: "audit",
        durable: true,
        deadLetterExchange: "audit.dlx",
        deadLetterRoutingKey: "poison",
        arguments: { "x-queue-type": "quorum", "x-max-length": 100000 },
      },
    };
    const view = describeEntity(node);
    const rows = rowMap(view);
    expect(rows.get("Queue/Dead-letter exchange")).toBe("audit.dlx");
    expect(rows.get("Queue/Dead-letter routing key")).toBe("poison");
    expect(rows.get("Arguments/x-queue-type")).toBe("quorum");
    // Numbers stringify without JSON quoting.
    expect(rows.get("Arguments/x-max-length")).toBe("100000");
  });

  it("renders a shovel with source, destination, and preserves already-redacted URIs", () => {
    const node: GraphNode = {
      id: "shovel:a:s1",
      kind: "shovel",
      label: "orders-forwarder",
      data: {
        id: "shovel:a:s1",
        hostId: "host:a",
        vhostId: "vhost:a:/",
        name: "orders-forwarder",
        ackMode: "on-confirm",
        reconnectDelay: 5,
        source: { host: "rabbit-a", vhost: "/", exchange: "orders" },
        destination: {
          host: "rabbit-b",
          vhost: "/",
          queue: "orders.mirror",
          // buildGraph already redacted this URI upstream — the details layer
          // just passes it through, so credentials never appear in the panel.
          uri: "amqp://REDACTED@rabbit-b:5672/%2F",
        },
      },
    };
    const view = describeEntity(node);
    expect(view.kindLabel).toBe("Shovel");
    expect(view.sections.map((s) => s.heading)).toEqual([
      "Shovel",
      "Source",
      "Destination",
    ]);
    const rows = rowMap(view);
    expect(rows.get("Shovel/Ack mode")).toBe("on-confirm");
    expect(rows.get("Shovel/Reconnect delay (s)")).toBe("5");
    expect(rows.get("Source/Exchange")).toBe("orders");
    expect(rows.get("Destination/Queue")).toBe("orders.mirror");
    expect(rows.get("Destination/URI")).toBe("amqp://REDACTED@rabbit-b:5672/%2F");
  });

  it("renders a federation with upstream/downstream and federated exchange/queue", () => {
    const node: GraphNode = {
      id: "fed:a:f1",
      kind: "federation",
      label: "orders-upstream",
      data: {
        id: "fed:a:f1",
        hostId: "host:a",
        vhostId: "vhost:a:/",
        name: "orders-upstream",
        exchange: "orders",
        upstream: { host: "rabbit-upstream", vhost: "/" },
        downstream: { host: "rabbit-a", vhost: "/" },
      },
    };
    const view = describeEntity(node);
    const rows = rowMap(view);
    expect(rows.get("Federation/Federated exchange")).toBe("orders");
    expect(rows.get("Upstream/Host")).toBe("rabbit-upstream");
    expect(rows.get("Downstream/Host")).toBe("rabbit-a");
  });

  it("renders an external endpoint using the redacted EndpointRef fields", () => {
    const node: GraphNode = {
      id: "external:...",
      kind: "external",
      label: "queue orders.mirror @ rabbit-b//",
      data: { host: "rabbit-b", vhost: "/", queue: "orders.mirror", unresolved: true },
    };
    const view = describeEntity(node);
    expect(view.kindLabel).toBe("External endpoint");
    const rows = rowMap(view);
    expect(rows.get("External endpoint/Host")).toBe("rabbit-b");
    expect(rows.get("External endpoint/Queue")).toBe("orders.mirror");
    expect(rows.get("External endpoint/Unresolved")).toBe("true");
  });
});
