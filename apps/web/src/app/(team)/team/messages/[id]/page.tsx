"use client";

import Link from "next/link";
import { use, useState } from "react";
import type { ThreadView } from "@bmu/shared";
import { Chat } from "@/components/chat";
import { AiPanel } from "@/components/ai/ai-panel";
import { aiPlain } from "@/lib/ai";
import { when } from "@/components/request-bits";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { useActionsMaybe } from "@/components/actions/actions-provider";
import { RowMenu } from "@/components/actions/row-menu";
import { MessageToRequestDrawer } from "@/components/ops/message-to-request";

export default function TeamThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.threads.get(id));
  const [fresh, setFresh] = useState<ThreadView>();
  const [draft, setDraft] = useState<{ n: number; text: string }>();
  const actions = useActionsMaybe();
  const [toRequest, setToRequest] = useState<{ id: string; body: string }>();
  const canRequest = !!actions?.me.roles.some((r) => ["founder", "admin", "am_lead", "account_manager"].includes(r));
  const t = fresh ?? loaded.data;
  if (!t) return <LoadState loading={loaded.loading} error={loaded.error} />;
  return (
    <>
      <Link href="/team/messages" className="text-sm underline">
        ← Messages
      </Link>
      <PageTitle
        title={t.client.name}
        subtitle={t.awaitingReply ? `Waiting for a reply since ${when.format(new Date(t.awaitingReply.since))}. Reply by ${when.format(new Date(t.awaitingReply.due))} (same working day).` : `Account Manager: ${t.am ?? "not assigned"}. All caught up.`}
        action={
          <div className="flex items-center gap-2">
            {t.awaitingReply && <Badge tone={t.awaitingReply.overdue ? "red" : "amber"}>{t.awaitingReply.overdue ? "Reply overdue" : "Awaiting reply"}</Badge>}
            <Link href={`/team/clients/${t.client.id}`} className="text-sm underline">
              Client 360
            </Link>
          </div>
        }
      />
      <Chat
        thread={t}
        allowInternal
        onSend={async (body, internal, files) => setFresh(await api.threads.send(id, body, internal, files))}
        onRefresh={async () => setFresh(await api.threads.get(id))}
        onUpload={(f) => api.service.uploadAttachment(f, id)}
        draft={draft}
        messageMenu={(m) =>
          (actions?.canNew("task") || canRequest) && m.body ? (
            <RowMenu
              label="Message actions"
              className="ml-1 align-middle"
              align={m.mine ? "right" : "left"}
              items={[
                { key: "task", label: "Create task", hidden: !actions?.canNew("task"), onSelect: () => actions?.openNew("task", { title: m.body.split("\n")[0].slice(0, 120), description: m.body, source: `message:${m.id}`, clientId: t.client.id }) },
                { key: "request", label: "Create request", hidden: !canRequest || m.internal, onSelect: () => setToRequest({ id: m.id, body: m.body }) },
              ]}
            />
          ) : null
        }
      />
      {toRequest && <MessageToRequestDrawer message={toRequest} clientId={t.client.id} onClose={() => setToRequest(undefined)} onDone={async (msg) => (actions?.notify(msg), setFresh(await api.threads.get(id)))} />}
      <div className="mt-6 grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <AiPanel
          feature="reply_suggest"
          targetId={t.id}
          options={{ kind: "thread" }}
          title="Suggested reply"
          description="Drafted from the last messages. Insert puts it in the message box; you send it."
          buttonLabel="Suggest reply"
          insertLabel="Put in message box"
          onInsert={(text) => setDraft((d) => ({ n: (d?.n ?? 0) + 1, text: aiPlain(text) }))}
        />
        <AiPanel feature="sentiment" targetId={t.id} options={{ kind: "thread" }} title="How is the client feeling?" description="Tone of the client's recent messages. Unhappy or urgent threads also count in Client Health." buttonLabel="Check tone" />
      </div>
    </>
  );
}
