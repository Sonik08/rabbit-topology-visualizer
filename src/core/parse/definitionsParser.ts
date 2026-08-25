import {
  bindingId,
  exchangeId,
  hostId,
  policyId,
  queueId,
  vhostId,
} from "../model/ids";
import { redactAmqpUri } from "./amqpUri";
import type {
  Binding,
  Diagnostic,
  Exchange,
  ExchangeId,
  Host,
  HostId,
  Policy,
  Queue,
  QueueId,
  SourceFileId,
  Vhost,
} from "../model/topology";

export interface RawParameter {
  hostId: HostId;
  vhost: string;
  component: string;
  name: string;
  value: unknown;
}

export interface ParseDefinitionsInput {
  json: unknown;
  hostName?: string;
  sourceFileId?: SourceFileId;
}

export interface ParseDefinitionsResult {
  host: Host;
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  policies: Policy[];
  rawParameters: RawParameter[];
  diagnostics: Diagnostic[];
}

interface JsonObject {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string" && /^amqps?:\/\//i.test(value)) {
    return redactAmqpUri(value);
  }
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactSensitiveValue(nested);
    }
    return out;
  }
  return value;
}

function redactSensitiveRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactSensitiveValue(value) as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asAppliesTo(value: unknown): string {
  return typeof value === "string" ? value : "all";
}

function asPriority(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const DEFAULT_EXCHANGE_TYPE_BY_PREFIX: Record<string, string> = {
  "amq.direct": "direct",
  "amq.topic": "topic",
  "amq.fanout": "fanout",
  "amq.headers": "headers",
  "amq.match": "headers",
};

function inferExchangeType(name: string, provided: string | undefined): string {
  if (provided && provided.length > 0) return provided;
  if (name === "") return "direct";
  return DEFAULT_EXCHANGE_TYPE_BY_PREFIX[name] ?? "direct";
}

export function parseDefinitionsExport(
  input: ParseDefinitionsInput,
): ParseDefinitionsResult {
  const diagnostics: Diagnostic[] = [];

  if (!isRecord(input.json)) {
    const host = makeHost(input.hostName, input.sourceFileId);
    diagnostics.push({
      severity: "error",
      code: "definitions.not-an-object",
      message: "Definitions payload was not a JSON object.",
      sourceFileId: input.sourceFileId,
      hostId: host.id,
    });
    return {
      host,
      vhosts: [],
      exchanges: [],
      queues: [],
      bindings: [],
      policies: [],
      rawParameters: [],
      diagnostics,
    };
  }

  const json = input.json;
  const host = makeHost(input.hostName, input.sourceFileId);

  const clusterHint = asRecord(
    (asArray(json.global_parameters) as JsonObject[]).find(
      (p) => isRecord(p) && asString(p.name) === "cluster_name",
    ),
  );
  if (clusterHint) {
    const clusterName = asString(clusterHint.value);
    if (clusterName) host.clusterName = clusterName;
  }

  const vhosts = parseVhosts(json, host.id, diagnostics, input.sourceFileId);
  const vhostNameToId = new Map(vhosts.map((v) => [v.name, v.id] as const));

  const ensureVhostId = (vhostName: string | undefined): string => {
    const name = vhostName ?? "/";
    let id = vhostNameToId.get(name);
    if (id === undefined) {
      const vhost: Vhost = {
        id: vhostId(host.id, name),
        hostId: host.id,
        name,
      };
      vhosts.push(vhost);
      vhostNameToId.set(name, vhost.id);
      diagnostics.push({
        severity: "warning",
        code: "definitions.vhost-inferred",
        message: `Vhost '${name}' referenced by an entity but missing from the top-level vhosts array; inferred.`,
        sourceFileId: input.sourceFileId,
        hostId: host.id,
        vhostId: vhost.id,
      });
      id = vhost.id;
    }
    return id;
  };

  const exchanges = parseExchanges(
    json,
    host.id,
    ensureVhostId,
    diagnostics,
    input.sourceFileId,
  );
  const exchangeIndex = new Map<string, ExchangeId>();
  for (const ex of exchanges) {
    exchangeIndex.set(exchangeIndexKey(ex.vhostId, ex.name), ex.id);
  }

  const queues = parseQueues(
    json,
    host.id,
    ensureVhostId,
    diagnostics,
    input.sourceFileId,
  );
  const queueIndex = new Map<string, QueueId>();
  for (const q of queues) {
    queueIndex.set(exchangeIndexKey(q.vhostId, q.name), q.id);
  }

  const bindings = parseBindings(
    json,
    host.id,
    ensureVhostId,
    exchangeIndex,
    queueIndex,
    diagnostics,
    input.sourceFileId,
  );

  const policies = parsePolicies(
    json,
    host.id,
    ensureVhostId,
    diagnostics,
    input.sourceFileId,
  );

  const rawParameters = parseRawParameters(
    json,
    host.id,
    diagnostics,
    input.sourceFileId,
  );

  return {
    host,
    vhosts,
    exchanges,
    queues,
    bindings,
    policies,
    rawParameters,
    diagnostics,
  };
}

function makeHost(name: string | undefined, sourceFile?: SourceFileId): Host {
  const id = hostId(name);
  return {
    id,
    name: name ?? "unknown-host",
    sourceFiles: sourceFile ? [sourceFile] : [],
  };
}

function exchangeIndexKey(vhost: string, name: string): string {
  return JSON.stringify([vhost, name]);
}

function parseVhosts(
  json: JsonObject,
  host: HostId,
  diagnostics: Diagnostic[],
  sourceFile: SourceFileId | undefined,
): Vhost[] {
  const items = asArray(json.vhosts);
  const out: Vhost[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.vhost-malformed",
        message: "Skipped a vhost entry that was not an object.",
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    const name = asString(item.name);
    if (!name) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.vhost-missing-name",
        message: "Skipped a vhost entry without a 'name' field.",
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    if (seen.has(name)) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.vhost-duplicate",
        message: `Duplicate vhost '${name}' in definitions export.`,
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    seen.add(name);
    out.push({ id: vhostId(host, name), hostId: host, name });
  }
  return out;
}

function parseExchanges(
  json: JsonObject,
  host: HostId,
  ensureVhostId: (name: string | undefined) => string,
  diagnostics: Diagnostic[],
  sourceFile: SourceFileId | undefined,
): Exchange[] {
  const items = asArray(json.exchanges);
  const out: Exchange[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.exchange-malformed",
        message: "Skipped an exchange entry that was not an object.",
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    const name = asString(item.name);
    if (name === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.exchange-missing-name",
        message: "Skipped an exchange entry without a 'name' field.",
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    const vhostName = asStringOr(item.vhost, "/");
    const vhost = ensureVhostId(vhostName);
    const id = exchangeId(vhost, name);
    if (seen.has(id)) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.exchange-duplicate",
        message: `Duplicate exchange '${name}' in vhost '${vhostName}'.`,
        sourceFileId: sourceFile,
        hostId: host,
        vhostId: vhost,
      });
      continue;
    }
    seen.add(id);
    const args = asRecord(item.arguments)
      ? redactSensitiveRecord(asRecord(item.arguments)!)
      : undefined;
    const alt = args?.["alternate-exchange"];
    out.push({
      id,
      hostId: host,
      vhostId: vhost,
      name,
      type: inferExchangeType(name, asString(item.type)),
      durable: asBool(item.durable),
      autoDelete: asBool(item.auto_delete),
      internal: asBool(item.internal),
      alternateExchange: asString(alt),
      arguments: args,
    });
  }
  return out;
}

