"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { LoadState } from "@/components/ui";
import { DiscussionsLayout } from "@/components/ops/discussion-chat";

export default function DiscussionsPage() {
  return (
    <Suspense fallback={<LoadState loading />}>
      <Discussions />
    </Suspense>
  );
}

function Discussions() {
  const params = useSearchParams()!; // never null in the App Router (src/pages only holds the API route)
  return <DiscussionsLayout startNew={params.get("new") === "1"} />;
}
