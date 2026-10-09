// v20 field-level permissions: one redactor used for every response (web, app, public API), for search and for what
// the AI is given, so a hidden field never leaks through a side door. Matching is by key name (with a little context
// for ambiguous names), because the same value travels in many response shapes.
import { fieldModeFor, PROTECTED_FIELDS, type FieldAccessSettings, type FieldMode, type Me } from '@bmu/shared';

type Obj = Record<string, unknown>;
type Matcher = (key: string, obj: Obj) => boolean;

/** How each protected field shows up in responses, and which request-body keys change it. */
export const FIELD_MATCHERS: Record<string, { read: Matcher; writeKeys: string[]; writePath?: RegExp }> = {
  'lead.budget': {
    read: (k, o) => k === 'budgetPaise' || k === 'budgetRupees' || (k === 'budget' && ('stage' in o || 'need' in o || 'score' in o)),
    writeKeys: ['budgetPaise', 'budgetRupees'],
    writePath: /(^|\/)(leads|sell|v1\/leads|ops\/leads|forms)(\/|$)/,
  },
  'people.cost_rates': {
    read: (k, o) => k === 'costRates' || k === 'hourlyPaise' || k === 'ratePaise' || (k === 'costPaise' && 'hours' in o),
    writeKeys: ['costRates', 'hourlyPaise'],
  },
  'finance.margins': {
    read: (k) => k === 'marginPct' || k === 'profitPaise' || k === 'grossMarginPct',
    writeKeys: [],
  },
  'creator.rates': {
    read: (k, o) => (k === 'rates' || k === 'rateCard') && ('handle' in o || 'niche' in o || 'city' in o),
    writeKeys: ['rates'],
    writePath: /creator/,
  },
  'people.contact': {
    read: (k, o) => k === 'phone' && ('roles' in o || 'specialty' in o || o.type === 'staff' || 'departmentId' in o) && !('stage' in o) && !('clientOrg' in o && o.type !== 'staff'),
    writeKeys: ['phone'],
    writePath: /(^|\/)(org\/users|people|admin-org\/users)(\/|$)/,
  },
};

export type FieldContext = {
  /** Protected field key → mode for this person. */
  modes: Record<string, FieldMode>;
  /** Custom field keys this person cannot see / cannot change. */
  hiddenCustom: Set<string>;
  readOnlyCustom: Set<string>;
  selfId: string | null;
};

export type CustomDef = { key: string; hiddenFrom: string[]; readOnlyFor: string[] };

export function buildContext(me: Pick<Me, 'id' | 'roles'>, overrides: FieldAccessSettings, customDefs: CustomDef[]): FieldContext {
  const modes: Record<string, FieldMode> = {};
  for (const f of PROTECTED_FIELDS) modes[f.key] = fieldModeFor(f.key, me.roles, overrides);
  const founder = me.roles.includes('founder');
  const hiddenCustom = new Set<string>();
  const readOnlyCustom = new Set<string>();
  if (!founder) {
    for (const d of customDefs) {
      if (d.hiddenFrom.length && me.roles.length && me.roles.every((r) => d.hiddenFrom.includes(r))) hiddenCustom.add(d.key);
      else if (d.readOnlyFor.length && me.roles.length && me.roles.every((r) => d.readOnlyFor.includes(r) || d.hiddenFrom.includes(r))) readOnlyCustom.add(d.key);
    }
  }
  return { modes, hiddenCustom, readOnlyCustom, selfId: me.id };
}

/** A creator always sees and edits their own rate card in the creator workspace. */
export function forPath(ctx: FieldContext, path: string): FieldContext {
  if (/^\/?workspace\/creator(\/|$)/.test(path) && ctx.modes['creator.rates'] !== 'edit') return { ...ctx, modes: { ...ctx.modes, 'creator.rates': 'edit' } };
  return ctx;
}

