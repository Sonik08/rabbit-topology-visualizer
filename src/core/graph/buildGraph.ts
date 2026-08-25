import type {
  Binding,
  Diagnostic,
  EndpointRef,
  Exchange,
  FederationLink,
  GraphEdge,
  GraphNode,
  Host,
  Queue,
  Shovel,
  Vhost,
} from "../model";
import { redactAmqpUri } from "../parse/amqpUri";

export interface BuildGraphInput {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  shovels: Shovel[];
  federations: FederationLink[];
}

export interface BuildGraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

const EXTERNAL_PREFIX = "external:";

function encodeSegment(value: string | undefined): string {
  return encodeURIComponent(value ?? "");
}

/**
 * Every source field for an external node id/label is a free-form string that
 * could itself embed an AMQP URI (a caller might mistakenly stuff a full
 * connection string with userinfo into `ref.host`). We redact each segment
 * *before* percent-encoding, because encoding would obscure the URI shape
 * from the final `deepSanitize` regex pass.
 */
function safeSegment(value: string | undefined): string {
  if (value === undefined) return "";
  return redactStringDeep(value);
}

function externalNodeId(ref: EndpointRef): string {
  const host = safeSegment(ref.host) || "unknown-host";
  const vhost = safeSegment(ref.vhost);
  const target = ref.exchange
    ? `x:${safeSegment(ref.exchange)}`
    : ref.queue
      ? `q:${safeSegment(ref.queue)}`
      : "";
  const parts = [host, vhost, target];
  return `${EXTERNAL_PREFIX}${parts.map(encodeSegment).join("/")}`;
}

/**
 * Returns a copy of the endpoint with any AMQP URI userinfo redacted, so the
 * value can safely be stored on `GraphNode.data` and exposed to the UI without
 * leaking credentials that might still be present in a raw `EndpointRef`.
 */
function sanitizeEndpointRef(ref: EndpointRef): EndpointRef {
  if (!ref.uri) return { ...ref };
  return { ...ref, uri: redactAmqpUri(ref.uri) };
}

/**
 * Replaces every `amqp://…` or `amqps://…` substring inside a string with a
 * credential-redacted copy. Works regardless of position (leading whitespace,
 * embedded in a longer sentence, wrapped by punctuation) — the match runs up to
 * the next whitespace character, which is the standard URI terminator.
 */
function redactStringDeep(input: string): string {
  return input.replace(/amqps?:\/\/\S+/gi, (match) => redactAmqpUri(match));
}

/**
 * Deep copy of any value with AMQP userinfo redacted from every reachable
 * string. Walks arrays and plain objects. Non-plain objects and primitives
 * (numbers, booleans, null, undefined) are returned unchanged.
 */
