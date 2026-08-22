import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CourtMate | Better pickleball groups",
  description: "Find your people. Fill the court. Play the right game.",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
