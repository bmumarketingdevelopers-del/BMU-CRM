// v11 people: CSV import of team members (spec bulk_import). Each row goes through the normal add-person rules
// (roles HR may give, team required when the department has teams, manager, branch). Duplicates on email or mobile
// are flagged and can't be imported twice.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { normaliseIdentifier, PEOPLE_EMPLOYMENT_TYPES, peopleAddPersonSchema, type Me } from '@bmu/shared';
import { ActionsRegistry } from '../actions/registry.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PeopleActionsService } from './people-actions.service.js';
import { peopleCan, rolePolicy } from './people-access.js';

const lc = (s: string | undefined) => (s ?? '').trim().toLowerCase();
const employment = (s: string | undefined) => {
  const v = lc(s).replace(/[\s-]+/g, '_');
  if (['full_time', 'fulltime', 'ft', 'permanent', ''].includes(v)) return v ? 'full_time' : null;
  if (['intern', 'internship'].includes(v)) return 'intern';
  if (['contract', 'contractor', 'freelance'].includes(v)) return 'contract';
  return 'bad';
};

@Injectable()
export class PersonImport implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ActionsRegistry,
    private readonly people: PeopleActionsService,
  ) {}

  onModuleInit() {
    this.registry.registerImportEntity({
      entity: 'people',
      label: 'People',
      fields: [
        { key: 'name', label: 'Full name', required: true },
        { key: 'email', label: 'Email', required: true },
        { key: 'phone', label: 'Mobile', required: true, hint: '10-digit Indian mobile' },
        { key: 'role', label: 'Role', required: true, hint: 'Role name, e.g. Producer; separate extra roles with ;' },
        { key: 'department', label: 'Department', required: true },
        { key: 'team', label: 'Team or pod', required: false, hint: 'Needed when the department has teams' },
        { key: 'manager', label: 'Reports to', required: true, hint: 'Email or full name' },
        { key: 'branch', label: 'Branch', required: false, hint: "Defaults to the department's branch" },
        { key: 'joining_date', label: 'Joining date', required: true, hint: 'YYYY-MM-DD' },
        { key: 'employment_type', label: 'Employment type', required: true, hint: 'full-time, intern or contract' },
      ],
      sampleCsv: 'Full name,Email,Mobile,Role,Department,Team or pod,Reports to,Branch,Joining date,Employment type\nAsha Rao,asha.rao@example.com,9876543210,Producer,Creative / Design,,design.head@bmu.demo,,2026-11-02,full-time\n',
      canImport: (me) => peopleCan(me).import,
      validate: (me, rows) => this.validate(me, rows),
      commit: async (me, rows, ip) => {
        const resolved = await this.resolve(me, rows);
        const ids: string[] = [];
        for (const r of resolved) ids.push(await this.people.createPerson(me, peopleAddPersonSchema.parse(r.input), ip));
        return ids;
      },
    });
  }

  private async resolve(me: Me, rows: Record<string, string>[]) {
    const [roles, depts, branches, staff] = await Promise.all([
      this.prisma.role.findMany({ where: { orgId: me.orgId } }),
      this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null }, include: { teams: { where: { deletedAt: null } } } }),
      this.prisma.branch.findMany({ where: { orgId: me.orgId, deletedAt: null } }),
      this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' }, leftAt: null }, select: { id: true, name: true, email: true } }),
    ]);
    return rows.map((r) => {
      const roleNames = (r.role ?? '').split(/[;|]/).map(lc).filter(Boolean);
      const roleRows = roleNames.map((n) => roles.find((x) => lc(x.name) === n || lc(x.baseRole) === n.replace(/\s+/g, '_')) ?? null);
      const branch = r.branch ? (branches.find((b) => lc(b.name) === lc(r.branch) || lc(b.city) === lc(r.branch)) ?? null) : null;
      const deptMatches = depts.filter((d) => lc(d.name) === lc(r.department));
      const dept = (branch ? deptMatches.find((d) => d.branchId === branch.id) : null) ?? deptMatches[0] ?? null;
      const team = dept && r.team ? (dept.teams.find((t) => lc(t.name) === lc(r.team)) ?? null) : null;
      const manager = staff.find((s) => lc(s.email ?? '') === lc(r.manager)) ?? staff.find((s) => lc(s.name) === lc(r.manager)) ?? null;
      const emp = employment(r.employment_type);
      return {
        roleNames,
        roleRows,
        branch,
        dept,
        team,
        manager,
        emp,
        input: {
          name: (r.name ?? '').trim(),
          email: (r.email ?? '').trim().toLowerCase(),
          phone: (r.phone ?? '').trim(),
          roleIds: roleRows.filter((x) => !!x).map((x) => x!.id),
          departmentId: dept?.id ?? '',
          teamId: team?.id ?? null,
          managerId: manager?.id ?? '',
          branchId: branch?.id ?? dept?.branchId ?? '',
          joiningDate: (r.joining_date ?? '').trim(),
          employmentType: (emp && emp !== 'bad' ? emp : 'full_time') as (typeof PEOPLE_EMPLOYMENT_TYPES)[number],
          onboarding: { enabled: true, items: ['laptop', 'accounts', 'sop_reading', 'shadowing'] as ('laptop' | 'accounts' | 'sop_reading' | 'shadowing')[] },
          sendInvite: true,
        },
      };
    });
  }

  private async validate(me: Me, rows: Record<string, string>[]) {
    const resolved = await this.resolve(me, rows);
    const out: { errors: string[]; duplicate: string | null }[] = [];
    for (const [i, r] of resolved.entries()) {
      const raw = rows[i];
      const errors: string[] = [];
      if (raw.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.email.trim())) errors.push('Email does not look right');
      if (raw.phone && !/^(\+?91)?[6-9]\d{9}$/.test(raw.phone.replace(/[\s-]/g, ''))) errors.push('Mobile must be a 10-digit Indian number');
      r.roleNames.forEach((n, j) => {
        const role = r.roleRows[j];
        if (!role) errors.push(`Unknown role "${n}"`);
        else {
          const p = rolePolicy(me, role.baseRole, 'add');
          if (!p.ok) errors.push(p.whyNot ?? `You can't give the ${role.name} role`);
          else if (p.needsFounder) errors.push(`${role.name}: add Branch Managers one by one (the Founder approves)`);
        }
      });
      if (raw.branch && !r.branch) errors.push(`Unknown branch "${raw.branch}"`);
      if (raw.department && !r.dept) errors.push(`Unknown department "${raw.department}"`);
      if (r.dept && r.branch && r.dept.branchId !== r.branch.id) errors.push(`${r.dept.name} is not in the ${r.branch.name} branch`);
      if (r.dept && r.dept.teams.length && !r.team) errors.push(raw.team ? `${r.dept.name} has no team called "${raw.team}"` : `Pick a team or pod in ${r.dept.name}`);
      if (raw.manager && !r.manager) errors.push(`Nobody active matches "${raw.manager}"`);
      if (raw.joining_date && (!/^\d{4}-\d{2}-\d{2}$/.test(raw.joining_date.trim()) || Number.isNaN(Date.parse(raw.joining_date)))) errors.push('Joining date must look like 2026-11-02');
      if (r.emp === 'bad') errors.push('Employment type must be full-time, intern or contract');
      let duplicate: string | null = null;
      const email = raw.email?.includes('@') ? normaliseIdentifier(raw.email) : null;
      const phone = raw.phone && raw.phone.replace(/\D/g, '').length >= 10 ? normaliseIdentifier(raw.phone) : null;
      if (email || phone) {
        const clash = await this.prisma.user.findFirst({ where: { orgId: me.orgId, OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] }, select: { name: true, email: true } });
        if (clash) {
          duplicate = `${clash.name} already uses this ${clash.email === email ? 'email' : 'mobile number'}`;
          errors.push(`Already on the team: ${clash.name}`);
        }
      }
      out.push({ errors, duplicate });
    }
    return out;
  }
}
