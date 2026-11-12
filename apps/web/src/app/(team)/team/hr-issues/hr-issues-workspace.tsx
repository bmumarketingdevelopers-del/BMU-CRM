"use client";

import { useState } from "react";
import { HR_ISSUE_CATEGORIES, HR_ISSUE_STATUSES, type HrIssueCategory, type HrIssueStatus, type HrIssueView } from "@bmu/shared";
import { Empty, Panel, Tabs } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const tone = (s: HrIssueStatus) => (s === "resolved" ? "green" : s === "in_progress" ? "amber" : "neutral");

/** v50 Raise an issue with HR. Everyone: raise one and follow it. HR: also the issues raised with HR, to reply and resolve. */
export function HrIssuesWorkspace({ isHr }: { isHr: boolean }) {
  const [view, setView] = useState<"mine" | "inbox">(isHr ? "inbox" : "mine");
  return (
    <div>
      <PageTitle
        title={isHr ? "HR issues" : "Raise an issue with HR"}
        subtitle="Confidential: only you and the HR team see what you raise here. Not your manager, your Department Head or leadership."
      />
      {isHr && (
        <div className="mb-6">
          <Tabs
            value={view}
            onChange={setView}
            options={[
              { value: "inbox", label: "Raised with HR" },
              { value: "mine", label: "Raise your own" },
            ]}
          />
        </div>
      )}
      {view === "inbox" ? <Inbox /> : <Mine />}
    </div>
  );
}

