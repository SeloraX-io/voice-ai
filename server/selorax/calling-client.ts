/**
 * The HTTP client for SeloraX-Backend's calling API.
 *
 * This is how the bridge claims its SIP line and reports inbound-call
 * outcomes, using the AI user's admin token instead of hand-pasted SIP
 * credentials. See `lib/selorax/config.ts` for what that token is and why it
 * never leaves the server.
 *
 * Error mapping is the point of this module, not an afterthought: a raw 401
 * ninety days from now is an unstartable support ticket, while
 * `code: "token_expired"` is a five-second fix. The token itself must never
 * appear in anything this module returns — not the message, not a log line.
 */

import { deviceIdFor, type SeloraxConfig } from "../../lib/selorax/config";

const TIMEOUT_MS = 10_000;

export interface SeloraxIceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export interface SeloraxLine {
  wsUrl: string;
  sipUri: string;
  sipDomain: string;
  extension: string;
  password: string;
  iceServers: SeloraxIceServer[];
}

export type SeloraxErrorCode =
  | "token_expired"
  | "extension_not_active"
  | "calling_disabled"
  | "unreachable"
  | "request_failed";

export class SeloraxError extends Error {
  readonly code: SeloraxErrorCode;

  constructor(code: SeloraxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SeloraxError";
    this.code = code;
  }
}

export type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface CallingClient {
  getLine(): Promise<SeloraxLine>;
  reportAnswered(callerPhone: string): Promise<void>;
  reportDeclined(callerPhone: string): Promise<void>;
}

// The passed-through causes Selorax may report on the extension endpoint.
// Anything else collapses to "request_failed" so this list is not a promise
// about every code Selorax could ever add.
const KNOWN_CAUSES: ReadonlySet<string> = new Set(["extension_not_active", "calling_disabled"]);

/**
 * Turn a non-OK response into a SeloraxError without ever quoting the raw
 * body back — Selorax's own error copy could itself echo request headers.
 */
async function toResponseError(response: Response): Promise<SeloraxError> {
  let parsedCode: string | undefined;
  try {
    const body: unknown = await response.json();
    const code = (body as { code?: unknown })?.code;
    if (typeof code === "string") parsedCode = code;
  } catch {
    // Body was not JSON, or was empty — fall through to a status-based cause.
  }

  if (parsedCode && KNOWN_CAUSES.has(parsedCode)) {
    return new SeloraxError(parsedCode as SeloraxErrorCode, `Selorax reported: ${parsedCode}.`);
  }

  if (response.status === 401) {
    return new SeloraxError(
      "token_expired",
      "The Selorax auth token was rejected. It has likely expired — issue a new one for the AI user.",
    );
  }

  return new SeloraxError(
    "request_failed",
    `The Selorax calling API returned an error (status ${response.status}).`,
  );
}

function toClientError(cause: unknown): SeloraxError {
  if (cause instanceof SeloraxError) return cause;
  if (cause instanceof TypeError) {
    return new SeloraxError("unreachable", "Could not reach the Selorax calling API.", { cause });
  }
  return new SeloraxError("request_failed", "The Selorax calling API request failed.", { cause });
}

function toIceServers(value: unknown): SeloraxIceServer[] {
  return Array.isArray(value) ? (value as SeloraxIceServer[]) : [];
}

export function createCallingClient(
  config: SeloraxConfig,
  fetchImpl: FetchImpl = fetch,
): CallingClient {
  const deviceId = deviceIdFor(config.storeId);

  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "x-auth-token": config.authToken,
      "x-store-id": config.storeId,
      "x-device-id": deviceId,
      ...extra,
    };
  }

  async function request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw toClientError(cause);
    }

    if (!response.ok) throw await toResponseError(response);

    try {
      return await response.json();
    } catch (cause) {
      throw toClientError(cause);
    }
  }

  return {
    async getLine(): Promise<SeloraxLine> {
      const body = (await request("/api/calling/extension", {
        method: "GET",
        headers: headers(),
      })) as { data?: Record<string, unknown> };

      const data = body?.data ?? {};
      return {
        wsUrl: String(data.ws_url ?? ""),
        sipUri: String(data.sip_uri ?? ""),
        sipDomain: String(data.sip_domain ?? ""),
        extension: String(data.extension ?? ""),
        password: String(data.password ?? ""),
        iceServers: toIceServers(data.iceServers),
      };
    },

    async reportAnswered(callerPhone: string): Promise<void> {
      await request("/api/calling/inbound-answered", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ caller_phone: callerPhone }),
      });
    },

    async reportDeclined(callerPhone: string): Promise<void> {
      await request("/api/calling/inbound-declined", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ caller_phone: callerPhone }),
      });
    },
  };
}
