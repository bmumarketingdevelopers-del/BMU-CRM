"use client";

// Small helpers shared by the Operations and Platform pages of the Command Centre.
import { Fragment, useState, type ReactNode } from "react";
import type { AdminPlatformSection, SettingsValue, SettingsView } from "@bmu/shared";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export type Msg = { ok: boolean; text: string } | undefined;

/** Loads all settings plus what the signed-in user may change. */
export function useSettingsAndAccess() {
  return useLoad(() => Promise.all([api.settings.all(), api.adminPlatform.access()]).then(([settings, access]) => ({ settings, access })));
}

/** Save state for one settings section through the role-checked Command Centre endpoint. */
export function useSaver<S extends AdminPlatformSection>(section: S, onSaved?: (s: SettingsView) => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>();
  async function save(value: SettingsValue<S>) {
    setBusy(true);
    setMsg(undefined);
    try {
      const s = await api.adminPlatform.saveSetting(section, value);
      onSaved?.(s);
      setMsg({ ok: true, text: "Saved. The change is recorded in the audit log." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return { busy, msg, setMsg, save };
}

export function Message({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <p className={`border px-3 py-2 text-sm ${msg.ok ? "border-green bg-green/10" : "border-red bg-red/10"}`}>{msg.text}</p>;
}

export function ReadOnlyNote({ who }: { who: "operations" | "platform" }) {
  return (
    <p className="mb-6 border border-border bg-canvas/60 px-4 py-3 text-sm text-ink-muted">
      You can view these settings. {who === "platform" ? "Only the Founder or a Branch Manager can change them." : "Only the Founder, a Branch Manager or a department head can change them."}
    </p>
  );
}

/** Labelled form field. */
export function Field({ label, hint, children, className = "" }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-muted">{hint}</span>}
    </label>
  );
}

export function Textarea({ className = "", ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`w-full border border-border bg-surface-raised px-3 py-2 text-sm leading-relaxed ${className}`} {...props} />;
}

/** Save bar shown under a settings form. */
export function SaveBar({ busy, dirty, disabled, onSave, onReset, msg }: { busy: boolean; dirty: boolean; disabled?: boolean; onSave: () => void; onReset?: () => void; msg: Msg }) {
  return (
    <div className="mt-6 space-y-3">
      <Message msg={msg} />
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy || !dirty || disabled} onClick={onSave}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
        {onReset && dirty && (
          <Button variant="ghost" disabled={busy} onClick={onReset}>
            Discard changes
          </Button>
        )}
        {dirty && <span className="text-xs text-ink-muted">You have unsaved changes.</span>}
      </div>
    </div>
  );
}

const inline = (text: string) =>
  text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>));

/** Renders the SOP's plain-text body: "# " / "## " headings, "- " bullets, "1. " steps, blank-line paragraphs. */
export function PlainDoc({ body }: { body: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length} className="text-sm leading-relaxed">{inline(para.join(" "))}</p>);
    para = [];
    if (list) {
      const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>);
      blocks.push(
        list.ordered ? (
          <ol key={blocks.length} className="list-decimal space-y-1 pl-5 text-sm leading-relaxed marker:text-ink-muted">{items}</ol>
        ) : (
          <ul key={blocks.length} className="list-disc space-y-1 pl-5 text-sm leading-relaxed marker:text-ink-muted">{items}</ul>
        ),
      );
    }
    list = null;
  };
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const step = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const cls = h[1].length === 1 ? "font-display text-xl" : h[1].length === 2 ? "pt-2 text-[15px] font-semibold tracking-tight" : "text-sm font-semibold";
      blocks.push(<p key={blocks.length} className={cls}>{inline(h[2])}</p>);
    } else if (bullet || step) {
      const ordered = !!step;
      if (para.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? step)![1]);
    } else if (!line.trim()) {
      flush();
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return <div className="space-y-3">{blocks}</div>;
}
