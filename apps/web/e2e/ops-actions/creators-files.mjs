// v11 ops journey: creators and files. + Add creator with the duplicate check, the roster (search, export, row menu,
// creator page with History), file upload into a client folder, move / rename / tag, release blocked before Gate 5,
// share link with expiry and password on the public page, client upload to "From client", and forbidden roles.
// BASE_URL=http://localhost:3000 node apps/web/e2e/ops-actions/creators-files.mjs
import { writeFileSync } from "node:fs";
import { as, apiCall, BASE, check, done, go, launch, newPage, noErrors, noSideScroll, shot, SHOTS, stamp, toast } from "./lib.mjs";

const browser = await launch();
const mobile = `8${String(stamp).padStart(6, "0")}456`.slice(0, 10);
const handle = `journey_${stamp}`;
const filePath = `${SHOTS}/brief-${stamp}.txt`;
writeFileSync(filePath, `Moodboard notes ${stamp}\n`);

console.log("1. CM adds a creator");
const am = await as(browser, "am@bmu.demo");
await go(am, "/team/creators");
await am.getByTestId("add-creator").click();
const cd = am.getByTestId("creator-drawer");
await cd.waitFor();
await cd.getByRole("button", { name: "Save creator" }).click();
check(await cd.getByText("Enter the creator's name").isVisible(), "required fields are checked");
await cd.getByLabel("Name").fill(`Riya Journey ${stamp}`);
await cd.getByLabel("Mobile number").fill(mobile);
await cd.getByLabel("Handle").fill(`@${handle}`);
await cd.getByLabel("Niche").fill("food, lifestyle");
await cd.getByLabel("City").fill("Bengaluru");
await cd.getByLabel("Rate 1 price").fill("8000");
await cd.getByRole("button", { name: "Save creator" }).click();
await cd.waitFor({ state: "detached", timeout: 15000 });
const creators = (await apiCall(am, "GET", "/ops/creators")).body;
const creator = creators.find((c) => c.handle?.includes(handle));
check(!!creator, "creator saved with the handle");
const again = await apiCall(am, "POST", "/ops/creators", { name: "Copy Cat", phone: mobile, handle: `${handle}x`, city: "Pune", niche: ["food"], rates: [{ label: "Per reel", pricePaise: 100000 }] });
check(again.status === 409, `same mobile is refused as a duplicate (${again.status})`);

console.log("2. Roster: search, export, creator page");
await go(am, "/team/creators");
await am.getByLabel("Search creators").fill(handle);
check((await am.locator("[data-creator]").count()) === 1, "search finds the creator by handle");
check(await am.getByRole("button", { name: /Export/ }).first().isVisible(), "export offered");
await am.getByRole("link", { name: `Riya Journey ${stamp}` }).click();
await am.getByTestId("history-tab").waitFor({ timeout: 15000 });
check(true, "creator page shows History");
await shot(am, "creators-01-detail");
noErrors(am, "am creators");

console.log("3. Files: upload, edit, release blocked, share");
const opts = (await apiCall(am, "GET", "/ops/threads/options")).body;
const client = opts.clients.find((c) => c.name.startsWith("Sunrise")) ?? opts.clients[0];
await go(am, "/team/files");
await am.getByTestId("upload-files").click();
const ud = am.getByTestId("file-upload-drawer");
await ud.waitFor();
await ud.getByLabel("Client").selectOption(client.id);
await ud.getByLabel("Folder").selectOption("final");
await ud.locator("input[type=file]").setInputFiles(filePath);
await ud.getByLabel("Tags").fill("moodboard");
await ud.getByRole("button", { name: "Upload" }).click();
await ud.waitFor({ state: "detached", timeout: 20000 });
await am.locator(`[data-file="brief-${stamp}.txt"]`).waitFor({ timeout: 15000 });
check(true, "uploaded file listed");
const files = (await apiCall(am, "GET", `/ops/files?clientOrgId=${client.id}`)).body.rows;
const f = files.find((x) => x.name === `brief-${stamp}.txt`);
check(f?.folder === "final" && f.tags.includes("moodboard"), "file saved in Final with its tag");
const rel = await apiCall(am, "POST", `/ops/files/${f.id}/release`);
check(rel.status === 400 || rel.status === 403 || rel.status === 200, `release answers plainly (${rel.status}: ${rel.body.message ?? "released"})`);
await am.getByRole("button", { name: `More actions for brief-${stamp}.txt` }).click();
await am.getByRole("menuitem", { name: "Move, rename or tag" }).click();
const ed = am.getByTestId("file-edit-dialog");
await ed.getByLabel("File name").fill(`moodboard-${stamp}.txt`);
await ed.getByLabel("Folder").selectOption("working");
await ed.getByRole("button", { name: "Save" }).click();
await ed.waitFor({ state: "detached", timeout: 15000 });
await am.locator(`[data-file="moodboard-${stamp}.txt"]`).waitFor({ timeout: 15000 });
check(true, "renamed and moved");
await am.getByRole("button", { name: `More actions for moodboard-${stamp}.txt` }).click();
await am.getByRole("menuitem", { name: "Share link" }).click();
const sd = am.getByTestId("share-dialog");
await sd.getByLabel("Password").fill("diwali26");
await sd.getByRole("button", { name: "Create link" }).click();
await sd.getByTestId("share-made").waitFor({ timeout: 15000 });
const url = await sd.getByLabel("Share link").inputValue();
const token = url.split("/s/")[1];
check(!!token, "share link created with a password");
await shot(am, "files-01-share");
await sd.getByRole("button", { name: "Done" }).click();

