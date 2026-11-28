// v54 redesign font: Outfit (picked by Hari), used only in the redesign preview; everyone else keeps Albert Sans.
// Kept in a plain module (not a "use client" one) so both the server app frame and client pieces can use it.
import { Outfit } from "next/font/google";

export const outfit = Outfit({ variable: "--font-outfit", subsets: ["latin"] });
