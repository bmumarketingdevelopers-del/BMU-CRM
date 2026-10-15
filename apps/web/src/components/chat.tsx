"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ThreadAttachment, ThreadMessage, ThreadView } from "@bmu/shared";
import { Button } from "@/components/ui";
import { when } from "@/components/request-bits";

const size = (b: number | null) => (b === null ? "" : b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/**
 * Client ↔ Client Manager conversation. Internal notes show only on the team side.
 * Refreshes itself every 15 seconds (pass `onRefresh`) so new replies appear without reloading the page.
 */
export function Chat({
  thread,
  allowInternal = false,
  onSend,
  onRefresh,
  onUpload,
  draft,
  messageMenu,
}: {
  thread: ThreadView;
  allowInternal?: boolean;
  onSend: (body: string, internal: boolean, attachmentIds: string[]) => Promise<void>;
  onRefresh?: () => Promise<void>;
  onUpload?: (file: File) => Promise<ThreadAttachment>;
  /** Text to put in the message box (e.g. an AI suggested reply); bump `n` to insert again. */
  draft?: { n: number; text: string };
  /** v11: a "⋯" menu per message (team side: "Create task"). */
  messageMenu?: (m: ThreadMessage) => ReactNode;
}) {
  const [body, setBody] = useState("");
  const [draftSeen, setDraftSeen] = useState(0);
  if (draft && draft.n !== draftSeen) {
    setDraftSeen(draft.n);
    setBody(draft.text);
  }
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [files, setFiles] = useState<ThreadAttachment[]>([]);
  const [error, setError] = useState<string>();
  const end = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const refresh = useRef(onRefresh);
  useEffect(() => {
    refresh.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [thread.messages.length]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh.current?.().catch(() => {});
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  async function attach(list: FileList | null) {
    if (!list?.length || !onUpload) return;
    setUploading(true);
    setError(undefined);
    try {
      for (const f of Array.from(list).slice(0, 5 - files.length)) {
        if (f.size > 25 * 1024 * 1024) throw new Error(`${f.name} is larger than 25 MB`);
        const a = await onUpload(f);
        setFiles((x) => [...x, a]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (picker.current) picker.current.value = "";
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() && !files.length) {
      setError("Write a message or attach a file");
      return;
    }
    setBusy(true);
    setError(undefined);
    // Clear straight away so anything typed while sending is kept; put the text back if sending fails.
    const text = body;
    const attached = files;
    setBody("");
    setFiles([]);
    try {
      await onSend(text, internal, attached.map((f) => f.id));
      setInternal(false);
    } catch (err) {
      setBody((b) => b || text);
      setFiles(attached);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col border border-border bg-surface-raised">
      <div className="max-h-[60vh] min-h-64 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {thread.messages.map((m) => (
          <div key={m.id} className={`flex ${m.mine ? "justify-end" : "justify-start"}`} data-testid="chat-message">
            <div
              className={`max-w-[85%] px-3 py-2 text-sm sm:max-w-[80%] ${
                m.internal ? "border border-dashed border-amber bg-amber/10" : m.mine ? "bg-charcoal text-ivory" : m.isClient ? "bg-green/15" : "bg-canvas text-charcoal"
              }`}
            >
              {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
              {!!m.attachments?.length && (
                <ul className="mt-1.5 space-y-1">
                  {m.attachments.map((a) => (
                    <li key={a.id}>
                      {a.mimeType?.startsWith("image/") ? (
                        <a href={a.url} target="_blank" rel="noreferrer" className="block">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={a.url} alt={a.name} className="max-h-48 max-w-full border border-border" />
                        </a>
                      ) : (
                        <a href={`${a.url}?download=1`} className={`underline ${m.mine && !m.internal ? "text-ivory" : ""}`}>
                          📎 {a.name} <span className="text-[11px] opacity-70">{size(a.sizeBytes)}</span>
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className={`mt-1 text-[11px] ${m.mine && !m.internal ? "text-grey" : "text-ink-muted"}`}>
                {m.internal && "🔒 Internal · "}
                {m.author} · {when.format(new Date(m.at))}
                {messageMenu?.(m)}
              </div>
            </div>
          </div>
        ))}
        {thread.messages.length === 0 && <p className="text-center text-sm text-ink-muted">No messages yet. Say hello.</p>}
        <div ref={end} />
      </div>
      <form onSubmit={submit} className="grid gap-2 border-t border-border p-3">
        <textarea
          className="w-full border border-border bg-surface px-3 py-2 text-sm"
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={internal ? "Internal note for the team" : "Write a message"}
          aria-label="Message"
        />
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2 text-xs">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-1 border border-border bg-canvas/50 px-2 py-1">
                📎 {f.name}
                <button type="button" className="ml-1 text-ink-muted hover:text-red" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || uploading}>
            {busy ? "Sending…" : "Send"}
          </Button>
          {onUpload && (
            <>
              <input ref={picker} type="file" multiple className="hidden" onChange={(e) => attach(e.target.files)} aria-label="Attach files" data-testid="chat-file" />
              <Button type="button" variant="secondary" disabled={uploading || files.length >= 5} onClick={() => picker.current?.click()}>
                {uploading ? "Uploading…" : "Attach file"}
              </Button>
            </>
          )}
          {allowInternal && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> 🔒 Internal note (client never sees it)
            </label>
          )}
          {error && <span className="text-sm text-red">{error}</span>}
        </div>
      </form>
    </div>
  );
}
