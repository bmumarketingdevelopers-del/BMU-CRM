// v20 journey: hardening. The Founder hides a field from a role and the sales executive no longer sees it on the
// website or through the API or search; the Founder turns on an authenticator app and signs in with the second
// step; adds a passkey (virtual authenticator) and signs in with it; makes two-step sign-in required for Finance,
// who is sent to set it up; a visitor makes a privacy request that lands in Privacy (DPDP); the audit chain verifies.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/hardening/hardening.mjs
import { createHmac } from "node:crypto";
import { apiCall, check, done, launch, newPage, shot, signIn, BASE } from "../team/lib.mjs";

function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, "0");
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}

const browser = await launch();
const founder = await newPage(browser);
const sales = await newPage(browser);
const visitor = await newPage(browser);
const stamp = Date.now().toString(36);

try {
  console.log("1. Field access: hide Lead budget from sales executives");
  await signIn(founder, "founder@bmu.demo");
  await founder.goto(`${BASE}/admin/security`);
  await founder.getByRole("heading", { name: "Security", level: 1 }).waitFor();
  check(await founder.getByRole("link", { name: "Security" }).count(), "Security is in the Command Centre menu");
  const cell = founder.getByLabel("Lead budget for Sales Executive");
  await cell.waitFor();
  check((await cell.inputValue()) === "edit", "sales executives can change the lead budget by default");
  await cell.selectOption("hidden");
  check(await founder.getByText("1 unsaved").count(), "the change is counted before saving");
  await founder.getByRole("button", { name: "Save", exact: true }).click();
  await founder.getByText("Saved. The new rules apply straight away everywhere.").waitFor();
  await shot(founder, "hardening-field-access");

  await signIn(sales, "sales@bmu.demo");
  const leads = (await apiCall(sales, "GET", "/leads")).body;
  const list = Array.isArray(leads) ? leads : (leads.leads ?? leads.rows ?? leads.items ?? []);
  check(list.length > 0, `the sales executive still sees leads (${list.length})`);
  check(!JSON.stringify(list).includes('"budgetPaise"'), "no budget in the leads list from the API");
  const one = (await apiCall(sales, "GET", `/leads/${list[0].id}`)).body;
  check(one && !("budgetPaise" in one), "no budget on a lead from the API");
  const sr = await apiCall(sales, "GET", `/team-flows/search?q=${encodeURIComponent((list[0].contact?.company ?? list[0].company ?? "a").slice(0, 6))}`);
  const search = sr.body;
  check(sr.status === 200, "search answers");
  check(!JSON.stringify(search).includes("budgetPaise"), "no budget in search results");
  await sales.goto(`${BASE}/team/leads/${list[0].id}`);
  await sales.waitForLoadState("networkidle").catch(() => {});
  check(!(await sales.getByText(/^Budget ₹[\d,.]+ a month$/).count()), "no budget amount on the lead page");

  console.log("2. View as the sales executive");
  await founder.getByRole("button", { name: "View as" }).click();
  const person = await founder.getByLabel("Person").locator("option", { hasText: "Sales Executive" }).first().getAttribute("value");
  await founder.getByLabel("Person").selectOption(person);
  await founder.getByText(/Fields .* sees/).waitFor();
  check(await founder.locator("li", { hasText: "Lead budget" }).getByText("Hidden").count(), "View as shows Lead budget as hidden");
  await shot(founder, "hardening-view-as");
  // Put the default back.
  await founder.getByRole("button", { name: "Field access" }).click();
  await founder.getByLabel("Lead budget for Sales Executive").selectOption("edit");
  await founder.getByRole("button", { name: "Save", exact: true }).click();
  await founder.getByText("Saved. The new rules apply straight away everywhere.").waitFor();
  const back = (await apiCall(sales, "GET", "/leads")).body;
  check(JSON.stringify(back).includes('"budgetPaise"'), "after putting it back the budget shows again");

  console.log("3. Authenticator app: turn on, then sign in with the second step");
  await founder.goto(`${BASE}/security`);
  await founder.getByRole("heading", { name: "Sign-in security" }).waitFor();
  await founder.getByRole("button", { name: "Set up authenticator app" }).click();
  await founder.getByAltText(/QR code/).waitFor();
  const secret = (await founder.locator("code").first().textContent()).trim();
  await founder.getByPlaceholder("6-digit code from the app").fill(totp(secret));
  await founder.getByRole("button", { name: "Turn on" }).click();
  await founder.getByText("Save these recovery codes somewhere safe.").waitFor();
  check((await founder.locator("pre span").count()) === 10, "ten recovery codes are shown once");
  await shot(founder, "hardening-recovery-codes");
  await founder.getByRole("button", { name: "I have saved them" }).click();
  await apiCall(founder, "POST", "/auth/logout");
  await founder.goto(`${BASE}/sign-in`);
  await founder.getByPlaceholder("Email or mobile number").fill("founder@bmu.demo");
  await founder.getByRole("button", { name: "Send code" }).click();
  await founder.getByRole("button", { name: "Sign in" }).click();
  await founder.getByPlaceholder("Authenticator or recovery code").waitFor();
  check(true, "sign-in asks for the second step");
  await founder.getByPlaceholder("Authenticator or recovery code").fill("000000");
  await founder.getByRole("button", { name: "Continue" }).click();
  await founder.locator("p.text-red").waitFor();
  check(true, "a wrong code is refused");
  // The code used to turn it on can't be used again (no replay), so use the next 30-second code.
  await founder.getByPlaceholder("Authenticator or recovery code").fill(totp(secret, Date.now() + 30_000));
  await founder.getByRole("button", { name: "Continue" }).click();
  await founder.waitForURL((u) => u.pathname.startsWith("/admin") || u.pathname.startsWith("/team"), { timeout: 20000 });
  check(true, "the right code signs in");

  console.log("4. Passkey: add one, sign in with it");
  const cdp = await founder.context().newCDPSession(founder);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await founder.goto(`${BASE}/security`);
  await founder.getByLabel("Passkey name").fill("Test laptop");
  await founder.getByRole("button", { name: "Add a passkey" }).click();
  await founder.getByText("Passkey added.").waitFor({ timeout: 15000 });
  await founder.getByText("Test laptop", { exact: true }).waitFor();
  check(true, "the passkey is listed");
  await shot(founder, "hardening-security-page");
  await apiCall(founder, "POST", "/auth/logout");
  await founder.goto(`${BASE}/sign-in`);
  await founder.getByRole("button", { name: "Sign in with a passkey" }).click();
  await founder.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 20000 });
  const sess = (await apiCall(founder, "GET", "/security/sessions")).body;
  check(sess.find((s) => s.current)?.method === "passkey", "signed in with the passkey, no code typed");

  console.log("5. Two-step sign-in required for Finance");
  const settings = (await apiCall(founder, "GET", "/settings")).body;
  await apiCall(founder, "PUT", "/settings/security", { ...settings.security, require2faRoles: ["finance"] });
  const fin = await newPage(browser);
  await fin.goto(`${BASE}/sign-in`);
  await fin.getByPlaceholder("Email or mobile number").fill("finance@bmu.demo");
  await fin.getByRole("button", { name: "Send code" }).click();
  await fin.getByRole("button", { name: "Sign in" }).click();
  await fin.waitForURL((u) => u.pathname.startsWith("/security"), { timeout: 20000 });
  await fin.getByText(/Your role must use two-step sign-in/).waitFor();
  check(true, "Finance is sent to set up two-step sign-in first");
  const blocked = await apiCall(fin, "GET", "/insights/weekly");
  check(blocked.status === 403 && blocked.body.code === "two_factor_required", "the API refuses other requests until it is set up");
  await shot(fin, "hardening-required");
  await apiCall(founder, "PUT", "/settings/security", { ...settings.security, require2faRoles: [] });

  console.log("6. Privacy request from the public page");
  await visitor.goto(`${BASE}/privacy`);
  await visitor.getByRole("heading", { name: "Privacy notice" }).waitFor();
  await visitor.getByLabel("What would you like?").selectOption("export");
  await visitor.getByLabel("Your name").fill("Meera Iyer");
  await visitor.getByLabel("Email").fill(`meera.${stamp}@example.com`);
  await visitor.getByRole("button", { name: "Send request" }).click();
  await visitor.getByText(/Your request is logged and we will answer by/).waitFor();
  check(true, "the request is accepted with a deadline");
  await founder.goto(`${BASE}/admin/privacy`);
  await founder.getByText(`meera.${stamp}@example.com`).waitFor();
  check(true, "it shows in Privacy (DPDP) for the Founder");
  await shot(founder, "hardening-privacy");

  console.log("7. Enquiry form consent and bot trap");
  await visitor.goto(`${BASE}/enquiry`);
  check(await visitor.getByText("Send me updates about my enquiry on WhatsApp (optional)").count(), "optional WhatsApp consent on the enquiry form");
  check(await visitor.getByRole("link", { name: "privacy notice" }).count(), "the privacy notice is linked from the form");

  console.log("8. Audit chain verifies");
  await founder.goto(`${BASE}/admin/audit`);
  await founder.getByRole("button", { name: "Verify chain" }).click();
  await founder.getByText(/Chain intact/).waitFor({ timeout: 20000 });
  check(true, "the audit chain is intact");
  await shot(founder, "hardening-audit");

  // Tidy up: turn the authenticator off so other journeys can sign in with a code only.
  const passkeys = (await apiCall(founder, "GET", "/security/me")).body.passkeys;
  for (const p of passkeys) await apiCall(founder, "DELETE", `/security/passkeys/${p.id}`);
  // Codes can't be reused, so try the newest one and wait for the next step if it was already used.
  for (let i = 0; i < 10; i++) {
    if ((await apiCall(founder, "POST", "/security/totp/disable", { code: totp(secret, Date.now() + 30_000) })).status < 300) break;
    await founder.waitForTimeout(5000);
  }
  const after = (await apiCall(founder, "GET", "/security/me")).body;
  check(!after.totp.enabled && after.passkeys.length === 0, "the Founder is back to code-only sign-in");
} finally {
  await browser.close();
}
done();
