"use client";

// v17 shared inbox: WhatsApp and email conversations, each linked to the right client or lead, with templates,
// an AI (or basic) reply draft, assignment and a development simulator.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { fillTemplateVars, inboxChannelLabels, TEMPLATE_VARIABLES, type InboxDetail, type InboxList, type InboxQuery, type InboxRow, type ReplyTemplateView } from "@bmu/shared";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { when } from "@/components/request-bits";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const BOXES: { key: string; label: string; q: InboxQuery; count: keyof InboxList["counts"] }[] = [
  { key: "open", label: "All open", q: {}, count: "open" },
  { key: "mine", label: "Mine", q: { box: "mine" }, count: "mine" },
  { key: "unassigned", label: "Unassigned", q: { box: "unassigned" }, count: "unassigned" },
  { key: "closed", label: "Closed", q: { status: "closed" }, count: "closed" },
];

const statusLabel: Record<string, string> = { received: "", queued: "Waiting to send (WhatsApp not connected)", sent: "Sent", simulated: "Not sent (no email server)", failed: "Failed" };

export function InboxScreen({ initialId }: { initialId: string | null }) {
  const [box, setBox] = useState("open");
  const [channel, setChannel] = useState<"" | "whatsapp" | "email">("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(initialId);
  const query: InboxQuery = { ...BOXES.find((b) => b.key === box)!.q, ...(channel ? { channel } : {}), ...(q.trim() ? { q: q.trim() } : {}) };
  const key = JSON.stringify(query);
  return (
    <>
      <PageTitle title="Inbox" subtitle="WhatsApp and email from clients and leads, in one place. Messages from known clients also land on their message thread." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} aria-label="Channel">
          <option value="">All channels</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="email">Email</option>
        </Select>
        <Input className="max-w-xs" placeholder="Search name, number or text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the inbox" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <ConversationList key={key} query={query} box={box} setBox={setBox} selected={selected} onSelect={setSelected} />
        <div>{selected ? <Conversation key={selected} id={selected} /> : <p className="border border-dashed border-border p-8 text-center text-sm text-ink-muted">Pick a conversation.</p>}</div>
      </div>
    </>
  );
}

function ConversationList({ query, box, setBox, selected, onSelect }: { query: InboxQuery; box: string; setBox: (b: string) => void; selected: string | null; onSelect: (id: string) => void }) {
  const list = useLoad(() => api.inbox.list(query), { live: ["Conversation", "ConversationMessage"] });
  const router = useRouter();
  if (!list.data) return <LoadState loading={list.loading} error={list.error} />;
  const d = list.data;
  const pick = (c: InboxRow) => {
    onSelect(c.id);
    router.replace(`/team/inbox?c=${c.id}`, { scroll: false });
  };
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1" role="tablist">
        {BOXES.map((b) => (
          <button key={b.key} role="tab" aria-selected={box === b.key} onClick={() => setBox(b.key)} className={`px-3 py-1.5 text-sm ${box === b.key ? "bg-charcoal text-ivory" : "border border-border"}`}>
            {b.label} <span className="opacity-70">{d.counts[b.count]}</span>
          </button>
        ))}
      </div>
      {!d.whatsappLive && <p className="mb-3 bg-amber/20 px-3 py-2 text-xs">WhatsApp is not connected yet, so replies wait in the WhatsApp queue. See the README to connect it.</p>}
      <div className="border-t border-border" data-testid="inbox-list">
        {d.items.map((c) => (
          <button key={c.id} onClick={() => pick(c)} className={`flex w-full items-start justify-between gap-3 border-b border-border px-2 py-3 text-left text-sm hover:bg-canvas/40 ${selected === c.id ? "bg-canvas/60" : ""}`}>
            <div className="min-w-0">
              <p className={c.unread ? "font-semibold" : "font-medium"}>
                {c.name ?? c.display}
                {!!c.unread && <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center bg-green px-1.5 text-[11px] font-bold text-charcoal">{c.unread}</span>}
              </p>
              <p className="text-xs text-ink-muted">
                {inboxChannelLabels[c.channel]} · {c.client ? c.client.name : c.lead ? `Lead: ${c.lead.name}` : "Not linked"}
                {c.assignee ? ` · ${c.assignee.name}` : " · Unassigned"}
              </p>
              {c.last && <p className="truncate text-xs text-ink-muted">{c.last.direction === "out" ? "You: " : ""}{c.last.body}</p>}
            </div>
            <span className="shrink-0 text-xs text-ink-muted">{when.format(new Date(c.lastMessageAt))}</span>
          </button>
        ))}
        {d.items.length === 0 && <p className="py-8 text-center text-sm text-ink-muted">Nothing here.</p>}
      </div>
      {d.canSimulate && <Simulator onDone={(id) => onSelect(id)} />}
      <Templates />
    </div>
  );
}

