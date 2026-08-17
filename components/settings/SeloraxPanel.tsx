"use client";

import { useState } from "react";
import { AlertTriangle, Check, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { FieldError } from "@/lib/agent-config/validate-helpers";
import { isTokenExpiringSoon, type SeloraxSummary } from "@/lib/selorax/config";

interface SeloraxPanelProps {
  initial: SeloraxSummary;
  /**
   * Computed by the server page from `initial.tokenExpiresAt`, not here: a
   * client component reading the clock during render is what
   * `react-hooks/purity` forbids, and would let the server and browser
   * renders of this same value disagree. Refreshed after a save inside the
   * `save` handler instead, where reading the clock is an event, not a
   * render.
   */
  initialExpiringSoon: boolean;
}

/** Every field this form owns has a slot; a path outside this set is form-level. */
const FIELD_PATHS = new Set(["baseUrl", "authToken", "storeId"]);

function formatExpiry(ms: number | null): string {
  if (ms === null) return "unknown";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function errorsFrom(response: Response): Promise<Record<string, string>> {
  const body: unknown = await response.json().catch(() => null);
  const reported = (body as { errors?: FieldError[] } | null)?.errors ?? [];
  if (reported.length === 0) return { "": "The server refused that." };
  return Object.fromEntries(
    reported.map((error) => [FIELD_PATHS.has(error.path) ? error.path : "", error.message]),
  );
}

/**
 * Where the AI's Selorax connection is configured — the SIP line and TURN
 * servers it claims from `GET /api/telephony/line`, and the token that backs
 * the answered/declined reports that correlate its calls in Selorax.
 *
 * `baseUrl` and `storeId` are always resubmitted, whatever the operator
 * touched: `PUT /api/selorax` reads a blank `authToken` as "keep the existing
 * one" but reads *every* field blank as a deliberate clear. Prefilling from
 * `GET` and always sending what is in the fields is what keeps an edit to just
 * the URL from wiping a 90-day token the operator does not have to hand.
 */
export function SeloraxPanel({ initial, initialExpiringSoon }: SeloraxPanelProps) {
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [storeId, setStoreId] = useState(initial.storeId);
  // Never prefilled with the real token — GET never sends it. Blank means
  // "keep whatever is already saved."
  const [authToken, setAuthToken] = useState("");
  const [hasToken, setHasToken] = useState(initial.hasToken);
  const [tokenExpiresAt, setTokenExpiresAt] = useState(initial.tokenExpiresAt);
  const [expiringSoon, setExpiringSoon] = useState(initialExpiringSoon);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setSaved(false);

    try {
      const response = await fetch("/api/selorax", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        // baseUrl and storeId travel every time, even when only one field was
        // touched — see the module doc for why that matters.
        body: JSON.stringify({ baseUrl, authToken, storeId }),
      });
      if (!response.ok) {
        setErrors(await errorsFrom(response));
        return;
      }
      const summary = (await response.json()) as SeloraxSummary;
      setBaseUrl(summary.baseUrl);
      setStoreId(summary.storeId);
      setHasToken(summary.hasToken);
      setTokenExpiresAt(summary.tokenExpiresAt);
      // Reading the clock here is an event handler, not a render, so it does
      // not carry the purity problem `initialExpiringSoon` was built server
      // side to avoid.
      setExpiringSoon(isTokenExpiringSoon(summary.tokenExpiresAt, Date.now()));
      // The field held whatever was typed, valid or not; once saved there is
      // nothing left to keep in it, and showing it back would look like the
      // stored value when it is only ever the last thing typed.
      setAuthToken("");
      setSaved(true);
    } catch {
      setErrors({ "": "Could not reach the server. Is the app still running?" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-[var(--text)]">Selorax</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          How this bridge reaches SeloraX-Backend for its SIP line, its TURN servers, and the
          reports that let an AI-answered call correlate with Selorax&apos;s own call log.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">
          Use a <strong className="font-semibold text-[var(--text)]">dedicated Selorax user with a
          restricted role</strong>, not a personal admin login. This token is an admin credential —
          the AI only ever needs to place and receive calls, and a leak of a calling-only token
          costs phone calls. A leak of a full admin token costs the order book.
        </p>
      </div>

      <form
        onSubmit={save}
        className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <Field label="Selorax API URL" htmlFor="selorax-base-url" error={errors.baseUrl}>
          <Input
            id="selorax-base-url"
            name="baseUrl"
            value={baseUrl}
            placeholder="https://api.selorax.io"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>

        <Field label="Store id" htmlFor="selorax-store-id" error={errors.storeId}>
          <Input
            id="selorax-store-id"
            name="storeId"
            value={storeId}
            placeholder="42"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setStoreId(event.target.value)}
          />
        </Field>

        <Field
          label="Auth token"
          htmlFor="selorax-auth-token"
          description={
            hasToken
              ? "A token is stored. Leave this blank to keep it — only fill it in to replace it."
              : "No token is stored yet. Paste the x-auth-token from a login as the dedicated AI user."
          }
          error={errors.authToken}
        >
          <Input
            id="selorax-auth-token"
            name="authToken"
            type="password"
            value={authToken}
            placeholder={hasToken ? "Unchanged" : "Paste the x-auth-token"}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setAuthToken(event.target.value)}
          />
        </Field>

        {hasToken && (
          <div
            className={
              "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs " +
              (expiringSoon
                ? "border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)]"
                : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]")
            }
          >
            {expiringSoon && <AlertTriangle className="size-3.5 shrink-0" />}
            <span>
              Expires {formatExpiry(tokenExpiresAt)}
              {expiringSoon &&
                " — this token lapses within 14 days and will not warn again on its own. Log in as the AI user and paste a fresh one."}
            </span>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          {saved && !busy && (
            <span className="flex items-center gap-1 text-xs font-medium text-[var(--success)]">
              <Check className="size-3.5" />
              Saved
            </span>
          )}
        </div>

        {errors[""] && (
          <p role="alert" className="text-xs font-medium text-[var(--danger)]">
            {errors[""]}
          </p>
        )}
      </form>

      <div className="flex flex-col gap-2 text-xs leading-relaxed text-[var(--text-dim)]">
        <p>
          Clearing every field and saving is a deliberate reset — it wipes the stored token along
          with the URL and store id. Editing just one field never touches the others.
        </p>
        <p>
          Selorax cannot tell which extension answered an inbound call from its own webhook alone,
          so <code className="font-mono">POST /api/telephony/report</code> is what tells it — fired
          the instant this bridge answers or declines, never awaited before the call itself.
        </p>
      </div>
    </div>
  );
}
