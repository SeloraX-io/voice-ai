/**
 * The Embed page: the snippet to paste, and what it needs to work.
 *
 * A server component because the origin comes from the environment, not the
 * browser. `NEXT_PUBLIC_EMBED_ORIGIN` is read here and validated once, so a
 * missing or malformed value is a visible explanation on this page rather than
 * a widget that silently 404s on somebody's site.
 */

import { EmbedSnippet } from "@/components/embed/EmbedSnippet";
import {
  EMBED_ORIGIN_VAR,
  consoleSnippet,
  isSecureContextOrigin,
  normaliseOrigin,
  scriptTagSnippet,
} from "@/lib/embed/snippet";

export const dynamic = "force-dynamic";

export default function EmbedPage() {
  const result = normaliseOrigin(process.env.NEXT_PUBLIC_EMBED_ORIGIN);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">Embed</h1>
        <p className="mt-1.5 text-sm text-[var(--text-muted)]">
          Put the voice agent on any website as a floating call button.
        </p>
      </header>

      {!result.ok ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-5">
          <p className="text-sm font-medium text-[var(--text)]">{result.reason}</p>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            The widget is served from this deployment and injected into another site, so every URL
            it uses has to be absolute — a relative path would resolve against the host page and
            fail. Set the origin this app is reachable at, then restart:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--surface-3)] p-3 text-[13px] text-[var(--text)]">
            <code>{`${EMBED_ORIGIN_VAR}=https://voice.example.com`}</code>
          </pre>
          <p className="mt-3 text-xs text-[var(--text-dim)]">
            It is a bare origin — scheme, host and port, with no path. Being{" "}
            <code>NEXT_PUBLIC_</code>, it is inlined into the browser bundle, which is correct here:
            it is a public address, not a credential.
          </p>
        </div>
      ) : (
        <>
          <EmbedSnippet
            consoleSnippet={consoleSnippet(result.origin)}
            scriptTag={scriptTagSnippet(result.origin)}
            origin={result.origin}
          />

          {!isSecureContextOrigin(result.origin) && (
            <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">
                This origin is plain HTTP, so the microphone will not work.
              </p>
              <p className="mt-1.5 text-sm text-amber-800">
                Browsers only grant <code>getUserMedia</code> in a secure context. Serve the widget
                over HTTPS before embedding it anywhere real. Loopback addresses are exempt, which
                is why local development still works.
              </p>
            </div>
          )}

          <section className="mt-8">
            <h2 className="text-sm font-semibold text-[var(--text)]">What it does</h2>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">
              The snippet adds one element to the page: an iframe served from{" "}
              <code className="text-[var(--text)]">{result.origin}</code>. The button, the audio and
              the gateway connection all live inside it, on this origin — which is what keeps the
              host page&apos;s CSS from reshaping the widget and lets the audio worklet load at all.
            </p>
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-semibold text-[var(--text)]">When it will not work</h2>
            <ul className="mt-2 space-y-2 text-sm leading-relaxed text-[var(--text-muted)]">
              <li>
                <span className="text-[var(--text)]">A restrictive host page.</span> A site sending{" "}
                <code>Permissions-Policy: microphone=()</code> or a <code>frame-src</code> CSP will
                block the widget. Pasting into the console does not bypass this — the policy governs
                the page, not the source of the script.
              </li>
              <li>
                <span className="text-[var(--text)]">An unreachable gateway.</span> The voice
                gateway must be reachable from the visitor&apos;s browser over{" "}
                <code>wss://</code>. A gateway bound to <code>localhost</code> is not.
              </li>
              <li>
                <span className="text-[var(--text)]">Key enforcement.</span> With{" "}
                <code>VOICE_GATEWAY_REQUIRE_KEY</code> on, the widget presents{" "}
                <code>NEXT_PUBLIC_VOICE_GATEWAY_KEY</code>. That key is readable by anyone who loads
                the widget, so give it one of its own that you can revoke separately.
              </li>
            </ul>
          </section>

          <section className="mt-8 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
            <h2 className="text-sm font-semibold text-[var(--text)]">This snippet is public</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-muted)]">
              Anyone who can read it can load the widget from their own page and open a billed
              session on your Gemini key. There is no origin check — the widget answers any site by
              design. Keep that in mind before leaving it on a public page for long.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
