"use client";

import { useState } from "react";
import { formatINR, settingsDefaults, type SettingsValue, type SettingsView } from "@bmu/shared";
import { Panel, Tabs } from "@/components/dash";
import { Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ErrorNote } from "../_admin-org/kit";

type Templates = SettingsValue<"documentTemplates">;
type Key = keyof Templates;
const FIELDS: { key: Key; label: string; short: string; hint: string; max: number }[] = [
  { key: "proposalIntro", label: "Proposal intro", short: "Intro", hint: "The opening note at the top of every proposal.", max: 4000 },
  { key: "proposalTerms", label: "Proposal terms", short: "Terms", hint: "Payment and scope terms shown under the price.", max: 8000 },
  { key: "agreementBody", label: "Agreement", short: "Agreement", hint: "The service agreement the client signs when accepting.", max: 20000 },
];
const SAMPLE = [
  { name: "Social Media Management · Growth", note: "Monthly", paise: 2_500_000 },
  { name: "Logo & Brand Kit · Starter", note: "One-time", paise: 1_500_000 },
];

export default function DocumentTemplatesPage() {
  const s = useLoad(() => api.settings.all());
  const [view, setView] = useState<SettingsView>();
  const data = view ?? s.data;
  return (
    <>
      <PageTitle title="Proposal & Agreement Templates" subtitle="The words clients read on every proposal and the agreement they sign. The preview shows it the way the client sees it." />
      <LoadState loading={!data && s.loading} error={s.error} />
      {data && <Editor key={JSON.stringify(data.documentTemplates)} data={data} onSaved={setView} />}
    </>
  );
}

function Editor({ data, onSaved }: { data: SettingsView; onSaved: (v: SettingsView) => void }) {
  const [t, setT] = useState<Templates>(data.documentTemplates);
  const [active, setActive] = useState<Key>("proposalIntro");
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const can = data.canEdit.documentTemplates;
  const dirty = FIELDS.some((f) => t[f.key] !== data.documentTemplates[f.key]);
  const field = FIELDS.find((f) => f.key === active)!;

  async function save() {
    setError(undefined);
    setSaved(false);
    try {
      onSaved(await api.settings.save("documentTemplates", t));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const subtotal = SAMPLE.reduce((s, l) => s + l.paise, 0);
  const gst = Math.round(subtotal * 0.18);

  return (
    <div className="grid grid-cols-1 items-start gap-6 [&>*]:min-w-0 lg:grid-cols-2">
      <Panel
        title="Edit"
        subtitle={field.hint}
        action={<Tabs value={active} onChange={setActive} options={FIELDS.map((f) => ({ value: f.key, label: f.short }))} />}
      >
        <ErrorNote>{error}</ErrorNote>
        {saved && !dirty && <p className="mb-4 border border-green bg-green/10 px-4 py-2 text-sm">Templates saved and logged. New proposals use them.</p>}
        <label htmlFor="tpl" className="mb-1 block text-xs text-ink-muted">
          {field.label}
        </label>
        <textarea
          id="tpl"
          value={t[active]}
          disabled={!can}
          maxLength={field.max}
          onChange={(e) => setT({ ...t, [active]: e.target.value })}
          rows={active === "agreementBody" ? 18 : 10}
          className="w-full border border-border bg-surface-raised px-3 py-2 text-sm leading-relaxed"
        />
        <div className="mt-1 flex justify-between text-xs text-ink-muted">
          <span>Blank lines start a new paragraph.</span>
          <span className="tabular-nums">
            {t[active].length.toLocaleString("en-IN")} / {field.max.toLocaleString("en-IN")}
          </span>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {can ? (
            <>
              <Button disabled={!dirty} onClick={save}>
                Save templates
              </Button>
              <Button variant="ghost" disabled={!dirty} onClick={() => setT(data.documentTemplates)}>
                Discard changes
              </Button>
              <Button
                variant="ghost"
                disabled={t[active] === settingsDefaults.documentTemplates[active]}
                onClick={() => setT({ ...t, [active]: settingsDefaults.documentTemplates[active] })}
              >
                Use BMU default
              </Button>
            </>
          ) : (
            <p className="text-sm text-ink-muted">Only the Founder or Admin can change templates.</p>
          )}
        </div>
      </Panel>

      <Panel title="Client preview" subtitle="Sample client and prices. Updates as you type.">
        <div className="bg-canvas/40 p-4 sm:p-6">
          <div className="bg-surface-raised p-5 sm:p-7">
            <p className="text-sm text-ink-muted">Proposal for</p>
            <h3 className="font-display text-2xl">Sunrise Realty Pvt Ltd</h3>
            <p className="mt-1 text-xs text-ink-muted">Prepared by BMU Marketing · valid for 14 days</p>
            <Paragraphs text={t.proposalIntro} className={`mt-5 text-sm ${active === "proposalIntro" ? "outline-1 outline-offset-4 outline-green outline-dashed" : ""}`} />
            <table className="mt-5 w-full text-sm">
              <tbody>
                {SAMPLE.map((l) => (
                  <tr key={l.name} className="border-b border-border">
                    <td className="py-2">
                      {l.name}
                      <span className="block text-xs text-ink-muted">{l.note}</span>
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatINR(l.paise)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="pt-2 text-ink-muted">GST 18%</td>
                  <td className="pt-2 text-right tabular-nums text-ink-muted">{formatINR(gst)}</td>
                </tr>
                <tr>
                  <td className="pt-1 font-semibold">Total</td>
                  <td className="pt-1 text-right font-semibold tabular-nums">{formatINR(subtotal + gst)}</td>
                </tr>
              </tbody>
            </table>
            <h4 className="mt-6 text-[11px] uppercase tracking-[0.1em] text-ink-muted">Terms</h4>
            <Paragraphs text={t.proposalTerms} className={`mt-2 text-xs text-ink-muted ${active === "proposalTerms" ? "outline-1 outline-offset-4 outline-green outline-dashed" : ""}`} />
          </div>
          <div className="mt-4 bg-surface-raised p-5 sm:p-7">
            <h4 className="font-semibold">Service agreement</h4>
            <Paragraphs text={t.agreementBody} className={`mt-3 max-h-72 overflow-y-auto text-xs leading-relaxed ${active === "agreementBody" ? "outline-1 outline-offset-4 outline-green outline-dashed" : ""}`} />
            <p className="mt-4 border-t border-border pt-3 text-xs text-ink-muted">Signed electronically by typing a full name. Time and IP address are recorded.</p>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function Paragraphs({ text, className = "" }: { text: string; className?: string }) {
  const parts = text.split(/\n\s*\n/).filter((p) => p.trim());
  return (
    <div className={`space-y-2 ${className}`}>
      {parts.length ? parts.map((p, i) => <p key={i} className="whitespace-pre-line">{p}</p>) : <p className="italic text-ink-muted">Empty</p>}
    </div>
  );
}
