// One-off: makes the live database hold ONLY the BMU hierarchy below (plus the owner's own login and the system
// setup the CRM needs: roles, services and prices, workflow / QC templates, SOPs). Everything else is removed.
//   node --env-file=.env scripts/reset-to-hierarchy.mjs            dry run: does it all, reports, then rolls back
//   node --env-file=.env scripts/reset-to-hierarchy.mjs --apply    the same, and keeps the changes
// One transaction; it checks every link in the database before committing and rolls back if any is broken.
// No emails are sent: people are written straight to the database. Emails end in .test, which never reaches an inbox.
import pg from 'pg';
import { randomBytes } from 'node:crypto';

const APPLY = process.argv.includes('--apply');
const OWNER_EMAIL = 'bmumarketingpaidtools@gmail.com';
const DOMAIN = 'demobmu.test';
const today = new Date().toISOString().slice(0, 10);
const newId = () => `c${randomBytes(12).toString('hex')}`;

// Branches (existing rows are renamed so their working hours stay) and departments.
const BRANCHES = { Bengaluru: 'Bengaluru HQ', Mumbai: 'Mumbai Studio' }; // new name: old name
const DEPARTMENTS = [
  // name, branch, old departments whose templates / SOPs move here
  ['HR', 'Bengaluru', ['HR / Ops']],
  ['UI/UX', 'Bengaluru', ['Creative / Design']],
  ['SDE', 'Bengaluru', ['Web / AI']],
  ['Digital Marketing', 'Bengaluru', ['SEO', 'Video / Production', 'Insta-pods', 'Performance Ads', 'Creator / UGC', 'Social Media', 'Video Production', 'Strategy']],
  ['Sales', 'Bengaluru', ['Sales']],
];
// [name, roles, department, branch, reports to, specialty, employment, leads team]
const PEOPLE = [
  ['Mukesh', ['founder'], null, 'Bengaluru', null],
  ['Mohith', ['founder'], null, 'Bengaluru', null],
  ['RajKumar', ['hr_ops', 'department_head'], 'HR', 'Bengaluru', 'Mukesh', null, 'full_time', 'HR Team'],
  ['Kavin', ['hr_ops'], 'HR', 'Bengaluru', 'RajKumar'],
  ['Neha', ['hr_ops'], 'HR', 'Bengaluru', 'RajKumar'],
  ['Deepan', ['hr_ops'], 'HR', 'Bengaluru', 'RajKumar'],
  ['Yuvaan Dev', ['admin'], null, 'Bengaluru', 'RajKumar'],
  ['Kaushik', ['admin'], null, 'Mumbai', 'RajKumar'],
  ['Tushara', ['department_head'], 'UI/UX', 'Bengaluru', 'Yuvaan Dev'],
  ['Harisha', ['producer'], 'UI/UX', 'Bengaluru', 'Tushara', 'ux_ui_designer', 'full_time', 'UI/UX Team'],
  ['Aathi', ['producer'], 'UI/UX', 'Bengaluru', 'Harisha', 'ux_ui_designer'],
  ['Srikanth', ['producer'], 'UI/UX', 'Bengaluru', 'Harisha', 'ux_ui_designer'],
  ['Prabha', ['department_head'], 'SDE', 'Bengaluru', 'Yuvaan Dev'],
  ['Vinod', ['producer'], 'SDE', 'Bengaluru', 'Prabha', 'developer', 'full_time', 'SDE Team'],
  ['Dhanush', ['producer'], 'SDE', 'Bengaluru', 'Vinod', 'developer'],
  ['Hariprasath', ['intern'], 'SDE', 'Bengaluru', 'Vinod', 'developer', 'intern'],
  ['Walter White', ['department_head'], 'Digital Marketing', 'Bengaluru', 'Yuvaan Dev'],
  ['Tamayadev', ['producer'], 'Digital Marketing', 'Bengaluru', 'Walter White', null],
  ['Sadhana', ['producer'], 'Digital Marketing', 'Bengaluru', 'Walter White', 'script_writer'],
  ['Lokeshwari', ['intern'], 'Digital Marketing', 'Bengaluru', 'Walter White', 'video_editor', 'intern'],
  ['Yathindra', ['intern'], 'Digital Marketing', 'Bengaluru', 'Walter White', 'video_editor', 'intern'],
  ['Gustavo Fring', ['department_head', 'sales_manager'], 'Sales', 'Bengaluru', 'Yuvaan Dev'],
  ['Akash', ['sales_executive'], 'Sales', 'Bengaluru', 'Gustavo Fring', null, 'full_time', 'Sales Team'],
  ['Tara', ['sales_executive'], 'Sales', 'Bengaluru', 'Akash'],
  ['Lingesh', ['sales_executive'], 'Sales', 'Bengaluru', 'Akash'],
];
const HEADS = { HR: 'RajKumar', 'UI/UX': 'Tushara', SDE: 'Prabha', 'Digital Marketing': 'Walter White', Sales: 'Gustavo Fring' };
const emailOf = (name) => `${name.toLowerCase().replace(/\s+/g, '.')}@${DOMAIN}`;

