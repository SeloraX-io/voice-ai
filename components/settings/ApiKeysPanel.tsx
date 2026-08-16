"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { FieldError } from "@/lib/agent-config/validate-helpers";
import type { ApiKeySummary } from "@/lib/api-keys/types";

interface ApiKeysPanelProps {
  initialKeys: ApiKeySummary[];
}

function formatDate(iso: string | null): string {
  if (iso === null) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function errorsFrom(response: Response): Promise<Record<string, string>> {
  const body: unknown = await response.json().catch(() => null);
  const reported = (body as { errors?: FieldError[] } | null)?.errors ?? [];
  if (reported.length === 0) return { "": "The server refused that." };
  return Object.fromEntries(reported.map((error) => [error.path, error.message]));
}

/**
 * Where keys are minted and revoked.
 *
 * A minted key is shown once, in a banner that stays until it is dismissed:
 * the store keeps only a hash, so there is no second chance and the copy is the
 * user's only one. Revoking is immediate and needs no confirmation dialogue —
 * a key is cheap to replace, and the row says plainly what it does.
 */
export function ApiKeysPanel({ initialKeys }: ApiKeysPanelProps) {
  const [keys, setKeys] = useState<ApiKeySummary[]>(initialKeys);
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const mint = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setMinted(null);
    setCopied(false);

    try {
      const response = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        setErrors(await errorsFrom(response));
        return;
      }
      const body = (await response.json()) as { key: string; keys: ApiKeySummary[] };
      setMinted({ name: name.trim(), key: body.key });
      setKeys(body.keys);
      setName("");
    } catch {
      setErrors({ "": "Could not reach the server. Is the app still running?" });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (key: ApiKeySummary) => {
    setBusy(true);
    setErrors({});
    try {
      const response = await fetch(`/api/api-keys?id=${encodeURIComponent(key.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        setErrors(await errorsFrom(response));
        return;
      }
      const body = (await response.json()) as { keys: ApiKeySummary[] };
      setKeys(body.keys);
    } catch {
      setErrors({ "": "Could not reach the server. Is the app still running?" });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.key);
      setCopied(true);
      // A plain timeout in the handler rather than an effect: this only fades a
      // label back, and nothing else depends on it.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErrors({ "": "The browser would not copy it. Select the key and copy it by hand." });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-[var(--text)]">API Keys</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Every connection to the voice gateway opens a billed AI session. A key is what separates a
          client of this service from anyone who can reach the port.
        </p>
      </div>

      {minted && (
        <div className="animate-fade-rise rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            <KeyRound className="size-4 text-[var(--accent)]" />
            {minted.name}
          </p>
          <p className="mt-1 text-xs font-medium text-[var(--danger)]">
            This is the only time this key will be shown. Copy it now — it cannot be recovered, only
            replaced.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="scroll-slim min-w-0 flex-1 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-xs text-[var(--text)]">
              {minted.key}
            </code>
            <div className="flex items-center gap-2">
              <Button type="button" variant="primary" size="sm" onClick={copy}>
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setMinted(null)}>
                Done
              </Button>
            </div>
          </div>
        </div>
      )}

      <form onSubmit={mint} className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <Field
          label="Mint a key"
          htmlFor="api-key-name"
          description="Name it after whatever will use it, so you know what you are revoking later."
          error={errors.name}
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="api-key-name"
              name="name"
              value={name}
              placeholder="Softphone bridge"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" variant="primary" disabled={busy || name.trim() === ""}>
              {busy ? "Working…" : "Mint key"}
            </Button>
          </div>
        </Field>

        {errors[""] && (
          <p role="alert" className="text-xs font-medium text-[var(--danger)]">
            {errors[""]}
          </p>
        )}
      </form>

      {keys.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
          No keys yet. The gateway only demands one when{" "}
          <code className="font-mono">VOICE_GATEWAY_REQUIRE_KEY=1</code> is set.
        </p>
      ) : (
        <div className="scroll-slim overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]">
                <Th>Name</Th>
                <Th>Key</Th>
                <Th>Created</Th>
                <Th>Last used</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr
                  key={key.id}
                  className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                >
                  <Td>
                    <span className="font-medium text-[var(--text)]">{key.name}</span>
                  </Td>
                  <Td>
                    {/* A fingerprint, not the key: the first few characters of
                        its hash, which names it without being usable. */}
                    <span className="font-mono text-xs text-[var(--text-dim)]">
                      {key.fingerprint}…
                    </span>
                  </Td>
                  <Td>{formatDate(key.createdAt)}</Td>
                  <Td>{formatDate(key.lastUsedAt)}</Td>
                  <Td>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Revoke ${key.name}`}
                      className="text-[var(--danger)] hover:bg-[var(--surface-3)] hover:text-[var(--danger)]"
                      onClick={() => void revoke(key)}
                    >
                      <Trash2 />
                      Revoke
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-col gap-2 text-xs leading-relaxed text-[var(--text-dim)]">
        <p>
          A client presents its key as{" "}
          <code className="font-mono">Authorization: Bearer &lt;key&gt;</code> or, where headers
          cannot be set — a browser <code className="font-mono">WebSocket</code>, which is what the
          softphone bridge is — as a <code className="font-mono">?key=</code> parameter on the
          gateway URL.
        </p>
        <p>
          Keys are only demanded when the gateway runs with{" "}
          <code className="font-mono">VOICE_GATEWAY_REQUIRE_KEY=1</code>; it is off by default so a
          fresh checkout runs with no setup. Revoking takes effect on the next connection — a call
          already in progress is left to finish.
        </p>
        <p>
          Only a hash is stored, in <code className="font-mono">data/api-keys.json</code>. A lost key
          is re-minted, never recovered.
        </p>
      </div>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold text-[var(--text-muted)]"
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3 align-middle text-[var(--text-muted)]">{children}</td>;
}
