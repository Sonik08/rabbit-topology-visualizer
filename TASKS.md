# RabbitMQ Topology Visualizer — Task Backlog

Automation rule: each 2-hour run should complete at least one unchecked task when possible, run verification, request OpenAI review, then commit and push approved changes to GitHub.

## Bootstrap

- [ ] Create Vite + React + TypeScript app scaffold.
- [ ] Add Vitest and baseline `test`, `typecheck`, and `build` scripts.
- [ ] Add project-local `AGENTS.md` with coding/automation rules.
- [ ] Add sanitized minimal RabbitMQ definitions fixture.

## Core model and parsing

- [ ] Define canonical topology TypeScript model and stable ID helpers.
- [ ] Implement JSON shape classifier for definitions exports vs split management dumps.
- [ ] Implement RabbitMQ definitions export parser for exchanges, queues, bindings, vhosts, policies, and parameters.
- [ ] Implement split management dump parser for `queues.json`, `exchanges.json`, `bindings.json`, `parameters.json`, and `policies.json`.
- [ ] Implement runtime parameter parsing for shovels and federation upstreams.
- [ ] Implement AMQP URI parser that redacts credentials and extracts host/vhost hints.
- [ ] Implement RAR archive import support for the current `Downloads.rar` sample.
- [ ] Implement diagnostics for malformed JSON, missing references, duplicates, and unresolved endpoints.

## Graph and query engine

- [ ] Build graph nodes/edges from canonical topology.
- [ ] Build indexes by exact name, kind, host, and vhost.
- [ ] Implement exact and ambiguous search for queues/exchanges.
- [ ] Implement fuzzy search for queue/exchange names.
- [ ] Implement topic routing-key matcher.
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
