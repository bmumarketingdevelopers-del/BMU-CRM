"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AiChatMessage, AiConversationSummary } from "@bmu/shared";
import { api } from "@/lib/api";
import { aiStream, useAiStatus } from "@/lib/ai";
import { AiNotice } from "./ai-panel";
import { AiText } from "./ai-text";
import { ChartLineUp, ClockCounterClockwise, CurrencyInr, NotePencil, PaperPlaneRight, Receipt, SealCheck, Tray, UserCircle, Warning, X, type IconProps } from "@phosphor-icons/react";
import type { ComponentType } from "react";

const STAFF_EXAMPLES = ["Which clients are at risk this month and why?", "How much is overdue from Metro Dental?", "What is Meera working on?", "Summary of the week"];
/** v54 chat card: an icon for each example question (same order as the lists below). */
const STAFF_EXAMPLE_ICONS: ComponentType<IconProps>[] = [Warning, CurrencyInr, UserCircle, ChartLineUp];
const CLIENT_EXAMPLE_ICONS: ComponentType<IconProps>[] = [SealCheck, Receipt, Tray];
const CLIENT_EXAMPLES = ["What is waiting for my approval?", "Do I have any invoices due?", "What is the status of my requests?"];

/** Ask BMU: a side panel opened with the button or Ctrl/Cmd + J. Staff ask about the CRM; clients about their own account. */
/** look "robot" (v54 redesign preview): the launcher is a round robot button (no text); the panel is the same. */
export function Copilot({ audience, look = "classic" }: { audience: "staff" | "client"; look?: "classic" | "robot" }) {
  // v54 mascot mood: happy while the pointer is on it, sad for a moment when it leaves, then back to normal.
  const [mood, setMood] = useState<"idle" | "happy" | "sad">("idle");
  const moodTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cheer = () => {
    if (moodTimer.current) clearTimeout(moodTimer.current);
    setMood("happy");
  };
  const sulk = () => {
    if (moodTimer.current) clearTimeout(moodTimer.current);
    setMood("sad");
    moodTimer.current = setTimeout(() => setMood("idle"), 2600);
  };
  useEffect(() => () => {
    if (moodTimer.current) clearTimeout(moodTimer.current);
  }, []);
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
  const exampleIcons = audience === "client" ? CLIENT_EXAMPLE_ICONS : STAFF_EXAMPLE_ICONS;
  const title = audience === "client" ? "Ask about your account" : "Ask BMU";
  const newChat = () => {
    setMessages([]);
    setConversationId(undefined);
    setShowHistory(false);
    setError(undefined);
  };

  // v54 (robot look): the same chat as a floating glass card at the bottom right, like Hari's reference.
  const chatCard = (
    <div className="fixed inset-0 z-50" onClick={() => setOpen(false)}>
      <aside role="dialog" aria-label="Ask BMU" className="copilot-card fixed right-3 bottom-3 flex flex-col overflow-hidden sm:right-5 sm:bottom-5" onClick={(e) => e.stopPropagation()}>
        {/* Three equal parts, so the title sits exactly in the middle of the card. */}
        <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 pt-4 pb-1">
          <button type="button" className="copilot-card-icon justify-self-start" onClick={() => setOpen(false)} aria-label="Close" title="Close">
            <X size={18} weight="bold" aria-hidden />
          </button>
          <p className="truncate text-center text-[15px] font-semibold">{title}</p>
          <div className="flex items-center gap-1.5 justify-self-end">
            <button
              type="button"
              className="copilot-card-icon"
              aria-label="History"
              title="History"
              aria-pressed={showHistory}
              onClick={() => {
                setShowHistory((v) => !v);
                if (!history) void loadHistory();
              }}
            >
              <ClockCounterClockwise size={18} weight="duotone" aria-hidden />
            </button>
            <button type="button" className="copilot-card-icon" onClick={newChat} aria-label="New chat" title="New chat">
              <NotePencil size={18} weight="duotone" aria-hidden />
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto px-5 pt-2 pb-4">
          {showHistory ? (
            <div>
              <p className="mb-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">Recent conversations</p>
              {history === null && <p className="text-sm text-ink-muted">Loading…</p>}
              {history?.length === 0 && <p className="text-sm text-ink-muted">No conversations yet.</p>}
              <ul className="space-y-1.5">
                {history?.map((c) => (
                  <li key={c.id} className="copilot-card-row flex items-center justify-between gap-2 px-3 py-2">
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
            <div className="flex flex-col items-center text-center">
              <div className="copilot-robot copilot-card-avatar mt-1" data-mood="idle" aria-hidden>
                <RobotBuddy />
              </div>
              <h2 className="mt-5 text-[22px] leading-tight font-semibold">What can I help you with?</h2>
              <p className="mt-1.5 text-sm text-ink-muted">{audience === "client" ? "Answers use only your company's data." : "Answers use only what your role can see."}</p>
              <div className="mt-5 grid w-full gap-2.5 sm:grid-cols-2">
                {examples.map((ex, i) => {
                  const Icon = exampleIcons[i] ?? ChartLineUp;
                  return (
                    <button key={ex} type="button" onClick={() => ask(ex)} className="copilot-card-example flex items-center gap-2.5 px-3.5 py-3 text-left text-sm">
                      <Icon size={20} weight="duotone" className="shrink-0" aria-hidden />
                      <span>{ex}</span>
                    </button>
                  );
                })}
              </div>
              {status?.mode === "basic" && <p className="mt-4 text-xs text-ink-muted">{status.notice}</p>}
            </div>
          ) : (
            <ol className="space-y-4">
              {messages.map((m, i) => (
                <li key={i} className={m.role === "user" ? "copilot-card-mine ml-10 px-3.5 py-2 text-sm" : ""}>
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
            <p className="mt-3 rounded-2xl border border-red bg-red/10 px-3 py-2 text-sm" role="alert">
              {error}
            </p>
          )}
          <div ref={endRef} />
        </div>
        <form
          className="px-4 pt-1 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(question);
          }}
        >
          <div className="copilot-card-input flex items-end gap-2 py-1.5 pr-1.5 pl-4">
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
              rows={1}
              maxLength={2000}
              placeholder={audience === "client" ? "e.g. Is anything waiting for my approval?" : "Ask about clients, leads, invoices, tasks…"}
              className="max-h-32 min-h-[40px] min-w-0 flex-1 resize-none bg-transparent py-2.5 text-sm outline-none"
              aria-label="Your question"
            />
            <button type="submit" disabled={!!working || question.trim().length < 2} className="copilot-card-send" aria-label="Ask" title="Ask">
              <PaperPlaneRight size={18} weight="fill" aria-hidden />
            </button>
          </div>
        </form>
        <p className="px-4 pb-3 text-center text-[11px] text-ink-muted">Ctrl/Cmd + J opens and closes this chat.</p>
      </aside>
    </div>
  );

  return (
    <>
      {!open && look === "robot" && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          onMouseEnter={cheer}
          onMouseLeave={sulk}
          onFocus={cheer}
          onBlur={sulk}
          data-mood={mood}
          className="copilot-robot fixed right-5 bottom-5 z-40 flex h-[72px] w-[72px] items-center justify-center rounded-full"
          aria-label="Open Ask BMU (Ctrl or Cmd + J)"
          data-testid="copilot-robot"
        >
          <RobotBuddy />
          <span className="copilot-robot-dot" aria-hidden />
          <span className="copilot-robot-label" aria-hidden>
            Ask BMU
          </span>
        </button>
      )}
      {!open && look !== "robot" && (
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
      {open && look === "robot" && chatCard}
      {open && look !== "robot" && (
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

/**
 * v54: the Ask BMU mascot, a little robot with a screen face (BMU colours): glossy green head, navy ear pieces, a glowing
 * antenna, a dark screen with light-blue glowing eyes. Its face follows the button's data-mood (globals.css):
 * idle = round eyes that blink and a small smile; happy (hover) = ^ ^ eyes, big smile, cheeks, a heart bubble;
 * sad (just after) = sad eyes and brows, a frown, a drooping antenna and a tear.
 */
function RobotBuddy() {
  return (
    <svg viewBox="0 0 64 64" className="rb-face" aria-hidden>
      <defs>
        <linearGradient id="rb-shell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#bfe68a" />
          <stop offset="0.5" stopColor="#8cc63f" />
          <stop offset="1" stopColor="#5c9a1c" />
        </linearGradient>
        <linearGradient id="rb-screen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a2a3d" />
          <stop offset="1" stopColor="#070d16" />
        </linearGradient>
      </defs>
      <g className="rb-body">
        {/* heart bubble (happy) */}
        <g className="rb-happy rb-heart">
          <rect x="0.5" y="2" width="13" height="11" rx="3.5" fill="#ff7a93" />
          <path d="M4.5 12.4 L5.6 15.2 L7.6 12.4 Z" fill="#ff7a93" />
          <path d="M7 10.6 C3.6 8.4 3.8 5.6 5.6 5.4 C6.4 5.3 6.9 5.8 7 6.4 C7.1 5.8 7.6 5.3 8.4 5.4 C10.2 5.6 10.4 8.4 7 10.6 Z" fill="#ffffff" />
        </g>
        {/* antenna */}
        <g className="rb-antenna">
          <path d="M32 13.5 V7.4" stroke="#1b2d42" strokeWidth="2" strokeLinecap="round" />
          <circle className="rb-antenna-ball" cx="32" cy="5.4" r="2.7" fill="#a8e05f" />
        </g>
        {/* ear pieces */}
        <rect x="5.5" y="25" width="6.5" height="15" rx="3.2" fill="#1b2d42" stroke="#8cc63f" strokeWidth="1.1" />
        <rect x="52" y="25" width="6.5" height="15" rx="3.2" fill="#1b2d42" stroke="#8cc63f" strokeWidth="1.1" />
        {/* head */}
        <rect x="10" y="13" width="44" height="38" rx="14" fill="url(#rb-shell)" />
        <path d="M16 17.5 C22 14.6 42 14.6 48 17.5" fill="none" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="1.6" strokeLinecap="round" />
        <rect x="10" y="13" width="44" height="38" rx="14" fill="none" stroke="#4f8a17" strokeOpacity="0.35" />
        {/* screen */}
        <rect x="14.5" y="19" width="35" height="25" rx="9" fill="url(#rb-screen)" />
        <path d="M18 21.6 C24 20.2 40 20.2 46 21.6" fill="none" stroke="#ffffff" strokeOpacity="0.12" strokeWidth="1.2" strokeLinecap="round" />
        {/* face (glows) */}
        <g className="rb-glow">
          {/* idle and sad: round eyes that blink */}
          <g className="rb-eyes-open">
            <g className="rb-blink">
              <ellipse cx="25" cy="30.2" rx="3" ry="3.8" fill="#9fe6ff" />
              <ellipse cx="39" cy="30.2" rx="3" ry="3.8" fill="#9fe6ff" />
            </g>
          </g>
          {/* sad brows */}
          <path className="rb-sad" d="M20.6 25.6 L27.2 24 M36.8 24 L43.4 25.6" fill="none" stroke="#9fe6ff" strokeWidth="1.4" strokeLinecap="round" />
          {/* happy eyes */}
          <path className="rb-happy" d="M21.4 31.6 q3.6 -4.8 7.2 0 M35.4 31.6 q3.6 -4.8 7.2 0" fill="none" stroke="#9fe6ff" strokeWidth="2.2" strokeLinecap="round" />
          {/* mouths */}
          <path className="rb-idle" d="M29 37 q3 2.2 6 0" fill="none" stroke="#9fe6ff" strokeWidth="1.6" strokeLinecap="round" />
          <path className="rb-happy" d="M26.8 35.4 q5.2 6.4 10.4 0 z" fill="#9fe6ff" />
          <path className="rb-sad" d="M28.6 40 q3.4 -2.9 6.8 0" fill="none" stroke="#9fe6ff" strokeWidth="1.6" strokeLinecap="round" />
          {/* tear (sad) */}
          <path className="rb-sad rb-tear" d="M22 34.6 q1.4 2.1 0 3 q-1.4 -0.9 0 -3 z" fill="#9fe6ff" />
        </g>
        {/* cheeks (happy) */}
        <g className="rb-happy">
          <ellipse cx="19.6" cy="36.4" rx="2.2" ry="1.3" fill="#ff8fa6" fillOpacity="0.8" />
          <ellipse cx="44.4" cy="36.4" rx="2.2" ry="1.3" fill="#ff8fa6" fillOpacity="0.8" />
        </g>
      </g>
    </svg>
  );
}
