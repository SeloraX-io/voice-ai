"use client";

import { useState } from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { FieldError } from "@/lib/agent-config/validate-helpers";
import type { SipCredentials } from "@/lib/telephony/credentials";

interface CredentialsFormProps {
  credentials: SipCredentials;
  /** Called with the stored values after a successful save. */
  onSaved: (credentials: SipCredentials) => void;
  /** True while the bridge is registered — the line cannot be changed under it. */
  disabled: boolean;
}

interface FieldSpec {
  key: keyof SipCredentials;
  label: string;
  placeholder: string;
  type?: "password";
  description?: string;
}

/**
 * The five values `GET /api/calling/extension` returns on the dashboard, in the
 * order that response lists them, so an operator can paste straight down.
 */
const FIELDS: readonly FieldSpec[] = [
  {
    key: "wsUrl",
    label: "WebSocket URL",
    placeholder: "wss://pbx.example.com:8089/ws",
    description: "SIP signalling only. The call's audio never travels over it.",
  },
  { key: "sipUri", label: "SIP URI", placeholder: "sip:ext-8@pbx.example.com" },
  { key: "sipDomain", label: "SIP domain", placeholder: "pbx.example.com" },
  { key: "extension", label: "Extension", placeholder: "8" },
  {
    key: "password",
    label: "Password",
    placeholder: "",
    type: "password",
    description:
      "SIP digest auth happens in this page, so the password is sent to the browser. Use the AI's own extension, never one a person answers.",
  },
];

/**
 * Where the operator pastes the AI extension's credentials.
 *
 * Validation is not duplicated here: the form posts to `PUT /api/telephony` and
 * renders whatever `validateSipCredentials` rejected, so the browser and the
 * store can never disagree about what a valid line looks like.
 */
export function CredentialsForm({ credentials, onSaved, disabled }: CredentialsFormProps) {
  const [values, setValues] = useState<SipCredentials>(credentials);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = (key: keyof SipCredentials, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    setSaved(false);

    try {
      const response = await fetch("/api/telephony", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const reported = (body as { errors?: FieldError[] } | null)?.errors ?? [];
        setErrors(
          reported.length > 0
            ? Object.fromEntries(reported.map((error) => [error.path, error.message]))
            : { "": "Could not save the credentials." },
        );
        return;
      }

      const stored = body as SipCredentials;
      setValues(stored);
      setSaved(true);
      onSaved(stored);
    } catch {
      setErrors({ "": "Could not reach the server. Is the app still running?" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {FIELDS.map((field) => (
        <Field
          key={field.key}
          label={field.label}
          htmlFor={`sip-${field.key}`}
          description={field.description}
          error={errors[field.key]}
        >
          <Input
            id={`sip-${field.key}`}
            name={field.key}
            type={field.type ?? "text"}
            value={values[field.key]}
            placeholder={field.placeholder}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled || saving}
            onChange={(event) => set(field.key, event.target.value)}
          />
        </Field>
      ))}

      {errors[""] && (
        <p role="alert" className="text-xs font-medium text-[var(--danger)]">
          {errors[""]}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={disabled || saving}>
          {saving ? "Saving…" : "Save credentials"}
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1.5 text-xs text-[var(--success)]">
            <Check className="size-3.5" />
            Saved
          </span>
        )}
        {disabled && (
          <span className="text-xs text-[var(--text-muted)]">
            Go offline to change the line.
          </span>
        )}
      </div>
    </form>
  );
}
