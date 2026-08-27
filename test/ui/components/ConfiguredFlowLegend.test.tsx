import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfiguredFlowLegend } from "../../../src/ui/components/ConfiguredFlowLegend";

afterEach(() => cleanup());

/**
 * The legend is the operator-facing anchor for the "configured message flow"
 * mental model. These tests pin:
 *   1. The wording explicitly disclaims live traffic.
 *   2. The pause button toggles independently of any external state.
 *   3. `reducedMotion` disables the pause toggle AND overrides the state
 *      label so an accessibility preference always wins.
 */

describe("ConfiguredFlowLegend — configured (not live) caption", () => {
  it("caption states shovel & federation edges depict *configured*, not live, message flow", () => {
    render(<ConfiguredFlowLegend paused={false} reducedMotion={false} onTogglePause={() => {}} />);
    const caption = screen.getByTestId("topology-configured-flow-caption");
    expect(caption.textContent).toMatch(/Configured message flow/i);
    expect(caption.textContent).toMatch(/not live traffic/i);
  });
});

describe("ConfiguredFlowLegend — pause control", () => {
  it("defaults to 'animation on' with a 'Pause animation' button when not paused and not reduced-motion", () => {
    render(<ConfiguredFlowLegend paused={false} reducedMotion={false} onTogglePause={() => {}} />);
    const btn = screen.getByTestId("topology-configured-flow-pause") as HTMLButtonElement;
    expect(btn.textContent).toMatch(/Pause animation/);
    expect(btn.disabled).toBe(false);
    expect(screen.getByTestId("topology-configured-flow-state").textContent).toMatch(
      /animation on/,
    );
  });

  it("clicking the button invokes onTogglePause without any state assumption", () => {
    const onTogglePause = vi.fn();
    render(<ConfiguredFlowLegend paused={false} reducedMotion={false} onTogglePause={onTogglePause} />);
    fireEvent.click(screen.getByTestId("topology-configured-flow-pause"));
    expect(onTogglePause).toHaveBeenCalledTimes(1);
  });

  it("swaps to 'Resume animation' when paused=true and reports 'animation paused'", () => {
    render(<ConfiguredFlowLegend paused={true} reducedMotion={false} onTogglePause={() => {}} />);
    expect(
      (screen.getByTestId("topology-configured-flow-pause") as HTMLButtonElement).textContent,
    ).toMatch(/Resume animation/);
    expect(screen.getByTestId("topology-configured-flow-state").textContent).toMatch(
      /animation paused/,
    );
  });
});

describe("ConfiguredFlowLegend — reduced-motion override", () => {
  it("reducedMotion=true disables the button and reports 'animation off (reduced motion)' regardless of the pause flag", () => {
    render(<ConfiguredFlowLegend paused={false} reducedMotion={true} onTogglePause={() => {}} />);
    const btn = screen.getByTestId("topology-configured-flow-pause") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByTestId("topology-configured-flow-state").textContent).toMatch(
      /animation off \(reduced motion\)/,
    );
  });

  it("reducedMotion=true wins over paused=true — state label still shows the reduced-motion reason", () => {
    render(<ConfiguredFlowLegend paused={true} reducedMotion={true} onTogglePause={() => {}} />);
    expect(screen.getByTestId("topology-configured-flow-state").textContent).toMatch(
      /animation off \(reduced motion\)/,
    );
  });
});
