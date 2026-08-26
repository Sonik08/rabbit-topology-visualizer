import { describe, expect, it } from "vitest";
import { aggregateImportedTopology } from "../../../src/core/import/aggregate";
import type { ImportResult } from "../../../src/core/import";

function importResult(files: ImportResult["files"]): ImportResult {
  return {
    archiveKind: "json",
    archivePath: "test",
    files,
    diagnostics: [],
  };
}

describe("aggregateImportedTopology", () => {
  it("merges parsed entities across multiple files and de-duplicates by id", () => {
    const parsedA = {
      host: { id: "host:a", name: "a", sourceFiles: [] },
      vhosts: [{ id: "vhost:a:/", hostId: "host:a", name: "/" }],
      exchanges: [{ id: "exchange:a:x1", hostId: "host:a", vhostId: "vhost:a:/", name: "x1", type: "topic" }],
      queues: [{ id: "queue:a:q1", hostId: "host:a", vhostId: "vhost:a:/", name: "q1" }],
      bindings: [],
      policies: [],
      rawParameters: [],
      diagnostics: [],
    };
    const parsedADuplicate = {
      ...parsedA,
      // Same host id + entity ids as parsedA — de-dup guarantees they don't
      // appear twice in the aggregated topology.
      exchanges: parsedA.exchanges,
    };
    const parsedB = {
      host: { id: "host:b", name: "b", sourceFiles: [] },
      vhosts: [{ id: "vhost:b:/", hostId: "host:b", name: "/" }],
      exchanges: [{ id: "exchange:b:x1", hostId: "host:b", vhostId: "vhost:b:/", name: "x1", type: "topic" }],
      queues: [],
      bindings: [],
      policies: [],
      rawParameters: [],
      diagnostics: [],
    };

    const agg = aggregateImportedTopology(
      importResult([
        { path: "a1.json", sizeBytes: 1, kind: "definitions", parsed: parsedA as never },
        { path: "a2.json", sizeBytes: 1, kind: "definitions", parsed: parsedADuplicate as never },
        { path: "b.json", sizeBytes: 1, kind: "definitions", parsed: parsedB as never },
      ]),
    );

    expect(agg.hosts.map((h) => h.id).sort()).toEqual(["host:a", "host:b"]);
    expect(agg.vhosts.map((v) => v.id).sort()).toEqual(["vhost:a:/", "vhost:b:/"]);
    expect(agg.exchanges.map((e) => e.id).sort()).toEqual([
      "exchange:a:x1",
      "exchange:b:x1",
    ]);
    expect(agg.queues.map((q) => q.id)).toEqual(["queue:a:q1"]);
  });

  it("aggregates runtime shovels and federations across files", () => {
    const runtimeA = {
      shovels: [{ id: "shovel:a:s1", hostId: "host:a", vhostId: "vhost:a:/", name: "s1" }],
      federations: [{ id: "fed:a:f1", hostId: "host:a", vhostId: "vhost:a:/", name: "f1" }],
      diagnostics: [],
    };
    const runtimeB = {
      shovels: [{ id: "shovel:b:s2", hostId: "host:b", vhostId: "vhost:b:/", name: "s2" }],
      federations: [],
      diagnostics: [],
    };
    const agg = aggregateImportedTopology(
      importResult([
        {
          path: "a.json",
          sizeBytes: 1,
          kind: "management-dump",
          runtime: runtimeA as never,
        },
        {
          path: "b.json",
          sizeBytes: 1,
          kind: "management-dump",
          runtime: runtimeB as never,
        },
      ]),
    );
    expect(agg.shovels.map((s) => s.id).sort()).toEqual(["shovel:a:s1", "shovel:b:s2"]);
    expect(agg.federations.map((f) => f.id)).toEqual(["fed:a:f1"]);
  });

  it("returns an empty input when no files carry parsed or runtime data", () => {
    const agg = aggregateImportedTopology(
      importResult([{ path: "raw.bin", sizeBytes: 1, kind: "non-json" }]),
    );
    expect(agg).toEqual({
      hosts: [],
      vhosts: [],
      exchanges: [],
      queues: [],
      shovels: [],
      federations: [],
      policies: [],
    });
  });
});
