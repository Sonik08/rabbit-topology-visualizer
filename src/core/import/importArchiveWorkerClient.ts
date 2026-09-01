import type { BuildGraphInput, BuildGraphResult } from "../graph/buildGraph";
import { buildGraph } from "../graph/buildGraph";
import {
  bidirectionalForNode,
  upstreamForExchange,
  upstreamForQueue,
  type BidirectionalTraversalResult,
  type UpstreamGraphInput,
  type UpstreamTraversalOptions,
  type UpstreamTraversalResult,
} from "../graph/traversal";
import {
  pruneNeighborhood,
  type PruneNeighborhoodOptions,
  type PruneNeighborhoodResult,
} from "../graph/pruneNeighborhood";
import {
  importTopologyArchive,
  importTopologyBatch,
  type BatchImportInput,
  type ImportInput,
  type ImportResult,
} from "./importArchive";
import type { WorkerRequest, WorkerResponse } from "./importArchiveWorkerMessage";

/**
 * Minimal `Worker` shape we depend on — narrower than lib.dom's Worker so this
 * module can be typechecked in a plain Node build (workers only exist in the
 * browser environment). Includes `error` + `messageerror` events so pending
 * requests get rejected when the worker crashes instead of hanging forever.
 */
export interface ImportArchiveWorkerLike {
  postMessage(message: WorkerRequest): void;
  addEventListener(type: "message", listener: (event: { data: WorkerResponse }) => void): void;
  addEventListener(
    type: "error" | "messageerror",
    listener: (event: { message?: string }) => void,
  ): void;
  removeEventListener(type: "message", listener: (event: { data: WorkerResponse }) => void): void;
  removeEventListener(
    type: "error" | "messageerror",
    listener: (event: { message?: string }) => void,
  ): void;
  terminate?(): void;
}

export interface ImportArchiveWorkerClient {
  /** Run a parsing/archive import through the worker. */
  importArchive(input: ImportInput): Promise<ImportResult>;
  /**
   * Run a batch parse of many individually-selected files through the worker.
   * Group-parses related split-dump files as if they were extracted from one
   * archive, so a queues.json + bindings.json pair produces one coherent
   * `ImportResult`.
   */
  importBatch(input: BatchImportInput): Promise<ImportResult>;
  /** Run the graph builder in the worker. */
  buildGraph(input: BuildGraphInput): Promise<BuildGraphResult>;
  /** Run an upstream traversal from a queue target in the worker. */
  upstreamForQueue(
    input: UpstreamGraphInput,
    targetQueueId: string,
    options?: UpstreamTraversalOptions,
  ): Promise<UpstreamTraversalResult>;
  /** Run an upstream traversal from an exchange target in the worker. */
  upstreamForExchange(
    input: UpstreamGraphInput,
    targetExchangeId: string,
    options?: UpstreamTraversalOptions,
  ): Promise<UpstreamTraversalResult>;
  /**
   * Run a bidirectional (upstream + downstream) traversal from a
   * queue / exchange / shovel / federation target. Backing store for the
   * selection highlight — computing both directions in a single worker
   * hop avoids two round-trips per selection and lets the client atomically
   * cancel one bidirectional in-flight response instead of racing two.
   */
  bidirectionalForNode(
    input: UpstreamGraphInput,
    targetNodeId: string,
    options?: UpstreamTraversalOptions,
  ): Promise<BidirectionalTraversalResult>;
  /**
   * Run the focused-mode neighborhood clip on the worker instead of the main
   * thread so a large graph with a deep focus radius doesn't stall the UI
   * frame. The result is a fresh `PruneNeighborhoodResult` (nodes + edges +
   * focus metadata) ready for `toReactFlowElements`. The caller pairs this
   * with a cancelled-flag guarded effect to protect against out-of-order
   * responses when the focus target changes rapidly.
   */
  pruneNeighborhood(
    input: BuildGraphResult,
    focusNodeId: string,
    options?: PruneNeighborhoodOptions,
  ): Promise<PruneNeighborhoodResult>;
  /** Tear down the worker; subsequent calls will reject immediately. */
  terminate(): void;
}

