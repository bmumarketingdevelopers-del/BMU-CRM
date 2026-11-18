"use client";

// v52: the invoice side of the shared quotation / invoice form. Details (client, project, invoice date, due date),
// Bill to (filled from the client until changed here), Items (a new invoice starts from the client's services at their
// plan prices), one GST rate with the "Add GST" switch, Signature and seal, Notes and terms. Autosaves as a draft; the
// first autosave turns /new into /<id>/edit. Issued invoices are locked (cancel and issue a new one to correct them).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { INVOICE_DEFAULT_DUE_DAYS, type InvoiceDocSaveInput, type PriceList, type QuoteContent } from "@bmu/shared";
import { Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { emptyContent, linesFromClient, QuoteEditor, SaveBar, useDocAutosave } from "./quote-editor";

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
type Meta = { clientOrgId: string; engagementId: string; invoiceDate: string; dueDate: string };

/** What still stops the draft from being saved (null when it can be saved). */
function invoiceProblem(meta: Meta, c: QuoteContent): string | null {
  if (!meta.clientOrgId) return "pick the client";
  if (meta.invoiceDate > todayIst()) return "the invoice date can't be in the future";
  if (!c.lines.some((l) => l.title.trim() && l.unitPricePaise > 0)) return "add an item with a rate";
  if (c.lines.some((l) => !l.title.trim() && (l.unitPricePaise > 0 || l.details.trim()))) return "give every item a sub service name";
  return null;
}

const bodyOf = (meta: Meta, c: QuoteContent): InvoiceDocSaveInput => ({
  clientOrgId: meta.clientOrgId,
  engagementId: meta.engagementId || null,
  invoiceDate: meta.invoiceDate,
  dueDate: meta.dueDate,
  overview: c.overview ?? "",
  billTo: c.billTo,
  lines: c.lines.filter((l) => l.title.trim() || l.unitPricePaise).map((l) => ({ ...l, kind: "unit" })),
  gstRatePct: (c.gstRatePct ?? 18) as InvoiceDocSaveInput["gstRatePct"],
  signWith: c.signWith ?? "mine",
  seal: c.seal !== false,
  notes: c.notes ?? "",
  terms: c.terms,
});

export function InvoiceForm({ id, presetClientId = "" }: { id?: string; presetClientId?: string }) {
  const router = useRouter();
  const [opts, setOpts] = useState<Awaited<ReturnType<typeof api.ops.finance.options>>>();
  const [meta, setMeta] = useState<Meta>({ clientOrgId: presetClientId, engagementId: "", invoiceDate: todayIst(), dueDate: "" });
  const [content, setContent] = useState<QuoteContent>({ ...emptyContent(), title: "Invoice" });
  const [loaded, setLoaded] = useState(!id);
  const [locked, setLocked] = useState<string>();
  const [number, setNumber] = useState<string>();
  const [mixed, setMixed] = useState(false);
  const [clientName, setClientName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string>();
  const itemsEdited = useRef(!!id);
  const clientLoadedFor = useRef<string>("");

  const [priceList, setPriceList] = useState<PriceList>();
  useEffect(() => {
    api.ops.finance.options().then(setOpts, (e: Error) => setError(e.message));
    api.catalogue.priceList().then(setPriceList, () => setPriceList({ groups: [], bundles: [] }));
  }, []);
  // An existing draft: everything comes from the invoice (older ones from their lines).
  useEffect(() => {
    if (!id) return;
    api.ops.finance.invoiceDoc(id).then(
      (d) => {
        setMeta({ clientOrgId: d.client?.id ?? "", engagementId: d.engagementId ?? "", invoiceDate: d.invoiceDate, dueDate: d.dueDate });
        setContent({ ...emptyContent(), title: "Invoice", overview: d.overview, billTo: d.billTo, lines: d.lines, gstRatePct: d.gstRatePct as QuoteContent["gstRatePct"], signWith: d.signWith, seal: d.seal, notes: d.notes, terms: d.terms });
        setNumber(d.number);
        setMixed(d.mixedRates);
        setClientName(d.client?.name ?? "");
        clientLoadedFor.current = d.client?.id ?? "";
        if (!d.canEdit) setLocked(`Invoice ${d.number} is ${d.status}: its items and amounts are locked. To correct it, cancel it and issue a new one.`);
        setLoaded(true);
      },
      (e: Error) => setError(e.message),
    );
  }, [id]);
  // Choosing a client fills Bill to and, on a new invoice, starts the items from the client's services.
  useEffect(() => {
    if (!meta.clientOrgId || !priceList || clientLoadedFor.current === meta.clientOrgId) return;
    clientLoadedFor.current = meta.clientOrgId;
    api.clientsActions.get(meta.clientOrgId).then(
      (d) => {
        setClientName(d.name);
        const gstin = d.billing.gstin ?? "";
        const billTo = { name: d.billing.billingName || d.name, gstin, placeOfSupply: d.billing.placeOfSupply || (/^\d{2}/.test(gstin) ? gstin.slice(0, 2) : ""), address: d.billing.billingAddress ?? "" };
        setContent((c) => {
          // All of the client's services, with their service, sub service and price; the manager adds or removes items.
          const lines = itemsEdited.current ? c.lines : linesFromClient(d, priceList);
          return { ...c, billTo, lines: lines.length ? lines : c.lines };
        });
      },
      () => undefined,
    );
  }, [meta.clientOrgId, priceList]);

  const auto = useDocAutosave({
    enabled: loaded && !locked,
    value: { meta, content },
    problem: invoiceProblem(meta, content),
    save: async () => {
      const r = await api.ops.finance.saveInvoiceDoc(bodyOf(meta, content), id);
      if (!id) router.replace(`/team/invoices/${r.id}/edit`);
    },
  });
  // A draft stays in this form (Founders and Finance only see issued invoices in Admin → Finance).
  async function save(): Promise<string | null> {
    const p = invoiceProblem(meta, content);
    if (p) {
      setError(`Can't save yet: ${p}.`);
      return null;
    }
    setBusy(true);
    setError(undefined);
    setSaved(undefined);
    try {
      const r = await api.ops.finance.saveInvoiceDoc(bodyOf(meta, content), id);
      auto.markSaved();
      if (!id) router.replace(`/team/invoices/${r.id}/edit`);
      else setSaved(r.message);
      return r.id;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  // Issue: saves first, then issues; the invoice is then locked and opens in its view.
  async function issue() {
    if (!window.confirm("Issue this invoice to the client? Its items and amounts are locked once it is issued.")) return;
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      await api.ops.finance.issue(saved);
      router.push(`/team/invoices/${saved}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const client = opts?.clients.find((c) => c.id === meta.clientOrgId);
  if (!loaded) return <LoadState loading={!error} error={error} />;
  return (
    <>
      <Link href={id ? `/team/invoices/${id}` : "/team/invoices"} className="mb-4 inline-block text-sm underline">
        ← {id ? "Back to the invoice" : "Invoices"}
      </Link>
      <PageTitle title={id ? `Edit invoice ${number ?? ""}` : "New invoice"} subtitle="Choose the client: their services, Bill to and the overview are filled in for you. Check them, then save." />
      {locked && <p className="mb-4 border border-[#9a6b00] bg-[#9a6b00]/10 px-3 py-2 text-sm" data-testid="invoice-locked">{locked}</p>}
      <fieldset disabled={!!locked} className="grid max-w-4xl gap-6">
        <QuoteEditor
          kind="invoice"
          value={content}
          onChange={setContent}
          clientName={clientName}
          mixedRates={mixed}
          onItemsEdited={() => (itemsEdited.current = true)}
          details={
            <div className="grid gap-3 sm:grid-cols-2" data-testid="invoice-meta">
              <label className="grid min-w-0 gap-1 text-xs font-medium">
                Client
                <Select value={meta.clientOrgId} disabled={!!id || !!presetClientId} onChange={(e) => setMeta({ ...meta, clientOrgId: e.target.value, engagementId: "" })} aria-label="Client">
                  <option value="">{opts ? "Pick the client…" : "Loading…"}</option>
                  {(opts?.clients ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="grid min-w-0 gap-1 text-xs font-medium">
                Project
                <Select value={meta.engagementId} onChange={(e) => setMeta({ ...meta, engagementId: e.target.value })} aria-label="Project" disabled={!client?.engagements.length}>
                  <option value="">{client?.engagements.length ? "Not for one project" : "No projects for this client"}</option>
                  {(client?.engagements ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="grid min-w-0 gap-1 text-xs font-medium">
                Invoice date
                <Input type="date" max={todayIst()} value={meta.invoiceDate} onChange={(e) => setMeta({ ...meta, invoiceDate: e.target.value })} aria-label="Invoice date" />
              </label>
              <label className="grid min-w-0 gap-1 text-xs font-medium">
                Due date
                <Input type="date" min={meta.invoiceDate} value={meta.dueDate} onChange={(e) => setMeta({ ...meta, dueDate: e.target.value })} aria-label="Due date" />
                <span className="font-normal text-ink-muted">Leave empty for {INVOICE_DEFAULT_DUE_DAYS} days after the date.</span>
              </label>
            </div>
          }
        />
        <SaveBar busy={busy} error={error}>
          <Button variant={id ? "secondary" : undefined} onClick={() => void save()} disabled={busy || !!locked} data-testid="invoice-save">
            {id ? "Save changes" : "Save invoice as draft"}
          </Button>
          {id && !locked && (
            <Button onClick={() => void issue()} disabled={busy} data-testid="invoice-issue">
              Issue invoice
            </Button>
          )}
          {saved && <span className="text-xs text-green">{saved}</span>}
          <span className="text-xs text-ink-muted" data-testid="invoice-autosave">
            {auto.status}
          </span>
        </SaveBar>
      </fieldset>
    </>
  );
}
