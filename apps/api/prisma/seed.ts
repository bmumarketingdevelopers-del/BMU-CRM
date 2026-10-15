// Seeds the BMU tenant, hierarchy, roles + permission matrix and the 2026 catalogue
// from catalogue_seed in the spec. Runs before every `pnpm dev`, so it only creates
// what's missing and never overwrites changes made in the admin panel.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  CAPABILITIES,
  DEFAULT_FLOWS,
  DEFAULT_QC_CHECKLISTS,
  DEPARTMENTS,
  TIERS,
  addWorkingDays,
  accessRule,
  catalogueSeed,
  hierarchyData,
  rupeesToPaise,
  scopeFromRule,
  type RoleId,
} from '@bmu/shared';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { generateProductionTasks } from '../src/production/generate.js';
import { seedInsights } from './seed/insights.js';
import { seedAdminOrg } from './seed/admin-org.js';
import { seedAdminPlatform } from './seed/admin-platform.js';
import { seedWorkspace } from './seed/workspace.js';
import { seedFlows } from './seed/flows.js';
import { seedOpsAnalytics } from './seed/ops-analytics.js';
import { seedAnalytics } from './seed/analytics.js';
import { seedAutomations } from './seed/automations.js';
import { seedSell } from './seed/sell.js';
import { seedService } from './seed/service.js';
import { seedDeliver } from './seed/deliver.js';
import { seedCraft } from './seed/craft.js';
import { seedAi } from './seed/ai.js';
import { seedTeam } from './seed/team.js';
import { seedCreative } from './seed/creative.js';
import { seedComms } from './seed/comms.js';
import { seedFinance } from './seed/finance.js';
import { sameDept } from './seed/dept-names.js';

// Demo people, clients and history are added in development, on a database on this computer only. A live database
// (NODE_ENV=production, SEED_DEMO=0, or any database that is not on localhost, e.g. Supabase) gets only the
// organisation, departments, roles and permissions, the catalogue, templates, settings and the owner login.
// SEED_DEMO=1 forces demo data even on a remote database (never do that on the live one).
const dbHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
})();
const LOCAL_DB = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(dbHost);
const DEMO = process.env.SEED_DEMO ? process.env.SEED_DEMO === '1' : process.env.NODE_ENV !== 'production' && LOCAL_DB;
if (!DEMO && !LOCAL_DB && process.env.SEED_DEMO !== '0') console.log(`Database at ${dbHost} is not on this computer: no demo data is added.`);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Demo accounts for development sign-in (emails end in .demo). [name, email, base role, department, manager email]
const DEMO_STAFF: [string, string, string, string | null, string | null][] = [
  ['Founder', 'founder@bmu.demo', 'founder', null, null],
  ['Asha Reddy', 'admin@bmu.demo', 'admin', 'HR / Ops', 'founder@bmu.demo'],
  ['Rahul Menon', 'sales.manager@bmu.demo', 'sales_manager', 'Sales', 'admin@bmu.demo'],
  ['Priya Shah', 'sales@bmu.demo', 'sales_executive', 'Sales', 'sales.manager@bmu.demo'],
  ['Kiran Rao', 'am.lead@bmu.demo', 'am_lead', 'Client Management', 'admin@bmu.demo'],
  ['Neha Iyer', 'am@bmu.demo', 'account_manager', 'Client Management', 'am.lead@bmu.demo'],
  ['Rohan Gupta', 'strategist@bmu.demo', 'strategist', 'Strategy', 'am.lead@bmu.demo'],
  ['Arjun Das', 'design.head@bmu.demo', 'department_head', 'Creative / Design', 'admin@bmu.demo'],
  ['Meera Nair', 'producer@bmu.demo', 'producer', 'Creative / Design', 'design.head@bmu.demo'],
  ['Vikram Joshi', 'qc@bmu.demo', 'qc_reviewer', 'QC', 'admin@bmu.demo'],
  ['Divya Pillai', 'finance@bmu.demo', 'finance', 'Finance', 'admin@bmu.demo'],
  ['Sana Khan', 'hr@bmu.demo', 'hr_ops', 'HR / Ops', 'admin@bmu.demo'],
];

