import type {
  EndpointRef,
  Exchange,
  FederationLink,
  GraphNode,
  Host,
  Queue,
  Shovel,
  Vhost,
} from "../../core/model";

export interface EntityDetailRow {
  key: string;
  value: string;
}

export interface EntityDetailSection {
  heading: string;
  rows: EntityDetailRow[];
}

export interface EntityDetailView {
  title: string;
  kindLabel: string;
  sections: EntityDetailSection[];
}

/**
 * Structured, presentation-ready details for a selected graph node. Purely
 * functional so the React component stays tiny and the same output can be
 * asserted in unit tests. Every string value is taken from the sanitized
 * node data attached by `buildGraph`, so credentials in AMQP URIs have
 * already been redacted before reaching this layer.
 */
export function describeEntity(node: GraphNode): EntityDetailView {
  switch (node.kind) {
    case "host":
      return describeHost(node);
    case "vhost":
      return describeVhost(node);
    case "exchange":
      return describeExchange(node);
    case "queue":
      return describeQueue(node);
    case "shovel":
      return describeShovel(node);
    case "federation":
      return describeFederation(node);
    case "external":
      return describeExternal(node);
    default:
      return {
        title: node.label,
        kindLabel: String(node.kind),
        sections: [],
      };
  }
}

function describeHost(node: GraphNode): EntityDetailView {
  const host = (node.data as Partial<Host> | undefined) ?? {};
  const rows: EntityDetailRow[] = [
    { key: "Name", value: host.name ?? node.label },
    { key: "Host id", value: host.id ?? node.id },
  ];
  if (host.clusterName) rows.push({ key: "Cluster", value: host.clusterName });
  if (host.environment) rows.push({ key: "Environment", value: host.environment });
  if (host.sourceFiles && host.sourceFiles.length > 0) {
    rows.push({ key: "Source files", value: String(host.sourceFiles.length) });
  }
  return { title: node.label, kindLabel: "Host", sections: [{ heading: "Host", rows }] };
}

function describeVhost(node: GraphNode): EntityDetailView {
  const vhost = (node.data as Partial<Vhost> | undefined) ?? {};
  const rows: EntityDetailRow[] = [
    { key: "Name", value: vhost.name ?? node.label },
    { key: "Vhost id", value: vhost.id ?? node.id },
  ];
  if (vhost.hostId) rows.push({ key: "Host id", value: vhost.hostId });
  return { title: node.label, kindLabel: "Vhost", sections: [{ heading: "Vhost", rows }] };
}

function describeExchange(node: GraphNode): EntityDetailView {
  const ex = (node.data as Partial<Exchange> | undefined) ?? {};
  const rows: EntityDetailRow[] = [
    { key: "Name", value: ex.name ?? node.label },
    { key: "Type", value: String(ex.type ?? "unknown") },
    { key: "Durable", value: formatBool(ex.durable, true) },
    { key: "Auto-delete", value: formatBool(ex.autoDelete, false) },
    { key: "Internal", value: formatBool(ex.internal, false) },
  ];
  if (ex.alternateExchange) {
    rows.push({ key: "Alternate exchange", value: ex.alternateExchange });
  }
  if (ex.hostId) rows.push({ key: "Host id", value: ex.hostId });
  if (ex.vhostId) rows.push({ key: "Vhost id", value: ex.vhostId });

  const sections: EntityDetailSection[] = [{ heading: "Exchange", rows }];
  const args = argumentRows(ex.arguments);
  if (args.length > 0) sections.push({ heading: "Arguments", rows: args });
  return { title: node.label, kindLabel: "Exchange", sections };
}

function describeQueue(node: GraphNode): EntityDetailView {
  const q = (node.data as Partial<Queue> | undefined) ?? {};
  const rows: EntityDetailRow[] = [
    { key: "Name", value: q.name ?? node.label },
    { key: "Durable", value: formatBool(q.durable, true) },
    { key: "Exclusive", value: formatBool(q.exclusive, false) },
    { key: "Auto-delete", value: formatBool(q.autoDelete, false) },
  ];
  if (q.deadLetterExchange) {
    rows.push({ key: "Dead-letter exchange", value: q.deadLetterExchange });
  }
  if (q.deadLetterRoutingKey) {
    rows.push({ key: "Dead-letter routing key", value: q.deadLetterRoutingKey });
  }
  if (q.hostId) rows.push({ key: "Host id", value: q.hostId });
  if (q.vhostId) rows.push({ key: "Vhost id", value: q.vhostId });

  const sections: EntityDetailSection[] = [{ heading: "Queue", rows }];
  const args = argumentRows(q.arguments);
  if (args.length > 0) sections.push({ heading: "Arguments", rows: args });
  return { title: node.label, kindLabel: "Queue", sections };
}

