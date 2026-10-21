"use client";

// v40: the client's Progress page. The finish dates the Client Manager shared, and each big part the team finished
// (a demo link or files) to approve or ask changes for.
import { useState } from "react";
import { milestoneStatusLabels, type ClientProgressView } from "@bmu/shared";
import { MilestoneFiles } from "@/components/deliver/project-flow";
import { Badge, Button, Card, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const day = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const fmt = (iso: string) => day.format(new Date(iso.length === 10 ? `${iso}T00:00:00+05:30` : iso));
const tone = { shared: "amber", approved: "green", changes_requested: "red" } as const;
const clientLabel = { ...milestoneStatusLabels, shared: "Waiting for you" };

type Milestone = ClientProgressView["projects"][number]["milestones"][number];

function Decide({ m, onDone }: { m: Milestone; onDone: (v: ClientProgressView) => void }) {
  const [changes, setChanges] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = async (decision: "approve" | "changes") => {
    if (decision === "changes" && comment.trim().length < 3) return setError("Tell the team what to change");
    setBusy(true);
    setError(undefined);
    try {
      onDone(await api.projectFlow.decide(m.id, { decision, comment: comment.trim() || undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2" data-testid="milestone-decide">
      {changes && (
        <textarea className="h-20 w-full border border-border bg-surface-raised p-2 text-sm" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} placeholder="What should the team change?" aria-label="What to change" />
      )}
      <div className="flex flex-wrap gap-2">
        {!changes && (
          <Button disabled={busy} onClick={() => send("approve")} data-testid="milestone-approve">
            Approve
          </Button>
        )}
        {changes ? (
          <>
            <Button disabled={busy} onClick={() => send("changes")} data-testid="milestone-changes-send">
              Send the changes
            </Button>
            <Button variant="secondary" onClick={() => setChanges(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setChanges(true)} data-testid="milestone-changes">
            Ask for changes
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-red">{error}</p>}
    </div>
  );
}

export default function ClientProgressPage() {
  const loaded = useLoad(() => api.projectFlow.clientProgress());
  const [fresh, setFresh] = useState<ClientProgressView>();
  const v = fresh ?? loaded.data;
  return (
    <>
      <PageTitle title="Progress" subtitle="When each team expects to finish, and the parts that are done for you to look at." />
      {!v ? (
        <LoadState loading={loaded.loading} error={loaded.error} />
      ) : v.projects.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-muted">Nothing here yet. Your Client Manager shares the expected dates, and the team shares each part when it is done.</p>
      ) : (
        <div className="grid gap-6">
          {v.projects.map((p) => (
            <Card key={p.engagementId}>
              <h2 className="text-base font-semibold">{p.service}</h2>
              {p.estimates.length > 0 && (
                <div className="mt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">Expected finish</h3>
                  <ul className="mt-1 space-y-1 text-sm" data-testid="client-estimates">
                    {p.estimates.map((e) => (
                      <li key={e.department}>
                        {e.department}: <strong>{fmt(e.finishBy)}</strong>
                        {e.note && <span className="block text-xs text-ink-muted">{e.note}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {p.milestones.length > 0 && (
                <div className="mt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">Finished parts</h3>
                  <ul className="mt-1 divide-y divide-border" data-testid="client-milestones">
                    {p.milestones.map((m) => (
                      <li key={m.id} className="py-3 text-sm">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <span className="font-medium">{m.title}</span>
                            <span className="text-xs text-ink-muted">
                              {m.department ? ` · ${m.department.name}` : ""} · {fmt(m.sharedAt)}
                            </span>
                            {m.note && <p className="text-xs text-ink-muted">{m.note}</p>}
                            <MilestoneFiles files={m.files} />
                            {m.clientComment && <p className="mt-1 border-l-2 border-border pl-2 text-xs">You said: {m.clientComment}</p>}
                          </div>
                          <Badge tone={tone[m.status]}>{clientLabel[m.status]}</Badge>
                        </div>
                        {m.canDecide && <Decide m={m} onDone={setFresh} />}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
