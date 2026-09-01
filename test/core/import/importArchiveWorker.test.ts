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

  it("dispatches an import-batch request through the batch importer", async () => {
    const response = await handleImportArchiveMessage({
      id: 11,
      kind: "import-batch",
      input: {
        files: [
          { fileName: "minimal-definitions.json", bytes: new Uint8Array(fixtureBytes) },
        ],
      },
    });
    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("expected ok");
    expect(response.kind).toBe("import-batch");
    if (response.kind !== "import-batch") throw new Error("expected import-batch");
    expect(response.result.archiveKind).toBe("batch");
    expect(response.result.files.length).toBe(1);
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

  it("regression: processes the RabbitMQ 3.12 HA shovel URI export shape end-to-end without dropping shovels or leaking credentials", async () => {
    // Sanitized reproduction of the failing 3.12.6 shape from the real export
    // this task is anchored on. Pre-fix, `parseShovel` silently discarded the
    // array-valued src-uri/dest-uri so both shovels disappeared from the
    // worker's runtime response — the worker path never surfaced the drop.
    const haFixturePath = resolve(
      here,
      "..",
      "..",
      "fixtures",
      "rabbit-3.12-shovel-ha-uri.json",
    );
    const bytes = new Uint8Array(readFileSync(haFixturePath));
    const response = await handleImportArchiveMessage({
      id: 312,
      kind: "import",
      input: { fileName: "rabbit-3.12-shovel-ha-uri.json", bytes },
    });
    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("expected ok");
    expect(response.kind).toBe("import");
    if (response.kind !== "import") throw new Error("expected import");
    const file = response.result.files[0];
    expect(file?.kind).toBe("definitions");
    // Both shovels materialise through the worker path (pre-fix regression pin).
    expect(file?.runtime?.shovels.map((s) => s.name).sort()).toEqual([
      "audit-shovel-mixed-shape",
      "orders-shovel-ha",
    ]);
    // Primary endpoint host derived from the FIRST URI in each HA array,
    // even when the import path went through the worker dispatcher.
    const ha = file?.runtime?.shovels.find((s) => s.name === "orders-shovel-ha");
    expect(ha?.source.host).toBe("primary.example.internal");
    expect(ha?.destination.host).toBe("local-a.example.internal");
    // Full serialized worker response must never contain a raw user:pass@
    // AMQP userinfo pattern — credentials stay redacted end-to-end.
    const serialised = JSON.stringify(response);
    expect(serialised).not.toMatch(/amqp:\/\/[^@:"\s]+:[^@:"\s]+@/);
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

  it("routes an importBatch call through the worker client end-to-end with per-file selectionIndex attribution", async () => {
    const shim = createShimWorker((req) => handleImportArchiveMessage(req));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    const result = await client.importBatch({
      files: [
        {
          fileName: "queues.json",
          bytes: new TextEncoder().encode(
            JSON.stringify([{ name: "q.only", vhost: "/", durable: true }]),
          ),
          selectionIndex: 0,
        },
      ],
      skipped: [
        {
          fileName: "queues.json",
          sizeBytes: 5,
          reason: "read-failed",
          detail: "simulated",
          selectionIndex: 1,
        },
      ],
    });
    expect(result.archiveKind).toBe("batch");
    // Both filenames appear in the result — one parsed as management-dump,
    // one recorded as load-error thanks to the preflight `skipped` payload.
    expect(result.files.some((f) => f.path === "queues.json" && f.kind === "management-dump")).toBe(true);
    expect(result.files.some((f) => f.path === "queues.json" && f.kind === "load-error")).toBe(true);
    // Every diagnostic keeps the caller-supplied selectionIndex in its
    // sourceFileId — batch[0]:queues.json and batch[1]:queues.json must both
    // appear, never a collision on batch[0] or batch[1].
    const sourceIds = new Set(
      result.diagnostics.map((d) => d.sourceFileId).filter((id): id is string => Boolean(id)),
    );
    expect(sourceIds.has("batch[0]:queues.json")).toBe(true);
    expect(sourceIds.has("batch[1]:queues.json")).toBe(true);
    // The request that hit the shim was of kind "import-batch", not "import".
    expect(shim.posted.some((r) => r.kind === "import-batch")).toBe(true);
    client.terminate();
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

/**
 * Sanitized 5-node bidirectional chain used by every bidirectional worker
 * test below:
 *
 *   exchange:a:x1 → exchange:a:x2 → shovel:a:s1 → exchange:a:x3 → queue:a:q1
 *
 * Plus a completely unrelated pair (`exchange:a:noise → queue:a:noise`)
 * that the traversal must NEVER touch. The fixture is intentionally small
 * — the point of these tests is the WIRE protocol / client envelope, not
 * traversal correctness (that's in bidirectionalTraversal.test.ts).
 */
function bidirectionalFixture(): {
  nodes: Array<{ id: string; kind: string; label: string; data: unknown }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    kind: string;
    routingKey?: string;
  }>;
} {
  return {
    nodes: [
      { id: "exchange:a:x1", kind: "exchange", label: "x1", data: {} },
      { id: "exchange:a:x2", kind: "exchange", label: "x2", data: {} },
      { id: "exchange:a:x3", kind: "exchange", label: "x3", data: {} },
      { id: "shovel:a:s1", kind: "shovel", label: "s1", data: {} },
      { id: "queue:a:q1", kind: "queue", label: "q1", data: {} },
      { id: "exchange:a:noise", kind: "exchange", label: "noise", data: {} },
      { id: "queue:a:noise", kind: "queue", label: "noise", data: {} },
    ],
    edges: [
      { id: "b:x1->x2", from: "exchange:a:x1", to: "exchange:a:x2", kind: "binds", routingKey: "k" },
      { id: "b:x2->s1", from: "exchange:a:x2", to: "shovel:a:s1", kind: "binds", routingKey: "k" },
      { id: "s:s1->x3", from: "shovel:a:s1", to: "exchange:a:x3", kind: "shovels" },
      { id: "b:x3->q1", from: "exchange:a:x3", to: "queue:a:q1", kind: "binds", routingKey: "k" },
      { id: "b:noise", from: "exchange:a:noise", to: "queue:a:noise", kind: "binds", routingKey: "n" },
    ],
  };
}

describe("handleImportArchiveMessage — bidirectional-for-node dispatcher (task 58 worker protocol)", () => {
  it("processes a well-formed bidirectional-for-node request and returns the combined upstream + downstream envelope with the request id echoed", async () => {
    const input = bidirectionalFixture();
    const response = await handleImportArchiveMessage({
      id: 42,
      kind: "bidirectional-for-node",
      input,
      targetNodeId: "shovel:a:s1",
    });
    expect(response.id).toBe(42);
    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("expected ok");
    expect(response.kind).toBe("bidirectional-for-node");
    if (response.kind !== "bidirectional-for-node") throw new Error("expected bidirectional-for-node");
    // Selecting the shovel walks both directions: upstream reaches
    // x2 + x1, downstream reaches x3 + q1. The unrelated noise pair MUST
    // not appear on either side.
    expect(new Set(response.result.upstream.reachableAncestorIds)).toEqual(
      new Set(["exchange:a:x2", "exchange:a:x1"]),
    );
    expect(new Set(response.result.downstream.reachableDescendantIds)).toEqual(
      new Set(["exchange:a:x3", "queue:a:q1"]),
    );
    expect(response.result.upstream.reachableAncestorIds).not.toContain("exchange:a:noise");
    expect(response.result.downstream.reachableDescendantIds).not.toContain("queue:a:noise");
  });

  it("forwards `options` (maxDepth, followDeadLetter) — proves the dispatcher does not silently drop the caller's traversal knobs", async () => {
    const input = bidirectionalFixture();
    const response = await handleImportArchiveMessage({
      id: 43,
      kind: "bidirectional-for-node",
      input,
      targetNodeId: "shovel:a:s1",
      options: { maxDepth: 1 },
    });
    if (response.status !== "ok" || response.kind !== "bidirectional-for-node") {
      throw new Error("expected bidirectional-for-node ok response");
    }
    // maxDepth=1 → only immediate neighbors reachable in each direction.
    expect(new Set(response.result.upstream.reachableAncestorIds)).toEqual(
      new Set(["exchange:a:x2"]),
    );
    expect(new Set(response.result.downstream.reachableDescendantIds)).toEqual(
      new Set(["exchange:a:x3"]),
    );
    expect(response.result.upstream.truncated || response.result.downstream.truncated).toBe(true);
  });

  it("rejects a bidirectional-for-node request missing `input` with a structured error envelope (not an unhandled rejection)", async () => {
    const response = await handleImportArchiveMessage({
      id: 44,
      kind: "bidirectional-for-node",
      targetNodeId: "queue:a:q1",
    });
    expect(response.status).toBe("error");
    if (response.status !== "error") throw new Error("expected error");
    expect(response.id).toBe(44);
    expect(response.message).toMatch(/bidirectional-for-node.*missing 'input'/i);
  });

  it("rejects a bidirectional-for-node request missing `targetNodeId` with a structured error envelope", async () => {
    const response = await handleImportArchiveMessage({
      id: 45,
      kind: "bidirectional-for-node",
      input: bidirectionalFixture(),
    });
    expect(response.status).toBe("error");
    if (response.status !== "error") throw new Error("expected error");
    expect(response.id).toBe(45);
    expect(response.message).toMatch(/bidirectional-for-node.*targetNodeId/i);
  });

  it("targeting an unsupported node id returns an OK envelope with empty per-direction reach — safe no-op contract mirrored across the worker protocol", async () => {
    const input = bidirectionalFixture();
    // No such id — dispatcher must NOT throw; the traversal safe-no-ops.
    const response = await handleImportArchiveMessage({
      id: 46,
      kind: "bidirectional-for-node",
      input,
      targetNodeId: "queue:a:ghost",
    });
    if (response.status !== "ok" || response.kind !== "bidirectional-for-node") {
      throw new Error("expected ok bidirectional-for-node response");
    }
    expect(response.result.upstream.reachableAncestorIds).toEqual([]);
    expect(response.result.downstream.reachableDescendantIds).toEqual([]);
  });
});

describe("createImportArchiveWorkerClient — bidirectionalForNode round-trip + malformed-response handling", () => {
  it("round-trips a bidirectional-for-node request through the shim worker and resolves with the combined envelope", async () => {
    const shim = createShimWorker((req) => handleImportArchiveMessage(req));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    const result = await client.bidirectionalForNode(
      bidirectionalFixture(),
      "shovel:a:s1",
    );
    expect(result.targetNodeId).toBe("shovel:a:s1");
    expect(new Set(result.upstream.reachableAncestorIds)).toEqual(
      new Set(["exchange:a:x1", "exchange:a:x2"]),
    );
    expect(new Set(result.downstream.reachableDescendantIds)).toEqual(
      new Set(["exchange:a:x3", "queue:a:q1"]),
    );
    // Wire-format check — the request the client posts is a bona fide
    // bidirectional-for-node payload with the right shape.
    const posted = shim.posted[0]!;
    expect(posted.kind).toBe("bidirectional-for-node");
    if (posted.kind !== "bidirectional-for-node") throw new Error("expected bidirectional-for-node");
    expect(posted.targetNodeId).toBe("shovel:a:s1");
    client.terminate();
  });

  it("propagates a status=error response from the worker as a rejected Promise", async () => {
    const shim = createShimWorker(async (req) => ({
      id: req.id,
      status: "error",
      message: "traversal blew up on the worker",
    }));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    await expect(
      client.bidirectionalForNode(bidirectionalFixture(), "shovel:a:s1"),
    ).rejects.toThrow(/traversal blew up on the worker/);
    client.terminate();
  });

  it("rejects with a descriptive error when the worker responds with the WRONG kind (protocol mismatch — malformed response)", async () => {
    // Worker respects the id but returns an unrelated `ok` kind. The client
    // must NOT silently pretend the bidirectional call succeeded with a
    // BuildGraphResult in the wrong slot — every helper carries an explicit
    // envelope-kind check that must fire.
    const shim = createShimWorker(async (req) => ({
      id: req.id,
      status: "ok",
      kind: "build-graph",
      result: { nodes: [], edges: [], diagnostics: [] },
    }));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    await expect(
      client.bidirectionalForNode(bidirectionalFixture(), "queue:a:q1"),
    ).rejects.toThrow(/unexpected response kind.*bidirectional-for-node/i);
    client.terminate();
  });

  it("terminate() rejects an in-flight bidirectionalForNode call (no hang on unmount)", async () => {
    // Worker never responds — simulates the tab closing mid-traversal.
    const shim = createShimWorker(() => new Promise<never>(() => {}));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    const pending = client.bidirectionalForNode(
      bidirectionalFixture(),
      "queue:a:q1",
    );
    client.terminate();
    await expect(pending).rejects.toThrow(/Worker terminated before response/);
  });
});

describe("createMainThreadClient — bidirectionalForNode fallback (Worker-unavailable path)", () => {
  it("services a bidirectionalForNode call end-to-end on the main thread with the same envelope shape as the worker client", async () => {
    const client = createMainThreadClient();
    const result = await client.bidirectionalForNode(
      bidirectionalFixture(),
      "exchange:a:x2",
    );
    expect(result.targetNodeId).toBe("exchange:a:x2");
    // From x2, upstream reaches only x1; downstream reaches shovel + x3 + q1.
    expect(result.upstream.reachableAncestorIds).toEqual(["exchange:a:x1"]);
    expect(new Set(result.downstream.reachableDescendantIds)).toEqual(
      new Set(["shovel:a:s1", "exchange:a:x3", "queue:a:q1"]),
    );
    client.terminate();
  });

  it("returns a rejected Promise (does NOT throw synchronously) when bidirectionalForNode is called with invalid input", async () => {
    const client = createMainThreadClient();
    let syncThrew = false;
    let promise: Promise<unknown>;
    try {
      promise = client.bidirectionalForNode(
        null as unknown as Parameters<
          ReturnType<typeof createMainThreadClient>["bidirectionalForNode"]
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

  it("after terminate() the fallback client rejects further bidirectionalForNode calls with a `terminated` message (matches the worker client's contract)", async () => {
    const client = createMainThreadClient();
    client.terminate();
    await expect(
      client.bidirectionalForNode(bidirectionalFixture(), "queue:a:q1"),
    ).rejects.toThrow(/terminated/);
  });
});

describe("handleImportArchiveMessage — prune-neighborhood dispatcher (task 53 worker protocol)", () => {
  it("processes a well-formed prune-neighborhood request and returns the clipped subgraph with the request id echoed", async () => {
    const input = bidirectionalFixture();
    const response = await handleImportArchiveMessage({
      id: 51,
      kind: "prune-neighborhood",
      input,
      focusNodeId: "shovel:a:s1",
      options: { direction: "both", maxDepth: 5 },
    });
    expect(response.id).toBe(51);
    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("expected ok");
    expect(response.kind).toBe("prune-neighborhood");
    if (response.kind !== "prune-neighborhood") throw new Error("expected prune-neighborhood");
    expect(response.result.focusNodeId).toBe("shovel:a:s1");
    // The unrelated noise pair must not survive the clip.
    const nodeIds = new Set(response.result.nodes.map((n) => n.id));
    expect(nodeIds.has("exchange:a:noise")).toBe(false);
    expect(nodeIds.has("queue:a:noise")).toBe(false);
    // Shovel neighborhood walks both directions from s1.
    expect(nodeIds.has("shovel:a:s1")).toBe(true);
    expect(nodeIds.has("exchange:a:x2")).toBe(true);
    expect(nodeIds.has("exchange:a:x3")).toBe(true);
  });

  it("rejects a prune-neighborhood request missing `input` with a structured error envelope", async () => {
    const response = await handleImportArchiveMessage({
      id: 52,
      kind: "prune-neighborhood",
      focusNodeId: "shovel:a:s1",
    });
    expect(response.status).toBe("error");
    if (response.status !== "error") throw new Error("expected error");
    expect(response.id).toBe(52);
    expect(response.message).toMatch(/prune-neighborhood.*missing 'input'/i);
  });

  it("rejects a prune-neighborhood request missing `focusNodeId` with a structured error envelope", async () => {
    const response = await handleImportArchiveMessage({
      id: 53,
      kind: "prune-neighborhood",
      input: bidirectionalFixture(),
    });
    expect(response.status).toBe("error");
    if (response.status !== "error") throw new Error("expected error");
    expect(response.id).toBe(53);
    expect(response.message).toMatch(/prune-neighborhood.*focusNodeId/i);
  });

  it("focus id not in the graph returns an OK envelope with `focusMissing: true` — safe no-op, not an error", async () => {
    const response = await handleImportArchiveMessage({
      id: 54,
      kind: "prune-neighborhood",
      input: bidirectionalFixture(),
      focusNodeId: "queue:a:ghost",
    });
    if (response.status !== "ok" || response.kind !== "prune-neighborhood") {
      throw new Error("expected ok prune-neighborhood response");
    }
    expect(response.result.focusMissing).toBe(true);
    expect(response.result.nodes).toEqual([]);
  });
});

describe("createImportArchiveWorkerClient — pruneNeighborhood round-trip + malformed-response handling", () => {
  it("round-trips a prune-neighborhood request through the shim worker and resolves with the clipped subgraph", async () => {
    const shim = createShimWorker((req) => handleImportArchiveMessage(req));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    const result = await client.pruneNeighborhood(
      bidirectionalFixture() as never,
      "shovel:a:s1",
      { direction: "both", maxDepth: 5 },
    );
    expect(result.focusNodeId).toBe("shovel:a:s1");
    expect(result.nodes.map((n) => n.id)).toContain("shovel:a:s1");
    client.terminate();
  });

  it("worker responds with the WRONG kind — client rejects with 'unexpected response kind … prune-neighborhood' instead of silently accepting a mismatched envelope", async () => {
    const shim = createShimWorker(async (req) => ({
      id: (req as { id: number }).id,
      status: "ok" as const,
      kind: "build-graph" as const,
      result: { nodes: [], edges: [], diagnostics: [] },
    }));
    const client = createImportArchiveWorkerClient({ createWorker: () => shim });
    await expect(
      client.pruneNeighborhood(
        bidirectionalFixture() as never,
        "shovel:a:s1",
      ),
    ).rejects.toThrow(/unexpected response kind.*prune-neighborhood/i);
    client.terminate();
  });
});

describe("createMainThreadClient — pruneNeighborhood fallback (Worker-unavailable path)", () => {
  it("runs prune-neighborhood end-to-end on the main thread and returns a subgraph with the focus id echoed", async () => {
    const client = createMainThreadClient();
    const result = await client.pruneNeighborhood(
      bidirectionalFixture() as never,
      "shovel:a:s1",
      { direction: "both", maxDepth: 5 },
    );
    expect(result.focusNodeId).toBe("shovel:a:s1");
    expect(result.nodes.map((n) => n.id)).toContain("shovel:a:s1");
    client.terminate();
  });

  it("after terminate() the fallback client rejects further pruneNeighborhood calls with a `terminated` message", async () => {
    const client = createMainThreadClient();
    client.terminate();
    await expect(
      client.pruneNeighborhood(bidirectionalFixture() as never, "shovel:a:s1"),
    ).rejects.toThrow(/terminated/);
  });
});
