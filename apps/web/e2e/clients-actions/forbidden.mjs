// Journey: forbidden roles. Buttons are hidden for people who can't use them, and the API refuses them with a
// plain-English 403 anyway: AM can't add clients or reassign AMs, a designer can't see the client list, Finance
// can't add clients, a client can't use team endpoints, a client Viewer can't change account settings.
// Run: BASE_URL=http://localhost:3000 node apps/web/e2e/clients-actions/forbidden.mjs
import { apiCall, as, check, done, go, launch, noErrors, shot } from "./lib.mjs";

const browser = await launch();
const body = { businessName: "Should Not Exist", contactName: "No Body", contactPhone: "9000000001", contactEmail: "nobody@example.com", industry: "Retail", billingName: "No LLP", billingAddress: "Nowhere road 1", branchId: "x" };

console.log("Account Manager");
const am = await as(browser, "am@bmu.demo");
await go(am, "/team/clients");
await am.locator("[data-client-row]").first().waitFor({ timeout: 15000 });
check(!(await am.getByTestId("clients-add").count()), "AM sees no + Add on the Clients list");
check(!(await am.getByRole("button", { name: "Migrate existing client" }).count()), "AM sees no Migrate");
let r = await apiCall(am, "POST", "/clients-actions", body);
check(r.status === 403 && /Founder|Admin|Sales Manager|AM Lead/.test(r.body.message), "API: AM can't add a client (403, says who can)");
await am.locator("[data-client-row] a").first().click();
await am.getByTestId("client360-actions").waitFor();
check(!(await am.getByRole("button", { name: "Reassign AM" }).count()), "AM sees no Reassign AM on Client 360");
const id = am.url().split("/team/clients/")[1].split("?")[0];
r = await apiCall(am, "POST", "/actions/reassign/client_am/apply", { ids: [id], toUserId: "someone", reason: "overload", handoverNote: "x" });
check(r.status === 403, "API: AM can't reassign the AM (403)");
r = await apiCall(am, "POST", `/clients-actions/${id}/offboard`, { reason: "No reason", lastCycle: "2026-10" });
check(r.status === 403, "API: AM can't offboard (403)");
await shot(am, "30-am-client360");
noErrors(am, "AM");

console.log("Designer");
const design = await as(browser, "design@bmu.demo");
r = await apiCall(design, "GET", "/clients-actions/list");
check(r.status === 403, "API: designer can't list clients (403)");
r = await apiCall(design, "PATCH", `/clients-actions/${id}`, { contactName: "Nope Nope" });
check(r.status === 403, "API: designer can't edit a client (403)");
r = await apiCall(design, "POST", "/clients-actions/requests", { engagementId: "x", type: "change", description: "Change something" });
check(r.status === 403, "API: designer can't raise a request for a client (403)");

console.log("Finance");
const fin = await as(browser, "finance@bmu.demo");
await go(fin, "/team/clients");
await fin.locator("[data-client-row]").first().waitFor({ timeout: 15000 }).catch(() => {});
check(!(await fin.getByTestId("clients-add").count()), "Finance sees no + Add");
r = await apiCall(fin, "POST", "/clients-actions", body);
check(r.status === 403, "API: Finance can't add a client (403)");
r = await apiCall(fin, "PATCH", `/clients-actions/${id}`, { contactName: "Nope Nope" });
check(r.status === 403 && /billing/i.test(r.body.message), "API: Finance can't change contact details (403, billing only)");

console.log("Client users");
const client = await as(browser, "client@sunrise.demo");
r = await apiCall(client, "GET", "/clients-actions/list");
check(r.status === 403, "API: client can't use team client endpoints (403)");
await go(client, "/client/settings");
await client.getByText("Account and services").first().waitFor({ timeout: 15000 });
check(true, "client Settings page opens");
await shot(client, "31-client-settings");
noErrors(client, "client settings");
const viewer = await as(browser, "approver@sunrise.demo");
r = await apiCall(viewer, "PATCH", "/client-actions/contact", { contactName: "Not Owner", contactPhone: "9876543210", contactEmail: "x@example.com" });
check(r.status === 403 && /Owner/.test(r.body.message), "API: a non-Owner client user can't change account details (403)");
await go(viewer, "/client/settings");
await viewer.getByText("Main contact").waitFor({ timeout: 15000 });
check(!(await viewer.getByRole("button", { name: "Edit" }).count()), "non-Owner sees no Edit on Settings");

await browser.close();
done();
