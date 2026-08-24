# RabbitMQ Topology Visualizer — Implementation Plan

## 1. Goal

Build a local-first tool that loads RabbitMQ topology exports from RAR/zip archives or folders and visualizes message-flow relationships between hosts, vhosts, exchanges, queues, bindings, shovels, federation links, dead-letter paths, and alternate exchanges.

Primary user query:

> Given a queue or exchange name, show the whole upstream flow: every place messages could come from, including other hosts/vhosts connected through shovels or federation.

## 2. Data movement from the SSH client machine

The example `Downloads.rar` archive, or any zip/folder, is on the machine you SSH **from**, in its Downloads folder. Run one of these commands on that machine, not inside the SSH session.

### Copy the current RAR file

Linux/macOS:

```bash
scp ~/Downloads/Downloads.rar sonik@192.168.1.233:/home/sonik/.openclaw/workspace/rabbit-topology-visualizer/data/raw/
```

Windows PowerShell:

```powershell
scp "$env:USERPROFILE\Downloads\Downloads.rar" sonik@192.168.1.233:/home/sonik/.openclaw/workspace/rabbit-topology-visualizer/data/raw/
```

### Copy one zip

Linux/macOS:

```bash
scp ~/Downloads/<topologies>.zip sonik@192.168.1.233:/home/sonik/.openclaw/workspace/rabbit-topology-visualizer/data/raw/
```

Windows PowerShell:

```powershell
scp "$env:USERPROFILE\Downloads\<topologies>.zip" sonik@192.168.1.233:/home/sonik/.openclaw/workspace/rabbit-topology-visualizer/data/raw/
```

### Copy a folder

Linux/macOS:

```bash
rsync -av ~/Downloads/<topology-folder>/ sonik@192.168.1.233:/home/sonik/.openclaw/workspace/rabbit-topology-visualizer/data/raw/<topology-folder>/
```

Windows PowerShell, if `scp` is available:

```powershell
scp -r "$env:USERPROFILE\Downloads\<topology-folder>" sonik@192.168.1.233:/home/sonik/.openclaw/workspace/rabbit-topology-visualizer/data/raw/
```

If your SSH command normally uses a key or non-default port, add the same options, e.g. `-i ~/.ssh/key` or `-P 2222` for `scp`, `-e "ssh -p 2222"` for `rsync`.

Security note: RabbitMQ definitions can contain credentials in shovel/federation AMQP URIs. Raw files belong in `data/raw/`, which is git-ignored.

## 3. Functional requirements

### 3.1 Input/import

- Accept `.rar` archives with nested JSON files, including the current `Downloads.rar` sample.
- Accept `.zip` files with nested JSON files.
- Accept local folders with nested JSON files.
- Detect and parse:
  - RabbitMQ definitions exports.
  - Management API dumps split across `queues.json`, `exchanges.json`, `bindings.json`, `parameters.json`, `policies.json`, etc.
  - Custom per-host/per-vhost JSON shapes where possible.
- Infer host/cluster/vhost metadata from file path, definitions fields, or JSON content.
- Allow manual overrides when metadata is ambiguous.
- Collect diagnostics for malformed JSON, missing references, duplicate names, unknown parameter types, and unresolved remote endpoints.

### 3.2 Topology model

Represent:

- Host / cluster.
- Vhost.
- Exchange.
- Queue.
- Exchange-to-queue binding.
- Exchange-to-exchange binding.
- Alternate exchange.
- Dead-letter exchange/routing key.
- Shovel source and destination.
- Federation upstream/downstream links.
- RabbitMQ policies and runtime parameters relevant to shovels/federation.
- Unknown/external source when a remote endpoint is referenced but no matching topology file was loaded.

### 3.3 Querying

Given a queue or exchange name:

- Resolve exact matches first.
- Show ambiguous matches grouped by host/vhost.
- Support fuzzy search as a convenience, but never silently pick an ambiguous entity.
- Traverse upstream routes across:
  - Queue bindings.
  - Exchange-to-exchange bindings.
  - Alternate exchanges.
  - Dead-letter flows as optional reverse/debug flow.
  - Shovel source/destination links.
  - Federation links.
  - External/unresolved AMQP endpoints.
- Return:
  - Matching target entity.
  - Upstream entities.
  - Paths from source to target.
  - Edge labels: routing key, exchange type, binding args, shovel/federation name.
  - Explanation text: why a source can reach the target.

### 3.4 Visualization

- Interactive graph view.
- Node types:
  - Host.
  - Vhost.
  - Exchange.
  - Queue.
  - Shovel.
  - Federation link.
  - External/unresolved endpoint.
- Edge types:
  - Contains.
  - Binds/routes.
  - Alternate-exchange.
  - Dead-letter.
  - Shovels-to.
  - Federates-from.
- Features:
  - Search box for queue/exchange names.
  - Highlight full upstream flow for selected entity.
  - Filters for host, vhost, entity type, edge type, routing key, and depth.
  - Details side panel for selected node/edge.
  - Explanation panel for upstream paths.
  - Diagnostics panel for parse/linking warnings.

