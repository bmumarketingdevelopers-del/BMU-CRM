// "+ New" entries owned by the leads / finance / creators / files / messages area (Lead, Invoice, File upload, Creator,
// Announcement…). Add yours here; see ../new-registry.tsx.
import { opsCanAnnounce, opsCanCreateInvoice, opsCanCreateLead, opsCanManageCreators, opsCanUploadFiles } from "@bmu/shared";
import type { NewEntry } from "../new-registry";
import { LeadDrawer } from "@/components/ops/lead-drawer";
import { InvoiceDrawer } from "@/components/ops/invoice-drawer";
import { FileUploadDrawer } from "@/components/ops/file-upload-drawer";
import { CreatorDrawer } from "@/components/ops/creator-drawer";
import { AnnouncementDrawer } from "@/components/ops/announcement-drawer";

export const opsNewEntries: NewEntry[] = [
  { id: "lead", label: "Lead", hint: "Duplicate check, round-robin owner", allowed: (me) => opsCanCreateLead(me), Drawer: LeadDrawer },
  { id: "invoice", label: "Invoice", hint: "Manual, with GST and pass-through lines", allowed: (me) => opsCanCreateInvoice(me), Drawer: InvoiceDrawer },
  { id: "file", label: "File upload", hint: "Into a client's folder", allowed: (me) => opsCanUploadFiles(me), Drawer: FileUploadDrawer },
  { id: "creator", label: "Creator", hint: "Add to the roster", allowed: (me) => opsCanManageCreators(me), Drawer: CreatorDrawer },
  { id: "announcement", label: "Announcement", hint: "To clients or the team", allowed: (me) => opsCanAnnounce(me), Drawer: AnnouncementDrawer },
];

