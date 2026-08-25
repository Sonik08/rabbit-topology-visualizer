/**
 * RabbitMQ topic exchange routing-key matcher.
 *
 * Wildcards (per the AMQP topic-exchange spec):
 *   `*` — matches exactly one word (a run of characters between dots).
 *   `#` — matches zero or more words, including their leading/trailing dots.
 *
 * Words are the dot-separated segments of the routing key. An empty pattern
 * only matches an empty routing key; the pattern `#` matches any routing key
 * including the empty one. Leading, trailing, or consecutive dots produce
 * empty-string words that must be matched literally (or by `*`).
 *
 * Runs in `O(P × K)` time and space via memoized DP over
 * `(patternIndex, keyIndex)`, so pathological patterns like `#.#.#.#.…` on a
 * long routing key can never trigger combinatorial backtracking.
 */
export function matchTopicRoutingKey(pattern: string, routingKey: string): boolean {
  const p = pattern === "" ? [] : pattern.split(".");
  const k = routingKey === "" ? [] : routingKey.split(".");
  const stride = k.length + 1;
  const size = (p.length + 1) * stride;
  // 0 = unknown, 1 = true, 2 = false. Cheaper than a Map for the common small case.
  const memo = new Uint8Array(size);

  const match = (pi: number, ki: number): boolean => {
    const cacheKey = pi * stride + ki;
    const cached = memo[cacheKey];
    if (cached === 1) return true;
    if (cached === 2) return false;

    let result: boolean;
    if (pi === p.length) {
      result = ki === k.length;
    } else {
      const word = p[pi]!;
      if (word === "#") {
        // Either the `#` swallows nothing (advance pattern) or it swallows one
        // more word (advance key). This is the classic wildcard DP recursion.
        result = match(pi + 1, ki) || (ki < k.length && match(pi, ki + 1));
      } else if (ki >= k.length) {
        result = false;
      } else if (word === "*" || word === k[ki]) {
        result = match(pi + 1, ki + 1);
      } else {
        result = false;
      }
    }

    memo[cacheKey] = result ? 1 : 2;
    return result;
  };

  return match(0, 0);
}

/**
 * Returns true when the pattern contains any topic wildcard (`*` or `#` as its
 * own dot-separated word). Handy for callers that want to skip the recursive
 * matcher for exact-equality patterns.
 */
export function isTopicPattern(pattern: string): boolean {
  if (pattern.length === 0) return false;
  const words = pattern.split(".");
  return words.some((w) => w === "*" || w === "#");
}

