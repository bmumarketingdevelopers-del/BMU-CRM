// GST tax invoice: seller details from settings.gst + tenant, buyer from the client's billing details,
// CGST + SGST inside the same state, IGST across states, amount in words in the Indian format.
// v27: the design (new subscription, due, overdue, part paid, paid, credited), the printed wording of each line
// (AI-written for manual invoices), the Founder's signature and company seal, and the terms on page 2.
import { BMU_ADDRESS, BMU_EMAIL, BMU_PHONE, serviceAmountInWords, serviceGstStateName, serviceInvoiceVariant, formatINR, type ServiceTaxInvoice } from '@bmu/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { escapeHtml } from './email.service.js';
import { signingFileUrl } from './cm-signing.service.js';
import { invoiceBrandingUrl, invoiceHeld, readInvoiceBranding } from './invoice-branding.service.js';

type InvoiceLine = { label: string; amountPaise: number; title?: string; details?: string; passThrough?: boolean; kind?: string };

/** The terms printed on page 2 of every invoice. */
function invoiceTerms(t: { number: string; dueDate: Date; email: string; phone: string; legalName: string; settled: boolean }) {
  const due = new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeZone: 'Asia/Kolkata' }).format(t.dueDate);
  return [
    t.settled ? `Nothing is payable against invoice ${t.number}. Please keep this document for your records.` : `Payment is due by ${due}. Please quote invoice number ${t.number} with every payment.`,
    'Prices are exclusive of GST; GST is charged at the rate shown. Pass-through costs (ad spend, creator fees) are billed at cost without GST.',
    'Work continues on schedule while the account is up to date; overdue invoices may pause new deliverables until they are paid.',
    `Please tell us about any question on this invoice within 7 days at ${t.email}${t.phone ? ` or ${t.phone}` : ''}.`,
    `Subject to Bengaluru jurisdiction. This invoice is issued by ${t.legalName}.`,
  ];
}