function deepSanitize<T>(value: T): T {
  if (typeof value === "string") {
    return redactStringDeep(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepSanitize(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepSanitize(v);
    }
    return out as unknown as T;
  }
  return value;
}

function sanitizeArguments(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (args === undefined) return undefined;
  return deepSanitize(args);
}

function sanitizeShovel(shovel: Shovel): Shovel {
  return {
    ...shovel,
    source: sanitizeEndpointRef(shovel.source),
    destination: sanitizeEndpointRef(shovel.destination),
    arguments: sanitizeArguments(shovel.arguments),
  };
}

function sanitizeFederation(fed: FederationLink): FederationLink {
  return {
    ...fed,
    upstream: sanitizeEndpointRef(fed.upstream),
    downstream: sanitizeEndpointRef(fed.downstream),
    arguments: sanitizeArguments(fed.arguments),
  };
}

function externalNodeLabel(ref: EndpointRef): string {
  // Same reasoning as `safeSegment` in `externalNodeId`: each free-form field
  // is redacted before it is concatenated with punctuation (`/`, ` @ `), so a
  // nested URI cannot ride along inside another matched URI's tail.
  const host = safeSegment(ref.host);
  const vhost = safeSegment(ref.vhost);
  const exchange = safeSegment(ref.exchange);
  const queue = safeSegment(ref.queue);
  const target = exchange
    ? `exchange ${exchange}`
    : queue
      ? `queue ${queue}`
      : "endpoint";
  const location = [host, vhost].filter(Boolean).join("/") || "unknown";
  return `${target} @ ${location}`;
}

/**
 * Builds graph nodes and edges from canonical topology entities. Every exchange,
 * queue, shovel, and federation is emitted as a node. `contains` edges express
 * the host → vhost → entity tree. Bindings produce `binds` edges (with routing
 * key). Alternate-exchange and dead-letter arguments produce their own edge
 * kinds. Shovel and federation endpoints link either to a matching in-project
 * entity or to a synthesized `external` node.
 */
export function buildGraph(input: BuildGraphInput): BuildGraphResult {
  const diagnostics: Diagnostic[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();

  const addNode = (node: GraphNode): void => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };

  const seenEdges = new Set<string>();
  const addEdge = (edge: GraphEdge): void => {
    if (seenEdges.has(edge.id)) return;
    seenEdges.add(edge.id);
    edges.push(edge);
  };

  for (const host of input.hosts) {
    addNode({ id: host.id, kind: "host", label: host.name, data: host });
  }
  for (const vhost of input.vhosts) {
    addNode({ id: vhost.id, kind: "vhost", label: vhost.name, data: vhost });
    addEdge({
      id: `contains:${vhost.hostId}->${vhost.id}`,
      from: vhost.hostId,
      to: vhost.id,
      kind: "contains",
    });
  }

  for (const ex of input.exchanges) {
    addNode({ id: ex.id, kind: "exchange", label: ex.name, data: ex });
    addEdge({
      id: `contains:${ex.vhostId}->${ex.id}`,
      from: ex.vhostId,
      to: ex.id,
      kind: "contains",
    });
  }

  for (const q of input.queues) {
    addNode({ id: q.id, kind: "queue", label: q.name, data: q });
    addEdge({
      id: `contains:${q.vhostId}->${q.id}`,
      from: q.vhostId,
      to: q.id,
      kind: "contains",
    });
  }

  const exchangeByVhostName = new Map<string, Exchange>();
  for (const ex of input.exchanges) {
    exchangeByVhostName.set(`${ex.vhostId}|${ex.name}`, ex);
  }
  const queueByVhostName = new Map<string, Queue>();
  for (const q of input.queues) {
    queueByVhostName.set(`${q.vhostId}|${q.name}`, q);
  }
  const vhostById = new Map(input.vhosts.map((v) => [v.id, v] as const));
  const hostByName = new Map(input.hosts.map((h) => [h.name, h] as const));
  const hostByNameLower = new Map(
    input.hosts.map((h) => [h.name.toLowerCase(), h] as const),
  );

  for (const binding of input.bindings) {
    addEdge({
      id: binding.id,
      from: binding.sourceExchangeId,
      to: binding.destinationId,
      kind: "binds",
      routingKey: binding.routingKey,
      arguments: sanitizeArguments(binding.arguments),
    });
  }

  for (const ex of input.exchanges) {
    if (!ex.alternateExchange) continue;
    const target = exchangeByVhostName.get(`${ex.vhostId}|${ex.alternateExchange}`);
    if (!target) {
      diagnostics.push({
        severity: "warning",
        code: "graph.alternate-exchange-unresolved",
        message: `Exchange '${ex.name}' declares alternate-exchange '${ex.alternateExchange}' but no matching exchange was loaded in the same vhost.`,
        hostId: ex.hostId,
        vhostId: ex.vhostId,
        entityId: ex.id,
      });
      continue;
    }
    addEdge({
      id: `alt:${ex.id}->${target.id}`,
      from: ex.id,
      to: target.id,
      kind: "alternate-exchange",
    });
  }

  for (const q of input.queues) {
    if (!q.deadLetterExchange) continue;
    const target = exchangeByVhostName.get(`${q.vhostId}|${q.deadLetterExchange}`);
    if (!target) {
      diagnostics.push({
        severity: "warning",
        code: "graph.dead-letter-exchange-unresolved",
        message: `Queue '${q.name}' declares dead-letter exchange '${q.deadLetterExchange}' but no matching exchange was loaded in the same vhost.`,
        hostId: q.hostId,
        vhostId: q.vhostId,
        entityId: q.id,
      });
      continue;
    }
    addEdge({
      id: `dlx:${q.id}->${target.id}`,
      from: q.id,
      to: target.id,
      kind: "dead-letter",
      routingKey: q.deadLetterRoutingKey,
    });
  }

  const resolveEndpoint = (
    ref: EndpointRef,
    contextVhostId: string,
  ): { id: string; created: boolean } => {
    const localMatch =
      ref.exchange && (!ref.host || matchesLocalHost(ref, input.hosts, hostByName, hostByNameLower, vhostById, contextVhostId))
        ? findLocalExchange(ref, input, exchangeByVhostName, hostByNameLower, vhostById, contextVhostId)
        : ref.queue && (!ref.host || matchesLocalHost(ref, input.hosts, hostByName, hostByNameLower, vhostById, contextVhostId))
          ? findLocalQueue(ref, input, queueByVhostName, hostByNameLower, vhostById, contextVhostId)
          : undefined;
    if (localMatch) return { id: localMatch, created: false };
    const id = externalNodeId(ref);
    addNode({
      id,
      kind: "external",
      label: externalNodeLabel(ref),
      data: sanitizeEndpointRef(ref),
    });
    return { id, created: true };
  };

  for (const shovel of input.shovels) {
    addNode({
      id: shovel.id,
      kind: "shovel",
      label: shovel.name,
      data: sanitizeShovel(shovel),
    });
    addEdge({
      id: `contains:${shovel.vhostId}->${shovel.id}`,
      from: shovel.vhostId,
      to: shovel.id,
      kind: "contains",
    });
    const src = resolveEndpoint(shovel.source, shovel.vhostId);
    const dst = resolveEndpoint(shovel.destination, shovel.vhostId);
    addEdge({
      id: `shovel-in:${shovel.id}<-${src.id}`,
      from: src.id,
      to: shovel.id,
      kind: "shovels",
      label: shovel.name,
    });
    addEdge({
      id: `shovel-out:${shovel.id}->${dst.id}`,
      from: shovel.id,
      to: dst.id,
      kind: "shovels",
      label: shovel.name,
    });
  }

  for (const fed of input.federations) {
    addNode({
      id: fed.id,
      kind: "federation",
      label: fed.name,
      data: sanitizeFederation(fed),
    });
    addEdge({
      id: `contains:${fed.vhostId}->${fed.id}`,
      from: fed.vhostId,
      to: fed.id,
      kind: "contains",
    });
    const up = resolveEndpoint(fed.upstream, fed.vhostId);
    const down = resolveEndpoint(fed.downstream, fed.vhostId);
    addEdge({
      id: `fed-in:${fed.id}<-${up.id}`,
      from: up.id,
      to: fed.id,
      kind: "federates",
      label: fed.name,
    });
    addEdge({
      id: `fed-out:${fed.id}->${down.id}`,
      from: fed.id,
      to: down.id,
      kind: "federates",
      label: fed.name,
    });
  }

  // Final defensive gate: every reachable string in every node / edge /
  // diagnostic runs through `deepSanitize`, so no matter what a caller passes
  // in — canonical entities, endpoint refs, routing keys, labels, or diagnostic
  // messages — any AMQP URI userinfo is redacted before it leaves the boundary.
  return {
    nodes: nodes.map((n) => deepSanitize(n)),
    edges: edges.map((e) => deepSanitize(e)),
    diagnostics: diagnostics.map((d) => deepSanitize(d)),
  };
}

function matchesLocalHost(
  ref: EndpointRef,
  hosts: Host[],
  hostByName: Map<string, Host>,
  hostByNameLower: Map<string, Host>,
  vhostById: Map<string, Vhost>,
  contextVhostId: string,
): boolean {
  if (!ref.host) return true;
  if (hostByName.has(ref.host)) return true;
  if (hostByNameLower.has(ref.host.toLowerCase())) return true;
  const contextVhost = vhostById.get(contextVhostId);
  if (contextVhost) {
    const host = hosts.find((h) => h.id === contextVhost.hostId);
    if (host && host.name.toLowerCase() === ref.host.toLowerCase()) return true;
  }
  return false;
}

function findLocalExchange(
  ref: EndpointRef,
  input: BuildGraphInput,
  exchangeByVhostName: Map<string, Exchange>,
  hostByNameLower: Map<string, Host>,
  vhostById: Map<string, Vhost>,
  contextVhostId: string,
): string | undefined {
  const exchangeName = ref.exchange;
  if (!exchangeName) return undefined;
  const hostCandidate = resolveHostCandidate(ref, input, hostByNameLower, vhostById, contextVhostId);
  if (!hostCandidate) return undefined;
  const vhostName = ref.vhost ?? vhostById.get(contextVhostId)?.name ?? "/";
  const vhost = input.vhosts.find(
    (v) => v.hostId === hostCandidate.id && v.name === vhostName,
  );
  if (!vhost) return undefined;
  return exchangeByVhostName.get(`${vhost.id}|${exchangeName}`)?.id;
}

function findLocalQueue(
  ref: EndpointRef,
  input: BuildGraphInput,
  queueByVhostName: Map<string, Queue>,
  hostByNameLower: Map<string, Host>,
  vhostById: Map<string, Vhost>,
  contextVhostId: string,
): string | undefined {
  const queueName = ref.queue;
  if (!queueName) return undefined;
  const hostCandidate = resolveHostCandidate(ref, input, hostByNameLower, vhostById, contextVhostId);
  if (!hostCandidate) return undefined;
  const vhostName = ref.vhost ?? vhostById.get(contextVhostId)?.name ?? "/";
  const vhost = input.vhosts.find(
    (v) => v.hostId === hostCandidate.id && v.name === vhostName,
  );
  if (!vhost) return undefined;
  return queueByVhostName.get(`${vhost.id}|${queueName}`)?.id;
}

function resolveHostCandidate(
  ref: EndpointRef,
  input: BuildGraphInput,
  hostByNameLower: Map<string, Host>,
  vhostById: Map<string, Vhost>,
  contextVhostId: string,
): Host | undefined {
  if (ref.host) {
    return hostByNameLower.get(ref.host.toLowerCase());
  }
  const contextVhost = vhostById.get(contextVhostId);
  if (!contextVhost) return undefined;
  return input.hosts.find((h) => h.id === contextVhost.hostId);
}
