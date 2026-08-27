import { parseAmqpUri, redactAmqpUri } from "./amqpUri";
import { federationId, shovelId } from "../model/ids";
import type { RawParameter } from "./definitionsParser";
import type {
  Diagnostic,
  EndpointRef,
  FederationLink,
  HostId,
  Shovel,
  SourceFileId,
  VhostId,
  Vhost,
} from "../model/topology";

export interface FederationUpstreamSetEntry {
  hostId: HostId;
  vhostId: VhostId;
  name: string;
  upstreams: string[];
}

export interface ParseRuntimeParametersInput {
  hostId: HostId;
  vhosts: Vhost[];
  parameters: RawParameter[];
  sourceFileId?: SourceFileId;
}

export interface ParseRuntimeParametersResult {
  shovels: Shovel[];
  federations: FederationLink[];
  federationUpstreamSets: FederationUpstreamSetEntry[];
  diagnostics: Diagnostic[];
}

const SHOVEL_COMPONENT = "shovel";
const FED_UPSTREAM_COMPONENT = "federation-upstream";
const FED_UPSTREAM_SET_COMPONENT = "federation-upstream-set";

export function parseRuntimeParameters(
  input: ParseRuntimeParametersInput,
): ParseRuntimeParametersResult {
  const diagnostics: Diagnostic[] = [];
  const shovels: Shovel[] = [];
  const federations: FederationLink[] = [];
  const federationUpstreamSets: FederationUpstreamSetEntry[] = [];

  const vhostByName = new Map(input.vhosts.map((v) => [v.name, v.id] as const));
  const resolveVhostId = (vhostName: string): VhostId | undefined =>
    vhostByName.get(vhostName);

  const seenShovel = new Set<string>();
  const seenFed = new Set<string>();
  const seenFedSet = new Set<string>();

  for (const p of input.parameters) {
    const vhostId = resolveVhostId(p.vhost);
    if (vhostId === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "runtime-params.vhost-unresolved",
        message: `Runtime parameter '${p.component}/${p.name}' references vhost '${p.vhost}' that is not known.`,
        sourceFileId: input.sourceFileId,
        hostId: input.hostId,
      });
      continue;
    }

    switch (p.component) {
      case SHOVEL_COMPONENT: {
        const shovel = parseShovel(input.hostId, vhostId, p, diagnostics, input.sourceFileId);
        if (!shovel) continue;
        if (seenShovel.has(shovel.id)) {
          diagnostics.push({
            severity: "warning",
            code: "runtime-params.shovel-duplicate",
            message: `Duplicate shovel '${p.name}' in vhost '${p.vhost}'.`,
            sourceFileId: input.sourceFileId,
            hostId: input.hostId,
            vhostId,
          });
          continue;
        }
        seenShovel.add(shovel.id);
        shovels.push(shovel);
        break;
      }
      case FED_UPSTREAM_COMPONENT: {
        const fed = parseFederationUpstream(
          input.hostId,
          vhostId,
          p,
          diagnostics,
          input.sourceFileId,
        );
        if (!fed) continue;
        if (seenFed.has(fed.id)) {
          diagnostics.push({
            severity: "warning",
            code: "runtime-params.federation-duplicate",
            message: `Duplicate federation-upstream '${p.name}' in vhost '${p.vhost}'.`,
            sourceFileId: input.sourceFileId,
            hostId: input.hostId,
            vhostId,
          });
          continue;
        }
        seenFed.add(fed.id);
        federations.push(fed);
        break;
      }
      case FED_UPSTREAM_SET_COMPONENT: {
        const entry = parseFederationUpstreamSet(input.hostId, vhostId, p, diagnostics, input.sourceFileId);
        if (!entry) continue;
        const key = JSON.stringify([vhostId, entry.name]);
        if (seenFedSet.has(key)) {
          diagnostics.push({
            severity: "warning",
            code: "runtime-params.federation-set-duplicate",
            message: `Duplicate federation-upstream-set '${p.name}' in vhost '${p.vhost}'.`,
            sourceFileId: input.sourceFileId,
            hostId: input.hostId,
            vhostId,
          });
          continue;
        }
        seenFedSet.add(key);
        federationUpstreamSets.push(entry);
        break;
      }
      default:
        diagnostics.push({
          severity: "info",
          code: "runtime-params.unknown-component",
          message: `Ignoring runtime parameter with unrecognised component '${p.component}' (name '${p.name}').`,
          sourceFileId: input.sourceFileId,
          hostId: input.hostId,
          vhostId,
        });
    }
  }

  return { shovels, federations, federationUpstreamSets, diagnostics };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

