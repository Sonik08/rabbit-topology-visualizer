import type { IndexedEntity, TopologyIndexes } from "../graph/indexes";

export type EntitySearchKind = "exchange" | "queue" | "either";

export interface EntitySearchOptions {
  /** Restrict matches to a single kind. Default: `either`. */
  kind?: EntitySearchKind;
  /** Restrict matches to a single host id. */
  hostId?: string;
  /** Restrict matches to a single vhost id. */
  vhostId?: string;
}

export interface EntitySearchGroup {
  hostId?: string;
  vhostId?: string;
  entities: IndexedEntity[];
}

export interface EntitySearchResult {
  query: string;
  kind: EntitySearchKind;
  /** All matches after filters, in insertion order from the underlying index. */
  matches: IndexedEntity[];
  /** True when more than one match survives filters — the caller must disambiguate. */
  ambiguous: boolean;
  /** Same entities grouped by (hostId, vhostId) for UI-friendly display. */
  byVhost: EntitySearchGroup[];
}

/**
 * Exact-name lookup for a queue or exchange. Returns every match (across hosts
 * and vhosts) so ambiguous names never silently resolve to one entity; the
 * caller decides how to present the choices.
 */
export function findEntity(
  indexes: TopologyIndexes,
  query: string,
  options: EntitySearchOptions = {},
): EntitySearchResult {
  const kind: EntitySearchKind = options.kind ?? "either";
  const raw =
    kind === "either"
      ? [
          ...indexes.entitiesByKindAndName("exchange", query),
          ...indexes.entitiesByKindAndName("queue", query),
        ]
      : indexes.entitiesByKindAndName(kind, query);

  const filtered = raw.filter((e) => {
    if (options.hostId !== undefined && e.hostId !== options.hostId) return false;
    if (options.vhostId !== undefined && e.vhostId !== options.vhostId) return false;
    return true;
  });

  return {
    query,
    kind,
    matches: filtered,
    ambiguous: filtered.length > 1,
    byVhost: groupByVhost(filtered),
  };
}

function groupByVhost(entities: IndexedEntity[]): EntitySearchGroup[] {
  const bucket = new Map<string, EntitySearchGroup>();
  const order: string[] = [];
  for (const e of entities) {
    const key = `${e.hostId ?? ""}|${e.vhostId ?? ""}`;
    let group = bucket.get(key);
    if (!group) {
      group = { hostId: e.hostId, vhostId: e.vhostId, entities: [] };
      bucket.set(key, group);
      order.push(key);
    }
    group.entities.push(e);
  }
  return order.map((k) => bucket.get(k)!);
}
