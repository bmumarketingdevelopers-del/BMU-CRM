"use client";

import Link from "next/link";
import { use, useState } from "react";
import { SimpleText } from "@/components/workspace/simple-text";
import { Badge, Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export default function SopPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.workspace.sop(id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const s = loaded.data;
  const current = !!s && s.acknowledgedVersion === s.version;

  async function acknowledge() {
    setBusy(true);
    setError(undefined);
    try {
      await api.teamFlows.people.acknowledgeSop(id);
      loaded.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Link href="/team/sops" className="text-sm text-ink-muted hover:text-ink">
        ← SOP library
      </Link>
      {!s ? (
        <div className="mt-6">
          <LoadState loading={loaded.loading} error={loaded.error} />
        </div>
      ) : (
        <>
          <PageTitle
            title={s.title}
            subtitle={`${s.department.name} · version ${s.version}`}
            action={current ? <Badge tone="green">You read this version{s.acknowledgedAt ? ` on ${fmt(s.acknowledgedAt)}` : ""}</Badge> : <Badge tone="dark">Read-only</Badge>}
          />
          <article className="max-w-3xl border border-border bg-surface-raised px-6 py-8 sm:px-10">
            <SimpleText body={s.body} />
          </article>
          <div className="mt-6 max-w-3xl border border-border bg-canvas/40 px-6 py-4">
            {current ? (
              <p className="text-sm">Thanks. Your acknowledgement of version {s.version} is recorded.</p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">
                  {s.acknowledgedVersion ? `This SOP changed since you read version ${s.acknowledgedVersion}. Read it again and confirm.` : "Read the steps above, then confirm. Your onboarding checklist ticks itself."}
                </p>
                <Button onClick={acknowledge} disabled={busy}>
                  {busy ? "Saving…" : "I have read this"}
                </Button>
              </div>
            )}
            {error && <p className="mt-2 text-sm text-red">{error}</p>}
          </div>
        </>
      )}
    </>
  );
}
