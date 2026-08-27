import { buildGraph, type BuildGraphInput, type BuildGraphResult } from "../graph/buildGraph";
import {
  upstreamForExchange,
  upstreamForQueue,
  type UpstreamGraphInput,
  type UpstreamTraversalOptions,
  type UpstreamTraversalResult,
} from "../graph/traversal";
import {
  importTopologyArchive,
  type ImportInput,
  type ImportResult,
} from "./importArchive";

/**
 * Wire format for messages sent to the topology Web Worker. Each request
 * carries a monotonically-increasing `id` so multiple concurrent operations
 * can share a single worker without their responses colliding.
 *
 * The worker handles both parsing (`import`) and query (`build-graph`,
 * `upstream-for-queue`, `upstream-for-exchange`) work — the whole heavy
 * pipeline stays off the main UI thread for large topologies.
 */
export type WorkerRequest =
  | { id: number; kind: "import"; input: ImportInput }
  | { id: number; kind: "build-graph"; input: BuildGraphInput }
  | {
      id: number;
      kind: "upstream-for-queue";
      input: UpstreamGraphInput;
      targetQueueId: string;
      options?: UpstreamTraversalOptions;
    }
  | {
      id: number;
      kind: "upstream-for-exchange";
      input: UpstreamGraphInput;
      targetExchangeId: string;
      options?: UpstreamTraversalOptions;
    };

/** Success/failure envelope posted back from the worker. */
export type WorkerResponse =
  | { id: number; status: "ok"; kind: "import"; result: ImportResult }
  | { id: number; status: "ok"; kind: "build-graph"; result: BuildGraphResult }
  | {
      id: number;
      status: "ok";
      kind: "upstream-for-queue";
      result: UpstreamTraversalResult;
    }
  | {
      id: number;
      status: "ok";
      kind: "upstream-for-exchange";
      result: UpstreamTraversalResult;
    }
  | {
      id: number;
      status: "error";
      /**
       * JS Error message. The worker never posts the raw Error object because
       * structured-clone drops the stack, and it would obscure the origin.
       */
      message: string;
    };

/**
 * Back-compat aliases for the pre-expansion (import-only) name. Downstream
 * consumers may still import the original names.
 */
export type ImportArchiveWorkerRequest = Extract<WorkerRequest, { kind: "import" }>;
export type ImportArchiveWorkerResponse =
  | Extract<WorkerResponse, { status: "ok"; kind: "import" }>
  | Extract<WorkerResponse, { status: "error" }>;

/**
 * Pure dispatcher used by the Web Worker entry — kept as its own function so
 * the request/response protocol can be unit-tested in Node vitest runs without
 * spawning a real `Worker` (jsdom doesn't ship one, and importing the Vite
 * worker entry would fail under vitest because it references `self` as
 * `DedicatedWorkerGlobalScope`).
 *
 * The entire body — including the `request.kind` lookup and even the `id`
 * read — runs inside `try/catch`, so a `null`, `undefined`, or otherwise
 * malformed payload never escapes as an unhandled worker rejection. The
 * worker stays alive and the error is surfaced as a structured envelope; the
 * response's `id` falls back to `-1` when the payload lacked one so the
 * client's `pending` map can still route it to *some* listener (or, more
 * commonly, be discarded as a stale response) rather than being lost.
 */
export async function handleImportArchiveMessage(
  request: unknown,
): Promise<WorkerResponse> {
  let id = -1;
  try {
    if (request === null || typeof request !== "object") {
      throw new Error(
        `Worker request must be an object, got ${describe(request)}.`,
      );
    }
    const record = request as Record<string, unknown>;
    if (typeof record.id === "number" && Number.isFinite(record.id)) {
      id = record.id;
    }
    const kind = record.kind;
    switch (kind) {
      case "import": {
        const input = record.input as ImportInput | undefined;
        if (!input) throw new Error("import request is missing 'input'.");
        const result = await importTopologyArchive(input);
        return { id, status: "ok", kind: "import", result };
      }
      case "build-graph": {
        const input = record.input as BuildGraphInput | undefined;
        if (!input) throw new Error("build-graph request is missing 'input'.");
        const result = buildGraph(input);
        return { id, status: "ok", kind: "build-graph", result };
      }
      case "upstream-for-queue": {
        const input = record.input as UpstreamGraphInput | undefined;
        const target = record.targetQueueId;
        if (!input) throw new Error("upstream-for-queue request is missing 'input'.");
        if (typeof target !== "string") {
          throw new Error("upstream-for-queue request is missing 'targetQueueId' string.");
        }
        const options = record.options as UpstreamTraversalOptions | undefined;
        const result = upstreamForQueue(input, target, options);
        return { id, status: "ok", kind: "upstream-for-queue", result };
      }
      case "upstream-for-exchange": {
        const input = record.input as UpstreamGraphInput | undefined;
        const target = record.targetExchangeId;
        if (!input) throw new Error("upstream-for-exchange request is missing 'input'.");
        if (typeof target !== "string") {
          throw new Error("upstream-for-exchange request is missing 'targetExchangeId' string.");
        }
        const options = record.options as UpstreamTraversalOptions | undefined;
        const result = upstreamForExchange(input, target, options);
        return { id, status: "ok", kind: "upstream-for-exchange", result };
      }
      default:
        throw new Error(`Unknown request kind '${describe(kind)}'.`);
    }
  } catch (err) {
    return {
      id,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "string") return `'${value}'`;
  if (t === "object" || t === "function") return t;
  return String(value);
}
