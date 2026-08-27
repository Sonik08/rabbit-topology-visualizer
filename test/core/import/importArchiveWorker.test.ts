import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  handleImportArchiveMessage,
  type WorkerRequest,
  type WorkerResponse,
} from "../../../src/core/import/importArchiveWorkerMessage";
import {
  createImportArchiveWorkerClient,
  createMainThreadClient,
  getSharedTopologyWorkerClient,
  importOnMainThread,
  resetSharedTopologyWorkerClient,
  type ImportArchiveWorkerLike,
} from "../../../src/core/import/importArchiveWorkerClient";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", "..", "fixtures", "minimal-definitions.json");
const fixtureBytes = readFileSync(fixturePath);

interface ShimWorker extends ImportArchiveWorkerLike {
  terminated: boolean;
  posted: WorkerRequest[];
  /** Manually inject a message-event response (used by the stale-response test). */
  fireMessage(response: WorkerResponse): void;
  /** Manually inject a worker-level error event. */
  fireError(message?: string): void;
  /** Manually inject a worker messageerror event. */
  fireMessageError(): void;
  /** When set, subsequent postMessage calls throw the provided error synchronously. */
  postThrows?: Error;
}

function createShimWorker(
  respond: (request: WorkerRequest) => Promise<WorkerResponse> | WorkerResponse,
): ShimWorker {
  const messageListeners = new Set<(event: { data: WorkerResponse }) => void>();
  const errorListeners = new Set<(event: { message?: string }) => void>();
  const messageErrorListeners = new Set<(event: { message?: string }) => void>();
  const posted: WorkerRequest[] = [];
  const shim: ShimWorker = {
    terminated: false,
    posted,
    postMessage(message) {
      if (shim.postThrows) throw shim.postThrows;
      posted.push(message);
      Promise.resolve(respond(message)).then((response) => {
        for (const listener of messageListeners) listener({ data: response });
      });
    },
    addEventListener(type: string, listener: (event: never) => void): void {
      if (type === "message") messageListeners.add(listener as (e: { data: WorkerResponse }) => void);
      else if (type === "error") errorListeners.add(listener as (e: { message?: string }) => void);
      else if (type === "messageerror")
        messageErrorListeners.add(listener as (e: { message?: string }) => void);
    },
    removeEventListener(type: string, listener: (event: never) => void): void {
      if (type === "message")
        messageListeners.delete(listener as (e: { data: WorkerResponse }) => void);
      else if (type === "error")
        errorListeners.delete(listener as (e: { message?: string }) => void);
      else if (type === "messageerror")
        messageErrorListeners.delete(listener as (e: { message?: string }) => void);
    },
    terminate() {
      shim.terminated = true;
    },
    fireMessage(response) {
      for (const listener of messageListeners) listener({ data: response });
    },
    fireError(message) {
      for (const listener of errorListeners) listener({ message });
    },
    fireMessageError() {
      for (const listener of messageErrorListeners) listener({});
    },
  };
  return shim;
}

