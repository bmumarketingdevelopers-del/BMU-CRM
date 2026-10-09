"use client";

import Link from "next/link";
import { useState } from "react";
import { clientRoleLabels, type ClientTeamRole, type Me, type NotificationView } from "@bmu/shared";
import { Empty, KeyValues, Panel } from "@/components/dash";
import { NotificationPrefsPanel } from "@/components/service/notification-prefs";
import { ago } from "@/components/workspace/format";
import { Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function ClientProfilePage() {
  const me = useLoad(() => api.auth.me());
  const notes = useLoad(() => api.notifications.list());
  const [fresh, setFresh] = useState<{ unread: number; items: NotificationView[] }>();
  const n = fresh ?? notes.data;
  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle title="Profile & notifications" subtitle="Your details and everything we've told you about." />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <div className="grid content-start gap-6">
          {me.data ? <Details me={me.data} onSaved={me.reload} /> : <LoadState loading={me.loading} error={me.error} />}
          <NotificationPrefsPanel />
        </div>
        <Panel
          title="Notifications"
          subtitle={n ? (n.unread ? `${n.unread} unread` : "All caught up") : undefined}
          action={n && n.unread > 0 ? <Button variant="secondary" className="px-3 py-1 text-xs" onClick={async () => setFresh(await api.notifications.read("all"))}>Mark all read</Button> : undefined}
          flush
        >
          {!n ? (
            <div className="p-5">
              <LoadState loading={notes.loading} error={notes.error} />
            </div>
          ) : n.items.length === 0 ? (
            <Empty>No notifications yet.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {n.items.map((x) => {
                const body = (
                  <div className="flex gap-3">
                    <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 ${x.read ? "bg-transparent" : x.critical ? "bg-red" : "bg-green"}`} />
                    <div className="min-w-0">
                      <p className={`text-sm ${x.read ? "text-ink-muted" : "font-medium"}`}>{x.title}</p>
                      {x.body && <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{x.body}</p>}
                      <p className="mt-1 text-[11px] text-ink-muted">{ago(x.at)}</p>
                    </div>
                  </div>
                );
                return (
                  <li key={x.id}>
                    {x.link ? (
                      <Link href={x.link} className="block px-5 py-3.5 transition-colors hover:bg-canvas/40" onClick={() => !x.read && api.notifications.read([x.id])}>
                        {body}
                      </Link>
                    ) : (
                      <div className="px-5 py-3.5">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Details({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me.name);
  const [phone, setPhone] = useState(me.phone ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const role = me.clientOrg ? (clientRoleLabels[me.clientOrg.role as ClientTeamRole]?.name ?? me.clientOrg.role) : "—";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.workspace.updateMe({ name, phone });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Your details" className="self-start" action={!editing && <Button variant="ghost" className="px-0 py-0 text-xs" onClick={() => setEditing(true)}>Edit</Button>}>
      {editing ? (
        <form onSubmit={save} className="grid gap-3">
          <label className="text-sm">
            <span className="text-ink-muted">Name</span>
            <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
          </label>
          <label className="text-sm">
            <span className="text-ink-muted">Mobile number</span>
            <Input className="mt-1" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="10-digit mobile" />
          </label>
          <p className="text-xs text-ink-muted">To change your email, ask your Account Manager.</p>
          {error && <p className="text-sm text-red">{error}</p>}
          <div className="flex gap-2">
            <Button disabled={busy}>Save</Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <KeyValues
          items={[
            { k: "Name", v: me.name },
            { k: "Email", v: me.email ?? "—" },
            { k: "Mobile", v: me.phone ?? "—" },
            { k: "Company", v: me.clientOrg?.name ?? "—" },
            { k: "Your role", v: role },
          ]}
        />
      )}
    </Panel>
  );
}
