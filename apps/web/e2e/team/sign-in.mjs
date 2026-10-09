// Sign-in journeys: every role by email lands on the right home, phone OTP, wrong code, session expiry, OWNER_EMAIL as Founder.
// BASE_URL=http://localhost:3000 [OWNER_EMAIL=...] node apps/web/e2e/team/sign-in.mjs
import { BASE, launch, newPage, signIn, apiCall, check, done } from "./lib.mjs";

// Mirrors homePathFor in packages/shared/src/auth.ts.
const homes = {
  "founder@bmu.demo": "/admin",
  "admin@bmu.demo": "/admin",
  "hr@bmu.demo": "/team",
  "design.head@bmu.demo": "/admin",
  "am.lead@bmu.demo": "/team",
  "producer@bmu.demo": "/team",
  "finance@bmu.demo": "/team",
  "creator@bmu.demo": "/creator",
  "client@sunrise.demo": "/client",
};
const browser = await launch();
const errors = [];

console.log("Email sign-in per role");
for (const [who, home] of Object.entries(homes)) {
  const page = await newPage(browser);
  const landed = await signIn(page, who);
  check(landed.startsWith(home), `${who} -> ${landed}`);
  errors.push(...page.errors);
  await page.context().close();
}

console.log("Phone OTP");
{
  const page = await newPage(browser);
  const landed = await signIn(page, "+919800000006");
  const me = await apiCall(page, "GET", "/auth/me");
  check(landed.startsWith("/team") && me.body?.email === "producer@bmu.demo", `producer by phone -> ${landed}`);
  await page.context().close();
}
{
  const page = await newPage(browser);
  const landed = await signIn(page, "98000 00010");
  check(landed.startsWith("/client"), `client by 10-digit phone -> ${landed}`);
  await page.context().close();
}

console.log("Wrong code");
{
  const page = await newPage(browser);
  await page.goto(`${BASE}/sign-in`);
  await page.getByPlaceholder("Email or mobile number").fill("am.lead@bmu.demo");
  await page.getByRole("button", { name: "Send code" }).click();
  const code = page.getByPlaceholder("6-digit code");
  await code.waitFor();
  const real = await code.inputValue();
  await code.fill(real === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForTimeout(1200);
  const t = await page.locator("body").innerText();
  check(new URL(page.url()).pathname === "/sign-in" && /code|incorrect|wrong|invalid/i.test(t), "a wrong code shows an error and stays on sign-in");
  await code.fill(real);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 15000 }).catch(() => {});
  check(!new URL(page.url()).pathname.startsWith("/sign-in"), "the right code still works after a wrong one");
  await page.context().close();
}
{
  const page = await newPage(browser);
  await page.goto(`${BASE}/sign-in`);
  await page.getByPlaceholder("Email or mobile number").fill("nobody-here@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.waitForTimeout(1200);
  check(new URL(page.url()).pathname === "/sign-in", "an unknown email does not sign anyone in");
  await page.context().close();
}

console.log("Session expiry");
{
  const page = await newPage(browser);
  await signIn(page, "producer@bmu.demo");
  await page.goto(`${BASE}/team/timesheet`, { waitUntil: "networkidle" });
  await page.context().clearCookies();
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search everything").fill("sunrise");
  await page.waitForURL(/\/sign-in\?expired=1/, { timeout: 10000 }).catch(() => {});
  check(/expired=1/.test(page.url()), `an expired session goes back to sign-in (${page.url().replace(BASE, "")})`);
  check(/session has ended/i.test(await page.locator("body").innerText()), "the sign-in page says the session ended");
  await page.getByPlaceholder("Email or mobile number").fill("producer@bmu.demo");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 15000 });
  check(new URL(page.url()).pathname === "/team/timesheet", `signing back in returns to the same page (${new URL(page.url()).pathname})`);
  await page.goto(`${BASE}/sign-in?next=https://evil.example.com/`);
  check(new URL(page.url()).host === new URL(BASE).host, "an off-site next link is ignored");
  await page.context().close();
}

console.log("Wrong surface");
{
  const page = await newPage(browser);
  await signIn(page, "client@sunrise.demo");
  const brand = await apiCall(page, "GET", "/team-flows/branding");
  await page.goto(`${BASE}/client`, { waitUntil: "networkidle" });
  check(brand.status === 200 && (await page.title()).includes(brand.body.clientAppName), `the client app uses the branded name (${brand.body?.clientAppName})`);
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  check(!new URL(page.url()).pathname.startsWith("/admin"), `a client cannot open the Command Centre (${new URL(page.url()).pathname})`);
  await page.context().close();
}

const owner = process.env.OWNER_EMAIL?.trim();
if (owner) {
  console.log("OWNER_EMAIL");
  const page = await newPage(browser);
  const landed = await signIn(page, owner);
  const me = await apiCall(page, "GET", "/auth/me");
  check(landed.startsWith("/admin") && (me.body?.roles ?? []).includes("founder"), `OWNER_EMAIL signs in as Founder -> ${landed}`);
  await page.context().close();
}

check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(" | ")})`);
await browser.close();
done();
