import { describe, expect, it } from "vitest";
import {
  isTopicPattern,
  matchTopicRoutingKey,
} from "../../../src/core/graph/topicMatcher";

describe("matchTopicRoutingKey — exact / no wildcards", () => {
  it("matches identical routing keys", () => {
    expect(matchTopicRoutingKey("orders.new", "orders.new")).toBe(true);
  });

  it("rejects different routing keys", () => {
    expect(matchTopicRoutingKey("orders.new", "orders.paid")).toBe(false);
    expect(matchTopicRoutingKey("orders", "orders.new")).toBe(false);
    expect(matchTopicRoutingKey("orders.new", "orders")).toBe(false);
  });

  it("matches empty pattern only against empty routing key", () => {
    expect(matchTopicRoutingKey("", "")).toBe(true);
    expect(matchTopicRoutingKey("", "anything")).toBe(false);
    expect(matchTopicRoutingKey("anything", "")).toBe(false);
  });
});

describe("matchTopicRoutingKey — '*' single-word wildcard", () => {
  it("matches exactly one word", () => {
    expect(matchTopicRoutingKey("orders.*", "orders.new")).toBe(true);
    expect(matchTopicRoutingKey("orders.*", "orders.paid")).toBe(true);
  });

  it("does not match zero words", () => {
    expect(matchTopicRoutingKey("orders.*", "orders")).toBe(false);
  });

  it("does not match two words", () => {
    expect(matchTopicRoutingKey("orders.*", "orders.new.eu")).toBe(false);
  });

  it("supports multiple '*' in a pattern", () => {
    expect(matchTopicRoutingKey("*.*.eu", "orders.new.eu")).toBe(true);
    expect(matchTopicRoutingKey("*.*.eu", "orders.eu")).toBe(false);
  });
});

describe("matchTopicRoutingKey — '#' zero-or-more-words wildcard", () => {
  it("'#' alone matches every routing key, including empty", () => {
    expect(matchTopicRoutingKey("#", "")).toBe(true);
    expect(matchTopicRoutingKey("#", "orders")).toBe(true);
    expect(matchTopicRoutingKey("#", "orders.new.eu.priority")).toBe(true);
  });

  it("trailing '#' absorbs zero or more suffix words", () => {
    expect(matchTopicRoutingKey("orders.#", "orders")).toBe(true);
    expect(matchTopicRoutingKey("orders.#", "orders.new")).toBe(true);
    expect(matchTopicRoutingKey("orders.#", "orders.new.eu")).toBe(true);
    expect(matchTopicRoutingKey("orders.#", "invoices.new")).toBe(false);
  });

  it("leading '#' absorbs zero or more prefix words", () => {
    expect(matchTopicRoutingKey("#.eu", "eu")).toBe(true);
    expect(matchTopicRoutingKey("#.eu", "orders.eu")).toBe(true);
    expect(matchTopicRoutingKey("#.eu", "orders.new.eu")).toBe(true);
    expect(matchTopicRoutingKey("#.eu", "orders.us")).toBe(false);
  });

  it("'#' between literals absorbs zero or more middle words", () => {
    expect(matchTopicRoutingKey("orders.#.eu", "orders.eu")).toBe(true);
    expect(matchTopicRoutingKey("orders.#.eu", "orders.new.eu")).toBe(true);
    expect(matchTopicRoutingKey("orders.#.eu", "orders.new.priority.eu")).toBe(true);
    expect(matchTopicRoutingKey("orders.#.eu", "orders.new")).toBe(false);
    expect(matchTopicRoutingKey("orders.#.eu", "invoices.new.eu")).toBe(false);
  });

  it("multiple '#' segments still match correctly", () => {
    expect(matchTopicRoutingKey("#.orders.#", "orders")).toBe(true);
    expect(matchTopicRoutingKey("#.orders.#", "eu.orders.new")).toBe(true);
    expect(matchTopicRoutingKey("#.orders.#", "eu.orders")).toBe(true);
    expect(matchTopicRoutingKey("#.orders.#", "invoices.new")).toBe(false);
  });
});

