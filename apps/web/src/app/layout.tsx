import type { Metadata } from "next";
import { Albert_Sans, Zen_Dots } from "next/font/google";
import { StartupScripts } from "@/components/startup-scripts";
import "./globals.css";

const zenDots = Zen_Dots({ variable: "--font-zen-dots", weight: "400", subsets: ["latin"] });
const albertSans = Albert_Sans({ variable: "--font-albert-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "BMU Marketing | Build My Universee",
  description: "Marketing, branding, web and content for growing businesses in Bengaluru.",
  // v45: added to an iPhone / iPad Home Screen, BMU Hub opens full screen under this name.
  appleWebApp: { capable: true, title: "BMU Hub", statusBarStyle: "default" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className={`${zenDots.variable} ${albertSans.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col font-sans">
        {/* v45 install-app catcher + v54 theme setter: put in the page head by the server only, so they run before the
            page paints and React never re-renders them in the browser (components/startup-scripts.tsx). */}
        <StartupScripts />
        {children}
      </body>
    </html>
  );
}
