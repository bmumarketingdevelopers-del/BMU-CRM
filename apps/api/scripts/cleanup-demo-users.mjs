// One-off: removes the demo PEOPLE from the live database and keeps everything else (demo clients, leads, invoices,
// projects and tasks stay). Kept people: the real users plus the demo Founder and Admin.
//   node --env-file=.env scripts/cleanup-demo-users.mjs            dry run: does it all, reports, then rolls back
//   node --env-file=.env scripts/cleanup-demo-users.mjs --apply    the same, and keeps the changes
// For each record that names a removed person:
//   - their own records (attendance, timesheets, notifications, sessions…) are deleted with them;
//   - records they authored (messages, comments, QC reviews, uploads…) stay and are credited to the demo Founder;
//   - optional "who" fields (owner, assignee, approved by…) are cleared.
// One transaction; it checks every link in the database before committing and rolls back if any is broken.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const KEEP_EMAILS = ['bmumarketingpaidtools@gmail.com', 'harishaise2024@gmail.com', 'dhanushpugazhendhi19@gmail.com', 'founder@bmu.demo', 'admin@bmu.demo'];
const CREDIT_TO = 'founder@bmu.demo';
const HEADS = [['Creative / Design', 'harishaise2024@gmail.com']];

/** Records that belong to the person: deleted with them (table → person column). */
const PERSONAL = {
  attendance: 'userId',
  eod_reports: 'userId',
  time_entries: 'userId',
  timesheets: 'userId',
  leave_requests: 'userId',
  notifications: 'userId',
  thread_reads: 'userId',
  watchers: 'userId',
  user_sessions: 'userId',
  undo_entries: 'userId',
  booking_pages: 'userId',
  craft_hooks: 'userId',
  people_processes: 'userId',
  passkeys: 'userId',
  user_totp: 'userId',
  push_tokens: 'userId',
  creators: 'userId',
};
const PERSON_COL = /(userId|UserId|managerId|ownerId|buddyId|ById|actorId|LeadId|leadId|headId|responsibleId|approverId|assigneeId|amId|AmId|reviewerId|authorId|hostId|organizerId)$/;