function Mine() {
  const loaded = useLoad(() => api.hrIssues.mine());
  const [fresh, setFresh] = useState<HrIssueView[]>();
  const list = fresh ?? loaded.data;
  const [form, setForm] = useState<{ category: HrIssueCategory; subject: string; details: string }>({ category: "workplace", subject: "", details: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.hrIssues.raise(form);
      setForm({ category: "workplace", subject: "", details: "" });
      setSent(true);
      setFresh(await api.hrIssues.mine());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6">
      <Panel title="Raise an issue" subtitle="HR will be told straight away. You'll get a notification when they reply.">
        <form onSubmit={submit} className="grid gap-4" data-testid="raise-hr-issue">
          <div className="grid gap-4 md:grid-cols-[220px_1fr]">
            <label className="block text-sm">
              <span className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">About</span>
              <Select className="mt-1.5 w-full" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as HrIssueCategory })}>
                {Object.entries(HR_ISSUE_CATEGORIES).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block text-sm">
              <span className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">Short title</span>
              <Input className="mt-1.5 w-full" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} maxLength={120} required minLength={3} placeholder="e.g. Laptop keeps shutting down" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">What happened</span>
            <textarea
              className="mt-1.5 w-full border border-border bg-surface-raised px-3 py-2 text-sm"
              rows={5}
              value={form.details}
              onChange={(e) => setForm({ ...form, details: e.target.value })}
              maxLength={4000}
              required
              minLength={10}
              placeholder="Tell HR what is going on, since when, and what would help."
            />
          </label>
          {error && <p className="text-sm text-red">{error}</p>}
          {sent && !error && <p className="text-sm text-ink-muted">Sent to HR. You can follow it below.</p>}
          <div>
            <Button disabled={busy}>{busy ? "Sending…" : "Send to HR"}</Button>
          </div>
        </form>
      </Panel>
      <Panel title="Your issues">
        {!list ? (
          <LoadState loading={loaded.loading} error={loaded.error} />
        ) : !list.length ? (
          <Empty>You haven&apos;t raised anything with HR.</Empty>
        ) : (
          <ul className="grid gap-4" data-testid="my-hr-issues">
            {list.map((i) => (
              <li key={i.id} className="border border-border p-4">
                <IssueHead i={i} />
                <p className="mt-2 whitespace-pre-wrap text-sm">{i.details}</p>
                {i.response && (
                  <div className="mt-3 border-l-2 border-green bg-canvas/60 px-3 py-2 text-sm">
                    <p className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">Reply from HR{i.handledBy ? ` · ${i.handledBy}` : ""}</p>
                    <p className="mt-1 whitespace-pre-wrap">{i.response}</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function IssueHead({ i }: { i: HrIssueView }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="font-medium">{i.subject}</p>
        <p className="text-xs text-ink-muted">
          {HR_ISSUE_CATEGORIES[i.category]} · raised {when.format(new Date(i.createdAt))}
          {i.from && ` · by ${i.from.name}${i.from.department ? ` (${i.from.department})` : ""}`}
        </p>
      </div>
      <Badge tone={tone(i.status)}>{HR_ISSUE_STATUSES[i.status]}</Badge>
    </div>
  );
}

function Inbox() {
  const [status, setStatus] = useState<"active" | "resolved" | "all">("active");
  return (
    <div className="grid gap-4">
      <Tabs
        value={status}
        onChange={setStatus}
        options={[
          { value: "active", label: "Open" },
          { value: "resolved", label: "Resolved" },
          { value: "all", label: "All" },
        ]}
      />
      <InboxList key={status} status={status} />
    </div>
  );
}

function InboxList({ status }: { status: "active" | "resolved" | "all" }) {
  const loaded = useLoad(() => api.hrIssues.inbox(status === "active" ? undefined : status));
  const [fresh, setFresh] = useState<HrIssueView[]>();
  const list = fresh ?? loaded.data;
  if (!list) return <LoadState loading={loaded.loading} error={loaded.error} />;
  if (!list.length) return <Empty>{status === "active" ? "No open issues. Nothing waiting for HR." : "Nothing here."}</Empty>;
  const replace = (v: HrIssueView) => setFresh(list.map((x) => (x.id === v.id ? v : x)));
  return (
    <ul className="grid gap-4" data-testid="hr-inbox">
      {list.map((i) => (
        <InboxItem key={i.id} i={i} onSaved={replace} />
      ))}
    </ul>
  );
}

function InboxItem({ i, onSaved }: { i: HrIssueView; onSaved: (v: HrIssueView) => void }) {
  const [reply, setReply] = useState(i.response ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function save(status?: HrIssueStatus) {
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await api.hrIssues.update(i.id, { ...(reply.trim() !== (i.response ?? "") ? { response: reply.trim() } : {}), ...(status ? { status } : {}) }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const changed = reply.trim() !== (i.response ?? "");
  return (
    <li className="border border-border bg-surface-raised p-4">
      <IssueHead i={i} />
      <p className="mt-2 whitespace-pre-wrap text-sm">{i.details}</p>
      <label className="mt-4 block text-sm">
        <span className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">Reply to {i.from?.name ?? "them"} (they get a notification)</span>
        <textarea className="mt-1.5 w-full border border-border bg-surface px-3 py-2 text-sm" rows={3} value={reply} onChange={(e) => setReply(e.target.value)} maxLength={4000} />
      </label>
      {error && <p className="mt-2 text-sm text-red">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {changed && (
          <Button className="px-3 py-1.5 text-xs" disabled={busy} onClick={() => save()}>
            Send reply
          </Button>
        )}
        {i.status === "open" && (
          <Button variant="secondary" className="px-3 py-1.5 text-xs" disabled={busy} onClick={() => save("in_progress")}>
            Mark as looking into it
          </Button>
        )}
        {i.status !== "resolved" ? (
          <Button variant="secondary" className="px-3 py-1.5 text-xs" disabled={busy} onClick={() => save("resolved")}>
            {changed ? "Reply and resolve" : "Resolve"}
          </Button>
        ) : (
          <Button variant="ghost" className="px-0 py-1.5 text-xs underline" disabled={busy} onClick={() => save("open")}>
            Reopen
          </Button>
        )}
        {i.handledBy && <span className="text-xs text-ink-muted">Last handled by {i.handledBy}</span>}
      </div>
    </li>
  );
}
