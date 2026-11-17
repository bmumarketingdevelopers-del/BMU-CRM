"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OpsThreadSummary, OpsThreadView, SentFile } from "@bmu/shared";
import { LoadState, PageTitle } from "@/components/ui";
import { useActions } from "@/components/actions/actions-provider";
import { RowMenu } from "@/components/actions/row-menu";
import { EmptyAdd, errMsg } from "@/components/ops/kit";
import { DiscussionDrawer } from "@/components/ops/discussion-drawer";
import { MessageToRequestDrawer } from "@/components/ops/message-to-request";
import { PendingFiles, SendFileControls } from "@/components/sent-files";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

/** The calendar day in India time, as "2026-11-16" (so "today" and "yesterday" follow IST, not the browser's zone). */
const istDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
/**
 * List time, like WhatsApp: today "6:14 pm", yesterday "Yesterday", the last week the day name ("Sunday"),
 * older "08/11/2026".
 */
export const listTime = (iso: string) => {
  const d = new Date(iso);
  const days = Math.round((Date.parse(istDay(new Date())) - Date.parse(istDay(d))) / 86_400_000);
  if (days <= 0) return d.toLocaleString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-IN", { weekday: "long", timeZone: "Asia/Kolkata" });
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Kolkata" });
};
/** Inside a bubble: "6:14 pm", with the day when it is not today. */
const bubbleTime = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString("en-IN", today ? { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" } : { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
};
const fileSize = (b: number | null) => (b === null ? "" : b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
/** "Muhammad Rafi" → "MR"; "Dhanush" → "D". */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("") || "?";
/** The same person always gets the same BMU colour for their avatar. */
const AVATAR_TONES = ["bg-green/30", "bg-amber/60", "bg-red/30", "bg-grey/50", "bg-charcoal/15"];
const avatarTone = (name: string) => AVATAR_TONES[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % AVATAR_TONES.length];
const discussionUrl = (id?: string) => (id ? `/team/discussions/${id}` : "/team/discussions");

// Line icons (no icon package in this project)
const svg = "h-5 w-5 shrink-0";
const IconPlus = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const IconSearch = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);
const IconSend = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 12 20 4l-4 16-4-7-8-1Z" />
    <path d="m12 13 8-9" />
  </svg>
);
const IconPeople = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c.6-3.5 3.3-5.5 6.5-5.5s5.9 2 6.5 5.5" />
    <path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.7.8 2.7 2.6 3 5.2" />
  </svg>
);
const IconChat = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" aria-hidden>
    <path d="M12 3.5c4.7 0 8.5 3.4 8.5 7.6s-3.8 7.6-8.5 7.6c-1 0-2-.2-2.9-.5L4 20l1.4-4A7.2 7.2 0 0 1 3.5 11c0-4.1 3.8-7.5 8.5-7.5Z" />
  </svg>
);
const IconFile = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" aria-hidden>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5M9 13h6M9 17h6" />
  </svg>
);
const IconDownload = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
  </svg>
);
const IconLink = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
);

