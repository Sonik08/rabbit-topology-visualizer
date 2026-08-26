import { useState } from "react";
import { ImportPanel } from "./ui/components/ImportPanel";
import { EntitySearchBox } from "./ui/components/EntitySearchBox";
import { TopologyGraphCanvas } from "./ui/components/TopologyGraphCanvas";
import type { ImportResult } from "./core/import";

export function App(): JSX.Element {
  const [result, setResult] = useState<ImportResult | undefined>(undefined);
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Rabbit Topology Visualizer</h1>
      <p>
        Local-first tool for exploring RabbitMQ topology exports. Import a
        definitions JSON, a management-dump JSON, or a RAR/zip archive that
        wraps them.
      </p>
      <ImportPanel onImported={setResult} />
      {result && <EntitySearchBox result={result} />}
      {result && <TopologyGraphCanvas result={result} />}
    </main>
  );
}
