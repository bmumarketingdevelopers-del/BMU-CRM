// v13 foundation: live updates and presence over server-sent events (GET /realtime/stream).
// Works through the web app's /api proxy on the same address, so there is nothing extra to set up or open.
//
// Who receives a change:
// - team members: changes in their organisation (personal records such as notifications only to their owner);
// - clients: changes linked to their own client account (directly, through an engagement or a thread);
// - creators: their own records.
// Messages say only "Task ck… was updated"; each screen reloads through its own permission-checked endpoint.
import { ForbiddenException, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Response } from 'express';
import { LIVE_PRESENCE_TTL_MS, type LiveMessage, type LivePresenceInput, type LivePresenceUser, type Me } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { servesHttp } from '../runtime/process-role.js';
import { eventBus, type BusEvent, type ChangeEvent } from './event-bus.js';
import { FlagsService } from './flags.service.js';

type Conn = {
  id: string;
  me: Pick<Me, 'id' | 'name' | 'orgId' | 'type' | 'roles'> & { clientOrgId: string | null };
  res: Response;
  flags: Record<string, boolean>;
  rooms: Set<string>;
  seenAt: number;
};

/** Records that belong to one person: only they hear about changes. */
const PERSONAL = new Set(['Notification', 'Draft', 'SavedView', 'NotificationPreference', 'Watcher']);
const PING_MS = 25_000;

@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Realtime');
  private readonly conns = new Map<string, Conn>();
  private unsub?: () => void;
  private ping?: ReturnType<typeof setInterval>;
  private sweep?: ReturnType<typeof setInterval>;
  private seq = 0;
  /** engagementId / threadId → clientOrgId, for routing changes to client accounts. */
  private readonly clientOf = new Map<string, string | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FlagsService,
  ) {}

  onModuleInit() {
    // A worker process holds no screen connections; changes it makes reach screens through the API processes.
    if (!servesHttp()) return;
    this.unsub = eventBus.subscribe('realtime', (e) => this.onEvent(e), ['change']);
    this.flags.onChange = (orgId) => void this.refreshFlags(orgId);
    this.ping = setInterval(() => this.broadcastRaw(': ping\n\n'), PING_MS);
    this.sweep = setInterval(() => this.sweepPresence(), 15_000);
    this.ping.unref?.();
    this.sweep.unref?.();
  }

  onModuleDestroy() {
    this.unsub?.();
    if (this.ping) clearInterval(this.ping);
    if (this.sweep) clearInterval(this.sweep);
    for (const c of this.conns.values()) c.res.end();
    this.conns.clear();
  }

  stats() {
    const people = new Set([...this.conns.values()].map((c) => c.me.id));
    const rooms = new Set([...this.conns.values()].flatMap((c) => [...c.rooms]));
    return { connections: this.conns.size, people: people.size, rooms: rooms.size };
  }

  /** Opens a live stream for this person. */
  async open(me: Me, res: Response) {
    const id = `c${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const flags = await this.flags.forMe(me);
    const conn: Conn = { id, me: { id: me.id, name: me.name, orgId: me.orgId, type: me.type, roles: me.roles, clientOrgId: me.clientOrg?.id ?? null }, res, flags, rooms: new Set(), seenAt: Date.now() };
    this.conns.set(id, conn);
    res.write('retry: 3000\n\n');
    this.send(conn, { kind: 'hello', connId: id, flags });
    res.on('close', () => {
      const rooms = [...conn.rooms];
      this.conns.delete(id);
      for (const r of rooms) this.broadcastPresence(r);
    });
  }

  /** Records which records this screen is showing and tells others looking at the same ones. */
  presence(me: Me, input: LivePresenceInput) {
    const conn = this.conns.get(input.connId);
    if (!conn || conn.me.id !== me.id) throw new ForbiddenException('That live connection is not yours');
    if (me.type !== 'staff' || !conn.flags.presence) return { ok: true as const };
    const before = conn.rooms;
    conn.rooms = new Set(input.rooms);
    conn.seenAt = Date.now();
    for (const r of new Set([...before, ...conn.rooms])) this.broadcastPresence(r);
    return { ok: true as const };
  }

  private viewers(room: string): LivePresenceUser[] {
    const seen = new Map<string, LivePresenceUser>();
    for (const c of this.conns.values()) if (c.rooms.has(room) && !seen.has(c.me.id)) seen.set(c.me.id, { id: c.me.id, name: c.me.name });
    return [...seen.values()];
  }

  private broadcastPresence(room: string) {
    const users = this.viewers(room);
    for (const c of this.conns.values()) if (c.rooms.has(room)) this.send(c, { kind: 'presence', room, users });
  }

  private sweepPresence() {
    const now = Date.now();
    for (const c of this.conns.values()) {
      if (c.rooms.size && now - c.seenAt > LIVE_PRESENCE_TTL_MS) {
        const rooms = [...c.rooms];
        c.rooms.clear();
        for (const r of rooms) this.broadcastPresence(r);
      }
    }
  }

  private async refreshFlags(orgId: string) {
    for (const c of this.conns.values()) {
      if (c.me.orgId !== orgId) continue;
      c.flags = await this.flags.forMe(c.me);
      this.send(c, { kind: 'hello', connId: c.id, flags: c.flags });
    }
  }

  private async onEvent(e: BusEvent) {
    if (e.kind !== 'change' || e.quiet || !this.conns.size) return;
    const msg: LiveMessage = { kind: 'change', entity: e.entity, op: e.op, ids: e.ids, at: e.at.toISOString(), actorId: e.actorId };
    let clientOrgId: string | null | undefined;
    for (const c of this.conns.values()) {
      if (!c.flags.live_updates) continue;
      if (e.orgId ? c.me.orgId !== e.orgId : c.me.type !== 'staff') continue;
      if (PERSONAL.has(e.entity) || c.me.type === 'creator') {
        if (e.refs.userId !== c.me.id) continue;
      } else if (c.me.type === 'client') {
        if (clientOrgId === undefined) clientOrgId = await this.resolveClient(e);
        if (!clientOrgId || clientOrgId !== c.me.clientOrgId) continue;
      }
      this.send(c, msg);
    }
  }

  private async resolveClient(e: ChangeEvent): Promise<string | null> {
    if (e.entity === 'ClientOrg') return e.ids[0] ?? null;
    if (e.refs.clientOrgId) return e.refs.clientOrgId;
    const key = e.refs.engagementId ? `e:${e.refs.engagementId}` : e.refs.threadId ? `t:${e.refs.threadId}` : null;
    if (!key) return null;
    if (this.clientOf.has(key)) return this.clientOf.get(key) ?? null;
    const row = e.refs.engagementId
      ? await this.prisma.engagement.findUnique({ where: { id: e.refs.engagementId }, select: { clientOrgId: true } })
      : await this.prisma.thread.findUnique({ where: { id: e.refs.threadId! }, select: { clientOrgId: true } });
    const v = row?.clientOrgId ?? null;
    if (this.clientOf.size > 5000) this.clientOf.clear();
    this.clientOf.set(key, v);
    return v;
  }

  private send(c: Conn, msg: LiveMessage) {
    try {
      c.res.write(`data: ${JSON.stringify(msg)}\n\n`);
    } catch (err) {
      this.log.warn(`Dropping live connection ${c.id}: ${(err as Error).message}`);
      this.conns.delete(c.id);
    }
  }

  private broadcastRaw(text: string) {
    for (const c of this.conns.values()) {
      try {
        c.res.write(text);
      } catch {
        this.conns.delete(c.id);
      }
    }
  }
}
