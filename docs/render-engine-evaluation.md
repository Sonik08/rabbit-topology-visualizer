# Render engine evaluation — React Flow vs Cytoscape.js

_Date: 2026-08-27._

## TL;DR

Stay on **React Flow** for now. Revisit **Cytoscape.js** only if measured performance on a real production topology crosses one of the thresholds in the [Switching criteria](#switching-criteria) section.

Filters (`applyGraphFilters`) and the `pruneNeighborhood` utility are the primary leverage for keeping the rendered graph small; the render engine is a downstream concern.

## Scope of this document

This is a **decision doc**, not a benchmark report. No measurements were taken as part of writing it — the current app has not been driven against a real production topology under any of the thresholds below. Every "empirical" or "60 fps" claim from any earlier draft has been removed. Any bundle-size / migration-effort figures below are order-of-magnitude estimates for planning purposes, not measured numbers.

If a switch is proposed later, that proposal must ship benchmark evidence gathered per the methodology in [How to measure](#how-to-measure).

## Where we are today

- React Flow v11.11.4 renders every node/edge produced by `toReactFlowElements` inside `<TopologyGraphCanvas>` (`src/ui/components/TopologyGraphCanvas.tsx`).
- The Web Worker client (`src/core/import/importArchiveWorkerClient.ts`, exposed via `getSharedTopologyWorkerClient`) handles exactly four request kinds — `import`, `build-graph`, `upstream-for-queue`, `upstream-for-exchange` — see `src/core/import/importArchiveWorkerMessage.ts`. Nothing else runs off-thread.
- `applyGraphFilters` runs on the **main thread** inside `useTopologyGraph`, on top of the worker's `BuildGraphResult`. Cheap enough to run synchronously, but explicitly NOT off-thread.
- The `useTopologyGraph` hook (`src/ui/hooks/useTopologyGraph.ts`) is the single production consumer of the worker client for graph work. On selection, it calls `workerClient.upstreamForQueue` or `upstreamForExchange` with `{ maxDepth: filters.maxDepth }` — the actual BFS runs off-thread. The returned `UpstreamTraversalResult` is then handed to the local `highlightFromTraversal(input, targetNodeId, traversal)` helper to build the `UpstreamHighlight` node/edge sets on the main thread.
- `computeUpstreamHighlight` still exists as a synchronous alternative (traversal + highlight assembly in one call) but is NOT in the async production path any longer.
- User-visible filters today: `TopologyFiltersPanel` — host, vhost, entity kind, edge kind, routing-key substring, and depth. `filters.maxDepth` flows into the worker call as `UpstreamTraversalOptions.maxDepth` on `workerClient.upstreamForQueue` / `upstreamForExchange`; the returned `UpstreamTraversalResult` is then assembled into an `UpstreamHighlight` locally by `highlightFromTraversal`. `computeUpstreamHighlight` is a separate main-thread helper used elsewhere (it internally calls `traverseUpstream` synchronously) and is NOT in the async production path any longer.
- `pruneNeighborhood` (`src/core/graph/pruneNeighborhood.ts`) exists as a **pure utility only**. It is not wired into `TopologyGraphCanvas` or any panel yet — it is a leverage point available for future work but currently not user-facing.

## What Cytoscape.js would (plausibly) buy us

The rows below are qualitative, based on published documentation from each library. They are not measured numbers.

| Concern | React Flow (current) | Cytoscape.js |
| --- | --- | --- |
| DOM nodes per rendered node | 1+ per node (React-managed div) | 0 for the graph body — canvas rendering |
| Layout algorithms | Bring-your-own (custom column layout today) | Built-in: cose, breadthfirst, dagre, cola, klay |
| Selection / hit-testing | React state + custom | Native, includes box-selection |
| Bundle size delta | Ships today (Vite build output shows a `dist/assets/importArchiveWorker-*.js` + main bundle around 500 kB minified) | Estimated +100–200 kB gz for cytoscape core + dagre + extensions — needs a real bundle measurement before this figure is trusted |
| Migration effort | 0 | Estimated 2–3 developer-days to port `toReactFlowElements`, styling, click handlers, and canvas tests — no work breakdown has been produced yet |

## What React Flow already gives us that we'd lose

- **React-native interop** — every node is a React component, so we can render any panel/label with hooks. Cytoscape can host DOM overlays but the ergonomics degrade.
- **Existing tests** — `topologyGraphElements.test.ts` (10) + `topologyGraphCanvasPipeline.test.ts` (8) + component tests rely on the React tree shape.
- **Familiar API** — the team has already burned the ramp-up cost on `FlowNode` / `FlowEdge` / `markerEnd` / `MiniMap`.

## Switching criteria

Only propose a switch if measurements on a real production export show **at least one** of these thresholds crossed. Below **all** of these, keep tuning filters and (when we wire it in) `pruneNeighborhood` first.

1. Interaction latency (pan/zoom, select-and-highlight) > **200 ms P95** on the target laptop.
2. Initial paint of the filtered sub-graph after the worker resolves > **1 s** with all filters at defaults.
3. Resident memory > **500 MB** for a single import.
4. Dropped-frame ratio > **30 %** during a 5-second pan/zoom sample.

_Target hardware:_ mid-range laptop (roughly 2 GHz CPU, 8 GB RAM, Chrome or Firefox latest stable). Adjust before running if the fleet changes.

## How to measure

Before proposing a switch, capture the numbers above:

1. Import a real production topology into the app (locally — never commit under `data/raw/`).
2. Chrome DevTools → Performance panel:
   - Record a 5 s pan/zoom on the graph canvas → check dropped-frame ratio + P95 interaction latency.
   - Reload the page with the filters at defaults → measure time from `useTopologyGraph`'s `buildLoading → false` transition to first paint (the stats-line update is a convenient anchor).
3. Chrome DevTools → Memory panel: heap snapshot after one full import + one selection cycle.
4. Log the numbers in `docs/render-engine-benchmarks/<YYYY-MM-DD>.md` (create the folder). Cite the topology size (`rawGraph.nodes.length` / `rawGraph.edges.length` from the stats line) so a follow-up run can compare apples to apples.

## Migration plan (only if triggered)

If the thresholds are crossed and the measurements are logged:

1. Introduce `src/ui/components/topologyCytoscapeElements.ts` that maps `BuildGraphResult` → Cytoscape `elements` payload (mirror the current `toReactFlowElements` shape).
2. Add a `RenderEngine` feature flag on `TopologyGraphCanvas` so both engines can live side-by-side during ramp.
3. Port styling to Cytoscape stylesheets (topology palette, per-kind background, animated shovel/federation edges).
4. Port `onNodeClick` + `onPaneClick` handlers to Cytoscape's event model.
5. Reuse `EntityDetailsPanel`, `PathExplanationPanel`, `TopologyFiltersPanel` unchanged (they consume `GraphNode` / `UpstreamHighlight`, not React Flow types).
6. Migrate existing render tests to a Cytoscape-agnostic layer (assert against the intermediate flow-graph representation) so both engines share the same test surface.
7. Remove the flag + `topologyGraphElements.ts` once the Cytoscape path is default.

## Decision

**Not switching now.** No production topology has been measured yet, so no threshold has been shown to be crossed. Task 63 is closed as an evaluation — the outcome is documented above with concrete thresholds, a measurement recipe, and a migration plan for the future.

## References

- `src/ui/components/TopologyGraphCanvas.tsx`
- `src/ui/components/topologyGraphElements.ts`
- `src/core/graph/pruneNeighborhood.ts` (utility only — not wired into the UI yet)
- `src/core/graph/filterGraph.ts` (main-thread)
- `src/core/graph/upstreamHighlight.ts` — `highlightFromTraversal` runs locally on the worker's `UpstreamTraversalResult`; `computeUpstreamHighlight` is the fully-synchronous helper (not in the async production path)
- `src/core/import/importArchiveWorkerMessage.ts` (worker-side request kinds — `import` / `build-graph` / `upstream-for-queue` / `upstream-for-exchange`)
- `src/ui/hooks/useTopologyGraph.ts` (production consumer of the worker client)
- Cytoscape.js docs: https://js.cytoscape.org
- React Flow docs: https://reactflow.dev
