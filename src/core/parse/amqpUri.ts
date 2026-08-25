export interface ParsedAmqpUri {
  scheme: "amqp" | "amqps" | string;
  host?: string;
  port?: number;
  vhost?: string;
  hasCredentials: boolean;
  /** URI with any user info replaced by `REDACTED`. Preserves scheme, host, port, vhost, query, and fragment. */
  redacted: string;
  valid: boolean;
}

const AMQP_SCHEME_RE = /^(amqps?):\/\//i;
const DEFAULT_PORT: Record<"amqp" | "amqps", number> = {
  amqp: 5672,
  amqps: 5671,
};

export function parseAmqpUri(uri: string): ParsedAmqpUri {
  if (typeof uri !== "string" || uri.length === 0) {
    return invalidParsedUri(uri);
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return invalidParsedUri(uri);
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "amqp" && scheme !== "amqps") {
    return invalidParsedUri(uri);
  }

  const host = normalizeHost(parsed.hostname);
  const port = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : DEFAULT_PORT[scheme];

  return {
    scheme,
    host,
    port: Number.isFinite(port) ? port : DEFAULT_PORT[scheme],
    vhost: decodeVhostPath(parsed.pathname),
    hasCredentials: parsed.username.length > 0 || parsed.password.length > 0,
    redacted: redactAmqpUri(uri),
    valid: host !== undefined,
  };
}

export function redactAmqpUri(uri: string): string {
  if (typeof uri !== "string" || uri.length === 0) return uri;

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return redactAmqpUriFallback(uri);
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "amqp" && scheme !== "amqps") return uri;
  if (parsed.username.length === 0 && parsed.password.length === 0) return uri;

  parsed.username = "REDACTED";
  parsed.password = "";
  return parsed.toString();
}

function invalidParsedUri(uri: unknown): ParsedAmqpUri {
  return {
    scheme: "",
    hasCredentials: false,
    redacted: typeof uri === "string" ? redactAmqpUri(uri) : "",
    valid: false,
  };
}

function normalizeHost(hostname: string): string | undefined {
  const stripped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return stripped.length > 0 ? stripped : undefined;
}

function decodeVhostPath(pathname: string): string | undefined {
  if (pathname.length === 0) return undefined;
  const raw = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (raw.length === 0) return "/";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function redactAmqpUriFallback(uri: string): string {
  const schemeMatch = uri.match(AMQP_SCHEME_RE);
  if (!schemeMatch) return uri;
  const remainder = uri.slice(schemeMatch[0].length);
  const atIdx = remainder.lastIndexOf("@");
  if (atIdx < 0) return uri;
  return `${schemeMatch[0]}REDACTED@${remainder.slice(atIdx + 1)}`;
}
