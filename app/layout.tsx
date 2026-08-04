import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geist = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Mellerick App",
  description: "Mellerick Plumbing Business Management",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Mellerick",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning is scoped to THIS element's attributes and does
    // not affect children. Browser extensions inject attributes into <html>
    // before React hydrates — Scribe adds data-scribe-recorder-ready, password
    // managers and theme switchers do similar — and React then reports a
    // hydration mismatch that looks like an app bug and is not. Suppressing it
    // here removes a recurring false alarm that costs every developer with such
    // an extension the same wasted investigation.
    //
    // The trade-off, stated plainly: a genuine server/client mismatch in the
    // <html> attributes themselves would now go unreported. Nothing dynamic is
    // rendered there — lang and className are both static — so there is nothing
    // for that to hide.
    <html lang="en" className={`${geist.variable} h-full`} suppressHydrationWarning>
      <body className="h-full antialiased">
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
