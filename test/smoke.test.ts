import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "fixtures", "minimal-definitions.json");

describe("Vitest smoke", () => {
  it("runs a trivial assertion", () => {
    expect(1 + 1).toBe(2);
  });

  it("can load the sanitized minimal definitions fixture", () => {
    const raw = readFileSync(fixturePath, "utf-8");
    const parsed = JSON.parse(raw) as {
      vhosts: Array<{ name: string }>;
      exchanges: unknown[];
      queues: unknown[];
      bindings: unknown[];
      parameters: unknown[];
    };

    expect(parsed.vhosts.map((v) => v.name)).toEqual(
      expect.arrayContaining(["/", "orders"]),
    );
    expect(parsed.exchanges.length).toBeGreaterThan(0);
    expect(parsed.queues.length).toBeGreaterThan(0);
    expect(parsed.bindings.length).toBeGreaterThan(0);
    expect(parsed.parameters.length).toBeGreaterThan(0);
  });

  it("fixture never contains raw credentials", () => {
    const raw = readFileSync(fixturePath, "utf-8");
    expect(raw).not.toMatch(/amqp:\/\/[^@:\s"]+:[^@\s"]+@/);
    expect(raw).toContain("REDACTED");
  });
});
