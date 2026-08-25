import { describe, expect, it } from "vitest";
import { parseRuntimeParameters } from "../../../src/core/parse/runtimeParameters";
import { hostId, vhostId } from "../../../src/core/model/ids";
import type { Vhost } from "../../../src/core/model/topology";

const HOST = hostId("rabbit-a");
const V_ORDERS: Vhost = { id: vhostId(HOST, "orders"), hostId: HOST, name: "orders" };
const V_ROOT: Vhost = { id: vhostId(HOST, "/"), hostId: HOST, name: "/" };
const USER_PLACEHOLDER = "USERNAME_PLACEHOLDER";
const PASSWORD_PLACEHOLDER = "PASSWORD_PLACEHOLDER";

describe("parseRuntimeParameters — shovels", () => {
  it("parses a shovel with URI + explicit exchange/queue fields, redacts credentials", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "shovel",
          name: "orders-shovel",
          value: {
            "src-uri": `amqp://${USER_PLACEHOLDER}:${PASSWORD_PLACEHOLDER}@remote.example.internal:5672/orders`,
            "src-exchange": "orders.out",
            "src-exchange-key": "orders.#",
            "dest-uri": `amqp://${USER_PLACEHOLDER}:${PASSWORD_PLACEHOLDER}@localhost:5672/orders`,
            "dest-exchange": "orders.in",
            nested: {
              uri: `amqp://${USER_PLACEHOLDER}:${PASSWORD_PLACEHOLDER}@nested.example.internal/orders`,
            },
            "ack-mode": "on-confirm",
            "reconnect-delay": 5,
          },
        },
      ],
    });

    expect(r.shovels).toHaveLength(1);
    const s = r.shovels[0]!;
    expect(s.name).toBe("orders-shovel");
    expect(s.source.host).toBe("remote.example.internal");
    expect(s.source.vhost).toBe("orders");
    expect(s.source.exchange).toBe("orders.out");
    expect(s.source.uri).toBe(
      "amqp://REDACTED@remote.example.internal:5672/orders",
    );
    expect(s.destination.exchange).toBe("orders.in");
    expect(s.ackMode).toBe("on-confirm");
    expect(s.reconnectDelay).toBe(5);

    const serialised = JSON.stringify(s);
    expect(serialised).not.toContain(USER_PLACEHOLDER);
    expect(serialised).not.toContain(PASSWORD_PLACEHOLDER);
    expect(serialised).toContain("amqp://REDACTED@nested.example.internal/orders");
  });

  it("emits a diagnostic and skips a shovel with no source or destination fields", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "shovel",
          name: "incomplete",
          value: { "src-uri": "amqp://REDACTED@remote.example.internal/orders" },
        },
      ],
    });
    expect(r.shovels).toHaveLength(0);
    expect(
      r.diagnostics.some((d) => d.code === "runtime-params.shovel-missing-endpoint"),
    ).toBe(true);
  });

  it("accepts underscore variants (src_uri, dest_uri, ack_mode)", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "shovel",
          name: "underscore",
          value: {
            src_uri: "amqp://REDACTED@remote.example.internal/orders",
            src_queue: "orders.out",
            dest_uri: "amqp://REDACTED@localhost/orders",
            dest_queue: "orders.in",
            ack_mode: "on-publish",
          },
        },
      ],
    });
    expect(r.shovels).toHaveLength(1);
    expect(r.shovels[0]!.ackMode).toBe("on-publish");
    expect(r.shovels[0]!.source.queue).toBe("orders.out");
  });
});

describe("parseRuntimeParameters — federation upstream", () => {
  it("builds an upstream endpoint from the URI and echoes local vhost as downstream", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "federation-upstream",
          name: "orders-upstream",
          value: {
            uri: `amqps://${USER_PLACEHOLDER}:${PASSWORD_PLACEHOLDER}@remote-b.example.internal:5671/orders`,
            expires: 3600000,
            "ack-mode": "on-confirm",
          },
        },
      ],
    });
    expect(r.federations).toHaveLength(1);
    const f = r.federations[0]!;
    expect(f.upstream.host).toBe("remote-b.example.internal");
    expect(f.upstream.vhost).toBe("orders");
    expect(f.upstream.uri).toBe(
      "amqps://REDACTED@remote-b.example.internal:5671/orders",
    );
    expect(f.downstream.vhost).toBe("orders");
    const serialised = JSON.stringify(f);
    expect(serialised).not.toContain(USER_PLACEHOLDER);
    expect(serialised).not.toContain(PASSWORD_PLACEHOLDER);
  });

  it("accepts a uri array and uses the first entry", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "federation-upstream",
          name: "multi",
          value: {
            uri: [
              "amqp://REDACTED@primary.example.internal/orders",
              "amqp://REDACTED@backup.example.internal/orders",
            ],
          },
        },
      ],
    });
    expect(r.federations[0]!.upstream.host).toBe("primary.example.internal");
  });

  it("emits a diagnostic when uri is missing", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "federation-upstream",
          name: "no-uri",
          value: { expires: 60000 },
        },
      ],
    });
    expect(r.federations).toEqual([]);
    expect(
      r.diagnostics.some((d) => d.code === "runtime-params.federation-missing-uri"),
    ).toBe(true);
  });
});

describe("parseRuntimeParameters — federation upstream sets", () => {
  it("parses a plain array of upstream names", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "federation-upstream-set",
          name: "all",
          value: ["upstream-a", "upstream-b"],
        },
      ],
    });
    expect(r.federationUpstreamSets).toHaveLength(1);
    expect(r.federationUpstreamSets[0]!.upstreams).toEqual([
      "upstream-a",
      "upstream-b",
    ]);
  });

  it("parses an array of {upstream: ...} entries", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "federation-upstream-set",
          name: "picky",
          value: [
            { upstream: "upstream-a" },
            { upstream: "upstream-b" },
          ],
        },
      ],
    });
    expect(r.federationUpstreamSets[0]!.upstreams).toEqual([
      "upstream-a",
      "upstream-b",
    ]);
  });
});

describe("parseRuntimeParameters — misc", () => {
  it("emits an info diagnostic and ignores unknown component types", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ROOT],
      parameters: [
        {
          hostId: HOST,
          vhost: "/",
          component: "vhost-limits",
          name: "custom-thing",
          value: {},
        },
      ],
    });
    expect(r.shovels).toEqual([]);
    expect(
      r.diagnostics.some((d) => d.code === "runtime-params.unknown-component"),
    ).toBe(true);
  });

  it("warns when a parameter references an unknown vhost", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ROOT],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "shovel",
          name: "sx",
          value: {
            "src-uri": "amqp://REDACTED@remote/orders",
            "src-queue": "q",
            "dest-uri": "amqp://REDACTED@local/orders",
            "dest-queue": "q",
          },
        },
      ],
    });
    expect(r.shovels).toEqual([]);
    expect(
      r.diagnostics.some((d) => d.code === "runtime-params.vhost-unresolved"),
    ).toBe(true);
  });

  it("detects duplicate shovel names within a single vhost", () => {
    const p = {
      hostId: HOST,
      vhost: "orders",
      component: "shovel",
      name: "dup",
      value: {
        "src-uri": "amqp://REDACTED@remote/orders",
        "src-queue": "q",
        "dest-uri": "amqp://REDACTED@local/orders",
        "dest-queue": "q",
      },
    };
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [p, p],
    });
    expect(r.shovels).toHaveLength(1);
    expect(
      r.diagnostics.some((d) => d.code === "runtime-params.shovel-duplicate"),
    ).toBe(true);
  });
});
