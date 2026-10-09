import Link from "next/link";
import { Fragment, type ReactNode } from "react";

// Renders the small Markdown subset the AI and basic mode write: paragraphs, "- " and "1. " lists,
// **bold** and internal links [label](/path). Nothing else is interpreted (no HTML).

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\((\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={`${key}-b${i++}`}>{m[1]}</strong>);
    else
      out.push(
        <Link key={`${key}-l${i++}`} href={m[3]} className="underline decoration-green decoration-2 underline-offset-2 hover:text-ink">
          {m[2]}
        </Link>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AiText({ text, className = "" }: { text: string; className?: string }) {
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  return (
    <div className={`space-y-2 text-sm leading-relaxed ${className}`}>
      {blocks.map((block, bi) => {
        const lines = block.split("\n").filter((l) => l.trim() !== "");
        const item = (l: string) => /^\s*([-*•]|\d+[.)])\s+/.test(l);
        const head = lines.length > 1 && !item(lines[0]) && lines.slice(1).every(item) ? lines[0] : null;
        const rest = head ? lines.slice(1) : lines;
        if (rest.length && rest.every(item)) {
          const ordered = rest.every((l) => /^\s*\d+[.)]\s+/.test(l));
          const items = rest.map((l, li) => <li key={li}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""), `${bi}-${li}`)}</li>);
          return (
            <Fragment key={bi}>
              {head && <p>{inline(head, `${bi}-h`)}</p>}
              {ordered ? <ol className="list-decimal space-y-1 pl-5">{items}</ol> : <ul className="list-disc space-y-1 pl-5 marker:text-ink-muted">{items}</ul>}
            </Fragment>
          );
        }
        return (
          <p key={bi} className="whitespace-pre-wrap">
            {lines.flatMap((l, li) => (li ? ["\n", ...inline(l, `${bi}-${li}`)] : inline(l, `${bi}-${li}`)))}
          </p>
        );
      })}
    </div>
  );
}
