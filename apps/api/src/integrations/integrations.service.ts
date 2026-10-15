// v19 integrations hub: connected accounts (Meta, LinkedIn, Google or BMU's test account), OAuth sign-in, the sync
// job log and the ads/website results that feed client dashboards. Publishing lives in publisher.service.ts and the
// daily results pull in metrics-sync.service.ts; both run their work through runJob() so every run is logged.
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  accountUpdateSchema,
  INTEGRATION_PROVIDERS,
  oauthStartSchema,
  PROVIDER_INFO,
  testAccountSchema,
  type AdResultsView,
  type ConnectorStatus,
  type IntegrationAccountView,
  type IntegrationProvider,
  type IntegrationsHubView,
  type Me,
  type PublicationView,
  type SyncJobView,
} from '@bmu/shared';
import type { IntegrationAccount, SyncJob } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { clientScope, hasRole, inScope, isLeadership } from '../creative/scope.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { seal, signToken, unseal, verifyToken } from './crypto.js';
import { finishCalendarConnect, type CalendarOAuthState } from './google-calendar.js';
import { loginFor, missingEnv, type AccountCtx } from './providers/index.js';

const DAY = 86_400_000;
export const apiPublicUrl = () => (process.env.API_PUBLIC_URL?.trim() || `${(process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/api`).replace(/\/$/, '');
export const appUrl = () => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const testAccountsAllowed = () => process.env.NODE_ENV !== 'production' || process.env.INTEGRATIONS_TEST_ACCOUNTS === '1';
/** Calendar day in IST, YYYY-MM-DD. */
export const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const addDay = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);

type OAuthState = { o: string; u: string; p: IntegrationProvider; c: string | null; n: string };

@Injectable()
export class IntegrationsService {
  private readonly log = new Logger('Integrations');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------------------------------------------ access

  /** Leadership manages every account; Client Managers manage their own clients' accounts. */
  private async manageScope(me: Me): Promise<'all' | string[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    if (isLeadership(me)) return 'all';
    if (hasRole(me, 'account_manager', 'strategist')) {
      const scope = await clientScope(this.prisma, me);
      return scope === 'all' ? 'all' : scope;
    }
    throw new ForbiddenException('Only Founders, Branch Managers and Client Managers can manage connected accounts');
  }

