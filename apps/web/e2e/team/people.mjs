// People journeys: leave chain (manager then HR), cover, timesheet submit -> approve, who's out, onboarding/offboarding pages.
// BASE_URL=http://localhost:3000 node apps/web/e2e/team/people.mjs
import { BASE, launch, newPage, signIn, apiCall, check, done } from "./lib.mjs";

const browser = await launch();
const as = async (who) => {
  const page = await newPage(browser);
  await signIn(page, who);
  return page;
};
const text = (page) => page.locator("body").innerText();

// A unique 5-working-day leave far in the future (Mon-Fri), so reruns do not overlap.
const base = new Date(Date.UTC(2027, 0, 4 + 7 * (Math.floor(Date.now() / 1000) % 40)));
const day = (n) => new Date(base.getTime() + n * 86400000).toISOString().slice(0, 10);

console.log("Leave chain");
const producer = await as("producer@bmu.demo");
const applied = await apiCall(producer, "POST", "/workspace/leave", { from: day(0), to: day(4), type: "casual", reason: "Family wedding (journey)" });
check(applied.status === 201, `producer applies for 5 days (${applied.status})`);
await producer.goto(`${BASE}/team/profile`, { waitUntil: "networkidle" });
check(/Waiting for/.test(await text(producer)), "profile shows who the leave is waiting for");

const head = await as("design.head@bmu.demo");
await head.goto(`${BASE}/team/approvals`, { waitUntil: "networkidle" });
const row = head.getByTestId("leave-approval").filter({ hasText: "Family wedding (journey)" }).first();
check(await row.isVisible(), "manager sees the request in Approvals");
await row.getByRole("button", { name: "Approve" }).click();
await head.getByText(/HR now makes the final call/).waitFor({ timeout: 10000 }).catch(() => {});
check(/HR now makes the final call/.test(await text(head)), "manager approval of >3 days moves it to HR");

const hr = await as("hr@bmu.demo");
await hr.goto(`${BASE}/team/approvals`, { waitUntil: "networkidle" });
const hrRow = hr.getByTestId("leave-approval").filter({ hasText: "Family wedding (journey)" }).first();
check(/Waiting for HR/.test(await hrRow.innerText()), "HR sees it as waiting for HR with the manager's OK");
await hrRow.getByRole("button", { name: "Approve" }).click();
await hr.getByText(/approved/).first().waitFor({ timeout: 10000 }).catch(() => {});
const rows = await apiCall(hr, "GET", "/admin-org/leave");
const mine = rows.body.find((l) => l.reason === "Family wedding (journey)");
check(mine?.status === "approved" && mine?.stage === "done", "HR's approval is final");
await hr.goto(`${BASE}/admin/attendance`, { waitUntil: "networkidle" });
check((await text(hr)).includes("Attendance & Leave"), "attendance board loads for HR");

console.log("Attendance");
const qc = await as("qc@bmu.demo");
await qc.goto(`${BASE}/team`, { waitUntil: "networkidle" });
const checkIn = qc.getByRole("button", { name: "Check in" });
if (await checkIn.count()) {
  await checkIn.click();
  await qc.getByRole("button", { name: "Check out" }).waitFor({ timeout: 10000 }).catch(() => {});
}
const board = await apiCall(hr, "GET", "/admin-org/attendance");
const qcMe = (await apiCall(qc, "GET", "/auth/me")).body;
const qcOnBoard = board.body.board.find((r) => r.user.id === qcMe.id);
check(!!qcOnBoard?.checkIn && ["checked_in", "checked_out"].includes(qcOnBoard.status), `check-in shows on HR's attendance board (${qcOnBoard?.status})`);

console.log("Cover");
const seededCover = rows.body.find((l) => l.status === "approved" && l.tasksDuringLeave > 0);
if (seededCover) {
  await hr.goto(`${BASE}/team/leave/${seededCover.id}/cover`, { waitUntil: "networkidle" });
  check((await text(hr)).includes("Tasks due while they are away"), "cover page lists tasks due during leave");
  check((await hr.getByRole("combobox", { name: "Cover person" }).count()) === 1, "cover page offers a person picker");
} else check(false, "seeded approved leave with tasks due exists");

