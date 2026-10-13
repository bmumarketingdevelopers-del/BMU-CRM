// One-off: removes the demo data that `pnpm dev` re-seeded into the live database on 13 Oct 2026, keeping every real
// person (anyone whose email does not end in .demo / .example) and what they did since the hierarchy reset.
//   node --env-file=.env scripts/remove-reseeded-demo.mjs            dry run: does it all, reports, then rolls back
//   node --env-file=.env scripts/remove-reseeded-demo.mjs --apply    the same, and keeps the changes
// One transaction; every link in the database is checked before committing, and it rolls back if any is broken.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const RESET_AT = '2026-10-12 10:30:00'; // the hierarchy reset (UTC); real activity is after this
const KEEP_BRANCHES = ['Bengaluru', 'Mumbai'];
const DEMO_EMAIL = String.raw`\.(demo|example)$`;

// System setup the CRM needs, kept as it is.
const KEEP_WHOLE = ['_prisma_migrations', 'roles', 'permissions', 'services', 'service_tiers', 'price_books', 'add_ons', 'bundles', 'organisations'];
// Kept in part: {ids} = real people, {emails} = their emails.
const PARTIAL = {
  branches: `name = any({branches})`,
  departments: `"branchId" in (select id from branches)`,
  teams: `"departmentId" in (select id from departments)`,
  flow_templates: `"departmentId" in (select id from departments)`,
  checklist_templates: `"departmentId" is null or "departmentId" in (select id from departments)`,
  sops: `"departmentId" is null or "departmentId" in (select id from departments)`,
  users: `id = any({ids})`,
  user_roles: `"userId" = any({ids})`,
  user_sessions: `"userId" = any({ids})`,
  passkeys: `"userId" = any({ids})`,
  user_totp: `"userId" = any({ids})`,
  push_tokens: `"userId" = any({ids})`,
  otp_codes: `identifier = any({emails})`,
  people_processes: `"userId" = any({ids})`,
  leave_requests: `"userId" = any({ids})`,
  tasks: `"createdAt" > '${RESET_AT}' and ("ownerId" = any({ids}) or "createdById" = any({ids})) and "engagementId" is null and "deliverableId" is null`,
  notifications: `"createdAt" > '${RESET_AT}' and "userId" = any({ids})`,
  approval_requests: `"createdAt" > '${RESET_AT}' and "requestedById" = any({ids})`,
  audit_events: `at > '${RESET_AT}' and "actorId" = any({ids})`,
  email_outbox: `"createdAt" > '${RESET_AT}' and "toUserId" = any({ids})`,
};
const ORDER = ['branches', 'departments', 'teams', 'flow_templates', 'checklist_templates', 'sops', 'users'];

