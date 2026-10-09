"use client";

import { useEffect, useState } from "react";
import { aiFeatureInfo, type AiFeature, type AiResult, type AiStatus, type AiStreamEvent } from "@bmu/shared";
import { api } from "@/lib/api";

/**
 * POSTs to an AI streaming endpoint (/ai/generate/stream, /ai/ask/stream, /ai/client/ask/stream) and calls
 * onEvent for each NDJSON line. Resolves with the final result; throws an Error with a plain message otherwise.
 */
export async function aiStream(path: string, body: unknown, onEvent: (e: AiStreamEvent) => void, signal?: AbortSignal): Promise<AiResult> {
  const res = await fetch(`/api${path}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { message?: unknown };
      if (typeof j.message === "string") message = j.message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AiResult | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const e = JSON.parse(line) as AiStreamEvent;
      if (e.t === "error") throw new Error(e.message);
      if (e.t === "done") result = e.result;
      onEvent(e);
    }
    if (done) break;
  }
  if (!result) throw new Error("The answer was cut off. Please try again.");
  return result;
}

let cached: Promise<AiStatus> | null = null;
/** AI status for the signed-in person (cached per page load). null while loading or when it failed. */
export function useAiStatus(): AiStatus | null {
  const [s, setS] = useState<AiStatus | null>(null);
  useEffect(() => {
    cached ??= api.ai.status().catch((e) => {
      cached = null;
      throw e;
    });
    cached.then(setS).catch(() => setS(null));
  }, []);
  return s;
}
export const resetAiStatus = () => {
  cached = null;
};

export const aiFeatureOn = (s: AiStatus | null, f: AiFeature) => !!s && s.features[aiFeatureInfo[f].group];

/** Plain text for pasting into a message box: drops **bold** markers and turns [label](/link) into label. */
export const aiPlain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\((\/[^)]+)\)/g, "$1");