console.log("Timesheet");
await producer.goto(`${BASE}/team/timesheet`, { waitUntil: "networkidle" });
check((await text(producer)).includes("My timesheet"), "producer opens My timesheet");
const sheet = await apiCall(producer, "GET", "/team-flows/timesheets/week");
if (sheet.body.canEdit) {
  await producer.getByLabel("Hours").fill("1.5");
  await producer.getByLabel("Note").fill("Team meeting (journey)");
  await producer.getByRole("button", { name: "Add", exact: true }).click();
  await producer.getByText("Team meeting (journey)").first().waitFor({ timeout: 10000 }).catch(() => {});
  check(await producer.getByText("Team meeting (journey)").first().isVisible(), "manual entry appears in the week");
}
if ((await producer.getByRole("button", { name: "Submit week for approval" }).count()) > 0) {
  await producer.getByRole("button", { name: "Submit week for approval" }).click();
  await producer.getByText("Waiting for approval").first().waitFor({ timeout: 10000 }).catch(() => {});
}
check((await text(producer)).includes("Waiting for approval") || (await text(producer)).includes("Approved"), "week is submitted");
await producer.getByRole("link", { name: "← Previous week" }).click();
await producer.waitForURL(/week=/);
check(/week=\d{4}-\d{2}-\d{2}/.test(producer.url()), "previous-week navigation works");

await head.goto(`${BASE}/team/approvals`, { waitUntil: "networkidle" });
const waitingSheets = await apiCall(head, "GET", "/team-flows/timesheets/approvals");
const alreadyApproved = sheet.body.status === "approved";
check(waitingSheets.body.length > 0 || alreadyApproved, alreadyApproved ? "producer's week was approved on an earlier run" : `manager has ${waitingSheets.body.length} timesheet(s) to approve`);
const toApprove = waitingSheets.body[0];
if (toApprove) {
  await head.goto(`${BASE}/team/timesheets/review/${toApprove.id}`, { waitUntil: "networkidle" });
  await head.getByRole("button", { name: "Return with comment" }).click();
  await head.getByText(/Say what needs fixing/).waitFor({ timeout: 5000 }).catch(() => {});
  check(/Say what needs fixing/.test(await text(head)), "returning without a comment is refused");
  await head.getByRole("button", { name: "Approve" }).click();
  await head.getByText("Approved").first().waitFor({ timeout: 10000 }).catch(() => {});
  check((await text(head)).includes("Approved"), "manager approves the week");
}

const self = await apiCall(producer, "GET", "/team-flows/timesheets/approvals");
check(self.status === 200 && self.body.every((r) => r.user.name !== "Producer"), "nobody approves their own week");

console.log("Who's out");
await producer.goto(`${BASE}/team/calendar`, { waitUntil: "networkidle" });
check(await producer.getByTestId("who-is-out").isVisible(), "calendar shows the Who's out strip");

console.log("Onboarding / offboarding");
await hr.goto(`${BASE}/admin/people`, { waitUntil: "networkidle" });
check((await text(hr)).includes("Riya Sharma"), "HR sees the new hire's onboarding");
const offs = await apiCall(hr, "GET", "/team-flows/people?kind=offboarding");
const karan = offs.body.find((p) => p.user.email === "karan.leaving@bmu.demo");
if (karan) {
  await hr.goto(`${BASE}/admin/people/${karan.id}`, { waitUntil: "networkidle" });
  const t = await text(hr);
  check(t.includes("Hand over work") || t.includes("Offboarding"), "offboarding page shows the handover");
} else check(false, "seeded offboarding exists");
await producer.goto(`${BASE}/team/onboarding`, { waitUntil: "networkidle" });
check(!/Application error/.test(await text(producer)), "My onboarding page loads");

console.log("Approvals page for someone with no team");
const finance = await as("finance@bmu.demo");
await finance.goto(`${BASE}/team/approvals`, { waitUntil: "networkidle" });
check((await text(finance)).includes("Nothing waiting"), "empty state when nothing waits");

const errors = [producer, head, hr, finance, qc].flatMap((p) => p.errors);
check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(" | ")})`);
await browser.close();
done();
