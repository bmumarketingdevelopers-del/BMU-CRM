"use client";
// v19: ads and website numbers pulled daily from Google Ads, Meta Ads and GA4, shown on the client's Insights page
// and on the team's client page.
import type { AdResultsView } from "@bmu/shared";
import { ColumnChart, DataTable, Grid, Panel, StatRow, StatTile } from "@/components/dash";
import { LoadState } from "@/components/ui";
import { useLoad } from "@/lib/use-load";
import { formatINR } from "@bmu/shared";

const num = (n: number) => n.toLocaleString("en-IN");
const dFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const day = (iso: string) => dFmt.format(new Date(`${iso}T00:00:00Z`));
const dtFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function AdResults({ load, audience }: { load: () => Promise<AdResultsView>; audience: "client" | "team" }) {
  const state = useLoad(load, { live: ["AdMetricDaily", "IntegrationAccount"] });
  if (!state.data) return state.error && audience === "client" ? null : <LoadState loading={state.loading} error={state.error} />;
  const v = state.data;
  if (!v.hasData) {
    return (
      <Panel title="Ads and website" subtitle="Spend, clicks, leads and visits from Google Ads, Meta Ads and Google Analytics">
        <p className="py-4 text-sm text-ink-muted" data-testid="ad-results-empty">
          {audience === "client"
            ? "Your ad and website numbers will show here once your client manager connects your ad accounts and Google Analytics."
            : v.accounts.length
              ? "Accounts are connected. Numbers appear after the next morning sync, or press Sync now in Integrations."
              : "No ads or analytics account is linked to this client. Connect one in Command Centre → Integrations."}
        </p>
      </Panel>
    );
  }
  const t = v.totals;
  const hasAds = t.spendPaise > 0 || t.clicks > 0;
  const hasSite = t.sessions > 0;
  return (
    <div className="space-y-6" data-testid="ad-results">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight">Ads and website</h2>
        <p className="text-sm text-ink-muted">
          {day(v.from)} to {day(v.to)} · updated every morning
          {v.accounts.some((a) => a.mode === "test") ? " · includes test accounts" : ""}
        </p>
      </div>
      <StatRow cols={4}>
        <StatTile label="Ad spend" value={formatINR(t.spendPaise)} hint={hasAds ? `${num(t.impressions)} impressions` : "no ads running"} />
        <StatTile label="Clicks" value={num(t.clicks)} hint={t.ctrPct === null ? undefined : `${t.ctrPct}% click rate · ${t.cpcPaise === null ? "—" : formatINR(t.cpcPaise)} each`} />
        <StatTile label="Leads and sales" value={num(t.conversions)} hint={t.costPerConversionPaise === null ? "from ads and the website" : `${formatINR(t.costPerConversionPaise)} each from ads`} />
        <StatTile label="Website visits" value={hasSite ? num(t.sessions) : "—"} hint={hasSite ? `${num(t.users)} people${t.revenuePaise ? ` · ${formatINR(t.revenuePaise)} sales` : ""}` : "Google Analytics not linked"} />
      </StatRow>
      <Grid>
        <Panel className="min-w-0" title={hasAds ? "Ad spend each day" : "Website visits each day"}>
          <ColumnChart data={v.daily.map((d) => ({ label: day(d.date), value: hasAds ? d.spendPaise / 100 : d.sessions }))} format={(n) => (hasAds ? `₹${Math.round(n).toLocaleString("en-IN")}` : num(n))} highlightLast={false} />
        </Panel>
        <Panel className="min-w-0" title="By platform">
          <ul className="divide-y divide-border">
            {v.byProvider.map((p) => (
              <li key={p.provider} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <span className="font-medium">{p.label}</span>
                <span className="text-right text-ink-muted">{p.provider === "ga4" ? `${num(p.sessions)} visits · ${num(p.users)} people · ${num(p.conversions)} key events` : `${formatINR(p.spendPaise)} · ${num(p.clicks)} clicks · ${num(p.conversions)} leads`}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </Grid>
      {v.campaigns.length > 0 && (
        <Panel title="Campaigns" flush>
          <DataTable
            rows={v.campaigns}
            rowKey={(c) => `${c.provider}-${c.campaign}`}
            columns={[
              { key: "c", header: "Campaign", cell: (c) => c.campaign || "All campaigns" },
              { key: "p", header: "Platform", cell: (c) => (c.provider === "google_ads" ? "Google Ads" : "Meta Ads") },
              { key: "s", header: "Spend", align: "right", cell: (c) => formatINR(c.spendPaise) },
              { key: "i", header: "Impressions", align: "right", cell: (c) => num(c.impressions) },
              { key: "k", header: "Clicks", align: "right", cell: (c) => num(c.clicks) },
              { key: "v", header: "Leads", align: "right", cell: (c) => num(c.conversions) },
              { key: "cpl", header: "Cost per lead", align: "right", cell: (c) => (c.conversions ? formatINR(Math.round(c.spendPaise / c.conversions)) : "—") },
            ]}
          />
        </Panel>
      )}
      {audience === "team" && (
        <p className="text-xs text-ink-muted">
          Accounts: {v.accounts.map((a) => `${a.name} (${a.mode === "test" ? "test, " : ""}synced ${a.lastSyncAt ? dtFmt.format(new Date(a.lastSyncAt)) : "never"})`).join(" · ")}
        </p>
      )}
    </div>
  );
}
