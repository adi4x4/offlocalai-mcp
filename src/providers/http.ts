import { OfflocalError } from "../util.js";

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Raw body (string) — already encoded by the caller. */
  body?: string;
  query?: Record<string, string | undefined>;
}

function withQuery(url: string, query?: Record<string, string | undefined>): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

/**
 * Minimal JSON HTTP client built on global fetch (Node 18+). Centralizes error
 * handling so adapters surface clean, agent-readable messages. Never logs
 * secrets; the caller is responsible for not putting tokens in `query`.
 */
export async function httpJson<T = unknown>(
  url: string,
  opts: HttpOptions = {},
): Promise<T> {
  const finalUrl = withQuery(url, opts.query);
  let res: Response;
  try {
    res = await fetch(finalUrl, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OfflocalError(`Network error calling ${finalUrl}: ${message}`);
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const detail =
      typeof parsed === "object" && parsed !== null
        ? JSON.stringify(parsed)
        : String(parsed ?? "");
    throw new OfflocalError(
      `${res.status} ${res.statusText} from ${url}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
    );
  }

  return parsed as T;
}

/** Encode an object as application/x-www-form-urlencoded, incl. bracketed nesting. */
export function formEncode(obj: Record<string, unknown>, prefix?: string): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const field = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object" && !Array.isArray(value)) {
      const nested = formEncode(value as Record<string, unknown>, field);
      if (nested) parts.push(nested);
    } else {
      parts.push(`${encodeURIComponent(field)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join("&");
}
