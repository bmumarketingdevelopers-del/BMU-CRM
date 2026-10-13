import Image from "next/image";
import Link from "next/link";

/**
 * The BMU Marketing logo, used everywhere: public header and footer, the signed-in app's menu, the Security page and
 * approval certificates. The image is a JPEG on white; `mix-blend-multiply` makes its white disappear on the light
 * backgrounds it sits on (white pages, the ivory side menu). `size` is the height in pixels.
 */
export function Logo({ className = "", size = 32 }: { className?: string; size?: number }) {
  return (
    <Link href="/" className={`inline-flex shrink-0 items-center ${className}`} aria-label="BMU Marketing home">
      <Image src="/bmu-marketing-logo.jpg" alt="BMU Marketing" width={556} height={256} priority style={{ height: size, width: "auto" }} className="mix-blend-multiply" />
    </Link>
  );
}