export async function buildTaxInvoice(prisma: PrismaService, settings: SettingsService, orgId: string, invoiceId: string, payLink: string): Promise<ServiceTaxInvoice | null> {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, orgId },
    include: { payments: { orderBy: { at: 'asc' } }, clientOrg: true },
  });
  if (!inv) return null;
  const [gst, tenant, notes, firstOwner, branding] = await Promise.all([
    settings.get(orgId, 'gst'),
    settings.get(orgId, 'tenant'),
    prisma.creditNote.findMany({ where: { invoiceId }, orderBy: { createdAt: 'asc' } }),
    inv.clientOrgId
      ? prisma.clientUser.findFirst({ where: { clientOrgId: inv.clientOrgId, clientRole: { in: ['client_owner', 'client_finance'] } }, select: { user: { select: { email: true } } } })
      : null,
    readInvoiceBranding(prisma, orgId),
  ]);
  const c = inv.clientOrg;
  // Place of supply: the client's chosen state, else the state in their GSTIN, else the seller's own state.
  const pos = c?.placeOfSupply || (c?.gstin && /^\d{2}/.test(c.gstin) ? c.gstin.slice(0, 2) : null) || gst.stateCode || '29';
  const interState = !!gst.stateCode && pos !== gst.stateCode;
  const lines = ((inv.lines as InvoiceLine[] | null) ?? []).filter((l) => l && typeof l.amountPaise === 'number' && !/^GST\b/i.test(l.label));
  const taxable = inv.subtotalPaise;
  const gstPaise = inv.gstPaise;
  const cgst = interState ? 0 : Math.floor(gstPaise / 2);
  const sgst = interState ? 0 : gstPaise - cgst;
  const igst = interState ? gstPaise : 0;
  const paid = inv.payments.reduce((s, p) => s + p.amountPaise, 0);
  const credited = notes.reduce((s, n) => s + n.totalPaise, 0);
  const open = ['issued', 'partially_paid', 'overdue'].includes(inv.status);
  const balance = open ? Math.max(0, inv.totalPaise - paid - credited) : 0;
  const payee = gst.legalName || tenant.name;
  const upiId = gst.upiId?.trim() || null;
  const upiUri = upiId && balance > 0 ? `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payee)}&am=${(balance / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(`Invoice ${inv.number}`)}` : null;
  const email = tenant.supportEmail?.trim() || BMU_EMAIL;
  const phone = tenant.supportPhone?.trim() || BMU_PHONE;
  // The founder who signs: the name set with the signature, else the first Founder.
  const variant = serviceInvoiceVariant({ status: inv.status, kind: inv.kind, dueDate: inv.dueDate.toISOString(), paidPaise: paid, creditedPaise: credited, balancePaise: balance });
  // v28: the seal and signature are printed only once the invoice is signed with the signing password.
  const signed = !!inv.signedAt;
  const signer = inv.signedById ? await prisma.user.findUnique({ where: { id: inv.signedById }, select: { name: true } }) : null;
  const founder = branding.signatoryName ? null : await prisma.user.findFirst({ where: { orgId, type: 'staff', deletedAt: null, roles: { some: { role: { baseRole: 'founder' } } } }, orderBy: { createdAt: 'asc' }, select: { name: true } });
  return {
    id: inv.id,
    number: inv.number,
    date: inv.createdAt.toISOString(),
    dueDate: inv.dueDate.toISOString(),
    status: inv.status,
    kind: inv.kind,
    title: 'Tax Invoice',
    variant,
    notes: inv.notes?.trim() || null,
    // v29: a signed invoice prints what it was signed with (Founder or Client Manager); older ones the current branding.
    signatory: inv.signedRole
      ? {
          name: inv.signatoryName ?? '',
          designation: inv.signatoryDesignation ?? (inv.signedRole === 'client_manager' ? 'Client Manager' : 'Founder'),
          signatureUrl: inv.signatureFileId ? signingFileUrl(inv.signatureFileId) : null,
          sealUrl: inv.sealFileId ? signingFileUrl(inv.sealFileId) : null,
        }
      : {
          name: branding.signatoryName || (founder?.name && !/^bmu owner$/i.test(founder.name) ? founder.name : ''),
          designation: branding.designation || 'Founder',
          signatureUrl: signed && branding.signatureFileId ? invoiceBrandingUrl('signature', branding.signatureFileId) : null,
          sealUrl: signed && branding.sealFileId ? invoiceBrandingUrl('seal', branding.sealFileId) : null,
        },
    signing: { signed, signedAt: inv.signedAt?.toISOString() ?? null, signedBy: signer?.name ?? null, held: invoiceHeld(branding, inv), canSign: false },
    terms: invoiceTerms({ number: inv.number, dueDate: inv.dueDate, email, phone, legalName: payee, settled: ['paid', 'credited', 'cancelled'].includes(variant) }),
    seller: {
      legalName: payee,
      gstin: gst.gstin,
      address: gst.address?.trim() || tenant.address?.trim() || BMU_ADDRESS,
      state: gst.state,
      stateCode: gst.stateCode,
      email,
      phone,
      website: tenant.website,
    },
    buyer: {
      name: c?.name ?? 'Customer',
      legalName: c?.legalName?.trim() || c?.name || 'Customer',
      gstin: c?.gstin ?? null,
      address: c?.billingAddress ?? null,
      placeOfSupply: pos,
      placeOfSupplyName: serviceGstStateName(pos) ?? pos,
      email: c?.billingEmail ?? firstOwner?.user.email ?? null,
    },
    sacCode: gst.sacCode,
    lines: lines.map((l) => ({ label: l.label, title: l.title?.trim() || l.label, details: l.details?.trim() || null, sac: gst.sacCode, taxablePaise: l.amountPaise, passThrough: !!l.passThrough })),
    taxablePaise: taxable,
    ratePct: taxable ? Math.round((gstPaise / taxable) * 1000) / 10 : gst.ratePct,
    interState,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    gstPaise,
    totalPaise: inv.totalPaise,
    paidPaise: paid,
    creditedPaise: credited,
    balancePaise: balance,
    amountInWords: serviceAmountInWords(inv.totalPaise),
    payment: {
      upiId,
      upiUri,
      payeeName: payee,
      bank: gst.bankAccount?.trim() ? { name: gst.bankName ?? '', account: gst.bankAccount, ifsc: gst.bankIfsc ?? '', branch: gst.bankBranch ?? '' } : null,
      payLink,
    },
    payments: inv.payments.map((p) => ({ at: p.at.toISOString(), amountPaise: p.amountPaise, method: p.method, ref: p.ref })),
    creditNotes: notes.map((n) => ({ number: n.number, at: n.createdAt.toISOString(), totalPaise: n.totalPaise, reason: n.reason })),
    reverseCharge: false,
  };
}

