// v11 core: registries other areas plug into. Inject `ActionsRegistry` (global) in your service and register in
// onModuleInit(). See docs/flows/core-actions.md "How to plug in" for worked examples.
import { Injectable } from '@nestjs/common';
import type { CoreImportField, CoreReassignApply, Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';

/** One record the reassignment engine moves (a task, a deliverable, a lead, a client's CM seat…). */
export type ReassignItem = {
  id: string;
  title: string;
  ownerId: string | null;
  deadline: Date | null;
  status: string | null;
  /** Work already started: a handover note is required. */
  inProgress: boolean;
  /** Client-facing date (deliverable due date, review date) that a deadline change could move. */
  clientDueAt?: Date | null;
  clientOrgId?: string | null;
  /** The client's CM (notified for client work). */
  amId?: string | null;
  departmentId?: string | null;
  specialty?: string | null;
  /** Hours of work this item adds to the new owner's load. */
  hours: number;
  /** Titles of open records that wait on this one. */
  dependents?: string[];
  href?: string | null;
};

/** Who may take the work. */
export type ReassignEligibility = {
  /** Extra user filter (roles, department…). The engine already limits to active staff in the org. */
  where?: Prisma.UserWhereInput;
  /** Department to prefer (sorted first, used for "Department Head" approvals). */
  departmentId?: string | null;
  /** Specialty that fits the work best (suggestion). */
  specialty?: string | null;
  /** Per-person reason they can't take it (e.g. uploaded the version being QC'd). */
  blocked?: (user: { id: string; name: string; roles: string[] }) => string | null;
  /** v11 ops: account types that may take the work (default staff only; creator briefs use ['creator']). */
  userTypes?: ('staff' | 'creator')[];
};

export type ReassignApplyInput = {
  to: { id: string; name: string };
  /** New deadline per item id (undefined = unchanged). */
  deadlines: Map<string, Date | null | undefined>;
  input: Omit<CoreReassignApply, 'ids' | 'toUserId'> & { reason: string };
};

/** Undo row: restore `data` on `model` row `id`, or delete the row when `delete` is set. */
export type UndoRow = { model: string; id: string; data?: Record<string, unknown>; delete?: boolean };

/**
 * A record type the reassignment engine can move. Core registers `task`, `deliverable` and `qc`; other areas
 * register e.g. `lead` (sales owner), `client_am`, `request`, `creator_brief`, `engagement` (roles: am | strategist | producer).
 */
export interface ReassignTarget {
  type: string;
  label: string;
  /** Seats for multi-role records (engagement). Omit for single-owner records. */
  roles?: { key: string; label: string }[];
  /** Loads the records, throwing 404/403 when `me` can't see them. */
  load(me: Me, ids: string[], role?: string): Promise<ReassignItem[]>;
  /** Throws ForbiddenException when `me` can't reassign these (role + scope). */
  assertCanReassign(me: Me, items: ReassignItem[], role?: string): Promise<void>;
  /** Who may take them (role/department filter, per-person blocks). `items` is empty for a new record. */
  eligibility(me: Me, items: ReassignItem[], ctx: { departmentId?: string | null; role?: string }): Promise<ReassignEligibility>;
  /** Before-state for undo (rows to restore). */
  snapshot(items: ReassignItem[], role?: string): Promise<UndoRow[]>;
  /** Moves ownership (and deadlines). The engine writes Assignment rows, audit, notifications and undo. */
  apply(me: Me, items: ReassignItem[], change: ReassignApplyInput): Promise<void>;
  /** Open records owned by a person (bulk "move all of A's work"). */
  openWorkOf?(orgId: string, userId: string): Promise<{ id: string; title: string; deadline: Date | null; status: string | null; client: string | null }[]>;
  /** Audit entity name (defaults to the type). */
  auditEntity?: string;
  /** Link for notifications. */
  href?(item: ReassignItem): string;
}

export type ApprovalRow = Prisma.ApprovalRequestGetPayload<object>;

/**
 * Applies an approved change. Register one per `action` key. `requester` is the person who asked (loaded fresh),
 * `approver` the person deciding, `input` any extra the approver gave (e.g. { toUserId } for a hand-back).
 */
export interface ApprovalHandler {
  action: string;
  label: string;
  /** What the approver must provide when approving. */
  approveNeeds?: 'none' | 'assignee';
  href?(req: ApprovalRow): string | null;
  /** Who may decide this kind of request. When set, it replaces the default rule (named approver, approver roles, or any Founder / Branch Manager). */
  approvers?(me: Me, req: ApprovalRow): boolean;
  apply(ctx: { approver: Me; requester: Me | null; req: ApprovalRow; input?: Record<string, unknown> }): Promise<unknown>;
  onReject?(ctx: { approver: Me; req: ApprovalRow }): Promise<void>;
}

/** An entity rows can be imported for from CSV. */
export interface ImportEntity {
  entity: string;
  label: string;
  fields: CoreImportField[];
  sampleCsv: string;
  canImport(me: Me): boolean;
  /** Validates mapped rows: one result per row (errors[] empty = ok; duplicate = what it matches). */
  validate(me: Me, rows: Record<string, string>[]): Promise<{ errors: string[]; duplicate: string | null }[]>;
  /** Creates the valid rows; returns the new ids (same order). */
  commit(me: Me, rows: Record<string, string>[], ip?: string): Promise<string[]>;
}

/** An entity with archivedAt/archivedReason that the generic archive/restore endpoints handle. */
export interface ArchiveEntity {
  entity: string;
  /** Prisma delegate name, e.g. 'lead'. Also added to the undo whitelist. */
  model: string;
  /** Audit entity name, e.g. 'Lead'. */
  auditEntity: string;
  /** Throws 403/404 when `me` can't archive/restore this record. */
  assertCan(me: Me, id: string, action: 'archive' | 'restore'): Promise<void>;
  /** Optional rule check before archiving (e.g. open invoices). Throw BadRequestException to refuse. */
  beforeArchive?(me: Me, id: string): Promise<void>;
}

@Injectable()
export class ActionsRegistry {
  readonly reassignTargets = new Map<string, ReassignTarget>();
  readonly approvalHandlers = new Map<string, ApprovalHandler>();
  readonly importEntities = new Map<string, ImportEntity>();
  readonly archiveEntities = new Map<string, ArchiveEntity>();
  /** Prisma models undo may write to. */
  readonly undoModels = new Set<string>(['task', 'deliverable', 'assignment']);

  registerReassignTarget(t: ReassignTarget) {
    this.reassignTargets.set(t.type, t);
  }
  registerApprovalHandler(h: ApprovalHandler) {
    this.approvalHandlers.set(h.action, h);
  }
  registerImportEntity(e: ImportEntity) {
    this.importEntities.set(e.entity, e);
  }
  registerArchiveEntity(e: ArchiveEntity) {
    this.archiveEntities.set(e.entity, e);
    this.undoModels.add(e.model);
  }
  registerUndoModel(model: string) {
    this.undoModels.add(model);
  }
}
