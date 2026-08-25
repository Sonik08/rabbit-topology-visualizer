export type GraphNodeKind =
  | "host"
  | "vhost"
  | "exchange"
  | "queue"
  | "shovel"
  | "federation"
  | "external";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Reference to the source entity when available; external nodes carry the raw EndpointRef. */
  data?: unknown;
}

export type GraphEdgeKind =
  | "contains"
  | "binds"
  | "routes"
  | "shovels"
  | "federates"
  | "alternate-exchange"
  | "dead-letter";

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  routingKey?: string;
  arguments?: Record<string, unknown>;
  /** Human label for the UI, e.g. shovel/federation name. */
  label?: string;
}
