// "+ New" entries owned by the people & hierarchy area (Person, Team…). Add yours here; see ../new-registry.tsx.
import type { Me } from "@bmu/shared";
import type { NewEntry } from "../new-registry";
import { AddPersonDrawer } from "@/components/people/add-person-drawer";
import { AddUnitDrawer } from "@/components/people/add-unit-drawer";
import { LeaveDrawer } from "@/components/people/leave-drawer";

const staff = (me: Me) => me.type === "staff";
const has = (me: Me, ...r: string[]) => staff(me) && me.roles.some((x) => r.includes(x));
const peopleCap = (me: Me) => (me.permissions.users_roles_hierarchy?.scope ?? "none") !== "none";

export const peopleNewEntries: NewEntry[] = [
  { id: "person", label: "Person", hint: "Add someone to the team", allowed: (me) => has(me, "founder", "admin", "hr_ops", "department_head") && peopleCap(me), Drawer: AddPersonDrawer },
  { id: "team", label: "Team or pod", hint: "Branch, department, team or client pod", allowed: (me) => (has(me, "founder", "admin") && peopleCap(me)) || has(me, "am_lead"), Drawer: AddUnitDrawer },
  { id: "leave", label: "Leave request", hint: "Apply for time off", allowed: (me) => staff(me), Drawer: LeaveDrawer },
];