describe("handleImportArchiveMessage — pure dispatcher", () => {
  it("processes a well-formed import request and echoes the id + kind", async () => {
    const bytes = new Uint8Array(fixtureBytes);
    const response = await handleImportArchiveMessage({
      id: 42,
      kind: "import",
      input: { fileName: "minimal-definitions.json", bytes },
    });
    expect(response.id).toBe(42);
    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("expected ok");
    expect(response.kind).toBe("import");
    if (response.kind !== "import") throw new Error("expected import");
    expect(response.result.archiveKind).toBe("json");
    expect(response.result.files.length).toBeGreaterThan(0);
  });

  it("dispatches a build-graph request to the graph builder", async () => {
    const response = await handleImportArchiveMessage({
      id: 5,
      kind: "build-graph",
      input: {
        hosts: [{ id: "host:a", name: "a", sourceFiles: [] }],
        vhosts: [{ id: "vhost:a:/", hostId: "host:a", name: "/" }],
        exchanges: [],
        queues: [],
        bindings: [],
        shovels: [],
        federations: [],
      },
    });
    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("expected ok");
    expect(response.kind).toBe("build-graph");
    if (response.kind !== "build-graph") throw new Error("expected build-graph");
    expect(response.result.nodes.length).toBe(2);
  });

  it("dispatches an upstream-for-queue request to the traversal engine", async () => {
    // Build a tiny graph first, then hand it back through the worker path.
    const graph = (
      await handleImportArchiveMessage({
        id: 1,
        kind: "build-graph",
        input: {
          hosts: [{ id: "host:a", name: "a", sourceFiles: [] }],
          vhosts: [{ id: "vhost:a:/", hostId: "host:a", name: "/" }],
          exchanges: [
            { id: "exchange:a:x", hostId: "host:a", vhostId: "vhost:a:/", name: "x", type: "topic" },
          ],
          queues: [{ id: "queue:a:q", hostId: "host:a", vhostId: "vhost:a:/", name: "q" }],
          bindings: [
            {
              id: "b:x->q",
              hostId: "host:a",
              vhostId: "vhost:a:/",
              sourceExchangeId: "exchange:a:x",
              destinationId: "queue:a:q",
              destinationType: "queue",
              routingKey: "",
            },
          ],
          shovels: [],
          federations: [],
        },
      })
    ) as WorkerResponse & { status: "ok"; kind: "build-graph" };
    expect(graph.status).toBe("ok");
    const response = await handleImportArchiveMessage({
      id: 2,
      kind: "upstream-for-queue",
      input: { nodes: graph.result.nodes, edges: graph.result.edges },
      targetQueueId: "queue:a:q",
    });
    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("expected ok");
    if (response.kind !== "upstream-for-queue") throw new Error("expected traversal");
    expect(response.result.reachableAncestorIds).toContain("exchange:a:x");
  });

  it("catches null/undefined payloads inside try/catch (worker stays alive)", async () => {
    const nullResponse = await handleImportArchiveMessage(null);
    expect(nullResponse.status).toBe("error");
    if (nullResponse.status !== "error") throw new Error("expected error");
    expect(nullResponse.id).toBe(-1);
    expect(nullResponse.message).toMatch(/must be an object/i);
    const undefinedResponse = await handleImportArchiveMessage(undefined);
    expect(undefinedResponse.status).toBe("error");
  });

  it("catches non-object payloads (string, number) and reports the shape", async () => {
    const stringResponse = await handleImportArchiveMessage("hello");
    expect(stringResponse.status).toBe("error");
    if (stringResponse.status !== "error") throw new Error("expected error");
    expect(stringResponse.message).toMatch(/must be an object/i);
    const numResponse = await handleImportArchiveMessage(42);
    expect(numResponse.status).toBe("error");
  });

  it("rejects an unknown request kind and preserves the request id", async () => {
    const response = await handleImportArchiveMessage({
      id: 7,
      kind: "not-a-real-kind",
      input: {},
    });
    expect(response.id).toBe(7);
    expect(response.status).toBe("error");
    if (response.status !== "error") throw new Error("expected error");
    expect(response.message).toMatch(/unknown request kind/i);
  });

  it("reports a structured error when a request kind is missing 'input'", async () => {
    const response = await handleImportArchiveMessage({ id: 3, kind: "build-graph" });
    expect(response.status).toBe("error");
    if (response.status !== "error") throw new Error("expected error");
    expect(response.message).toMatch(/build-graph.*missing/i);
  });
});

