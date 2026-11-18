// "+ New" entries owned by the leads / finance / creators / files / messages area (Lead, Invoice, File upload, Creator,
// Announcement…). Add yours here; see ../new-registry.tsx.
import { opsCanAnnounce, opsCanCreateInvoice, opsCanCreateLead, opsCanManageCreators, opsCanUploadFiles } from "@bmu/shared";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { NewDrawerProps, NewEntry } from "../new-registry";
import { LeadDrawer } from "@/components/ops/lead-drawer";
import { FileUploadDrawer } from "@/components/ops/file-upload-drawer";
import { CreatorDrawer } from "@/components/ops/creator-drawer";
import { AnnouncementDrawer } from "@/components/ops/announcement-drawer";

/** v52: "+ New → Invoice" (and every "New invoice" button) opens the invoice form, the same as a new quotation. */
function OpenInvoicePage({ open, onClose, prefill }: NewDrawerProps) {
  const router = useRouter();
  useEffect(() => {
    if (!open) return;
    router.push(prefill?.clientId ? `/team/invoices/new?clientId=${prefill.clientId}` : "/team/invoices/new");
    onClose();
  }, [open, prefill?.clientId, router, onClose]);
  return null;
}

export const opsNewEntries: NewEntry[] = [
  { id: "lead", label: "Lead", hint: "Duplicate check, round-robin owner", allowed: (me) => opsCanCreateLead(me), Drawer: LeadDrawer },
  { id: "invoice", label: "Invoice", hint: "The same form as a quotation", allowed: (me) => opsCanCreateInvoice(me), Drawer: OpenInvoicePage },
  { id: "file", label: "File upload", hint: "Into a client's folder", allowed: (me) => opsCanUploadFiles(me), Drawer: FileUploadDrawer },
  { id: "creator", label: "Creator", hint: "Add to the roster", allowed: (me) => opsCanManageCreators(me), Drawer: CreatorDrawer },
  { id: "announcement", label: "Announcement", hint: "To clients or the team", allowed: (me) => opsCanAnnounce(me), Drawer: AnnouncementDrawer },
];

