// Ask BMU "page skills": one per tab in a person's menu (Team app, Command Centre, client portal). Each answers
// questions about that tab with the person's own data, read through the same services (and scope) the page uses.
// A skill is only offered, listed in help, or run for people whose menu has that tab (`can`).
import type { ModuleRef } from '@nestjs/core';
import type { Me } from '@bmu/shared';

export type PageSurface = 'team' | 'admin' | 'client';

export type PageSkill = {
  /** Tool name, unique, snake_case, starting with "page_", e.g. "page_documents". */
  name: string;
  /** The menu label and link of the tab this answers for. */
  label: string;
  href: string;
  surface: PageSurface;
  /** Same rule as the menu item: does this person see the tab? (see ./access.ts). */
  can: (me: Me) => boolean;
  /**
   * Basic-mode keywords, tested against the lower-cased question. Keep them specific to this tab: generic words
   * ("show", "status", "list", "my") match everything. Every example below must match.
   */
  keywords: RegExp;
  /** One or two example questions, shown in the help list to people who have the tab. */
  examples: string[];
  /** For the AI model: what the lookup returns. */
  description: string;
  /**
   * Read-only lookup through existing services with this person's own scope. Keep it small (top 10-20 rows, counts,
   * totals), money already formatted with formatINR, dates readable, free text passed through redact(). Never write.
   * A ForbiddenException/NotFoundException is turned into "not allowed"/"not found" by the caller.
   */
  load: (ref: ModuleRef, me: Me) => Promise<unknown>;
  /** Basic-mode answer from the loaded data: short markdown, links only to real app pages, ending with the page link. */
  answer: (data: never, question: string) => string;
};

/** Gets a Nest provider by class without importing its module (same as ai-tools.ts). */
export const svc = <T>(ref: ModuleRef, cls: new (...args: never[]) => T): T => ref.get(cls as never, { strict: false }) as T;

export const day = (iso: string | Date | null | undefined) =>
  iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : null;
export const dayShort = (iso: string | Date | null | undefined) => (iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : null);
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
/** "- a\n- b" list, at most `max` lines, with "…and N more" when cut. */
export const bullets = (rows: string[], max = 10) => (rows.length ? rows.slice(0, max).map((r) => `- ${r}`).join('\n') + (rows.length > max ? `\n…and ${rows.length - max} more` : '') : '');
export const link = (label: string, href: string) => `[${label}](${href})`;
