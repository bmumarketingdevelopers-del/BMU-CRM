"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { formatINR, priceProposal, sellApprovalChain, sellApprovalLevelLabels, type ProposalView, type Tier } from "@bmu/shared";
import { AiPanel } from "@/components/ai/ai-panel";
import { ProposalSummary } from "@/components/proposal-summary";
import { Button, Card, Input, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const TIERS: Tier[] = ["starter", "growth", "premium"];

export function ProposalBuilder() {
  const router = useRouter();
  const params = useSearchParams()!; // never null in the App Router (src/pages only holds the API route)
  const reviseId = params.get("revise") ?? "";
  const pricing = useLoad(() => api.proposals.pricing());
  const leads = useLoad(() => api.leads.list());
  const original = useLoad<ProposalView | null>(() => (reviseId ? api.proposals.get(reviseId) : Promise.resolve(null)));
  const me = useLoad(() => api.auth.me());
  const limits = useLoad(() => api.sell.approvals().then((x) => x.limits));
  const [changeNote, setChangeNote] = useState("");
  const leadId = params.get("lead") ?? original.data?.leadId ?? "";
  const [picked, setPicked] = useState<Record<string, Tier>>({});
  const [addOns, setAddOns] = useState<Record<string, number>>({});
  const [extra, setExtra] = useState(0);
  const [validDays, setValidDays] = useState(14);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const lead = leads.data?.find((l) => l.id === leadId);

  // Pre-select the services the client asked for on the website, or the lines of the version being revised.
  const [seeded, setSeeded] = useState(false);
  if (!seeded && reviseId && original.data && pricing.data) {
    setSeeded(true);
    const o = original.data;
    setPicked(Object.fromEntries(o.lines.filter((l) => l.kind === "service" && l.tier).map((l) => [l.key, l.tier as Tier])));
    setAddOns(Object.fromEntries(o.lines.filter((l) => l.kind === "addon").map((l) => [l.key, l.qty])));
    setExtra(o.extraDiscountPct);
    const open = o.changeRequests?.filter((c) => !c.resolvedAt).map((c) => c.comment) ?? [];
    if (open.length) setChangeNote(`As requested: ${open.join("; ")}`.slice(0, 900));
  }
  if (!seeded && !reviseId && lead && pricing.data) {
    setSeeded(true);
    setPicked(Object.fromEntries(lead.serviceIds.filter((id) => pricing.data!.services.some((s) => s.key === id)).map((id) => [id, "growth" as Tier])));
  }
  const chain = me.data && limits.data ? sellApprovalChain({ pct: extra, creatorRoles: me.data.roles, limits: limits.data }) : [];

  const result = useMemo(() => {
    if (!pricing.data || Object.keys(picked).length === 0) return null;
    return priceProposal({
      ...pricing.data,
      serviceLines: Object.entries(picked).map(([serviceKey, tier]) => ({ serviceKey, tier })),
      addOnLines: Object.entries(addOns)
        .filter(([, qty]) => qty > 0)
        .map(([addOnId, qty]) => ({ addOnId, qty })),
      extraDiscountPct: extra,
    });
  }, [pricing.data, picked, addOns, extra]);

  async function create() {
    setBusy(true);
    setError(undefined);
    try {
      const body = {
        lines: Object.entries(picked).map(([serviceKey, tier]) => ({ serviceKey, tier })),
        addOns: Object.entries(addOns)
          .filter(([, qty]) => qty > 0)
          .map(([addOnId, qty]) => ({ addOnId, qty })),
        extraDiscountPct: extra,
        validDays,
      };
      const p = reviseId ? await api.sell.revise(reviseId, { ...body, changeNote: changeNote.trim() || undefined }) : await api.proposals.create({ leadId, ...body });
      router.push(`/team/proposals/${p.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (!pricing.data || !leads.data || original.loading) return <LoadState loading={pricing.loading || leads.loading || original.loading} error={pricing.error ?? leads.error ?? original.error} />;
  if (!lead && !original.data)
    return (
      <p className="text-sm">
        Choose a lead from the <Link href="/team/leads" className="underline">pipeline</Link> first, then pick Create proposal on its card.
      </p>
    );
  const client = lead?.contact ?? original.data!.client;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
      <div className="space-y-6">
        <Card>
          <p className="text-sm text-ink-muted">For</p>
          <p className="font-semibold">{client.company || client.name}</p>
          <p className="text-sm text-ink-muted">
            {client.name} · {client.email ?? client.phone}
          </p>
          {lead && <p className="mt-2 text-sm">“{lead.need}”</p>}
          {original.data && (
            <p className="mt-3 border-t border-border pt-3 text-sm">
              New version of proposal v{original.data.version}. The client keeps seeing the current version until you send this one; then the old link shows “superseded”.
            </p>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 font-semibold">Services</h2>
          <div className="divide-y divide-border">
            {pricing.data.services.map((s) => {
              const tier = picked[s.key];
              return (
                <div key={s.key} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <label className="flex flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-[#8BB72C]"
                      checked={!!tier}
                      onChange={() =>
                        setPicked((p) => {
                          const n = { ...p };
                          if (n[s.key]) delete n[s.key];
                          else n[s.key] = "growth";
                          return n;
                        })
                      }
                    />
                    {s.name}
                  </label>
                  {tier && (
                    <Select value={tier} onChange={(e) => setPicked((p) => ({ ...p, [s.key]: e.target.value as Tier }))} aria-label={`${s.name} tier`}>
                      {TIERS.map((t) => (
                        <option key={t} value={t}>
                          {t} · {formatINR(s.tiers.find((x) => x.tier === t)?.pricePaise ?? 0)}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 font-semibold">Add-ons</h2>
          {pricing.data.addOns
            .filter((a) => !a.isCustomQuote)
            .map((a) => (
              <label key={a.id} className="flex items-center gap-3 py-1 text-sm">
                <span className="flex-1">{a.name}</span>
                <span className="text-ink-muted">{formatINR(a.pricePaise ?? 0)}</span>
                <Input
                  type="number"
                  min={0}
                  max={20}
                  className="w-16"
                  value={addOns[a.id] ?? 0}
                  onChange={(e) => setAddOns((x) => ({ ...x, [a.id]: Math.max(0, Number(e.target.value)) }))}
                />
              </label>
            ))}
        </Card>

        <AiPanel
          feature="proposal_intro"
          title="Proposal intro & scope"
          description="Written from the lead's need and the services you ticked. Copy it into the covering email or WhatsApp when you send the proposal link."
          options={{ leadId: leadId || undefined, serviceKeys: Object.keys(picked) }}
          buttonLabel="Draft intro"
        />

        <Card>
          <h2 className="mb-3 font-semibold">Terms</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Special discount (%)
              <Input type="number" min={0} max={50} value={extra} onChange={(e) => setExtra(Math.max(0, Math.min(50, Number(e.target.value))))} />
              <span className="block text-xs text-ink-muted" data-testid="approval-hint">
                {chain.length
                  ? `Needs approval before sending: ${chain.map((c) => sellApprovalLevelLabels[c]).join(" → ")}.`
                  : extra > 0
                    ? "Within your limit: no approval needed."
                    : "Above your limit, a sales manager (and the Founder above the admin limit) must approve before it can be sent."}
              </span>
            </label>
            {reviseId && (
              <label className="text-sm sm:col-span-2">
                What changed in this version (shown in the history)
                <Input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="e.g. Premium SMM tier, website removed" />
              </label>
            )}
            <label className="text-sm">
              Valid for (days)
              <Input type="number" min={1} max={60} value={validDays} onChange={(e) => setValidDays(Number(e.target.value))} />
            </label>
          </div>
        </Card>
      </div>

      <aside className="h-fit border border-border bg-surface-raised p-5 lg:sticky lg:top-6">
        <h2 className="mb-3 font-display text-lg">Summary</h2>
        {result ? <ProposalSummary p={result} bundleName={result.bundle?.name} /> : <p className="text-sm text-ink-muted">Tick a service to start.</p>}
        {error && <p className="mt-3 text-sm text-red">{error}</p>}
        <Button className="mt-4 w-full" disabled={!result || busy} onClick={create}>
          {busy ? "Saving…" : reviseId ? "Save new version" : "Save proposal"}
        </Button>
      </aside>
    </div>
  );
}
