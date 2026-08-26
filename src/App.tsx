import { ImportPanel } from "./ui/components/ImportPanel";

export function App(): JSX.Element {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Rabbit Topology Visualizer</h1>
      <p>
        Local-first tool for exploring RabbitMQ topology exports. Import a
        definitions JSON, a management-dump JSON, or a RAR/zip archive that
        wraps them.
      </p>
      <ImportPanel />
    </main>
  );
}
