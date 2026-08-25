export type JsonShape =
  | "definitions"
  | "management-dump-queues"
  | "management-dump-exchanges"
  | "management-dump-bindings"
  | "management-dump-parameters"
  | "management-dump-policies"
  | "management-dump-vhosts"
  | "unknown";

export interface JsonClassification {
  shape: JsonShape;
  /** 0–1 confidence score. */
  confidence: number;
  reasons: string[];
  /** Host name inferred from the file path, when a `hosts/<name>/…` segment is present. */
  hostHint?: string;
  /** Vhost name inferred from the file path, when a `vhosts/<name>/…` segment is present. */
  vhostHint?: string;
}

interface JsonObject {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function basename(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

function pathHints(filePath: string | undefined): {
  hostHint?: string;
  vhostHint?: string;
} {
  if (!filePath) return {};
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  const hints: { hostHint?: string; vhostHint?: string } = {};
  for (let i = 0; i < parts.length - 1; i += 1) {
    const seg = parts[i]!.toLowerCase();
    const next = parts[i + 1]!;
    if ((seg === "hosts" || seg === "host") && hints.hostHint === undefined) {
      hints.hostHint = next;
    }
    if ((seg === "vhosts" || seg === "vhost") && hints.vhostHint === undefined) {
      hints.vhostHint = next;
    }
  }
  return hints;
}

interface FilenameHint {
  shape: Exclude<JsonShape, "definitions" | "unknown"> | "definitions";
  reason: string;
}

function filenameShapeHint(filePath: string | undefined): FilenameHint | undefined {
  if (!filePath) return undefined;
  const base = basename(filePath).toLowerCase();
  if (base === "definitions.json" || base.endsWith(".definitions.json")) {
    return { shape: "definitions", reason: `filename '${base}' matches definitions export` };
  }
  const map: Record<string, JsonShape> = {
    "queues.json": "management-dump-queues",
    "exchanges.json": "management-dump-exchanges",
    "bindings.json": "management-dump-bindings",
    "parameters.json": "management-dump-parameters",
    "policies.json": "management-dump-policies",
    "vhosts.json": "management-dump-vhosts",
  };
  const shape = map[base];
  if (shape) {
    return {
      shape: shape as Exclude<JsonShape, "definitions" | "unknown">,
      reason: `filename '${base}' matches split management dump`,
    };
  }
  return undefined;
}

function looksLikeDefinitions(value: JsonObject): {
  is: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (typeof value.rabbit_version === "string") {
    reasons.push("top-level 'rabbit_version' present");
  }
  if (typeof value.rabbitmq_version === "string") {
    reasons.push("top-level 'rabbitmq_version' present");
  }
  const structuralKeys = [
    "vhosts",
    "exchanges",
    "queues",
    "bindings",
    "parameters",
    "policies",
    "users",
    "permissions",
  ];
  const presentStructural = structuralKeys.filter((k) => Array.isArray(value[k]));
  if (presentStructural.length >= 3) {
    reasons.push(
      `top-level array fields present: ${presentStructural.slice(0, 5).join(", ")}${presentStructural.length > 5 ? "…" : ""}`,
    );
  }
  return {
    is: reasons.length > 0 && (reasons.length >= 2 || presentStructural.length >= 3),
    reasons,
  };
}

interface ArrayShapeScore {
  shape: Exclude<JsonShape, "definitions" | "unknown">;
  score: number;
  reason: string;
}

function scoreArrayShape(items: unknown[]): ArrayShapeScore[] {
  const scores: Record<Exclude<JsonShape, "definitions" | "unknown">, number> = {
    "management-dump-queues": 0,
    "management-dump-exchanges": 0,
    "management-dump-bindings": 0,
    "management-dump-parameters": 0,
    "management-dump-policies": 0,
    "management-dump-vhosts": 0,
  };

  let sampled = 0;
  for (const item of items) {
    if (!isRecord(item)) continue;
    sampled += 1;
    if (sampled > 20) break;

    if (
      typeof item.source === "string" &&
      typeof item.destination === "string" &&
      typeof item.destination_type === "string"
    ) {
      scores["management-dump-bindings"] += 1;
      continue;
    }
    if (
      typeof item.component === "string" &&
      "value" in item &&
      typeof item.name === "string"
    ) {
      scores["management-dump-parameters"] += 1;
      continue;
    }
    if (
      typeof item.pattern === "string" &&
      ("apply-to" in item || "apply_to" in item) &&
      isRecord(item.definition)
    ) {
      scores["management-dump-policies"] += 1;
      continue;
    }
    if (typeof item.type === "string" && typeof item.name === "string") {
      scores["management-dump-exchanges"] += 1;
      continue;
    }
    if (
      typeof item.name === "string" &&
      "vhost" in item &&
      !("type" in item) &&
      !("source" in item) &&
      !("component" in item) &&
      !("pattern" in item)
    ) {
      scores["management-dump-queues"] += 1;
      continue;
    }
    if (typeof item.name === "string" && Object.keys(item).length <= 3) {
      scores["management-dump-vhosts"] += 1;
      continue;
    }
  }

  const total = sampled === 0 ? 1 : sampled;
  return (Object.keys(scores) as Array<keyof typeof scores>)
    .map((shape) => ({
      shape,
      score: scores[shape] / total,
      reason: `${scores[shape]}/${sampled} items look like ${shape}`,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function classifyJson(
  value: unknown,
  filePath?: string,
): JsonClassification {
  const hints = pathHints(filePath);
  const filenameHint = filenameShapeHint(filePath);
  const reasons: string[] = [];

  if (isRecord(value)) {
    if (filenameHint?.shape === "definitions") {
      reasons.push(filenameHint.reason);
    }
    const defCheck = looksLikeDefinitions(value);
    reasons.push(...defCheck.reasons);
    if (defCheck.is || filenameHint?.shape === "definitions") {
      return {
        shape: "definitions",
        confidence: defCheck.is ? 0.95 : 0.7,
        reasons,
        ...hints,
      };
    }
    return {
      shape: "unknown",
      confidence: 0,
      reasons: reasons.length ? reasons : ["object shape did not match any known schema"],
      ...hints,
    };
  }

  if (Array.isArray(value)) {
    const arrayScores = scoreArrayShape(value);
    if (filenameHint && filenameHint.shape !== "definitions") {
      const shape = filenameHint.shape;
      const contentScore = arrayScores.find((s) => s.shape === shape)?.score ?? 0;
      const confidence = value.length === 0 ? 0.6 : Math.min(0.95, 0.55 + contentScore * 0.4);
      const structuralReason =
        value.length === 0
          ? "array is empty; filename hint alone drives classification"
          : arrayScores[0]?.reason ?? "content shape inconclusive";
      return {
        shape,
        confidence,
        reasons: [filenameHint.reason, structuralReason],
        ...hints,
      };
    }
    if (arrayScores.length === 0) {
      return {
        shape: "unknown",
        confidence: 0,
        reasons: ["array contained no items with a recognisable shape"],
        ...hints,
      };
    }
    const [best, second] = arrayScores;
    const gap = best!.score - (second?.score ?? 0);
    if (best!.score < 0.5 || gap < 0.2) {
      return {
        shape: "unknown",
        confidence: best!.score,
        reasons: [`ambiguous array shape: ${arrayScores.map((s) => s.reason).join("; ")}`],
        ...hints,
      };
    }
    return {
      shape: best!.shape,
      confidence: Math.min(0.9, best!.score),
      reasons: [best!.reason],
      ...hints,
    };
  }

  return {
    shape: "unknown",
    confidence: 0,
    reasons: ["value is neither object nor array"],
    ...hints,
  };
}
