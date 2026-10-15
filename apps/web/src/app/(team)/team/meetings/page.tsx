import { TeamMeetings } from "@/components/comms/meetings";
import { requireMe } from "@/lib/session";

export default async function MeetingsPage() {
  const me = await requireMe();
  // v23: Founders get "Meet a client", which goes through the client's Client Manager.
  return <TeamMeetings isFounder={me.roles.includes("founder")} />;
}