describe("createImportArchiveWorkerClient — Promise wrapper", () => {
  it("round-trips a request through the shim worker and resolves with the result", async () => {
    const shim = createShimWorker((req) => handleImportArchiveMessage(req));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    const result = await client.importArchive({
      fileName: "minimal-definitions.json",
      bytes: new Uint8Array(fixtureBytes),
    });
    expect(result.archiveKind).toBe("json");
    expect(shim.posted).toHaveLength(1);
    expect(shim.posted[0]!.id).toBe(1);
    client.terminate();
  });

  it("assigns a fresh monotonic id per request so concurrent operations never collide", async () => {
    const shim = createShimWorker((req) => handleImportArchiveMessage(req));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    const [a, b, c] = await Promise.all([
      client.importArchive({ fileName: "a.json", bytes: new Uint8Array(fixtureBytes) }),
      client.importArchive({ fileName: "b.json", bytes: new Uint8Array(fixtureBytes) }),
      client.importArchive({ fileName: "c.json", bytes: new Uint8Array(fixtureBytes) }),
    ]);
    expect(shim.posted.map((r) => r.id).sort()).toEqual([1, 2, 3]);
    expect(a.archivePath).toBe("a.json");
    expect(b.archivePath).toBe("b.json");
    expect(c.archivePath).toBe("c.json");
    client.terminate();
  });

  it("rejects a request when the worker responds with status=error", async () => {
    const shim = createShimWorker(async (req) => ({
      id: req.id,
      status: "error",
      message: "boom from worker",
    }));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    await expect(
      client.importArchive({ fileName: "x.json", bytes: new Uint8Array() }),
    ).rejects.toThrow(/boom from worker/);
    client.terminate();
  });

  it("terminate() rejects still-pending requests and refuses further work", async () => {
    // Response never fires — the request stays pending until terminate.
    const shim = createShimWorker(() => new Promise<never>(() => {}));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    const pending = client.importArchive({
      fileName: "x.json",
      bytes: new Uint8Array(),
    });
    client.terminate();
    await expect(pending).rejects.toThrow(/terminated/);
    await expect(
      client.importArchive({ fileName: "y.json", bytes: new Uint8Array() }),
    ).rejects.toThrow(/terminated/);
    expect(shim.terminated).toBe(true);
  });

  it("ignores a stale response whose id has no pending entry (regression: does not throw or resolve elsewhere)", async () => {
    const shim = createShimWorker((req) => handleImportArchiveMessage(req));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    // First: resolve a real request so id 1 is fully consumed.
    const first = await client.importArchive({
      fileName: "a.json",
      bytes: new Uint8Array(fixtureBytes),
    });
    expect(first.archivePath).toBe("a.json");
    // Now fire a response for id 999 that was never sent — must be dropped.
    shim.fireMessage({
      id: 999,
      status: "ok",
      kind: "import",
      result: {
        archiveKind: "json",
        archivePath: "stale.json",
        files: [],
        diagnostics: [],
      },
    });
    // And fire a duplicate response for id 1 (stale duplicate) — also dropped.
    shim.fireMessage({
      id: 1,
      status: "ok",
      kind: "import",
      result: {
        archiveKind: "json",
        archivePath: "stale-dup.json",
        files: [],
        diagnostics: [],
      },
    });
    // Follow-up request must still round-trip normally with id 2.
    const second = await client.importArchive({
      fileName: "b.json",
      bytes: new Uint8Array(fixtureBytes),
    });
    expect(second.archivePath).toBe("b.json");
    expect(shim.posted.map((r) => r.id)).toEqual([1, 2]);
    client.terminate();
  });

  it("worker `error` event rejects every pending request", async () => {
    const shim = createShimWorker(() => new Promise<never>(() => {}));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    const p1 = client.importArchive({ fileName: "a.json", bytes: new Uint8Array() });
    const p2 = client.buildGraph({
      hosts: [{ id: "host:a", name: "a", sourceFiles: [] }],
      vhosts: [],
      exchanges: [],
      queues: [],
      bindings: [],
      shovels: [],
      federations: [],
    });
    shim.fireError("worker crashed");
    await expect(p1).rejects.toThrow(/worker crashed/);
    await expect(p2).rejects.toThrow(/worker crashed/);
    client.terminate();
  });

  it("worker `messageerror` event rejects every pending request with a descriptive message", async () => {
    const shim = createShimWorker(() => new Promise<never>(() => {}));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    const p = client.importArchive({ fileName: "a.json", bytes: new Uint8Array() });
    shim.fireMessageError();
    await expect(p).rejects.toThrow(/messageerror/i);
    client.terminate();
  });

  it("postMessage throwing synchronously removes the pending entry and rejects the caller", async () => {
    const shim = createShimWorker(() => new Promise<never>(() => {}));
    shim.postThrows = new Error("clone failed");
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    await expect(
      client.importArchive({ fileName: "a.json", bytes: new Uint8Array() }),
    ).rejects.toThrow(/clone failed/);
    // Now clear the throw and try again — the id counter still advanced so
    // the second call uses id 2, and the shim is free to respond normally.
    shim.postThrows = undefined;
    // Rebuild shim to also respond to the follow-up
    const shim2 = createShimWorker((req) => handleImportArchiveMessage(req));
    const client2 = createImportArchiveWorkerClient({ createWorker: () => shim2 });
    const result = await client2.importArchive({
      fileName: "b.json",
      bytes: new Uint8Array(fixtureBytes),
    });
    expect(result.archivePath).toBe("b.json");
    client.terminate();
    client2.terminate();
  });

  it("routes upstream-for-queue through the worker end-to-end", async () => {
    const shim = createShimWorker((req) => handleImportArchiveMessage(req));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    const graph = await client.buildGraph({
      hosts: [{ id: "host:a", name: "a", sourceFiles: [] }],
      vhosts: [{ id: "vhost:a:/", hostId: "host:a", name: "/" }],
      exchanges: [
        { id: "exchange:a:x", hostId: "host:a", vhostId: "vhost:a:/", name: "x", type: "topic" },
      ],
      queues: [{ id: "queue:a:q", hostId: "host:a", vhostId: "vhost:a:/", name: "q" }],
      bindings: [
        {
          id: "b:x->q",
          hostId: "host:a",
          vhostId: "vhost:a:/",
          sourceExchangeId: "exchange:a:x",
          destinationId: "queue:a:q",
          destinationType: "queue",
          routingKey: "",
        },
      ],
      shovels: [],
      federations: [],
    });
    const traversal = await client.upstreamForQueue(
      { nodes: graph.nodes, edges: graph.edges },
      "queue:a:q",
    );
    expect(traversal.reachableAncestorIds).toContain("exchange:a:x");
    client.terminate();
  });
});

