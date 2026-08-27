import type { EndpointRef, LinkFlow, LinkFlowBoundary } from "../model";

/**
 * Pure classifier for shovel / federation endpoint boundaries. The label
 * `configured message flow` is deliberate: this is a *static* declaration of
 * the intended path, not a live telemetry feed. Callers rendering these
 * boundaries in a UI must make that distinction explicit.
 *
 * All string inputs are treated as opaque names — nothing here parses AMQP
 * URIs or touches credentials. Callers (in `buildGraph`) sanitize every
 * `EndpointRef` before it reaches this module.
 */

export interface LinkContext {
  /** Bare host name of the vhost that OWNS the shovel/federation definition. */
  linkHostName: string;
  /** Bare vhost name of the vhost that OWNS the shovel/federation definition. */
  linkVhostName: string;
}

export interface ResolvedEndpointNames {
  hostName: string;
  vhostName: string;
}

/**
 * Fills in the effective host / vhost names for a shovel / federation
 * endpoint. RabbitMQ's shovel/federation schema commonly omits the endpoint
 * host (defaulting to the shovel's local host) and often omits the vhost
 * (defaulting to the shovel's local vhost). This helper applies those
 * defaults so callers get a total function.
 */
export function resolveEndpointNames(
  ref: EndpointRef,
  context: LinkContext,
): ResolvedEndpointNames {
  const hostName = nonEmpty(ref.host) ?? context.linkHostName;
  const vhostName = nonEmpty(ref.vhost) ?? context.linkVhostName;
  return { hostName, vhostName };
}

/**
 * Classifies where a shovel / federation edge crosses relative to its
 * source and destination endpoints. Host / vhost equality is case-sensitive
 * because RabbitMQ vhost names are case-sensitive; hostnames are compared
 * with a case-insensitive fallback to catch trivial `Host-A` vs `host-a`
 * mismatches introduced during export.
 */
export function classifyBoundary(
  source: ResolvedEndpointNames,
  destination: ResolvedEndpointNames,
): LinkFlowBoundary {
  if (!sameHost(source.hostName, destination.hostName)) return "cross-host";
  if (source.vhostName !== destination.vhostName) return "cross-vhost-same-host";
  return "same-vhost";
}

/**
 * Convenience wrapper: given both endpoints plus the link's own context,
 * returns a fully-populated `LinkFlow` for one direction (`role="in"` for
 * source→link, `role="out"` for link→destination). Nothing here is
 * asynchronous or IO-bound; the function is pure and safe to call inside
 * `buildGraph` for every shovel/federation.
 */
export function buildLinkFlow(params: {
  source: EndpointRef;
  destination: EndpointRef;
  context: LinkContext;
  linkKind: LinkFlow["linkKind"];
  linkName: string;
  role: LinkFlow["role"];
}): LinkFlow {
  const src = resolveEndpointNames(params.source, params.context);
  const dst = resolveEndpointNames(params.destination, params.context);
  return {
    linkKind: params.linkKind,
    linkName: params.linkName,
    role: params.role,
    boundary: classifyBoundary(src, dst),
    sourceHostName: src.hostName,
    sourceVhostName: src.vhostName,
    destinationHostName: dst.hostName,
    destinationVhostName: dst.vhostName,
  };
}

/**
 * Human-readable summary of a `LinkFlow`, suitable for rendering under a
 * shovel/federation edge. Includes the link kind, name, and a boundary
 * suffix like `host-a / vhost1 → host-b / vhost1`. The leading tag
 * `configured` reminds the operator the visualization is static.
 */
export function describeLinkFlow(flow: LinkFlow): string {
  const boundary = describeBoundary(flow.boundary);
  const path = `${flow.sourceHostName}/${flow.sourceVhostName} → ${flow.destinationHostName}/${flow.destinationVhostName}`;
  return `configured ${flow.linkKind} "${flow.linkName}" (${boundary}): ${path}`;
}

export function describeBoundary(boundary: LinkFlowBoundary): string {
  switch (boundary) {
    case "cross-host":
      return "cross-host";
    case "cross-vhost-same-host":
      return "cross-vhost, same host";
    case "same-vhost":
      return "same vhost";
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function sameHost(a: string, b: string): boolean {
  if (a === b) return true;
  return a.toLowerCase() === b.toLowerCase();
}
