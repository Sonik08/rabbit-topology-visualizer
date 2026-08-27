import { useCallback, useState } from "react";
import { ImportPanel } from "./ui/components/ImportPanel";
import { EntitySearchBox } from "./ui/components/EntitySearchBox";
import { TopologyGraphCanvas } from "./ui/components/TopologyGraphCanvas";
import type { ImportResult } from "./core/import";
import type { IndexedEntity } from "./core/graph/indexes";

export function App(): JSX.Element {
  const [result, setResult] = useState<ImportResult | undefined>(undefined);
  // Selection state is hoisted so `EntitySearchBox` (via `onSelect`) can drive
  // the same highlight that `TopologyGraphCanvas` uses for its click-driven
  // selection. Selecting a search result focuses the matching graph node
  // without any extra clicks.
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const handleImported = useCallback((next: ImportResult) => {
    setResult(next);
    // A new import invalidates the current selection — the previously
    // highlighted node id may not exist in the freshly built graph.
    setSelectedNodeId(undefined);
  }, []);
  const handleSearchSelect = useCallback((entity: IndexedEntity) => {
    setSelectedNodeId(entity.id);
  }, []);
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Rabbit Topology Visualizer</h1>
      <p>
        Local-first tool for exploring RabbitMQ topology exports. Import a
        definitions JSON, a management-dump JSON, or a RAR/zip archive that
        wraps them.
      </p>
      <ImportPanel onImported={handleImported} />
      {result && <EntitySearchBox result={result} onSelect={handleSearchSelect} />}
      {result && (
        <TopologyGraphCanvas
          result={result}
          selectedNodeId={selectedNodeId}
          onSelectionChange={setSelectedNodeId}
        />
      )}
    </main>
  );
}
