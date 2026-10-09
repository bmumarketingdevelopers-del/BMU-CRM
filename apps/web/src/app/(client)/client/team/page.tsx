"use client";

import { useState } from "react";
import { CLIENT_TEAM_ROLES, clientRoleLabels, type ClientTeamRole, type ClientTeamView } from "@bmu/shared";
import { DataTable, KeyValues, Panel } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ApprovalRuleCard } from "@/components/deliver/approval-rule";

export default function ClientTeamPage() {
  const loaded = useLoad(() => api.clientWorkspace.team());
  const [fresh, setFresh] = useState<ClientTeamView>();
  const [error, setError] = useState<string>();
  const t = fresh ?? loaded.data;

  async function update(userId: string, input: { role?: ClientTeamRole; active?: boolean }) {
    setError(undefined);
    try {
      setFresh(await api.clientWorkspace.updateMember(userId, input));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle title="Team users" subtitle="People from your company who can use this app, and what each of them can do." />
      {!t ? (
        <LoadState loading={loaded.loading} error={loaded.error} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <div className="grid content-start gap-6">
            <Panel title="Your team" subtitle={`${t.members.filter((m) => m.status !== "suspended").length} active`} flush>
              {error && <p className="border-b border-border bg-red/10 px-5 py-2 text-sm">{error}</p>}
              <DataTable
                rows={t.members}
                rowKey={(m) => m.id}
                columns={[
                  {
                    key: "n",
                    header: "Name",
                    cell: (m) => (
                      <span className={m.status === "suspended" ? "text-ink-muted" : ""}>
                        <span className="font-medium">{m.name}</span>
                        {m.isMe && <span className="text-ink-muted"> (you)</span>}
                        <span className="block text-xs text-ink-muted">{m.email ?? m.phone}</span>
                      </span>
                    ),
                  },
                  {
                    key: "r",
                    header: "Role",
                    cell: (m) =>
                      t.canManage && m.status !== "suspended" ? (
                        <Select value={m.role} onChange={(e) => update(m.id, { role: e.target.value as ClientTeamRole })} aria-label={`Role for ${m.name}`}>
                          {CLIENT_TEAM_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {clientRoleLabels[r].name}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        clientRoleLabels[m.role].name
                      ),
                  },
                  { key: "s", header: "Status", cell: (m) => <Badge tone={m.status === "suspended" ? "red" : "green"}>{m.status === "suspended" ? "Deactivated" : "Active"}</Badge> },
                  ...(t.canManage
                    ? [
                        {
                          key: "a",
                          header: "",
                          align: "right" as const,
                          cell: (m: ClientTeamView["members"][number]) =>
                            m.status === "suspended" ? (
                              <Button variant="ghost" className="px-0 py-0 text-xs" onClick={() => update(m.id, { active: true })}>
                                Reactivate
                              </Button>
                            ) : (
                              <Button variant="ghost" className="px-0 py-0 text-xs" onClick={() => confirm(`Deactivate ${m.name}? They will be signed out and lose access.`) && update(m.id, { active: false })}>
                                Deactivate
                              </Button>
                            ),
                        },
                      ]
                    : []),
                ]}
              />
            </Panel>
            {t.canManage ? <InviteForm onDone={setFresh} /> : <p className="text-sm text-ink-muted">Only the account owner can add people or change roles.</p>}
            <ApprovalRuleCard />
          </div>
          <Panel title="What each role can do" className="self-start">
            <KeyValues items={CLIENT_TEAM_ROLES.map((r) => ({ k: clientRoleLabels[r].name, v: <span className="block max-w-[14rem] text-xs font-normal text-ink-muted">{clientRoleLabels[r].can}</span> }))} />
          </Panel>
        </div>
      )}
    </div>
  );
}

function InviteForm({ onDone }: { onDone: (t: ClientTeamView) => void }) {
  const [v, setV] = useState({ name: "", email: "", role: "client_approver" as ClientTeamRole });
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setOk(undefined);
    try {
      onDone(await api.clientWorkspace.invite(v));
      setOk(`${v.name} can now sign in with ${v.email}.`);
      setV({ name: "", email: "", role: "client_approver" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Add a team user" subtitle="They sign in with a one-time code sent to their email">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
        <label className="text-sm">
          <span className="text-ink-muted">Name</span>
          <Input className="mt-1" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required minLength={2} />
        </label>
        <label className="text-sm">
          <span className="text-ink-muted">Work email</span>
          <Input type="email" className="mt-1" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} required />
        </label>
        <label className="text-sm">
          <span className="text-ink-muted">Role</span>
          <Select className="mt-1 block w-full py-2" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value as ClientTeamRole })}>
            {CLIENT_TEAM_ROLES.map((r) => (
              <option key={r} value={r}>
                {clientRoleLabels[r].name}
              </option>
            ))}
          </Select>
        </label>
        <Button disabled={busy}>Add user</Button>
      </form>
      {error && <p className="mt-3 text-sm text-red">{error}</p>}
      {ok && <p className="mt-3 text-sm text-[#5f8a12]">{ok}</p>}
    </Panel>
  );
}
