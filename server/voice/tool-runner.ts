/**
 * Runs an HTTP tool the model asked for.
 *
 * This lives in the gateway rather than the browser for one reason: the request
 * may carry a secret. Resolving `{{NAME}}` here means the value is read from
 * disk, put in a header, and sent — it never crosses to the client, which is
 * the whole point of storing secrets separately.
 *
 * Every failure is turned into a result the model can read and speak about. A
 * thrown error would leave the caller in silence while the agent waits for a
 * response that never arrives, which is worse than telling it the lookup failed.
 */

import { bracedParams, type HttpTool } from "../../lib/agent-config/tools";

/** Beyond this a caller is left waiting; better to fail and let the agent say so. */
const TIMEOUT_MS = 10_000;

/** Guard against an endpoint returning something enormous into the context. */
const MAX_RESPONSE_CHARS = 8_000;

const SECRET_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/** What the model receives back. Always an object; never a thrown error. */
export type ToolResult = Record<string, unknown>;

/**
 * Substitutes `{{SECRET}}` references.
 *
 * An unknown reference is left as written rather than replaced with an empty
 * string: sending `Bearer ` reads to the endpoint as a malformed credential,
 * while the literal text makes the misconfiguration obvious in its logs.
 */
function resolveSecretRefs(value: string, secrets: Record<string, string>): string {
  return value.replace(SECRET_RE, (whole, name: string) => secrets[name] ?? whole);
}

/** Fills `{brace}` segments in the URL from the model's arguments. */
function fillPath(url: string, args: Record<string, unknown>): string {
  let filled = url;
  for (const name of bracedParams(url)) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    filled = filled.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
  }
  return filled;
}

/** Arguments not consumed by the path, which therefore travel as query or body. */
function remainingArgs(
  url: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const inPath = new Set(bracedParams(url));
  return Object.fromEntries(Object.entries(args).filter(([key]) => !inPath.has(key)));
}

export async function executeHttpTool(
  tool: HttpTool,
  args: Record<string, unknown>,
  secrets: Record<string, string>,
): Promise<ToolResult> {
  const target = fillPath(tool.url, args);
  const rest = remainingArgs(tool.url, args);

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { error: "The tool's URL is not valid. Tell the caller the lookup is unavailable." };
  }

  const headers: Record<string, string> = {};
  for (const header of tool.headers) {
    if (header.name === "") continue;
    headers[header.name] = resolveSecretRefs(header.value, secrets);
  }

  const sendsBody = tool.method !== "GET";
  if (sendsBody) headers["content-type"] = "application/json";

  // A GET carries its remaining arguments in the query string; anything else
  // sends them as a JSON body, which is what an endpoint expects of a POST.
  if (!sendsBody) {
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: tool.method,
      headers,
      body: sendsBody && Object.keys(rest).length > 0 ? JSON.stringify(rest) : undefined,
      signal: controller.signal,
    });

    const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);

    if (!response.ok) {
      // The status is given to the model deliberately: "not found" and "denied"
      // deserve different things said to the caller.
      return { ok: false, status: response.status, body: text };
    }

    try {
      return { ok: true, status: response.status, data: JSON.parse(text) as unknown };
    } catch {
      return { ok: true, status: response.status, data: text };
    }
  } catch (cause) {
    const timedOut = (cause as Error).name === "AbortError";
    return {
      ok: false,
      error: timedOut
        ? `The request took longer than ${TIMEOUT_MS / 1000} seconds and was given up on.`
        : "The request could not be completed.",
    };
  } finally {
    clearTimeout(timer);
  }
}
