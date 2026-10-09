// "+ New" entries owned by the clients area (Client, Request, Engagement, Approval). See ../new-registry.tsx.
import { clientsCanAdd, clientsCanAddEngagement, clientsCanAskApproval, clientsCanRaiseRequest } from "@bmu/shared";
import type { NewEntry } from "../new-registry";
import { AddClientDrawer } from "../../clients/add-client-drawer";
import { AddServiceDrawer } from "../../clients/client-dialogs";
import { InternalApprovalDrawer, RaiseRequestDrawer } from "../../clients/request-drawers";

export const clientsNewEntries: NewEntry[] = [
  { id: "client", label: "Client", hint: "New or migrated account", allowed: (me) => clientsCanAdd(me), Drawer: AddClientDrawer },
  { id: "request", label: "Request", hint: "Raise for a client", allowed: (me) => clientsCanRaiseRequest(me), Drawer: RaiseRequestDrawer },
  { id: "engagement", label: "Engagement", hint: "Quote a new service", allowed: (me) => clientsCanAddEngagement(me), Drawer: AddServiceDrawer },
  { id: "approval", label: "Approval", hint: "Ask a colleague to sign off", allowed: (me) => clientsCanAskApproval(me), Drawer: InternalApprovalDrawer },
];
