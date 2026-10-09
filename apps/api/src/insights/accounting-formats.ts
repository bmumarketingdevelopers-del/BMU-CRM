// v19 accounting exports beyond the v8 voucher CSV:
// - Tally Prime XML (Gateway of Tally → Import → Vouchers): party ledgers under Sundry Debtors, then Sales, Receipt
//   and Credit Note vouchers with CGST+SGST (same state) or IGST (other state) lines.
// - Zoho Books import CSVs: invoices (one row per line item) and customer payments.
// Amounts in rupees with 2 decimals. GST split: the client's place of supply (or the first two digits of their GSTIN)
// against BMU's state code in Settings → GST.
import type { LedgerInvoice } from './ledger.js';

const STATES: Record<string, string> = {
  '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK', '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR', '11': 'SK', '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH', '21': 'OD', '22': 'CG', '23': 'MP', '24': 'GJ', '26': 'DN', '27': 'MH', '29': 'KA', '30': 'GA', '31': 'LD', '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TS', '37': 'AD', '38': 'LA',
};

type Gst = { stateCode: string; ratePct: number; sacCode: string };
type Range = { start: Date; end: Date };
const r2 = (paise: number) => (paise / 100).toFixed(2);
const tallyDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10).replace(/-/g, '');
const isoDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inRange = (d: Date, r: Range) => d >= r.start && d < r.end;

/** State code of the client (place of supply, else GSTIN prefix), falling back to BMU's own state. */
export function supplyState(i: LedgerInvoice, placeOfSupply: Map<string, string | null>, gst: Gst) {
  const pos = i.clientOrgId ? placeOfSupply.get(i.clientOrgId) : null;
  const fromGstin = i.clientOrg?.gstin?.slice(0, 2);
  return (pos || (fromGstin && /^\d{2}$/.test(fromGstin) ? fromGstin : null) || gst.stateCode || '29').padStart(2, '0');
}

/** Tax split of a GST amount: intra-state halves (any odd paisa goes to CGST) or all IGST. */
export function splitTax(gstPaise: number, interState: boolean) {
  if (interState) return { cgst: 0, sgst: 0, igst: gstPaise };
  const sgst = Math.floor(gstPaise / 2);
  return { cgst: gstPaise - sgst, sgst, igst: 0 };
}

