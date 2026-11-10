import type { Metadata } from "next";
import { Albert_Sans, Zen_Dots } from "next/font/google";
import { INSTALL_CATCHER } from "@/lib/install-app";
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
    <html lang="en-IN" className={`${zenDots.variable} ${albertSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        {/* v45: keeps Chrome's / Edge's "can be installed" signal for the Install BMU Hub app button (src/lib/install-app.ts). */}
        <script dangerouslySetInnerHTML={{ __html: INSTALL_CATCHER }} />
        {children}
      </body>
    </html>
  );
}
