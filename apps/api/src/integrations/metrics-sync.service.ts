// v19 daily results pull. Every morning (from 07:00 IST) each connected account reports:
// - post results (reach, impressions, engagement, clicks) for posts it published in the last 28 days, saved as
//   PostMetric rows (source = provider) so the v16 Results views, the calendar and client reports show them;
// - ad and website numbers per day (and campaign) for ad accounts and GA4, saved as AdMetricDaily.
// Platforms report a post's numbers the day after it goes out, so a post published today shows up tomorrow.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PROVIDER_INFO, type IntegrationProvider, type SyncJobView } from '@bmu/shared';
import type { IntegrationAccount } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { IntegrationsService, istDay } from './integrations.service.js';
import { connectorFor, type AdRow, type PostStats } from './providers/index.js';
import { claimOnce } from '../runtime/claims.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const DAY = 86_400_000;
const addDay = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
/** Midnight IST of a day, as an instant. */
const istMidnight = (iso: string) => new Date(`${iso}T00:00:00+05:30`);

@Injectable()
export class MetricsSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MetricsSync');
  private job?: JobHandle;
  private lastDay: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hub: IntegrationsService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'integrations.metrics_sync', hint: 'Pulls ads and analytics results from connected accounts', everyMs: 15 * 60_000, run: () => this.maybeRun() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  private async maybeRun(now = new Date()) {
    const today = istDay(now);
    const hour = new Date(now.getTime() + 330 * 60_000).getUTCHours();
    if (hour < 7 || this.lastDay === today) return;
    this.lastDay = today;
    if (!(await claimOnce(this.prisma, `integrations.metrics_sync:${today}`))) return;
    await this.runAll(now);
  }

  async runAll(now = new Date()) {
    const accounts = await this.prisma.integrationAccount.findMany({ where: { status: { in: ['connected', 'error'] } } });
    let jobs = 0;
    for (const a of accounts) jobs += (await this.syncAccount(a, now)).length;
    return jobs;
  }

  /** Pulls everything one account can report. Returns the job log rows it wrote. */
  async syncAccount(a: IntegrationAccount, now = new Date()): Promise<SyncJobView[]> {
    const provider = a.provider as IntegrationProvider;
    const info = PROVIDER_INFO[provider];
    const c = connectorFor(provider, a.mode);
    const jobs = [];
    if (info.publishes && c.postStats) {
      const today = istDay(now);
      const pubs = await this.prisma.postPublication.findMany({
        where: { accountId: a.id, status: 'published', externalId: { not: null }, publishedAt: { gte: new Date(now.getTime() - 28 * DAY), lt: istMidnight(today) } },
        select: { deliverableId: true, externalId: true, publishedAt: true, orgId: true },
      });
      const r = await this.hub.runJob<number>(a, 'post_metrics', async (ctx) => {
        if (!pubs.length) return { items: 0, result: 0 };
        const stats = await c.postStats!(ctx, pubs.map((p) => ({ externalId: p.externalId!, publishedAt: p.publishedAt! })), now);
        // One provider row per post per day: re-running the sync the same day updates it instead of adding rows.
        const dayStart = istMidnight(today);
        let n = 0;
        for (const p of pubs) {
          const s: PostStats | undefined = stats.get(p.externalId!);
          if (!s) continue;
          const data = { reach: s.reach, impressions: s.impressions, engagement: s.engagement, clicks: s.clicks };
          const same = await this.prisma.postMetric.findFirst({ where: { deliverableId: p.deliverableId, source: provider, createdAt: { gte: dayStart } }, select: { id: true } });
          if (same) await this.prisma.postMetric.update({ where: { id: same.id }, data });
          else await this.prisma.postMetric.create({ data: { orgId: p.orgId, deliverableId: p.deliverableId, source: provider, createdAt: now, ...data } });
          n++;
        }
        return { items: n, result: n };
      });
      jobs.push(r.job);
    }
    if (c.adRows && (info.kind === 'ads' || info.kind === 'analytics')) {
      const yesterday = addDay(istDay(now), -1);
      const last = await this.prisma.adMetricDaily.findFirst({ where: { accountId: a.id }, orderBy: { date: 'desc' }, select: { date: true } });
      // First sync backfills 30 days; later ones refresh the last 3 days (platforms adjust recent numbers).
      const from = last ? addDay(yesterday, -2) : addDay(yesterday, -29);
      const r = await this.hub.runJob<number>(a, 'ad_metrics', async (ctx) => {
        const rows: AdRow[] = await c.adRows!(ctx, from, yesterday);
        for (const row of rows) {
          const data = { clientOrgId: a.clientOrgId, provider, spendPaise: row.spendPaise, impressions: row.impressions, clicks: row.clicks, conversions: row.conversions, sessions: row.sessions, users: row.users, revenuePaise: row.revenuePaise, syncedAt: new Date() };
          await this.prisma.adMetricDaily.upsert({
            where: { accountId_date_campaign: { accountId: a.id, date: new Date(`${row.date}T00:00:00Z`), campaign: row.campaign } },
            create: { orgId: a.orgId, accountId: a.id, date: new Date(`${row.date}T00:00:00Z`), campaign: row.campaign, ...data },
            update: data,
          });
        }
        return { items: rows.length, result: rows.length };
      });
      jobs.push(r.job);
    }
    return this.hub.jobViews(jobs, [a]);
  }
}
