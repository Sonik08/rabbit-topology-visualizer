import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isTopicPattern,
  matchTopicRoutingKey,
} from "../../../src/core/graph/topicMatcher";
import { parseDefinitionsExport } from "../../../src/core/parse/definitionsParser";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", "..", "fixtures", "minimal-definitions.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

/**
 * Integration coverage that pairs the topic-routing matcher with the real
 * binding routing keys the fixture exercises. Ensures that every pattern
 * shipped in test/fixtures/minimal-definitions.json behaves the way an AMQP
 * broker would route messages through it — so a regression in the matcher's
 * word-tokenisation or wildcard handling would fail here even without an
 * exhaustive hand-crafted routing-key list.
 */

describe("matchTopicRoutingKey — fixture-driven routing keys", () => {
  const parsed = parseDefinitionsExport({ json: fixture, hostName: "example-host" });
  const bindingKeys = parsed.bindings
    .map((b) => b.routingKey)
    .filter((k): k is string => typeof k === "string");

  it("every binding routing key from the fixture is a well-formed matcher input", () => {
    expect(bindingKeys.length).toBeGreaterThan(0);
    // Every pattern must be splittable and produce a boolean without throwing.
    for (const pattern of bindingKeys) {
      expect(() => matchTopicRoutingKey(pattern, pattern)).not.toThrow();
    }
  });

  it("'orders.#' (fixture) matches every orders.* routing key including exact 'orders'", () => {
    expect(matchTopicRoutingKey("orders.#", "orders")).toBe(true);
    expect(matchTopicRoutingKey("orders.#", "orders.new")).toBe(true);
    expect(matchTopicRoutingKey("orders.#", "orders.new.eu")).toBe(true);
    expect(matchTopicRoutingKey("orders.#", "orders.new.eu.priority")).toBe(true);
    // Must not swallow the top-level namespace
    expect(matchTopicRoutingKey("orders.#", "shipments.new")).toBe(false);
    expect(matchTopicRoutingKey("orders.#", "")).toBe(false);
  });

  it("'orders.*' (fixture) matches exactly one word after 'orders'", () => {
    expect(matchTopicRoutingKey("orders.*", "orders.new")).toBe(true);
    expect(matchTopicRoutingKey("orders.*", "orders.audit")).toBe(true);
    expect(matchTopicRoutingKey("orders.*", "orders")).toBe(false);
    expect(matchTopicRoutingKey("orders.*", "orders.new.eu")).toBe(false);
  });

  it("empty-string routing key (fixture uses '' for fanout bindings) only matches an empty pattern", () => {
    expect(matchTopicRoutingKey("", "")).toBe(true);
    expect(matchTopicRoutingKey("", "orders.new")).toBe(false);
    expect(matchTopicRoutingKey("orders.new", "")).toBe(false);
  });

  it("literal fixture pattern 'jobs' matches only the exact 'jobs' routing key", () => {
    expect(matchTopicRoutingKey("jobs", "jobs")).toBe(true);
    expect(matchTopicRoutingKey("jobs", "jobs.high")).toBe(false);
    expect(matchTopicRoutingKey("jobs", "priority.jobs")).toBe(false);
  });

  it("isTopicPattern correctly identifies each fixture pattern", () => {
    // Fixture patterns: 'jobs', '', 'orders.#', 'orders.*', ''
    expect(isTopicPattern("jobs")).toBe(false);
    expect(isTopicPattern("")).toBe(false);
    expect(isTopicPattern("orders.#")).toBe(true);
    expect(isTopicPattern("orders.*")).toBe(true);
  });
});

describe("matchTopicRoutingKey — semantic properties on every fixture pattern", () => {
  const parsed = parseDefinitionsExport({ json: fixture, hostName: "example-host" });
  const bindingKeys = Array.from(
    new Set(
      parsed.bindings
        .map((b) => b.routingKey)
        .filter((k): k is string => typeof k === "string"),
    ),
  );

  it("every non-wildcard pattern matches itself and rejects any single-word suffix", () => {
    for (const pattern of bindingKeys.filter((k) => !isTopicPattern(k))) {
      expect(matchTopicRoutingKey(pattern, pattern)).toBe(true);
      // Appending an extra word must break the match for a literal pattern
      expect(matchTopicRoutingKey(pattern, `${pattern}.extra`)).toBe(false);
    }
  });

  it("every wildcard fixture pattern matches at least one plausible message routing key", () => {
    // A concrete routing key that would fan out through the fixture's
    // orders.* / orders.# bindings when a message is published.
    const plausibleKey = "orders.new";
    for (const pattern of bindingKeys.filter((k) => isTopicPattern(k))) {
      expect(
        matchTopicRoutingKey(pattern, plausibleKey),
        `pattern '${pattern}' should route 'orders.new'`,
      ).toBe(true);
    }
  });
});
