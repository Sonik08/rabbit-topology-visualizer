# RabbitMQ Topology Visualizer — Task Backlog

Automation rule: each 2-hour run should complete at least one unchecked task when possible, run verification, request OpenAI review, then commit and push approved changes to GitHub.

## Bootstrap

- [x] Create Vite + React + TypeScript app scaffold. (package.json, vite.config.ts, tsconfig*.json, index.html, src/main.tsx, src/App.tsx)
- [x] Add Vitest and baseline `test`, `typecheck`, and `build` scripts. (vitest devDep, `test`/`test:watch` scripts, `test` block in vite.config.ts, test/smoke.test.ts)
- [x] Add project-local `AGENTS.md` with coding/automation rules. (AGENTS.md — landed in bootstrap; checkbox was stale)
- [x] Add sanitized minimal RabbitMQ definitions fixture. (test/fixtures/minimal-definitions.json)

## Core model and parsing

- [x] Define canonical topology TypeScript model and stable ID helpers. (src/core/model/topology.ts, src/core/model/ids.ts, src/core/model/index.ts + 13 unit tests in test/core/model/ids.test.ts)
- [x] Implement JSON shape classifier for definitions exports vs split management dumps. (src/core/parse/jsonClassifier.ts with filename + content heuristics, host/vhost path hints, adds `management-dump-vhosts`; 15 unit tests in test/core/parse/jsonClassifier.test.ts)
- [x] Implement RabbitMQ definitions export parser for exchanges, queues, bindings, vhosts, policies, and parameters. (src/core/parse/definitionsParser.ts with `parseDefinitionsExport`, ID resolution, inferred-vhost + duplicate + missing-source-destination diagnostics, dead-letter arg extraction, cluster hint from `global_parameters`; keeps sanitized `parameters` as `RawParameter[]` for the shovel/federation task, including array-valued federation upstream sets; 17 unit tests in test/core/parse/definitionsParser.test.ts)
- [x] Implement split management dump parser for `queues.json`, `exchanges.json`, `bindings.json`, `parameters.json`, and `policies.json`. (src/core/parse/splitDumpParser.ts with `parseSplitManagementDump` composing over `parseDefinitionsExport`, per-file sourceFileId tracking on host, `split-dump.file-not-array` diagnostic; 6 unit tests in test/core/parse/splitDumpParser.test.ts)
- [x] Implement runtime parameter parsing for shovels and federation upstreams. (src/core/parse/runtimeParameters.ts with `parseRuntimeParameters` producing `Shovel[]` / `FederationLink[]` / `FederationUpstreamSetEntry[]`; consumes AMQP URI parser for redaction + host/vhost hints; supports dashed + underscored keys; 11 unit tests in test/core/parse/runtimeParameters.test.ts)
- [x] Implement AMQP URI parser that redacts credentials and extracts host/vhost hints. (src/core/parse/amqpUri.ts with `parseAmqpUri` and `redactAmqpUri`, no raw/user credential fields in parsed output, query/fragment-safe URL parsing, IPv6 + percent-encoded vhost support, default port from scheme; 16 unit tests in test/core/parse/amqpUri.test.ts)
- [x] Implement RAR archive import support for the current `Downloads.rar` sample. (adds `node-unrar-js` dep, src/core/parse/rarLoader.ts with `loadRarArchive` + `filterJsonEntries`, path-string filter, unsafe path + encrypted-entry diagnostics, compressed archive / entry count / per-entry bytes / total bytes limits; MIT-licensed FolderTest.rar fixture in test/fixtures/rar/; 10 unit tests in test/core/parse/rarLoader.test.ts covering round-trip + error paths + safety limits)
- [x] Implement diagnostics for malformed JSON, missing references, duplicates, and unresolved endpoints. (adds `safeParseJson` in src/core/parse/safeJson.ts with `parse.{malformed-json,empty-input,non-string-input}`; adds src/core/resolve/{diagnostics.ts,index.ts} with `dedupeDiagnostics`, `groupBySeverity`, `sortBySeverity`, `summarizeDiagnostics`; existing parsers already emit the missing-reference/duplicate/unresolved-endpoint codes surfaced by these helpers; 10 unit tests across test/core/parse/safeJson.test.ts + test/core/resolve/diagnostics.test.ts)

## Graph and query engine

