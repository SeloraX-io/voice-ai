"use client";

/**
 * The client switcher at the top of the sidebar.
 *
 * Switching re-renders the whole console under the chosen client — the layout
 * keys the config provider by client id — so unsaved edits do not survive it.
 * That is why a dirty configuration prompts before the switch, with the same
 * wording the navigation guard uses.
 */

import { useState } from "react";
import { Check, ChevronsUpDown, Pencil, Plus, Trash2 } from "lucide-react";

import { useAgentConfig } from "@/components/agent-config/AgentConfigProvider";
import { useClients } from "@/components/shell/ClientProvider";
import { Button } from "@/components/ui/button";
import { Dropdown } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { CLIENT_NAME_MAX } from "@/lib/clients/types";
import { cn } from "@/lib/utils";

type Editing =
  | { mode: "create" }
  | { mode: "rename"; id: string; currentName: string }
  | null;

export function ClientSwitcher() {
  const { clients, activeClient, pending, switchTo, createClient, renameClient, deleteClient } =
    useClients();
  const { dirty } = useAgentConfig();

  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirmDiscard = () =>
    !dirty ||
    window.confirm(
      "You have unsaved changes to the agent configuration.\n\n" +
        "Switching clients discards them. Switch anyway?",
    );

  const openCreate = () => {
    setName("");
    setError(null);
    setEditing({ mode: "create" });
  };

  const openRename = () => {
    setName(activeClient.name);
    setError(null);
    setEditing({ mode: "rename", id: activeClient.id, currentName: activeClient.name });
  };

  const submit = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const failure =
        editing.mode === "create" ? await createClient(name) : await renameClient(editing.id, name);
      if (failure) {
        setError(failure);
        return;
      }
      setEditing(null);
    } finally {
      setBusy(false);
    }
  };

  const removeActive = async () => {
    const confirmed = window.confirm(
      `Delete the client "${activeClient.name}"?\n\n` +
        "Its agent configuration and secrets are deleted with it. " +
        "Call history is kept. This cannot be undone.",
    );
    if (!confirmed) return;
    const failure = await deleteClient(activeClient.id);
    if (failure) window.alert(failure);
  };

  return (
    <>
      <Dropdown
        align="left"
        className="w-56"
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={`Client: ${activeClient.name}. Switch client`}
            className={cn(
              "mb-3 flex w-full items-center gap-2 rounded-lg border border-[var(--border)]",
              "bg-[var(--surface-2)] px-3 py-2 text-left transition-colors",
              "hover:bg-[var(--surface-3)]",
              pending && "opacity-60",
            )}
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[var(--accent)] text-[11px] font-semibold uppercase text-[var(--accent-contrast)]">
              {activeClient.name.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[var(--text)]">
                {activeClient.name}
              </span>
              <span className="block text-[11px] text-[var(--text-dim)]">Client</span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-[var(--text-dim)]" />
          </button>
        )}
      >
        {({ close }) => (
          <div className="flex max-h-80 flex-col">
            <div className="scroll-slim overflow-y-auto">
              {clients.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => {
                    if (client.id !== activeClient.id && !confirmDiscard()) return;
                    close();
                    switchTo(client.id);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                    client.id === activeClient.id
                      ? "bg-[var(--surface-3)] font-medium text-[var(--text)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{client.name}</span>
                  {client.id === activeClient.id && <Check className="size-3.5 shrink-0" />}
                </button>
              ))}
            </div>

            <div className="mt-1 border-t border-[var(--border)] pt-1">
              <button
                type="button"
                onClick={() => {
                  close();
                  openCreate();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                <Plus className="size-3.5" />
                New client
              </button>
              <button
                type="button"
                onClick={() => {
                  close();
                  openRename();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                <Pencil className="size-3.5" />
                Rename “{activeClient.name}”
              </button>
              {clients.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    void removeActive();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-[var(--surface-2)]"
                >
                  <Trash2 className="size-3.5" />
                  Delete “{activeClient.name}”
                </button>
              )}
            </div>
          </div>
        )}
      </Dropdown>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.mode === "rename" ? "Rename client" : "New client"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={busy || name.trim() === ""}>
              {editing?.mode === "rename" ? "Rename" : "Create"}
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--text)]">
          Client name
          <Input
            value={name}
            maxLength={CLIENT_NAME_MAX}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && name.trim() !== "" && !busy) void submit();
            }}
            placeholder="Acme Dental"
          />
        </label>
        {editing?.mode === "create" && (
          <p className="text-sm text-[var(--text-muted)]">
            Each client gets its own agent configuration, secrets, call history and embed snippet.
          </p>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </Modal>
    </>
  );
}
