"use client";

// v20 hardening: who sees which sensitive field (the permission editor), "view as" a person, and sign-in rules.
import { useEffect, useMemo, useState } from "react";
import { FIELD_MODES, TWO_FACTOR_ROLES, fieldModeLabels, type FieldAccessView, type FieldMode, type OrgUser, type ViewAsView } from "@bmu/shared";
import { Panel, Tabs } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

type Msg = { ok: boolean; text: string } | undefined;
const Note = ({ msg }: { msg: Msg }) => (msg ? <p className={`mt-3 text-sm ${msg.ok ? "text-ink" : "text-red"}`}>{msg.text}</p> : null);
const tone: Record<FieldMode, string> = { edit: "bg-surface-raised", read: "bg-amber/15", hidden: "bg-red/10" };

export default function SecurityAdminPage() {
  const [tab, setTab] = useState<"fields" | "view" | "signin">("fields");
  return (
    <>
      <PageTitle title="Security" subtitle="Field-level permissions, view as a person, and sign-in rules. The same rules apply on the website, the app, the API, search and AI." />
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "fields", label: "Field access" },
          { value: "view", label: "View as" },
          { value: "signin", label: "Sign-in rules" },
        ]}
      />
      <div className="mt-6">{tab === "fields" ? <FieldAccess /> : tab === "view" ? <ViewAs /> : <SignInRules />}</div>
    </>
  );
}

