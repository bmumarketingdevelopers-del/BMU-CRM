// Visits every Command Centre / team page as each role and reports page errors, 5xx API calls and error banners.
import { BASE, launch, newPage, signIn, check, done } from "./lib.mjs";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "../../src/app");
function pages(group, prefix) {
  const out = [];
  const walk = (dir, url) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) {
        if (f.startsWith("[")) continue; // dynamic routes are covered by journeys
        walk(p, `${url}/${f}`);
      } else if (f === "page.tsx") out.push(url || "/");
    }
  };
  walk(join(appDir, group, prefix), `/${prefix}`);
  return out;
}

const roles = (process.env.ROLES ?? "founder@bmu.demo,hr@bmu.demo,design.head@bmu.demo,am.lead@bmu.demo,producer@bmu.demo,finance@bmu.demo,creator@bmu.demo,client@sunrise.demo").split(",");
const browser = await launch();
for (const who of roles) {
  const page = await newPage(browser);
  const home = await signIn(page, who);
  console.log(`\n${who} -> ${home}`);
  const surface = home.startsWith("/admin") ? ["(admin)", "admin", "(team)", "team"] : home.startsWith("/team") ? ["(team)", "team"] : home.startsWith("/client") ? ["(client)", "client"] : ["(creator)", "creator"];
  if (home.startsWith("/team")) {
    await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
    if (new URL(page.url()).pathname.startsWith("/admin")) surface.push("(admin)", "admin");
  }
  const urls = [];
  for (let i = 0; i < surface.length; i += 2) urls.push(...pages(surface[i], surface[i + 1]));
  for (const url of urls) {
    page.errors = [];
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" }).catch((e) => page.errors.push(String(e)));
    await page.waitForTimeout(300);
    const body = await page.locator("body").innerText().catch(() => "");
    const bad = /Application error|Unhandled Runtime Error|Request failed \(5|Internal server error/i.test(body);
    const forbidden = /You don't have access|Only the Founder/i.test(body);
    if (page.errors.length || bad) check(false, `${url} ${page.errors.join(" | ").slice(0, 300)}${bad ? " [error text on page]" : ""}`);
    else if (forbidden && !process.env.QUIET) console.log(`  --   ${url} shows a no-access message`);
  }
  await page.context().close();
}
await browser.close();
done();
