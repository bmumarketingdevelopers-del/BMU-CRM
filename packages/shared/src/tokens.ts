// BMU design tokens. Source: Brand kit and UX study + design_system.fallback_tokens in the spec.
// Uploaded UX/UI design files override these values.
export const colors = {
  charcoal: "#121F2F",
  green: "#8BB72C",
  ivory: "#F8F7F4",
  grey: "#C2C2C2",
  paper: "#FFFFFF",
  muted: "#5E6672",
  line: "#E4E3DE",
  canvas: "#ECEBE6",
  statusAmber: "#F2D27A",
  statusRed: "#E7735C",
} as const;

export const fonts = {
  display: "Zen Dots",
  body: "Albert Sans",
} as const;

export type ColorToken = keyof typeof colors;

/** Shown in the footer and sign-in page so it's clear which build is running. */
export const APP_VERSION = "v21 · 7 Oct 2026";
