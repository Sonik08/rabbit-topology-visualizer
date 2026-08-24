export type HostId = string;
export type VhostId = string;
export type ExchangeId = string;
export type QueueId = string;
export type BindingId = string;
export type LinkId = string;
export type PolicyId = string;
export type SourceFileId = string;

export type SourceFileKind =
  | "definitions"
  | "management-dump"
  | "parameters"
  | "policies"
  | "custom"
  | "unknown";

export interface SourceFile {
  id: SourceFileId;
  path: string;
  kind: SourceFileKind;
  hostHint?: string;
  vhostHint?: string;
}

export interface Host {
  id: HostId;
  name: string;
  clusterName?: string;
  environment?: string;
  sourceFiles: SourceFileId[];
}

export interface Vhost {
  id: VhostId;
  hostId: HostId;
  name: string;
}

export type ExchangeType =
  | "direct"
  | "topic"
  | "fanout"
  | "headers"
  | "consistent-hash"
  | "x-random"
  | "x-delayed-message"
  | (string & { readonly brand?: unique symbol });

export interface Exchange {
  id: ExchangeId;
  hostId: HostId;
  vhostId: VhostId;
  name: string;
  type: ExchangeType;
  durable?: boolean;
  autoDelete?: boolean;
  internal?: boolean;
  alternateExchange?: string;
  arguments?: Record<string, unknown>;
}

export interface Queue {
  id: QueueId;
  hostId: HostId;
  vhostId: VhostId;
  name: string;
  durable?: boolean;
  exclusive?: boolean;
  autoDelete?: boolean;
  deadLetterExchange?: string;
  deadLetterRoutingKey?: string;
  arguments?: Record<string, unknown>;
}

export type BindingDestinationType = "exchange" | "queue";

export interface Binding {
  id: BindingId;
  hostId: HostId;
  vhostId: VhostId;
  sourceExchangeId: ExchangeId;
  destinationId: ExchangeId | QueueId;
  destinationType: BindingDestinationType;
  routingKey: string;
  arguments?: Record<string, unknown>;
}

export interface EndpointRef {
  host?: string;
  vhost?: string;
  exchange?: string;
  queue?: string;
  uri?: string;
  unresolved?: boolean;
}

export interface Shovel {
  id: LinkId;
  hostId: HostId;
  vhostId: VhostId;
  name: string;
  source: EndpointRef;
  destination: EndpointRef;
  ackMode?: string;
  reconnectDelay?: number;
  arguments?: Record<string, unknown>;
}

export interface FederationLink {
  id: LinkId;
  hostId: HostId;
  vhostId: VhostId;
  name: string;
  upstream: EndpointRef;
  downstream: EndpointRef;
  exchange?: string;
  queue?: string;
  routingKey?: string;
  arguments?: Record<string, unknown>;
}

export type PolicyAppliesTo =
  | "queues"
  | "exchanges"
  | "all"
  | (string & { readonly brand?: unique symbol });

export interface Policy {
  id: PolicyId;
  hostId: HostId;
  vhostId: VhostId;
  name: string;
  pattern: string;
  appliesTo: PolicyAppliesTo;
  priority: number;
  definition: Record<string, unknown>;
}

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  sourceFileId?: SourceFileId;
  hostId?: HostId;
  vhostId?: VhostId;
  entityId?: string;
}

export interface TopologyProject {
  id: string;
  name: string;
  loadedAt: string;
  files: SourceFile[];
  hosts: Host[];
  vhosts: Vhost[];
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
  shovels: Shovel[];
  federations: FederationLink[];
  policies: Policy[];
  diagnostics: Diagnostic[];
}
