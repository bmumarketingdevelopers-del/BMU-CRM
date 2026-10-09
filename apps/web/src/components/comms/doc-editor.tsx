"use client";

// v17 collaborative documents: a plain text editor backed by Yjs so two people can type at once without losing
// each other's words. Each change is sent as a small Yjs update; changes from others arrive on live updates (and a
// short poll while the page is open) and are merged in place, keeping your cursor where it was.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { docKindLabels, type DocDetail } from "@bmu/shared";
import { Presence } from "@/components/live/presence";
import { Badge, Button, Input, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLiveChanges } from "@/lib/live";
import { useLoad } from "@/lib/use-load";

const enc = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const dec = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const LOCAL = "local";

export function DocScreen({ id, backHref, team }: { id: string; backHref: string; team: boolean }) {
  const loaded = useLoad(() => api.docs.get(id), { live: false });
  if (!loaded.data) return <LoadState loading={loaded.loading} error={loaded.error} />;
  return <DocEditor initial={loaded.data} backHref={backHref} team={team} />;
}

function DocEditor({ initial, backHref, team }: { initial: DocDetail; backHref: string; team: boolean }) {
  const [meta, setMeta] = useState(initial);
  const [ydoc] = useState(() => {
    const d = new Y.Doc();
    Y.applyUpdate(d, dec(initial.state), "remote");
    return d;
  });
  const ytext = ydoc.getText("body");
  const [value, setValue] = useState(() => ytext.toString());
  const [status, setStatus] = useState<"saved" | "saving" | "offline">("saved");
  const [error, setError] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<Uint8Array[]>([]);
  const sending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editable = meta.can.edit;

  const applyRemote = useCallback(
    (b64: string) => {
      const update = dec(b64);
      if (update.length <= 2) return; // empty update
      const el = area.current;
      const focused = !!el && document.activeElement === el;
      const start = focused ? Y.createRelativePositionFromTypeIndex(ytext, el.selectionStart) : null;
      const end = focused ? Y.createRelativePositionFromTypeIndex(ytext, el.selectionEnd) : null;
      Y.applyUpdate(ydoc, update, "remote");
      const next = ytext.toString();
      setValue(next);
      if (focused && el && start && end) {
        const s = Y.createAbsolutePositionFromRelativePosition(start, ydoc)?.index ?? next.length;
        const e = Y.createAbsolutePositionFromRelativePosition(end, ydoc)?.index ?? s;
        requestAnimationFrame(() => el.setSelectionRange(s, e));
      }
    },
    [ydoc, ytext],
  );

  const flush = useCallback(async () => {
    if (sending.current || !pending.current.length) return;
    sending.current = true;
    const batch = pending.current;
    pending.current = [];
    setStatus("saving");
    try {
      const r = await api.docs.edit(meta.id, enc(Y.mergeUpdates(batch)), enc(Y.encodeStateVector(ydoc)));
      applyRemote(r.update);
      setError(undefined);
      setStatus(pending.current.length ? "saving" : "saved");
    } catch (e) {
      pending.current = [...batch, ...pending.current];
      setStatus("offline");
      setError((e as Error).message);
    } finally {
      sending.current = false;
      if (pending.current.length) timer.current = setTimeout(() => void flush(), 800);
    }
  }, [applyRemote, meta.id, ydoc]);

  useEffect(() => {
    const onUpdate = (u: Uint8Array, origin: unknown) => {
      if (origin !== LOCAL) return;
      pending.current.push(u);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 250);
    };
    ydoc.on("update", onUpdate);
    return () => ydoc.off("update", onUpdate);
  }, [ydoc, flush]);

  const pull = useCallback(async () => {
    try {
      const r = await api.docs.pull(meta.id, enc(Y.encodeStateVector(ydoc)));
      applyRemote(r.update);
    } catch {
      // try again on the next tick
    }
  }, [applyRemote, meta.id, ydoc]);

  // Others' edits: live updates when they arrive, plus a short poll as a safety net while this page is visible.
  useLiveChanges(() => void pull(), ["CollabDoc"]);
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && !sending.current && void pull(), 1500);
    return () => clearInterval(t);
  }, [pull]);

  // Unsaved typing is sent before the tab closes.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pending.current.length || sending.current) {
        void flush();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [flush]);

  const onChange = (next: string) => {
    const prev = ytext.toString();
    if (next === prev) return;
    let a = 0;
    while (a < prev.length && a < next.length && prev[a] === next[a]) a++;
    let b = 0;
    while (b < prev.length - a && b < next.length - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++;
    ydoc.transact(() => {
      if (prev.length - a - b > 0) ytext.delete(a, prev.length - a - b);
      if (next.length - a - b > 0) ytext.insert(a, next.slice(a, next.length - b));
    }, LOCAL);
    setValue(ytext.toString());
  };

  const saveMeta = (body: Parameters<typeof api.docs.update>[1]) =>
    api.docs
      .update(meta.id, body)
      .then((d) => setMeta({ ...meta, ...d, state: meta.state }))
      .catch((e: Error) => setError(e.message));

  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div className="min-w-0 flex-1">
          <Link href={backHref} className="text-sm underline">
            ← Documents
          </Link>
          {team && meta.can.archive ? (
            <Input className="mt-2 font-display text-xl" defaultValue={meta.title} aria-label="Title" onBlur={(e) => e.target.value.trim() && e.target.value !== meta.title && saveMeta({ title: e.target.value.trim() })} />
          ) : (
            <h1 className="mt-2 font-display text-2xl">{meta.title}</h1>
          )}
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <Badge>{docKindLabels[meta.kind]}</Badge>
            {meta.client && <span>{meta.client.name}</span>}
            {meta.engagement && <span>· {meta.engagement.name}</span>}
            {meta.lead && <span>· Lead: {meta.lead.name}</span>}
            {team && meta.client && <span>· {meta.clientVisible ? "Shared with the client" : "Team only"}</span>}
          </p>
          <Presence entity="CollabDoc" id={meta.id} className="mt-2" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-muted" data-testid="doc-status">
            {status === "saved" ? "All changes saved" : status === "saving" ? "Saving…" : "Not saved yet, retrying"}
          </span>
          {team && meta.can.share && (
            <Button variant="secondary" onClick={() => saveMeta({ clientVisible: !meta.clientVisible })} data-testid="doc-share">
              {meta.clientVisible ? "Stop sharing with client" : "Share with client"}
            </Button>
          )}
          {team && meta.can.archive && (
            <Button variant="ghost" onClick={() => saveMeta({ archived: true }).then(() => (window.location.href = backHref))}>
              Archive
            </Button>
          )}
        </div>
      </div>
      {error && <p className="mb-3 border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
      {!editable && <p className="mb-3 text-sm text-ink-muted">You can read this document. Ask your company admin if you need to edit it.</p>}
      <textarea
        ref={area}
        className="min-h-[60vh] w-full border border-border bg-surface-raised p-4 font-mono text-sm leading-6"
        value={value}
        readOnly={!editable}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Document text"
        data-testid="doc-text"
        spellCheck
      />
      <p className="mt-2 text-xs text-ink-muted">
        {words} words · Everyone with access can type at the same time; changes appear for others within a couple of seconds.
      </p>
    </div>
  );
}
