"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AiChatMessage, AiConversationSummary } from "@bmu/shared";
import { api } from "@/lib/api";
import { aiStream, useAiStatus } from "@/lib/ai";
import { AiNotice } from "./ai-panel";
import { AiText } from "./ai-text";

const STAFF_EXAMPLES = ["Which clients are at risk this month and why?", "How much is overdue from Metro Dental?", "What is Meera working on?", "Summary of the week"];
const CLIENT_EXAMPLES = ["What is waiting for my approval?", "Do I have any invoices due?", "What is the status of my requests?"];

/** Ask BMU: a side panel opened with the button or Ctrl/Cmd + J. Staff ask about the CRM; clients about their own account. */
export function Copilot({ audience }: { audience: "staff" | "client" }) {
  const status = useAiStatus();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [question, setQuestion] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [history, setHistory] = useState<AiConversationSummary[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const enabled = !!status && (audience === "client" ? status.features.clientPortal : status.features.copilot);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, working]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await api.ai.conversations());
    } catch {
      setHistory([]);
    }
  }, []);

  async function openConversation(id: string) {
    try {
      const c = await api.ai.conversation(id);
      setConversationId(c.id);
      setMessages(c.messages);
      setShowHistory(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function ask(q: string) {
    const text = q.trim();
    if (text.length < 2 || working) return;
    setError(undefined);
    setQuestion("");
    const at = new Date().toISOString();
    setMessages((m) => [...m, { role: "user", text, citations: [], at }, { role: "assistant", text: "", citations: [], at }]);
    setWorking("Thinking…");
    let streamed = "";
    const patchLast = (p: Partial<AiChatMessage>) => setMessages((m) => [...m.slice(0, -1), { ...m[m.length - 1], ...p }]);
    try {
      const r = await aiStream(audience === "client" ? "/ai/client/ask/stream" : "/ai/ask/stream", { question: text, conversationId }, (e) => {
        if (e.t === "delta") {
          streamed += e.text;
          patchLast({ text: streamed });
          setWorking(null);
        } else if (e.t === "status") setWorking(e.text);
      });
      setConversationId(r.conversationId);
      patchLast({ text: r.text, citations: r.citations, mode: r.mode, notice: r.notice });
    } catch (e) {
      setMessages((m) => m.slice(0, -1));
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  }

  if (!enabled) return null;
  const examples = audience === "client" ? CLIENT_EXAMPLES : STAFF_EXAMPLES;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed right-4 bottom-4 z-40 flex items-center gap-2 border border-charcoal bg-charcoal px-4 py-2.5 text-sm font-medium text-ivory shadow-lg hover:opacity-90"
          aria-label="Open Ask BMU (Ctrl or Cmd + J)"
        >
          <span aria-hidden className="inline-block size-2 bg-green" />
          {audience === "client" ? "Ask about your account" : "Ask BMU"}
          <kbd className="hidden border border-ivory/30 px-1 text-[10px] sm:inline">Ctrl J</kbd>
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-charcoal/20" onClick={() => setOpen(false)}>
          <aside role="dialog" aria-label="Ask BMU" className="flex h-full w-full max-w-[440px] flex-col border-l border-border bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}>
            <header className="flex items-center justify-between gap-2 border-b border-border bg-ivory px-4 py-3">
              <div>
                <p className="flex items-center gap-2 font-semibold">
                  <span aria-hidden className="inline-block size-2 bg-green" />
                  {audience === "client" ? "Ask about your account" : "Ask BMU"}
                </p>
                <p className="text-[11px] text-ink-muted">{audience === "client" ? "Answers use only your company's data." : "Answers use only what your role can see."} Ctrl/Cmd + J</p>
              </div>
              <div className="flex items-center gap-1 text-sm">
                <button
                  type="button"
                  className="px-2 py-1 text-ink-muted hover:text-ink"
                  onClick={() => {
                    setShowHistory((s) => !s);
                    if (!history) void loadHistory();
                  }}
                >
                  History
                </button>
                <button
                  type="button"
                  className="px-2 py-1 text-ink-muted hover:text-ink"
                  onClick={() => {
                    setMessages([]);
                    setConversationId(undefined);
                    setShowHistory(false);
                    setError(undefined);
                  }}
                >
                  New chat
                </button>
                <button type="button" className="px-2 py-1 text-ink-muted hover:text-ink" onClick={() => setOpen(false)} aria-label="Close">
                  ✕
                </button>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto px-4 py-4">
              {showHistory ? (
                <div>
                  <p className="mb-2 text-xs font-medium tracking-wide text-ink-muted uppercase">Recent conversations</p>
                  {history === null && <p className="text-sm text-ink-muted">Loading…</p>}
                  {history?.length === 0 && <p className="text-sm text-ink-muted">No conversations yet.</p>}
                  <ul className="divide-y divide-border border-y border-border">
                    {history?.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                        <button type="button" className="min-w-0 flex-1 truncate text-left text-sm hover:underline" onClick={() => openConversation(c.id)}>
                          {c.title}
                        </button>
                        <button
                          type="button"
                          className="text-xs text-ink-muted hover:text-ink"
                          onClick={async () => {
                            await api.ai.deleteConversation(c.id).catch(() => undefined);
                            void loadHistory();
                          }}
                        >
                          Delete
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : messages.length === 0 ? (
                <div>
                  <p className="text-sm text-ink-muted">Ask a question in plain words. Try:</p>
                  <div className="mt-3 grid gap-2">
                    {examples.map((ex) => (
                      <button key={ex} type="button" onClick={() => ask(ex)} className="border border-border bg-surface-raised px-3 py-2 text-left text-sm hover:border-ink">
                        {ex}
                      </button>
                    ))}
                  </div>
                  {status?.mode === "basic" && <p className="mt-4 text-xs text-ink-muted">{status.notice}</p>}
                </div>
              ) : (
                <ol className="space-y-4">
                  {messages.map((m, i) => (
                    <li key={i} className={m.role === "user" ? "ml-8 bg-canvas px-3 py-2 text-sm" : ""}>
                      {m.role === "user" ? (
                        m.text
                      ) : (
                        <div className="space-y-2">
                          {m.mode && <AiNotice result={{ mode: m.mode, notice: m.notice ?? null }} canManage={status?.canManage} />}
                          {m.text ? <AiText text={m.text} /> : <p className="animate-pulse text-sm text-ink-muted">{working ?? "Thinking…"}</p>}
                        </div>
                      )}
                    </li>
                  ))}
                  {working && messages.at(-1)?.text && <li className="text-xs text-ink-muted">{working}</li>}
                </ol>
              )}
              {error && (
                <p className="mt-3 border border-red bg-red/10 px-3 py-2 text-sm" role="alert">
                  {error}
                </p>
              )}
              <div ref={endRef} />
            </div>
            <form
              className="border-t border-border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(question);
              }}
            >
              <div className="flex gap-2">
                <textarea
                  ref={inputRef}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void ask(question);
                    }
                  }}
                  rows={2}
                  maxLength={2000}
                  placeholder={audience === "client" ? "e.g. Is anything waiting for my approval?" : "Ask about clients, leads, invoices, tasks…"}
                  className="min-w-0 flex-1 resize-none border border-border bg-surface-raised px-3 py-2 text-sm"
                  aria-label="Your question"
                />
                <button type="submit" disabled={!!working || question.trim().length < 2} className="bg-charcoal px-4 text-sm font-medium text-ivory disabled:opacity-40">
                  Ask
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </>
  );
}