## 4. Recommended stack

Start as a local-first web app:

- Vite + React + TypeScript.
- React Flow for graph UI first.
- Cytoscape.js later if graph sizes become too large for React Flow.
- Zustand for UI state.
- JSZip for browser zip import.
- RAR support via a browser-safe WASM library such as `node-unrar-js`, or a local helper using `7z`/`unrar` for development-only extraction.
- Vitest for core parser/query tests.
- Playwright later for UI smoke tests.
- Optional Web Worker once imports/traversals become slow.

Why local-first first:

- Fastest path to usable tool.
- No server or database needed.
- Topology exports stay on the local machine.
- Core parser/query library can later move into a backend or desktop app unchanged.

## 5. Architecture

```text
Zip / Folder Input
        |
        v
File Loader
        |
        v
JSON Classifier
        |
        v
Shape-specific Parsers
        |
        v
Canonical Topology Model
        |
        v
Reference Resolver + Diagnostics
        |
        v
Flow Graph Builder
        |
        +-----------------------------+
        |                             |
        v                             v
Upstream Query Engine           Visual Graph UI
        |                             |
        v                             v
Explanation Panel               Node/Edge Details
```

Suggested module layout:

```text
src/
  core/
    model/
      ids.ts
      topology.ts
      graph.ts
      rabbitmq.ts
    parse/
      fileLoader.ts
      jsonClassifier.ts
      definitionsParser.ts
      managementDumpParser.ts
      parameterParser.ts
      policyParser.ts
      normalizer.ts
    resolve/
      endpointResolver.ts
      referenceResolver.ts
      diagnostics.ts
    graph/
      buildGraph.ts
      indexes.ts
      routing.ts
      traversal.ts
    query/
      findEntity.ts
      upstreamSources.ts
      pathExplain.ts
  ui/
    components/
      ImportPanel.tsx
      SearchBox.tsx
      GraphCanvas.tsx
      EntityDetails.tsx
      PathExplanation.tsx
      FiltersPanel.tsx
      DiagnosticsPanel.tsx
    state/
      topologyStore.ts
      queryStore.ts
  workers/
    topologyWorker.ts
```

## 6. Canonical data model

Use stable compound IDs so names can repeat across hosts/vhosts.

```ts
export type HostId = string;
export type VhostId = string;
export type ExchangeId = string;
export type QueueId = string;
export type BindingId = string;
export type LinkId = string;

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

export interface SourceFile {
  id: string;
  path: string;
  kind: "definitions" | "management-dump" | "parameters" | "policies" | "custom" | "unknown";
  hostHint?: string;
  vhostHint?: string;
}

export interface Host {
  id: HostId;
  name: string;
  clusterName?: string;
  environment?: string;
  sourceFiles: string[];
}

export interface Vhost {
  id: VhostId;
  hostId: HostId;
  name: string;
}

export interface Exchange {
  id: ExchangeId;
  hostId: HostId;
  vhostId: VhostId;
  name: string;
  type: "direct" | "topic" | "fanout" | "headers" | "consistent-hash" | string;
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

export interface Binding {
  id: BindingId;
  hostId: HostId;
  vhostId: VhostId;
  sourceExchangeId: ExchangeId;
  destinationId: ExchangeId | QueueId;
  destinationType: "exchange" | "queue";
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
```

Graph model:

```ts
export interface GraphNode {
  id: string;
  kind: "host" | "vhost" | "exchange" | "queue" | "shovel" | "federation" | "external";
  label: string;
  data: unknown;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "contains" | "binds" | "routes" | "shovels" | "federates" | "alternate-exchange" | "dead-letter";
  routingKey?: string;
  arguments?: Record<string, unknown>;
}
```

## 7. Routing and traversal design

RabbitMQ routing can be exact or approximate depending on exchange type and headers arguments. The tool should show **possible** flow, not guarantee every message matches every route.

### 7.1 Build routing edges

- Exchange-to-queue binding: exchange may route to queue.
- Exchange-to-exchange binding: upstream exchange may route to downstream exchange.
- Alternate exchange: original exchange may route unroutable messages to alternate exchange.
- Dead-letter exchange: queue may publish rejected/expired/dead-lettered messages to DLX.
- Shovel: source endpoint may feed destination endpoint.
- Federation: upstream exchange/queue may feed local/downstream exchange/queue.

### 7.2 Query upstream sources

For a target queue:

1. Start from queue node.
2. Reverse-traverse incoming route/binding edges to source exchange(s).
3. Continue reverse through exchange-to-exchange bindings.
4. Reverse through shovel/federation destination edges to their sources.
5. Mark unresolved remote endpoints as external source nodes.
6. Stop at:
   - Default/external publisher source.
   - Unknown endpoint.
   - Configured max depth.
   - Cycle already seen in current path.

For a target exchange:

1. Start from exchange node.
2. Reverse-traverse exchange-to-exchange bindings.
3. Reverse through shovels/federation that target the exchange.
4. Include external publisher source for the exchange.