function redactValue(value: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactUnknown(value);
  return isPlainRecord(redacted) ? redacted : {};
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string" && /^amqps?:\/\//i.test(value)) {
    return redactAmqpUri(value);
  }
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactUnknown(nested);
    }
    return out;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function endpointFromShovelSide(
  uri: string | undefined,
  exchange: string | undefined,
  queue: string | undefined,
): EndpointRef | undefined {
  if (!uri && !exchange && !queue) return undefined;
  const ref: EndpointRef = {};
  if (uri) {
    const parsed = parseAmqpUri(uri);
    ref.uri = parsed.redacted;
    if (parsed.host) ref.host = parsed.host;
    if (parsed.vhost) ref.vhost = parsed.vhost;
    ref.unresolved = !parsed.valid;
  }
  if (exchange !== undefined) ref.exchange = exchange;
  if (queue !== undefined) ref.queue = queue;
  return ref;
}

function parseShovel(
  hostId: HostId,
  vhostId: VhostId,
  p: RawParameter,
  diagnostics: Diagnostic[],
  sourceFileId: SourceFileId | undefined,
): Shovel | undefined {
  const v = asRecord(p.value);
  if (!v) {
    diagnostics.push({
      severity: "warning",
      code: "runtime-params.shovel-malformed",
      message: `Shovel '${p.name}' has an unrecognised value shape.`,
      sourceFileId,
      hostId,
      vhostId,
    });
    return undefined;
  }
  const srcUri = pickShovelUri(
    v["src-uri"] ?? v.src_uri,
    "src-uri",
    p,
    diagnostics,
    sourceFileId,
    hostId,
    vhostId,
  );
  const srcExchange = asString(v["src-exchange"] ?? v.src_exchange);
  const srcQueue = asString(v["src-queue"] ?? v.src_queue);
  const destUri = pickShovelUri(
    v["dest-uri"] ?? v.dest_uri,
    "dest-uri",
    p,
    diagnostics,
    sourceFileId,
    hostId,
    vhostId,
  );
  const destExchange = asString(v["dest-exchange"] ?? v.dest_exchange);
  const destQueue = asString(v["dest-queue"] ?? v.dest_queue);

  const source = endpointFromShovelSide(srcUri, srcExchange, srcQueue);
  const destination = endpointFromShovelSide(destUri, destExchange, destQueue);

  if (!source || !destination) {
    diagnostics.push({
      severity: "warning",
      code: "runtime-params.shovel-missing-endpoint",
      message: `Shovel '${p.name}' is missing a source or destination endpoint.`,
      sourceFileId,
      hostId,
      vhostId,
    });
    return undefined;
  }

  return {
    id: shovelId(vhostId, p.name),
    hostId,
    vhostId,
    name: p.name,
    source,
    destination,
    ackMode: asString(v["ack-mode"] ?? v.ack_mode),
    reconnectDelay: asNumber(v["reconnect-delay"] ?? v.reconnect_delay),
    arguments: redactValue(v),
  };
}

function parseFederationUpstream(
  hostId: HostId,
  vhostId: VhostId,
  p: RawParameter,
  diagnostics: Diagnostic[],
  sourceFileId: SourceFileId | undefined,
): FederationLink | undefined {
  const v = asRecord(p.value);
  if (!v) {
    diagnostics.push({
      severity: "warning",
      code: "runtime-params.federation-malformed",
      message: `Federation upstream '${p.name}' has an unrecognised value shape.`,
      sourceFileId,
      hostId,
      vhostId,
    });
    return undefined;
  }
  const uri = firstUri(v.uri);
  if (!uri) {
    diagnostics.push({
      severity: "warning",
      code: "runtime-params.federation-missing-uri",
      message: `Federation upstream '${p.name}' has no 'uri' field.`,
      sourceFileId,
      hostId,
      vhostId,
    });
    return undefined;
  }

  const parsed = parseAmqpUri(uri);
  const upstream: EndpointRef = {
    uri: parsed.redacted,
    host: parsed.host,
    vhost: parsed.vhost,
    exchange: asString(v.exchange),
    queue: asString(v.queue),
    unresolved: !parsed.valid,
  };

  const downstream: EndpointRef = {
    host: undefined,
    vhost: p.vhost,
    exchange: asString(v.exchange),
    queue: asString(v.queue),
  };

  return {
    id: federationId(vhostId, p.name),
    hostId,
    vhostId,
    name: p.name,
    upstream,
    downstream,
    exchange: asString(v.exchange),
    queue: asString(v.queue),
    arguments: redactValue(v),
  };
}

