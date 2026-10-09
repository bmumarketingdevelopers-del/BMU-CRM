// v13 live updates: the browser's live stream (EventSource on /api/realtime/stream). Served here rather than through
// the /api rewrite because the rewrite proxy closes requests after 30 seconds and holds connections it no longer needs;
// this handler streams the API's events through for as long as the tab is open and stops the moment it closes.
import { API_URL } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/realtime/stream`, {
      headers: { cookie: req.headers.get("cookie") ?? "", accept: "text/event-stream" },
      signal: req.signal,
      cache: "no-store",
    });
  } catch {
    return new Response("Live updates are not reachable right now", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) return new Response(await upstream.text().catch(() => ""), { status: upstream.status });
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform also stops response compression, which would hold messages back.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
