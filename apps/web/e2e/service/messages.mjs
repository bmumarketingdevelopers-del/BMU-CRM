// Journey: client ↔ CM messages. Both directions, internal notes hidden from the client, unread badges,
// file attachments, live refresh without reloading, same-working-day reply tracking, bell deep links,
// and notification preferences really switching alerts off.
import { writeFileSync } from "node:fs";
import { BASE, SHOTS, apiCall, browser, check, done, shot, signIn, sleep } from "./lib.mjs";

const stamp = Date.now().toString().slice(-6);
const b = await browser();
const client = await signIn(b, "client@sunrise.demo");
const am = await signIn(b, "am@bmu.demo");

// Start clean: the CM has read the thread.
const threadId = (await apiCall(client, "GET", "/client/thread")).json.id;
await apiCall(am, "GET", `/threads/${threadId}`);

console.log("Client writes with an attachment");
await client.goto(`${BASE}/client/messages`);
await client.getByRole("textbox", { name: "Message" }).fill(`Hi, here is the brief [${stamp}]`);
const file = `${SHOTS}/brief-${stamp}.txt`;
writeFileSync(file, "Brief: new festive campaign\n");
await client.getByTestId("chat-file").setInputFiles(file);
await client.getByText(`brief-${stamp}.txt`).waitFor();
await client.getByRole("button", { name: "Send", exact: true }).click();
await client.locator(`text=Hi, here is the brief [${stamp}]`).waitFor();
await client.locator(`[data-testid=chat-message] a:has-text("brief-${stamp}.txt")`).waitFor();
check((await client.locator(`[data-testid=chat-message] a:has-text("brief-${stamp}.txt")`).count()) === 1, "attachment shows in the client's message");

console.log("CM sees the unread badge, the waiting timer and the attachment");
await am.goto(`${BASE}/team/messages`);
await am.getByText("Sunrise Realty Pvt Ltd").first().waitFor();
const badge = await am.getByTestId("unread-badge").first().textContent().catch(() => null);
check(!!badge && Number(badge) >= 1, `menu shows unread messages (${badge})`);
const row = am.locator(`a[href="/team/messages/${threadId}"]`);
check((await row.locator("text=/Awaiting reply|Reply overdue/").count()) === 1, "thread shows 'Awaiting reply' (same working day target)");
check((await row.getByLabel(/unread/).count()) === 1, "thread row shows its unread count");
const amNote = (await apiCall(am, "GET", "/notifications")).json.items.find((n) => n.kind === "message" && n.body?.includes(stamp));
check(amNote?.link === `/team/messages/${threadId}`, "CM bell alert deep-links to the thread");
await am.goto(`${BASE}/team/messages/${threadId}`);
await am.getByText(`Hi, here is the brief [${stamp}]`).waitFor();
const href = await am.locator(`a:has-text("brief-${stamp}.txt")`).getAttribute("href");
const dl = await apiCall(am, "GET", href.replace(/^\/api/, ""));
check(dl.status === 200 && String(dl.json).includes("festive"), "CM can download the attachment");
const listAfter = (await apiCall(am, "GET", "/threads")).json.find((t) => t.id === threadId);
check(listAfter.unread === 0, "opening the thread clears its unread count");

console.log("CM adds an internal note and replies; client sees only the reply, live");
await am.getByLabel(/Internal note/).check();
await am.getByRole("textbox", { name: "Message" }).fill(`Internal: budget is tight [${stamp}]`);
await am.getByRole("button", { name: "Send", exact: true }).click();
await am.getByText(`Internal: budget is tight [${stamp}]`).waitFor();
await am.getByRole("textbox", { name: "Message" }).fill(`Thanks! We'll share ideas today [${stamp}]`);
await am.getByRole("button", { name: "Send", exact: true }).click();
await am.getByText(`Thanks! We'll share ideas today [${stamp}]`).waitFor();
check((await am.locator("text=/Waiting for a reply since/").count()) === 0, "after replying the thread is no longer waiting");
// The client page is still open: it refreshes on its own within 15 seconds.
await client.getByText(`Thanks! We'll share ideas today [${stamp}]`).waitFor({ timeout: 25_000 });
check(true, "client sees the reply without reloading");
check((await client.getByText(`Internal: budget is tight [${stamp}]`).count()) === 0, "client never sees the internal note");
const ct = await apiCall(client, "GET", "/client/thread");
check(!JSON.stringify(ct.json).includes("budget is tight"), "internal note not in the client API response either");
const cn = (await apiCall(client, "GET", "/notifications")).json.items.find((n) => n.kind === "message" && n.body?.includes(stamp));
check(cn?.link === "/client/messages" && !cn.body.includes("Internal"), "client bell alert for the reply only, linking to Messages");

console.log("Notification preferences are respected");
await client.goto(`${BASE}/client/profile`);
await client.getByTestId("notification-prefs").waitFor();
const box = client.getByLabel("New message in the app");
if (await box.isChecked()) await box.uncheck();
const mail = client.getByLabel("New message by email");
if (await mail.isChecked()) await mail.uncheck();
await client.getByRole("button", { name: "Save" }).click();
await client.getByText("Saved. We'll use these from now on.").waitFor();
const before = (await apiCall(client, "GET", "/notifications")).json.items.length;
await apiCall(am, "POST", `/threads/${threadId}/messages`, { body: `Muted check [${stamp}]`, internal: false });
const after = (await apiCall(client, "GET", "/notifications")).json.items;
check(!after.some((n) => n.body?.includes(`Muted check [${stamp}]`)), `no in-app alert after switching messages off (${before} → ${after.length})`);
const unread = (await apiCall(client, "GET", "/service/unread")).json.messages;
check(unread >= 1, `the message still counts as unread for the client (${unread})`);
// Switch back on for the next runs.
await client.getByLabel("New message in the app").check();
await client.getByLabel("New message by email").check();
await client.getByRole("button", { name: "Save" }).click();
await client.getByText("Saved. We'll use these from now on.").waitFor();
await apiCall(am, "POST", `/threads/${threadId}/messages`, { body: `Unmuted check [${stamp}]`, internal: false });
check((await apiCall(client, "GET", "/notifications")).json.items.some((n) => n.body?.includes(`Unmuted check [${stamp}]`)), "alerts come back after switching on");
await am.goto(`${BASE}/team/profile`);
check(await am.getByTestId("notification-prefs").waitFor().then(() => true, () => false), "team profile has notification preferences too");

await client.goto(`${BASE}/client/messages`);
await client.setViewportSize({ width: 390, height: 844 });
await sleep(500);
await shot(client, "messages-client-phone");
const wide = await client.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
check(!wide, "messages page has no sideways scroll on a phone");
await client.setViewportSize({ width: 1360, height: 900 });
await shot(am, "messages-team-profile");

const errors = [client, am].flatMap((p) => p.errors);
check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(" | ")})`);
await b.close();
done();
