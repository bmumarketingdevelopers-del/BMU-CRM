// v21 backend runtime: shares event-bus events between backend processes through Postgres LISTEN/NOTIFY, so no
// extra service (Redis, a message broker) is needed. Every process listens on one channel; each event published in
// a process is sent once with that process's id, and every other process re-publishes it on its own bus. That keeps
// the per-person read cache, live updates, the search index, workflows, AI agents and webhooks in step whether the
// backend runs as one process or as API + worker processes.
//
// Notes
// - LISTEN needs a direct database connection. Behind PgBouncer in transaction mode, set DIRECT_DATABASE_URL.
// - Postgres limits a notification to 8000 bytes. Large id lists are trimmed (an empty list means "several rows"),
//   which every subscriber already handles for bulk writes.
// - While the connection is down events are not shared (each process still handles its own); it reconnects with
//   backoff and System health shows the state.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { eventBus, reviveEvent, type BusEvent } from '../platform/event-bus.js';
import { bridgeEnabled, instanceId } from './process-role.js';

const CHANNEL = 'bmu_events';
const MAX_BYTES = 7900;
const MAX_IDS = 100;

export type BridgeState = { transport: 'in_process' | 'postgres'; connected: boolean; sent: number; received: number; dropped: number; lastError: string | null };

/** The notification body for one event, kept under Postgres's size limit. */
export function encodeEvent(e: BusEvent): string {
  let body = JSON.stringify({ o: instanceId, e: e.kind === 'change' && e.ids.length > MAX_IDS ? { ...e, ids: [] } : e });
  if (Buffer.byteLength(body) > MAX_BYTES && e.kind === 'change') body = JSON.stringify({ o: instanceId, e: { ...e, ids: [], refs: {} } });
  return body;
}

/** Parses a notification; null for our own events or anything malformed. */
export function decodeEvent(payload: string | undefined, self = instanceId): BusEvent | null {
  if (!payload) return null;
  try {
    const msg = JSON.parse(payload) as { o?: string; e?: unknown };
    if (!msg.e || msg.o === self) return null;
    return reviveEvent(msg.e);
  } catch {
    return null;
  }
}

@Injectable()
export class EventBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('EventBridge');
  private client: pg.Client | null = null;
  private stopping = false;
  private retryMs = 1000;
  private retryTimer?: ReturnType<typeof setTimeout>;
  readonly state: BridgeState = { transport: 'in_process', connected: false, sent: 0, received: 0, dropped: 0, lastError: null };

  async onModuleInit() {
    if (!bridgeEnabled()) return;
    this.state.transport = 'postgres';
    eventBus.outbound = (e) => this.send(e);
    await this.connect();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (eventBus.outbound) eventBus.outbound = null;
    const c = this.client;
    this.client = null;
    this.state.connected = false;
    await c?.end().catch(() => undefined);
  }

  private async connect() {
    if (this.stopping) return;
    const client = new pg.Client({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL, application_name: 'bmu-hub-events' });
    client.on('notification', (n) => {
      if (n.channel !== CHANNEL) return;
      const e = decodeEvent(n.payload);
      if (!e) return;
      this.state.received++;
      eventBus.publish(e, { remote: true });
    });
    client.on('error', (err) => this.lost(client, err));
    client.on('end', () => this.lost(client, new Error('connection closed')));
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      this.state.connected = true;
      this.state.lastError = null;
      this.retryMs = 1000;
      this.log.log('Sharing events with other backend processes through Postgres');
    } catch (err) {
      this.lost(client, err as Error);
    }
  }

  private lost(client: pg.Client, err: Error) {
    if (this.stopping) return;
    if (this.client && this.client !== client) return;
    this.client = null;
    if (this.state.connected || this.state.lastError !== err.message) this.log.warn(`Event sharing paused: ${err.message}. Reconnecting…`);
    this.state.connected = false;
    this.state.lastError = err.message;
    void client.end().catch(() => undefined);
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, this.retryMs);
    this.retryTimer.unref?.();
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }

  private send(e: BusEvent) {
    const c = this.client;
    if (!c) {
      this.state.dropped++;
      return;
    }
    this.state.sent++;
    c.query('SELECT pg_notify($1, $2)', [CHANNEL, encodeEvent(e)]).catch((err: Error) => {
      this.state.dropped++;
      this.state.lastError = err.message;
    });
  }
}
