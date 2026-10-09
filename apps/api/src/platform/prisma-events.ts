// v13 foundation: publishes a `change` event on the event bus after every database write, from one place, so no
// feature has to remember to. Reads are untouched. The event carries ids and a few routing references (organisation,
// client, engagement, thread, owner) but never record data: screens reload through their own permission-checked endpoints.
import type { LiveChangeOp } from '@bmu/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import { eventBus, type ChangeRefs } from './event-bus.js';
import { requestContext } from './request-context.js';

const WRITES: Record<string, LiveChangeOp> = {
  create: 'create',
  createMany: 'create',
  createManyAndReturn: 'create',
  update: 'update',
  updateMany: 'update',
  updateManyAndReturn: 'update',
  upsert: 'update',
  delete: 'delete',
  deleteMany: 'delete',
};

/** Bookkeeping tables that change constantly and mean nothing to a screen. */
export const QUIET_MODELS = new Set(['AuditEvent', 'UndoEntry', 'OtpCode', 'SearchDoc', 'EventFailure', 'AiLog', 'EmailOutbox', 'ErrorLog', 'ThreadRead', 'DashboardVersion', 'WorkflowRunStep']);

type Row = Record<string, unknown>;
type Delegate = { findUnique(a: unknown): Promise<Row | null>; findFirst(a: unknown): Promise<Row | null> };

const str = (v: unknown) => (typeof v === 'string' ? v : null);

function refsOf(row: Row | undefined): ChangeRefs {
  if (!row) return {};
  return { clientOrgId: str(row.clientOrgId), engagementId: str(row.engagementId), threadId: str(row.threadId), userId: str(row.userId) };
}

/** Ids named by a where clause ({ id } or { id: { in } }). */
function idsOfWhere(where: unknown): string[] {
  const w = where as Row | undefined;
  if (!w) return [];
  if (typeof w.id === 'string') return [w.id];
  const inList = (w.id as Row | undefined)?.in;
  return Array.isArray(inList) ? inList.filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
}

export function withChangeEvents<T extends PrismaClient>(client: T) {
  const delegate = (model: string) => (client as unknown as Record<string, Delegate>)[model.charAt(0).toLowerCase() + model.slice(1)];

  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const op = WRITES[operation];
          if (!op || QUIET_MODELS.has(model)) return query(args);
          const a = (args ?? {}) as Row;
          const ctx = requestContext.getStore();
          // Bulk deletes lose their rows, so work out the organisation first.
          let preOrg: string | null = null;
          if (operation === 'deleteMany' && !str((a.where as Row | undefined)?.orgId)) {
            preOrg = str((await delegate(model)?.findFirst({ where: a.where, select: { orgId: true } }).catch(() => null))?.orgId);
          }
          const result = await query(args);
          try {
            const rows: Row[] = Array.isArray(result) ? (result as Row[]) : result && typeof result === 'object' && 'id' in (result as Row) ? [result as Row] : [];
            const data = (Array.isArray(a.data) ? a.data[0] : a.data) as Row | undefined;
            let ids = rows.map((r) => str(r.id)).filter((x): x is string => !!x);
            if (!ids.length) ids = idsOfWhere(a.where);
            let orgId = str(rows[0]?.orgId) ?? str(data?.orgId) ?? str((a.create as Row | undefined)?.orgId) ?? str((a.where as Row | undefined)?.orgId) ?? preOrg;
            const refs = { ...refsOf(data), ...refsOf(rows[0]) };
            const publish = () =>
              eventBus.publish({ kind: 'change', orgId, entity: model, op, ids, at: new Date(), actorId: ctx?.userId ?? null, quiet: ctx ? ctx.method === 'GET' || ctx.method === 'HEAD' : false, refs });
            if (!orgId && ids[0] && op !== 'delete') {
              // The write selected only some fields: look the organisation up (after the request, never blocking it).
              void delegate(model)
                ?.findUnique({ where: { id: ids[0] }, select: { orgId: true } })
                .then((r) => {
                  orgId = str(r?.orgId);
                })
                .catch(() => undefined)
                .finally(publish);
            } else publish();
          } catch {
            // Events must never break a write.
          }
          return result;
        },
      },
    },
  });
}
