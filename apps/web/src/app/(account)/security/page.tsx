import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiError, homePathFor } from "@bmu/shared";
import { Logo } from "@/components/logo";
import { SecurityPanels } from "@/components/security/security-panel";
import { serverApi } from "@/lib/session";

export const metadata = { title: "Sign-in security | BMU Hub" };

/** v20: two-step sign-in set-up. Lives outside the app shells so people whose role requires it can reach it first. */
export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  const me = await (await serverApi()).auth.me().catch((e) => {
    if (e instanceof ApiError && e.status === 401) redirect("/sign-in?next=/security");
    throw e;
  });
  const required = !!me.mustEnroll2fa || (await searchParams).required === "1";
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <div className="mb-8 flex items-center justify-between">
        <Logo className="text-ink" />
        {!me.mustEnroll2fa && (
          <Link href={homePathFor(me)} className="text-sm underline">
            Back to BMU Hub
          </Link>
        )}
      </div>
      <h1 className="font-display text-2xl">Sign-in security</h1>
      <p className="mt-1 mb-6 text-ink-muted">
        {me.name} · {me.email ?? me.phone}
      </p>
      <SecurityPanels required={required} />
      {me.mustEnroll2fa && (
        <p className="mt-6 text-sm text-ink-muted">
          Once two-step sign-in is on, <Link href={homePathFor(me)} className="underline">open BMU Hub</Link>.
        </p>
      )}
    </main>
  );
}
