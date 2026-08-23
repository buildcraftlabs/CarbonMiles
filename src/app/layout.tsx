import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// `globals.css` maps Tailwind's `--font-sans` straight through to this
// variable, so the name here is load-bearing: rename it and every `font-sans`
// utility silently falls back to the browser's default serif.
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Carbon Miles — mobility intelligence for India",
  description:
    "Which vehicle to buy, given how you actually drive and where you actually live — and whether the one you already own can run on E20. Computed from a curated database, with the assumptions and sources shown.",
};

export const viewport: Viewport = {
  themeColor: "#05100c",
  colorScheme: "dark light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