function parseQueues(
  json: JsonObject,
  host: HostId,
  ensureVhostId: (name: string | undefined) => string,
  diagnostics: Diagnostic[],
  sourceFile: SourceFileId | undefined,
): Queue[] {
  const items = asArray(json.queues);
  const out: Queue[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.queue-malformed",
        message: "Skipped a queue entry that was not an object.",
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    const name = asString(item.name);
    if (name === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.queue-missing-name",
        message: "Skipped a queue entry without a 'name' field.",
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    const vhostName = asStringOr(item.vhost, "/");
    const vhost = ensureVhostId(vhostName);
    const id = queueId(vhost, name);
    if (seen.has(id)) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.queue-duplicate",
        message: `Duplicate queue '${name}' in vhost '${vhostName}'.`,
        sourceFileId: sourceFile,
        hostId: host,
        vhostId: vhost,
      });
      continue;
    }
    seen.add(id);
    const args = asRecord(item.arguments)
      ? redactSensitiveRecord(asRecord(item.arguments)!)
      : undefined;
    out.push({
      id,
      hostId: host,
      vhostId: vhost,
      name,
      durable: asBool(item.durable),
      exclusive: asBool(item.exclusive),
      autoDelete: asBool(item.auto_delete),
      deadLetterExchange: asString(args?.["x-dead-letter-exchange"]),
      deadLetterRoutingKey: asString(args?.["x-dead-letter-routing-key"]),
      arguments: args,
    });
  }
  return out;
}

