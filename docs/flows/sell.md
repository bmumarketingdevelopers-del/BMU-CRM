# Sell flow (v10): website visitor → paying client

Everything from a stranger on the website to a signed, paying client, plus renewals. Tested in a real browser as
an anonymous visitor, sales executive (sales@bmu.demo), sales manager (sales.manager@bmu.demo), Founder,
finance, the new client and a renewing client. Journey scripts: `apps/web/e2e/sell/*.mjs`
(`BASE_URL=http://localhost:3000 node apps/web/e2e/sell/full-sale.mjs`). API rules: `apps/api/test/sell.e2e-spec.ts`.

## What I tested (end to end)
- **Website**: home, services (live prices), package builder (bundles, add-ons, GST, first payment), discovery-call form.
- **Leads**: board and list, search and filters, drag between stages, assign owner, mark lost with a reason,
  lead detail with full history, logging calls/meetings/notes, follow-ups, duplicate merge / keep separate.
  The v9 "welcome new leads" automation assigns website leads when the engine runs (seen in the audit log).
- **Proposals**: build from a lead (tiers, bundle, add-ons, discount), multi-step discount approval, send, client
  link, view tracking, request changes, v2, old link "superseded", expiry + extend, e-sign with designation,
  printable agreement, test payment (Razorpay path unchanged and still verifies the signature), client account,
  AM assigned, engagements at G1, first invoice paid, welcome notification, client signs in and lands on /client.
- **Leadership numbers**: the lead shows Won on the pipeline; Weekly Review, Sales Funnel and Revenue Forecast
  open and include the new deal.
- **Phone width**: leads, lead detail, approvals, renewals, proposals, package builder, enquiry: no sideways scroll.

## What was broken and is now fixed
- Package builder used the bundled seed catalogue, not the live price book, so bundles/add-ons could differ from
  the proposal. It also charged the full project price as the "first payment" (projects are 50% up front) and
  silently dropped add-ons from the enquiry. Now it uses the live price book and the same pricing engine as
  proposals, shows the payment plan, and sends add-ons + the estimate with the enquiry.
- Add-on rows on the package builder were squashed (name wrapped one word per line).
- Enquiry form showed "Couldn't reach the server" for every error; it now shows the real reason. It can also
  record which services the visitor is interested in.
- No lead detail page: lead names went nowhere. Built `/team/leads/[id]` (contact, timeline, score, proposals).
- Marking a lead lost used a browser pop-up; now an inline dialog with common reasons.
- Sending a proposal and paying never wrote `lead.proposal_sent` / `lead.won` history, so funnel stage times were
  missing for those steps. Both are now recorded.
- Sales executives could not offer any discount at all (hard 403) and the Founder was the only approver.
  Replaced with the multi-step approval below.
- Nobody was notified about anything in the sale: discount approvals, approvals/rejections, the client opening or
  accepting the proposal, payment, new client for the AM, or a welcome for the client. All added (bell).
- Proposals only expired when the client happened to open the link; now swept every minute (and on read).
- Automation notifications for leads linked to the generic leads page; they now open the lead itself.
- Founder Pulse listed rejected discounts as "approve discount" and linked to the proposal; it now skips rejected
  ones and links to the approvals inbox. Expired proposals stay visible on the flow map as stuck.
- Team preview of the client link counted as the client opening it; the team now previews with `?preview=1`.

## What I added
1. **Lead detail and activity timeline**: log calls, meetings, notes, emails, WhatsApp with an outcome and an
   optional next follow-up; a first call/meeting moves a New lead to Contacted ("meeting booked" → Discovery).
   Follow-up reminder in the bell on the day (one per follow-up, also when overdue); "Your follow-ups" strip on
   the leads page. Lead score explained line by line. Duplicate detection on every website enquiry (same email
   or phone): the new lead is linked to the original, keeps its owner, the original gets a "repeat enquiry"
   entry and its owner is notified; sales can **Merge** (activity, proposals and services move over) or
   **Keep separate**.
2. **Negotiation**: "Request changes" on the public proposal → sales notified → "Make a new version" (v2, v3…,
   history kept with "what changed"). The client keeps the current version until the new one is sent; then old
   links show "This version has been replaced" with a button to the latest. Expiry date with **Extend** (re-opens
   an expired link) and automatic expiry. Accept with typed e-signature + name, designation, email, IP, browser
   and time; printable, styled agreement page `/p/<token>/agreement` (Print → Save as PDF).
3. **Multi-step discount approval** (uses Command Centre → Discount Limits): above the creator's own limit a sales
   manager approves first; above the admin limit the Founder approves next. Nobody approves their own discount.
   Approvals inbox `/team/approvals` (approve / reject with a required reason), status on the proposal and the
   proposals list; the builder tells sales up front who must approve.
4. **Renewals and upsell** `/team/renewals`: engagements ending within 45 days (or ended in the last 30) and monthly
   retainers reaching 6/12/18… months. One click drafts a renewal proposal from the current services and tiers;
   "Edit as a new version" adds services (upsell). Paying it extends the existing retainers by 12 months (new tier,
   renewal count) on the same client account; added services start as new engagements. No duplicate client.
5. **Payment plan before acceptance**: proposal, package builder and agreement show "First payment" (retainers
   one month in advance, projects/add-ons 50%) and what comes later (project balance before handover, monthly
   retainer). The first invoice uses exactly these amounts, with a note per line ("50% advance", "First month,
   in advance").

## Demo data (seed, "Sell demo · …")
Activity and follow-ups on the original demo leads (one due today, one overdue), a duplicate enquiry (Lotus Yoga
Studio), a negotiated proposal (Saffron Kitchens v1 superseded by v2), an open change request (Bloom Florist),
discounts waiting for the Founder (Northstar Realty, 25%) and a sales manager (Pebble Cafe, 8%), an expired
proposal (Metro Dental), and clients due for renewal (Coastal Foods, Harbor Fitness, Velvet Salon).
