import Image from "next/image";
import Link from "next/link";

/**
 * The BMU Marketing logo, used everywhere: public header and footer, the signed-in app's menu, the Security page and
 * approval certificates. The image is a JPEG on white; `mix-blend-multiply` makes its white disappear on the light
 * backgrounds it sits on (white pages, the ivory side menu). `size` is the height in pixels.
 * `href` is the public site by default; signed-in pages pass the person's own home, so the logo never takes them out
 * of the CRM.
 */
/** seeThrough: v54 redesign sidebar (glass): the see-through logo file, so no white box shows on the glass. */
export function Logo({ className = "", size = 32, href = "/", seeThrough = false }: { className?: string; size?: number; href?: string; seeThrough?: boolean }) {
  return (
    <Link href={href} className={`inline-flex shrink-0 items-center ${className}`} aria-label={href === "/" ? "BMU Marketing home" : "BMU Hub home"}>
      {seeThrough ? (
        <Image src="/bmu-logo.png" alt="BMU Marketing" width={556} height={256} priority style={{ height: size, width: "auto" }} className="logo-for-light-theme" />
      ) : (
        <Image src="/bmu-marketing-logo.jpg" alt="BMU Marketing" width={556} height={256} priority style={{ height: size, width: "auto" }} className="logo-for-light-theme mix-blend-multiply" />
      )}
      {/* v54: the white logo for the dark theme (shown only when the moon icon has switched it on). */}
      <Image src="/bmu-logo-white.png" alt="" aria-hidden width={556} height={256} style={{ height: size, width: "auto" }} className="logo-for-dark-theme hidden" />
    </Link>
  );
}
