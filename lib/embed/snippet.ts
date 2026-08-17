/**
 * The embed snippet, and the origin it points at.
 *
 * The widget is served from THIS deployment and injected into somebody else's
 * page, so every URL it uses has to be absolute. A relative path would resolve
 * against the host site and 404 — that is the single most common way an embed
 * breaks, and it is why the origin is configuration rather than a guess.
 *
 * Kept free of React so it can be unit tested and imported from a route
 * handler, the console page, or a script.
 */

/** Where the widget is served from, e.g. "https://voice.example.com". */
export const EMBED_ORIGIN_VAR = "NEXT_PUBLIC_EMBED_ORIGIN";

export type OriginResult =
  | { ok: true; origin: string }
  | { ok: false; reason: string };

/**
 * Validates and normalises a deploy origin.
 *
 * Demands http/https and no path, because the value is concatenated into
 * script and iframe URLs. A trailing slash is trimmed rather than rejected:
 * it is the likeliest way to type this by hand and it has one obvious meaning.
 *
 * https is not *required* — a plain-http origin is legitimate on localhost
 * during development — but `describeSecurity` flags it, because microphone
 * capture needs a secure context and will fail on a deployed http origin.
 */
export function normaliseOrigin(value: string | undefined | null): OriginResult {
  const raw = (value ?? "").trim();
  if (raw === "") {
    return { ok: false, reason: `${EMBED_ORIGIN_VAR} is not set.` };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `${EMBED_ORIGIN_VAR} is not a valid URL.` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `${EMBED_ORIGIN_VAR} must start with http:// or https://.` };
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return {
      ok: false,
      reason: `${EMBED_ORIGIN_VAR} must be a bare origin, with no path or query.`,
    };
  }

  return { ok: true, origin: url.origin };
}

/** True for origins where `getUserMedia` will work: https, or a loopback host. */
export function isSecureContextOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/**
 * The one-liner to paste into a browser console, or drop in a <script> tag.
 *
 * Deliberately a loader rather than the widget itself: the real code lives at
 * /embed.js on this origin, so fixing a bug there fixes every page that has
 * already pasted this, with nobody re-copying anything.
 */
export function consoleSnippet(origin: string): string {
  return `(function(){var s=document.createElement('script');s.src='${origin}/embed.js';s.async=true;document.body.appendChild(s);})()`;
}

/** The same loader as a tag, for embedding in a page's HTML properly. */
export function scriptTagSnippet(origin: string): string {
  return `<script src="${origin}/embed.js" async></script>`;
}