export interface CreateImportArchiveWorkerClientOptions {
  /**
   * Factory that produces the worker. Kept as a caller-provided function so
   * both the real Vite worker constructor
   * (`new Worker(new URL('./importArchiveWorker.ts', import.meta.url), { type: 'module' })`)
   * and test-time in-process shims can plug in through the same API.
   */
  createWorker: () => ImportArchiveWorkerLike;
  /**
   * Invoked exactly once when the worker enters a terminal failure state
   * (`error` or `messageerror` event). The shared-client factory uses this
   * hook to invalidate its cached singleton so the next
   * `getSharedTopologyWorkerClient()` call spins up a fresh worker (or falls
   * back to the main-thread implementation).
   */
  onFailure?: (error: Error) => void;
}

/**
 * Wraps a `Worker` in a Promise-based client. Every outbound request gets a
 * fresh monotonic `id` so a single worker can service concurrent operations
 * without responses bleeding into the wrong callers — critical when a user
 * drops several archives in quick succession or triggers a highlight update
 * while an import is still resolving.
 *
 * Safety invariants:
 *   - `postMessage` is wrapped in try/catch; if the underlying `Worker` throws
 *     synchronously (e.g. because it was terminated racily or the payload
 *     failed structured-clone), the pending entry is removed and the Promise
 *     rejects rather than hanging forever.
 *   - The client listens for `error` and `messageerror` events on the worker.
 *     Any such event rejects EVERY pending request with a descriptive Error
 *     because the worker crashed mid-flight and none of them will ever return.
 *   - `terminate()` removes every listener, calls `worker.terminate?.()`, and
 *     rejects any still-pending requests so a caller awaiting them doesn't
 *     hang after teardown.
 *
 * Failure to construct the worker itself (unsupported environment, syntax
 * error in the entry module) is not caught here; the caller can decide to
 * fall back to {@link importOnMainThread} inline. See
 * {@link getSharedTopologyWorkerClient} for a browser-safe factory that
 * transparently falls back to the main thread when Worker is unavailable.
 */
