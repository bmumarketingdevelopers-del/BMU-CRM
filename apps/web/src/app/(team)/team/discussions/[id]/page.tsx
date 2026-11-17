"use client";

import { use } from "react";
import { DiscussionsLayout } from "@/components/ops/discussion-chat";

/** A discussion opened by its link (e.g. from a notification): the same chat layout with this one open. */
export default function DiscussionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <DiscussionsLayout openId={id} />;
}