describe("importOnMainThread + createMainThreadClient — same-thread fallback", () => {
  it("importOnMainThread returns the same shape as the worker path", async () => {
    const result = await importOnMainThread({
      fileName: "minimal-definitions.json",
      bytes: new Uint8Array(fixtureBytes),
    });
    expect(result.archiveKind).toBe("json");
    expect(result.files.length).toBeGreaterThan(0);
  });

  it("createMainThreadClient exposes the same API surface as the worker client", async () => {
    const client = createMainThreadClient();
    const importResult = await client.importArchive({
      fileName: "minimal-definitions.json",
      bytes: new Uint8Array(fixtureBytes),
    });
    expect(importResult.archiveKind).toBe("json");
    const graph = await client.buildGraph({
      hosts: [{ id: "host:a", name: "a", sourceFiles: [] }],
      vhosts: [{ id: "vhost:a:/", hostId: "host:a", name: "/" }],
      exchanges: [
        { id: "exchange:a:x", hostId: "host:a", vhostId: "vhost:a:/", name: "x", type: "topic" },
      ],
      queues: [{ id: "queue:a:q", hostId: "host:a", vhostId: "vhost:a:/", name: "q" }],
      bindings: [
        {
          id: "b:x->q",
          hostId: "host:a",
          vhostId: "vhost:a:/",
          sourceExchangeId: "exchange:a:x",
          destinationId: "queue:a:q",
          destinationType: "queue",
          routingKey: "",
        },
      ],
      shovels: [],
      federations: [],
    });
    const traversal = await client.upstreamForQueue(
      { nodes: graph.nodes, edges: graph.edges },
      "queue:a:q",
    );
    expect(traversal.reachableAncestorIds).toContain("exchange:a:x");
    client.terminate();
    await expect(
      client.importArchive({ fileName: "x.json", bytes: new Uint8Array() }),
    ).rejects.toThrow(/terminated/);
  });
});

