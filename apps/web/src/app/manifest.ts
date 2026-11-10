import type { MetadataRoute } from "next";

/**
 * v45 installable app: what Chrome and Edge need to offer "Install BMU Hub" (the icon in the address bar, and the
 * button in the sidebar). Installed, BMU Hub opens in its own window with a desktop / Start menu / taskbar icon.
 * It is the same website underneath: no offline copy is kept, so every release reaches it on the next page load.
 * Served at /manifest.webmanifest; Next.js adds the <link rel="manifest"> to every page.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/start",
    name: "BMU Hub",
    short_name: "BMU Hub",
    description: "BMU Marketing's workspace: My Day, tasks, clients, approvals and reports.",
    // Opens on each person's own home (Command Centre, My Day, client or creator portal), or sign-in.
    start_url: "/start",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#121f2f",
    theme_color: "#121f2f",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
