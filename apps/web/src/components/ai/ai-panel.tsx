"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import type { AiGenerateFeature, AiGenerateInput, AiResult } from "@bmu/shared";
import { Button } from "@/components/ui";
import { aiFeatureOn, aiPlain, aiStream, useAiStatus } from "@/lib/ai";
import { AiText } from "./ai-text";

/** "AI" / "Basic" label and the plain-English notice (basic mode, budget reached, key problem). */
export function AiNotice({ result, canManage }: { result: Pick<AiResult, "mode" | "notice">; canManage?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
      <span className={`px-1.5 py-0.5 font-medium ${result.mode === "ai" ? "bg-green/15 text-ink" : "border border-border"}`}>{result.mode === "ai" ? "AI" : "Basic"}</span>
      {result.notice && (
        <span>
          {result.notice}
          {canManage && result.mode === "basic" && (
            <>
              {" "}
              <Link href="/admin/ai" className="underline">
                Open AI Copilot settings
              </Link>
            </>
          )}
        </span>
      )}
    </div>
  );
}

export type AiPanelProps = {
  feature: AiGenerateFeature;
  title: string;
  description?: string;
  targetId?: string;
  options?: AiGenerateInput["options"];
  /** Optional text the person pastes (meeting notes, copy to check…). */
  input?: { label: string; placeholder?: string; rows?: number; required?: boolean };
  buttonLabel?: string;
  /** Controls shown next to the button (e.g. Email / WhatsApp). */
  controls?: ReactNode;
  /** Puts the (edited) draft where the person works. The person still confirms the final action there. */
  onInsert?: (text: string, result: AiResult) => void | Promise<void>;
  insertLabel?: string;
  /** Hide Insert for results that have nothing to insert (e.g. triage without an add-on). */
  canInsert?: (result: AiResult) => boolean;
  /** Extra buttons for the finished result. */
  actions?: (text: string, result: AiResult) => ReactNode;
  className?: string;
};

/** Reusable AI box: generate (streamed), then Copy, Edit, Regenerate and Insert. Never sends anything by itself. */
export function AiPanel({ feature, title, description, targetId, options, input, buttonLabel = "Draft with AI", controls, onInsert, insertLabel = "Insert", canInsert, actions, className = "" }: AiPanelProps) {
  const status = useAiStatus();
  const [text, setText] = useState("");
  const [extra, setExtra] = useState("");
  const [result, setResult] = useState<AiResult>();
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [inserted, setInserted] = useState(false);
  const abort = useRef<AbortController | null>(null);

  if (status && !aiFeatureOn(status, feature)) return null;

  async function generate() {
    if (input?.required && extra.trim().length < 3) return setError(`Add the ${input.label.toLowerCase()} first`);
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setError(undefined);
    setEditing(false);
    setInserted(false);
    setResult(undefined);
    setText("");
    setWorking("Thinking…");
    try {
      let streamed = "";
      const r = await aiStream(
        "/ai/generate/stream",
        { feature, targetId, input: extra.trim() || undefined, options: options ?? {} },
        (e) => {
          if (e.t === "delta") {
            streamed += e.text;
            setText(streamed);
            setWorking("Writing…");
          } else if (e.t === "status") setWorking(e.text);
        },
        ctl.signal,
      );
      setResult(r);
      setText(r.text);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(aiPlain(text));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Copy is blocked by the browser. Select the text and copy it instead.");
    }
  }

  return (
    <section className={`border border-border bg-surface-raised p-5 ${className}`} aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 font-semibold">
            <span aria-hidden className="inline-block size-2 bg-green" />
            {title}
          </h3>
          {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {controls}
          <Button type="button" variant={result ? "secondary" : "primary"} onClick={generate} disabled={!!working}>
            {working ? "Working…" : result ? "Regenerate" : buttonLabel}
          </Button>
        </div>
      </div>
      {input && (
        <label className="mt-3 grid gap-1 text-sm">
          {input.label}
          <textarea value={extra} onChange={(e) => setExtra(e.target.value)} rows={input.rows ?? 4} placeholder={input.placeholder} className="w-full border border-border bg-surface px-3 py-2 text-sm" />
        </label>
      )}
      {error && (
        <p className="mt-3 border border-red bg-red/10 px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      {(working || text) && (
        <div className="mt-4 border-t border-border pt-4" aria-live="polite">
          {result && (
            <div className="mb-3">
              <AiNotice result={result} canManage={status?.canManage} />
            </div>
          )}
          {working && !text && <p className="animate-pulse text-sm text-ink-muted">{working}</p>}
          {editing ? (
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(18, Math.max(6, text.split("\n").length + 1))} className="w-full border border-border bg-surface px-3 py-2 font-mono text-[13px] leading-relaxed" aria-label="Edit the draft" />
          ) : (
            text && <AiText text={text} />
          )}
          {working && text && <p className="mt-2 text-xs text-ink-muted">{working}</p>}
          {result && !working && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {onInsert && (!canInsert || canInsert(result)) && (
                <Button
                  type="button"
                  onClick={async () => {
                    try {
                      await onInsert(text, result);
                      setInserted(true);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  {inserted ? "Inserted ✓" : insertLabel}
                </Button>
              )}
              {actions?.(text, result)}
              <Button type="button" variant="secondary" onClick={() => setEditing((x) => !x)}>
                {editing ? "Done editing" : "Edit"}
              </Button>
              <Button type="button" variant="secondary" onClick={copy}>
                {copied ? "Copied ✓" : "Copy"}
              </Button>
              <Button type="button" variant="ghost" onClick={generate}>
                Regenerate
              </Button>
            </div>
          )}
          {result && !working && <p className="mt-3 text-[11px] text-ink-muted">AI drafts can be wrong. Check names, numbers and dates before you use it — nothing is sent until you send it.</p>}
        </div>
      )}
    </section>
  );
}
