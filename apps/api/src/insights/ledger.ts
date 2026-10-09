// Invoice ledger: each invoice with what was paid, what was credited and what is still owed.
import type { FinanceInvoiceRow, InvoiceDisplayStatus } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { daysBetween } from './ist.js';

export type LedgerInvoice = Awaited<ReturnType<typeof loadLedger>>[number];

/** Invoices with payments, credit notes, client and engagement service. Draft invoices are left out. */
export async function loadLedger(prisma: PrismaService, orgId: string, where: Prisma.InvoiceWhereInput = {}) {
  const invoices = await prisma.invoice.findMany({
    where: { orgId, status: { not: 'draft' }, ...where },
    include: { payments: { orderBy: { at: 'asc' } }, clientOrg: { select: { id: true, name: true, gstin: true, amUserId: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const ids = invoices.map((i) => i.id);
  const engagementIds = [...new Set(invoices.map((i) => i.engagementId).filter((x): x is string => !!x))];
  const [notes, engagements] = await Promise.all([
    ids.length ? prisma.creditNote.findMany({ where: { orgId, invoiceId: { in: ids } }, orderBy: { createdAt: 'asc' } }) : [],
    engagementIds.length ? prisma.engagement.findMany({ where: { id: { in: engagementIds } }, select: { id: true, billingType: true, service: { select: { name: true } } } }) : [],
  ]);
  const engById = new Map(engagements.map((e) => [e.id, e]));
  const now = new Date();
  return invoices.map((inv) => {
    const creditNotes = notes.filter((n) => n.invoiceId === inv.id);
    const paidPaise = inv.payments.reduce((s, p) => s + p.amountPaise, 0);
    const creditedPaise = creditNotes.reduce((s, n) => s + n.totalPaise, 0);
    const creditedSubtotal = creditNotes.reduce((s, n) => s + n.amountPaise, 0);
    const creditedGst = creditNotes.reduce((s, n) => s + n.gstPaise, 0);
    const open = ['issued', 'partially_paid', 'overdue'].includes(inv.status);
    const balancePaise = open ? Math.max(0, inv.totalPaise - paidPaise - creditedPaise) : 0;
    const daysOverdue = open && balancePaise > 0 ? Math.max(0, daysBetween(inv.dueDate, now)) : 0;
    let status = inv.status as InvoiceDisplayStatus;
    if (open && balancePaise > 0 && inv.dueDate < now && daysOverdue > 0) status = 'overdue';
    else if (inv.status === 'overdue') status = paidPaise > 0 ? 'partially_paid' : 'issued';
    const eng = inv.engagementId ? engById.get(inv.engagementId) : undefined;
    return { ...inv, creditNotes, paidPaise, creditedPaise, creditedSubtotal, creditedGst, balancePaise, daysOverdue, displayStatus: status, engagement: eng ?? null };
  });
}

export function toRow(i: LedgerInvoice): FinanceInvoiceRow {
  return {
    id: i.id,
    number: i.number,
    clientId: i.clientOrgId,
    client: i.clientOrg?.name ?? 'No client yet',
    kind: i.kind,
    status: i.displayStatus,
    createdAt: i.createdAt.toISOString(),
    dueDate: i.dueDate.toISOString(),
    subtotalPaise: i.subtotalPaise,
    gstPaise: i.gstPaise,
    totalPaise: i.totalPaise,
    paidPaise: i.paidPaise,
    creditedPaise: i.creditedPaise,
    balancePaise: i.balancePaise,
  };
}

/** Counts towards revenue: issued invoices that were not cancelled. */
export const isBillable = (i: { status: string }) => i.status !== 'void' && i.status !== 'draft';

/** Retainer / project / add-on bucket for the revenue split. */
export function revenueBucket(i: LedgerInvoice): string {
  if (i.kind === 'retainer') return 'Retainers';
  if (i.kind === 'addon') return 'Add-ons';
  if (i.kind === 'project_balance') return 'Projects';
  if (i.engagement) return i.engagement.billingType === 'monthly' ? 'Retainers' : 'Projects';
  return 'Other';
}
