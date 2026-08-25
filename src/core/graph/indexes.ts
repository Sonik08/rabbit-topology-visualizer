import type {
  Exchange,
  FederationLink,
  Host,
  Policy,
  Queue,
  Shovel,
  Vhost,
} from "../model";

export type IndexedEntityKind =
  | "host"
  | "vhost"
  | "exchange"
  | "queue"
  | "shovel"
  | "federation"
  | "policy";

export interface IndexedEntity {
  id: string;
  kind: IndexedEntityKind;
  name: string;
  hostId?: string;
  vhostId?: string;
  /** Reference to the source entity (Host | Vhost | Exchange | Queue | …). */
  entity: unknown;
}

export interface BuildIndexesInput {
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  shovels: Shovel[];
  federations: FederationLink[];
  policies: Policy[];
}

export interface TopologyIndexes {
  /** Look up any entity by its canonical id. */
  entityById(id: string): IndexedEntity | undefined;
  /** Exact-name match across all kinds; order matches insertion order. */
  entitiesByName(name: string): IndexedEntity[];
  /** Exact-name match within one kind. */
  entitiesByKindAndName(kind: IndexedEntityKind, name: string): IndexedEntity[];
  /** All entities of a kind. */
  entitiesByKind(kind: IndexedEntityKind): IndexedEntity[];
  /** All entities anchored to a host (includes the host itself). */
  entitiesByHost(hostId: string): IndexedEntity[];
  /** All entities anchored to a vhost (includes the vhost itself). */
  entitiesByVhost(vhostId: string): IndexedEntity[];
  /** All indexed entities, in insertion order. */
  all(): IndexedEntity[];
}

const ALL_KINDS: readonly IndexedEntityKind[] = [
  "host",
  "vhost",
  "exchange",
  "queue",
  "shovel",
  "federation",
  "policy",
];

export function buildTopologyIndexes(input: BuildIndexesInput): TopologyIndexes {
  const all: IndexedEntity[] = [];
  const byId = new Map<string, IndexedEntity>();
  const byName = new Map<string, IndexedEntity[]>();
  const byKindAndName = new Map<string, IndexedEntity[]>();
  const byKind = new Map<IndexedEntityKind, IndexedEntity[]>();
  const byHost = new Map<string, IndexedEntity[]>();
  const byVhost = new Map<string, IndexedEntity[]>();

  for (const kind of ALL_KINDS) {
    byKind.set(kind, []);
  }

  const add = (entry: IndexedEntity): void => {
    if (byId.has(entry.id)) return;
    byId.set(entry.id, entry);
    all.push(entry);
    pushInto(byName, entry.name, entry);
    pushInto(byKindAndName, kindNameKey(entry.kind, entry.name), entry);
    byKind.get(entry.kind)!.push(entry);
    if (entry.hostId) pushInto(byHost, entry.hostId, entry);
    if (entry.vhostId) pushInto(byVhost, entry.vhostId, entry);
  };

  for (const host of input.hosts) {
    add({ id: host.id, kind: "host", name: host.name, hostId: host.id, entity: host });
  }
  for (const vhost of input.vhosts) {
    add({
      id: vhost.id,
      kind: "vhost",
      name: vhost.name,
      hostId: vhost.hostId,
      vhostId: vhost.id,
      entity: vhost,
    });
  }
  for (const ex of input.exchanges) {
    add({
      id: ex.id,
      kind: "exchange",
      name: ex.name,
      hostId: ex.hostId,
      vhostId: ex.vhostId,
      entity: ex,
    });
  }
  for (const q of input.queues) {
    add({
      id: q.id,
      kind: "queue",
      name: q.name,
      hostId: q.hostId,
      vhostId: q.vhostId,
      entity: q,
    });
  }
  for (const s of input.shovels) {
    add({
      id: s.id,
      kind: "shovel",
      name: s.name,
      hostId: s.hostId,
      vhostId: s.vhostId,
      entity: s,
    });
  }
  for (const f of input.federations) {
    add({
      id: f.id,
      kind: "federation",
      name: f.name,
      hostId: f.hostId,
      vhostId: f.vhostId,
      entity: f,
    });
  }
  for (const p of input.policies) {
    add({
      id: p.id,
      kind: "policy",
      name: p.name,
      hostId: p.hostId,
      vhostId: p.vhostId,
      entity: p,
    });
  }

  return {
    entityById: (id) => byId.get(id),
    entitiesByName: (name) => copy(byName.get(name)),
    entitiesByKindAndName: (kind, name) => copy(byKindAndName.get(kindNameKey(kind, name))),
    entitiesByKind: (kind) => copy(byKind.get(kind)),
    entitiesByHost: (hostId) => copy(byHost.get(hostId)),
    entitiesByVhost: (vhostId) => copy(byVhost.get(vhostId)),
    all: () => [...all],
  };
}

function pushInto<K>(bucket: Map<K, IndexedEntity[]>, key: K, entry: IndexedEntity): void {
  const arr = bucket.get(key);
  if (arr === undefined) bucket.set(key, [entry]);
  else arr.push(entry);
}

function kindNameKey(kind: IndexedEntityKind, name: string): string {
  return `${kind}|${name}`;
}

function copy(arr: IndexedEntity[] | undefined): IndexedEntity[] {
  return arr === undefined ? [] : [...arr];
}