  private async assertManage(me: Me, clientOrgId: string | null) {
    const scope = await this.manageScope(me);
    if (scope !== 'all' && (!clientOrgId || !scope.includes(clientOrgId))) throw new ForbiddenException('You can only connect accounts for your own clients');
    if (clientOrgId) {
      const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId, deletedAt: null }, select: { id: true } });
      if (!c) throw new NotFoundException('Client not found');
    }
  }

  async account(me: Me, id: string) {
    const a = await this.prisma.integrationAccount.findFirst({ where: { id, orgId: me.orgId } });
    if (!a) throw new NotFoundException('Account not found');
    await this.assertManage(me, a.clientOrgId);
    return a;
  }

  // ------------------------------------------------------------------------------------------------ hub

  async hub(me: Me): Promise<IntegrationsHubView> {
    const scope = await this.manageScope(me);
    const accounts = await this.prisma.integrationAccount.findMany({
      where: { orgId: me.orgId, status: { not: 'disconnected' }, ...(scope === 'all' ? {} : { clientOrgId: { in: scope } }) },
      orderBy: [{ provider: 'asc' }, { createdAt: 'desc' }],
    });
    const ids = accounts.map((a) => a.id);
    const [views, jobs, pubs] = await Promise.all([
      this.views(accounts),
      this.prisma.syncJob.findMany({ where: { orgId: me.orgId, accountId: { in: ids } }, orderBy: { startedAt: 'desc' }, take: 40 }),
      this.prisma.postPublication.findMany({ where: { orgId: me.orgId, accountId: { in: ids } }, orderBy: { updatedAt: 'desc' }, take: 30 }),
    ]);
    const connectors: ConnectorStatus[] = INTEGRATION_PROVIDERS.map((p) => {
      const info = PROVIDER_INFO[p];
      const mine = accounts.filter((a) => a.provider === p);
      const missing = missingEnv(p);
      return { provider: p, label: info.label, kind: info.kind, publishes: info.publishes, configured: missing.length === 0, missingEnv: missing, accounts: mine.length, errors: mine.filter((a) => a.status === 'error').length };
    });
    return {
      connectors,
      accounts: views,
      jobs: this.jobViews(jobs, accounts),
      publications: await this.publicationViews(pubs),
      testAccountsAllowed: testAccountsAllowed(),
      callbackUrl: `${apiPublicUrl()}/integrations/oauth/callback`,
      canManage: true,
    };
  }

  async views(accounts: IntegrationAccount[]): Promise<IntegrationAccountView[]> {
    const [clients, users, counts] = await Promise.all([
      this.prisma.clientOrg.findMany({ where: { id: { in: [...new Set(accounts.map((a) => a.clientOrgId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: [...new Set(accounts.map((a) => a.connectedById))] } }, select: { id: true, name: true } }),
      this.prisma.postPublication.groupBy({ by: ['accountId'], where: { accountId: { in: accounts.map((a) => a.id) }, status: 'published' }, _count: { _all: true } }),
    ]);
    const cName = new Map(clients.map((c) => [c.id, c]));
    const uName = new Map(users.map((u) => [u.id, u.name]));
    const n = new Map(counts.map((c) => [c.accountId, c._count._all]));
    return accounts.map((a) => ({
      id: a.id,
      provider: a.provider as IntegrationProvider,
      mode: a.mode === 'test' ? 'test' : 'live',
      name: a.name,
      externalId: a.externalId,
      client: a.clientOrgId ? (cName.get(a.clientOrgId) ?? null) : null,
      status: a.status as IntegrationAccountView['status'],
      lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
      lastError: a.lastError,
      connectedBy: uName.get(a.connectedById) ?? 'Someone',
      createdAt: a.createdAt.toISOString(),
      published: n.get(a.id) ?? 0,
    }));
  }

  jobViews(jobs: SyncJob[], accounts: IntegrationAccount[]): SyncJobView[] {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return jobs.map((j) => ({
      id: j.id,
      accountId: j.accountId,
      accountName: byId.get(j.accountId)?.name ?? 'Account',
      provider: (byId.get(j.accountId)?.provider ?? 'instagram') as IntegrationProvider,
      kind: j.kind as SyncJobView['kind'],
      status: j.status as SyncJobView['status'],
      items: j.items,
      error: j.error,
      startedAt: j.startedAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString() ?? null,
    }));
  }

  async jobs(me: Me, accountId?: string): Promise<SyncJobView[]> {
    const scope = await this.manageScope(me);
    const accounts = await this.prisma.integrationAccount.findMany({ where: { orgId: me.orgId, ...(accountId ? { id: accountId } : {}), ...(scope === 'all' ? {} : { clientOrgId: { in: scope } }) } });
    const jobs = await this.prisma.syncJob.findMany({ where: { accountId: { in: accounts.map((a) => a.id) } }, orderBy: { startedAt: 'desc' }, take: 100 });
    return this.jobViews(jobs, accounts);
  }

  async publicationViews(pubs: { id: string; deliverableId: string; accountId: string; status: string; attempts: number; error: string | null; url: string | null; nextAttemptAt: Date | null; publishedAt: Date | null }[]): Promise<PublicationView[]> {
    if (!pubs.length) return [];
    const [dels, accounts] = await Promise.all([
      this.prisma.deliverable.findMany({ where: { id: { in: pubs.map((p) => p.deliverableId) } }, select: { id: true, title: true, cycle: { select: { engagement: { select: { clientOrg: { select: { name: true } } } } } } } }),
      this.prisma.integrationAccount.findMany({ where: { id: { in: pubs.map((p) => p.accountId) } }, select: { id: true, name: true, provider: true } }),
    ]);
    const d = new Map(dels.map((x) => [x.id, x]));
    const a = new Map(accounts.map((x) => [x.id, x]));
    return pubs.map((p) => ({
      id: p.id,
      deliverableId: p.deliverableId,
      title: d.get(p.deliverableId)?.title ?? 'Post',
      client: d.get(p.deliverableId)?.cycle.engagement.clientOrg.name ?? '',
      accountName: a.get(p.accountId)?.name ?? 'Account',
      provider: (a.get(p.accountId)?.provider ?? 'instagram') as IntegrationProvider,
      status: p.status as PublicationView['status'],
      attempts: p.attempts,
      error: p.error,
      url: p.url,
      nextAttemptAt: p.nextAttemptAt?.toISOString() ?? null,
      publishedAt: p.publishedAt?.toISOString() ?? null,
    }));
  }

  // ------------------------------------------------------------------------------------------------ connect

  async addTest(me: Me, body: unknown, ip?: string): Promise<IntegrationAccountView> {
    if (!testAccountsAllowed()) throw new ForbiddenException('Test accounts are switched off on a live server');
    const input = parse(testAccountSchema, body);
    await this.assertManage(me, input.clientOrgId);
    const client = input.clientOrgId ? await this.prisma.clientOrg.findUnique({ where: { id: input.clientOrgId }, select: { name: true } }) : null;
    const label = PROVIDER_INFO[input.provider].label;
    const a = await this.prisma.integrationAccount.create({
      data: {
        orgId: me.orgId,
        provider: input.provider,
        mode: 'test',
        clientOrgId: input.clientOrgId,
        name: input.name?.trim() || `Test ${label}${client ? ` · ${client.name}` : ''}`,
        externalId: `test-${input.provider}-${randomBytes(5).toString('hex')}`,
        connectedById: me.id,
      },
    });
    await this.audit.log(me, 'integration.account_connected', 'IntegrationAccount', a.id, undefined, { provider: a.provider, mode: 'test', clientOrgId: a.clientOrgId }, ip);
    return (await this.views([a]))[0];
  }

  async oauthStart(me: Me, body: unknown) {
    const input = parse(oauthStartSchema, body);
    await this.assertManage(me, input.clientOrgId);
    const missing = missingEnv(input.provider);
    if (missing.length) throw new BadRequestException(`${PROVIDER_INFO[input.provider].label} is not set up on the server yet. Add ${missing.join(', ')} to apps/api/.env (see the run guide), or use a test account.`);
    const state = signToken({ o: me.orgId, u: me.id, p: input.provider, c: input.clientOrgId, n: randomBytes(6).toString('hex') } satisfies OAuthState, 600);
    return { url: loginFor(input.provider).authUrl(state, `${apiPublicUrl()}/integrations/oauth/callback`, input.provider) };
  }

  /** The provider sends the person back here. Returns where to send the browser next. */
  async oauthCallback(q: { code?: string; state?: string; error?: string; error_description?: string }): Promise<string> {
    const back = (params: Record<string, string>) => `${appUrl()}/admin/integrations?${new URLSearchParams(params)}`;
    const raw = verifyToken<OAuthState | CalendarOAuthState>(q.state);
    // v23: a person connecting their own Google Calendar (Google Meet links) shares this return address.
    if (raw && 'k' in raw && raw.k === 'calendar') return this.calendarCallback(raw, q);
    const st = raw as OAuthState | null;
    if (!st) return back({ error: 'The sign-in link expired. Press Connect again.' });
    if (q.error || !q.code) return back({ error: q.error_description ?? q.error ?? 'Sign-in was cancelled' });
    try {
      const found = await loginFor(st.p).exchange(q.code, `${apiPublicUrl()}/integrations/oauth/callback`, st.p);
      if (!found.length) return back({ error: `No ${PROVIDER_INFO[st.p].label} accounts were found for that login` });
      for (const f of found) {
        const data = { name: f.name, tokenEnc: seal(f.token), refreshEnc: f.refreshToken ? seal(f.refreshToken) : null, tokenExpiresAt: f.expiresAt ?? null, scopes: f.scopes, status: 'connected', lastError: null, disconnectedAt: null, mode: 'live' };
        const a = await this.prisma.integrationAccount.upsert({
          where: { orgId_provider_externalId: { orgId: st.o, provider: f.provider, externalId: f.externalId } },
          create: { orgId: st.o, provider: f.provider, externalId: f.externalId, clientOrgId: st.c, connectedById: st.u, ...data },
          update: { ...data, ...(st.c ? { clientOrgId: st.c } : {}) },
        });
        await this.audit.logSystem(st.o, 'integration.account_connected', 'IntegrationAccount', a.id, { provider: f.provider, mode: 'live', by: st.u });
      }
      return back({ connected: String(found.length), provider: st.p });
    } catch (e) {
      this.log.warn(`OAuth ${st.p} failed: ${(e as Error).message}`);
      return back({ error: (e as Error).message.slice(0, 300) });
    }
  }

  /** v23: finishes connecting a person's Google Calendar and sends them back to Meetings. */
  private async calendarCallback(st: CalendarOAuthState, q: { code?: string; error?: string; error_description?: string }): Promise<string> {
    const back = (params: Record<string, string>) => `${appUrl()}/team/meetings?${new URLSearchParams(params)}`;
    if (q.error || !q.code) return back({ calendarError: q.error_description ?? q.error ?? 'Google sign-in was cancelled' });
    try {
      const email = await finishCalendarConnect(this.prisma, st, q.code, `${apiPublicUrl()}/integrations/oauth/callback`);
      await this.audit.logSystem(st.o, 'calendar.connected', 'User', st.u, { provider: 'google', email });
      return back({ calendar: 'connected' });
    } catch (e) {
      this.log.warn(`Google Calendar connect failed: ${(e as Error).message}`);
      return back({ calendarError: (e as Error).message.slice(0, 300) });
    }
  }

  async updateAccount(me: Me, id: string, body: unknown, ip?: string): Promise<IntegrationAccountView> {
    const input = parse(accountUpdateSchema, body);
    const a = await this.account(me, id);
    await this.assertManage(me, input.clientOrgId);
    const updated = await this.prisma.integrationAccount.update({ where: { id }, data: { clientOrgId: input.clientOrgId } });
    await this.prisma.adMetricDaily.updateMany({ where: { accountId: id }, data: { clientOrgId: input.clientOrgId } });
    await this.audit.log(me, 'integration.account_updated', 'IntegrationAccount', id, { clientOrgId: a.clientOrgId }, { clientOrgId: input.clientOrgId }, ip);
    return (await this.views([updated]))[0];
  }

  async disconnect(me: Me, id: string, ip?: string): Promise<IntegrationAccountView> {
    await this.account(me, id);
    const updated = await this.prisma.integrationAccount.update({ where: { id }, data: { status: 'disconnected', tokenEnc: null, refreshEnc: null, disconnectedAt: new Date() } });
    await this.prisma.postPublication.updateMany({ where: { accountId: id, status: { in: ['queued'] } }, data: { status: 'failed', error: 'The account was disconnected' } });
    await this.audit.log(me, 'integration.account_disconnected', 'IntegrationAccount', id, undefined, { provider: updated.provider }, ip);
    return (await this.views([updated]))[0];
  }

  // ------------------------------------------------------------------------------------------------ jobs

  /** Decrypted token, refreshed first when it is about to expire. */
  async ctx(a: IntegrationAccount): Promise<AccountCtx> {
    let token = unseal(a.tokenEnc);
    if (a.mode !== 'test' && a.tokenExpiresAt && a.tokenExpiresAt.getTime() < Date.now() + 5 * 60_000) {
      const refresh = unseal(a.refreshEnc);
      const flow = loginFor(a.provider as IntegrationProvider);
      if (refresh && flow.refresh) {
        const r = await flow.refresh(refresh);
        token = r.token;
        await this.prisma.integrationAccount.update({ where: { id: a.id }, data: { tokenEnc: seal(r.token), tokenExpiresAt: r.expiresAt } });
      } else if (a.tokenExpiresAt.getTime() < Date.now()) {
        throw new Error('The sign-in has expired. Press Reconnect on Integrations.');
      }
    }
    if (a.mode !== 'test' && !token) throw new Error('No sign-in stored. Press Reconnect on Integrations.');
    return { id: a.id, provider: a.provider as IntegrationProvider, externalId: a.externalId, name: a.name, token, mode: a.mode, createdAt: a.createdAt };
  }

  /** Runs one connector job with a log row; marks the account in error (and tells leadership once) on failure. */
  async runJob<T>(a: IntegrationAccount, kind: SyncJob['kind'], fn: (ctx: AccountCtx) => Promise<{ items: number; result: T }>): Promise<{ job: SyncJob; result: T | null; error: string | null }> {
    const job = await this.prisma.syncJob.create({ data: { orgId: a.orgId, accountId: a.id, kind } });
    try {
      const { items, result } = await fn(await this.ctx(a));
      const done = await this.prisma.syncJob.update({ where: { id: job.id }, data: { status: 'ok', items, finishedAt: new Date() } });
      await this.prisma.integrationAccount.update({ where: { id: a.id }, data: { lastSyncAt: new Date(), ...(a.status === 'error' ? { status: 'connected', lastError: null } : {}) } });
      return { job: done, result, error: null };
    } catch (e) {
      const error = (e as Error).message.slice(0, 500);
      const done = await this.prisma.syncJob.update({ where: { id: job.id }, data: { status: 'failed', error, finishedAt: new Date() } });
      if (kind !== 'publish') {
        await this.prisma.integrationAccount.update({ where: { id: a.id }, data: { status: 'error', lastError: error } });
        if (a.status !== 'error') await this.alert(a, `${a.name} stopped syncing`, error);
        await this.audit.logSystem(a.orgId, 'integration.sync_failed', 'IntegrationAccount', a.id, { kind, error });
      }
      return { job: done, result: null, error };
    }
  }

  /** Leadership and the client's Client Manager hear about connection and publishing problems. */
  async alert(a: { orgId: string; clientOrgId: string | null }, title: string, body: string) {
    const [leaders, client] = await Promise.all([
      this.prisma.user.findMany({ where: { orgId: a.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: { in: ['founder', 'admin'] } } } } }, select: { id: true } }),
      a.clientOrgId ? this.prisma.clientOrg.findUnique({ where: { id: a.clientOrgId }, select: { amUserId: true } }) : null,
    ]);
    await this.notifications.notify(a.orgId, [...leaders.map((l) => l.id), client?.amUserId], { kind: 'integration', title, body, link: '/admin/integrations' });
  }

  // ------------------------------------------------------------------------------------------------ results

  async results(me: Me, clientOrgId: string, from?: string, to?: string): Promise<AdResultsView> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const scope = await clientScope(this.prisma, me);
    if (!inScope(scope, clientOrgId)) throw new ForbiddenException('You do not work on this client');
    return this.resultsFor(me.orgId, clientOrgId, from, to);
  }

  async clientResults(me: Me, from?: string, to?: string): Promise<AdResultsView> {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    return this.resultsFor(me.orgId, me.clientOrg.id, from, to);
  }

  async resultsFor(orgId: string, clientOrgId: string, from?: string, to?: string): Promise<AdResultsView> {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const t = to && day.test(to) ? to : addDay(istDay(new Date()), -1);
    const f = from && day.test(from) ? from : addDay(t, -29);
    if (f > t) throw new BadRequestException('Pick a valid date range');
    const [rows, accounts] = await Promise.all([
      this.prisma.adMetricDaily.findMany({ where: { orgId, clientOrgId, date: { gte: new Date(`${f}T00:00:00Z`), lte: new Date(`${t}T00:00:00Z`) } } }),
      this.prisma.integrationAccount.findMany({ where: { orgId, clientOrgId, status: { not: 'disconnected' }, provider: { in: ['meta_ads', 'google_ads', 'ga4'] } } }),
    ]);
    const totals = { spendPaise: 0, impressions: 0, clicks: 0, conversions: 0, sessions: 0, users: 0, revenuePaise: 0 };
    const byProvider = new Map<string, AdResultsView['byProvider'][number]>();
    const daily = new Map<string, AdResultsView['daily'][number]>();
    const campaigns = new Map<string, AdResultsView['campaigns'][number]>();
    for (const r of rows) {
      const p = r.provider as IntegrationProvider;
      const date = r.date.toISOString().slice(0, 10);
      for (const k of ['spendPaise', 'impressions', 'clicks', 'conversions', 'sessions', 'users', 'revenuePaise'] as const) totals[k] += r[k];
      const bp = byProvider.get(p) ?? { provider: p, label: PROVIDER_INFO[p]?.label ?? p, spendPaise: 0, impressions: 0, clicks: 0, conversions: 0, sessions: 0, users: 0, revenuePaise: 0 };
      for (const k of ['spendPaise', 'impressions', 'clicks', 'conversions', 'sessions', 'users', 'revenuePaise'] as const) bp[k] += r[k];
      byProvider.set(p, bp);
      const dd = daily.get(date) ?? { date, spendPaise: 0, clicks: 0, conversions: 0, sessions: 0 };
      dd.spendPaise += r.spendPaise;
      dd.clicks += r.clicks;
      dd.conversions += r.conversions;
      dd.sessions += r.sessions;
      daily.set(date, dd);
      if (r.campaign) {
        const key = `${p}|${r.campaign}`;
        const c = campaigns.get(key) ?? { provider: p, campaign: r.campaign, spendPaise: 0, impressions: 0, clicks: 0, conversions: 0 };
        c.spendPaise += r.spendPaise;
        c.impressions += r.impressions;
        c.clicks += r.clicks;
        c.conversions += r.conversions;
        campaigns.set(key, c);
      }
    }
    const adConversions = [...byProvider.values()].filter((b) => b.provider !== 'ga4').reduce((s, b) => s + b.conversions, 0);
    return {
      from: f,
      to: t,
      hasData: rows.length > 0,
      totals: {
        ...totals,
        ctrPct: totals.impressions ? Math.round((totals.clicks / totals.impressions) * 1000) / 10 : null,
        cpcPaise: totals.clicks ? Math.round(totals.spendPaise / totals.clicks) : null,
        costPerConversionPaise: adConversions ? Math.round(totals.spendPaise / adConversions) : null,
      },
      byProvider: [...byProvider.values()],
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
      campaigns: [...campaigns.values()].sort((a, b) => b.spendPaise - a.spendPaise).slice(0, 20),
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, provider: a.provider as IntegrationProvider, mode: a.mode === 'test' ? 'test' : 'live', status: a.status, lastSyncAt: a.lastSyncAt?.toISOString() ?? null })),
    };
  }

  /** Public page for a post sent to BMU's test account. */
  async testPost(externalId: string) {
    const p = await this.prisma.postPublication.findFirst({ where: { externalId, status: 'published' } });
    const a = p ? await this.prisma.integrationAccount.findUnique({ where: { id: p.accountId } }) : null;
    if (!p || !a || a.mode !== 'test') throw new NotFoundException('Test post not found');
    const d = await this.prisma.deliverable.findUniqueOrThrow({ where: { id: p.deliverableId }, select: { title: true, caption: true } });
    return { externalId, provider: a.provider, account: a.name, caption: d.caption, title: d.title, publishedAt: (p.publishedAt ?? p.updatedAt).toISOString() };
  }
}
