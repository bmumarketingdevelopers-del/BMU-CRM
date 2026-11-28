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
import { PendingFiles, SENT_FILE_MAX } from "@/components/sent-files";
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

// Solid icons for the + menu (coloured like WhatsApp's attach menu by the parent's text colour).
const MenuIconDocument = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5Zm-5 11h6v1.6H9V13Zm0 3.4h6V18H9v-1.6ZM13.5 8V3.5L18 8h-4.5Z" />
  </svg>
);
const MenuIconMedia = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm4 4.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM5 18h14l-4.5-6-3.5 4.5-2.5-3L5 18Z" />
  </svg>
);
const MenuIconLink = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
);
/** v60: CRM files (a folder). */
const MenuIconFolder = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M3 6a2 2 0 0 1 2-2h4.2l2 2.2H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" />
  </svg>
);

/**
 * v60: "CRM files": pick a file that is already in Files (only the ones this person may see there). Starts on this
 * discussion's client when it has one; "All files" shows everything they can see. Search by name, client or uploader.
 */
function CrmFilePicker({ clientId, clientName, pick, onBack }: { clientId: string | null; clientName: string | null; pick: (fileId: string) => void; onBack: () => void }) {
  const [onlyClient, setOnlyClient] = useState(!!clientId);
  const [q, setQ] = useState("");
  // Every file this person may see in Files, loaded once; "This client" narrows it here.
  const list = useLoad(() => api.ops.files.list(), { live: false });
  const needle = q.trim().toLowerCase();
  const rows = (list.data?.rows ?? []).filter((f) => (!onlyClient || !clientId || f.client?.id === clientId) && f.source !== "payment_proof").filter((f) => !needle || [f.name, f.client?.name, f.uploadedBy, f.engagement?.name].some((x) => x?.toLowerCase().includes(needle)));
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  return (
    <div className="grid gap-2 p-2" data-testid="crm-file-picker">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-charcoal">CRM files</span>
        <button type="button" onClick={onBack} className="px-1 text-sm text-ink-muted hover:text-ink">
          Back
        </button>
      </div>
      <input autoFocus className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" placeholder="Search files" aria-label="Search CRM files" value={q} onChange={(e) => setQ(e.target.value)} />
      {clientId && (
        <div className="flex gap-1 text-xs" role="radiogroup" aria-label="Which files">
          {[true, false].map((only) => (
            <button key={String(only)} type="button" role="radio" aria-checked={onlyClient === only} onClick={() => setOnlyClient(only)} className={`rounded-full border px-2.5 py-1 ${onlyClient === only ? "border-charcoal bg-charcoal text-ivory" : "border-border text-ink-muted"}`}>
              {only ? clientName ?? "This client" : "All files"}
            </button>
          ))}
        </div>
      )}
      <ul className="max-h-72 overflow-y-auto" aria-label="Files you can send">
        {list.loading && <li className="px-2 py-3 text-sm text-ink-muted">Loading files…</li>}
        {list.error && <li className="px-2 py-3 text-sm text-[#b4432c]">{list.error}</li>}
        {!list.loading && !list.error && rows.length === 0 && <li className="px-2 py-3 text-sm text-ink-muted">{needle ? "No files match your search." : "No files here yet."}</li>}
        {rows.slice(0, 60).map((f) => (
          <li key={f.id}>
            <button type="button" onClick={() => pick(f.id)} className="flex w-full flex-col rounded-lg px-2 py-2 text-left hover:bg-canvas" data-testid="crm-file-option">
              <span className="truncate text-sm text-charcoal">{f.name}</span>
              <span className="truncate text-[11px] text-ink-muted">{[f.client?.name ?? "No client", f.uploadedBy, day(f.createdAt)].filter(Boolean).join(" · ")}</span>
            </button>
          </li>
        ))}
        {rows.length > 60 && <li className="px-2 py-2 text-[11px] text-ink-muted">Showing 60 of {rows.length}. Search to narrow it down.</li>}
      </ul>
    </div>
  );
}

/**
 * The + menu (like WhatsApp's attach menu): Document, Photos & videos, Link and v60 CRM files.
 * Uploads go through the same discussion upload as before; files over 200 MB are refused with a hint to send a link.
 */
