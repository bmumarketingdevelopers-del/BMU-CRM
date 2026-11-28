// Ask BMU basic mode: the help list and page answers follow each person's own dashboard and menu.
import type { Me } from '@bmu/shared';
import { describe, expect, it } from 'vitest';
import { clientHelpFor, clientPageFor, staffHelpFor, staffPageFor } from './ai-topics.js';

const staff = (roles: string[], extra: Partial<Me> = {}): Me => ({ id: 'u1', orgId: 'o1', type: 'staff', name: 'Asha Rao', email: null, roles, permissions: {}, ...extra }) as unknown as Me;
const client = (canBill: boolean): Me =>
  ({ id: 'c1', orgId: 'o1', type: 'client', name: 'Ravi', email: null, roles: [], permissions: canBill ? { invoices_payments: { scope: 'own', rule: 'view' } } : {} }) as unknown as Me;
const names = { client: 'Metro Dental', colleague: 'Meera' };

describe('Ask BMU help follows the dashboard', () => {
  it('a producer sees their own work, goals and pages, not money, sales, clients or team', () => {
    const h = staffHelpFor(staff(['producer']), names);
    for (const s of ['Your day', 'Attendance', 'Leave', 'End-of-day report', 'Goals', 'Meetings', 'Timesheet', 'Expenses', 'My performance', 'Documents', 'SOP library']) expect(h).toContain(s);
    for (const s of ['**Money', '**Sales', '**Target', '**Team', '**Clients', '**Requests', 'Meera', 'Metro Dental', 'Quotations', 'Renewals', 'Messages']) expect(h).not.toContain(s);
  });

  it('the Founder sees money, target, team and clients with real names, and no leave or own EOD', () => {
    const h = staffHelpFor(staff(['founder']), names);
    for (const s of ['**Money', '**Target', '**Team', '**Clients', 'Tell me about Metro Dental', 'What is Meera working on?', 'Quotations']) expect(h).toContain(s);
    expect(h).not.toContain('**Leave');
    expect(h).not.toContain('Have I filed my EOD?');
  });

  it('a sales executive sees leads; without a colleague name no person example is made up', () => {
    const h = staffHelpFor(staff(['sales_executive'], { permissions: { leads_pipeline: { scope: 'own', rule: 'edit' } } } as Partial<Me>), {});
    expect(h).toContain('**Sales');
    expect(h).not.toContain('working on?');
  });

  it('pages: answered when in the menu, refused plainly when not', () => {
    expect(staffPageFor(staff(['producer']), 'where are the sops?').mine?.label).toBe('SOP library');
    const q = staffPageFor(staff(['producer']), 'show quotations');
    expect(q.mine).toBeUndefined();
    expect(q.notMine?.label).toBe('Quotations');
  });

  it('clients: billing only for users who may see it', () => {
    expect(clientHelpFor(client(true))).toContain('Do I have any invoices due?');
    expect(clientHelpFor(client(false))).not.toContain('invoices');
    expect(clientHelpFor(client(false))).not.toContain('Quotations');
    expect(clientPageFor(client(false), 'show my quotations').notMine?.label).toBe('Quotations');
    expect(clientPageFor(client(true), 'where is my brand kit?').mine?.label).toBe('Brand kit');
  });
});
