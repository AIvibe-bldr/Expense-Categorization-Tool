import { serviceNames, type Transaction, type Category } from "./types";

function safe(s: string) {
  return /^[=+@\-\t\r]/.test(s) ? "\'" + s : s;
}

/** Editable ledger: every row from the selected year remains visible. */
export function spreadsheetReport(
  transactions: Omit<Transaction, "raw_encrypted">[],
  categories: Category[],
  year: number,
) {
  const categoryLabel = (id: string | null) => {
    const c = categories.find((c) => c.id === id);
    if (!c) return "未分類";
    const parent = categories.find((p) => p.id === c.parent_id);
    return `${parent?.name ?? ""} › ${c.name} (${c.year} ${c.source_cell})`;
  };
  return {
    title: `${year}年 項目別明細`,
    rows: [
      [
        "振り分け項目",
        "日付",
        "利用先",
        "出金額",
        "入金額",
        "サービス",
        "口座・カード",
        "備考",
      ],
      ...transactions
        .filter((t) => t.transaction_date.startsWith(`${year}-`))
        .sort(
          (a, b) =>
            categoryLabel(a.category_id).localeCompare(
              categoryLabel(b.category_id),
              "ja",
            ) || a.transaction_date.localeCompare(b.transaction_date),
        )
        .map((t) => [
          safe(categoryLabel(t.category_id)),
          t.transaction_date,
          safe(t.merchant_original),
          t.direction === "out" ? t.amount : 0,
          t.direction === "in" ? t.amount : 0,
          serviceNames[t.source_service],
          safe(t.account_id),
          safe(
            [t.excluded ? "重複除外" : "", t.purpose_note]
              .filter(Boolean)
              .join(" / "),
          ),
        ]),
    ],
  };
}
