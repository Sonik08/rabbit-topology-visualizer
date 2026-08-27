import { useEffect, useState } from "react";

export interface ConfiguredFlowLegendProps {
  paused: boolean;
  reducedMotion: boolean;
  onTogglePause: () => void;
}

/**
 * Compact caption + control for the shovel / federation animation shown on
 * the topology canvas. The wording spells out "configured message flow" so
 * operators cannot mistake the marching-ants animation for live message-rate
 * telemetry — the visualization is derived entirely from static topology
 * definitions and carries no live throughput information. If a live rate
 * feed is ever wired up, the caller is responsible for updating both this
 * caption and the animation-speed scaling so the distinction remains
 * explicit.
 *
 * When `reducedMotion` is true (the OS reports
 * `prefers-reduced-motion: reduce`), the button is disabled and the
 * state label states that reduced-motion overrode the pause toggle. That
 * order matters — an accessibility preference always wins over the user's
 * transient pause state.
 */
export function ConfiguredFlowLegend({
  paused,
  reducedMotion,
  onTogglePause,
}: ConfiguredFlowLegendProps): JSX.Element {
  const animationOff = paused || reducedMotion;
  const stateLabel = reducedMotion
    ? "animation off (reduced motion)"
    : paused
      ? "animation paused"
      : "animation on";
  return (
    <div
      data-testid="topology-configured-flow-legend"
      style={legendStyle}
    >
      <span data-testid="topology-configured-flow-caption" style={captionStyle}>
        Configured message flow · shovel &amp; federation edges depict declared
        topology direction, <strong>not live traffic</strong>.
      </span>
      <span
        data-testid="topology-configured-flow-state"
        style={stateStyle(animationOff)}
      >
        {stateLabel}
      </span>
      <button
        type="button"
        onClick={onTogglePause}
        disabled={reducedMotion}
        data-testid="topology-configured-flow-pause"
        title={
          reducedMotion
            ? "Animation is disabled because the OS reports prefers-reduced-motion"
            : paused
              ? "Resume configured-flow animation"
              : "Pause configured-flow animation"
        }
        style={pauseButtonStyle}
      >
        {paused ? "Resume" : "Pause"} animation
      </button>
    </div>
  );
}

/**
 * Reads the current `prefers-reduced-motion` state and subscribes to changes
 * so a user toggling their OS accessibility setting is honoured live without
 * a page reload. SSR-safe: returns `false` when `window` is unavailable.
 * Extracted alongside `ConfiguredFlowLegend` because the two are always used
 * together.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listener = (e: MediaQueryListEvent): void => setReduced(e.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", listener);
      return () => mq.removeEventListener("change", listener);
    }
    mq.addListener(listener);
    return () => mq.removeListener(listener);
  }, []);
  return reduced;
}

const legendStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  padding: "0.35rem 0.6rem",
  background: "#fff8e1",
  border: "1px solid #d9b46a",
  borderRadius: 4,
  fontSize: "0.75rem",
  marginBottom: "0.5rem",
  flexWrap: "wrap",
};

const captionStyle: React.CSSProperties = {
  color: "#6a4600",
  flex: "1 1 auto",
  minWidth: 200,
};

function stateStyle(animationOff: boolean): React.CSSProperties {
  return {
    color: animationOff ? "#7a5010" : "#2f6feb",
    fontVariant: "small-caps",
    letterSpacing: "0.03em",
  };
}

const pauseButtonStyle: React.CSSProperties = {
  padding: "0.2rem 0.6rem",
  border: "1px solid #b0862a",
  background: "#fffdf3",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: "0.72rem",
};
