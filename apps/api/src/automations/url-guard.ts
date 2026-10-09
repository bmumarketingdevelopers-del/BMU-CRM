// Webhook safety: only public http/https addresses. Blocks localhost, private, link-local and
// carrier-grade NAT ranges, both for IP literals and for names that resolve to them.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function ipv4Private(ip: string) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4Private(mapped[1]);
    if (/^::ffff:/.test(s)) return true;
    if (/^f[cd]/.test(s)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(s)) return true; // fe80::/10 link local
    return false;
  }
  return false;
}

/** Problem with a webhook URL without DNS (for saving a rule), or null when it looks fine. */
export function webhookUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'Enter a full web address starting with https://';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Webhooks must use http or https';
  if (u.username || u.password) return 'Do not put a username or password in the webhook address';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') {
    return 'Webhooks cannot call this computer or the private network';
  }
  if (isIP(host) && isPrivateIp(host)) return 'Webhooks cannot call this computer or the private network';
  return null;
}

/** Full check including DNS: every address the name resolves to must be public. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const problem = webhookUrlProblem(raw);
  if (problem) throw new Error(problem);
  const u = new URL(raw);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host)) {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Webhooks cannot call this computer or the private network');
  }
  return u;
}
