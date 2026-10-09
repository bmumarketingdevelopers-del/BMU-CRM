"use client";

/**
 * ImportWizard: CSV import for any registered import entity (spec bulk_import).
 * Steps: 1 upload (or paste) → 2 map columns → 3 check rows (errors + duplicates) → 4 import → done with an error report.
 *
 *   <ImportWizard entity="tasks" open={open} onClose={() => setOpen(false)} onDone={(job) => reload()} />
 *
 * The server side is ImportsService; register a new entity with ActionsRegistry.importEntities (see docs/flows/core-actions.md).
 */
import { useEffect, useState } from "react";
import type { CoreImportEntityInfo, CoreImportJob } from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDialog } from "./action-drawer";

type Step = "upload" | "map" | "done";

export function ImportWizard({ entity, open, onClose, onDone }: { entity: string; open: boolean; onClose: () => void; onDone?: (job: CoreImportJob) => void }) {
  const [info, setInfo] = useState<CoreImportEntityInfo>();
  const [step, setStep] = useState<Step>("upload");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string>();
  const [job, setJob] = useState<CoreImportJob>();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.imports
      .entities()
      .then((all) => {
        if (!live) return;
        const e = all.find((x) => x.entity === entity);
        if (e) setInfo(e);
        else setError("You can't import these here");
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [open, entity]);

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    const j = await run(() => api.imports.preview(entity, { csv, fileName }));
    if (j) {
      setJob(j);
      setMapping(j.mapping);
      setStep("map");
    }
  }
  async function remap(next: Record<string, string>) {
    setMapping(next);
    if (!job) return;
    const j = await run(() => api.imports.remap(job.id, next));
    if (j) setJob(j);
  }
  async function commit() {
    if (!job) return;
    const j = await run(() => api.imports.commit(job.id, skipDuplicates));
    if (j) {
      setJob(j);
      setStep("done");
      onDone?.(j);
    }
  }
  function sample() {
    if (!info) return;
    const url = URL.createObjectURL(new Blob([info.sampleCsv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${entity}-sample.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const failed = job?.rows.filter((r) => !r.ok) ?? [];
  const dupes = job?.rows.filter((r) => r.ok && r.duplicate) ?? [];
  const willImport = job ? job.rows.filter((r) => r.ok && !(skipDuplicates && r.duplicate)).length : 0;
  const btn = "bg-charcoal px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40";
  const ghost = "border border-border px-3 py-2 text-sm";

  return (
    <ActionDialog
      open={open}
      title={`Import ${info?.label.toLowerCase() ?? entity} from CSV`}
      onClose={onClose}
      testId="import-wizard"
      footer={
        step === "upload" ? (
          <>
            <button type="button" className={btn} disabled={!csv.trim() || busy} onClick={preview}>
              {busy ? "Reading…" : "Next: match columns"}
            </button>
            <button type="button" className={ghost} onClick={onClose}>
              Cancel
            </button>
          </>
        ) : step === "map" ? (
          <>
            <button type="button" className={btn} disabled={!willImport || busy} onClick={commit}>
              {busy ? "Working…" : `Import ${willImport} row${willImport === 1 ? "" : "s"}`}
            </button>
            <button type="button" className={ghost} onClick={() => setStep("upload")}>
              Back
            </button>
          </>
        ) : (
          <button type="button" className={btn} onClick={onClose}>
            Close
          </button>
        )
      }
    >
      <ol className="flex gap-3 text-xs text-ink-muted" aria-label="Steps">
        <li className={step === "upload" ? "font-semibold text-ink" : ""}>1 Upload</li>
        <li className={step === "map" ? "font-semibold text-ink" : ""}>2 Match and check</li>
        <li className={step === "done" ? "font-semibold text-ink" : ""}>3 Done</li>
      </ol>
      {error && (
        <p role="alert" className="border border-red bg-red/10 px-3 py-2 text-sm">
          {error}
        </p>
      )}
      {step === "upload" && (
        <>
          {info && (
            <p className="text-xs text-ink-muted">
              Columns: {info.fields.map((f) => `${f.label}${f.required ? " (required)" : ""}`).join(", ")}.{" "}
              <button type="button" className="underline" onClick={sample}>
                Download a sample file
              </button>
            </p>
          )}
          <label className="block">
            <span className="text-xs font-medium">CSV file</span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="mt-1 block w-full text-sm"
              aria-label="CSV file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 5_000_000) return setError("The file is too big (5 MB max)");
                setFileName(f.name);
                setCsv(await f.text());
              }}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Or paste rows (first line is the header)</span>
            <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={5} className="mt-1 w-full border border-border bg-surface-raised px-2 py-1 font-mono text-xs" aria-label="CSV text" />
          </label>
        </>
      )}
      {step === "map" && job && info && (
        <>
          <div className="space-y-1">
            <p className="text-xs font-medium">Match your columns</p>
            {job.columns.map((c) => (
              <label key={c} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">{c}</span>
                <select
                  value={mapping[c] ?? ""}
                  onChange={(e) => {
                    const next = { ...mapping };
                    if (e.target.value) next[c] = e.target.value;
                    else delete next[c];
                    remap(next);
                  }}
                  className="w-44 border border-border bg-surface-raised px-1 py-1"
                  aria-label={`Field for ${c}`}
                >
                  <option value="">Ignore</option>
                  {info.fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                      {f.required ? " *" : ""}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <p className="text-sm" data-testid="import-summary">
            {job.rowsTotal} rows · <span className="font-semibold">{job.rowsOk} ready</span> · {job.rowsFailed} with problems{dupes.length ? ` · ${dupes.length} look like duplicates` : ""}
          </p>
          {dupes.length > 0 && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} /> Skip rows that look like duplicates
            </label>
          )}
          {(failed.length > 0 || dupes.length > 0) && (
            <ul className="max-h-48 space-y-1 overflow-y-auto border border-border p-2 text-xs">
              {[...failed, ...dupes].slice(0, 50).map((r) => (
                <li key={r.row}>
                  <span className="font-medium">Row {r.row}:</span> {r.errors.length ? r.errors.join("; ") : `Possible duplicate (${r.duplicate})`}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {step === "done" && job && (
        <>
          <p className="text-sm">
            Imported <span className="font-semibold">{job.rowsOk}</span> row{job.rowsOk === 1 ? "" : "s"}.{job.rowsFailed ? ` ${job.rowsFailed} were not imported.` : ""}
          </p>
          {job.rowsFailed > 0 && (
            <a className="text-sm underline" href={`/api${api.imports.errorReportPath(job.id)}`}>
              Download the error report
            </a>
          )}
        </>
      )}
    </ActionDialog>
  );
}
