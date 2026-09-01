import type { GraphEdgeKind, GraphNode } from "../model";
import type {
  DownstreamPath,
  DownstreamStep,
  UpstreamPath,
  UpstreamStep,
} from "../graph/traversal";

export interface ExplainedStep {
  edgeId: string;
  edgeKind: GraphEdgeKind;
  fromNode?: GraphNode;
  toNode?: GraphNode;
  routingKey?: string;
  label?: string;
  /** One-line, human-readable sentence describing what this hop does. */
  sentence: string;
}

export interface PathExplanation {
  sourceNodeId: string;
  targetNodeId: string;
  steps: ExplainedStep[];
  /** Full explanation as a multi-line string, one line per step. */
  summary: string;
}

/**
 * Turns an `UpstreamPath` (from `upstreamForQueue`/`upstreamForExchange`) into
 * a human-readable explanation. Each step is rendered with an English sentence
 * suitable for a UI details panel: verb-first phrasing that explains *why* the
 * upstream side can reach the downstream side.
 *
 * The explanation reads source → target — the same direction as message flow —
 * even though the traversal walked the graph backwards.
 */
export function explainUpstreamPath(
  path: UpstreamPath,
  targetNodeId: string,
  nodes: readonly GraphNode[],
): PathExplanation {
  const nodeById = new Map<string, GraphNode>();
  for (const n of nodes) nodeById.set(n.id, n);

  const steps: ExplainedStep[] = path.steps.map((step) => ({
    edgeId: step.edgeId,
    edgeKind: step.kind,
    fromNode: nodeById.get(step.fromNodeId),
    toNode: nodeById.get(step.toNodeId),
    routingKey: step.routingKey,
    label: step.label,
    sentence: sentenceForStep(step, nodeById),
  }));

  return {
    sourceNodeId: path.sourceNodeId,
    targetNodeId,
    steps,
    summary: steps.map((s) => s.sentence).join("\n"),
  };
}

/**
 * Downstream counterpart of {@link explainUpstreamPath}. `DownstreamPath.steps`
 * already flow target → sink (natural reading order), so the same per-step
 * renderer is reused — the only difference is the shape wrapping the steps.
 */
export function explainDownstreamPath(
  path: DownstreamPath,
  targetNodeId: string,
  nodes: readonly GraphNode[],
): PathExplanation {
  const nodeById = new Map<string, GraphNode>();
  for (const n of nodes) nodeById.set(n.id, n);

  const steps: ExplainedStep[] = path.steps.map((step) => ({
    edgeId: step.edgeId,
    edgeKind: step.kind,
    fromNode: nodeById.get(step.fromNodeId),
    toNode: nodeById.get(step.toNodeId),
    routingKey: step.routingKey,
    label: step.label,
    sentence: sentenceForStep(step, nodeById),
  }));

  return {
    // For the downstream explanation the "source" of the reader-facing flow
    // sentence is the selected target itself and the "target" is the sink;
    // populate the PathExplanation fields accordingly so the panel can render
    // target → sink summary lines symmetric to the upstream direction.
    sourceNodeId: targetNodeId,
    targetNodeId: path.sinkNodeId,
    steps,
    summary: steps.map((s) => s.sentence).join("\n"),
  };
}

function sentenceForStep(
  step: UpstreamStep | DownstreamStep,
  nodeById: Map<string, GraphNode>,
): string {
  const from = describeNode(step.fromNodeId, nodeById);
  const to = describeNode(step.toNodeId, nodeById);
  switch (step.kind) {
    case "binds":
    case "routes": {
      const key = formatRoutingKey(step.routingKey);
      return `${from} binds ${key} to ${to}.`;
    }
    case "alternate-exchange":
      // `to` already renders as "exchange 'X' (host)"; using "alternate
      // exchange ${to}" would produce "alternate exchange exchange 'X'".
      // Phrase it so the noun appears only once.
      return `${from} forwards unroutable messages to its alternate: ${to}.`;
    case "dead-letter": {
      const key = step.routingKey
        ? ` with routing key '${sanitizeInline(step.routingKey)}'`
        : "";
      return `${from} dead-letters expired or rejected messages to ${to}${key}.`;
    }
    case "shovels": {
      const named = step.label ? ` '${sanitizeInline(step.label)}'` : "";
      return `shovel${named} carries messages from ${from} to ${to}.`;
    }
    case "federates": {
      const named = step.label ? ` '${sanitizeInline(step.label)}'` : "";
      return `federation link${named} mirrors messages from ${from} to ${to}.`;
    }
    case "contains":
      // Should not appear in a traversal path, but render something safe if it does.
      return `${from} contains ${to}.`;
    default: {
      const unknown: never = step.kind;
      return `${from} → ${to} (${sanitizeInline(String(unknown))}).`;
    }
  }
}

function formatRoutingKey(key: string | undefined): string {
  if (key === undefined || key === "") return "with no routing key";
  return `via routing key '${sanitizeInline(key)}'`;
}

/**
 * Replaces newlines, carriage returns, tabs, other C0 control characters, and
 * the DEL character with a visible middle-dot escape (`·`). RabbitMQ names,
 * routing keys, and shovel/federation labels are arbitrary strings from
 * external systems — a stray `\n` inside one of them would otherwise break
 * both the "one line per step" invariant and the newline-joined summary.
 */
function sanitizeInline(input: string): string {
  // Replace any C0 control (0x00–0x1F) or DEL (0x7F) with a visible marker.
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u001F\u007F]/g, "·");
}

interface HostBearing {
  hostId?: string;
  vhostId?: string;
}

function describeNode(
  nodeId: string,
  nodeById: Map<string, GraphNode>,
): string {
  const node = nodeById.get(nodeId);
  if (!node) return sanitizeInline(nodeId);
  const label = sanitizeInline(node.label || nodeId);
  const context = describeContext(node, nodeById);
  const kindWord = kindLabel(node.kind);
  return context.length > 0
    ? `${kindWord} '${label}' (${context})`
    : `${kindWord} '${label}'`;
}

function kindLabel(kind: GraphNode["kind"]): string {
  switch (kind) {
    case "exchange":
      return "exchange";
    case "queue":
      return "queue";
    case "shovel":
      return "shovel";
    case "federation":
      return "federation link";
    case "external":
      return "external endpoint";
    case "host":
      return "host";
    case "vhost":
      return "vhost";
    default:
      return kind;
  }
}

function describeContext(
  node: GraphNode,
  nodeById: Map<string, GraphNode>,
): string {
  const bearing = node.data as HostBearing | undefined;
  const host = bearing?.hostId ? nodeById.get(bearing.hostId)?.label : undefined;
  const vhost = bearing?.vhostId
    ? nodeById.get(bearing.vhostId)?.label
    : undefined;
  const parts: string[] = [];
  if (host) parts.push(sanitizeInline(host));
  if (vhost) parts.push(`vhost ${sanitizeInline(vhost)}`);
  return parts.join(" / ");
}