function Conversation({ id }: { id: string }) {
  const loaded = useLoad(() => api.inbox.get(id), { live: ["Conversation", "ConversationMessage"] });
  const [fresh, setFresh] = useState<InboxDetail>();
  const [seen, setSeen] = useState(loaded.data);
  if (seen !== loaded.data) {
    setSeen(loaded.data);
    setFresh(undefined);
  }
  const d = fresh ?? loaded.data;
  if (!d) return <LoadState loading={loaded.loading} error={loaded.error} />;
  return (
    <div data-testid="conversation">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <h2 className="font-display text-xl">{d.name ?? d.display}</h2>
          <p className="text-sm text-ink-muted">
            {inboxChannelLabels[d.channel]} · {d.display}
            {d.client && (
              <>
                {" · "}
                <Link className="underline" href={`/team/clients/${d.client.id}`}>
                  {d.client.name}
                </Link>
              </>
            )}
            {d.lead && (
              <>
                {" · "}
                <Link className="underline" href={`/team/leads/${d.lead.id}`}>
                  Lead: {d.lead.name}
                </Link>
              </>
            )}
            {d.threadId && (
              <>
                {" · "}
                <Link className="underline" href={`/team/messages/${d.threadId}`}>
                  Client thread
                </Link>
              </>
            )}
          </p>
        </div>
        <Manage d={d} onSaved={setFresh} />
      </div>
      <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-1" data-testid="conversation-messages">
        {d.messages.map((m) => (
          <div key={m.id} className={`max-w-[85%] px-3 py-2 text-sm ${m.direction === "out" ? "ml-auto bg-charcoal text-ivory" : "bg-canvas"}`}>
            {m.subject && <p className="mb-1 text-xs font-semibold">{m.subject}</p>}
            <p className="whitespace-pre-wrap">{m.body}</p>
            <p className={`mt-1 text-[11px] ${m.direction === "out" ? "text-ivory/70" : "text-ink-muted"}`}>
              {m.author ? `${m.author} · ` : ""}
              {when.format(new Date(m.at))}
              {m.direction === "out" && statusLabel[m.status] ? ` · ${statusLabel[m.status]}` : ""}
              {m.error ? ` · ${m.error}` : ""}
            </p>
          </div>
        ))}
      </div>
      {d.status === "open" && <ReplyBox d={d} onSent={setFresh} />}
    </div>
  );
}

