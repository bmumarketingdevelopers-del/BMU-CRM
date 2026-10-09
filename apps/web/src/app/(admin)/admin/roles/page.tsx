"use client";

import { useState } from "react";
import { ACCESS_SCOPES, type RoleWithPermissions } from "@bmu/shared";
import { Badge, Button, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { useActions } from "@/components/actions/actions-provider";
import { CustomRoleDrawer } from "@/components/people/custom-role-drawer";

const capabilityLabels: Record<string, string> = {
  leads_pipeline: "Leads & pipeline",
  proposal_price_override: "Proposal price override",
  mark_rcd_gate1: "Mark RCD (Gate 1)",
  plan_and_calendar: "Plan & calendar",
  tasks_files: "Tasks & files",
  qc_pass_fail: "QC pass / fail",
  send_draft_to_client: "Send draft to client",
  approve_creative: "Approve creative",
  quote_addon: "Quote add-on",
  approve_addon_quote: "Approve add-on quote",
  invoices_payments: "Invoices & payments",
  revenue_margins: "Revenue & margins",
  users_roles_hierarchy: "Users, roles, hierarchy",
  catalogue_pricing_engine: "Catalogue & pricing",
  sop_checklists_flow_templates: "SOPs, checklists, flows",
  audit_log: "Audit log",
  credential_vault_reveal: "Credential vault reveal",
};

const tone = (scope: string) =>
  scope === "none" ? "text-ink-muted" : scope === "all" ? "font-semibold" : "";

export default function RolesPage() {
  const roles = useLoad(() => api.org.roles());
  const [error, setError] = useState<string>();
  const [audience, setAudience] = useState<"team" | "client">("team");
  // v11 people: custom roles are made by cloning a role and adjusting scopes; an Admin's go to the Founder.
  const { me } = useActions();
  const [custom, setCustom] = useState<{ from?: RoleWithPermissions } | null>(
    null,
  );
  const canCustom = me.roles.some((r) => r === "founder" || r === "admin");

  async function change(
    role: RoleWithPermissions,
    capability: string,
    scope: string,
  ) {
    setError(undefined);
    try {
      await api.org.setPermission(role.id, capability, scope);
      roles.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const list = (roles.data ?? []).filter(
    (r) => (audience === "client") === r.baseRole.startsWith("client_"),
  );
  const capabilities =
    roles.data?.[0]?.permissions.map((p) => p.capability) ?? [];

  return (
    <>
      <PageTitle
        title="Roles & Permissions"
        subtitle="Scope per capability: none, own, team, department, branch or all. Only the Founder can change these; the API enforces them on every request."
        action={
          <div className="flex flex-wrap gap-2">
            {canCustom && (
              <Button onClick={() => setCustom({})}>New custom role</Button>
            )}
            <Select
              value={audience}
              onChange={(e) => setAudience(e.target.value as typeof audience)}
              aria-label="Audience"
            >
              <option value="team">Team roles</option>
              <option value="client">Client roles</option>
            </Select>
          </div>
        }
      />
      {error && (
        <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">
          {error}
        </p>
      )}
      <LoadState loading={roles.loading} error={roles.error} />
      {roles.data && (
        <div className="overflow-x-auto">
          <table className="bg-surface-raised text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                <th className="sticky left-0 z-10 bg-surface px-3 py-2">
                  Capability
                </th>
                {list.map((r) => (
                  <th
                    key={r.id}
                    className="min-w-28 px-2 py-2 align-bottom font-normal"
                  >
                    <div className="font-semibold">{r.name}</div>
                    {r.isCustom && <Badge tone="green">custom</Badge>}
                    {canCustom &&
                      !r.baseRole.startsWith("client_") &&
                      r.baseRole !== "founder" && (
                        <button
                          type="button"
                          className="mt-1 block text-grey underline"
                          onClick={() => setCustom({ from: r })}
                        >
                          Clone
                        </button>
                      )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {capabilities.map((cap) => (
                <tr key={cap} className="border-b border-border">
                  <td className="sticky left-0 bg-surface-raised px-3 py-2 font-medium">
                    {capabilityLabels[cap] ?? cap}
                  </td>
                  {list.map((r) => {
                    const p = r.permissions.find((x) => x.capability === cap)!;
                    return (
                      <td
                        key={r.id}
                        className="px-2 py-1"
                        title={`Rule in spec: ${p.rule}`}
                      >
                        <Select
                          className={`w-full text-xs ${tone(p.scope)}`}
                          value={p.scope}
                          disabled={r.baseRole === "founder"}
                          onChange={(e) => change(r, cap, e.target.value)}
                        >
                          {ACCESS_SCOPES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </Select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-xs text-ink-muted">
        Hover a cell to see the original rule from the spec, such as &quot;own
        (requires QC pass)&quot;.{" "}
        <Button variant="ghost" onClick={roles.reload}>
          Refresh
        </Button>
      </p>
      {custom && roles.data && (
        <CustomRoleDrawer
          roles={roles.data}
          from={custom.from}
          onClose={() => setCustom(null)}
          onSaved={roles.reload}
        />
      )}
    </>
  );
}
