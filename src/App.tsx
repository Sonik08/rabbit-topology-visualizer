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
  // Focus state is hoisted alongside selection so a search-driven pick clips
  // the canvas to that entity's reachable message-flow neighborhood (task 53's
  // "switch the canvas into a focused mode"), not merely highlights the node
  // in the full topology. Canvas-driven `onFocusChange(undefined)` (Show full
  // topology) clears the focus without dropping the highlight, so the user
  // can keep inspecting the same entity in unfocused context.
  const [focusNodeId, setFocusNodeId] = useState<string | undefined>(undefined);
  const handleImported = useCallback((next: ImportResult) => {
    setResult(next);
    // A new import invalidates the current selection — the previously
    // highlighted node id may not exist in the freshly built graph. Same
    // for focus: a stale focus id would otherwise show the empty-view
    // banner against a freshly built graph.
    setSelectedNodeId(undefined);
    setFocusNodeId(undefined);
  }, []);
  const handleSearchSelect = useCallback((entity: IndexedEntity) => {
    setSelectedNodeId(entity.id);
    setFocusNodeId(entity.id);
  }, []);
  return (
    <main style={appMainStyle}>
      <h1 style={appHeadingStyle}>Rabbit Topology Visualizer</h1>
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
          focusNodeId={focusNodeId}
          onFocusChange={setFocusNodeId}
        />
      )}
    </main>
  );
}

// Fluid page shell — clamps padding so ultra-narrow phones still get a usable
// gutter (0.75rem) while wide desktops keep a comfortable 2rem inset without
// pinning the content to a fixed max-width. `minHeight: 100vh` lets the shell
// fill the viewport; `boxSizing: border-box` prevents the padding from
// pushing the visible area past 100vw and producing a horizontal scrollbar.
const appMainStyle: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  padding: "clamp(0.75rem, 2vw, 2rem)",
  minHeight: "100vh",
  width: "100%",
  maxWidth: "100%",
  boxSizing: "border-box",
};

const appHeadingStyle: React.CSSProperties = {
  // Heading scales with viewport so it stays proportional at every
  // breakpoint — never becomes a full-width banner on ultra-wide screens
  // nor a wrapped run-on line on narrow ones.
  fontSize: "clamp(1.3rem, 3vw, 2rem)",
  margin: "0 0 0.5rem",
};
