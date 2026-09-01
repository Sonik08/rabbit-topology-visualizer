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
  /**
   * Per-step conditional-semantics annotation — describes WHEN messages
   * actually traverse this hop (topic-pattern match, direct-key equality,
   * headers criteria, alternate-exchange fallback, dead-letter trigger,
   * shovel/federation reliability, unresolved external endpoints).
   *
   * The chain view surfaces this text so the operator understands the
   * route is conditional; every hedged sentence prevents the UI from
   * implying "every message follows this route" — the acceptance
   * requirement from the flow-explorer task.
   *
   * Always populated (never undefined) so downstream renderers can rely
   * on it existing. The wording is deliberately conservative: it flags
   * the constraint without asserting message-count or delivery
   * guarantees the visualizer cannot verify statically.
   */
  condition: string;
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
    condition: conditionForStep(step, nodeById),
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
    condition: conditionForStep(step, nodeById),
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

/**
 * Per-step conditional-semantics annotation. Explicitly hedges each hop
 * so the chain view never implies every published message actually
 * traverses the route — the visualizer knows the STRUCTURE, not the
 * live routing outcome.
 */
function conditionForStep(
  step: UpstreamStep | DownstreamStep,
  nodeById: Map<string, GraphNode>,
): string {
  switch (step.kind) {
    case "binds":
    case "routes": {
      const fromNode = nodeById.get(step.fromNodeId);
      const exchangeType = extractExchangeType(fromNode);
      const key = step.routingKey ?? "";
      return describeBindingCondition(exchangeType, key);
    }
    case "alternate-exchange":
      return "Only when the source exchange itself has no matching binding for a published message — the check happens at the source exchange only, so a matching exchange-to-exchange binding still counts as routed even if nothing downstream reaches a queue; the alternate is the fallback route for messages the source cannot route, not the primary one.";
    case "dead-letter":
      return "Only when a message is rejected (basic.reject / basic.nack) without requeue, expires via per-message or queue TTL, is dropped for exceeding the queue length or byte limit, or (on quorum queues) exceeds the configured delivery-limit; dead-lettering is a failure-path consequence, not a routing decision the publisher controls.";
    case "shovels": {
      const named = step.label ? ` '${sanitizeInline(step.label)}'` : "";
      const unresolved = unresolvedEndpointNote(step, nodeById, "shovel");
      return `${unresolved}Delivery depends on the shovel${named} being running, its ack-mode, and the destination staying reachable — a paused, misconfigured, or unreachable shovel silently blocks this hop.`;
    }
    case "federates": {
      const named = step.label ? ` '${sanitizeInline(step.label)}'` : "";
      const unresolved = unresolvedEndpointNote(step, nodeById, "federation");
      return `${unresolved}Delivery depends on the federation link${named} being active and the upstream/downstream broker connection staying healthy — a broken link silently pauses this hop until reconnection succeeds.`;
    }
    case "contains":
      return "Structural containment only — no message flow crosses this edge.";
    default:
      return "Routing outcome depends on the runtime state of this edge kind, which the topology visualizer cannot determine from static definitions.";
  }
}

/**
 * Produces the "only when …" clause for a `binds`/`routes` step based on
 * the source exchange's declared type. Falls back to a generic
 * "matches this binding" phrasing for unknown or missing types so the
 * chain view still surfaces a conditional annotation instead of
 * omitting one.
 */
function describeBindingCondition(
  exchangeType: string | undefined,
  routingKey: string,
): string {
  const key = sanitizeInline(routingKey);
  const keyPhrase = key.length > 0 ? `'${key}'` : "(empty routing key)";
  switch ((exchangeType ?? "").toLowerCase()) {
    case "topic":
      return `Only messages whose routing key matches the topic pattern ${keyPhrase} follow this binding; other routing keys are not delivered via this hop.`;
    case "direct":
      return `Only messages whose routing key equals ${keyPhrase} exactly follow this binding; any other routing key skips this hop.`;
    case "fanout":
      return "Every message published to the source fanout exchange follows this binding regardless of routing key.";
    case "headers":
      return "Only messages whose headers satisfy this binding's x-match arguments follow this hop; the routing key is ignored for headers exchanges.";
    case "consistent-hash":
    case "x-consistent-hash":
      return `Consistent-hash exchange: the destination is chosen by hashing each message's own routing key (or configured header) and mapping that hash across all bindings' weighted shards; this binding's routing key ${keyPhrase} declares its integer WEIGHT (share of the hash ring), not an equality/pattern check on message routing keys.`;
    case "x-random":
      return `The source x-random exchange picks one bound destination per message; this binding is reached only when the random draw selects it, regardless of routing key ${keyPhrase}.`;
    case "x-delayed-message":
      return `Only messages whose routing key matches the delegated exchange type's rules follow this binding, and only after the per-message x-delay header (in ms) elapses; messages without an x-delay header are delivered immediately, and the routing key ${keyPhrase} applies according to the wrapped exchange type.`;
    case "":
    case undefined:
      return `Only messages that match this binding's routing/headers criteria follow this hop; the source exchange type is unknown so the visualizer cannot narrow the condition further (routing key: ${keyPhrase}).`;
    default:
      return `Only messages that match this binding's criteria for the source exchange type '${sanitizeInline(exchangeType!)}' follow this hop (routing key: ${keyPhrase}).`;
  }
}

interface ExchangeTypeBearing {
  type?: string;
}

function extractExchangeType(node: GraphNode | undefined): string | undefined {
  if (!node || node.kind !== "exchange") return undefined;
  const data = node.data as ExchangeTypeBearing | undefined;
  const type = data?.type;
  return typeof type === "string" ? type : undefined;
}

/**
 * Returns a leading "Note: …" clause when a shovel or federation step
 * has an unresolved (synthesized `external`) node at either end, and an
 * empty string otherwise. Task 40 requires the flow explorer to
 * "clearly report … unresolved links" — the sentence already names the
 * external endpoint, but the CONDITION needs to hedge the routing
 * outcome so the operator knows the referenced broker was never
 * observed in the loaded topology and its behavior cannot be verified.
 */
function unresolvedEndpointNote(
  step: UpstreamStep | DownstreamStep,
  nodeById: Map<string, GraphNode>,
  kindWord: "shovel" | "federation",
): string {
  const fromExternal = nodeById.get(step.fromNodeId)?.kind === "external";
  const toExternal = nodeById.get(step.toNodeId)?.kind === "external";
  if (!fromExternal && !toExternal) return "";
  let side: string;
  if (fromExternal && toExternal) side = "both endpoints reference";
  else if (fromExternal) side = "the source endpoint references";
  else side = "the destination endpoint references";
  return `Note: ${side} an UNRESOLVED external broker — the referenced host/vhost/exchange was not observed in the loaded topology, so the ${kindWord}'s runtime behavior at that end cannot be verified from these definitions. `;
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
