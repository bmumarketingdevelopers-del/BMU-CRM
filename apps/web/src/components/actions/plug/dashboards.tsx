"use client";

// v12 Dashboard Studio: "+ New → Dashboard" for the Founder and Branch Managers.
import { NewDashboardDrawer } from "@/components/dashboards/new-dashboard-drawer";
import type { NewEntry } from "../new-registry";

export const dashboardsNewEntries: NewEntry[] = [
  { id: "dashboard", label: "Dashboard", hint: "Numbers, charts and lists for chosen people", allowed: (me) => me.type === "staff" && me.roles.some((r) => r === "founder" || r === "admin"), Drawer: ({ open, onClose }) => <NewDashboardDrawer open={open} onClose={onClose} /> },
];
