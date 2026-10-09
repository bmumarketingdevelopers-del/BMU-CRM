"use client";

/** "Upload files" on client and project pages: opens the + New → File upload drawer with the client / project filled in. */
import Link from "next/link";
import { useActionsMaybe } from "@/components/actions/actions-provider";
import type { NewPrefill } from "@/components/actions/new-registry";

export function UploadFilesButton({ prefill, onSaved }: { prefill: NewPrefill; onSaved?: () => void }) {
  const actions = useActionsMaybe();
  if (!actions?.canNew("file")) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={() => actions.openNew("file", prefill, onSaved)} className="border border-border bg-surface-raised px-3 py-1.5 text-sm hover:border-ink" data-testid="upload-files-here">
        Upload files
      </button>
      <Link href="/team/files" className="text-sm underline">
        Files
      </Link>
    </span>
  );
}
