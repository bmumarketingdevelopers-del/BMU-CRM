import type { Metadata } from "next";
import { Albert_Sans, Zen_Dots } from "next/font/google";
import "./globals.css";

const zenDots = Zen_Dots({ variable: "--font-zen-dots", weight: "400", subsets: ["latin"] });
const albertSans = Albert_Sans({ variable: "--font-albert-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "BMU Marketing | Build My Universee",
  description: "Marketing, branding, web and content for growing businesses in Bengaluru.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className={`${zenDots.variable} ${albertSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