async function main() {
  const org =
    (await prisma.organisation.findFirst({ where: { name: 'BMU Marketing' } })) ??
    (await prisma.organisation.create({ data: { name: 'BMU Marketing' } }));

  const branch =
    (await prisma.branch.findFirst({ where: { orgId: org.id, name: 'Bengaluru HQ' } })) ??
    (await prisma.branch.create({ data: { orgId: org.id, name: 'Bengaluru HQ', city: 'Bengaluru' } }));

  // "Account Management" was renamed "Client Management": rename the old row so older databases keep one department.
  if ((DEPARTMENTS as readonly string[]).includes('Client Management')) {
    const old = await prisma.department.findFirst({ where: { branchId: branch.id, name: 'Account Management' } });
    const renamed = await prisma.department.findFirst({ where: { branchId: branch.id, name: 'Client Management' } });
    if (old && !renamed) await prisma.department.update({ where: { id: old.id }, data: { name: 'Client Management' } });
  }
  for (const name of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { branchId_name: { branchId: branch.id, name } },
      update: {},
      create: { orgId: org.id, branchId: branch.id, name },
    });
  }

  const allRoles = [...hierarchyData.team_roles, ...hierarchyData.client_roles];
  for (const r of allRoles) {
    const role = await prisma.role.upsert({
      where: { orgId_name: { orgId: org.id, name: r.name } },
      update: {},
      create: { orgId: org.id, name: r.name, baseRole: r.id },
    });
    for (const capability of CAPABILITIES) {
      const rule = accessRule(capability, r.id as RoleId);
      await prisma.permission.upsert({
        where: { roleId_capability: { roleId: role.id, capability } },
        update: {},
        create: { roleId: role.id, capability, rule, scope: scopeFromRule(rule) },
      });
    }
  }

  // Earlier seeds used founder@bmu.marketing; move it to the demo address.
  if (DEMO) await prisma.user.updateMany({ where: { orgId: org.id, email: 'founder@bmu.marketing' }, data: { email: 'founder@bmu.demo' } });

  const departments = await prisma.department.findMany({ where: { branchId: branch.id } });
  const deptId = (name: string | null) => (name ? departments.find((d) => sameDept(d.name, name))?.id : undefined);
  const roles = await prisma.role.findMany({ where: { orgId: org.id, isCustom: false } });
  const roleId = (base: string) => roles.find((r) => r.baseRole === base)!.id;
  const userIds = new Map<string, string>();

  // The business owner's own login (OWNER_EMAIL in apps/api/.env), created as a Founder.
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!DEMO && !ownerEmail) throw new Error('Set OWNER_EMAIL (your own email) before seeding a live database: it becomes the Founder login.');
  const owner = ownerEmail ? [['BMU Owner', ownerEmail, 'founder', null, null] as (typeof DEMO_STAFF)[number]] : [];
  const staff = [...(DEMO ? DEMO_STAFF : []), ...owner];
  for (const [name, email, base, dept, managerEmail] of staff) {
    const user = await prisma.user.upsert({
      where: { orgId_email: { orgId: org.id, email } },
      update: {},
      create: {
        orgId: org.id,
        type: 'staff',
        name,
        email,
        status: 'active',
        branchId: branch.id,
        departmentId: deptId(dept),
        managerId: managerEmail ? userIds.get(managerEmail) : undefined,
      },
    });
    userIds.set(email, user.id);
    await prisma.userRole.upsert({
      where: { userId_roleId_scopeRef: { userId: user.id, roleId: roleId(base), scopeRef: '' } },
      update: {},
      create: { userId: user.id, roleId: roleId(base) },
    });
  }

  // The catalogue is seeded once. Later price changes create new price book versions in the admin panel.
  if (await prisma.priceBook.findFirst({ where: { orgId: org.id } })) {
    console.log('Catalogue already present; leaving price books as they are.');
  } else {
    await seedCatalogue(org.id);
  }

  const settings = (org.settings ?? {}) as Record<string, unknown>;
  // proposal_price_override: maximum extra discount (%) each role may give without Founder approval.
  settings.discountLimits ??= { sales_manager: 10, admin: 20 };
  // Government holidays (no working time). Editable later under Holidays & Working Hours.
  settings.holidays ??= ['2026-01-26', '2026-05-01', '2026-08-15', '2026-10-02', '2026-11-01', '2026-12-25'];
  await prisma.organisation.update({ where: { id: org.id }, data: { settings: settings as object } });

  // Department flows and QC checklists (editable under Admin → Templates).
  for (const f of DEFAULT_FLOWS) {
    if (await prisma.flowTemplate.findFirst({ where: { orgId: org.id, key: f.key } })) continue;
    const dept = departments.find((d) => sameDept(d.name, f.department)) ?? departments[0];
    await prisma.flowTemplate.create({
      data: { orgId: org.id, departmentId: dept.id, key: f.key, name: f.name, deliverableTypes: f.deliverableTypes, steps: f.steps },
    });
  }
  const qcDept = departments.find((d) => d.name === 'QC');
  for (const c of DEFAULT_QC_CHECKLISTS) {
    if (await prisma.checklistTemplate.findFirst({ where: { orgId: org.id, kind: 'qc', key: c.key } })) continue;
    await prisma.checklistTemplate.create({ data: { orgId: org.id, kind: 'qc', key: c.key, name: c.name, items: c.items, departmentId: qcDept?.id } });
  }

  // Settings defaults, SOPs and proposal requirements (configuration, not demo data).
  await seedAdminPlatform(prisma, org.id);

  if (!DEMO) {
    console.log(`Seeded ${org.name} for live use: ${DEPARTMENTS.length} departments, ${allRoles.length} roles, catalogue, templates and the owner login (${ownerEmail}). No demo data.`);
    return;
  }

  const amDept = departments.find((d) => sameDept(d.name, 'Client Management'))!;
  if (!(await prisma.team.findFirst({ where: { departmentId: amDept.id, name: 'Pod A' } }))) {
    const pod = await prisma.team.create({
      data: { orgId: org.id, departmentId: amDept.id, name: 'Pod A', leadUserId: userIds.get('am@bmu.demo') },
    });
    await prisma.user.updateMany({
      where: { id: { in: ['am@bmu.demo', 'strategist@bmu.demo'].map((e) => userIds.get(e)!) } },
      data: { teamId: pod.id },
    });
  }

  // Demo client with an owner who can sign in to the client app.
  const client =
    (await prisma.clientOrg.findFirst({ where: { orgId: org.id, name: 'Sunrise Realty Pvt Ltd' } })) ??
    (await prisma.clientOrg.create({
      data: {
        orgId: org.id,
        name: 'Sunrise Realty Pvt Ltd',
        industry: 'Real estate',
        amUserId: userIds.get('am@bmu.demo'),
        tenureStart: new Date('2026-09-01'),
        brands: { create: { orgId: org.id, name: 'Sunrise Heights', location: 'Whitefield, Bengaluru' } },
      },
    }));
  const clientOwner = await prisma.user.upsert({
    where: { orgId_email: { orgId: org.id, email: 'client@sunrise.demo' } },
    update: {},
    create: { orgId: org.id, type: 'client', name: 'Anil Kumar', email: 'client@sunrise.demo', status: 'active' },
  });
  await prisma.clientUser.upsert({
    where: { userId: clientOwner.id },
    update: {},
    create: { userId: clientOwner.id, orgId: org.id, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId_scopeRef: { userId: clientOwner.id, roleId: roleId('client_owner'), scopeRef: '' } },
    update: {},
    create: { userId: clientOwner.id, roleId: roleId('client_owner') },
  });

  if ((await prisma.lead.count({ where: { orgId: org.id } })) < 3) {
    const sales = userIds.get('sales@bmu.demo');
    const demoLeads = [
      { name: 'Kavya Bakery', need: 'Instagram growth and a new logo', stage: 'new', budget: 30000, services: ['smm', 'logo_brand_kit'], owner: undefined },
      { name: 'Greenfield Schools', need: 'Admissions campaign with Google Ads', stage: 'contacted', budget: 75000, services: ['digital_marketing', 'seo'], owner: sales },
      { name: 'Urban Nest Interiors', need: 'Website and Google Business Profile', stage: 'discovery', budget: 120000, services: ['website', 'gbp', 'seo', 'smm'], owner: sales },
      { name: 'Prakash Motors', need: 'Showroom video shoot', stage: 'proposal_sent', budget: 50000, services: ['business_video_shoot'], owner: userIds.get('sales.manager@bmu.demo') },
    ] as const;
    for (const l of demoLeads) {
      await prisma.lead.create({
        data: {
          orgId: org.id,
          source: 'website',
          contact: { name: l.name, email: `hello@${l.name.toLowerCase().replace(/\W+/g, '')}.demo`, phone: '+919876543210', company: l.name },
          need: l.need,
          stage: l.stage,
          budgetPaise: rupeesToPaise(l.budget),
          serviceIds: [...l.services],
          score: 40,
          ownerId: l.owner,
        },
      });
    }
  }

  // Demo engagement so the demo client and CM have onboarding to try.
  if ((await prisma.engagement.count({ where: { clientOrgId: client.id } })) === 0) {
    const smm = await prisma.service.findFirstOrThrow({ where: { key: 'smm', priceBook: { orgId: org.id, status: 'active' } } });
    const amId = userIds.get('am@bmu.demo');
    await prisma.engagement.create({
      data: {
        orgId: org.id,
        clientOrgId: client.id,
        serviceId: smm.id,
        tier: 'growth',
        billingType: 'monthly',
        status: 'onboarding',
        amId,
        startDate: new Date(),
        cycles: {
          create: {
            orgId: org.id,
            period: new Date().toISOString().slice(0, 7),
            requirements: {
              create: [
                { orgId: org.id, label: 'Business details questionnaire', type: 'info', ownerId: amId, status: 'received' },
                { orgId: org.id, label: 'Logo, brand guidelines and fonts', type: 'asset', ownerId: amId },
                { orgId: org.id, label: 'Social media account access', type: 'access', ownerId: amId },
                { orgId: org.id, label: 'At least 10 reference videos', type: 'asset', ownerId: amId },
              ],
            },
          },
        },
      },
    });
    if (!(await prisma.thread.findFirst({ where: { clientOrgId: client.id } }))) {
      await prisma.thread.create({ data: { orgId: org.id, clientOrgId: client.id, type: 'client_am' } });
    }
  }

  // Demo project already in production, so tasks, QC and the Review Studio have something to show.
  const logo = await prisma.service.findFirst({ where: { key: 'logo_brand_kit', priceBook: { orgId: org.id, status: 'active' } } });
  if (logo && !(await prisma.engagement.findFirst({ where: { clientOrgId: client.id, serviceId: logo.id } }))) {
    const holidays = (settings.holidays as string[]) ?? [];
    const rcdAt = new Date(Date.now() - 5 * 86_400_000);
    const engagement = await prisma.engagement.create({
      data: {
        orgId: org.id,
        clientOrgId: client.id,
        serviceId: logo.id,
        tier: 'growth',
        billingType: 'one_time',
        status: 'in_production',
        currentGate: 'G3',
        amId: userIds.get('am@bmu.demo'),
        startDate: rcdAt,
        cycles: {
          create: {
            orgId: org.id,
            period: 'project',
            rcdAt,
            planningDue: addWorkingDays(rcdAt, 4, holidays),
            status: 'production',
            requirements: {
              create: [
                { orgId: org.id, label: 'Business details questionnaire', type: 'info', status: 'received' },
                { orgId: org.id, label: 'Brand references you like', type: 'asset', status: 'received' },
              ],
            },
          },
        },
      },
      include: { cycles: true },
    });
    const cycle = engagement.cycles[0];
    const deliverables = [
      { type: 'post', title: 'Logo concepts' },
      { type: 'other', title: 'Brand guidelines PDF' },
    ];
    await prisma.plan.create({
      data: {
        orgId: org.id,
        cycleId: cycle.id,
        status: 'approved',
        approvedById: clientOwner.id,
        approvedAt: new Date(),
        content: {
          objectives: 'A modern, trustworthy identity for Sunrise Heights.',
          audience: 'Home buyers in East Bengaluru',
          pillars: ['Trust', 'Modern living'],
          creativeDirection: 'Clean geometric mark, warm sunrise palette.',
          deliverables,
        },
      },
    });
    await prisma.approval.create({ data: { orgId: org.id, targetType: 'plan', targetId: cycle.id, gate: 'G2', userId: clientOwner.id } });
    for (const d of deliverables) await prisma.deliverable.create({ data: { orgId: org.id, cycleId: cycle.id, ...d } });
    await generateProductionTasks(prisma, cycle.id);
  }

  // v8 area demo data (each idempotent).
  await seedAdminOrg(prisma, org.id);
  await seedWorkspace(prisma, org.id);
  await seedInsights(prisma, org.id);
  await seedFlows(prisma, org.id);
  await seedOpsAnalytics(prisma, org.id);
  await seedAnalytics(prisma, org.id);
  await seedAutomations(prisma, org.id);
  await seedSell(prisma, org.id);
  await seedService(prisma, org.id);
  await seedDeliver(prisma, org.id);
  await seedCraft(prisma, org.id);
  await seedAi(prisma, org.id);
  await seedTeam(prisma, org.id);
  await seedCreative(prisma, org.id);
  await seedComms(prisma, org.id);
  await seedFinance(prisma, org.id);

  console.log(
    `Seeded ${org.name}: ${DEPARTMENTS.length} departments, ${allRoles.length} roles, ${DEMO_STAFF.length + 1} demo users.`,
  );
}

