import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Analytics } from "@/components/analytics";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { withBase } from "@/lib/base-path";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

// The manifest link is added by app/manifest.ts; Next.js prefixes it with the base path itself.
export const metadata: Metadata = {
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  icons: {
    icon: [
      { url: withBase("/icon.svg"), type: "image/svg+xml" },
      { url: withBase("/icon-192.png"), sizes: "192x192", type: "image/png" },
    ],
    apple: withBase("/apple-touch-icon.png"),
  },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: SITE_NAME },
};

export const viewport: Viewport = { themeColor: "#f5f0e4", colorScheme: "light", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body id="top">{children}<ServiceWorkerRegister /><Analytics /></body></html>;
}
