// v54: light / dark theme. The moon icon at the top right (TopBar) switches it; the choice is kept in this browser.
// The root layout runs THEME_SETTER before the page paints, so a dark page never flashes white.
export const THEME_KEY = "bmu.theme";
export type Theme = "light" | "dark";

export const THEME_SETTER = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`;

export function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function applyTheme(t: Theme) {
  if (t === "dark") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* storage blocked: the theme still changes for this visit */
  }
}
