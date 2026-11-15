import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "GALAPAGOS | CSV → Excel",
  description: "CSVを取り込み、項目別のExcelを作成",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