- [x] Build graph nodes/edges from canonical topology. (adds src/core/model/graph.ts with `GraphNode`/`GraphEdge`/`GraphNodeKind`/`GraphEdgeKind`; adds src/core/graph/buildGraph.ts + index.ts with `buildGraph` producing host/vhost/exchange/queue/shovel/federation/external nodes and contains/binds/alternate-exchange/dead-letter/shovels/federates edges, `contains` edges also link vhost→shovel and vhost→federation; external node ids AND labels sanitize each source segment via `safeSegment` *before* percent-encoding so any URI embedded in `ref.host`/`ref.vhost`/`ref.exchange`/`ref.queue` can't hide behind `%3A%2F%2F`; a final defensive gate runs every returned node, edge, and diagnostic through `deepSanitize` so any `amqp[s]://…` substring (nested, embedded, whitespace-prefixed, in labels, routing keys, arguments, or diagnostic messages) is redacted via `redactAmqpUri`; emits `graph.{alternate,dead-letter}-exchange-unresolved` diagnostics; 25 unit tests in test/core/graph/buildGraph.test.ts including per-kind leak checks (exchange args, queue args, binding routing key, diagnostic message, every external-ID source field) and a whole-graph credential-leak check that poisons every node kind + every edge kind + a diagnostic)
- [x] Build indexes by exact name, kind, host, and vhost. (adds src/core/graph/indexes.ts exporting `IndexedEntity`, `IndexedEntityKind`, `TopologyIndexes`, `BuildIndexesInput`, `buildTopologyIndexes`; extends src/core/graph/index.ts barrel; index accessors return defensive copies so callers can mutate without corrupting internal state; 8 unit tests in test/core/graph/indexes.test.ts including end-to-end from the sanitized fixture)
- [x] Implement exact and ambiguous search for queues/exchanges. (adds src/core/query/findEntity.ts + index.ts exporting `findEntity`, `EntitySearchKind`, `EntitySearchOptions`, `EntitySearchResult`, `EntitySearchGroup`; exact-name lookup over `TopologyIndexes` with optional kind/host/vhost filters, `ambiguous` flag when >1 match survives, results grouped by (host, vhost) for UI-friendly disambiguation; 9 unit tests in test/core/query/findEntity.test.ts)
- [x] Implement fuzzy search for queue/exchange names. (adds src/core/query/fuzzyFindEntity.ts + barrel export exporting `fuzzyFindEntity`, `FuzzySearchOptions`, `FuzzySearchMatch`, `FuzzyMatchReason`; case-insensitive scorer with strictly disjoint tier bands — exact=1.0, prefix∈[0.80,0.85], substring∈[0.55,0.70], subsequence∈[0.30,0.50] — so `exact > prefix > substring > subsequence` is a hard invariant; stable sort by score desc then name asc; host/vhost/kind filters plus clamped `limit` (negative/0 → [], non-finite → default) and `minScore` (negative → 0, non-finite → default, >1 legitimately filters everything); 17 unit tests in test/core/query/fuzzyFindEntity.test.ts)
- [x] Implement topic routing-key matcher. (adds src/core/graph/topicMatcher.ts exporting `matchTopicRoutingKey`, `isTopicPattern`; word-tokenized memoized DP over `(patternIndex, keyIndex)` — O(P·K) time and space, so adversarial `#.#.#.…` patterns can't backtrack combinatorially; handles `*` (exactly one word), `#` (zero or more words) at any position, multiple `#`s, and empty words from leading/trailing/consecutive dots; extends src/core/graph/index.ts barrel; 24 unit tests in test/core/graph/topicMatcher.test.ts including adversarial-'#' timing bounds and empty-word coverage)
- [ ] Implement upstream traversal for queue targets.
- [ ] Implement upstream traversal for exchange targets.
- [ ] Implement cross-host shovel/federation traversal.
- [ ] Implement cycle detection and max-depth traversal limits.
- [ ] Implement path explanation output.

## UI

- [ ] Add file/RAR/zip import panel.
- [ ] Add topology summary and diagnostics panel.
- [ ] Add search box for queue/exchange names.
- [ ] Add graph canvas with React Flow.
- [ ] Add custom node/edge styling by entity/flow type.
- [ ] Highlight upstream paths for selected queue/exchange.
- [ ] Add entity details panel.
- [ ] Add path explanation panel.
- [ ] Add filters for host, vhost, entity type, edge type, routing key, and depth.

## Tests and quality

- [ ] Add tests for parser fixtures.
- [ ] Add tests for topic routing matcher.
- [ ] Add tests for queue upstream traversal.
- [ ] Add tests for exchange upstream traversal.
- [ ] Add tests for cross-host shovel traversal.
- [ ] Add tests for federation traversal.
- [ ] Add tests for cycle detection.
- [ ] Add build/typecheck gate in CI-ready script.

## Later options

- [ ] Move parsing/query work into a Web Worker for large topologies.
- [ ] Add graph neighborhood pruning for very large graphs.
- [ ] Evaluate Cytoscape.js if React Flow struggles with large datasets.
- [ ] Add Tauri/Electron packaging if browser file APIs are limiting.
