import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpacePlan AI — редактор пространства",
  description:
    "Создавайте планировки, редактируйте комнаты и рассчитывайте площади в SpacePlan AI.",
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
