import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "GALAPAGOS | お金の使い道",
  description: "CSVから自分の資金用途を分類し、利用月ごとに記録",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