function describeShovel(node: GraphNode): EntityDetailView {
  const shovel = (node.data as Partial<Shovel> | undefined) ?? {};
  const overview: EntityDetailRow[] = [
    { key: "Name", value: shovel.name ?? node.label },
  ];
  if (shovel.ackMode) overview.push({ key: "Ack mode", value: shovel.ackMode });
  if (shovel.reconnectDelay !== undefined) {
    overview.push({ key: "Reconnect delay (s)", value: String(shovel.reconnectDelay) });
  }
  if (shovel.hostId) overview.push({ key: "Host id", value: shovel.hostId });
  if (shovel.vhostId) overview.push({ key: "Vhost id", value: shovel.vhostId });

  const sections: EntityDetailSection[] = [{ heading: "Shovel", rows: overview }];
  if (shovel.source) {
    sections.push({ heading: "Source", rows: endpointRows(shovel.source) });
  }
  if (shovel.destination) {
    sections.push({ heading: "Destination", rows: endpointRows(shovel.destination) });
  }
  const args = argumentRows(shovel.arguments);
  if (args.length > 0) sections.push({ heading: "Arguments", rows: args });
  return { title: node.label, kindLabel: "Shovel", sections };
}

function describeFederation(node: GraphNode): EntityDetailView {
  const fed = (node.data as Partial<FederationLink> | undefined) ?? {};
  const overview: EntityDetailRow[] = [
    { key: "Name", value: fed.name ?? node.label },
  ];
  if (fed.exchange) overview.push({ key: "Federated exchange", value: fed.exchange });
  if (fed.queue) overview.push({ key: "Federated queue", value: fed.queue });
  if (fed.routingKey) overview.push({ key: "Routing key", value: fed.routingKey });
  if (fed.hostId) overview.push({ key: "Host id", value: fed.hostId });
  if (fed.vhostId) overview.push({ key: "Vhost id", value: fed.vhostId });

  const sections: EntityDetailSection[] = [{ heading: "Federation", rows: overview }];
  if (fed.upstream) {
    sections.push({ heading: "Upstream", rows: endpointRows(fed.upstream) });
  }
  if (fed.downstream) {
    sections.push({ heading: "Downstream", rows: endpointRows(fed.downstream) });
  }
  const args = argumentRows(fed.arguments);
  if (args.length > 0) sections.push({ heading: "Arguments", rows: args });
  return { title: node.label, kindLabel: "Federation", sections };
}

function describeExternal(node: GraphNode): EntityDetailView {
  const ref = (node.data as EndpointRef | undefined) ?? {};
  return {
    title: node.label,
    kindLabel: "External endpoint",
    sections: [{ heading: "External endpoint", rows: endpointRows(ref) }],
  };
}

function endpointRows(ref: EndpointRef): EntityDetailRow[] {
  const rows: EntityDetailRow[] = [];
  if (ref.host) rows.push({ key: "Host", value: ref.host });
  if (ref.vhost) rows.push({ key: "Vhost", value: ref.vhost });
  if (ref.exchange) rows.push({ key: "Exchange", value: ref.exchange });
  if (ref.queue) rows.push({ key: "Queue", value: ref.queue });
  if (ref.uri) rows.push({ key: "URI", value: ref.uri });
  if (ref.unresolved) rows.push({ key: "Unresolved", value: "true" });
  return rows;
}

function argumentRows(args: Record<string, unknown> | undefined): EntityDetailRow[] {
  if (!args) return [];
  const rows: EntityDetailRow[] = [];
  for (const [key, value] of Object.entries(args)) {
    rows.push({ key, value: formatArgumentValue(value) });
  }
  return rows;
}

function formatArgumentValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function formatBool(value: unknown, defaultTrue: boolean): string {
  if (value === undefined) return defaultTrue ? "true (default)" : "false (default)";
  return value ? "true" : "false";
}
