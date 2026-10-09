"use client";

import { useState } from "react";
import type { ThreadView } from "@bmu/shared";
import { Chat } from "@/components/chat";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function ClientMessagesPage() {
  const loaded = useLoad(() => api.client.thread());
  const [fresh, setFresh] = useState<ThreadView>();
  const thread = fresh ?? loaded.data;
  if (!thread) return <LoadState loading={loaded.loading} error={loaded.error} />;
  return (
    <>
      <PageTitle
        title="Messages"
        subtitle={thread.am ? `Talk to ${thread.am}, your Account Manager. Replies come the same working day (9:30–6:30, Mon–Sat).` : "Talk to your Account Manager. Replies come the same working day."}
      />
      <Chat
        thread={thread}
        onSend={async (body, _internal, files) => setFresh(await api.client.sendMessage(body, files))}
        onRefresh={async () => setFresh(await api.client.thread())}
        onUpload={(f) => api.service.uploadAttachment(f)}
      />
    </>
  );
}
