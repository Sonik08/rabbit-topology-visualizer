import { describe, expect, it } from "vitest";
import { parseAmqpUri, redactAmqpUri } from "../../../src/core/parse/amqpUri";

const USER_PLACEHOLDER = "USERNAME_PLACEHOLDER";
const PASSWORD_PLACEHOLDER = "PASSWORD_PLACEHOLDER";

function credentialUri(hostAndPath: string): string {
  return `amqp://${USER_PLACEHOLDER}:${PASSWORD_PLACEHOLDER}@${hostAndPath}`;
}

describe("parseAmqpUri — happy path", () => {
  it("parses user info, host, port, and vhost without exposing credential fields", () => {
    const r = parseAmqpUri(credentialUri("rabbit.example.internal:5672/orders"));
    expect(r.valid).toBe(true);
    expect(r.scheme).toBe("amqp");
    expect(r.host).toBe("rabbit.example.internal");
    expect(r.port).toBe(5672);
    expect(r.vhost).toBe("orders");
    expect(r.hasCredentials).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(r, "raw")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(r, "userName")).toBe(false);
    expect(JSON.stringify(r)).not.toContain(USER_PLACEHOLDER);
    expect(JSON.stringify(r)).not.toContain(PASSWORD_PLACEHOLDER);
  });

  it("defaults port from scheme when unspecified", () => {
    expect(parseAmqpUri("amqp://rabbit.example.internal").port).toBe(5672);
    expect(parseAmqpUri("amqps://rabbit.example.internal").port).toBe(5671);
  });

  it("decodes percent-encoded vhost (%2F → '/')", () => {
    const r = parseAmqpUri("amqp://rabbit.example.internal/%2F");
    expect(r.vhost).toBe("/");
  });

  it("treats a trailing slash with no vhost as default '/'", () => {
    const r = parseAmqpUri("amqp://rabbit.example.internal/");
    expect(r.vhost).toBe("/");
  });

  it("parses bracketed IPv6 host", () => {
    const r = parseAmqpUri("amqp://REDACTED@[fe80::1]:5672/orders");
    expect(r.host).toBe("fe80::1");
    expect(r.port).toBe(5672);
    expect(r.vhost).toBe("orders");
  });

  it("separates query strings and fragments from host and vhost", () => {
    const withVhost = parseAmqpUri(
      "amqp://rabbit.example.internal/orders?heartbeat=30#consumer",
    );
    expect(withVhost.host).toBe("rabbit.example.internal");
    expect(withVhost.vhost).toBe("orders");

    const hostOnly = parseAmqpUri("amqp://rabbit.example.internal?heartbeat=30");
    expect(hostOnly.host).toBe("rabbit.example.internal");
    expect(hostOnly.vhost).toBeUndefined();
  });
});

describe("parseAmqpUri — edge cases", () => {
  it("returns valid=false for a non-amqp scheme", () => {
    expect(parseAmqpUri("https://example.com").valid).toBe(false);
  });

  it("returns valid=false for empty input", () => {
    expect(parseAmqpUri("").valid).toBe(false);
  });

  it("returns hasCredentials=false when there is no user info", () => {
    const r = parseAmqpUri("amqp://rabbit.example.internal:5672/orders");
    expect(r.hasCredentials).toBe(false);
  });

  it("handles empty user info (just '@' before host)", () => {
    const r = parseAmqpUri("amqp://@rabbit.example.internal");
    expect(r.hasCredentials).toBe(false);
    expect(r.host).toBe("rabbit.example.internal");
  });
});

describe("redactAmqpUri", () => {
  it("replaces user info with REDACTED and keeps everything else", () => {
    expect(
      redactAmqpUri(credentialUri("rabbit.example.internal:5672/orders")),
    ).toBe("amqp://REDACTED@rabbit.example.internal:5672/orders");
  });

  it("preserves query strings and fragments while redacting", () => {
    expect(
      redactAmqpUri(
        credentialUri("rabbit.example.internal:5672/orders?heartbeat=30#consumer"),
      ),
    ).toBe("amqp://REDACTED@rabbit.example.internal:5672/orders?heartbeat=30#consumer");
  });

  it("is a no-op when there is no user info", () => {
    const uri = "amqp://rabbit.example.internal:5672/orders";
    expect(redactAmqpUri(uri)).toBe(uri);
  });

  it("is a no-op for non-amqp schemes", () => {
    expect(redactAmqpUri("https://user:***@example.com")).toBe(
      "https://user:***@example.com",
    );
  });

  it("redacts even when password contains '@' (uses URL authority parsing)", () => {
    expect(
      redactAmqpUri(`amqp://${USER_PLACEHOLDER}:opaque@token@rabbit.example.internal/orders`),
    ).toBe("amqp://REDACTED@rabbit.example.internal/orders");
  });

  it("parseAmqpUri.redacted matches redactAmqpUri output", () => {
    const uri = `amqps://${USER_PLACEHOLDER}:${PASSWORD_PLACEHOLDER}@rabbit.example.internal:5671/analytics`;
    const r = parseAmqpUri(uri);
    expect(r.redacted).toBe(redactAmqpUri(uri));
    expect(JSON.stringify(r)).not.toContain(USER_PLACEHOLDER);
    expect(JSON.stringify(r)).not.toContain(PASSWORD_PLACEHOLDER);
  });
});
