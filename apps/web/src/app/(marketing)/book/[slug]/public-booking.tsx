"use client";

import { useState } from "react";
import { SlotPicker, whenLabel } from "@/components/comms/meetings";
import { Button, Input, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export function PublicBooking({ slug }: { slug: string }) {
  const slots = useLoad(() => api.meetings.publicSlots(slug), { live: false });
  const [pick, setPick] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", company: "", agenda: "" });
  const [done, setDone] = useState<{ startAt: string; host: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!slots.data) {
    if (slots.loading) return <LoadState loading />;
    return (
      <div className="border border-border p-6 text-center">
        <h1 className="text-lg font-semibold">This booking link is not active</h1>
        <p className="mt-2 text-sm text-ink-muted">Please contact BMU Marketing on bmumarketing.in.</p>
      </div>
    );
  }
  if (done)
    return (
      <div className="border border-border p-6 text-center" data-testid="booking-done">
        <h1 className="font-display text-2xl">You&apos;re booked</h1>
        <p className="mt-2 text-sm">
          {whenLabel(done.startAt)} (IST) with {done.host}. We emailed you the details and a calendar invite.
        </p>
      </div>
    );
  const s = slots.data;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <div>
      <p className="text-sm text-ink-muted">BMU Marketing</p>
      <h1 className="font-display text-3xl">{s.title}</h1>
      <p className="mb-6 mt-1 text-sm text-ink-muted">
        {s.durationMin} minutes with {s.host.name}
        {s.host.title ? `, ${s.host.title}` : ""}
      </p>
      <SlotPicker slots={s} value={pick} onChange={setPick} />
      {pick && (
        <div className="mt-6 space-y-2">
          <Input placeholder="Your name" value={form.name} onChange={set("name")} aria-label="Your name" />
          <Input placeholder="Email" type="email" value={form.email} onChange={set("email")} aria-label="Email" />
          <Input placeholder="WhatsApp number (optional)" value={form.phone} onChange={set("phone")} aria-label="Phone" />
          <Input placeholder="Company (optional)" value={form.company} onChange={set("company")} aria-label="Company" />
          <textarea className="h-20 w-full border border-border bg-surface-raised p-2 text-sm" placeholder="What would you like to discuss?" value={form.agenda} onChange={set("agenda")} aria-label="Agenda" />
          {error && <p className="text-sm text-red">{error}</p>}
          <Button
            disabled={busy || form.name.trim().length < 2 || !form.email.includes("@")}
            data-testid="public-book"
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.meetings.publicBook(slug, { startAt: pick, name: form.name, email: form.email, phone: form.phone || undefined, company: form.company || undefined, agenda: form.agenda || undefined });
                setDone(r);
              } catch (e) {
                setError((e as Error).message);
                slots.reload();
              } finally {
                setBusy(false);
              }
            }}
          >
            Book {whenLabel(pick)}
          </Button>
        </div>
      )}
    </div>
  );
}