describe("createImportArchiveWorkerClient — terminal failure state after error/messageerror", () => {
  it("subsequent requests are rejected immediately after a worker `error` event (never posts to a dead worker)", async () => {
    const shim = createShimWorker(() => new Promise<never>(() => {}));
    let failureNotifications = 0;
    const client = createImportArchiveWorkerClient({
      createWorker: () => shim,
      onFailure: () => {
        failureNotifications += 1;
      },
    });
    const pendingBeforeFailure = client.importArchive({
      fileName: "before.json",
      bytes: new Uint8Array(),
    });
    shim.fireError("worker crashed at startup");
    await expect(pendingBeforeFailure).rejects.toThrow(/worker crashed at startup/);
    // Every follow-up request must reject immediately with the failure
    // reason — NOT hang waiting for a dead worker to respond.
    const postFailurePostedBefore = shim.posted.length;
    await expect(
      client.importArchive({ fileName: "after.json", bytes: new Uint8Array() }),
    ).rejects.toThrow(/worker crashed at startup/);
    await expect(
      client.buildGraph({
        hosts: [{ id: "host:a", name: "a", sourceFiles: [] }],
        vhosts: [],
        exchanges: [],
        queues: [],
        bindings: [],
        shovels: [],
        federations: [],
      }),
    ).rejects.toThrow(/worker crashed at startup/);
    // Prove we never posted to the dead worker.
    expect(shim.posted.length).toBe(postFailurePostedBefore);
    expect(shim.terminated).toBe(true);
    expect(failureNotifications).toBe(1);
    // A late-arriving `error` event must NOT double-fire onFailure.
    shim.fireError("late error");
    expect(failureNotifications).toBe(1);
    client.terminate();
  });

  it("subsequent requests are rejected immediately after a worker `messageerror` event", async () => {
    const shim = createShimWorker(() => new Promise<never>(() => {}));
    let failureNotifications = 0;
    const client = createImportArchiveWorkerClient({
      createWorker: () => shim,
      onFailure: () => {
        failureNotifications += 1;
      },
    });
    const pendingBeforeFailure = client.importArchive({
      fileName: "before.json",
      bytes: new Uint8Array(),
    });
    shim.fireMessageError();
    await expect(pendingBeforeFailure).rejects.toThrow(/messageerror/i);
    const postFailurePostedBefore = shim.posted.length;
    await expect(
      client.importArchive({ fileName: "after.json", bytes: new Uint8Array() }),
    ).rejects.toThrow(/messageerror/i);
    await expect(
      client.upstreamForQueue(
        { nodes: [], edges: [] },
        "queue:whatever",
      ),
    ).rejects.toThrow(/messageerror/i);
    expect(shim.posted.length).toBe(postFailurePostedBefore);
    expect(failureNotifications).toBe(1);
    client.terminate();
  });

  it("getSharedTopologyWorkerClient rebuilds its cached singleton after the current one fails", async () => {
    // The shared factory in this vitest env has no `Worker`, so it caches a
    // main-thread client — no worker events to fire. Simulate the singleton
    // being invalidated (as happens when `onFailure` fires in production)
    // and prove the very next call constructs a fresh client.
    resetSharedTopologyWorkerClient();
    const first = getSharedTopologyWorkerClient();
    resetSharedTopologyWorkerClient(); // simulate onFailure invalidating the cache
    const second = getSharedTopologyWorkerClient();
    expect(second).not.toBe(first);
    // Both must still service a request end-to-end (the second is a fresh
    // fallback and therefore healthy).
    const result = await second.importArchive({
      fileName: "minimal-definitions.json",
      bytes: new Uint8Array(fixtureBytes),
    });
    expect(result.archiveKind).toBe("json");
    resetSharedTopologyWorkerClient();
  });
});

