import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "GALAPAGOS | 支出管理",
  description: "購入支出・銀行出金・資金移動を分けて管理",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
