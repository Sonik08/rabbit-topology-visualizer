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
