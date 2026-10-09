import { NextResponse, type NextRequest } from "next/server";

/** Optimistic check: no session cookie on a signed-in surface goes straight to sign-in. */
export function proxy(request: NextRequest) {
  if (!request.cookies.has("bmu_session")) {
    const url = new URL("/sign-in", request.url);
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/team/:path*", "/client/:path*", "/creator/:path*"],
};