export const seesEverything = (ctx: FieldContext) => Object.values(ctx.modes).every((m) => m !== 'hidden') && ctx.hiddenCustom.size === 0;

export const canSee = (ctx: FieldContext | undefined, field: string) => !ctx || ctx.modes[field] !== 'hidden';

/** A copy of `value` without the fields this person may not see. Returns the same object when nothing is hidden. */
export function redact<T>(value: T, ctx: FieldContext): T {
  if (seesEverything(ctx)) return value;
  const hidden = Object.entries(FIELD_MATCHERS).filter(([k]) => ctx.modes[k] === 'hidden');
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 14 || v === null || typeof v !== 'object') return v;
    if (v instanceof Date || Buffer.isBuffer(v)) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1)).filter((x, i) => !(x === null && v[i] !== null));
    const o = v as Obj;
    const out: Obj = {};
    for (const [k, val] of Object.entries(o)) {
      if (hidden.some(([, m]) => m.read(k, o))) {
        // A person always sees their own contact details.
        if (k === 'phone' && ctx.selfId && o.id === ctx.selfId) out[k] = val;
        continue;
      }
      if (k === 'customFields' && val && typeof val === 'object' && !Array.isArray(val) && ctx.hiddenCustom.size) {
        out[k] = Object.fromEntries(Object.entries(val as Obj).filter(([ck]) => !ctx.hiddenCustom.has(ck)));
        continue;
      }
      // Custom field record views send { entity, fields: [...], values: { key: value } }.
      if (k === 'values' && val && typeof val === 'object' && !Array.isArray(val) && ctx.hiddenCustom.size && 'fields' in o && 'entity' in o) {
        out[k] = Object.fromEntries(Object.entries(val as Obj).filter(([ck]) => !ctx.hiddenCustom.has(ck)));
        continue;
      }
      // Custom field panels and definitions send [{ key, label, type, value? }].
      if (ctx.hiddenCustom.size && typeof o.key === 'string' && ctx.hiddenCustom.has(o.key) && ('value' in o ? 'label' in o || 'type' in o : 'label' in o && 'type' in o && 'entity' in o)) return null;
      out[k] = walk(val, depth + 1);
    }
    return out;
  };
  return walk(value, 0) as T;
}

/** The first protected field this request body tries to change without permission, or null. */
export function blockedWrite(body: unknown, path: string, ctx: FieldContext, method = 'PATCH'): string | null {
  if (!body || typeof body !== 'object') return null;
  const keys = new Set<string>();
  const custom = new Set<string>();
  const collect = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => collect(x, depth + 1));
    for (const [k, val] of Object.entries(v as Obj)) {
      keys.add(k);
      if (k === 'customFields' && val && typeof val === 'object') Object.keys(val as Obj).forEach((ck) => custom.add(ck));
      collect(val, depth + 1);
    }
  };
  collect(body, 0);
  // Custom field panels save { values: { key: value } }.
  const values = (body as Obj).values;
  if (/custom-fields\/values\//.test(path) && values && typeof values === 'object') Object.keys(values as Obj).forEach((ck) => custom.add(ck));
  for (const [field, m] of Object.entries(FIELD_MATCHERS)) {
    if (ctx.modes[field] === 'edit') continue;
    if (m.writePath && !m.writePath.test(path)) continue;
    // A person may change their own phone number, and whoever adds a new person gives theirs.
    if (field === 'people.contact' && (/\/(me|profile)(\/|$)/.test(path) || (ctx.selfId && path.includes(`/${ctx.selfId}`)) || (method === 'POST' && /\/(people|org\/users|admin-org\/users)\/?$/.test(path)))) continue;
    const hit = m.writeKeys.find((k) => keys.has(k));
    if (hit) return PROTECTED_FIELDS.find((f) => f.key === field)?.label ?? field;
  }
  for (const k of custom) if (ctx.hiddenCustom.has(k) || ctx.readOnlyCustom.has(k)) return `the custom field “${k}”`;
  return null;
}