export function createImportArchiveWorkerClient(
  options: CreateImportArchiveWorkerClientOptions,
): ImportArchiveWorkerClient {
  const worker = options.createWorker();
  const pending = new Map<
    number,
    {
      resolve: (r: WorkerResponse) => void;
      reject: (e: Error) => void;
    }
  >();
  let nextId = 1;
  let terminated = false;
  /**
   * Terminal failure reason. Once set, the client refuses every subsequent
   * request with this Error rather than posting to a worker that has already
   * crashed — a `worker.postMessage(...)` to a dead worker would silently
   * never resolve, hanging the caller forever. Set by the `error` /
   * `messageerror` handlers and also invalidates the shared-client cache so
   * the next `getSharedTopologyWorkerClient()` call spins up a fresh
   * instance (or falls back to the main-thread implementation).
   */
  let failure: Error | undefined;
  const onFailure = options.onFailure;

  const markFailed = (message: string): void => {
    if (failure) return;
    failure = new Error(message);
    // Detach listeners eagerly so a late-arriving message can't resolve a
    // stale pending entry that we're about to reject.
    try {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onErrorEvent);
      worker.removeEventListener("messageerror", onMessageError);
    } catch {
      // Best-effort listener cleanup.
    }
    rejectAllPending(message);
    // Try to release the underlying worker; swallow any teardown error
    // because we've already surfaced the fatal failure to every caller.
    try {
      worker.terminate?.();
    } catch {
      // ignore
    }
    onFailure?.(failure);
  };

  const onMessage = (event: { data: WorkerResponse }): void => {
    const response = event.data;
    if (!response || typeof response.id !== "number") return;
    const entry = pending.get(response.id);
    if (!entry) return; // stale response — worker responded after we gave up
    pending.delete(response.id);
    entry.resolve(response);
  };

  const rejectAllPending = (message: string): void => {
    for (const [, entry] of pending) {
      entry.reject(new Error(message));
    }
    pending.clear();
  };

  const onErrorEvent = (event: { message?: string }): void => {
    markFailed(
      `Worker error event: ${event?.message ?? "(no message provided)"}`,
    );
  };

  const onMessageError = (): void => {
    markFailed(
      "Worker messageerror event — a response payload failed structured-clone",
    );
  };

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onErrorEvent);
  worker.addEventListener("messageerror", onMessageError);

  function submitRaw(request: WorkerRequest): Promise<WorkerResponse> {
    if (terminated) {
      return Promise.reject(
        new Error("ImportArchiveWorkerClient has been terminated"),
      );
    }
    if (failure) {
      // Terminal failure state: refuse every subsequent request immediately
      // rather than posting to a dead worker that will never respond.
      return Promise.reject(new Error(failure.message));
    }
    const id = request.id;
    return new Promise<WorkerResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage(request);
      } catch (err) {
        // `postMessage` can throw synchronously if the payload can't be
        // structured-cloned or the worker was terminated racily. Remove the
        // pending entry so we never hang — the reject propagates to the
        // caller through the returned Promise.
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return {
    async importArchive(input) {
      const id = nextId++;
      const response = await submitRaw({ id, kind: "import", input });
      if (response.status === "error") throw new Error(response.message);
      if (response.kind !== "import") {
        throw new Error(`Worker returned unexpected response kind '${response.kind}' for import`);
      }
      return response.result;
    },
    async importBatch(input) {
      const id = nextId++;
      const response = await submitRaw({ id, kind: "import-batch", input });
      if (response.status === "error") throw new Error(response.message);
      if (response.kind !== "import-batch") {
        throw new Error(
          `Worker returned unexpected response kind '${response.kind}' for import-batch`,
        );
      }
      return response.result;
    },
    async buildGraph(input) {
      const id = nextId++;
      const response = await submitRaw({ id, kind: "build-graph", input });
      if (response.status === "error") throw new Error(response.message);
      if (response.kind !== "build-graph") {
        throw new Error(
          `Worker returned unexpected response kind '${response.kind}' for build-graph`,
        );
      }
      return response.result;
    },
    async upstreamForQueue(input, targetQueueId, traversalOptions) {
      const id = nextId++;
      const response = await submitRaw({
        id,
        kind: "upstream-for-queue",
        input,
        targetQueueId,
        options: traversalOptions,
      });
      if (response.status === "error") throw new Error(response.message);
      if (response.kind !== "upstream-for-queue") {
        throw new Error(
          `Worker returned unexpected response kind '${response.kind}' for upstream-for-queue`,
        );
      }
      return response.result;
    },
    async upstreamForExchange(input, targetExchangeId, traversalOptions) {
      const id = nextId++;
      const response = await submitRaw({
        id,
        kind: "upstream-for-exchange",
        input,
        targetExchangeId,
        options: traversalOptions,
      });
      if (response.status === "error") throw new Error(response.message);
      if (response.kind !== "upstream-for-exchange") {
        throw new Error(
          `Worker returned unexpected response kind '${response.kind}' for upstream-for-exchange`,
        );
      }
      return response.result;
    },
    async bidirectionalForNode(input, targetNodeId, traversalOptions) {
      const id = nextId++;
      const response = await submitRaw({
        id,
        kind: "bidirectional-for-node",
        input,
        targetNodeId,
        options: traversalOptions,
      });
      if (response.status === "error") throw new Error(response.message);
      if (response.kind !== "bidirectional-for-node") {
        throw new Error(
          `Worker returned unexpected response kind '${response.kind}' for bidirectional-for-node`,
        );
      }
      return response.result;
    },
    async pruneNeighborhood(input, focusNodeId, pruneOptions) {
      const id = nextId++;
      const response = await submitRaw({
        id,
        kind: "prune-neighborhood",
        input,
        focusNodeId,
        options: pruneOptions,
      });
      if (response.status === "error") throw new Error(response.message);
      if (response.kind !== "prune-neighborhood") {
        throw new Error(
          `Worker returned unexpected response kind '${response.kind}' for prune-neighborhood`,
        );
      }
      return response.result;
    },
    terminate() {
      if (terminated) return;
      terminated = true;
      // Detach listeners eagerly so a message racing with terminate can't
      // resolve a pending entry we're about to reject.
      try {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onErrorEvent);
        worker.removeEventListener("messageerror", onMessageError);
      } catch {
        // Best-effort — a broken listener registry can't be allowed to leave
        // callers hanging on unresolved promises.
      }
      let terminateError: unknown;
      try {
        worker.terminate?.();
      } catch (err) {
        // Capture but do NOT re-throw yet — pending requests must be
        // rejected first so callers never hang, even when the underlying
        // Worker throws from `terminate()` (some browser polyfills do this
        // on already-terminated workers, and shims/tests may as well).
        terminateError = err;
      } finally {
        rejectAllPending("Worker terminated before response");
      }
      if (terminateError !== undefined) {
        // Surface the termination failure after every caller has been
        // unblocked. Rethrowing keeps the failure visible to whoever asked
        // for teardown, but by now every pending Promise has already been
        // rejected with a clear "Worker terminated before response" message.
        throw terminateError instanceof Error
          ? terminateError
          : new Error(String(terminateError));
      }
    },
  };
}