// System setup the CRM needs: kept as it is (departmentId links are moved to the new departments).
const KEEP_WHOLE = ['_prisma_migrations', 'roles', 'permissions', 'services', 'service_tiers', 'price_books', 'add_ons', 'bundles', 'flow_templates', 'checklist_templates', 'sops', 'organisations', 'branches', 'departments'];
// The owner's own login and its security records.
const OWNER_ROWS = { users: 'id', user_roles: 'userId', user_sessions: 'userId', passkeys: 'userId', user_totp: 'userId', push_tokens: 'userId' };

const c = new pg.Client({ connectionString: process.env.DIRECT_DATABASE_URL });
await c.connect();
const q = (s, p) => c.query(s, p).catch((e) => { e.message += ` | in: ${s.slice(0, 160)}`; throw e; });
const report = [];
try {
  await q('begin');
  await q(`set local session_replication_role = replica`); // links checked below, before committing
  const org = (await q(`select id from organisations`)).rows;
  if (org.length !== 1) throw new Error(`Expected one organisation, found ${org.length}`);
  const orgId = org[0].id;
  const owner = (await q(`select id from users where email = $1`, [OWNER_EMAIL])).rows[0];
  if (!owner) throw new Error('Owner login not found');
  const roleIds = Object.fromEntries((await q(`select "baseRole", id from roles where "isCustom" = false`)).rows.map((r) => [r.baseRole, r.id]));

  // 1. Empty everything that is not system setup, keeping only the owner's login.
  const tables = (await q(`select tablename from pg_tables where schemaname = 'public' order by 1`)).rows.map((r) => r.tablename);
  for (const t of tables.filter((t) => !KEEP_WHOLE.includes(t))) {
    const res = t in OWNER_ROWS ? await q(`delete from "${t}" where "${OWNER_ROWS[t]}" <> $1`, [owner.id]) : t === 'otp_codes' ? await q(`delete from otp_codes where identifier <> $1`, [OWNER_EMAIL]) : await q(`delete from "${t}"`);
    if (res.rowCount) report.push({ table: t, removed: res.rowCount });
  }

  // 2. Branches: rename the two existing ones, drop any other.
  const branchId = {};
  for (const [name, old] of Object.entries(BRANCHES)) {
    const b = (await q(`update branches set name = $1, city = $1 where name = $2 returning id`, [name, old])).rows[0];
    branchId[name] = b ? b.id : (await q(`insert into branches (id, "orgId", name, city) values ($1, $2, $3, $3) returning id`, [newId(), orgId, name])).rows[0].id;
  }
  const delB = await q(`delete from branches where id <> all($1)`, [Object.values(branchId)]);
  if (delB.rowCount) report.push({ table: 'branches', removed: delB.rowCount });

  // 3. Departments: create the new ones, move templates and SOPs over, drop the old ones.
  const oldDepts = (await q(`select id, name from departments`)).rows;
  // Names are unique per branch: move the old ones aside first (they are deleted below).
  await q(`update departments set name = name || ' (old ' || id || ')'`);
  const deptId = {};
  for (const [name, branch, from] of DEPARTMENTS) {
    deptId[name] = newId();
    await q(`insert into departments (id, "orgId", "branchId", name) values ($1, $2, $3, $4)`, [deptId[name], orgId, branchId[branch], name]);
    const ids = oldDepts.filter((d) => from.includes(d.name)).map((d) => d.id);
    for (const t of ['flow_templates', 'checklist_templates', 'sops']) await q(`update "${t}" set "departmentId" = $1 where "departmentId" = any($2)`, [deptId[name], ids]);
  }
  const orphanSops = await q(`delete from sops where "departmentId" = any($1)`, [oldDepts.map((d) => d.id)]);
  if (orphanSops.rowCount) report.push({ table: 'sops', removed: orphanSops.rowCount, note: 'for departments that no longer exist (QC, Client Management)' });
  await q(`update checklist_templates set "departmentId" = null where "departmentId" = any($1)`, [oldDepts.map((d) => d.id)]);
  const orphanFlows = await q(`delete from flow_templates where "departmentId" = any($1)`, [oldDepts.map((d) => d.id)]);
  if (orphanFlows.rowCount) report.push({ table: 'flow_templates', removed: orphanFlows.rowCount });
  const delD = await q(`delete from departments where id = any($1)`, [oldDepts.map((d) => d.id)]);
  report.push({ table: 'departments', removed: delD.rowCount, added: DEPARTMENTS.length });

  // 4. People, in order so each manager exists before their reports.
  const userId = {};
  for (const [name, roles, dept, branch, manager, specialty = null, employment = 'full_time'] of PEOPLE) {
    userId[name] = newId();
    await q(
      `insert into users (id, "orgId", type, name, email, status, "managerId", "departmentId", "branchId", specialty, "employmentType", "joiningDate", "createdAt", "updatedAt")
       values ($1, $2, 'staff', $3, $4, 'active', $5, $6, $7, $8, $9, $10::date, now(), now())`,
      [userId[name], orgId, name, emailOf(name), manager ? userId[manager] : null, dept ? deptId[dept] : null, branchId[branch], specialty, employment, today],
    );
    for (const r of roles) {
      if (!roleIds[r]) throw new Error(`Role ${r} not found`);
      await q(`insert into user_roles ("userId", "roleId") values ($1, $2)`, [userId[name], roleIds[r]]);
    }
  }
  // Teams with their leads; members are the lead and the people in the same department who report to them.
  for (const [name, , dept, , , , , team] of PEOPLE) {
    if (!team) continue;
    const id = newId();
    await q(`insert into teams (id, "orgId", "departmentId", name, "leadUserId") values ($1, $2, $3, $4, $5)`, [id, orgId, deptId[dept], team, userId[name]]);
    await q(`update users set "teamId" = $1 where (id = $2 or "managerId" = $2) and "departmentId" = $3`, [id, userId[name], deptId[dept]]);
  }
  for (const [dept, head] of Object.entries(HEADS)) await q(`update departments set "headUserId" = $1 where id = $2`, [userId[head], deptId[dept]]);
  report.push({ table: 'users', added: PEOPLE.length, note: '+ the owner login kept' });

  // 5. Company settings: drop the demo's fake GST / bank details, cash-flow figures and sales target.
  await q(`update organisations set settings = jsonb_set(settings::jsonb, '{v8}', coalesce(settings::jsonb -> 'v8', '{}'::jsonb) - 'gst' - 'cashflow' - 'forecast')`);

  // Checks: every enforced link and every "who" column points at something that exists.
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
    const n = (await q(`select count(*)::int n from ${f.src} s where ${notNull} and not exists (select 1 from ${f.dst} d where ${match})`)).rows[0].n;
    if (n) console.log(`broken: ${f.src}.${f.cols} → ${f.dst} (${n})`);
    broken += n;
  }
  const personCols = (await q(`select table_name t, column_name col from information_schema.columns where table_schema = 'public' and data_type = 'text' and column_name ~ '(userId|UserId|managerId|ownerId|ById|actorId|leadUserId|headUserId)$'`)).rows;
  for (const { t, col } of personCols) {
    const n = (await q(`select count(*)::int n from "${t}" where "${col}" is not null and "${col}" not in (select id from users)`)).rows[0].n;
    if (n) console.log(`broken: ${t}.${col} names a missing person (${n})`);
    broken += n;
  }
  if (broken) throw new Error(`${broken} broken link(s); nothing was changed`);

  console.table(report);
  console.table(
    (await q(`select u.name, u.email, string_agg(r.name, ' + ') roles, d.name dept, b.name branch, m.name reports_to, t.name team
      from users u left join user_roles ur on ur."userId" = u.id left join roles r on r.id = ur."roleId" left join departments d on d.id = u."departmentId"
      left join branches b on b.id = u."branchId" left join users m on m.id = u."managerId" left join teams t on t.id = u."teamId"
      group by u.id, d.name, b.name, m.name, t.name order by u."createdAt"`)).rows,
  );
  console.table((await q(`select b.name branch, d.name department, h.name head from departments d join branches b on b.id = d."branchId" left join users h on h.id = d."headUserId" order by 1, 2`)).rows);
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