### 7.3 Cycle handling

RabbitMQ topologies can contain cycles through exchange bindings, shovels, or federation. Traversal must track `(nodeId, pathSignature)` and return cycle diagnostics rather than recurse forever.

### 7.4 Routing-key notes

- Direct: binding key must equal publish routing key. If no publish key is known, display as possible.
- Topic: use `*` and `#` matcher when filtering by routing key.
- Fanout: route to all bindings.
- Headers: mark as conditional; show arguments.
- Unknown exchange type: mark as possible/unknown semantics.

## 8. Implementation phases

### Phase 0 — Bootstrap

- Create Vite/React/TypeScript app.
- Add Vitest.
- Add lint/typecheck/build scripts.
- Add sample fixtures with sanitized RabbitMQ definitions.
- Keep raw examples in `data/raw/` only.

### Phase 1 — Core parser/model

- Define canonical model and ID helpers.
- Implement definitions export parser.
- Implement split management dump parser.
- Implement runtime parameter parser for shovels/federation-upstream/federation-upstream-set.
- Implement policies parser for federation/shovel-related policies.
- Add diagnostics for missing source/destination references.

### Phase 2 — Graph + query engine

- Build graph nodes/edges from canonical topology.
- Build indexes by name, host, vhost, and kind.
- Implement exact/ambiguous/fuzzy entity search.
- Implement upstream traversal for queues and exchanges.
- Implement path explanations.
- Add cycle detection and max-depth controls.

### Phase 3 — Import UI

- Add file/RAR/zip/folder import panel.
- Parse files in browser.
- Show summary: hosts, vhosts, queues, exchanges, bindings, shovels, federation links, diagnostics.
- Add manual metadata override for host/vhost inference.

### Phase 4 — Visualization UI

- Add React Flow graph canvas.
- Add custom node styles for host/vhost/exchange/queue/shovel/federation/external.
- Add edge styles by flow type.
- Add search selection and upstream highlighting.
- Add details/explanation/diagnostics panels.
- Add filters for host/vhost/type/depth.

### Phase 5 — Scale/performance

- Move parsing/traversal into Web Worker if needed.
- Add graph pruning around selected entity.
- Add large-topology layout strategy.
- Consider Cytoscape.js for very large graphs.

### Phase 6 — Optional backend/desktop

- Add Tauri/Electron wrapper if local file access is awkward.
- Add backend indexing only if team-sharing or very large topologies require it.

## 9. Testing strategy

### Unit tests

- ID generation and parsing.
- RabbitMQ definitions parser.
- Split management dump parser.
- Shovel/federation parameter parsing.
- Topic routing matcher.
- Upstream traversal.
- Cycle detection.
- Path explanation.

### Fixture tests

Use sanitized fixtures:

- Single vhost: exchange -> queue.
- Exchange-to-exchange chain.
- Topic exchange with wildcard bindings.
- Queue with DLX.
- Exchange with alternate exchange.
- Shovel host A queue/exchange -> host B exchange/queue.
- Federation upstream host A -> host B.
- Unresolved external endpoint.
- Cycle through exchange bindings or shovels.

### UI tests later

- Import RAR/zip archive.
- Search queue.
- Highlight upstream path.
- Filter by host/vhost.
- Diagnostics display.

## 10. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Topology files contain credentials | Keep `data/raw/` git-ignored; sanitize before fixtures. |
| RabbitMQ exports vary by version | Use classifiers and diagnostics, not one rigid schema. |
| Shovel/federation endpoints may hide host/vhost inside AMQP URI | Parse URI carefully; redact credentials; allow manual endpoint mapping. |
| Ambiguous queue/exchange names across vhosts | Always qualify by host/vhost in UI and query results. |
| Large graphs become unreadable | Default to selected-neighborhood view, filters, depth limits. |
| Routing semantics can be conditional | Label results as “possible flow”; show routing key/headers conditions. |
| Cycles cause traversal explosion | Cycle detection, max depth, deduped path signatures. |

## 11. Automation plan

A scheduled automation job should run every 2 hours:

1. Acquire repo lock so overlapping runs do not collide.
2. Inspect git status.
3. Use Claude 4.7-family model for coding: configured slug `anthropic/claude-opus-4-7`.
4. Complete at least one unchecked task from `TASKS.md` when possible.
5. Run the smallest meaningful verification gate.
6. Use OpenAI 5.6-family model for review: configured slug `openai/gpt-5.6-sol`.
7. Commit only if the OpenAI review approves.
8. Leave rejected or blocked changes uncommitted for inspection/follow-up.
9. Never commit `data/raw/`.

## 12. Initial acceptance criteria

The first useful release should be able to:

- Import a definitions JSON file.
- Import a RAR or zip archive containing multiple topology JSON files.
- Show counts and diagnostics.
- Search for a queue/exchange by name.
- Display upstream paths for a queue.
- Render a visual graph with highlighted upstream paths.
- Include tests proving cross-host shovel traversal works.