describe("matchTopicRoutingKey — '*' and '#' combined", () => {
  it("mixes single-word and multi-word wildcards", () => {
    expect(matchTopicRoutingKey("orders.*.#", "orders.new")).toBe(true);
    expect(matchTopicRoutingKey("orders.*.#", "orders.new.eu")).toBe(true);
    expect(matchTopicRoutingKey("orders.*.#", "orders")).toBe(false);
  });
});

describe("matchTopicRoutingKey — adversarial repeated-'#' patterns", () => {
  // Under the old exponential backtracker, N=10 hashes against a 10-word key
  // would explore ~2^10 states; N=15 would visibly stall. Under the memoized
  // DP each `(pi, ki)` pair is evaluated at most once — O(P·K) time and space.
  // We assert both correctness AND that the calls return well under a second
  // even for large N so any accidental exponential regression trips the timer.

  const timedMatch = (
    pattern: string,
    key: string,
  ): { result: boolean; ms: number } => {
    const start = performance.now();
    const result = matchTopicRoutingKey(pattern, key);
    return { result, ms: performance.now() - start };
  };

  it("many '#' segments matching a long key stays fast", () => {
    const key = Array.from({ length: 20 }, (_, i) => `w${i}`).join(".");
    const pattern = Array(15).fill("#").join(".");
    const { result, ms } = timedMatch(pattern, key);
    expect(result).toBe(true);
    expect(ms).toBeLessThan(50);
  });

  it("many '#' segments with a non-matching literal tail stays fast", () => {
    const key = Array.from({ length: 20 }, (_, i) => `w${i}`).join(".");
    const pattern = `${Array(15).fill("#").join(".")}.zzz-not-there`;
    const { result, ms } = timedMatch(pattern, key);
    expect(result).toBe(false);
    expect(ms).toBeLessThan(50);
  });

  it("interleaved '#' and literal words on a long key stays fast", () => {
    const key = Array.from({ length: 30 }, (_, i) => `w${i}`).join(".");
    const pattern = "#.w5.#.w15.#.w25.#";
    const { result, ms } = timedMatch(pattern, key);
    expect(result).toBe(true);
    expect(ms).toBeLessThan(50);
  });
});

describe("matchTopicRoutingKey — empty words (leading/trailing/consecutive dots)", () => {
  it("leading dot creates an empty leading word that must be matched", () => {
    expect(matchTopicRoutingKey(".foo", ".foo")).toBe(true);
    expect(matchTopicRoutingKey(".foo", "foo")).toBe(false);
    expect(matchTopicRoutingKey("foo", ".foo")).toBe(false);
  });

  it("trailing dot creates an empty trailing word that must be matched", () => {
    expect(matchTopicRoutingKey("foo.", "foo.")).toBe(true);
    expect(matchTopicRoutingKey("foo.", "foo")).toBe(false);
    expect(matchTopicRoutingKey("foo", "foo.")).toBe(false);
  });

  it("consecutive dots create empty middle words that must be matched", () => {
    expect(matchTopicRoutingKey("foo..bar", "foo..bar")).toBe(true);
    expect(matchTopicRoutingKey("foo..bar", "foo.bar")).toBe(false);
  });

  it("'*' matches an empty word segment", () => {
    expect(matchTopicRoutingKey(".*.", ".foo.")).toBe(true);
    expect(matchTopicRoutingKey(".*.", "..")).toBe(true);
  });

  it("'#' matches empty word segments as if they were words", () => {
    expect(matchTopicRoutingKey("#", "..")).toBe(true);
    expect(matchTopicRoutingKey("foo.#", "foo.")).toBe(true);
  });
});

describe("isTopicPattern", () => {
  it("returns true when the pattern contains a wildcard word", () => {
    expect(isTopicPattern("orders.*")).toBe(true);
    expect(isTopicPattern("#")).toBe(true);
    expect(isTopicPattern("orders.#.eu")).toBe(true);
  });

  it("returns false for a fully literal pattern", () => {
    expect(isTopicPattern("orders.new")).toBe(false);
    expect(isTopicPattern("")).toBe(false);
  });

  it("does not treat '#' or '*' inside a word as a wildcard", () => {
    expect(isTopicPattern("orders.new#")).toBe(false);
    expect(isTopicPattern("orders.*extra")).toBe(false);
  });
});
