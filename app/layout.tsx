import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CourtMate | Better court-sport groups",
  description: "Find your people. Fill the court. Play the right game.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/courtmate-icon.png", type: "image/png" },
      { url: "/courtmate-icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/courtmate-icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/courtmate-icon-192.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "CourtMate",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#d7f23f",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
