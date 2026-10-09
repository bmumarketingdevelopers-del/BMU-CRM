// Journey: Ask BMU (basic mode, no API key). Founder opens it with Ctrl+J, asks about at-risk clients and gets an
// answer with links into the CRM; history keeps the conversation. A producer asks about money and is told it is not
// visible to their role. A client asks about their own invoices from the portal. A creator gets no copilot at all.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/ai/copilot.mjs
import { launch, newPage, signIn, shot, check, finish, BASE, apiAs } from "./lib.mjs";

const browser = await launch();

console.log("1. Founder asks a question with Ctrl+J");
const founder = await newPage(browser, "founder");
await signIn(founder, "founder@bmu.demo");
const status = (await apiAs(founder, "GET", "/ai/status")).body;
check(status.mode === "basic", "no key: AI Copilot runs in basic mode");
await founder.goto(`${BASE}/admin`);
await founder.getByRole("button", { name: /Open Ask BMU/ }).waitFor();
await founder.keyboard.press("Control+j");
const panel = founder.getByRole("dialog", { name: "Ask BMU" });
await panel.waitFor();
check(await panel.getByText("Answers use only what your role can see").isVisible(), "panel says answers follow the role");
await shot(founder, "01-copilot-empty");
await panel.getByRole("button", { name: "Which clients are at risk this month and why?" }).click();
await panel.getByText("Basic", { exact: true }).first().waitFor();
const answer = await panel.locator("ol > li").nth(1).innerText();
check(answer.length > 40, "a basic answer arrives");
check((await panel.locator("ol a[href^='/']").count()) > 0, "the answer links into the CRM");
check(await panel.getByText(/Basic suggestions/).first().isVisible(), "basic-mode notice is shown");
await shot(founder, "02-copilot-answer");

console.log("2. Follow-up question in the same chat, then history");
await panel.getByLabel("Your question").fill("How much is overdue?");
await panel.getByRole("button", { name: "Ask", exact: true }).click();
await founder.waitForFunction(() => document.querySelectorAll('[role="dialog"] ol > li').length >= 4 && !document.body.innerText.includes("Thinking…"));
check((await panel.locator("ol > li").count()) >= 4, "second answer is added to the same conversation");
await panel.getByRole("button", { name: "History" }).click();
await panel.getByText("Recent conversations").waitFor();
await panel.locator("ul li").first().waitFor();
check(await panel.getByRole("button", { name: "Which clients are at risk this month and why?" }).first().isVisible(), "conversation shows in history");
await shot(founder, "03-copilot-history");
await founder.keyboard.press("Escape");

console.log("3. Producer cannot see money through the copilot");
const producer = await newPage(browser, "producer");
await signIn(producer, "producer@bmu.demo");
const p = (await apiAs(producer, "POST", "/ai/ask", { question: "Show me overdue invoices" })).body;
check(!/₹/.test(p.text), "producer gets no invoice amounts");
check(/can't see|cannot see|not available|isn't available|not visible/i.test(p.text), "producer is told money is outside their role");

console.log("4. Client asks about their own account");
const client = await newPage(browser, "client");
await signIn(client, "client@sunrise.demo");
await client.getByRole("button", { name: /Open Ask BMU/ }).waitFor();
await client.getByRole("button", { name: /Open Ask BMU/ }).click();
const cpanel = client.getByRole("dialog", { name: "Ask BMU" });
check(await cpanel.getByText("Answers use only your company's data").isVisible(), "client panel says it uses only their data");
await cpanel.getByRole("button", { name: "Do I have any invoices due?" }).click();
await cpanel.getByText("Basic", { exact: true }).first().waitFor();
const ctext = await cpanel.locator("ol > li").nth(1).innerText();
check(ctext.length > 20, "client gets an answer about their invoices");
check(!/Metro Dental/i.test(ctext), "client answer does not mention other clients");
const blocked = await apiAs(client, "POST", "/ai/ask", { question: "list all clients" });
check(blocked.status === 403, "client cannot use the staff copilot endpoint");
await shot(client, "04-client-copilot");

console.log("5. Creator has no copilot");
const creator = await newPage(browser, "creator");
await signIn(creator, "creator@bmu.demo");
await creator.waitForTimeout(1500);
check((await creator.getByRole("button", { name: /Open Ask BMU/ }).count()) === 0, "creator sees no Ask BMU button");

await browser.close();
finish();
