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
  /**
   * Configured message-flow metadata for shovel / federation edges. Present
   * only on `shovels` and `federates` edges; describes the directional link,
   * whether it crosses a host or vhost boundary, and the source / destination
   * host+vhost names so the UI can label the boundary context without a
   * secondary lookup.
   *
   * IMPORTANT: This is *configured* topology — the visualization is a static
   * declaration of the intended flow direction, not a live message telemetry
   * feed. Any UI that surfaces this metadata must make that distinction
   * explicit so operators do not confuse it with live traffic.
   */
  flow?: LinkFlow;
}

export type LinkFlowBoundary =
  | "same-vhost"
  | "cross-vhost-same-host"
  | "cross-host";

export interface LinkFlow {
  /** `shovel` or `federation` — matches the parent link type. */
  linkKind: "shovel" | "federation";
  /** Human name of the shovel / federation link (never a URI). */
  linkName: string;
  /** Direction of this edge relative to the link node. */
  role: "in" | "out";
  boundary: LinkFlowBoundary;
  /**
   * Source-side host / vhost names for label rendering. Names, not ids —
   * `EndpointRef.host` might be a bare hostname, an alias, or absent (in which
   * case the link's own vhost's host is used). Sanitized upstream so no AMQP
   * userinfo can leak.
   */
  sourceHostName: string;
  sourceVhostName: string;
  destinationHostName: string;
  destinationVhostName: string;
}
