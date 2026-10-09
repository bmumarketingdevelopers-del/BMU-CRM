"use client";

import { useMemo, useRef, useState } from "react";
import type { ReviewAnchor, ReviewComment, VersionView } from "@bmu/shared";
import { Button } from "@/components/ui";

const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
/** A video comment shows on the frame while playback is within this many seconds of its moment. */
const NEAR = 0.5;

type Point = [number, number];
export type CommentDraft = { body: string; anchor?: ReviewAnchor; internal: boolean };

/** A comment that points at the picture: a spot, a drawing, or both. */
const marked = (c: ReviewComment) => !!c.anchor && (c.anchor.x !== undefined || !!c.anchor.drawing);

/**
 * Review Studio viewer shared by the team and client apps: version tabs and side-by-side compare, pinned comments and
 * freehand drawings on images, time-coded comments on video (optionally pinned to a spot on that frame, shown on the
 * frame while it plays), timeline markers, comments carried over from earlier versions, and resolving.
 */
export function ReviewViewer({
  versions,
  comments,
  canComment,
  allowInternal = false,
  onComment,
  onResolve,
}: {
  versions: VersionView[];
  comments: ReviewComment[];
  canComment: boolean;
  allowInternal?: boolean;
  onComment: (versionId: string, draft: CommentDraft) => Promise<void>;
  onResolve?: (commentId: string, resolved: boolean) => Promise<void>;
}) {
  const latest = versions.at(-1);
  const [selectedId, setSelectedId] = useState(latest?.id);
  const [compareId, setCompareId] = useState<string>();
  const [t, setT] = useState<number>();
  const [spot, setSpot] = useState<{ x: number; y: number }>();
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [drawing, setDrawing] = useState(false);
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showResolved, setShowResolved] = useState(false);
  const [now, setNow] = useState(0);
  const [duration, setDuration] = useState(0);
  const [focus, setFocus] = useState<string>();
  const videoRef = useRef<HTMLVideoElement>(null);

  function clearDraft() {
    setT(undefined);
    setSpot(undefined);
    setStrokes([]);
    setDrawing(false);
  }

  // Jump to the newest version when one is added.
  const [seenLatest, setSeenLatest] = useState(latest?.id);
  if (seenLatest !== latest?.id) {
    setSeenLatest(latest?.id);
    setSelectedId(latest?.id);
    clearDraft();
  }

  const selected = versions.find((v) => v.id === selectedId) ?? latest;
  const compare = versions.find((v) => v.id === compareId);
  const thread = useMemo(() => comments.filter((c) => c.versionId === selected?.id), [comments, selected?.id]);
  const open = thread.filter((c) => !c.resolvedAt);
  const resolved = thread.filter((c) => c.resolvedAt);
  const marks = open.filter(marked);
  const isVideo = selected?.kind === "video";
  // On video only the comments for the moment on screen are drawn on the frame.
  const onFrame = isVideo ? marks.filter((c) => c.anchor?.t !== undefined && Math.abs(c.anchor.t - now) <= NEAR) : marks;
  const timed = open.filter((c) => c.anchor?.t !== undefined);
  const canMark = canComment && (selected?.kind === "image" || (isVideo && t !== undefined));

  if (!selected) return <p className="text-sm text-ink-muted">No versions yet.</p>;

  function seek(c: ReviewComment) {
    setFocus(c.id);
    const v = videoRef.current;
    if (v && c.anchor?.t !== undefined) {
      v.pause();
      v.currentTime = c.anchor.t;
      setNow(c.anchor.t);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const anchor: ReviewAnchor | undefined =
      t !== undefined || spot || strokes.length ? { ...(t !== undefined ? { t } : {}), ...(spot ?? {}), ...(strokes.length ? { drawing: strokes } : {}) } : undefined;
    setBusy(true);
    setError(undefined);
    try {
      await onComment(selected.id, { body, anchor, internal });
      setBody("");
      setInternal(false);
      clearDraft();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resolve(c: ReviewComment, value: boolean) {
    if (!onResolve) return;
    setError(undefined);
    try {
      await onResolve(c.id, value);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const row = (c: ReviewComment) => {
    const no = marks.indexOf(c) + 1;
    return (
      <li
        key={c.id}
        data-comment={c.id}
        className={`border-l-4 px-3 py-2 text-sm ${c.resolvedAt ? "border-border bg-canvas text-ink-muted" : c.internal ? "border-amber bg-amber/10" : c.author.isClient ? "border-green bg-green/10" : "border-border bg-surface-raised"} ${focus === c.id ? "ring-1 ring-charcoal" : ""}`}
        onMouseEnter={() => setFocus(c.id)}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          {no > 0 && <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-red text-[11px] font-bold text-white">{no}</span>}
          {c.anchor?.t !== undefined && (
            <button className="font-mono underline" onClick={() => seek(c)} title="Show this moment">
              {clock(c.anchor.t)}
            </button>
          )}
          {c.anchor?.drawing && <span title="Has a drawing on the frame">✎ drawing</span>}
          <span className="font-semibold text-ink">{c.author.name}</span>
          {c.internal && <span title="Internal note, hidden from the client">🔒 Internal</span>}
          {c.carriedFrom && (
            <span className="border border-border bg-canvas px-1.5" title="Still open from an earlier version, so it moved to this one">
              Carried over from v{c.carriedFrom}
            </span>
          )}
          {c.resolvedAt && <span className="font-semibold text-green">✓ Resolved</span>}
          <span>{when.format(new Date(c.at))}</span>
          {onResolve && (
            <button className="ml-auto underline" onClick={() => resolve(c, !c.resolvedAt)}>
              {c.resolvedAt ? "Reopen" : "Mark resolved"}
            </button>
          )}
        </div>
        <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
      </li>
    );
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {versions.map((v) => (
          <button
            key={v.id}
            onClick={() => (setSelectedId(v.id), clearDraft())}
            className={`border px-3 py-1 ${v.id === selected.id ? "border-charcoal bg-charcoal text-ivory" : "border-border bg-surface-raised"}`}
          >
            v{v.number}
            {v.approved ? " ✓" : ""}
          </button>
        ))}
        {versions.length > 1 && (
          <label className="ml-auto flex items-center gap-2 text-xs text-ink-muted">
            Compare with
            <select className="border border-border bg-surface-raised px-2 py-1" value={compareId ?? ""} onChange={(e) => setCompareId(e.target.value || undefined)}>
              <option value="">None</option>
              {versions
                .filter((v) => v.id !== selected.id)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.number}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>

      <div className={compare ? "grid gap-3 md:grid-cols-2" : ""}>
        {compare && (
          <div>
            <p className="mb-1 text-xs text-ink-muted">v{compare.number}</p>
            <Media version={compare} marks={[]} numbered={[]} />
          </div>
        )}
        <div>
          {compare && <p className="mb-1 text-xs text-ink-muted">v{selected.number}</p>}
          <Media
            version={selected}
            marks={onFrame}
            numbered={marks}
            focus={focus}
            pendingSpot={spot}
            pendingStrokes={strokes}
            videoRef={videoRef}
            mode={!canMark ? undefined : drawing ? "draw" : "pin"}
            onPin={(x, y) => setSpot({ x, y })}
            onStroke={(s) => setStrokes((all) => [...all, s].slice(0, 20))}
            onTime={setNow}
            onDuration={setDuration}
          />
          {isVideo && duration > 0 && (
            <div className="relative mt-2 h-4 border border-border bg-canvas" aria-label="Comment markers">
              <span className="absolute inset-y-0 left-0 bg-charcoal/15" style={{ width: `${Math.min(100, (now / duration) * 100)}%` }} />
              {timed.map((c) => (
                <button
                  key={c.id}
                  title={`${clock(c.anchor?.t ?? 0)} · ${c.author.name}: ${c.body}`}
                  onClick={() => seek(c)}
                  className={`absolute top-0 h-full w-1.5 -translate-x-1/2 ${c.author.isClient ? "bg-green" : c.internal ? "bg-amber" : "bg-red"}`}
                  style={{ left: `${Math.min(100, ((c.anchor?.t ?? 0) / duration) * 100)}%` }}
                />
              ))}
              {t !== undefined && <span className="absolute top-0 h-full w-1.5 -translate-x-1/2 animate-pulse bg-charcoal" style={{ left: `${Math.min(100, (t / duration) * 100)}%` }} />}
            </div>
          )}
        </div>
      </div>

      <p className="mt-2 text-xs text-ink-muted">
        v{selected.number} by {selected.uploadedBy} · {when.format(new Date(selected.at))}
        {selected.note && <> · {selected.note}</>}
        {selected.approved && (
          <span className="ml-1 font-semibold text-charcoal">
            · Approved by {selected.approved.by} on {when.format(new Date(selected.approved.at))}
          </span>
        )}
      </p>

      <ol className="mt-4 space-y-2">
        {open.map(row)}
        {open.length === 0 && <li className="text-sm text-ink-muted">{resolved.length ? "Everything on this version is resolved." : "No comments on this version yet."}</li>}
      </ol>
      {resolved.length > 0 && (
        <div className="mt-3">
          <button className="text-xs text-ink-muted underline" onClick={() => setShowResolved(!showResolved)}>
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </button>
          {showResolved && <ol className="mt-2 space-y-2">{resolved.map(row)}</ol>}
        </div>
      )}

      {canComment && (
        <form onSubmit={submit} className="mt-4 grid gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            {selected.kind === "image" && !spot && !drawing && <span>Tip: click the image to pin a comment to a spot, or draw on it.</span>}
            {isVideo && (
              <Button
                type="button"
                variant="secondary"
                className="py-1 text-xs"
                onClick={() => {
                  const v = videoRef.current;
                  v?.pause();
                  const at = Math.round((v?.currentTime ?? 0) * 10) / 10;
                  setT(at);
                  setNow(at);
                }}
              >
                {t === undefined ? "Comment at current time" : "Use current time"}
              </Button>
            )}
            {isVideo && t !== undefined && !spot && !drawing && <span>Optional: click the frame to pin the exact spot, or draw on it.</span>}
            {canMark && (
              <Button type="button" variant={drawing ? "primary" : "secondary"} className="py-1 text-xs" onClick={() => setDrawing(!drawing)}>
                {drawing ? "Done drawing" : "✎ Draw"}
              </Button>
            )}
            {t !== undefined && <Chip label={`At ${clock(t)}`} onRemove={clearDraft} />}
            {spot && <Chip label={`Pinned at ${Math.round(spot.x)}%, ${Math.round(spot.y)}%`} onRemove={() => setSpot(undefined)} />}
            {strokes.length > 0 && <Chip label={`${strokes.length} stroke${strokes.length > 1 ? "s" : ""}`} onRemove={() => setStrokes([])} removeLabel="clear" />}
          </div>
          <textarea
            className="w-full border border-border bg-surface-raised px-3 py-2 text-sm"
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t !== undefined || spot || strokes.length ? "What should change here?" : "Add a comment"}
            required
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" disabled={busy}>
              Add comment
            </Button>
            {allowInternal && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> 🔒 Internal note (client never sees it)
              </label>
            )}
          </div>
          {error && <p className="text-sm text-red">{error}</p>}
        </form>
      )}
      {!canComment && error && <p className="mt-2 text-sm text-red">{error}</p>}
    </div>
  );
}

function Chip({ label, onRemove, removeLabel = "remove" }: { label: string; onRemove: () => void; removeLabel?: string }) {
  return (
    <span className="bg-canvas px-2 py-0.5 text-charcoal">
      {label}{" "}
      <button type="button" className="underline" onClick={onRemove}>
        {removeLabel}
      </button>
    </span>
  );
}

const line = (s: Point[]) => s.map(([x, y]) => `${x},${y}`).join(" ");

/** Pins and drawings over an image or a video frame, in percent of the frame. Captures the pointer only while marking. */
function Overlay({
  marks,
  numbered,
  focus,
  pendingSpot,
  pendingStrokes,
  mode,
  onPin,
  onStroke,
}: {
  marks: ReviewComment[];
  numbered: ReviewComment[];
  focus?: string;
  pendingSpot?: { x: number; y: number };
  pendingStrokes?: Point[][];
  mode?: "pin" | "draw";
  onPin?: (x: number, y: number) => void;
  onStroke?: (s: Point[]) => void;
}) {
  const [live, setLive] = useState<Point[]>();
  const pos = (e: React.PointerEvent<HTMLDivElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    const c = (n: number) => Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
    return [c(((e.clientX - r.left) / r.width) * 100), c(((e.clientY - r.top) / r.height) * 100)];
  };
  return (
    <div
      data-testid="review-overlay"
      className={`absolute inset-0 ${mode ? (mode === "draw" ? "cursor-crosshair touch-none" : "cursor-crosshair") : "pointer-events-none"}`}
      onPointerDown={(e) => {
        if (mode !== "draw") return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setLive([pos(e)]);
      }}
      onPointerMove={(e) => {
        if (mode !== "draw" || !live) return;
        const p = pos(e);
        const last = live[live.length - 1];
        if (live.length < 500 && Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.6) setLive([...live, p]);
      }}
      onPointerUp={(e) => {
        if (mode === "draw") {
          if (live && live.length >= 2) onStroke?.(live);
          setLive(undefined);
          return;
        }
        if (mode === "pin") {
          const [x, y] = pos(e);
          onPin?.(x, y);
        }
      }}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
        {marks.map((c) =>
          (c.anchor?.drawing ?? []).map((s, i) => (
            <polyline key={`${c.id}-${i}`} points={line(s as Point[])} fill="none" stroke="#dc2626" strokeOpacity={focus && focus !== c.id ? 0.35 : 0.9} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          )),
        )}
        {[...(pendingStrokes ?? []), ...(live ? [live] : [])].map((s, i) => (
          <polyline key={`p-${i}`} points={line(s)} fill="none" stroke="#16a34a" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {marks.map((c) => {
        const a = c.anchor;
        const first = a?.drawing?.[0]?.[0];
        const at = a?.x !== undefined && a.y !== undefined ? { x: a.x, y: a.y } : first ? { x: first[0], y: first[1] } : null;
        if (!at) return null;
        return (
          <span
            key={c.id}
            data-pin={c.id}
            title={c.body}
            className={`pointer-events-none absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-red text-xs font-bold text-white ring-2 ${focus === c.id ? "ring-charcoal" : "ring-white"}`}
            style={{ left: `${at.x}%`, top: `${at.y}%` }}
          >
            {numbered.indexOf(c) + 1}
          </span>
        );
      })}
      {pendingSpot && (
        <span
          className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full bg-green ring-2 ring-white"
          style={{ left: `${pendingSpot.x}%`, top: `${pendingSpot.y}%` }}
        />
      )}
    </div>
  );
}

function Media({
  version,
  marks,
  numbered,
  focus,
  pendingSpot,
  pendingStrokes,
  videoRef,
  mode,
  onPin,
  onStroke,
  onTime,
  onDuration,
}: {
  version: VersionView;
  marks: ReviewComment[];
  numbered: ReviewComment[];
  focus?: string;
  pendingSpot?: { x: number; y: number };
  pendingStrokes?: Point[][];
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  mode?: "pin" | "draw";
  onPin?: (x: number, y: number) => void;
  onStroke?: (s: Point[]) => void;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
}) {
  const overlay = <Overlay marks={marks} numbered={numbered} focus={focus} pendingSpot={pendingSpot} pendingStrokes={pendingStrokes} mode={mode} onPin={onPin} onStroke={onStroke} />;
  if (version.kind === "image") {
    return (
      <div className="relative inline-block max-w-full border border-border bg-canvas">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={version.url} alt={version.name ?? `Version ${version.number}`} className="block max-h-[70vh] max-w-full select-none" draggable={false} />
        {overlay}
      </div>
    );
  }
  if (version.kind === "video") {
    // The box hugs the frame (no letterboxing) so percent positions land on the same spot for everyone.
    return (
      <div className="relative inline-block max-w-full bg-black">
        <video
          ref={videoRef}
          src={version.url}
          controls={mode === undefined}
          playsInline
          preload="metadata"
          className="block max-h-[70vh] max-w-full"
          onTimeUpdate={(e) => onTime?.(e.currentTarget.currentTime)}
          onSeeked={(e) => onTime?.(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => onDuration?.(e.currentTarget.duration || 0)}
        />
        {overlay}
      </div>
    );
  }
  if (version.kind === "pdf") {
    return <iframe src={version.url} title={version.name ?? "PDF"} className="h-[70vh] w-full border border-border bg-white" />;
  }
  return (
    <div className="border border-border bg-surface-raised p-6 text-sm">
      <p className="mb-2 text-ink-muted">{version.kind === "link" ? "Live link" : "File"}</p>
      <a href={version.url} target="_blank" rel="noreferrer" className="break-all font-semibold underline">
        {version.name ?? version.url}
      </a>
      <p className="mt-2 text-xs text-ink-muted">Opens in a new tab. Leave your comments below.</p>
    </div>
  );
}
