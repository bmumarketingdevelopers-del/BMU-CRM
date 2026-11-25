import { Suspense } from "react";
import { cookies } from "next/headers";
import { APP_VERSION } from "@bmu/shared";
import { serverApi } from "@/lib/session";
import { SignInForm } from "./sign-in-form";

export const metadata = { title: "Sign in | BMU Marketing" };

export default async function SignInPage() {
  // Still signed in (came here from the public site, a bookmark…): the form takes them straight back in, no new code.
  const me = (await cookies()).has("bmu_session") ? await (await serverApi()).auth.me().catch(() => undefined) : undefined;
  return (
    <main className="grid flex-1 lg:grid-cols-[1fr_1fr]">
      <div className="mx-auto w-full max-w-md px-5 py-16 sm:py-24">
        <p className="text-xs uppercase tracking-[0.18em] text-ink-muted">BMU Hub</p>
        <h1 className="font-display mt-3 text-3xl sm:text-4xl">Sign in</h1>
        <p className="mt-3 mb-10 text-ink-muted">Use the email or mobile number BMU has on file. We&apos;ll send you a 6-digit code.</p>
        <Suspense>
          <SignInForm me={me} />
        </Suspense>
      </div>
      <aside className="hidden flex-col justify-between bg-charcoal p-12 text-ivory lg:flex">
        <p className="text-sm text-grey">One place for every proposal, approval, file and report.</p>
        <div>
          <p className="font-display max-w-md text-3xl leading-tight">
            Building smarter growth systems<span className="text-green">.</span>
          </p>
          <ul className="mt-8 space-y-3 text-sm text-grey">
            <li>Clients: approve work, raise requests, pay and download files.</li>
            <li>Team: My Day, tasks, QC, Review Studio and client conversations.</li>
            <li>Leadership: revenue, collections, capacity and client health.</li>
          </ul>
        </div>
        <p className="text-xs text-grey">{APP_VERSION}</p>
      </aside>
    </main>
  );
}
