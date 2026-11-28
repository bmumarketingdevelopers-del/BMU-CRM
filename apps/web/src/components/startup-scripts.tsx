"use client";

/**
 * The two tiny startup scripts every page needs before it paints:
 * - INSTALL_CATCHER (v45): keeps Chrome's / Edge's "can be installed" signal for the Install BMU Hub app button.
 * - THEME_SETTER (v54): applies the theme chosen with the moon icon, so there is no white flash in dark.
 *
 * They go into the server's HTML only (Next.js useServerInsertedHTML puts them in the page head), so they run at once,
 * as the page loads, exactly as before. React never renders them in the browser, so React can't warn "Encountered a
 * script tag while rendering React component" (it did when a page re-built itself in the browser after an error).
 */
import { useRef } from "react";
import { useServerInsertedHTML } from "next/navigation";
import { INSTALL_CATCHER } from "@/lib/install-app";
import { THEME_SETTER } from "@/lib/theme";

export function StartupScripts() {
  const inserted = useRef(false);
  useServerInsertedHTML(() => {
    if (inserted.current) return null;
    inserted.current = true;
    return (
      <>
        <script id="bmu-install-catcher" dangerouslySetInnerHTML={{ __html: INSTALL_CATCHER }} />
        <script id="bmu-theme-setter" dangerouslySetInnerHTML={{ __html: THEME_SETTER }} />
      </>
    );
  });
  return null;
}
