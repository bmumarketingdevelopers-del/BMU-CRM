import Link from "next/link";

/** v12: shown on a dashboard to the Founder and Admins, opens it in the Dashboard Studio. */
export function CustomiseLink({ id }: { id: string }) {
  return (
    <Link href={`/admin/dashboards/${id}`} className="text-sm text-ink-muted hover:text-ink" data-testid="customise-dashboard">
      Customise this dashboard
    </Link>
  );
}
