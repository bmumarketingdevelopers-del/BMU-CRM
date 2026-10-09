import type { PlanContent, PlanView } from "@bmu/shared";

const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

/** Read-only plan, used by the team (once locked) and by the client approvals page. */
export function PlanContentView({ content }: { content: PlanContent }) {
  return (
    <div className="space-y-4 text-sm">
      <Field label="Objectives" value={content.objectives} />
      <Field label="Audience" value={content.audience} />
      <div>
        <p className="text-xs uppercase tracking-wide text-ink-muted">Content pillars</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {content.pillars.map((p) => (
            <span key={p} className="bg-canvas px-2 py-0.5 text-charcoal">
              {p}
            </span>
          ))}
          {content.pillars.length === 0 && <span className="text-ink-muted">None</span>}
        </div>
      </div>
      <Field label="Creative direction" value={content.creativeDirection} />
      <div>
        <p className="text-xs uppercase tracking-wide text-ink-muted">Deliverables ({content.deliverables.length})</p>
        <ul className="mt-1 divide-y divide-border border border-border">
          {content.deliverables.map((d, i) => (
            <li key={i} className="flex flex-wrap justify-between gap-2 px-3 py-2">
              <span>
                <span className="capitalize text-ink-muted">{d.type}</span> · {d.title}
              </span>
              {d.due && <span className="text-ink-muted">{day.format(new Date(d.due))}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-1 whitespace-pre-wrap">{value || <span className="text-ink-muted">Not set</span>}</p>
    </div>
  );
}

export function PlanComments({ plan }: { plan: PlanView }) {
  if (plan.clientComments.length === 0) return null;
  return (
    <div className="mt-4 border-l-4 border-amber bg-amber/10 px-4 py-3 text-sm">
      <p className="font-semibold">Client feedback</p>
      <ul className="mt-2 space-y-2">
        {plan.clientComments.map((c, i) => (
          <li key={i}>
            <p className="whitespace-pre-wrap">{c.body}</p>
            <p className="text-xs text-ink-muted">
              {c.author} · {day.format(new Date(c.at))}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
