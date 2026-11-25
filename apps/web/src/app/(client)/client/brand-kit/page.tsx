"use client";

import { useRef, useState } from "react";
import type { CraftBrandKitView } from "@bmu/shared";
import { ClientChecklist } from "@/components/client-checklist";
import { BrandKitCard } from "@/components/craft/craft-bits";
import { Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const MAX_MB = 100;

export default function ClientBrandKitPage() {
  const loaded = useLoad(() => api.creative.clientBrandKit(), { live: false });
  const [fresh, setFresh] = useState<CraftBrandKitView>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const kit = fresh ?? loaded.data;

  async function upload(files: File[]) {
    setError(undefined);
    setDone(undefined);
    const big = files.find((f) => f.size > MAX_MB * 1024 * 1024);
    if (big) return setError(`${big.name} is too large. Files can be up to ${MAX_MB} MB each.`);
    let sent = 0;
    try {
      for (const f of files) {
        setBusy(files.length > 1 ? `Uploading ${sent + 1} of ${files.length}…` : "Uploading…");
        setFresh(await api.creative.uploadClientBrandFile(f));
        sent++;
      }
    } catch (e) {
      setError(`${files[sent].name} was not uploaded: ${(e as Error).message}`);
    } finally {
      setBusy(undefined);
      if (sent) setDone(`${sent === 1 ? "1 file" : `${sent} files`} added to your brand kit. Your Client Manager has been told.`);
    }
  }

  return (
    <>
      <PageTitle
        title="Brand kit"
        subtitle={`What our team follows for your brand. Upload your logos, brand guidelines, fonts and other brand files (up to ${MAX_MB} MB each).`}
        action={
          <Button onClick={() => picker.current?.click()} disabled={!!busy || !kit}>
            {busy ?? "Upload brand kit"}
          </Button>
        }
      />
      <input
        ref={picker}
        type="file"
        multiple
        className="hidden"
        aria-label="Brand kit files"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void upload(files);
        }}
      />
      {error && (
        <p role="alert" className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="mb-4 border border-green bg-green/10 px-4 py-2 text-sm">
          {done}
        </p>
      )}
      {/* The card keeps its own copy of the kit, so a new upload remounts it. */}
      {kit ? <BrandKitCard key={kit.files[0]?.id ?? "empty"} kit={kit} readOnly /> : <LoadState loading={loaded.loading} error={loaded.error} />}
      <ClientChecklist kind="items" />
    </>
  );
}
