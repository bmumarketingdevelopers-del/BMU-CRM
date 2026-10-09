// v19: OpenAPI 3.1 description of the public API, built from the shared route table (packages/shared/src/public-api.ts)
// so the document, the server routes and the TypeScript SDK never drift apart.
import { API_SCOPES, apiScopeLabels, PUBLIC_ROUTES, WEBHOOK_EVENTS } from '@bmu/shared';
import { apiPublicUrl } from './integrations.service.js';

const str = { type: 'string' };
const strN = { type: ['string', 'null'] };
const int = { type: 'integer' };
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required });

const SCHEMAS: Record<string, unknown> = {
  PublicLead: obj({ id: str, name: str, company: strN, email: strN, phone: strN, stage: str, source: strN, owner: strN, createdAt: str, updatedAt: str }),
  PublicClient: obj({ id: str, name: str, industry: strN, gstin: strN, accountManager: strN, health: str, createdAt: str }),
  PublicProject: obj({ id: str, clientId: str, client: str, service: str, status: str, createdAt: str }),
  PublicTask: obj({ id: str, title: str, status: str, priority: str, deadline: strN, owner: strN, projectId: strN, clientId: strN, createdAt: str }),
  PublicInvoice: obj({ id: str, number: str, clientId: strN, client: strN, status: str, subtotalPaise: int, gstPaise: int, totalPaise: int, paidPaise: int, dueDate: str, createdAt: str }),
  PublicPost: obj({ id: str, title: str, clientId: str, client: str, channel: strN, status: str, scheduledAt: strN, publishedAt: strN, liveUrl: strN }),
  PublicService: obj({ id: str, name: str }),
  PublicPerson: obj({ id: str, name: str, email: strN, roles: { type: 'array', items: str }, departmentId: strN }),
  PublicDepartment: obj({ id: str, name: str }),
  PublicMe: obj({ key: obj({ name: str, prefix: str, scopes: { type: 'array', items: str }, rateLimitPerMin: int }), actsAs: obj({ id: str, name: str }) }),
  Error: obj({ statusCode: int, message: str }, ['message']),
  WebhookPayload: obj({ id: str, type: str, occurredAt: str, entity: str, entityId: str, data: { type: ['object', 'null'] } }),
};

const responseSchema = (returns: string) => {
  const page = /^PublicPage<(\w+)>$/.exec(returns);
  if (page) return obj({ data: { type: 'array', items: { $ref: `#/components/schemas/${page[1]}` } }, nextCursor: strN });
  if (returns.endsWith('[]')) return { type: 'array', items: { $ref: `#/components/schemas/${returns.slice(0, -2)}` } };
  return { $ref: `#/components/schemas/${returns}` };
};

export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of PUBLIC_ROUTES) {
    const op: Record<string, unknown> = {
      operationId: r.id,
      summary: r.summary,
      description: r.scope ? `Needs the \`${r.scope}\` scope (${apiScopeLabels[r.scope]}).` : 'Any valid key.',
      security: [{ apiKey: [] }],
      parameters: (r.params ?? []).map((p) => ({ name: p.name, in: p.in, required: p.in === 'path' || !!p.required, description: p.description, schema: str })),
      responses: {
        [r.method === 'POST' ? '201' : '200']: { description: 'OK', content: { 'application/json': { schema: responseSchema(r.returns) } } },
        '400': { description: 'Invalid input (the message says what to fix)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Missing, revoked or expired key' },
        '403': { description: 'The key lacks the scope, or its person lacks the permission' },
        '429': { description: 'Rate limit reached (see Retry-After)' },
      },
    };
    if (r.body) op.requestBody = { required: true, content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(Object.entries(r.body).map(([k, d]) => [k, { description: d }])) } } } };
    (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'BMU Hub API',
      version: '1.0.0',
      description: [
        'Read and create BMU Hub records from your own tools. Create a key in Admin → API & Webhooks and send it as `Authorization: Bearer bmu_…`.',
        'A key acts as the person who made it, so it sees and changes only what that person can, and only within its scopes.',
        `Scopes: ${API_SCOPES.map((s) => `\`${s}\``).join(', ')}. Lists are newest first; pass \`nextCursor\` back as \`cursor\` for the next page.`,
        'Money is in paise (₹1 = 100). Each key has a per-minute limit (X-RateLimit-Limit / X-RateLimit-Remaining headers).',
        `Webhooks: BMU POSTs a WebhookPayload to your URL for the events you pick (for example ${WEBHOOK_EVENTS.slice(0, 4).map((e) => `\`${e.type}\``).join(', ')}). Check X-BMU-Signature = "sha256=" + hex HMAC-SHA256(secret, X-BMU-Timestamp + "." + raw body). Failed deliveries are retried for about a day.`,
      ].join('\n\n'),
    },
    servers: [{ url: apiPublicUrl() }],
    components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'bmu_… key' } }, schemas: SCHEMAS },
    paths,
  };
}