const c = new pg.Client({ connectionString: process.env.DIRECT_DATABASE_URL });
await c.connect();
const q = (s, p) => c.query(s, p).catch((e) => { e.message += ` | in: ${s.slice(0, 160)}`; throw e; });
const report = [];
try {
  await q('begin');
  await q(`set local session_replication_role = replica`);
  const real = (await q(`select id, email from users where email is null or email !~* $1`, [DEMO_EMAIL])).rows;
  const params = { ids: real.map((r) => r.id), emails: real.map((r) => r.email).filter(Boolean), branches: KEEP_BRANCHES };
  const missing = KEEP_BRANCHES.filter(async () => false);
  if (!real.length) throw new Error('No real people found');
  const tables = (await q(`select tablename from pg_tables where schemaname = 'public' order by 1`)).rows.map((r) => r.tablename);
  for (const t of [...ORDER, ...Object.keys(PARTIAL).filter((t) => !ORDER.includes(t))]) {
    if (!tables.includes(t)) throw new Error(`Table ${t} not found`);
    const vals = [];
    const where = PARTIAL[t].replace(/\{(\w+)\}/g, (_, k) => `$${vals.push(params[k])}::text[]`);
    const before = (await q(`select count(*)::int n from "${t}"`)).rows[0].n;
    const res = await q(`delete from "${t}" where not (${where})`, vals);
    report.push({ table: t, before, removed: res.rowCount, kept: before - res.rowCount });
  }
  for (const t of tables.filter((t) => !KEEP_WHOLE.includes(t) && !(t in PARTIAL))) {
    const res = await q(`delete from "${t}"`);
    if (res.rowCount) report.push({ table: t, before: res.rowCount, removed: res.rowCount, kept: 0 });
  }
  await q(`update organisations set settings = jsonb_set(settings::jsonb, '{v8}', coalesce(settings::jsonb -> 'v8', '{}'::jsonb) - 'gst' - 'cashflow' - 'forecast')`);
  void missing;

  // Kept rows that point at removed rows: clear the link when it may be empty, otherwise stop.
  const fks = (
    await q(`select k.conrelid::regclass::text src, k.confrelid::regclass::text dst, array_agg(a.attname::text order by x.n) cols, array_agg(b.attname::text order by x.n) refcols, bool_and(not a.attnotnull) nullable
      from pg_constraint k cross join lateral unnest(k.conkey, k.confkey) with ordinality as x(c, r, n)
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.c join pg_attribute b on b.attrelid = k.confrelid and b.attnum = x.r
      where k.contype = 'f' and k.connamespace = 'public'::regnamespace group by k.conname, k.conrelid, k.confrelid`)
  ).rows;
  const orphan = (f) => `from ${f.src} s where ${f.cols.map((col) => `s."${col}" is not null`).join(' and ')} and not exists (select 1 from ${f.dst} d where ${f.cols.map((col, i) => `d."${f.refcols[i]}" = s."${col}"`).join(' and ')})`;
  const cleared = [];
  for (const f of fks) {
    const n = (await q(`select count(*)::int n ${orphan(f)}`)).rows[0].n;
    if (!n) continue;
    if (!f.nullable) throw new Error(`${n} kept row(s) in ${f.src} need removed rows in ${f.dst} (${f.cols}); nothing was changed`);
    const where = orphan(f).replace(/^from (\S+) s where /, '').replace(/s\."/g, `${f.src}."`);
    await q(`update ${f.src} set ${f.cols.map((col) => `"${col}" = null`).join(', ')} where ${where}`);
    cleared.push({ table: f.src, column: f.cols.join(','), cleared: n });
  }
  const personCols = (
    await q(`select table_name t, column_name col from information_schema.columns where table_schema = 'public' and data_type = 'text' and table_name <> 'users'
      and column_name ~ '(userId|UserId|managerId|ownerId|buddyId|ById|actorId|LeadId|leadId|headId|responsibleId|approverId|assigneeId|amId|AmId|reviewerId|authorId|hostId)$'`)
  ).rows;
  for (const { t, col } of [...personCols, { t: 'users', col: 'managerId' }]) {
    const res = await q(`update "${t}" set "${col}" = null where "${col}" is not null and "${col}" not in (select id from users)`).catch(() => ({ rowCount: 0 }));
    if (res.rowCount) cleared.push({ table: t, column: col, cleared: res.rowCount });
  }
  let broken = 0;
  for (const f of fks) broken += (await q(`select count(*)::int n ${orphan(f)}`)).rows[0].n;
  for (const { t, col } of personCols) broken += (await q(`select count(*)::int n from "${t}" where "${col}" is not null and "${col}" not in (select id from users)`)).rows[0].n;
  if (broken) throw new Error(`${broken} broken link(s); nothing was changed`);

  console.table(report.filter((r) => r.removed || r.kept).sort((a, b) => b.removed - a.removed));
  if (cleared.length) console.log('Links cleared:'), console.table(cleared);
  console.log(
    'After:',
    (await q(`select (select count(*) from users)::int people, (select count(*) from users where email ~* $1)::int demo_people, (select count(*) from branches)::int branches, (select count(*) from departments)::int departments, (select count(*) from teams)::int teams, (select count(*) from client_orgs)::int clients, (select count(*) from leads)::int leads, (select count(*) from invoices)::int invoices, (select count(*) from tasks)::int tasks, (select count(*) from files)::int files, (select count(*) from approval_requests)::int approvals, (select count(*) from people_processes)::int onboardings`, [DEMO_EMAIL])).rows[0],
  );
  console.log('broken links: 0');
  if (APPLY) {
    await q('commit');
    console.log('APPLIED.');
  } else {
    await q('rollback');
    console.log('DRY RUN: nothing was changed. Run with --apply to keep these changes.');
  }
} catch (e) {
  await q('rollback').catch(() => undefined);
  console.error('Stopped, nothing was changed:', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