function Avatar({ name, size = "h-9 w-9" }: { name: string; size?: string }) {
  return (
    <span aria-hidden className={`flex ${size} shrink-0 items-center justify-center rounded-full text-xs font-semibold text-charcoal ${avatarTone(name)}`}>
      {initials(name)}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Layout: list + open discussion

/**
 * Discussions, WhatsApp style in BMU colours: the list (New discussion, search, Project/Internal filter) and the open
 * discussion. Phone and tablet: the list first, tap one to open it, ← goes back. Desktop: list left, discussion right.
 * Used by /team/discussions (nothing open) and /team/discussions/<id> (that one open, e.g. from a notification).
 */
export function DiscussionsLayout({ openId, startNew = false }: { openId?: string; startNew?: boolean }) {
  const router = useRouter();
  const { notify } = useActions();
  const list = useLoad(() => api.ops.threads.list());
  const [selectedId, setSelectedId] = useState<string | undefined>(openId);
  const [creating, setCreating] = useState(startNew);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");

  const rows = (list.data ?? []).filter((t) => (!kind || t.kind === kind) && (!q.trim() || [t.title, t.client.name, t.engagement].some((x) => x?.toLowerCase().includes(q.trim().toLowerCase()))));

  /** Opens a discussion without reloading the page; the address follows so it can be shared or refreshed. */
  function open(id?: string) {
    setSelectedId(id);
    window.history.replaceState(null, "", discussionUrl(id));
  }

  return (
    <>
      <PageTitle title="Discussions" subtitle="Project threads with the client's team, and internal threads for the people you add." />
      {!list.data ? (
        <LoadState loading={list.loading} error={list.error} />
      ) : list.data.length === 0 && !selectedId ? (
        <EmptyAdd
          title="No discussions yet"
          body="Start one about a project, or an internal thread with the people who need to weigh in."
          action={
            <button type="button" onClick={() => setCreating(true)} className="inline-flex items-center gap-2 rounded-md bg-green px-4 py-2 text-sm font-medium text-charcoal hover:opacity-90" data-testid="new-discussion">
              <IconPlus /> New discussion
            </button>
          }
        />
      ) : (
        <div className="grid overflow-hidden rounded-xl border border-border bg-surface-raised lg:h-[min(78vh,780px)] lg:grid-cols-[340px_1fr]" data-testid="discussions-layout">
          {/* Discussion list */}
          <div className={`min-w-0 border-border lg:flex lg:min-h-0 lg:flex-col lg:border-r ${selectedId ? "hidden" : "flex flex-col"}`} data-testid="discussions-list">
            <div className="grid gap-2 border-b border-border p-3">
              <button type="button" onClick={() => setCreating(true)} className="flex items-center justify-center gap-2 rounded-md bg-green px-4 py-2.5 text-sm font-medium text-charcoal hover:opacity-90" data-testid="new-discussion">
                <IconPlus /> New discussion
              </button>
              <input
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm placeholder:text-ink-muted"
                placeholder="Search title or client"
                aria-label="Search discussions"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <select className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" aria-label="Filter by type" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">Project and internal</option>
                <option value="project">Project</option>
                <option value="internal">Internal</option>
              </select>
            </div>
            <ul aria-label="Discussions" className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {rows.map((t) => (
                <li key={t.id}>
                  <DiscussionRow t={t} active={t.id === selectedId} onOpen={() => open(t.id)} />
                </li>
              ))}
              {rows.length === 0 && <li className="px-4 py-8 text-center text-sm text-ink-muted">No discussions match.</li>}
            </ul>
          </div>

          {/* Open discussion */}
          <section className={`min-w-0 lg:block lg:h-full lg:min-h-0 ${selectedId ? "block" : "hidden"}`} data-testid="discussion-panel">
            {selectedId ? (
              <DiscussionPanel key={selectedId} id={selectedId} onBack={() => open(undefined)} onPosted={() => list.reload()} />
            ) : (
              <div className="flex h-full min-h-80 flex-col items-center justify-center gap-2 bg-ivory p-6 text-center text-sm text-ink-muted">
                <span className="text-ink-muted">
                  <IconChat />
                </span>
                Pick a discussion on the left to read and reply.
              </div>
            )}
          </section>
        </div>
      )}
      <DiscussionDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(id, m) => {
          notify(m);
          setCreating(false);
          router.push(discussionUrl(id));
        }}
      />
    </>
  );
}

function DiscussionRow({ t, active, onOpen }: { t: OpsThreadSummary; active: boolean; onOpen: () => void }) {
  const last = t.lastMessage ? `${t.lastMessage.author}: ${t.lastMessage.body || "Sent a file"}` : "No messages yet";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      data-thread={t.title}
      className={`flex w-full items-start gap-3 border-b border-l-4 border-b-border px-4 py-3 text-left ${active ? "border-l-green bg-green/15" : "border-l-transparent hover:bg-canvas"}`}
    >
      <span className="mt-0.5 text-ink-muted" title={t.kind === "internal" ? "Internal" : "Project"}>
        {t.kind === "internal" ? <IconPeople /> : <IconChat />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate font-semibold text-charcoal">{t.title}</span>
          <span className="shrink-0 text-[11px] text-ink-muted">{listTime(t.lastMessage?.at ?? t.createdAt)}</span>
        </span>
        <span className="block truncate text-sm text-ink-muted">{last}</span>
        <span className="block truncate text-[11px] text-ink-muted">
          {t.client.name}
          {t.engagement ? ` · ${t.engagement}` : ""} · {t.kind === "internal" ? "Internal" : "Project"}
        </span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// One discussion

function FileCard({ f, mine }: { f: SentFile; mine: boolean }) {
  const card = `flex items-center gap-3 rounded-lg px-3 py-2 ${mine ? "bg-paper/70" : "bg-canvas"}`;
  if (f.kind === "link")
    return (
      <a href={f.url} target="_blank" rel="noreferrer noopener" className={`${card} hover:opacity-90`}>
        <span className="text-ink-muted">
          <IconLink />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium underline">{f.name}</span>
      </a>
    );
  if (f.mimeType?.startsWith("image/"))
    return (
      <a href={f.url} target="_blank" rel="noreferrer" className="block w-fit">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={f.url} alt={f.name} className="max-h-60 max-w-full rounded-lg" />
      </a>
    );
  return (
    <div className={card}>
      <span className="text-ink-muted">
        <IconFile />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{f.name}</span>
        <span className="block text-[11px] text-ink-muted">{fileSize(f.sizeBytes)}</span>
      </span>
      <a href={`${f.url}?download=1`} className="rounded p-1 text-charcoal hover:bg-canvas" aria-label={`Download ${f.name}`}>
        <IconDownload />
      </a>
    </div>
  );
}

/** One discussion: header (← on phone/tablet, search, ⋮), messages as bubbles, and the WhatsApp-style reply bar. */
function DiscussionPanel({ id, onBack, onPosted }: { id: string; onBack: () => void; onPosted: () => void }) {
  const loaded = useLoad(() => api.ops.threads.get(id));
  const [fresh, setFresh] = useState<OpsThreadView>();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // v38: files (v39: and links) to send with the reply; they go to Files for the people in this discussion.
  const [files, setFiles] = useState<SentFile[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [find, setFind] = useState("");
  const [toRequest, setToRequest] = useState<{ id: string; body: string }>();
  const { me, canNew, openNew, notify } = useActions();
  const canRequest = me.roles.some((r) => ["founder", "admin", "am_lead", "account_manager"].includes(r));
  const end = useRef<HTMLLIElement>(null);
  const t = fresh ?? loaded.data;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [t?.messages.length]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!body.trim() && !files.length) return setError("Write a message or attach a file");
    setBusy(true);
    setError(undefined);
    try {
      setFresh(await api.ops.threads.post(id, body.trim(), files.map((f) => f.id)));
      setBody("");
      setFiles([]);
      setAttachOpen(false);
      onPosted();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  const back = (
    <button type="button" onClick={onBack} className="-ml-1 px-1 text-lg text-charcoal lg:hidden" aria-label="Back to discussions" data-testid="discussion-back">
      ←
    </button>
  );
  if (!t)
    return (
      <div className="p-4">
        {back}
        <LoadState loading={loaded.loading} error={loaded.error} />
      </div>
    );

  const people = t.participants.length;
  const subtitle =
    t.kind === "internal"
      ? `Internal · ${people} ${people === 1 ? "person" : "people"}${people ? `: ${t.participants.join(", ")}` : ""}`
      : `Project · ${t.client.name}${t.engagement ? ` · ${t.engagement}` : ""} · the client's team can read this`;
  const shown = find.trim() ? t.messages.filter((m) => m.body.toLowerCase().includes(find.trim().toLowerCase()) || m.author.toLowerCase().includes(find.trim().toLowerCase())) : t.messages;

  return (
    <div className="flex flex-col lg:h-full">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        {back}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-semibold text-charcoal">{t.title}</span>
          <span className="block truncate text-xs text-ink-muted">{subtitle}</span>
        </span>
        <button
          type="button"
          onClick={() => (setSearchOpen((x) => !x), setFind(""))}
          className={`rounded-full p-2 text-charcoal hover:bg-canvas ${searchOpen ? "bg-canvas" : ""}`}
          aria-label="Search messages"
          aria-pressed={searchOpen}
          data-testid="discussion-search-toggle"
        >
          <IconSearch />
        </button>
        <RowMenu label="Discussion options" items={[{ key: "client", label: "Open Client 360", href: `/team/clients/${t.client.id}` }]} />
      </div>
      {searchOpen && (
        <div className="border-b border-border px-4 py-2">
          <input autoFocus className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm" placeholder="Search in this discussion" aria-label="Search in this discussion" value={find} onChange={(e) => setFind(e.target.value)} />
        </div>
      )}

      {/* Messages */}
      <ol className="max-h-[60vh] min-h-80 space-y-3 overflow-y-auto bg-ivory p-4 lg:max-h-none lg:min-h-0 lg:flex-1" aria-label="Messages">
        {shown.map((m) => (
          <li key={m.id} className={`flex items-end gap-2 ${m.mine ? "justify-end" : "justify-start"}`} data-message={m.id}>
            {!m.mine && <Avatar name={m.author} />}
            <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm shadow-sm sm:max-w-[70%] ${m.mine ? "rounded-br-sm bg-green/25 text-charcoal" : "rounded-bl-sm border border-border bg-paper text-charcoal"}`}>
              {!m.mine && <p className="mb-0.5 text-xs font-semibold text-charcoal">{m.author}</p>}
              {!!m.attachments?.length && (
                <div className="mb-1 grid gap-1.5">
                  {m.attachments.map((f) => (
                    <FileCard key={f.id} f={f} mine={m.mine} />
                  ))}
                </div>
              )}
              {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
              <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-ink-muted">
                <span>{bubbleTime(m.at)}</span>
                <RowMenu
                  label="Message actions"
                  className="align-middle"
                  align={m.mine ? "right" : "left"}
                  items={[
                    { key: "task", label: "Create task", hidden: !canNew("task"), onSelect: () => openNew("task", { title: m.body.split("\n")[0].slice(0, 120), description: m.body, source: `message:${m.id}`, clientId: t.client.id }) },
                    { key: "request", label: "Create request", hidden: !canRequest || t.kind === "internal", onSelect: () => setToRequest({ id: m.id, body: m.body }) },
                  ]}
                />
              </div>
            </div>
          </li>
        ))}
        {t.messages.length === 0 && <li className="py-10 text-center text-sm text-ink-muted">No messages yet. Say hello.</li>}
        {t.messages.length > 0 && shown.length === 0 && <li className="py-10 text-center text-sm text-ink-muted">No messages match.</li>}
        <li ref={end} aria-hidden />
      </ol>

      {/* Reply bar */}
      {t.canPost ? (
        <form onSubmit={send} className="grid gap-2 border-t border-border bg-paper p-3">
          {attachOpen && (
            <div className="grid gap-1 rounded-lg border border-border bg-canvas/50 p-3" data-testid="discussion-attach-panel">
              <SendFileControls limit={5 - files.length} upload={(f) => api.ops.threads.attach(id, f)} addLink={(url) => api.ops.threads.link(id, { url })} onAdded={(f) => setFiles((x) => [...x, f])} />
              <span className="text-xs text-ink-muted">{t.kind === "internal" ? "Only the people in this discussion see the files (also in their Files)." : "Everyone on this client's team sees the files (also in their Files)."}</span>
            </div>
          )}
          <PendingFiles files={files} onRemove={(fid) => setFiles((x) => x.filter((y) => y.id !== fid))} />
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => setAttachOpen((x) => !x)}
              className={`mb-1 rounded-full p-2 text-charcoal hover:bg-canvas ${attachOpen ? "bg-canvas" : ""}`}
              aria-label="Attach files or add a link"
              aria-expanded={attachOpen}
              data-testid="discussion-attach-toggle"
            >
              <IconPlus />
            </button>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift + Enter starts a new line (like WhatsApp).
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!busy) send();
                }
              }}
              aria-label="Message"
              rows={1}
              maxLength={4000}
              placeholder="Type a message"
              className="max-h-40 min-h-11 flex-1 resize-none rounded-3xl border border-border bg-surface px-4 py-2.5 text-sm placeholder:text-ink-muted"
            />
            <button type="submit" disabled={busy} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-green text-charcoal hover:opacity-90 disabled:opacity-50" aria-label="Send" title="Send (Enter)">
              <IconSend />
            </button>
          </div>
          {error && <p className="text-sm text-red">{error}</p>}
        </form>
      ) : (
        <p className="border-t border-border p-4 text-sm text-ink-muted">You can read this discussion but not post in it.</p>
      )}
      {toRequest && <MessageToRequestDrawer message={toRequest} clientId={t.client.id} onClose={() => setToRequest(undefined)} onDone={(m) => (notify(m), loaded.reload(), setFresh(undefined))} />}
    </div>
  );
}