function entry(ledger: string, amountPaise: number, debit: boolean) {
  // Tally: debits are negative and "deemed positive".
  return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${debit ? '-' : ''}${r2(amountPaise)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
}

export function tallyXml(ledger: LedgerInvoice[], range: Range, gst: Gst, placeOfSupply: Map<string, string | null>, companyName: string) {
  const parties = new Map<string, { gstin: string | null; state: string }>();
  const vouchers: string[] = [];
  for (const i of ledger) {
    const party = i.clientOrg?.name ?? 'Unregistered customer';
    const state = supplyState(i, placeOfSupply, gst);
    const inter = state !== gst.stateCode.padStart(2, '0');
    const taxLines = (gstPaise: number, debit: boolean) => {
      const t = splitTax(gstPaise, inter);
      return [t.cgst ? entry('Output CGST', t.cgst, debit) : '', t.sgst ? entry('Output SGST', t.sgst, debit) : '', t.igst ? entry('Output IGST', t.igst, debit) : ''].join('');
    };
    const touched = inRange(i.createdAt, range) || i.payments.some((p) => inRange(p.at, range)) || i.creditNotes.some((n) => inRange(n.createdAt, range));
    if (touched) parties.set(party, { gstin: i.clientOrg?.gstin ?? null, state });
    if (inRange(i.createdAt, range)) {
      vouchers.push(
        `<VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>${tallyDate(i.createdAt)}</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(i.number)}</VOUCHERNUMBER><PARTYLEDGERNAME>${xml(party)}</PARTYLEDGERNAME><NARRATION>${xml(`Invoice ${i.number}`)}</NARRATION>` +
          entry(party, i.totalPaise, true) +
          entry('Sales - Services', i.subtotalPaise, false) +
          taxLines(i.gstPaise, false) +
          `</VOUCHER>`,
      );
    }
    for (const p of i.payments) {
      if (!inRange(p.at, range)) continue;
      const account = p.method === 'tds' ? 'TDS Receivable' : p.method === 'cash' ? 'Cash' : 'Bank';
      vouchers.push(
        `<VOUCHER VCHTYPE="Receipt" ACTION="Create"><DATE>${tallyDate(p.at)}</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(p.ref ?? p.id)}</VOUCHERNUMBER><PARTYLEDGERNAME>${xml(party)}</PARTYLEDGERNAME><NARRATION>${xml(`${p.method === 'tds' ? 'TDS deducted' : 'Payment'} against ${i.number}`)}</NARRATION>` +
          entry(account, p.amountPaise, true) +
          entry(party, p.amountPaise, false) +
          `</VOUCHER>`,
      );
    }
    for (const n of i.creditNotes) {
      if (!inRange(n.createdAt, range)) continue;
      vouchers.push(
        `<VOUCHER VCHTYPE="Credit Note" ACTION="Create"><DATE>${tallyDate(n.createdAt)}</DATE><VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(n.number)}</VOUCHERNUMBER><PARTYLEDGERNAME>${xml(party)}</PARTYLEDGERNAME><NARRATION>${xml(`Against ${i.number}: ${n.reason}`)}</NARRATION>` +
          entry('Sales - Services', n.amountPaise, true) +
          taxLines(n.gstPaise, true) +
          entry(party, n.totalPaise, false) +
          `</VOUCHER>`,
      );
    }
  }
  const masters = [...parties.entries()].map(
    ([name, p]) => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xml(name)}" ACTION="Create"><NAME>${xml(name)}</NAME><PARENT>Sundry Debtors</PARENT>${p.gstin ? `<PARTYGSTIN>${xml(p.gstin)}</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` : '<GSTREGISTRATIONTYPE>Consumer</GSTREGISTRATIONTYPE>'}<ISBILLWISEON>Yes</ISBILLWISEON></LEDGER></TALLYMESSAGE>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>',
    `<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xml(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>`,
    '<REQUESTDATA>',
    ...masters,
    ...vouchers.map((v) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${v}</TALLYMESSAGE>`),
    '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>',
  ].join('\n');
}

type Line = { label?: string; amountPaise?: number; kind?: string };

export function zohoInvoiceRows(ledger: LedgerInvoice[], range: Range, gst: Gst, placeOfSupply: Map<string, string | null>) {
  const header = ['Invoice Date', 'Invoice Number', 'Invoice Status', 'Customer Name', 'GST Treatment', 'GST Identification Number (GSTIN)', 'Place of Supply', 'Due Date', 'Currency Code', 'Item Name', 'Item Desc', 'Quantity', 'Item Price', 'Item Tax', 'Item Tax %', 'Item Tax Type', 'SAC', 'Notes'];
  const rows: string[][] = [];
  for (const i of ledger.filter((x) => inRange(x.createdAt, range)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const state = supplyState(i, placeOfSupply, gst);
    const inter = state !== gst.stateCode.padStart(2, '0');
    const rate = i.subtotalPaise ? Math.round((i.gstPaise / i.subtotalPaise) * 100) : gst.ratePct;
    const lines = (Array.isArray(i.lines) ? (i.lines as Line[]) : []).filter((l) => typeof l.amountPaise === 'number');
    const items = lines.length ? lines : [{ label: 'Services', amountPaise: i.subtotalPaise }];
    const status = i.displayStatus === 'paid' ? 'Closed' : i.displayStatus === 'void' ? 'Void' : 'Open';
    for (const l of items) {
      rows.push([isoDay(i.createdAt), i.number, status, i.clientOrg?.name ?? 'Unregistered customer', i.clientOrg?.gstin ? 'business_gst' : 'consumer', i.clientOrg?.gstin ?? '', STATES[state] ?? state, isoDay(i.dueDate), 'INR', (l.label ?? 'Services').slice(0, 100), l.kind ?? '', '1', r2(l.amountPaise ?? 0), `${inter ? 'IGST' : 'GST'}${rate}`, String(rate), 'ItemAmount', gst.sacCode, `Invoice ${i.number}`]);
    }
  }
  return [header, ...rows];
}

export function zohoPaymentRows(ledger: LedgerInvoice[], range: Range) {
  const header = ['Date', 'Payment Number', 'Customer Name', 'Amount', 'Mode', 'Reference Number', 'Invoice Number', 'Amount Applied to Invoice', 'Description'];
  const MODES: Record<string, string> = { cash: 'Cash', cheque: 'Check', bank: 'Bank Transfer', upi: 'Bank Transfer', razorpay: 'Credit Card', test: 'Others', tds: 'Others' };
  const rows: { at: Date; cells: string[] }[] = [];
  for (const i of ledger) {
    for (const p of i.payments) {
      if (!inRange(p.at, range)) continue;
      rows.push({ at: p.at, cells: [isoDay(p.at), p.ref ?? p.id, i.clientOrg?.name ?? 'Unregistered customer', r2(p.amountPaise), MODES[p.method] ?? 'Others', p.ref ?? '', i.number, r2(p.amountPaise), p.method === 'tds' ? 'TDS deducted by the customer' : `Payment for ${i.number}`] });
    }
  }
  return [header, ...rows.sort((a, b) => a.at.getTime() - b.at.getTime()).map((r) => r.cells)];
}
