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
  | "session_required"
  | "extension_not_active"
  | "calling_disabled"
  | "unreachable"
  | "timeout"
  | "request_failed";

export class SeloraxError extends Error {
  readonly code: SeloraxErrorCode;
  /**
   * The `name` of whatever was thrown underneath, e.g. "TypeError" — never
   * the thrown error itself. The original error can carry request internals
   * (or, transitively, the token) into its own `.message`; attaching it as
   * `cause` would let `console.log`/`util.inspect` print that. A name is
   * enough to tell a timeout from a DNS failure without that risk.
   */
  readonly underlying?: string;

  constructor(code: SeloraxErrorCode, message: string, underlying?: string) {
    super(message);
    this.name = "SeloraxError";
    this.code = code;
    this.underlying = underlying;
  }
}

export type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface CallingClient {
  getLine(): Promise<SeloraxLine>;
  reportAnswered(callerPhone: string): Promise<void>;
  reportDeclined(callerPhone: string): Promise<void>;
}

// Plain-language messages for the causes Selorax may report on the extension
// endpoint. The reader is an operator, not a Selorax developer — "Selorax
// reported: extension_not_active." is a machine code, not an answer; these say
// what to actually go do, the same way the 401 branch below does. Anything
// else collapses to "request_failed" so this map is not a promise about every
// code Selorax could ever add.
const CAUSE_MESSAGES: Readonly<Record<string, string>> = {
  extension_not_active:
    "The AI user needs an extension in Selorax — none is currently active. Provision one for it in Selorax.",
  calling_disabled:
    "Calling is disabled for the AI user in Selorax. Ask an operator to enable it.",
  // Deliberately says nothing about expiry. Selorax returns this when a
  // request lands on the store-switching path, which wants a registered
  // dashboard session — the token can be perfectly valid and still get it.
  // Reading it as "expired" once sent an operator off to reissue a token with
  // 89 days left on it; see the `x-store-id` note in `headers()` below.
  session_required:
    "Selorax rejected the request as having no signed-in session. This is a bridge bug, not an expired token — the request carried a header that put it on Selorax's store-switching path.",
};

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

  if (parsedCode && parsedCode in CAUSE_MESSAGES) {
    return new SeloraxError(parsedCode as SeloraxErrorCode, CAUSE_MESSAGES[parsedCode]);
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

  const name = cause instanceof Error ? cause.name : undefined;

  // AbortSignal.timeout() aborts the fetch with a DOMException named
  // "TimeoutError" — distinct from a generic connection failure, and worth
  // its own code so a hung backend reads as "timed out", not "broke".
  if (name === "TimeoutError") {
    return new SeloraxError(
      "timeout",
      `The Selorax calling API did not respond within ${TIMEOUT_MS / 1000} seconds.`,
      name,
    );
  }

  if (cause instanceof TypeError) {
    return new SeloraxError("unreachable", "Could not reach the Selorax calling API.", name);
  }

  return new SeloraxError("request_failed", "The Selorax calling API request failed.", name);
}

function toIceServers(value: unknown): SeloraxIceServer[] {
  return Array.isArray(value) ? (value as SeloraxIceServer[]) : [];
}

export function createCallingClient(
  config: SeloraxConfig,
  fetchImpl: FetchImpl = fetch,
): CallingClient {
  const deviceId = deviceIdFor(config.storeId);

  /**
   * Identity for a calling request: the token, and the device the claim is
   * made for.
   *
   * **No `x-store-id`.** The design called for one, and it was wrong. Selorax
   * treats that header as "act on this store", a path that requires a
   * registered dashboard session; a headless bridge has none, so every request
   * came back 401 `session_required` — including ones whose `x-store-id`
   * exactly matched the `store_id` claim inside the token. Verified against
   * the live API: token alone → 200, token + any non-empty `x-store-id` → 401.
   *
   * The store is not lost by dropping it. It is a claim in the token, which is
   * what scopes the request; `config.storeId` still names the device via
   * `deviceIdFor`.
   */
  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "x-auth-token": config.authToken,
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
