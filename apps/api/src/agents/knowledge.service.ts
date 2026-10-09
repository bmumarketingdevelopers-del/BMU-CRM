// v15 knowledge memory for agents: SOPs, the service catalogue, approved monthly plans, brand kits and client notes,
// cut into chunks and searched with Postgres full-text search (ranked keyword search with English stemming).
// Results are filtered to what the person could open: client-specific chunks only for clients they can see.
// Meaning-based (vector) search can be added later without changing callers; it needs an embeddings provider.
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { formatINR, KNOWLEDGE_SOURCES, knowledgeSourceLabels, type KnowledgeHit, type KnowledgeSource, type Me } from '@bmu/shared';
import { ClientsController } from '../clients/clients.controller.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { redact } from '../ai/ai-safety.js';

type ChunkInput = { orgId: string; clientOrgId: string | null; sourceType: KnowledgeSource; sourceId: string; title: string; link: string | null; text: string };

const PART = 1500;
const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'which', 'who', 'how', 'our', 'are', 'was', 'this', 'that', 'from', 'have', 'has', 'does', 'did', 'can', 'you', 'your', 'about', 'there', 'their', 'when', 'where', 'why', 'into', 'any', 'all', 'show', 'tell', 'give', 'list', 'much', 'many']);

/** Splits long text on paragraph boundaries into parts of about 1,500 characters. */
export function splitText(text: string): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const parts: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > PART) {
      parts.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > PART * 1.5) {
      parts.push(cur.slice(0, PART));
      cur = cur.slice(PART);
    }
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [''];
}

/** Words of the question as a prefix OR query for to_tsquery (letters and digits only, so nothing can inject). */
export function tsQueryOf(q: string): string | null {
  const words = [...new Set((q.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)))].slice(0, 12);
  return words.length ? words.map((w) => `${w}:*`).join(' | ') : null;
}

