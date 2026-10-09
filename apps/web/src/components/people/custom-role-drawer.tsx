"use client";

/**
 * CustomRoleDrawer: "New custom role" on Roles & Permissions. Clone an existing team role, name it, and adjust the
 * scope per capability. The Founder's roles are created straight away; an Admin's go to the Founder for approval.
 */
import { useState } from "react";
import {
  ACCESS_SCOPES,
  PEOPLE_CAPABILITY_LABELS,
  peopleScopeLabels,
  type AccessScope,
  type RoleWithPermissions,
} from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDrawer, Field, inputCls } from "../actions/action-drawer";
import { useActions } from "../actions/actions-provider";

export function CustomRoleDrawer({
  roles,
  from,
  onClose,
  onSaved,
}: {
  roles: RoleWithPermissions[];
  from?: RoleWithPermissions;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { notify, me } = useActions();
  const team = roles.filter(
    (r) => !r.baseRole.startsWith("client_") && r.baseRole !== "founder",
  );
  const [baseId, setBaseId] = useState(from?.id ?? team[0]?.id ?? "");
  const [name, setName] = useState(from ? `${from.name} (custom)` : "");
  const [scopes, setScopes] = useState<Record<string, AccessScope>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const base = team.find((r) => r.id === baseId);
  const founder = me.roles.includes("founder");

  async function save() {
    setError(undefined);
    setSaving(true);
    try {
      const r = await api.peopleActions.customRole({
        name,
        cloneFromRoleId: baseId,
        scopes,
      });
      notify(r.message);
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionDrawer
      open
      title="New custom role"
      subtitle={
        founder
          ? "Created as soon as you save"
          : "Sent to the Founder for approval"
      }
      onClose={onClose}
      onSubmit={save}
      saving={saving}
      error={error}
      saveLabel={founder ? "Create role" : "Send for approval"}
      testId="custom-role-drawer"
      wide
    >
      <Field
        label="Start from"
        required
        htmlFor="cr-base"
        hint="The new role copies this role's permissions; change any of them below."
      >
        <select
          id="cr-base"
          className={inputCls}
          value={baseId}
          onChange={(e) => {
            setBaseId(e.target.value);
            setScopes({});
          }}
        >
          {team.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Role name" required htmlFor="cr-name">
        <input
          id="cr-name"
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
        />
      </Field>
      {base && (
        <fieldset className="border border-border">
          <legend className="px-2 text-xs font-semibold">
            What this role can do
          </legend>
          <ul className="divide-y divide-border">
            {base.permissions.map((p) => {
              const v = scopes[p.capability] ?? (p.scope as AccessScope);
              const changed = v !== p.scope;
              return (
                <li
                  key={p.capability}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-sm"
                >
                  <span className={changed ? "font-medium" : ""}>
                    {PEOPLE_CAPABILITY_LABELS[p.capability] ?? p.capability}
                    {changed && (
                      <span className="ml-1 text-xs text-ink-muted">
                        (was {peopleScopeLabels[p.scope as AccessScope]})
                      </span>
                    )}
                  </span>
                  <select
                    className="border border-border bg-surface-raised px-2 py-1 text-xs"
                    aria-label={
                      PEOPLE_CAPABILITY_LABELS[p.capability] ?? p.capability
                    }
                    value={v}
                    onChange={(e) =>
                      setScopes((s) => ({
                        ...s,
                        [p.capability]: e.target.value as AccessScope,
                      }))
                    }
                  >
                    {ACCESS_SCOPES.map((s) => (
                      <option key={s} value={s}>
                        {peopleScopeLabels[s]}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
    </ActionDrawer>
  );
}
