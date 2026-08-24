import type {
  BindingDestinationType,
  BindingId,
  ExchangeId,
  HostId,
  LinkId,
  PolicyId,
  QueueId,
  SourceFileId,
  VhostId,
} from "./topology";

const SEG_SEPARATOR = "/";

const RESERVED_HOST = "__unknown_host__";
const DEFAULT_VHOST = "/";

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function normalizeHostName(name: string | undefined | null): string {
  const trimmed = (name ?? "").trim();
  if (trimmed.length === 0) {
    return RESERVED_HOST;
  }
  return trimmed.toLowerCase();
}

function normalizeVhostName(name: string | undefined | null): string {
  const value = name ?? DEFAULT_VHOST;
  return value.length === 0 ? DEFAULT_VHOST : value;
}

export function hostId(name: string | undefined | null): HostId {
  return `host:${encodeSegment(normalizeHostName(name))}`;
}

export function vhostId(host: HostId, name: string | undefined | null): VhostId {
  return `vhost:${host}${SEG_SEPARATOR}${encodeSegment(normalizeVhostName(name))}`;
}

export function exchangeId(vhost: VhostId, name: string): ExchangeId {
  return `exchange:${vhost}${SEG_SEPARATOR}${encodeSegment(name)}`;
}

export function queueId(vhost: VhostId, name: string): QueueId {
  return `queue:${vhost}${SEG_SEPARATOR}${encodeSegment(name)}`;
}

export function shovelId(vhost: VhostId, name: string): LinkId {
  return `shovel:${vhost}${SEG_SEPARATOR}${encodeSegment(name)}`;
}

export function federationId(vhost: VhostId, name: string): LinkId {
  return `federation:${vhost}${SEG_SEPARATOR}${encodeSegment(name)}`;
}

export function policyId(vhost: VhostId, name: string): PolicyId {
  return `policy:${vhost}${SEG_SEPARATOR}${encodeSegment(name)}`;
}

export function sourceFileId(path: string): SourceFileId {
  return `file:${encodeSegment(path)}`;
}

export interface BindingIdInput {
  vhost: VhostId;
  sourceExchange: ExchangeId;
  destination: ExchangeId | QueueId;
  destinationType: BindingDestinationType;
  routingKey: string;
  arguments?: Record<string, unknown>;
}

export function bindingId(input: BindingIdInput): BindingId {
  const argsSig = canonicalArgsSignature(input.arguments);
  const parts = [
    input.vhost,
    input.sourceExchange,
    `${input.destinationType}:${input.destination}`,
    `rk:${encodeSegment(input.routingKey)}`,
    `args:${argsSig}`,
  ];
  return `binding:${parts.join("|")}`;
}

export function canonicalArgsSignature(
  args: Record<string, unknown> | undefined,
): string {
  if (args === undefined || args === null) {
    return "";
  }
  const keys = Object.keys(args);
  if (keys.length === 0) {
    return "";
  }
  return JSON.stringify(sortDeep(args));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortDeep(record[key]);
    }
    return out;
  }
  return value;
}