function parseBindings(
  json: JsonObject,
  host: HostId,
  ensureVhostId: (name: string | undefined) => string,
  exchangeIndex: Map<string, ExchangeId>,
  queueIndex: Map<string, QueueId>,
  diagnostics: Diagnostic[],
  sourceFile: SourceFileId | undefined,
): Binding[] {
  const items = asArray(json.bindings);
  const out: Binding[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.binding-malformed",
        message: "Skipped a binding entry that was not an object.",
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    const source = asString(item.source);
    const destination = asString(item.destination);
    const destinationType = asString(item.destination_type);
    if (source === undefined || destination === undefined || destinationType === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.binding-missing-fields",
        message: "Skipped a binding entry missing source/destination/destination_type.",
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    if (destinationType !== "queue" && destinationType !== "exchange") {
      diagnostics.push({
        severity: "warning",
        code: "definitions.binding-unknown-destination-type",
        message: `Binding has unknown destination_type '${destinationType}'; expected 'queue' or 'exchange'.`,
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    const vhostName = asStringOr(item.vhost, "/");
    const vhost = ensureVhostId(vhostName);
    const srcId = exchangeIndex.get(exchangeIndexKey(vhost, source));
    if (srcId === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.binding-source-unresolved",
        message: `Binding source exchange '${source}' in vhost '${vhostName}' not found; skipping.`,
        sourceFileId: sourceFile,
        hostId: host,
        vhostId: vhost,
      });
      continue;
    }
    const destId =
      destinationType === "queue"
        ? queueIndex.get(exchangeIndexKey(vhost, destination))
        : exchangeIndex.get(exchangeIndexKey(vhost, destination));
    if (destId === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.binding-destination-unresolved",
        message: `Binding destination ${destinationType} '${destination}' in vhost '${vhostName}' not found; skipping.`,
        sourceFileId: sourceFile,
        hostId: host,
        vhostId: vhost,
      });
      continue;
    }
    const routingKey = asStringOr(item.routing_key, "");
    const args = asRecord(item.arguments)
      ? redactSensitiveRecord(asRecord(item.arguments)!)
      : undefined;
    const id = bindingId({
      vhost,
      sourceExchange: srcId,
      destination: destId,
      destinationType,
      routingKey,
      arguments: args,
    });
    if (seen.has(id)) {
      diagnostics.push({
        severity: "info",
        code: "definitions.binding-duplicate",
        message: `Duplicate binding from '${source}' to ${destinationType} '${destination}' with routing key '${routingKey}'.`,
        sourceFileId: sourceFile,
        hostId: host,
        vhostId: vhost,
      });
      continue;
    }
    seen.add(id);
    out.push({
      id,
      hostId: host,
      vhostId: vhost,
      sourceExchangeId: srcId,
      destinationId: destId,
      destinationType,
      routingKey,
      arguments: args,
    });
  }
  return out;
}

function parsePolicies(
  json: JsonObject,
  host: HostId,
  ensureVhostId: (name: string | undefined) => string,
  diagnostics: Diagnostic[],
  sourceFile: SourceFileId | undefined,
): Policy[] {
  const items = asArray(json.policies);
  const out: Policy[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.policy-malformed",
        message: "Skipped a policy entry that was not an object.",
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    const name = asString(item.name);
    const pattern = asString(item.pattern);
    if (name === undefined || pattern === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.policy-missing-fields",
        message: "Skipped a policy entry missing 'name' or 'pattern'.",
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    const vhostName = asStringOr(item.vhost, "/");
    const vhost = ensureVhostId(vhostName);
    const id = policyId(vhost, name);
    if (seen.has(id)) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.policy-duplicate",
        message: `Duplicate policy '${name}' in vhost '${vhostName}'.`,
        sourceFileId: sourceFile,
        hostId: host,
        vhostId: vhost,
      });
      continue;
    }
    seen.add(id);
    const definition = redactSensitiveRecord(asRecord(item.definition) ?? {});
    out.push({
      id,
      hostId: host,
      vhostId: vhost,
      name,
      pattern,
      appliesTo: asAppliesTo(item["apply-to"] ?? item.apply_to),
      priority: asPriority(item.priority),
      definition,
    });
  }
  return out;
}

function parseRawParameters(
  json: JsonObject,
  host: HostId,
  diagnostics: Diagnostic[],
  sourceFile: SourceFileId | undefined,
): RawParameter[] {
  const items = asArray(json.parameters);
  const out: RawParameter[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.parameter-malformed",
        message: "Skipped a parameter entry that was not an object.",
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    const component = asString(item.component);
    const name = asString(item.name);
    const hasValue = Object.prototype.hasOwnProperty.call(item, "value");
    if (!component || !name || !hasValue) {
      diagnostics.push({
        severity: "warning",
        code: "definitions.parameter-missing-fields",
        message: "Skipped a parameter entry missing component/name/value.",
        sourceFileId: sourceFile,
        hostId: host,
      });
      continue;
    }
    out.push({
      hostId: host,
      vhost: asStringOr(item.vhost, "/"),
      component,
      name,
      value: redactSensitiveValue(item.value),
    });
  }
  return out;
}
