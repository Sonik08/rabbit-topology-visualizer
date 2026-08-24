# Rabbit Topology Visualizer

Local-first tool for loading RabbitMQ topology JSON exports and visualizing how queues, exchanges, bindings, shovels, and cross-host flows relate.

## Current status

Planning/bootstrap stage. See `PLAN.md` and `TASKS.md`.

## Data safety

Raw RabbitMQ topology exports can include credentials inside AMQP shovel/federation URIs. Put raw zips under `data/raw/`; this path is intentionally git-ignored.
