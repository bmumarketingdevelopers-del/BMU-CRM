import { redirect } from "next/navigation";
import { homePathFor } from "@bmu/shared";
import { requireMe } from "@/lib/session";

/**
 * v45: where the installed BMU Hub app opens (manifest start_url). Signed in: their own home (Command Centre, My Day,
 * client or creator portal). Not signed in: sign-in (requireMe sends them there).
 */
export default async function Start() {
  const me = await requireMe();
  redirect(homePathFor(me));
}
