"use client";

/**
 * The global "+ New" registry (top bar button, Ctrl/Cmd+K "new …", "N" shortcut, contextual "+ Add" buttons).
 * An entry appears only when its drawer is built AND the person may use it, so there are no dead entries.
 *
 * HOW TO PLUG IN (other areas): add your entry to YOUR OWN file in ./plug/ (people.tsx, clients.tsx, ops.tsx) —
 * never this file — so parallel work doesn't conflict:
 *
 *   export const peopleNewEntries: NewEntry[] = [
 *     { id: "person", label: "Person", hint: "Invite a team member", allowed: (me) => …, Drawer: AddPersonDrawer },
 *   ];
 *
 * Your Drawer receives { open, onClose, prefill, onSaved }. Call onSaved(id, "Person added", undo?) after saving;
 * the provider shows the toast (with Undo when you pass a token) and bumps `version` so lists reload.
 */
import type { ComponentType } from "react";
import type { CoreUndo, Me } from "@bmu/shared";
import { clientsNewEntries } from "./plug/clients";
import { opsNewEntries } from "./plug/ops";
import { peopleNewEntries } from "./plug/people";
import { coreNewEntries } from "./plug/core";
import { dashboardsNewEntries } from "./plug/dashboards";

export type NewPrefill = Record<string, string | undefined>;
export type NewDrawerProps = {
  open: boolean;
  onClose: () => void;
  prefill?: NewPrefill;
  onSaved: (id?: string, message?: string, undo?: CoreUndo | null) => void;
};
export type NewEntry = {
  /** Stable key used by openNew(id), the palette ("new <id>") and contextual buttons. */
  id: string;
  label: string;
  hint?: string;
  /** Surfaces where the entry shows (default both). */
  surfaces?: ("team" | "admin")[];
  /** Hide the entry from people who can't use it (the API checks again). */
  allowed: (me: Me) => boolean;
  Drawer: ComponentType<NewDrawerProps>;
};

/** Menu order from the spec: Person, Client, Lead, Task, Request, Engagement, Invoice, File upload, Creator, Note, Meeting, Announcement. */
export const NEW_ORDER = ["person", "client", "lead", "task", "request", "engagement", "invoice", "file", "creator", "note", "meeting", "announcement"];

export const NEW_ENTRIES: NewEntry[] = [...coreNewEntries, ...peopleNewEntries, ...clientsNewEntries, ...opsNewEntries, ...dashboardsNewEntries];

export function newEntriesFor(me: Me, surface: "team" | "admin"): NewEntry[] {
  const rank = (id: string) => (NEW_ORDER.includes(id) ? NEW_ORDER.indexOf(id) : 99);
  return NEW_ENTRIES.filter((e) => (!e.surfaces || e.surfaces.includes(surface)) && e.allowed(me)).sort((a, b) => rank(a.id) - rank(b.id));
}