const d = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** Compact HTML version of the tax invoice for emails (inline styles only). */
export function taxInvoiceEmailHtml(t: ServiceTaxInvoice) {
  const cell = 'padding:6px 8px;border-bottom:1px solid #e6e4dc;font-size:13px';
  const passThrough = t.lines.filter((l) => l.passThrough).reduce((s, l) => s + l.taxablePaise, 0);
  const right = `${cell};text-align:right`;
  const tax = t.interState
    ? `<tr><td style="${cell}">IGST ${t.ratePct}%</td><td style="${right}">${formatINR(t.igstPaise)}</td></tr>`
    : `<tr><td style="${cell}">CGST ${t.ratePct / 2}%</td><td style="${right}">${formatINR(t.cgstPaise)}</td></tr><tr><td style="${cell}">SGST ${t.ratePct / 2}%</td><td style="${right}">${formatINR(t.sgstPaise)}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;border:1px solid #e6e4dc">
<tr><td colspan="2" style="${cell};background:#f6f5f0"><strong>Tax Invoice ${escapeHtml(t.number)}</strong> · ${d(t.date)} · due ${d(t.dueDate)}<br>
<span style="color:#6b7280">From ${escapeHtml(t.seller.legalName)}${t.seller.gstin ? ` (GSTIN ${escapeHtml(t.seller.gstin)})` : ''} to ${escapeHtml(t.buyer.legalName)}${t.buyer.gstin ? ` (GSTIN ${escapeHtml(t.buyer.gstin)})` : ''}. Place of supply: ${escapeHtml(t.buyer.placeOfSupplyName)}.</span></td></tr>
${t.lines.map((l) => `<tr><td style="${cell}">${escapeHtml(l.title)}${l.details ? `<br><span style="color:#6b7280;font-size:12px">${escapeHtml(l.details)}</span>` : ''}<br><span style="color:#6b7280;font-size:11px">SAC ${escapeHtml(l.sac)}</span></td><td style="${right};vertical-align:top;white-space:nowrap">${formatINR(l.taxablePaise)}</td></tr>`).join('')}
<tr><td style="${cell}">Taxable value${passThrough ? ' (services)' : ''}</td><td style="${right}">${formatINR(t.taxablePaise - passThrough)}</td></tr>
${passThrough ? `<tr><td style="${cell}">Pass-through (no GST)</td><td style="${right}">${formatINR(passThrough)}</td></tr>` : ''}
${tax}
<tr><td style="${cell}"><strong>Total</strong></td><td style="${right}"><strong>${formatINR(t.totalPaise)}</strong></td></tr>
${t.balancePaise > 0 && t.balancePaise !== t.totalPaise ? `<tr><td style="${cell}">Balance due</td><td style="${right}"><strong>${formatINR(t.balancePaise)}</strong></td></tr>` : ''}
<tr><td colspan="2" style="${cell};color:#6b7280">${escapeHtml(t.amountInWords)}</td></tr>
${t.payment.upiId || t.payment.bank ? `<tr><td colspan="2" style="${cell}">${t.payment.upiId ? `UPI: <strong>${escapeHtml(t.payment.upiId)}</strong>` : ''}${t.payment.bank ? `${t.payment.upiId ? '<br>' : ''}Bank: ${escapeHtml(t.payment.bank.name)}, A/c ${escapeHtml(t.payment.bank.account)}, IFSC ${escapeHtml(t.payment.bank.ifsc)}` : ''}</td></tr>` : ''}
</table>`;
}

export function taxInvoiceEmailText(t: ServiceTaxInvoice) {
  return [
    `Tax Invoice ${t.number} (${d(t.date)}, due ${d(t.dueDate)})`,
    ...t.lines.map((l) => `- ${l.title}: ${formatINR(l.taxablePaise)}`),
    `Taxable value: ${formatINR(t.taxablePaise - t.lines.filter((l) => l.passThrough).reduce((s, l) => s + l.taxablePaise, 0))}`,
    t.interState ? `IGST ${t.ratePct}%: ${formatINR(t.igstPaise)}` : `CGST ${t.ratePct / 2}%: ${formatINR(t.cgstPaise)} · SGST ${t.ratePct / 2}%: ${formatINR(t.sgstPaise)}`,
    `Total: ${formatINR(t.totalPaise)} (${t.amountInWords})`,
    ...(t.payment.upiId ? [`UPI: ${t.payment.upiId}`] : []),
  ].join('\n');
}
