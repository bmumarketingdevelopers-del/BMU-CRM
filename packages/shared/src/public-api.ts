// v19 public REST API v1: one route table drives the server's OpenAPI document and the TypeScript SDK below.
// Every request needs `Authorization: Bearer bmu_…` (an API key made in Admin → API & Webhooks). The key acts as the
// person who made it, limited to its scopes, so the normal permission rules, validation and audit log apply.
import type { ApiScope } from "./integrations-types.js";

export type PublicLead = { id: string; name: string; company: string | null; email: string | null; phone: string | null; stage: string; source: string | null; owner: string | null; createdAt: string; updatedAt: string };
export type PublicClient = { id: string; name: string; industry: string | null; gstin: string | null; accountManager: string | null; health: string; createdAt: string };
export type PublicProject = { id: string; clientId: string; client: string; service: string; status: string; createdAt: string };
export type PublicTask = { id: string; title: string; status: string; priority: string; deadline: string | null; owner: string | null; projectId: string | null; clientId: string | null; createdAt: string };
export type PublicInvoice = { id: string; number: string; clientId: string | null; client: string | null; status: string; subtotalPaise: number; gstPaise: number; totalPaise: number; paidPaise: number; dueDate: string; createdAt: string };
export type PublicPost = { id: string; title: string; clientId: string; client: string; channel: string | null; status: string; scheduledAt: string | null; publishedAt: string | null; liveUrl: string | null };
export type PublicService = { id: string; name: string };
export type PublicPerson = { id: string; name: string; email: string | null; roles: string[]; departmentId: string | null };
export type PublicDepartment = { id: string; name: string };
export type PublicMe = { key: { name: string; prefix: string; scopes: ApiScope[]; rateLimitPerMin: number }; actsAs: { id: string; name: string } };
export type PublicPage<T> = { data: T[]; nextCursor: string | null };

export type PublicLeadCreate = {
  name: string;
  phone: string;
  company: string;
  email?: string;
  source?: string;
  /** Service ids from GET /v1/services. */
  serviceIds: string[];
  need?: string;
  budgetRupees?: number;
  /** Add even if a lead with the same phone or email exists. */
  confirmDuplicate?: boolean;
};
export type PublicTaskCreate = {
  title: string;
  /** Project id from GET /v1/projects, or set internal: true. */
  projectId?: string;
  internal?: boolean;
  departmentId: string;
  ownerId: string;
  /** YYYY-MM-DD or an ISO date-time. */
  deadline: string;
  priority?: "urgent" | "high" | "normal" | "low";
  description?: string;
};

type Param = { name: string; in: "path" | "query"; description: string; required?: boolean };
export type PublicRoute = {
  id: string;
  method: "GET" | "POST";
  path: string;
  scope: ApiScope | null;
  summary: string;
  params?: Param[];
  /** Field → description, for the request body. */
  body?: Record<string, string>;
  returns: string;
};

const page: Param[] = [
  { name: "limit", in: "query", description: "1 to 100 (default 50)" },
  { name: "cursor", in: "query", description: "nextCursor from the previous page" },
  { name: "updatedSince", in: "query", description: "ISO date-time: only records created or changed since then" },
];