function Manage({ d, onSaved }: { d: InboxDetail; onSaved: (d: InboxDetail) => void }) {
  const clients = useLoad(() => api.clients.list().catch(() => []), { live: false });
  const [error, setError] = useState<string>();
  const save = (body: Parameters<typeof api.inbox.update>[1]) =>
    api.inbox
      .update(d.id, body)
      .then((x) => {
        setError(undefined);
        onSaved(x);
      })
      .catch((e: Error) => setError(e.message));
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Select aria-label="Assign to" value={d.assignee?.id ?? ""} onChange={(e) => save({ assigneeId: e.target.value || null })}>
        <option value="">Unassigned</option>
        {d.people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      {!d.client && !!clients.data?.length && (
        <Select aria-label="Link to a client" value="" onChange={(e) => e.target.value && save({ clientOrgId: e.target.value })}>
          <option value="">Link to a client…</option>
          {clients.data.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      )}
      <Button variant="secondary" onClick={() => save({ status: d.status === "open" ? "closed" : "open" })}>
        {d.status === "open" ? "Close" : "Reopen"}
      </Button>
      {error && <p className="w-full text-xs text-red">{error}</p>}
    </div>
  );
}

function ReplyBox({ d, onSent }: { d: InboxDetail; onSent: (d: InboxDetail) => void }) {
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [ai, setAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const templates = d.templates.filter((t) => t.channel === "any" || t.channel === d.channel);
  const send = async () => {
    setBusy(true);
    try {
      onSent(await api.inbox.reply(d.id, { body, subject: d.channel === "email" && subject.trim() ? subject.trim() : undefined, aiDrafted: ai }));
      setBody("");
      setSubject("");
      setAi(false);
      setNote(undefined);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const draft = async () => {
    setBusy(true);
    try {
      const r = await api.inbox.draft(d.id);
      setBody(r.body);
      setAi(!r.basic);
      setNote(r.basic ? "A simple starting reply (AI is off). Edit it before sending." : "AI draft. Read and edit it before sending.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="mb-2 flex flex-wrap gap-2">
        {templates.length > 0 && (
          <Select aria-label="Insert a template" value="" onChange={(e) => {
            const t = templates.find((x) => x.id === e.target.value);
            if (t) setBody(fillTemplateVars(t.body, d.variables));
          }}>
            <option value="">Insert template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
        <Button variant="secondary" onClick={draft} disabled={busy} data-testid="inbox-draft">
          Draft a reply
        </Button>
      </div>
      {d.channel === "email" && <Input className="mb-2" placeholder={`Subject (default: Re: …)`} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />}
      <textarea className="h-28 w-full border border-border bg-surface-raised p-3 text-sm" placeholder={`Reply by ${inboxChannelLabels[d.channel]}`} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Reply" />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs text-ink-muted">{note}</p>
        <Button onClick={send} disabled={busy || !body.trim()} data-testid="inbox-send">
          Send {inboxChannelLabels[d.channel]}
        </Button>
      </div>
    </div>
  );
}

function Simulator({ onDone }: { onDone: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<"whatsapp" | "email">("whatsapp");
  const [from, setFrom] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  if (!open)
    return (
      <button className="mt-4 text-xs underline" onClick={() => setOpen(true)}>
        Test: pretend a message arrived (development only)
      </button>
    );
  return (
    <div className="mt-4 space-y-2 border border-dashed border-border p-3 text-sm" data-testid="inbox-simulator">
      <p className="text-xs text-ink-muted">Development only. Use a client&apos;s phone number or email to see it land on their thread.</p>
      <Select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} aria-label="Simulated channel">
        <option value="whatsapp">WhatsApp</option>
        <option value="email">Email</option>
      </Select>
      <Input placeholder={channel === "whatsapp" ? "From number, e.g. 9876543210" : "From email"} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
      <textarea className="h-16 w-full border border-border bg-surface-raised p-2" placeholder="Message" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Simulated message" />
      {error && <p className="text-xs text-red">{error}</p>}
      <Button
        onClick={() =>
          api.inbox
            .simulate({ channel, from, body, subject: channel === "email" ? "Test email" : undefined })
            .then((d) => {
              setBody("");
              setError(undefined);
              onDone(d.id);
            })
            .catch((e: Error) => setError(e.message))
        }
        disabled={!from.trim() || !body.trim()}
      >
        Receive it
      </Button>
    </div>
  );
}

function Templates() {
  const list = useLoad(() => api.inbox.templates(), { live: ["ReplyTemplate"] });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [channel, setChannel] = useState<ReplyTemplateView["channel"]>("any");
  const [error, setError] = useState<string>();
  return (
    <div className="mt-6 border-t border-border pt-4">
      <button className="text-sm font-medium underline" onClick={() => setOpen(!open)}>
        Reply templates ({list.data?.length ?? 0})
      </button>
      {open && (
        <div className="mt-3 space-y-3 text-sm">
          {list.data?.map((t) => (
            <div key={t.id} className="border border-border p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">
                  {t.name} {t.channel !== "any" && <Badge>{inboxChannelLabels[t.channel]}</Badge>}
                </p>
                <button className="text-xs text-ink-muted underline" onClick={() => api.inbox.deleteTemplate(t.id).then(list.reload)}>
                  Delete
                </button>
              </div>
              <p className="whitespace-pre-wrap text-xs text-ink-muted">{t.body}</p>
            </div>
          ))}
          <div className="space-y-2 border border-dashed border-border p-2">
            <Input placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Template name" />
            <Select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} aria-label="Template channel">
              <option value="any">Any channel</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
            </Select>
            <textarea className="h-20 w-full border border-border bg-surface-raised p-2" placeholder="Hi {{first_name}}, …" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Template text" />
            <p className="text-xs text-ink-muted">You can use {TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(", ")}.</p>
            {error && <p className="text-xs text-red">{error}</p>}
            <Button
              onClick={() =>
                api.inbox
                  .saveTemplate({ name, body, channel })
                  .then(() => {
                    setName("");
                    setBody("");
                    setError(undefined);
                    list.reload();
                  })
                  .catch((e: Error) => setError(e.message))
              }
              disabled={!name.trim() || !body.trim()}
            >
              Add template
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
