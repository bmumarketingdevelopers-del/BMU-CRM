// Every Ask BMU page skill, in matching order (first keyword match wins among the tabs the person has).
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { Me } from '@bmu/shared';
import { z } from 'zod';
import type { CopilotTool, ToolOutput } from '../ai-tools.js';
import { SKILLS as ADMIN_CATALOGUE } from './admin-catalogue.js';
import { SKILLS as ADMIN_COMMAND } from './admin-command.js';
import { SKILLS as ADMIN_FINANCE } from './admin-finance.js';
import { SKILLS as ADMIN_ORG } from './admin-org.js';
import { SKILLS as CLIENT } from './client.js';
import { SKILLS as TEAM_CLIENTS } from './team-clients.js';
import { SKILLS as TEAM_WORK } from './team-work.js';
import type { PageSkill } from './types.js';

// Built on first use, not at import: skill files import services (e.g. AgentsService) that import ai-tools, which
// imports this file, so a skill file loaded first would otherwise see this list before its own SKILLS exist.
let all: PageSkill[] | undefined;
export const pageSkills = (): PageSkill[] => (all ??= [...TEAM_WORK, ...TEAM_CLIENTS, ...ADMIN_COMMAND, ...ADMIN_ORG, ...ADMIN_CATALOGUE, ...ADMIN_FINANCE, ...CLIENT]);

/** The skills for this person's own menu (team + Command Centre for staff, the portal for clients). */
export function skillsFor(me: Me): PageSkill[] {
  return pageSkills().filter((s) => (me.type === 'client' ? s.surface === 'client' : s.surface !== 'client') && s.can(me));
}

/** The skill a question is about: one the person has, or (to say so plainly) one they don't. */
export function skillFor(me: Me, q: string): { mine?: PageSkill; notMine?: PageSkill } {
  const pool = pageSkills().filter((s) => (me.type === 'client' ? s.surface === 'client' : s.surface !== 'client'));
  // The most specific match wins: "capacity by department" (Command Centre) over "capacity" (Team app), "discount
  // limits" over "discount". Ties keep the registry order.
  const hits = pool
    .map((s, i) => ({ s, i, len: q.match(s.keywords)?.[0].length ?? 0 }))
    .filter((h) => h.len > 0)
    .sort((a, b) => b.len - a.len || a.i - b.i)
    .map((h) => h.s);
  return { mine: hits.find((s) => s.can(me)), notMine: hits.find((s) => !s.can(me)) };
}

/** Runs a skill's lookup; a 403/404 becomes a plain "not allowed"/"not found" result instead of an error. */
export async function runSkill(ref: ModuleRef, me: Me, s: PageSkill): Promise<ToolOutput> {
  try {
    return { data: await s.load(ref, me), citations: [{ label: s.label, href: s.href }] };
  } catch (e) {
    if (e instanceof ForbiddenException) return { data: { notAllowed: true, message: e.message }, citations: [] };
    if (e instanceof NotFoundException) return { data: { notFound: true, message: e.message }, citations: [] };
    throw e;
  }
}

/** The skills as model tools (AI mode), only those this person's menu has. */
export function skillTools(ref: ModuleRef, me: Me): CopilotTool[] {
  return skillsFor(me).map((s) => ({
    name: s.name,
    description: `${s.label} page (${s.href}): ${s.description}`,
    schema: z.object({}),
    properties: {},
    status: `Opening ${s.label}…`,
    run: () => runSkill(ref, me, s),
  }));
}
