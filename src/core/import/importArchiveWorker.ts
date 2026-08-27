/// <reference lib="webworker" />
import { handleImportArchiveMessage } from "./importArchiveWorkerMessage";

/**
 * Web Worker entry that offloads the (potentially heavy) parsing + graph
 * building + query pipeline off the main thread for large topologies.
 *
 * Vite bundles this file when it is imported as
 * `new Worker(new URL('./importArchiveWorker.ts', import.meta.url), { type: 'module' })`.
 * See {@link file://./importArchiveWorkerClient.ts} for the recommended client
 * wrapper — no other consumer should import this module directly because it
 * relies on the `DedicatedWorkerGlobalScope` global.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener("message", async (event: MessageEvent<unknown>) => {
  const response = await handleImportArchiveMessage(event.data);
  scope.postMessage(response);
});