function FieldAccess() {
  const data = useLoad(() => api.securityAdmin.fields(), { live: false });
  const [fresh, setFresh] = useState<FieldAccessView>();
  const [changes, setChanges] = useState<Record<string, Record<string, FieldMode>>>({});
  const [group, setGroup] = useState<"team" | "client">("team");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>();
  const v = fresh ?? data.data;
  const count = Object.values(changes).reduce((n, r) => n + Object.keys(r).length, 0);
  const fields = useMemo(() => (v?.fields ?? []).filter((f) => !q.trim() || `${f.label} ${f.area}`.toLowerCase().includes(q.trim().toLowerCase())), [v, q]);
  if (!v) return <LoadState loading={data.loading} error={data.error} />;
  const roles = v.roles.filter((r) => (group === "client" ? r.client : !r.client));

  const mode = (key: string, role: string) => changes[key]?.[role] ?? v.fields.find((f) => f.key === key)!.modes[role];
  const set = (key: string, role: string, m: FieldMode) =>
    setChanges((c) => {
      const orig = v.fields.find((f) => f.key === key)!.modes[role];
      const row = { ...(c[key] ?? {}) };
      if (m === orig) delete row[role];
      else row[role] = m;
      const next = { ...c, [key]: row };
      if (!Object.keys(row).length) delete next[key];
      return next;
    });

  async function save() {
    setBusy(true);
    setMsg(undefined);
    try {
      const full = Object.fromEntries(Object.keys(changes).map((k) => [k, { ...v!.fields.find((f) => f.key === k)!.modes, ...changes[k] }]));
      setFresh(await api.securityAdmin.saveFields(full));
      setChanges({});
      setMsg({ ok: true, text: "Saved. The new rules apply straight away everywhere." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Who sees which field"
      subtitle="Can change, Can see (read-only) or Hidden, per role. Hidden fields are removed by the server, so they never reach the website, the app, the API, search results or AI answers. The Founder always keeps full access."
      action={
        <div className="flex items-center gap-2">
          {count > 0 && <span className="text-sm text-ink-muted">{count} unsaved</span>}
          <Button variant="secondary" disabled={!count || busy} onClick={() => setChanges({})}>
            Undo
          </Button>
          <Button disabled={!count || busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Tabs value={group} onChange={setGroup} options={[{ value: "team", label: "Team roles" }, { value: "client", label: "Client roles" }]} />
        <Input className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a field" aria-label="Find a field" />
      </div>
      <div className="overflow-x-auto border border-border">
        <table className="text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.08em] text-ink-muted">
              <th className="sticky left-0 z-10 min-w-[220px] bg-surface-raised px-3 py-2">Field</th>
              {roles.map((r) => (
                <th key={r.id} className="min-w-[104px] px-2 py-2 font-medium normal-case tracking-normal">
                  {r.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.key} className="border-b border-border align-top">
                <td className="sticky left-0 z-10 bg-surface-raised px-3 py-2">
                  <span className="font-medium">{f.label}</span>
                  <span className="block text-xs text-ink-muted">{f.area}</span>
                </td>
                {roles.map((r) => {
                  const m = mode(f.key, r.id);
                  const changed = changes[f.key]?.[r.id] !== undefined;
                  return (
                    <td key={r.id} className={`px-1 py-1 ${tone[m]}`}>
                      <select
                        aria-label={`${f.label} for ${r.label}`}
                        value={m}
                        disabled={r.id === "founder"}
                        onChange={(e) => set(f.key, r.id, e.target.value as FieldMode)}
                        className={`w-full bg-transparent px-1 py-1 text-xs ${changed ? "font-semibold underline" : ""}`}
                      >
                        {FIELD_MODES.map((x) => (
                          <option key={x} value={x}>
                            {fieldModeLabels[x]}
                          </option>
                        ))}
                      </select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note msg={msg} />
    </Panel>
  );
}

function ViewAs() {
  const users = useLoad(() => api.org.users(), { live: false });
  const [id, setId] = useState("");
  const [view, setView] = useState<{ id: string; data?: ViewAsView; error?: string }>();
  useEffect(() => {
    if (!id) return;
    let live = true;
    api.securityAdmin.viewAs(id).then(
      (data) => live && setView({ id, data }),
      (e: Error) => live && setView({ id, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [id]);
  const people = (users.data ?? []).filter((u: OrgUser) => u.status === "active");
  const v = id && view?.id === id ? view.data : null;
  return (
    <div className="grid gap-6">
      <Panel title="View as a person" subtitle="See what someone can open and which sensitive fields they see, without signing in as them.">
        <Select value={id} onChange={(e) => setId(e.target.value)} aria-label="Person" className="max-w-md">
          <option value="">Choose a person…</option>
          {people.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} · {u.roles.map((r) => r.name).join(", ")}
            </option>
          ))}
        </Select>
        {id && <LoadState loading={view?.id !== id} error={view?.id === id ? view.error : undefined} />}
      </Panel>
      {v && (
        <>
          <Panel title={`Fields ${v.person.name} sees`}>
            <ul className="grid gap-1 sm:grid-cols-2">
              {v.fields.map((f) => (
                <li key={f.key} className="flex items-center justify-between gap-3 border border-border px-3 py-2 text-sm">
                  {f.label}
                  <Badge tone={f.mode === "edit" ? "green" : f.mode === "read" ? "amber" : "red"}>{fieldModeLabels[f.mode]}</Badge>
                </li>
              ))}
            </ul>
          </Panel>
          {v.sample && (
            <Panel title={`A real record as ${v.person.name.split(" ")[0]} sees it`} subtitle={v.sample.title}>
              {v.sample.hiddenKeys.length > 0 && <p className="mb-2 text-sm">Removed for this person: {v.sample.hiddenKeys.join(", ")}</p>}
              <pre className="max-h-80 overflow-auto border border-border bg-surface p-3 text-xs">{JSON.stringify(v.sample.shown, null, 2)}</pre>
            </Panel>
          )}
          <Panel title="What they can do" flush>
            <ul className="divide-y divide-border">
              {v.capabilities.map((c) => (
                <li key={c.capability} className="flex items-center justify-between px-4 py-2 text-sm">
                  {c.label}
                  <span className={c.scope === "none" ? "text-ink-muted" : ""}>{c.scope === "none" ? "No access" : c.scope}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </div>
  );
}

function SignInRules() {
  const all = useLoad(() => api.settings.all(), { live: false });
  const users = useLoad(() => api.org.users(), { live: false });
  const [roles, setRoles] = useState<string[]>();
  const [days, setDays] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>();
  const [who, setWho] = useState("");
  if (!all.data) return <LoadState loading={all.loading} error={all.error} />;
  const sec = all.data.security;
  const picked = roles ?? sec.require2faRoles;
  const sessionDays = days ?? sec.sessionDays;
  const teamRoles = Array.from(new Set((users.data ?? []).flatMap((u) => u.roles.map((r) => r.baseRole)))).sort();
  const choices = Array.from(new Set([...TWO_FACTOR_ROLES, ...teamRoles]));

  async function save() {
    setBusy(true);
    setMsg(undefined);
    try {
      await api.settings.save("security", { require2faRoles: picked, sessionDays });
      setMsg({ ok: true, text: "Saved. People in these roles are asked to set up two-step sign-in the next time they open BMU Hub." });
      all.reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6">
      <Panel title="Two-step sign-in" subtitle="Roles ticked here must add an authenticator app or a passkey before they can use BMU Hub. Recommended: Founder, Branch Manager and Finance.">
        <div className="grid gap-1 sm:grid-cols-3">
          {choices.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[#8BB72C]" checked={picked.includes(r)} onChange={() => setRoles(picked.includes(r) ? picked.filter((x) => x !== r) : [...picked, r])} />
              {r.replaceAll("_", " ")}
            </label>
          ))}
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm">
          Keep people signed in for
          <Input type="number" min={1} max={90} value={sessionDays} onChange={(e) => setDays(Number(e.target.value))} className="w-20" />
          days
        </label>
        <div className="mt-4">
          <Button disabled={busy || !all.data.canEdit.security} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
        <Note msg={msg} />
      </Panel>
      <Panel title="Sign someone out everywhere" subtitle="For a lost phone or someone leaving. Their devices stop working straight away.">
        <div className="flex max-w-xl flex-wrap gap-2">
          <Select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person to sign out" className="min-w-0 flex-1">
            <option value="">Choose a person…</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            disabled={!who}
            onClick={() =>
              void api.security.signOutUser(who).then(
                (r) => setMsg({ ok: true, text: `Signed out of ${r.signedOut} device${r.signedOut === 1 ? "" : "s"}.` }),
                (e: Error) => setMsg({ ok: false, text: e.message }),
              )
            }
          >
            Sign out everywhere
          </Button>
        </div>
      </Panel>
    </div>
  );
}