const c = new pg.Client({ connectionString: process.env.DIRECT_DATABASE_URL });
await c.connect();
const q = (s, p) => c.query(s, p).catch((e) => { e.message += ` | in: ${s.slice(0, 160)}`; throw e; });
const deleted = [];
const changed = [];
try {
  await q('begin');
  const keep = (await q(`select id, email from users where email = any($1)`, [KEEP_EMAILS])).rows;
  if (keep.length !== KEEP_EMAILS.length) throw new Error(`Expected ${KEEP_EMAILS.length} people to keep, found ${keep.length}: ${keep.map((k) => k.email)}`);
  const keepIds = keep.map((k) => k.id);
  const creditId = keep.find((k) => k.email === CREDIT_TO).id;
  const gone = (await q(`select id, email from users where id <> all($1)`, [keepIds])).rows;
  const goneIds = gone.map((g) => g.id);
  const goneEmails = gone.map((g) => g.email).filter(Boolean);
  if (gone.some((g) => !/\.(demo|example)$/i.test(g.email ?? ''))) throw new Error(`Refusing: a person to remove has a real-looking email: ${gone.filter((g) => !/\.(demo|example)$/i.test(g.email ?? '')).map((g) => g.email)}`);

  // 1. Their own records.
  for (const [t, col] of Object.entries(PERSONAL)) {
    const exists = (await q(`select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2`, [t, col])).rowCount;
    if (!exists) continue;
    const r = await q(`delete from "${t}" where "${col}" = any($1)`, [goneIds]);
    if (r.rowCount) deleted.push({ table: t, why: `${col} is a removed person`, rows: r.rowCount });
  }
  const otp = await q(`delete from otp_codes where identifier = any($1)`, [goneEmails]);
  if (otp.rowCount) deleted.push({ table: 'otp_codes', why: 'sign-in codes of removed people', rows: otp.rowCount });

  // 2 and 3. Other columns that name a removed person (enforced links are left to the database's own rules).
  const fkCols = new Set(
    (await q(`select k.conrelid::regclass::text t, a.attname::text col from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1] where k.contype = 'f' and k.confrelid = 'public.users'::regclass`)).rows.map((r) => `${r.t}.${r.col}`),
  );
  const cols = (
    await q(`select table_name t, column_name col, is_nullable = 'YES' nullable, data_type dt from information_schema.columns where table_schema = 'public' and table_name <> 'users'`)
  ).rows.filter((r) => PERSON_COL.test(r.col) && !fkCols.has(`${r.t}.${r.col}`));
  for (const r of cols) {
    if (r.dt === 'ARRAY') {
      const u = await q(`update "${r.t}" set "${r.col}" = array(select x from unnest("${r.col}") x where x <> all($1)) where "${r.col}" && $1::text[]`, [goneIds]);
      if (u.rowCount) changed.push({ table: r.t, column: r.col, action: 'removed from list', rows: u.rowCount });
      continue;
    }
    const set = r.nullable ? 'null' : '$2';
    const u = await q(`update "${r.t}" set "${r.col}" = ${set} where "${r.col}" = any($1)`, r.nullable ? [goneIds] : [goneIds, creditId]);
    if (u.rowCount) changed.push({ table: r.t, column: r.col, action: r.nullable ? 'cleared' : 'credited to demo Founder', rows: u.rowCount });
  }

  // The people themselves (role and client-portal links go with them; owner / account manager links become empty).
  const du = await q(`delete from users where id = any($1)`, [goneIds]);
  deleted.push({ table: 'users', why: 'demo people', rows: du.rowCount });

  for (const [dept, email] of HEADS) {
    await q(`update departments set "headUserId" = (select id from users where email = $2) where name = $1`, [dept, email]);
    changed.push({ table: 'departments', column: 'headUserId', action: `${dept} → ${email}`, rows: 1 });
  }

  // Checks: every enforced link, and every person column, points at something that exists.
  const fks = (
    await q(`select k.conrelid::regclass::text src, k.confrelid::regclass::text dst, array_agg(a.attname::text order by x.n) cols, array_agg(b.attname::text order by x.n) refcols
      from pg_constraint k cross join lateral unnest(k.conkey, k.confkey) with ordinality as x(c, r, n)
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.c join pg_attribute b on b.attrelid = k.confrelid and b.attnum = x.r
      where k.contype = 'f' and k.connamespace = 'public'::regnamespace group by k.conname, k.conrelid, k.confrelid`)
  ).rows;
  let broken = 0;
  for (const f of fks) {
    const notNull = f.cols.map((col) => `s."${col}" is not null`).join(' and ');
    const match = f.cols.map((col, i) => `d."${f.refcols[i]}" = s."${col}"`).join(' and ');
    broken += (await q(`select count(*)::int n from ${f.src} s where ${notNull} and not exists (select 1 from ${f.dst} d where ${match})`)).rows[0].n;
  }
  for (const r of cols.filter((r) => r.dt !== 'ARRAY')) broken += (await q(`select count(*)::int n from "${r.t}" where "${r.col}" = any($1)`, [goneIds])).rows[0].n;
  if (broken) throw new Error(`${broken} broken link(s) would remain; nothing was changed`);

  const after = (await q(`select (select count(*) from users)::int people, (select count(*) from client_orgs)::int clients, (select count(*) from leads)::int leads, (select count(*) from invoices)::int invoices, (select count(*) from engagements)::int engagements, (select count(*) from tasks)::int tasks, (select count(*) from files)::int files`)).rows[0];
  console.log('Deleted:'); console.table(deleted);
  console.log('Changed:'); console.table(changed);
  console.log('After:', after, '| broken links: 0');
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