function AttachMenu({
  limit,
  upload,
  addLink,
  crm,
  onAdded,
  onError,
  onClose,
}: {
  limit: number;
  upload: (f: File) => Promise<SentFile | void>;
  addLink: (url: string) => Promise<SentFile | void>;
  /** v60: "CRM files" (team discussions only). */
  crm?: { clientId: string | null; clientName: string | null; pick: (fileId: string) => Promise<SentFile | void> };
  onAdded: (f: SentFile) => void;
  onError: (message: string | undefined) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const [picking, setPicking] = useState(false);

  async function pickCrm(fileId: string) {
    if (!crm) return;
    setBusy(true);
    onError(undefined);
    try {
      const r = await crm.pick(fileId);
      if (r) onAdded(r);
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const [url, setUrl] = useState("");
  const documentPicker = useRef<HTMLInputElement>(null);
  const mediaPicker = useRef<HTMLInputElement>(null);

  // Click outside or Esc closes the menu (not while a file is uploading).
  useEffect(() => {
    // The + button sits next to the menu (same parent): it toggles the menu itself, so it is not "outside".
    const away = (e: MouseEvent) => !busy && box.current && !(box.current.parentElement ?? box.current).contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [busy, onClose]);

  async function pick(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    onError(undefined);
    try {
      for (const f of Array.from(list).slice(0, limit)) {
        if (f.size > SENT_FILE_MAX) throw new Error(`${f.name} is larger than 200 MB. Upload it to Google Drive and send the link instead.`);
        const r = await upload(f);
        if (r) onAdded(r);
      }
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendLink() {
    if (!url.trim()) return onError("Paste the link");
    setBusy(true);
    onError(undefined);
    try {
      const r = await addLink(url.trim());
      if (r) onAdded(r);
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const full = limit <= 0;
  const item = "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-charcoal hover:bg-canvas disabled:opacity-50";
  return (
    <div ref={box} role="menu" aria-label="Attach" className={`absolute bottom-full left-0 z-20 mb-2 ${picking ? "w-[min(22rem,calc(100vw-2rem))]" : "w-64"} rounded-xl border border-border bg-paper p-1.5 shadow-lg`} data-testid="discussion-attach-menu">
      {busy ? (
        <p className="px-3 py-2.5 text-sm text-ink-muted">{picking ? "Adding…" : "Uploading…"}</p>
      ) : picking && crm ? (
        <CrmFilePicker clientId={crm.clientId} clientName={crm.clientName} pick={pickCrm} onBack={() => setPicking(false)} />
      ) : linking ? (
        <div className="grid gap-2 p-2">
          <input
            autoFocus
            type="url"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            placeholder="https://drive.google.com/…"
            aria-label="Link to send"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                sendLink();
              }
            }}
          />
          <div className="flex gap-2">
            <button type="button" onClick={sendLink} className="rounded-md bg-green px-3 py-1.5 text-sm font-medium text-charcoal hover:opacity-90">
              Add link
            </button>
            <button type="button" onClick={() => setLinking(false)} className="px-2 text-sm text-ink-muted hover:text-ink">
              Back
            </button>
          </div>
        </div>
      ) : (
        <>
          <button type="button" role="menuitem" className={item} disabled={full} onClick={() => documentPicker.current?.click()}>
            <span className="text-[#7f66ff]">
              <MenuIconDocument />
            </span>
            Document
          </button>
          <button type="button" role="menuitem" className={item} disabled={full} onClick={() => mediaPicker.current?.click()}>
            <span className="text-[#007bfc]">
              <MenuIconMedia />
            </span>
            Photos &amp; videos
          </button>
          <button type="button" role="menuitem" className={item} disabled={full} onClick={() => setLinking(true)}>
            <span className="text-[#02a698]">
              <MenuIconLink />
            </span>
            Link <span className="ml-auto text-[11px] text-ink-muted">Drive, over 200 MB</span>
          </button>
          {crm && (
            <button type="button" role="menuitem" className={item} disabled={full} onClick={() => setPicking(true)} data-testid="attach-crm-files">
              <span className="text-[#c98a00]">
                <MenuIconFolder />
              </span>
              CRM files <span className="ml-auto text-[11px] text-ink-muted">From Files</span>
            </button>
          )}
          {full && <p className="px-3 pb-1 text-[11px] text-ink-muted">Up to 5 files per message.</p>}
        </>
      )}
      <input ref={documentPicker} type="file" multiple className="sr-only" onChange={(e) => pick(e.target.files)} aria-label="Attach documents" tabIndex={-1} />
      <input ref={mediaPicker} type="file" multiple accept="image/*,video/*" className="sr-only" onChange={(e) => pick(e.target.files)} aria-label="Attach photos and videos" tabIndex={-1} />
    </div>
  );
}

/** WhatsApp-style ticks on my messages: grey ✓✓ sent, blue ✓✓ once everyone in the discussion has read it. */
function Ticks({ seen }: { seen: boolean }) {
  return (
    <span className={seen ? "text-[#1d9bf0]" : "text-ink-muted"} title={seen ? "Read by everyone" : "Sent"} aria-label={seen ? "Read by everyone" : "Sent"} data-testid={seen ? "ticks-seen" : "ticks-sent"}>
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m2 13 4 4 8-9" />
        <path d="m10 16 1 1 10-11" />
      </svg>
    </span>
  );
}

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

  // v53: new discussions and unread counts show within seconds, not only after a refresh.
  const refreshList = list.refresh;
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && refreshList(), 8_000);
    return () => clearInterval(t);
  }, [refreshList]);

  const rows = (list.data ?? []).filter((t) => (!kind || t.kind === kind) && (!q.trim() || [t.title, t.client?.name, t.engagement].some((x) => x?.toLowerCase().includes(q.trim().toLowerCase()))));

  /** Opens a discussion without reloading the page; the address follows so it can be shared or refreshed. */
  function open(id?: string) {
    setSelectedId(id);
    window.history.replaceState(null, "", discussionUrl(id));
  }

  return (
    <>
      <PageTitle title="Discussions" subtitle="Project threads for everyone on a client, internal threads for the people you add, and chats with your clients." />
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
        <div className="mb-20 grid overflow-hidden rounded-xl border border-border bg-surface-raised lg:mb-0 lg:h-[min(calc(100vh-260px),780px)] lg:min-h-[420px] lg:grid-cols-[340px_1fr]" data-testid="discussions-layout">
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
                <option value="">All discussions</option>
                <option value="project">Project</option>
                <option value="internal">Internal</option>
                <option value="client_staff">Client chats</option>
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
              <DiscussionPanel key={selectedId} id={selectedId} onBack={() => open(undefined)} onPosted={() => list.refresh()} onOpened={() => list.refresh()} />
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

/** v53: the three kinds of discussion. */
const kindLabel = (k: string) => (k === "internal" ? "Internal" : k === "client_staff" ? "Client chat" : "Project");

function DiscussionRow({ t, active, onOpen }: { t: OpsThreadSummary; active: boolean; onOpen: () => void }) {
  const last = t.lastMessage ? `${t.lastMessage.author}: ${t.lastMessage.body || "Sent a file"}` : "No messages yet";
  // The open discussion is being read, so it never shows a count.
  const unread = active ? 0 : (t.unread ?? 0);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      data-thread={t.title}
      className={`flex w-full items-start gap-3 border-b border-l-4 border-b-border px-4 py-3 text-left ${active ? "border-l-green bg-green/15" : "border-l-transparent hover:bg-canvas"}`}
    >
      <span className="mt-0.5 text-ink-muted" title={kindLabel(t.kind)}>
        {t.kind === "internal" ? <IconPeople /> : <IconChat />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate font-semibold text-charcoal">{t.title}</span>
          <span className={`shrink-0 text-[11px] ${unread ? "font-semibold text-charcoal" : "text-ink-muted"}`}>{listTime(t.lastMessage?.at ?? t.createdAt)}</span>
        </span>
        <span className="flex items-center justify-between gap-2">
          <span className={`truncate text-sm ${unread ? "font-medium text-charcoal" : "text-ink-muted"}`}>{last}</span>
          {unread > 0 && (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-green px-1.5 text-[11px] font-bold text-charcoal" aria-label={`${unread} unread`} data-testid="discussion-unread">
              {unread}
            </span>
          )}
        </span>
        <span className="block truncate text-[11px] text-ink-muted">
          {/* v59: an internal discussion may have no client: it just reads "Internal". */}
          {[t.client?.name, t.engagement, kindLabel(t.kind)].filter(Boolean).join(" · ")}
        </span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// One discussion

/** v53: how often an open discussion checks for new messages: while chatting, and when it is quiet. */
const FAST_MS = 1_000;
const QUIET_MS = 3_000;
/** "Chatting": someone wrote in the last 2 minutes, or you typed in the last 30 seconds. */
const CHATTING_MS = 120_000;
const TYPING_MS = 30_000;
/** How often "I am reading this" is saved (the server counts it for 20 seconds). */
const BEAT_MS = 5_000;

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

const IconClose = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
const IconPencil = () => (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" />
  </svg>
);

/**
 * Discussion info (like WhatsApp's group info): name, type and client, who started it, the files, links and documents
 * sent in it, and the people. The person who started it, the Founder and Admins can edit the title and add or remove
 * people; everyone else sees it read-only.
 */
function DiscussionInfo({ t, meId, onClose, onChanged }: { t: OpsThreadView; meId: string; onClose: () => void; onChanged: (v: OpsThreadView) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const options = useLoad(() => api.ops.threads.options(), { live: false });
  const people = t.people ?? [];
  const canManage = !!t.canManage;
  const files = t.messages.flatMap((m) => m.attachments ?? []);
  const media = files.slice(-6).reverse();
  const addable = (options.data?.people ?? []).filter((p) => !people.some((x) => x.id === p.id));

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  async function save(body: { title?: string; addIds?: string[]; removeIds?: string[] }, after?: () => void) {
    setBusy(true);
    setError(undefined);
    try {
      onChanged(await api.ops.threads.update(t.id, body));
      after?.();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="absolute inset-0 z-10 flex flex-col overflow-hidden bg-paper" aria-label="Discussion info" data-testid="discussion-info">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <button type="button" onClick={onClose} className="rounded-full p-1.5 text-charcoal hover:bg-canvas" aria-label="Close discussion info" data-testid="discussion-info-close">
          <IconClose />
        </button>
        <span className="font-semibold text-charcoal">Discussion info</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Name */}
        <div className="flex flex-col items-center gap-2 border-b border-border px-6 py-6 text-center">
          <span aria-hidden className="flex h-24 w-24 items-center justify-center rounded-full bg-green/30 text-3xl font-semibold text-charcoal">
            {initials(t.title)}
          </span>
          {editing ? (
            <form
              className="flex w-full max-w-sm items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                save({ title: title.trim() }, () => setEditing(false));
              }}
            >
              <input autoFocus className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} aria-label="Discussion title" />
              <button type="submit" disabled={busy || title.trim().length < 3} className="rounded-md bg-green px-3 py-2 text-sm font-medium text-charcoal hover:opacity-90 disabled:opacity-50" data-testid="discussion-title-save">
                Save
              </button>
              <button type="button" onClick={() => (setEditing(false), setTitle(t.title))} className="px-1 text-sm text-ink-muted hover:text-ink">
                Cancel
              </button>
            </form>
          ) : (
            <h3 className="flex items-center gap-2 text-xl font-semibold text-charcoal">
              {t.title}
              {canManage && (
                <button type="button" onClick={() => setEditing(true)} className="rounded-full p-1.5 text-ink-muted hover:bg-canvas hover:text-ink" aria-label="Edit title" data-testid="discussion-title-edit">
                  <IconPencil />
                </button>
              )}
            </h3>
          )}
          <p className="text-sm text-ink-muted">
            {t.kind === "internal" ? "Internal discussion" : t.kind === "client_staff" ? "Chat with the client" : "Project discussion"}
            {t.client ? ` · ${t.client.name}` : " · Not linked to a client"}
            {t.engagement ? ` · ${t.engagement}` : ""}
          </p>
          {t.startedBy && (
            <p className="text-xs text-ink-muted">
              Started by {t.startedBy.id === meId ? "you" : t.startedBy.name} · {new Date(t.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}
            </p>
          )}
        </div>

        {/* Media, links and docs */}
        <div className="border-b border-border px-4 py-4">
          <div className="mb-3 flex items-center justify-between text-sm">
            <span className="font-medium text-charcoal">Media, links and docs</span>
            <span className="text-ink-muted">{files.length}</span>
          </div>
          {media.length ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" data-testid="discussion-info-media">
              {media.map((f) => (
                <a
                  key={f.id}
                  href={f.kind === "link" || f.mimeType?.startsWith("image/") ? f.url : `${f.url}?download=1`}
                  target={f.kind === "link" || f.mimeType?.startsWith("image/") ? "_blank" : undefined}
                  rel="noreferrer noopener"
                  title={f.name}
                  className="flex aspect-square flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-border bg-canvas p-1 text-center hover:opacity-90"
                >
                  {f.mimeType?.startsWith("image/") && f.kind !== "link" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={f.url} alt={f.name} className="h-full w-full object-cover" />
                  ) : (
                    <>
                      <span className={f.kind === "link" ? "text-[#02a698]" : "text-[#7f66ff]"}>{f.kind === "link" ? <MenuIconLink /> : <MenuIconDocument />}</span>
                      <span className="line-clamp-2 w-full break-all text-[10px] text-ink-muted">{f.name}</span>
                    </>
                  )}
                </a>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">No files, links or documents yet.</p>
          )}
        </div>

        {/* People */}
        <div className="px-4 py-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-charcoal">
              {people.length} {people.length === 1 ? "person" : "people"}
            </span>
            {canManage && !adding && (
              <button type="button" onClick={() => (setAdding(true), setPicked([]))} className="flex items-center gap-1.5 rounded-md bg-green px-3 py-1.5 text-sm font-medium text-charcoal hover:opacity-90" data-testid="discussion-add-people">
                <IconPlus /> Add people
              </button>
            )}
          </div>
          {t.kind === "project" && <p className="mb-2 text-xs text-ink-muted">Everyone on {t.client?.name ?? "the client"}&apos;s team can also read this discussion.</p>}
          {t.kind === "client_staff" && <p className="mb-2 text-xs text-ink-muted">{t.client?.name ?? "The client"} reads and replies to this chat in their Messages. Their Client Manager can read it too.</p>}

          {adding && (
            <div className="mb-3 rounded-lg border border-border bg-canvas/50 p-3" data-testid="discussion-add-panel">
              <p className="mb-2 text-sm font-medium text-charcoal">Pick people to add</p>
              {!options.data ? (
                <LoadState loading={options.loading} error={options.error} />
              ) : addable.length ? (
                <ul className="max-h-56 overflow-y-auto">
                  {addable.map((p) => (
                    <li key={p.id}>
                      <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-canvas">
                        <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} />
                        <Avatar name={p.name} size="h-7 w-7" />
                        <span className="text-sm text-charcoal">{p.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">Everyone on the team is already in this discussion.</p>
              )}
              <div className="mt-3 flex items-center gap-2">
                <button type="button" disabled={busy || !picked.length} onClick={() => save({ addIds: picked }, () => setAdding(false))} className="rounded-md bg-green px-3 py-1.5 text-sm font-medium text-charcoal hover:opacity-90 disabled:opacity-50" data-testid="discussion-add-confirm">
                  {busy ? "Adding…" : `Add${picked.length ? ` ${picked.length}` : ""}`}
                </button>
                <button type="button" onClick={() => setAdding(false)} className="px-2 text-sm text-ink-muted hover:text-ink">
                  Cancel
                </button>
              </div>
            </div>
          )}

          <ul data-testid="discussion-people">
            {people.map((p) => {
              const starter = t.startedBy?.id === p.id;
              return (
                <li key={p.id} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-canvas" data-person={p.name}>
                  <Avatar name={p.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-charcoal">
                      {p.name}
                      {p.id === meId ? " (You)" : ""}
                    </span>
                    {starter && <span className="block text-xs text-ink-muted">Started this discussion</span>}
                  </span>
                  {canManage && !starter && (
                    <>
                      {confirmRemove === p.id ? (
                        <span className="flex items-center gap-2 text-xs">
                          <span className="text-ink-muted">Remove?</span>
                          <button type="button" disabled={busy} onClick={() => save({ removeIds: [p.id] }, () => setConfirmRemove(undefined))} className="rounded-md bg-red/20 px-2 py-1 font-medium text-charcoal hover:bg-red/30" data-testid="discussion-remove-yes">
                            Yes, remove
                          </button>
                          <button type="button" onClick={() => setConfirmRemove(undefined)} className="text-ink-muted hover:text-ink">
                            No
                          </button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => setConfirmRemove(p.id)} className="rounded-md px-2 py-1 text-xs text-red hover:bg-red/10" aria-label={`Remove ${p.name}`} data-testid="discussion-remove">
                          Remove
                        </button>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {error && <p className="mt-2 text-sm text-red">{error}</p>}
          {!canManage && <p className="mt-3 text-xs text-ink-muted">Only the person who started this discussion, the Founder or an Admin can change the title or the people.</p>}
        </div>
      </div>
    </aside>
  );
}

/** One discussion: header (← on phone/tablet, search, ⋮), messages as bubbles, and the WhatsApp-style reply bar. */
function DiscussionPanel({ id, onBack, onPosted, onOpened }: { id: string; onBack: () => void; onPosted: () => void; onOpened: () => void }) {
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
  const [infoOpen, setInfoOpen] = useState(false);
  const [toRequest, setToRequest] = useState<{ id: string; body: string }>();
  const { me, canNew, openNew, notify } = useActions();
  const canRequest = me.roles.some((r) => ["founder", "admin", "am_lead", "account_manager"].includes(r));
  // v60: "Open Client 360" only for the people who have Client 360 in their menu (same roles as the team layout).
  const canClient360 = me.roles.some((r) => ["founder", "admin", "am_lead", "account_manager", "finance"].includes(r));
  const end = useRef<HTMLLIElement>(null);
  const t = fresh ?? loaded.data;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [t?.messages.length]);

  // Opening it marked it read on the server: refresh the list once so its unread count clears.
  const opened = !!loaded.data;
  const onOpenedRef = useRef(onOpened);
  useEffect(() => {
    onOpenedRef.current = onOpened;
  }, [onOpened]);
  useEffect(() => {
    if (opened) onOpenedRef.current();
  }, [opened]);

  // v53: new messages and ticks show within a second while people are chatting (someone wrote in the last 2 minutes,
  // or you are typing), and within 3 seconds when it is quiet. Nothing is checked while the tab is not on screen.
  // While the tab is open and looked at, the server knows this person is reading it, so they get no notification for
  // it; in another tab, app or window, they do.
  const typedAt = useRef(0);
  useEffect(() => {
    if (body) typedAt.current = Date.now();
  }, [body]);
  // My messages not yet seen by everyone: only then does someone else reading it change what is on screen (the ticks).
  const waitingForTicks = useRef(false);
  useEffect(() => {
    waitingForTicks.current = !!t?.messages.some((m) => m.mine && !m.seen);
  }, [t]);
  useEffect(() => {
    let stopped = false;
    let lastMessage: string | null | undefined;
    let lastRead = 0;
    let busy = false;
    let changedAt = Date.now();
    let beatAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const looking = () => document.visibilityState === "visible" && document.hasFocus();
    const tick = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const now = Date.now();
        const active = looking();
        const beat = !active || now - beatAt >= BEAT_MS;
        if (active && beat) beatAt = now;
        const p = await api.ops.threads.pulse(id, active, beat);
        const newMessage = lastMessage !== undefined && p.last !== lastMessage;
        const newTicks = p.read !== lastRead && waitingForTicks.current;
        if (lastMessage !== undefined && (newMessage || newTicks) && !stopped) {
          // A new message keeps the quick checks going; someone reading it only redraws the ticks.
          if (newMessage) changedAt = Date.now();
          setFresh(await api.ops.threads.get(id));
          onOpenedRef.current();
        }
        lastMessage = p.last;
        lastRead = p.read;
      } catch {
        // offline or signed out: the next tick tries again
      } finally {
        busy = false;
      }
    };
    const loop = () => {
      if (stopped) return;
      const chatting = Date.now() - changedAt < CHATTING_MS || Date.now() - typedAt.current < TYPING_MS;
      timer = setTimeout(async () => {
        if (document.visibilityState === "visible") await tick();
        loop();
      }, chatting ? FAST_MS : QUIET_MS);
    };
    const away = () => {
      beatAt = 0;
      if (!stopped) api.ops.threads.pulse(id, false).catch(() => {});
    };
    const onVisibility = () => (document.hidden ? away() : void tick());
    void tick();
    loop();
    window.addEventListener("blur", away);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("blur", away);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", onVisibility);
      away();
      stopped = true;
    };
  }, [id]);

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
    t.kind === "client_staff"
      ? `Chat with ${t.client?.name ?? "the client"} · they see every message here`
      : t.kind === "internal"
      ? `Internal${t.client ? ` · ${t.client.name}` : ""} · ${people} ${people === 1 ? "person" : "people"}${people ? `: ${t.participants.join(", ")}` : ""}`
      : `Project · ${t.client?.name ?? ""}${t.engagement ? ` · ${t.engagement}` : ""} · the client's team can read this`;
  const shown = find.trim() ? t.messages.filter((m) => m.body.toLowerCase().includes(find.trim().toLowerCase()) || m.author.toLowerCase().includes(find.trim().toLowerCase())) : t.messages;

  return (
    <div className="relative flex flex-col lg:h-full">
      {/* Header: tap the name to open Discussion info (like WhatsApp's group info) */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        {back}
        <button type="button" onClick={() => setInfoOpen(true)} className="min-w-0 flex-1 text-left" aria-label={`Discussion info: ${t.title}`} data-testid="discussion-info-open">
          <span className="block truncate text-base font-semibold text-charcoal">{t.title}</span>
          <span className="block truncate text-xs text-ink-muted">{subtitle}</span>
        </button>
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
        {t.client && canClient360 && <RowMenu label="Discussion options" items={[{ key: "client", label: "Open Client 360", href: `/team/clients/${t.client.id}` }]} />}
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
              {!m.mine && (
                <p className="mb-0.5 text-xs font-semibold text-charcoal">
                  {m.author}
                  {m.fromClient && <span className="ml-1 font-normal text-ink-muted">· {t.client?.name}</span>}
                </p>
              )}
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
                {m.mine && <Ticks seen={!!m.seen} />}
                <RowMenu
                  label="Message actions"
                  className="align-middle"
                  align={m.mine ? "right" : "left"}
                  items={[
                    { key: "task", label: "Create task", hidden: !canNew("task"), onSelect: () => openNew("task", { title: m.body.split("\n")[0].slice(0, 120), description: m.body, source: `message:${m.id}`, clientId: t.client?.id }) },
                    { key: "request", label: "Create request", hidden: !canRequest || t.kind === "internal" || !t.client, onSelect: () => setToRequest({ id: m.id, body: m.body }) },
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
          <PendingFiles files={files} onRemove={(fid) => setFiles((x) => x.filter((y) => y.id !== fid))} />
          {files.length > 0 && <span className="text-xs text-ink-muted">{t.kind === "internal" ? "Only the people in this discussion see the files (also in their Files)." : t.kind === "client_staff" ? "The client gets these files with your message." : "Everyone on this client's team sees the files (also in their Files)."}</span>}
          <div className="flex items-end gap-2">
            <div className="relative">
              <button
                type="button"
                onClick={() => setAttachOpen((x) => !x)}
                className={`mb-1 rounded-full p-2 text-charcoal hover:bg-canvas ${attachOpen ? "bg-canvas" : ""}`}
                aria-label="Attach files or add a link"
                aria-haspopup="menu"
                aria-expanded={attachOpen}
                data-testid="discussion-attach-toggle"
              >
                <IconPlus />
              </button>
              {attachOpen && (
                <AttachMenu
                  limit={5 - files.length}
                  upload={(f) => api.ops.threads.attach(id, f)}
                  addLink={(url) => api.ops.threads.link(id, { url })}
                  // v60: CRM files in team discussions only (never sends an internal file to a client chat).
                  crm={t.kind === "client_staff" ? undefined : { clientId: t.client?.id ?? null, clientName: t.client?.name ?? null, pick: (fileId) => api.ops.threads.crmFile(id, { fileId }) }}
                  onAdded={(f) => setFiles((x) => [...x, f])}
                  onError={setError}
                  onClose={() => setAttachOpen(false)}
                />
              )}
            </div>
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
      {toRequest && t.client && <MessageToRequestDrawer message={toRequest} clientId={t.client.id} onClose={() => setToRequest(undefined)} onDone={(m) => (notify(m), loaded.reload(), setFresh(undefined))} />}
      {infoOpen && (
        <DiscussionInfo
          t={t}
          meId={me.id}
          onClose={() => setInfoOpen(false)}
          onChanged={(v) => {
            setFresh(v);
            onPosted();
          }}
        />
      )}
    </div>
  );
}
