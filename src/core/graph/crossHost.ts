import type { GraphNode } from "../model";
import type { UpstreamGraphInput, UpstreamTraversalResult } from "./traversal";

export interface CrossHostSummary {
  /** Distinct in-project host ids that appear on the ancestor set (excludes the target's host). */
  ancestorHostIds: string[];
  /** External hostname hints from unresolved endpoints reached during traversal (deduped, sorted). */
  externalHostHints: string[];
  /**
   * True when the traversal actually crossed a `shovels` or `federates` step
   * — a cheap signal for the UI to show "message flow enters this vhost from
   * another host" without introspecting every path.
   */
  crossedShovelOrFederation: boolean;
}

interface EndpointRefLike {
  host?: string;
}

interface HostBearing {
  hostId?: string;
}

/**
 * Given a graph and an upstream traversal result, extracts every distinct host
 * involved on the ancestor side. In-project hosts (host/vhost/exchange/queue/
 * shovel/federation nodes) are surfaced via their canonical `hostId`; external
 * nodes surface the remote hostname *hint* from their sanitized endpoint ref.
 *
 * `targetHostId` is filtered out of `ancestorHostIds` so the caller can tell at
 * a glance whether messages arrive from a different host than the target lives
 * on. Pass the target queue/exchange's `hostId` (looked up via
 * `TopologyIndexes.entityById`, for example) to enable that filter.
 */
export function summarizeCrossHostAncestry(
  input: UpstreamGraphInput,
  result: UpstreamTraversalResult,
  targetHostId?: string,
): CrossHostSummary {
  const nodeById = new Map<string, GraphNode>();
  const knownHostIds = new Set<string>();
  for (const n of input.nodes) {
    nodeById.set(n.id, n);
    if (n.kind === "host") knownHostIds.add(n.id);
  }

  const ancestorHostIds = new Set<string>();
  const externalHostHints = new Set<string>();

  for (const ancestorId of result.reachableAncestorIds) {
    const node = nodeById.get(ancestorId);
    if (node === undefined) continue;
    if (node.kind === "external") {
      const ref = node.data as EndpointRefLike | undefined;
      if (ref?.host && ref.host.length > 0) {
        externalHostHints.add(ref.host);
      }
      continue;
    }
    if (node.kind === "host") {
      if (node.id !== targetHostId) ancestorHostIds.add(node.id);
      continue;
    }
    const bearing = node.data as HostBearing | undefined;
    // Only surface a host id when the host itself is loaded as a node in the
    // graph — a shovel/federation with a stale `hostId` pointing at a host
    // that was never imported must not masquerade as an in-project ancestor.
    if (
      bearing?.hostId &&
      bearing.hostId !== targetHostId &&
      knownHostIds.has(bearing.hostId)
    ) {
      ancestorHostIds.add(bearing.hostId);
    }
  }

  let crossedShovelOrFederation = false;
  outer: for (const path of result.paths) {
    for (const step of path.steps) {
      if (step.kind === "shovels" || step.kind === "federates") {
        crossedShovelOrFederation = true;
        break outer;
      }
    }
  }

  return {
    ancestorHostIds: [...ancestorHostIds].sort(),
    externalHostHints: [...externalHostHints].sort(),
    crossedShovelOrFederation,
  };
}
