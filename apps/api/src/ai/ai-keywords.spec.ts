// Ask BMU basic mode (no AI key): questions about what is on each dashboard reach the right keyword group.
import { describe, expect, it } from 'vitest';
import { CLIENT_KEYWORDS, STAFF_KEYWORDS } from './ai-copilot.js';

const staff: [keyof typeof STAFF_KEYWORDS, string[]][] = [
  ['attendance', ['Did I check in today?', 'Was I late today?', 'Is tomorrow a holiday?', 'Is my leave approved?', 'What are my office timings?', 'Am I working from home today?']],
  ['eod', ['Have I submitted my EOD?', 'Did I file my end of day report?', 'How many of my team filed their daily report?']],
  ['qc', ['What did QC send back?', 'What is waiting for my QC check?', 'Anything for rework?']],
  ['sendToClient', ['What is ready to send to the client?']],
  ['delivery', ['Which deliverables are delayed?', 'Any milestones slipping?']],
  ['mine', ['What should I do today?', 'Show my follow-ups', "What's on my plate?", 'My priorities']],
  ['money', ['How much is overdue from Metro Dental?', 'Unpaid invoices', 'Pending payments this month', 'Total receivables']],
  ['leads', ['Show open leads', 'Any proposals pending?', 'New enquiries this week']],
  ['requests', ['Open requests', 'Any complaints from clients?', 'Which tickets have the first reply overdue?']],
  ['sales', ['How are we doing against target?', 'Show the scorecard', 'Sales forecast']],
  ['team', ['Show team performance', 'Who is overloaded?', 'Team utilisation']],
  ['summary', ['Summary of the week', 'Revenue this month', "What's happening?"]],
];

const client: [keyof typeof CLIENT_KEYWORDS, string[]][] = [
  ['contact', ['Who is my client manager?', 'What is the phone number of my manager?', 'How do I book a call?']],
  ['plans', ['Is my monthly plan ready?', 'Show the content calendar']],
  ['requirements', ['What do you still need from me?', 'Do you need any logins?', 'Where do I upload brand files?']],
  ['approvals', ['What is waiting for my approval?', 'Any new designs to review?', 'Give feedback on the reel']],
  ['money', ['Do I have any invoices due?', 'How much have I paid?', 'Send me the GST receipt']],
  ['requests', ['What is the status of my requests?', 'I have a complaint']],
];

describe('Ask BMU basic-mode keywords', () => {
  for (const [group, questions] of staff)
    it(`team: ${group}`, () => {
      for (const q of questions) expect(STAFF_KEYWORDS[group].test(q.toLowerCase()), q).toBe(true);
    });
  for (const [group, questions] of client)
    it(`client: ${group}`, () => {
      for (const q of questions) expect(CLIENT_KEYWORDS[group].test(q.toLowerCase()), q).toBe(true);
    });

  it('keeps look-alike questions apart', () => {
    expect(CLIENT_KEYWORDS.contact.test('what is my invoice number for october?')).toBe(false);
    expect(STAFF_KEYWORDS.attendance.test('which clients are at risk?')).toBe(false);
    expect(STAFF_KEYWORDS.qc.test('is my leave rejected?')).toBe(false);
  });
});
