import Link from "next/link";

/** BMU wordmark: the only place the Zen Dots display face is used. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <Link href="/" className={`font-logo text-lg tracking-wide ${className}`} aria-label="BMU Marketing home">
      BMU<span className="text-green">.</span>
    </Link>
  );
}
