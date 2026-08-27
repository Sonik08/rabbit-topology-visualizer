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

  it("accepts array-valued src-uri / dest-uri (RabbitMQ HA form) and uses the first entry for the primary endpoint", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "shovel",
          name: "ha-shovel",
          value: {
            "src-uri": [
              `amqp://${USER_PLACEHOLDER}:${PASSWORD_PLACEHOLDER}@primary.example.internal:5672/orders`,
              `amqp://${USER_PLACEHOLDER}:${PASSWORD_PLACEHOLDER}@backup.example.internal:5672/orders`,
            ],
            "src-queue": "orders.out",
            "dest-uri": [
              `amqp://${USER_PLACEHOLDER}:${PASSWORD_PLACEHOLDER}@dest-a.example.internal:5672/orders`,
            ],
            "dest-queue": "orders.in",
          },
        },
      ],
    });
    expect(r.shovels).toHaveLength(1);
    const s = r.shovels[0]!;
    // Primary endpoint host/vhost derived from the FIRST URI in each list.
    expect(s.source.host).toBe("primary.example.internal");
    expect(s.source.vhost).toBe("orders");
    expect(s.destination.host).toBe("dest-a.example.internal");
    expect(s.source.uri).toBe(
      "amqp://REDACTED@primary.example.internal:5672/orders",
    );
    // Alternate URIs preserved (redacted) in arguments so the HA list is not
    // silently lost; credentials never leak.
    const args = s.arguments as Record<string, unknown>;
    const srcArgs = args["src-uri"];
    expect(Array.isArray(srcArgs)).toBe(true);
    expect(srcArgs).toEqual([
      "amqp://REDACTED@primary.example.internal:5672/orders",
      "amqp://REDACTED@backup.example.internal:5672/orders",
    ]);
    const serialised = JSON.stringify(s);
    expect(serialised).not.toContain(USER_PLACEHOLDER);
    expect(serialised).not.toContain(PASSWORD_PLACEHOLDER);
    // No warning diagnostics for the clean HA form.
    expect(
      r.diagnostics.some((d) => d.code === "runtime-params.shovel-uri-empty-list"),
    ).toBe(false);
    expect(
      r.diagnostics.some((d) => d.code === "runtime-params.shovel-uri-invalid-list"),
    ).toBe(false);
  });

  it("emits a diagnostic for an empty src-uri array; source endpoint has no URI-derived host/vhost", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "shovel",
          name: "empty-src",
          value: {
            "src-uri": [],
            "src-queue": "q",
            "dest-uri": "amqp://REDACTED@local/orders",
            "dest-queue": "q",
          },
        },
      ],
    });
    expect(
      r.diagnostics.some((d) => d.code === "runtime-params.shovel-uri-empty-list"),
    ).toBe(true);
    // Shovel is still materialised because a queue name alone is enough to
    // build an endpoint reference, but no URI-derived host/vhost is attached.
    expect(r.shovels).toHaveLength(1);
    expect(r.shovels[0]!.source.uri).toBeUndefined();
    expect(r.shovels[0]!.source.host).toBeUndefined();
    expect(r.shovels[0]!.source.queue).toBe("q");
  });

  it("emits a diagnostic when the src-uri array has no usable string entries", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "shovel",
          name: "all-invalid",
          value: {
            "src-uri": [null, 42, { nested: "amqp://REDACTED@x/y" }],
            "src-queue": "q",
            "dest-uri": "amqp://REDACTED@local/orders",
            "dest-queue": "q",
          },
        },
      ],
    });
    expect(
      r.diagnostics.some(
        (d) => d.code === "runtime-params.shovel-uri-invalid-list",
      ),
    ).toBe(true);
    expect(r.shovels[0]!.source.uri).toBeUndefined();
  });

  it("treats a whitespace-only scalar src-uri as no URI and does NOT silently pass it to the URI parser", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "shovel",
          name: "ws-scalar",
          value: {
            "src-uri": "   \t\n  ",
            "src-queue": "q",
            "dest-uri": "amqp://REDACTED@local/orders",
            "dest-queue": "q",
          },
        },
      ],
    });
    expect(r.shovels).toHaveLength(1);
    expect(r.shovels[0]!.source.uri).toBeUndefined();
    // No spurious mixed/invalid diagnostic — the whitespace-only scalar is
    // handled identically to `undefined` on the src side.
    expect(
      r.diagnostics.some(
        (d) =>
          d.code === "runtime-params.shovel-uri-empty-list" ||
          d.code === "runtime-params.shovel-uri-invalid-list" ||
          d.code === "runtime-params.shovel-uri-mixed-list",
      ),
    ).toBe(false);
  });

  it("treats whitespace-only array entries as skipped and reports them in the mixed-list diagnostic message", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "shovel",
          name: "ws-array",
          value: {
            "src-uri": "amqp://REDACTED@remote.example.internal/orders",
            "src-queue": "q",
            "dest-uri": [
              "   ",
              "\t\n",
              "amqp://REDACTED@dest-c.example.internal:5672/orders",
              "",
            ],
            "dest-queue": "q",
          },
        },
      ],
    });
    expect(r.shovels).toHaveLength(1);
    expect(r.shovels[0]!.destination.host).toBe("dest-c.example.internal");
    const mixed = r.diagnostics.find(
      (d) => d.code === "runtime-params.shovel-uri-mixed-list",
    );
    expect(mixed).toBeDefined();
    // Message reports the skipped count and clarifies that "unusable" covers
    // BOTH non-string entries AND empty/whitespace strings.
    expect(mixed!.message).toContain("3");
    expect(mixed!.message).toMatch(/empty|whitespace/i);
  });

  it("treats an all-whitespace src-uri array as invalid (same as no usable string entries)", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "shovel",
          name: "all-ws",
          value: {
            "src-uri": ["   ", "\t", "", "\n\r"],
            "src-queue": "q",
            "dest-uri": "amqp://REDACTED@local/orders",
            "dest-queue": "q",
          },
        },
      ],
    });
    expect(
      r.diagnostics.some(
        (d) => d.code === "runtime-params.shovel-uri-invalid-list",
      ),
    ).toBe(true);
    expect(r.shovels[0]!.source.uri).toBeUndefined();
  });

  it("emits an info diagnostic when the dest-uri array is mixed (some non-string entries) but still keeps the first valid entry", () => {
    const r = parseRuntimeParameters({
      hostId: HOST,
      vhosts: [V_ORDERS],
      parameters: [
        {
          hostId: HOST,
          vhost: "orders",
          component: "shovel",
          name: "mixed-dest",
          value: {
            "src-uri": "amqp://REDACTED@remote.example.internal/orders",
            "src-queue": "q",
            "dest-uri": [
              null,
              "amqp://REDACTED@dest-b.example.internal:5672/orders",
              42,
            ],
            "dest-queue": "q",
          },
        },
      ],
    });
    expect(r.shovels).toHaveLength(1);
    expect(r.shovels[0]!.destination.host).toBe("dest-b.example.internal");
    expect(
      r.diagnostics.some(
        (d) => d.code === "runtime-params.shovel-uri-mixed-list",
      ),
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
