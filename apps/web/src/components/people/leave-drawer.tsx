"use client";

/** LeaveDrawer: "+ New → Leave request" (same as Team → Profile, leave & attendance). Goes to the manager, then HR for long leave. */
import { useState } from "react";
import { LEAVE_TYPES, leaveTypeLabels, type LeaveType } from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDrawer, Field, TextArea, inputCls } from "../actions/action-drawer";
import type { NewDrawerProps } from "../actions/new-registry";
import { todayIst } from "./use-people-options";

export function LeaveDrawer({ open, onClose, onSaved }: NewDrawerProps) {
  const [v, setV] = useState({ from: todayIst(), to: todayIst(), type: "casual" as LeaveType, reason: "" });
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  async function save() {
    if (v.reason.trim().length < 3) return setError("Add a short note for your manager");
    setSaving(true);
    setError(undefined);
    try {
      await api.workspace.applyLeave({ from: v.from, to: v.to, type: v.type, reason: v.reason.trim() });
      onSaved(undefined, "Leave request sent to your manager");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDrawer open={open} title="Apply for leave" subtitle="Your manager decides; leave over 3 working days then goes to HR." onClose={onClose} onSubmit={save} saving={saving} error={error} saveLabel="Send request" testId="leave-drawer">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="From" required htmlFor="lv-from">
          <input id="lv-from" type="date" className={inputCls} value={v.from} onChange={(e) => setV({ ...v, from: e.target.value, to: e.target.value > v.to ? e.target.value : v.to })} />
        </Field>
        <Field label="To" required htmlFor="lv-to">
          <input id="lv-to" type="date" className={inputCls} min={v.from} value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} />
        </Field>
      </div>
      <Field label="Type" required htmlFor="lv-type">
        <select id="lv-type" className={inputCls} value={v.type} onChange={(e) => setV({ ...v, type: e.target.value as LeaveType })}>
          {LEAVE_TYPES.map((t) => (
            <option key={t} value={t}>
              {leaveTypeLabels[t]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Note" required htmlFor="lv-note">
        <TextArea id="lv-note" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder="e.g. Family wedding in Jaipur" />
      </Field>
    </ActionDrawer>
  );
}