@Injectable()
export class KnowledgeService {
  private readonly log = new Logger('Knowledge');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ref: ModuleRef,
  ) {}

  /** Rebuilds the organisation's knowledge chunks from the source records. Returns the chunk count. */
  async refresh(orgId: string): Promise<number> {
    const chunks: ChunkInput[] = [];
    const add = (c: Omit<ChunkInput, 'orgId'>) => chunks.push({ orgId, ...c, text: redact(c.text) });

    const sops = await this.prisma.sOP.findMany({ where: { orgId, status: 'published' }, include: { department: { select: { name: true } } } });
    for (const s of sops) add({ clientOrgId: null, sourceType: 'sop', sourceId: s.id, title: `SOP: ${s.title} (${s.department.name}, v${s.version})`, link: `/team/sops/${s.id}`, text: s.body });

    const services = await this.prisma.service.findMany({ where: { orgId, priceBook: { status: 'active' } }, include: { tiers: true } });
    for (const s of services) {
      const tiers = s.tiers.map((t) => `${t.tier}: ${t.isFromPrice ? 'from ' : ''}${formatINR(t.pricePaise)}${s.billingType === 'monthly' ? ' a month' : ''}; includes ${t.deliverables.join(', ') || 'see proposal'}; ${t.revisionRounds} revision rounds`);
      add({ clientOrgId: null, sourceType: 'service', sourceId: s.id, title: `Service: ${s.name}`, link: '/services', text: [`${s.name} (${s.track}, ${s.billingType.replace('_', ' ')}${s.unit ? `, per ${s.unit}` : ''}).`, ...tiers, s.excludedNote ? `Not included: ${s.excludedNote}` : ''].filter(Boolean).join('\n') });
    }

    const plans = await this.prisma.plan.findMany({ where: { orgId, status: 'approved' }, include: { cycle: { select: { period: true, engagement: { select: { clientOrgId: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } } } } } });
    for (const p of plans) {
      const c = p.content as { objectives?: string; audience?: string; pillars?: string[]; creativeDirection?: string; deliverables?: { type: string; title: string; due?: string }[] };
      const e = p.cycle.engagement;
      add({
        clientOrgId: e.clientOrgId,
        sourceType: 'plan',
        sourceId: p.id,
        title: `${e.clientOrg.name}: ${e.service.name} plan ${p.cycle.period}`,
        link: `/team/clients/${e.clientOrgId}`,
        text: [c.objectives && `Objectives: ${c.objectives}`, c.audience && `Audience: ${c.audience}`, c.pillars?.length && `Content pillars: ${c.pillars.join(', ')}`, c.creativeDirection && `Creative direction: ${c.creativeDirection}`, c.deliverables?.length && `Deliverables: ${c.deliverables.map((d) => `${d.title} (${d.type}${d.due ? `, ${d.due}` : ''})`).join('; ')}`].filter(Boolean).join('\n\n'),
      });
    }

    const kits = await this.prisma.craftBrandKit.findMany({ where: { orgId } });
    const clientNames = new Map((await this.prisma.clientOrg.findMany({ where: { orgId }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    for (const k of kits) {
      add({ clientOrgId: k.clientOrgId, sourceType: 'brand_kit', sourceId: k.id, title: `${clientNames.get(k.clientOrgId) ?? 'Client'}: brand kit`, link: `/team/clients/${k.clientOrgId}`, text: [`Colours: ${k.colours.join(', ') || 'not set'}`, `Fonts: ${k.fonts.join(', ') || 'not set'}`, k.tone ? `Tone of voice: ${k.tone}` : '', k.dos.length ? `Do: ${k.dos.join('; ')}` : '', k.donts.length ? `Don't: ${k.donts.join('; ')}` : '', k.competitors.length ? `Competitors: ${k.competitors.join(', ')}` : '', k.notes ? `Notes: ${k.notes}` : ''].filter(Boolean).join('\n') });
    }

    const notes = await this.prisma.craftClientNote.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 2000 });
    for (const n of notes) {
      const when = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(n.createdAt);
      add({ clientOrgId: n.clientOrgId, sourceType: 'client_note', sourceId: n.id, title: `${clientNames.get(n.clientOrgId) ?? 'Client'}: ${n.kind} note, ${when}`, link: `/team/clients/${n.clientOrgId}`, text: n.body });
    }

    const rows = chunks.flatMap((c) => splitText(c.text).map((text, part) => ({ ...c, part, text })));
    await this.prisma.$transaction([this.prisma.knowledgeChunk.deleteMany({ where: { orgId } }), this.prisma.knowledgeChunk.createMany({ data: rows })]);
    this.log.log(`Knowledge refreshed: ${rows.length} chunks`);
    return rows.length;
  }

  async stats(orgId: string) {
    const groups = await this.prisma.knowledgeChunk.groupBy({ by: ['sourceType'], where: { orgId }, _count: { _all: true }, _max: { createdAt: true } });
    const refreshed = groups.map((g) => g._max.createdAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    return {
      chunks: groups.reduce((s, g) => s + g._count._all, 0),
      sources: KNOWLEDGE_SOURCES.map((t) => ({ type: t, label: knowledgeSourceLabels[t], count: groups.find((g) => g.sourceType === t)?._count._all ?? 0 })),
      refreshedAt: refreshed?.toISOString() ?? null,
      search: 'full_text' as const,
    };
  }

  /** Client ids this person can see (client-specific knowledge is limited to these). */
  private async visibleClients(me: Me): Promise<string[]> {
    if (me.type !== 'staff') return [];
    try {
      const list = await (this.ref.get(ClientsController as never, { strict: false }) as ClientsController).list(me);
      return list.map((c) => c.id);
    } catch {
      return [];
    }
  }

  /** Ranked search over what this person may see. Builds the index on first use. */
  async search(me: Me, query: string, limit = 6): Promise<KnowledgeHit[]> {
    const tsq = tsQueryOf(query);
    if (!tsq || me.type !== 'staff') return [];
    if (!(await this.prisma.knowledgeChunk.count({ where: { orgId: me.orgId } }))) await this.refresh(me.orgId);
    const clients = await this.visibleClients(me);
    const rows = await this.prisma.$queryRaw<{ id: string; title: string; link: string | null; sourceType: string; score: number; snippet: string }[]>`
      SELECT id, title, link, "sourceType",
        ts_rank(to_tsvector('english', title || ' ' || text), to_tsquery('english', ${tsq}))::float8 AS score,
        ts_headline('english', text, to_tsquery('english', ${tsq}), 'MaxWords=40, MinWords=15') AS snippet
      FROM knowledge_chunks
      WHERE "orgId" = ${me.orgId}
        AND to_tsvector('english', title || ' ' || text) @@ to_tsquery('english', ${tsq})
        AND ("clientOrgId" IS NULL OR "clientOrgId" = ANY(${clients}::text[]))
      ORDER BY score DESC
      LIMIT ${Math.min(Math.max(limit, 1), 20)}`;
    return rows.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet.replace(/<\/?b>/g, ''), link: r.link, sourceType: r.sourceType, score: Math.round(r.score * 1000) / 1000 }));
  }
}
