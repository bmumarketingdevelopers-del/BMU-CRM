"use client";

import { useState } from "react";
import { settingsDefaults, type SettingsValue } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { Button, Input, LoadState, PageTitle } from "@/components/ui";
import { Field, ReadOnlyNote, SaveBar, useSaver, useSettingsAndAccess } from "../_platform/kit";

type Branding = SettingsValue<"branding">;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Picks dark or light text for a background colour. */
function onColour(hex: string) {
  if (!HEX.test(hex)) return "#121F2F";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? "#121F2F" : "#FFFFFF";
}

export default function BrandingPage() {
  const data = useSettingsAndAccess();
  if (!data.data) {
    return (
      <>
        <PageTitle title="Branding & Theme" subtitle="Colours and name used on client-facing screens and documents." />
        <LoadState loading={data.loading} error={data.error} />
      </>
    );
  }
  return <Editor initial={data.data.settings.branding} canEdit={data.data.access.platform} />;
}

function ColourField({ label, hint, value, onChange, disabled }: { label: string; hint: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input type="color" disabled={disabled} value={HEX.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-9 w-12 cursor-pointer border border-border bg-surface-raised p-0.5" aria-label={`${label} picker`} />
        <Input disabled={disabled} className={`w-32! font-mono uppercase ${HEX.test(value) ? "" : "border-red"}`} value={value} maxLength={7} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      </div>
    </Field>
  );
}

function Editor({ initial, canEdit }: { initial: Branding; canEdit: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [b, setB] = useState(initial);
  const { busy, msg, setMsg, save } = useSaver("branding", (s) => {
    setSaved(s.branding);
    setB(s.branding);
  });
  const dirty = JSON.stringify(saved) !== JSON.stringify(b);
  const valid = HEX.test(b.primary) && HEX.test(b.accent) && HEX.test(b.background);
  const set = (p: Partial<Branding>) => setB({ ...b, ...p });

  return (
    <>
      <PageTitle title="Branding & Theme" subtitle="Colours, logo and name used on client-facing screens and documents: proposals, agreements, invoices and the client app." />
      {!canEdit && <ReadOnlyNote who="platform" />}
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_1fr]">
        <Panel title="Brand" subtitle="Applies to client-facing documents and the client app. The Command Centre and Team app keep the standard look.">
          <div className="space-y-5">
            <Field label="Client app name" hint="Shown in the client app header and in emails.">
              <Input disabled={!canEdit} maxLength={60} value={b.clientAppName} onChange={(e) => set({ clientAppName: e.target.value })} />
            </Field>
            <Field label="Logo URL" hint="A link to a PNG or SVG logo. Leave empty to show the name instead.">
              <Input disabled={!canEdit} maxLength={500} placeholder="https://…/logo.svg" value={b.logoUrl} onChange={(e) => set({ logoUrl: e.target.value })} />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <ColourField label="Primary colour" hint="Headings, buttons and totals" value={b.primary} onChange={(v) => set({ primary: v })} disabled={!canEdit} />
              <ColourField label="Accent colour" hint="The one thing to notice" value={b.accent} onChange={(v) => set({ accent: v })} disabled={!canEdit} />
              <ColourField label="Background" hint="Page and card background" value={b.background} onChange={(v) => set({ background: v })} disabled={!canEdit} />
            </div>
            {canEdit && (
              <Button variant="ghost" className="px-0!" onClick={() => set({ primary: settingsDefaults.branding.primary, accent: settingsDefaults.branding.accent, background: settingsDefaults.branding.background })}>
                Reset to BMU colours
              </Button>
            )}
          </div>
        </Panel>

        <Panel title="Live preview" subtitle="How a client sees a card and button">
          <Preview b={valid ? b : saved} />
        </Panel>
      </div>
      {canEdit && (
        <SaveBar
          busy={busy}
          dirty={dirty}
          disabled={!valid}
          msg={!valid ? { ok: false, text: "Colours must look like #121F2F." } : msg}
          onSave={() => save(b)}
          onReset={() => {
            setB(saved);
            setMsg(undefined);
          }}
        />
      )}
    </>
  );
}

function Preview({ b }: { b: Branding }) {
  return (
    <div className="border border-border" style={{ background: b.background }}>
      <div className="flex items-center justify-between px-5 py-3" style={{ background: b.primary, color: onColour(b.primary) }}>
        {b.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={b.logoUrl} alt={b.clientAppName} className="h-6 max-w-[140px] object-contain" />
        ) : (
          <span className="text-sm font-semibold tracking-tight">{b.clientAppName || "Client app"}</span>
        )}
        <span className="text-xs opacity-80">Sunrise Bakery</span>
      </div>
      <div className="space-y-4 p-5">
        <div className="border p-5" style={{ borderColor: `${b.primary}22`, background: b.background, color: onColour(b.background) }}>
          <div className="flex items-center gap-2 text-xs" style={{ color: b.accent }}>
            <span className="inline-block h-2 w-2" style={{ background: b.accent }} />
            Ready for your review
          </div>
          <p className="mt-2 text-lg font-semibold" style={{ color: onColour(b.background) === "#FFFFFF" ? "#FFFFFF" : b.primary }}>
            Diwali offer post
          </p>
          <p className="mt-1 text-sm opacity-70">Social Media Management · Version 2</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="px-4 py-2 text-sm font-medium" style={{ background: b.primary, color: onColour(b.primary) }}>
              Approve
            </span>
            <span className="border px-4 py-2 text-sm" style={{ borderColor: b.primary, color: onColour(b.background) === "#FFFFFF" ? "#FFFFFF" : b.primary }}>
              Ask for changes
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between border-t pt-3 text-sm" style={{ borderColor: `${b.primary}22`, color: onColour(b.background) }}>
          <span className="opacity-70">Invoice BMU/2026-10/0042</span>
          <span className="font-semibold" style={{ color: onColour(b.background) === "#FFFFFF" ? "#FFFFFF" : b.primary }}>
            ₹35,400
          </span>
        </div>
      </div>
    </div>
  );
}
