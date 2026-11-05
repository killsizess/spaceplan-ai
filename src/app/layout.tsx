import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/onest";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpacePlan AI — редактор пространства",
  description:
    "Создавайте планировки, редактируйте комнаты и рассчитывайте площади в SpacePlan AI.",
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
