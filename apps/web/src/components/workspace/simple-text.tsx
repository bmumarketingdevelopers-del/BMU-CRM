import type { ReactNode } from "react";

/** Renders plain SOP text with light markdown: "## headings", "- bullets", "1. steps" and paragraphs. No HTML is interpreted. */
export function SimpleText({ body }: { body: string }) {
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    out.push(
      <Tag key={out.length} className={`my-3 space-y-1.5 pl-5 ${list.ordered ? "list-decimal" : "list-disc"}`}>
        {list.items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const step = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || step) {
      const ordered = !!step;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? step)![1]);
      continue;
    }
    flush();
    if (!line) continue;
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) out.push(<h3 key={out.length} className="mt-6 mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted first:mt-0">{h[2]}</h3>);
    else out.push(<p key={out.length} className="my-2">{line}</p>);
  }
  flush();
  return <div className="text-[15px] leading-relaxed">{out}</div>;
}
