"use client";

import { useState } from "react";
import { formatINR, rupeesToPaise, type CreatorProfile } from "@bmu/shared";
import { Empty, KeyValues, Panel } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function CreatorProfilePage() {
  const loaded = useLoad(() => api.creator.profile());
  const [fresh, setFresh] = useState<CreatorProfile>();
  const p = fresh ?? loaded.data;
  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle title="Profile" subtitle="Your details, the niches you create for and your standard rates. BMU sees these when choosing creators." />
      {!p ? <LoadState loading={loaded.loading} error={loaded.error} /> : <ProfileBody key={JSON.stringify(p)} p={p} onSaved={setFresh} />}
    </div>
  );
}

function ProfileBody({ p, onSaved }: { p: CreatorProfile; onSaved: (p: CreatorProfile) => void }) {
  const [name, setName] = useState(p.name);
  const [phone, setPhone] = useState(p.phone ?? "");
  const [niche, setNiche] = useState(p.niche.join(", "));
  const [rates, setRates] = useState(p.rates.map((r) => ({ label: r.label, rupees: String(r.pricePaise / 100) })));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.workspace.updateMe({ name, phone });
      const saved = await api.creator.saveProfile({
        niche: niche.split(",").map((n) => n.trim()).filter(Boolean),
        rates: rates.filter((r) => r.label.trim()).map((r) => ({ label: r.label.trim(), pricePaise: rupeesToPaise(Number(r.rupees || 0)) })),
      });
      setEditing(false);
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!editing)
    return (
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Your details" action={<Button variant="ghost" className="px-0 py-0 text-xs" onClick={() => setEditing(true)}>Edit profile</Button>}>
          <KeyValues
            items={[
              { k: "Name", v: p.name },
              { k: "Email", v: p.email ?? "—" },
              { k: "Mobile", v: p.phone ?? "—" },
              { k: "Rating from BMU", v: p.rating ? `${p.rating.toFixed(1)} / 5` : "Not rated yet" },
            ]}
          />
          <h3 className="mt-6 mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted">Niches</h3>
          <div className="flex flex-wrap gap-1.5">{p.niche.length ? p.niche.map((n) => <Badge key={n} tone="dark">{n}</Badge>) : <span className="text-sm text-ink-muted">None added</span>}</div>
        </Panel>
        <Panel title="Rates" subtitle="Your standard prices, before TDS">
          {p.rates.length ? <KeyValues items={p.rates.map((r) => ({ k: r.label, v: formatINR(r.pricePaise) }))} /> : <Empty>No rates added yet.</Empty>}
        </Panel>
      </div>
    );

  return (
    <Panel title="Edit profile">
      <form onSubmit={save} className="grid max-w-2xl gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-ink-muted">Name</span>
            <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
          </label>
          <label className="text-sm">
            <span className="text-ink-muted">Mobile number</span>
            <Input className="mt-1" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="10-digit mobile" />
          </label>
        </div>
        <label className="text-sm">
          <span className="text-ink-muted">Niches (comma separated)</span>
          <Input className="mt-1" value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="Food, Travel, Real estate" />
        </label>
        <div>
          <p className="text-sm text-ink-muted">Rates (₹)</p>
          <div className="mt-1 grid gap-2">
            {rates.map((r, i) => (
              <div key={i} className="flex gap-2">
                <Input value={r.label} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="e.g. Instagram reel" aria-label="Rate name" />
                <Input type="number" min={0} className="w-36" value={r.rupees} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, rupees: e.target.value } : x)))} aria-label="Price in rupees" />
                <Button type="button" variant="ghost" onClick={() => setRates(rates.filter((_, j) => j !== i))} aria-label="Remove rate">
                  ×
                </Button>
              </div>
            ))}
          </div>
          <Button type="button" variant="secondary" className="mt-2" onClick={() => setRates([...rates, { label: "", rupees: "" }])}>
            Add a rate
          </Button>
        </div>
        {error && <p className="text-sm text-red">{error}</p>}
        <div className="flex gap-2">
          <Button disabled={busy}>Save profile</Button>
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  );
}
