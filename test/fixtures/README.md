# Test fixtures

Sanitized RabbitMQ topology fixtures for parser and query engine tests.

All connection URIs use `REDACTED` in place of credentials and reference
`*.example.internal` hostnames. Nothing here should ever contain real
credentials or real infrastructure hostnames.

## Files

- `minimal-definitions.json` — a single `definitions` export covering the
  shapes the parser needs to handle first:
  - Two vhosts (`/`, `orders`) with permissions.
  - Exchanges of type `direct`, `topic`, and `fanout`.
  - Queues bound directly and via topic patterns.
  - An exchange-to-exchange binding (`orders.in` → `orders.audit`).
  - An alternate exchange (`orders.in` → `orders.unrouted` via
    `alternate-exchange` argument).
  - A dead-letter policy targeting `work.*` queues with `work.dlx` and
    `work.dead`.
  - A shovel runtime parameter feeding `orders.in` from a remote host.
  - A federation-upstream runtime parameter plus a matching
    `federation-upstream-set` policy on `orders.*` exchanges.

Use this fixture to exercise the definitions parser, upstream traversal
across shovel/federation, and cross-vhost queue resolution.

- `rabbit-3.12-shovel-ha-uri.json` — sanitized reproduction of the
  RabbitMQ 3.12.6 export shape that motivated the shovel HA URI
  compatibility fix. Every `parameters[*].value["src-uri"]` and
  `["dest-uri"]` is a JSON array (RabbitMQ's HA form), plus one shovel
  mixes a scalar `src-uri` with a single-entry `dest-uri` array. All
  URIs already read `amqp://REDACTED@…` and reference only
  `*.example.internal` hostnames — no credentials, no real
  infrastructure names. Use this fixture as the failing-shape
  regression pin for the parser and buildGraph pipeline.

- `rabbit-3.8-legacy.json` — representative legacy shape from the
  RabbitMQ 3.8 line: `tags` as a scalar string on the user record,
  scalar `src-uri` / `dest-uri` on the shovel parameter, classic
  queues without an explicit `x-queue-type`. Pins that the parser
  still tolerates the older export shape and does not regress on
  simpler payloads.

- `rabbit-4.0-current.json` — representative current shape from the
  RabbitMQ 4.x line: rich vhost fields (`description`, `tags` array,
  `default_queue_type`, nested `metadata`), quorum queues via
  `arguments["x-queue-type"] = "quorum"`, and a shovel that mixes an
  HA-form `src-uri` array with a scalar `dest-uri`. Pins that
  additive vhost fields do not raise warnings and that the fixture
  parses end-to-end without credential leakage.
