"use client";

import { useEffect } from "react";

/** A document's file name: no characters that Windows, Mac or phones refuse ("BMU/Q/2026/1003" → "BMU-Q-2026-1003"). */
export const documentName = (...parts: (string | null | undefined)[]) =>
  parts
    .map((p) => (p ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" - ")
    .slice(0, 150);

/**
 * "Save as PDF" names the file after the page title, so while a document is open the page is called what its PDF should
 * be. Set again just before printing, in case something else changed the title meanwhile.
 */
export function usePrintTitle(name: string) {
  useEffect(() => {
    const before = document.title;
    const set = () => {
      document.title = name;
    };
    set();
    window.addEventListener("beforeprint", set);
    return () => {
      window.removeEventListener("beforeprint", set);
      if (document.title === name) document.title = before;
    };
  }, [name]);
}