/**
 * Synchronous same-thread fallback used when the browser can't spawn a
 * dedicated worker (very old runtimes, tests, non-browser environments).
 * Behaves identically to the worker-backed client but keeps everything on the
 * current thread. Matches the shape of {@link ImportArchiveWorkerClient} so
 * `getSharedTopologyWorkerClient` can return either one from the same call
 * site.
 */
export function importOnMainThread(input: ImportInput): Promise<ImportResult> {
  return importTopologyArchive(input);
}

/**
 * Same-thread client with the exact same shape as the worker-backed client.
 * Handy for tests and for the fallback path when `Worker` is undefined.
 */
export function createMainThreadClient(): ImportArchiveWorkerClient {
  let terminated = false;
  const guard = <T>(work: () => Promise<T> | T): Promise<T> => {
    if (terminated) {
      return Promise.reject(
        new Error("ImportArchiveWorkerClient has been terminated"),
      );
    }
    // Must catch synchronous exceptions from `work()` — `buildGraph` and the
    // traversal helpers throw synchronously on invalid input, and letting
    // that escape the Promise contract would surprise callers who expect a
    // rejected Promise from an async-shaped method. `Promise.resolve(work())`
    // alone doesn't handle this because it evaluates `work()` eagerly before
    // the Promise wrapper takes effect.
    try {
      return Promise.resolve(work());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
  return {
    importArchive: (input) => guard(() => importTopologyArchive(input)),
    importBatch: (input) => guard(() => importTopologyBatch(input)),
    buildGraph: (input) => guard(() => buildGraph(input)),
    upstreamForQueue: (input, target, options) =>
      guard(() => upstreamForQueue(input, target, options)),
    upstreamForExchange: (input, target, options) =>
      guard(() => upstreamForExchange(input, target, options)),
    bidirectionalForNode: (input, target, options) =>
      guard(() => bidirectionalForNode(input, target, options)),
    pruneNeighborhood: (input, focus, options) =>
      guard(() => pruneNeighborhood(input, focus, options)),
    terminate: () => {
      terminated = true;
    },
  };
}

let sharedClient: ImportArchiveWorkerClient | undefined;

/**
 * Returns a lazily-created singleton client suitable for UI use. On the first
 * call it attempts to spawn the real Web Worker via
 * `new Worker(new URL('./importArchiveWorker.ts', import.meta.url), { type: 'module' })`;
 * if `Worker` is not defined or construction fails (jsdom test env, prerender,
 * unsupported browser) it transparently falls back to a same-thread client so
 * the app still works — just without the off-thread benefit.
 *
 * Subsequent calls return the same client instance. Call `resetSharedTopologyWorkerClient`
 * to tear it down (useful in tests).
 */
export function getSharedTopologyWorkerClient(): ImportArchiveWorkerClient {
  if (sharedClient) return sharedClient;
  try {
    if (typeof Worker === "undefined") {
      throw new Error("Worker is not defined in this environment");
    }
    const worker = new Worker(new URL("./importArchiveWorker.ts", import.meta.url), {
      type: "module",
    });
    sharedClient = createImportArchiveWorkerClient({
      createWorker: () => worker as unknown as ImportArchiveWorkerLike,
      // On terminal failure invalidate the cached singleton so the NEXT
      // `getSharedTopologyWorkerClient()` call constructs a fresh worker; if
      // construction itself keeps failing, the catch below falls back to the
      // main-thread client on that retry. This means a crashed worker never
      // strands the app in a permanently-broken state.
      onFailure: () => {
        sharedClient = undefined;
      },
    });
  } catch {
    sharedClient = createMainThreadClient();
  }
  return sharedClient;
}

/** Reset the shared client (tests only — production code should call `.terminate()`). */
export function resetSharedTopologyWorkerClient(): void {
  sharedClient?.terminate();
  sharedClient = undefined;
}
