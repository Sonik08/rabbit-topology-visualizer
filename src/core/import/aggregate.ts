import type { BuildIndexesInput } from "../graph/indexes";
import type { ImportResult } from "./importArchive";

/**
 * Flatten an `ImportResult` into a `BuildIndexesInput` — merging every
 * parsed definitions/management-dump file's entities across the whole
 * import. Callers that only care about one host should filter afterwards.
 *
 * Duplicate `id`s across files are dropped on first-seen; `buildTopologyIndexes`
 * already de-dupes by id, but pre-filtering here keeps the returned arrays
 * exactly reflective of what will be indexed.
 */
export function aggregateImportedTopology(result: ImportResult): BuildIndexesInput {
  const seen = new Set<string>();
  const out: BuildIndexesInput = {
    hosts: [],
    vhosts: [],
    exchanges: [],
    queues: [],
    shovels: [],
    federations: [],
    policies: [],
  };

  for (const file of result.files) {
    if (file.parsed) {
      pushUnique(out.hosts, file.parsed.host, seen, `host:${file.parsed.host.id}`);
      for (const v of file.parsed.vhosts) pushUnique(out.vhosts, v, seen, v.id);
      for (const e of file.parsed.exchanges) pushUnique(out.exchanges, e, seen, e.id);
      for (const q of file.parsed.queues) pushUnique(out.queues, q, seen, q.id);
      for (const p of file.parsed.policies) pushUnique(out.policies, p, seen, p.id);
    }
    if (file.runtime) {
      for (const s of file.runtime.shovels) pushUnique(out.shovels, s, seen, s.id);
      for (const f of file.runtime.federations) pushUnique(out.federations, f, seen, f.id);
    }
  }
  return out;
}

function pushUnique<T>(bucket: T[], entity: T, seen: Set<string>, key: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  bucket.push(entity);
}
