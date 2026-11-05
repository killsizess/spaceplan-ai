import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/onest";
import { APP_VERSION } from "@/lib/app-version";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpacePlan AI",
  description: "Check what can be changed in an apartment, and what it would take.",
  other: { "app-version": APP_VERSION },
  // Not launched yet: the legal wording of the report comes first (see the product plan).
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
