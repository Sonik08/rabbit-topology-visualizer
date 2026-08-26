import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { GraphNode } from "../../../src/core/model";
import { EntityDetailsPanel } from "../../../src/ui/components/EntityDetailsPanel";

afterEach(() => {
  cleanup();
});

describe("EntityDetailsPanel", () => {
  it("shows an empty-state hint when no node is selected", () => {
    render(<EntityDetailsPanel />);
    const panel = screen.getByTestId("entity-details-panel");
    expect(panel.textContent).toMatch(/Select a node/i);
  });

  it("renders the selected exchange's kind badge, title, and structured rows", () => {
    const node: GraphNode = {
      id: "exchange:a:x1",
      kind: "exchange",
      label: "orders",
      data: {
        id: "exchange:a:x1",
        hostId: "host:a",
        vhostId: "vhost:a:/",
        name: "orders",
        type: "topic",
        durable: true,
        alternateExchange: "orders.dlx",
        arguments: { "x-delayed-type": "topic" },
      },
    };
    render(<EntityDetailsPanel node={node} />);
    expect(screen.getByTestId("entity-details-kind").textContent).toBe("Exchange");
    expect(screen.getByTestId("entity-details-title").textContent).toBe("orders");
    const exchangeSection = screen.getByTestId("entity-details-section-exchange");
    expect(within(exchangeSection).getByText("Type").nextElementSibling?.textContent).toBe(
      "topic",
    );
    expect(within(exchangeSection).getByText("Alternate exchange").nextElementSibling?.textContent).toBe(
      "orders.dlx",
    );
    const argsSection = screen.getByTestId("entity-details-section-arguments");
    expect(within(argsSection).getByText("x-delayed-type").nextElementSibling?.textContent).toBe(
      "topic",
    );
  });

  it("splits shovel details into Shovel / Source / Destination sections", () => {
    const node: GraphNode = {
      id: "shovel:a:s1",
      kind: "shovel",
      label: "orders-forwarder",
      data: {
        id: "shovel:a:s1",
        hostId: "host:a",
        vhostId: "vhost:a:/",
        name: "orders-forwarder",
        source: { host: "rabbit-a", vhost: "/", exchange: "orders" },
        destination: { host: "rabbit-b", vhost: "/", queue: "orders.mirror" },
      },
    };
    render(<EntityDetailsPanel node={node} />);
    expect(screen.getByTestId("entity-details-section-shovel")).toBeTruthy();
    expect(screen.getByTestId("entity-details-section-source")).toBeTruthy();
    expect(screen.getByTestId("entity-details-section-destination")).toBeTruthy();
  });

  it("renders host details without an arguments section when the entity has no arguments", () => {
    const node: GraphNode = {
      id: "host:a",
      kind: "host",
      label: "rabbit-a",
      data: { id: "host:a", name: "rabbit-a", sourceFiles: ["sf:1"] },
    };
    render(<EntityDetailsPanel node={node} />);
    expect(screen.getByTestId("entity-details-kind").textContent).toBe("Host");
    expect(screen.queryByTestId("entity-details-section-arguments")).toBeNull();
  });
});