export const PUBLIC_ROUTES: PublicRoute[] = [
  { id: "me", method: "GET", path: "/v1/me", scope: null, summary: "The key and the person it acts as", returns: "PublicMe" },
  { id: "listLeads", method: "GET", path: "/v1/leads", scope: "leads:read", summary: "Leads, newest first", params: [...page, { name: "stage", in: "query", description: "new, contacted, discovery, proposal_sent, won or lost" }], returns: "PublicPage<PublicLead>" },
  { id: "getLead", method: "GET", path: "/v1/leads/{id}", scope: "leads:read", summary: "One lead", params: [{ name: "id", in: "path", description: "Lead id", required: true }], returns: "PublicLead" },
  {
    id: "createLead",
    method: "POST",
    path: "/v1/leads",
    scope: "leads:write",
    summary: "Add a lead (assigned to the sales team like any new lead)",
    body: { name: "Contact name (required)", phone: "10-digit Indian mobile (required)", company: "Business name (required)", email: "Email", source: "website, referral, phone, instagram, facebook_ads, google_ads, event, other… (default other)", serviceIds: "Service ids from GET /v1/services (at least one)", need: "What they need", budgetRupees: "Budget in rupees", confirmDuplicate: "true to add even if it looks like a duplicate" },
    returns: "PublicLead",
  },
  { id: "listServices", method: "GET", path: "/v1/services", scope: "leads:write", summary: "Service ids for new leads", returns: "PublicService[]" },
  { id: "listClients", method: "GET", path: "/v1/clients", scope: "clients:read", summary: "Clients the key's person can see", params: page, returns: "PublicPage<PublicClient>" },
  { id: "getClient", method: "GET", path: "/v1/clients/{id}", scope: "clients:read", summary: "One client", params: [{ name: "id", in: "path", description: "Client id", required: true }], returns: "PublicClient" },
  { id: "listProjects", method: "GET", path: "/v1/projects", scope: "projects:read", summary: "Projects (services a client bought)", params: [...page, { name: "clientId", in: "query", description: "Only this client's projects" }], returns: "PublicPage<PublicProject>" },
  { id: "listTasks", method: "GET", path: "/v1/tasks", scope: "tasks:read", summary: "Tasks the key's person can see", params: [...page, { name: "projectId", in: "query", description: "Only this project's tasks" }, { name: "status", in: "query", description: "todo, in_progress, done…" }], returns: "PublicPage<PublicTask>" },
  {
    id: "createTask",
    method: "POST",
    path: "/v1/tasks",
    scope: "tasks:write",
    summary: "Create a task (same rules as the app: leave, workload, department)",
    body: { title: "Title (required)", projectId: "Project id, or internal: true", internal: "true for internal work", departmentId: "Department id from GET /v1/departments", ownerId: "Person id from GET /v1/people", deadline: "YYYY-MM-DD", priority: "urgent, high, normal or low", description: "Details" },
    returns: "PublicTask",
  },
  { id: "listPeople", method: "GET", path: "/v1/people", scope: "tasks:read", summary: "Active team members", returns: "PublicPerson[]" },
  { id: "listDepartments", method: "GET", path: "/v1/departments", scope: "tasks:read", summary: "Departments", returns: "PublicDepartment[]" },
  { id: "listInvoices", method: "GET", path: "/v1/invoices", scope: "invoices:read", summary: "Invoices (Finance and leadership keys)", params: [...page, { name: "clientId", in: "query", description: "Only this client's invoices" }, { name: "status", in: "query", description: "issued, partially_paid, paid, overdue…" }], returns: "PublicPage<PublicInvoice>" },
  { id: "getInvoice", method: "GET", path: "/v1/invoices/{id}", scope: "invoices:read", summary: "One invoice", params: [{ name: "id", in: "path", description: "Invoice id", required: true }], returns: "PublicInvoice" },
  { id: "listPosts", method: "GET", path: "/v1/posts", scope: "content:read", summary: "Scheduled and published posts", params: [...page, { name: "clientId", in: "query", description: "Only this client's posts" }], returns: "PublicPage<PublicPost>" },
];

/** Minimal TypeScript SDK for the public API. Works in Node 18+ and browsers (fetch). */
export function createBmuClient(opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch }) {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  const call = async <T>(method: "GET" | "POST", path: string, query?: Record<string, string | number | undefined>, body?: unknown): Promise<T> => {
    const qs = query ? new URLSearchParams(Object.entries(query).filter((e): e is [string, string | number] => e[1] !== undefined).map(([k, v]) => [k, String(v)])).toString() : "";
    const res = await f(`${base}${path}${qs ? `?${qs}` : ""}`, { method, headers: { authorization: `Bearer ${opts.apiKey}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const message = (json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      throw Object.assign(new Error(message), { status: res.status, body: json });
    }
    return json as T;
  };
  type PageQ = { limit?: number; cursor?: string; updatedSince?: string };
  return {
    me: () => call<PublicMe>("GET", "/v1/me"),
    leads: {
      list: (q: PageQ & { stage?: string } = {}) => call<PublicPage<PublicLead>>("GET", "/v1/leads", q),
      get: (id: string) => call<PublicLead>("GET", `/v1/leads/${encodeURIComponent(id)}`),
      create: (body: PublicLeadCreate) => call<PublicLead>("POST", "/v1/leads", undefined, body),
    },
    services: () => call<PublicService[]>("GET", "/v1/services"),
    clients: {
      list: (q: PageQ = {}) => call<PublicPage<PublicClient>>("GET", "/v1/clients", q),
      get: (id: string) => call<PublicClient>("GET", `/v1/clients/${encodeURIComponent(id)}`),
    },
    projects: { list: (q: PageQ & { clientId?: string } = {}) => call<PublicPage<PublicProject>>("GET", "/v1/projects", q) },
    tasks: {
      list: (q: PageQ & { projectId?: string; status?: string } = {}) => call<PublicPage<PublicTask>>("GET", "/v1/tasks", q),
      create: (body: PublicTaskCreate) => call<PublicTask>("POST", "/v1/tasks", undefined, body),
    },
    people: () => call<PublicPerson[]>("GET", "/v1/people"),
    departments: () => call<PublicDepartment[]>("GET", "/v1/departments"),
    invoices: {
      list: (q: PageQ & { clientId?: string; status?: string } = {}) => call<PublicPage<PublicInvoice>>("GET", "/v1/invoices", q),
      get: (id: string) => call<PublicInvoice>("GET", `/v1/invoices/${encodeURIComponent(id)}`),
    },
    posts: { list: (q: PageQ & { clientId?: string } = {}) => call<PublicPage<PublicPost>>("GET", "/v1/posts", q) },
  };
}