function firstUri(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) {
    const first = value.find((s) => typeof s === "string" && s.length > 0);
    if (typeof first === "string") return first;
  }
  return undefined;
}

/**
 * Normalize the string-or-array `src-uri` / `dest-uri` form used by RabbitMQ
 * shovels for HA. RabbitMQ tries the URIs in order until one connects, so we
 * treat the first non-empty string as the primary endpoint for host/vhost
 * display. Alternate URIs stay preserved (redacted) in `Shovel.arguments`
 * because `redactValue` walks the whole raw value tree — no separate schema
 * change is needed to retain them.
 *
 * Emits actionable diagnostics for the failure modes seen on real 3.12 exports:
 * empty arrays, arrays containing no strings, and mixed arrays whose non-string
 * entries had to be skipped.
 */
function pickShovelUri(
  raw: unknown,
  fieldName: "src-uri" | "dest-uri",
  p: RawParameter,
  diagnostics: Diagnostic[],
  sourceFileId: SourceFileId | undefined,
  hostId: HostId,
  vhostId: VhostId,
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") {
    // Trim so a whitespace-only scalar behaves like the "no URI at all" case
    // rather than being silently accepted and later rejected by parseAmqpUri.
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "runtime-params.shovel-uri-empty-list",
        message: `Shovel '${p.name}' has an empty '${fieldName}' array.`,
        sourceFileId,
        hostId,
        vhostId,
      });
      return undefined;
    }
    // Trim strings before selection so a whitespace-only entry is treated the
    // same as an empty string / non-string entry — the caller's URI parser
    // would reject it anyway, but here we surface it as a skipped entry so the
    // diagnostic accurately reports what was unusable.
    const strings: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (trimmed.length === 0) continue;
      strings.push(trimmed);
    }
    if (strings.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "runtime-params.shovel-uri-invalid-list",
        message: `Shovel '${p.name}' '${fieldName}' array has no usable string entries.`,
        sourceFileId,
        hostId,
        vhostId,
      });
      return undefined;
    }
    if (strings.length < raw.length) {
      const skipped = raw.length - strings.length;
      diagnostics.push({
        severity: "info",
        code: "runtime-params.shovel-uri-mixed-list",
        message: `Shovel '${p.name}' '${fieldName}' array had ${skipped} unusable entrie(s) (non-string or empty/whitespace) that were skipped.`,
        sourceFileId,
        hostId,
        vhostId,
      });
    }
    return strings[0];
  }
  return undefined;
}

function parseFederationUpstreamSet(
  hostId: HostId,
  vhostId: VhostId,
  p: RawParameter,
  diagnostics: Diagnostic[],
  sourceFileId: SourceFileId | undefined,
): FederationUpstreamSetEntry | undefined {
  const v = p.value as unknown;
  let upstreams: string[] | undefined;
  if (Array.isArray(v)) {
    upstreams = v
      .map((item) =>
        typeof item === "string"
          ? item
          : typeof item === "object" && item && typeof (item as { upstream?: unknown }).upstream === "string"
            ? (item as { upstream: string }).upstream
            : undefined,
      )
      .filter((s): s is string => typeof s === "string");
  } else if (typeof v === "object" && v !== null) {
    const upstreamsField = (v as { upstreams?: unknown }).upstreams;
    if (Array.isArray(upstreamsField)) {
      upstreams = upstreamsField.filter(
        (s): s is string => typeof s === "string",
      );
    }
  }
  if (!upstreams) {
    diagnostics.push({
      severity: "warning",
      code: "runtime-params.federation-set-malformed",
      message: `federation-upstream-set '${p.name}' has an unrecognised value shape.`,
      sourceFileId,
      hostId,
      vhostId,
    });
    return undefined;
  }
  return {
    hostId,
    vhostId,
    name: p.name,
    upstreams,
  };
}
