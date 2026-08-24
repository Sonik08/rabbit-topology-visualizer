# AGENTS.md — Rabbit Topology Visualizer

## Project goal

Build a local-first RabbitMQ topology visualizer. It loads topology JSON/zip/folder inputs, models queues/exchanges/bindings/shovels/federation across hosts/vhosts, and shows upstream message flow for a selected queue or exchange.

## Safety

- Raw topology exports may contain credentials in AMQP URIs.
- Never commit files under `data/raw/`.
- Never print secrets from topology files in logs, tests, docs, or fixtures.
- Sanitized fixtures may live under `test/fixtures/` or `src/**/__fixtures__/`.

## Automation workflow

For scheduled coding runs:

1. Inspect `git status --short --branch` before editing.
2. Read `PLAN.md` and `TASKS.md`.
3. Complete the first unchecked task that can be finished safely.
4. Prefer focused, small changes.
5. Add or update tests for core logic changes.
6. Run the smallest meaningful verification gate:
   - `npm test` if tests exist.
   - `npm run typecheck` if configured.
   - `npm run build` if configured.
   - If no app scaffold exists yet, verify by direct file inspection.
7. Update `TASKS.md` by checking off completed tasks with a concise note if useful.
8. Do not commit directly from the coding model. The cron runner performs OpenAI review and commits approved changes.

## Code style

- TypeScript for core model/parser/query code.
- Keep parsing/query code framework-independent under `src/core/`.
- Keep UI code under `src/ui/` or standard Vite app locations.
- Write clear diagnostics instead of throwing on every malformed input.