describe("createMainThreadClient — synchronous exception safety", () => {
  it("returns a rejected Promise (does NOT throw synchronously) when buildGraph throws on invalid input", async () => {
    const client = createMainThreadClient();
    // Passing a non-array where an array is required makes `buildGraph`
    // throw synchronously. The client must translate that into a rejected
    // Promise — never let it escape the async boundary.
    const invalid = {
      hosts: null,
      vhosts: [],
      exchanges: [],
      queues: [],
      bindings: [],
      shovels: [],
      federations: [],
    } as unknown as Parameters<ReturnType<typeof createMainThreadClient>["buildGraph"]>[0];
    // Wrapping in a Promise.resolve() lets us detect a synchronous escape:
    // if buildGraph threw synchronously, the outer `expect` would surface it
    // instead of the rejection assertion.
    let syncThrew = false;
    let promise: Promise<unknown>;
    try {
      promise = client.buildGraph(invalid);
    } catch (err) {
      syncThrew = true;
      promise = Promise.reject(err);
    }
    expect(syncThrew).toBe(false);
    await expect(promise).rejects.toBeInstanceOf(Error);
    client.terminate();
  });

  it("returns a rejected Promise (does NOT throw synchronously) when upstreamForQueue is called with invalid input", async () => {
    const client = createMainThreadClient();
    let syncThrew = false;
    let promise: Promise<unknown>;
    try {
      // Passing `null` as the graph input forces traversal to throw when
      // iterating `input.nodes`. That must be caught inside guard() and
      // surface through a rejected Promise.
      promise = client.upstreamForQueue(
        null as unknown as Parameters<
          ReturnType<typeof createMainThreadClient>["upstreamForQueue"]
        >[0],
        "queue:whatever",
      );
    } catch (err) {
      syncThrew = true;
      promise = Promise.reject(err);
    }
    expect(syncThrew).toBe(false);
    await expect(promise).rejects.toBeInstanceOf(Error);
    client.terminate();
  });
});

describe("createImportArchiveWorkerClient — terminate() error safety", () => {
  it("still rejects every pending request even when worker.terminate() throws", async () => {
    const shim = createShimWorker(() => new Promise<never>(() => {}));
    // Override terminate to throw so we can verify pending requests still
    // resolve via the finally block.
    shim.terminate = () => {
      shim.terminated = true;
      throw new Error("terminate blew up");
    };
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    const p1 = client.importArchive({ fileName: "a.json", bytes: new Uint8Array() });
    const p2 = client.buildGraph({
      hosts: [{ id: "host:a", name: "a", sourceFiles: [] }],
      vhosts: [],
      exchanges: [],
      queues: [],
      bindings: [],
      shovels: [],
      federations: [],
    });
    // The termination surfaces after pending rejections. It rethrows the
    // underlying `terminate blew up`, but by then every awaiter has been
    // notified of "Worker terminated before response".
    expect(() => client.terminate()).toThrow(/terminate blew up/);
    await expect(p1).rejects.toThrow(/Worker terminated before response/);
    await expect(p2).rejects.toThrow(/Worker terminated before response/);
    // A follow-up call rejects because the client is now marked terminated.
    await expect(
      client.importArchive({ fileName: "b.json", bytes: new Uint8Array() }),
    ).rejects.toThrow(/terminated/);
    // Calling terminate again is a no-op (idempotent).
    expect(() => client.terminate()).not.toThrow();
  });
});

describe("getSharedTopologyWorkerClient — browser-safe factory", () => {
  it("falls back to the main-thread client when Worker is undefined and still services requests", async () => {
    // vitest node env has no Worker global — the factory MUST fall back.
    resetSharedTopologyWorkerClient();
    const client = getSharedTopologyWorkerClient();
    const result = await client.importArchive({
      fileName: "minimal-definitions.json",
      bytes: new Uint8Array(fixtureBytes),
    });
    expect(result.archiveKind).toBe("json");
    // Subsequent calls return the same instance
    expect(getSharedTopologyWorkerClient()).toBe(client);
    resetSharedTopologyWorkerClient();
  });
});