async function seedCatalogue(orgId: string) {
  const org = { id: orgId };
  const priceBook = await prisma.priceBook.create({
    data: {
      orgId,
      version: catalogueSeed.edition,
      effectiveFrom: new Date(`${catalogueSeed.edition}-01-01`),
      status: 'active',
    },
  });

  for (const s of catalogueSeed.services) {
    const service = await prisma.service.upsert({
      where: { priceBookId_key: { priceBookId: priceBook.id, key: s.id } },
      update: {},
      create: {
        orgId: org.id,
        priceBookId: priceBook.id,
        key: s.id,
        name: s.name,
        track: s.track,
        billingType: s.billing_type,
        unit: 'unit' in s ? String(s.unit) : null,
        excludedNote: 'excluded_note' in s ? s.excluded_note : null,
      },
    });
    for (const tier of TIERS) {
      const withShoot = 'with_shoot_tiers' in s ? rupeesToPaise(s.with_shoot_tiers[tier]) : null;
      const data = {
        pricePaise: rupeesToPaise(s.tiers[tier]),
        isFromPrice: tier === 'premium' && s.premium_is_starting_price,
        withShootPricePaise: withShoot,
      };
      await prisma.serviceTier.upsert({
        where: { serviceId_tier: { serviceId: service.id, tier } },
        update: {},
        create: { serviceId: service.id, tier, ...data },
      });
    }
  }

  for (const b of catalogueSeed.bundles.items) {
    await prisma.bundle.upsert({
      where: { priceBookId_key: { priceBookId: priceBook.id, key: b.id } },
      update: {},
      create: {
        orgId: org.id,
        priceBookId: priceBook.id,
        key: b.id,
        name: b.name,
        serviceKeys: [...b.services],
        discountPct: catalogueSeed.bundles.discount_pct,
      },
    });
  }

  if ((await prisma.addOn.count({ where: { priceBookId: priceBook.id } })) === 0) await prisma.addOn.createMany({
    data: [
      ...catalogueSeed.priced_addons.map((a) => ({
        orgId: org.id,
        priceBookId: priceBook.id,
        name: a.name,
        pricePaise: rupeesToPaise(a.price),
        unit: 'unit' in a ? a.unit : null,
      })),
      ...catalogueSeed.custom_quote_addon_groups.map((name) => ({
        orgId: org.id,
        priceBookId: priceBook.id,
        name,
        isCustomQuote: true,
      })),
    ],
  });

  console.log(`Seeded catalogue ${catalogueSeed.edition}: ${catalogueSeed.services.length} services, ${catalogueSeed.bundles.items.length} bundles.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