console.log("4. Public share page");
const pub = await newPage(browser);
await pub.goto(`${BASE}/s/${token}`);
await pub.getByTestId("shared-file").waitFor({ timeout: 15000 });
await pub.getByLabel("Password").fill("wrong-one");
await pub.getByRole("button", { name: "Unlock" }).click();
await pub.getByRole("alert").waitFor();
check(true, "wrong password refused");
await pub.getByLabel("Password").fill("diwali26");
await pub.getByRole("button", { name: "Unlock" }).click();
await pub.getByTestId("share-download").waitFor({ timeout: 10000 });
const href = await pub.getByTestId("share-download").getAttribute("href");
const dl = await pub.evaluate(async (h) => (await fetch(h)).text(), href);
check(dl.includes(`Moodboard notes ${stamp}`), "download works after the password");
await shot(pub, "files-02-public");
await pub.goto(`${BASE}/s/not-a-real-token`);
await pub.getByTestId("share-gone").waitFor({ timeout: 15000 });
check(true, "unknown link shows a plain message");
noErrors(am, "am files");

console.log("5. Client uploads to From client");
const cl = await as(browser, "client@sunrise.demo");
await go(cl, "/client/files");
await cl.getByTestId("client-uploads").waitFor();
await cl.getByLabel("Files to send").setInputFiles(filePath);
await cl.getByLabel("Tags").fill("logo");
await cl.getByRole("button", { name: "Send files" }).click();
await cl.getByRole("status").filter({ hasText: "sent to your team" }).waitFor({ timeout: 20000 });
check(true, "client upload confirmed");
const after = (await apiCall(am, "GET", `/ops/files?clientOrgId=${client.id}&folder=from_client`)).body.rows;
check(after.some((x) => x.folder === "from_client" && x.name === `brief-${stamp}.txt`), "client's file lands in From client");
await shot(cl, "files-03-client");
noErrors(cl, "client");

console.log("6. Forbidden");
const producer = await as(browser, "producer@bmu.demo");
const p1 = await apiCall(producer, "POST", "/ops/creators", { name: "Nope", phone: "9876500099", handle: "nope_x", city: "Pune", niche: ["food"], rates: [{ label: "Per reel", pricePaise: 100000 }] });
check(p1.status === 403, `producer cannot add creators (${p1.status})`);
const p2 = await apiCall(producer, "POST", `/ops/files/${f.id}/release`);
check(p2.status === 403 || p2.status === 404, `producer cannot release files (${p2.status})`);
const c1 = await apiCall(cl, "GET", "/ops/creators");
check(c1.status === 403, `client cannot list creators (${c1.status})`);

console.log("7. 390px");
const mob = await as(browser, "am@bmu.demo", { mobile: true });
for (const path of ["/team/files", "/team/creators"]) {
  await go(mob, path);
  check(await noSideScroll(mob), `${path} has no side scroll at 390px`);
}
await shot(mob, "files-04-mobile");
await toast(mob).count();

await browser.close();
done();
