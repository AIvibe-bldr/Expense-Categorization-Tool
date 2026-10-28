import { colorHex } from "./colors";
import { effectiveCategories, purchaseAmount, sum, summary } from "./engine";
import { type State, serviceNames } from "./types";
export type Report = {
  title: string;
  rows: (string | number)[][];
  colors?: Record<number, string>;
};
function safe(s: string) {
  return /^[=+@\-\t\r]/.test(s) ? "'" + s : s;
}
export function reports(s: State, year: number): Report[] {
  const categories = effectiveCategories(s);
  const month = `${year}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`,
    stats = summary(s, month);
  const monthly: Report = {
    title: `${year}年 月別経費`,
    rows: [
      [
        "分類ID",
        "分類",
        ...Array.from({ length: 12 }, (_, i) => `${i + 1}月`),
        "年間合計",
      ],
    ],
    colors: {},
  };
  const months = (categoryId: string | null) =>
    Array.from({ length: 12 }, (_, i) =>
      sum(
        s.transactions
          .filter(
            (t) =>
              t.category_id === categoryId &&
              t.transaction_date.startsWith(
                `${year}-${String(i + 1).padStart(2, "0")}`,
              ),
          )
          .map(purchaseAmount),
      ),
    );
  for (const parent of categories
    .filter((c) => !c.selectable)
    .sort((a, b) => b.year - a.year || a.order - b.order)) {
    const children = categories
      .filter((c) => c.parent_id === parent.id)
      .sort((a, b) => a.order - b.order);
    monthly.colors![monthly.rows.length] = colorHex(parent.color);
    monthly.rows.push([parent.id, parent.name]);
    const totals = Array(12).fill(0) as number[];
    for (const child of children) {
      const m = months(child.id);
      m.forEach((n, i) => (totals[i] = sum([totals[i], n])));
      monthly.rows.push([child.id, `  ${child.name}`, ...m, sum(m)]);
    }
    monthly.rows.push(["", `${parent.name} 小計`, ...totals, sum(totals)]);
  }
  const unknown = months(null);
  monthly.rows.push([
    "unclassified",
    "未振分け（旧データ）",
    ...unknown,
    sum(unknown),
  ]);
  const total = stats.monthly.map((m) => m.amount);
  monthly.rows.push(["", "購入支出合計", ...total, sum(total)]);
  const ledger = (filter: (t: State["transactions"][number]) => boolean) => [
    [
      "取引ID",
      "サービス",
      "口座別名",
      "日付",
      "利用先",
      "金額",
      "方向",
      "取引種別",
      "分類ID",
      "用途分類",
      "利用先分類",
      "分類状態",
      "照合状態",
      "計上対象",
      "請求月",
      "引落日",
      "カード別名",
      "個人/事業",
      "メモ",
    ],
    ...s.transactions
      .filter(filter)
      .map((t) => [
        t.transaction_id,
        serviceNames[t.source_service],
        t.account_id,
        t.transaction_date,
        safe(t.merchant_original),
        t.amount,
        t.direction,
        t.transaction_type,
        t.category_id || "",
        categories.find((c) => c.id === t.category_id)?.name || "",
        t.merchant_category || "",
        t.classification_status,
        t.reconciliation_status,
        t.excluded ? "重複除外" : "対象",
        t.billing_month || "",
        t.scheduled_debit_date || "",
        t.card_id || "",
        t.business_use,
        safe(t.purpose_note),
      ]),
  ];
  return [
    {
      title: "経費サマリー",
      rows: [
        ["項目", "値"],
        ["対象月", month],
        ["月間購入支出", stats.purchase],
        ["年間購入支出", stats.annual],
        ["前月購入支出", stats.previous],
        ["前月差額", stats.purchase - stats.previous],
        ["銀行出金", stats.bank_outflow],
        ["資金移動（出金側）", stats.transfers],
        ["未分類件数", stats.unclassified],
        ["未照合件数", stats.unreconciled],
        ["集計状態", stats.final ? "照合確認済み" : "暫定（未照合あり）"],
        ["注意", "税務上の必要経費ではありません"],
        ["利用先", "購入支出"],
        ...Object.entries(stats.by_merchant).map(([k, v]) => [safe(k), v]),
        ["分類", "購入支出", "構成比"],
        ...Object.entries(stats.by_category).map(([k, v]) => [
          categories.find((c) => c.id === k)?.name || "未分類",
          v,
          stats.purchase ? v / stats.purchase : 0,
        ]),
      ],
    },
    monthly,
    {
      title: "カード明細",
      rows: ledger((t) => t.source_service.endsWith("card")),
    },
    { title: "PayPay明細", rows: ledger((t) => t.source_service === "paypay") },
    {
      title: "銀行入出金",
      rows: ledger((t) => t.source_service.endsWith("bank")),
    },
    {
      title: "未分類・確認待ち",
      rows: ledger(
        (t) =>
          t.classification_status === "pending" ||
          t.reconciliation_status === "pending",
      ),
    },
    {
      title: "重複・照合",
      rows: [
        ["照合ID", "種類", "状態", "根拠", "明細ID"],
        ...s.reconciliations.map((r) => [
          r.id,
          r.kind,
          r.status,
          safe(r.reason),
          r.transaction_ids.join(","),
        ]),
      ],
    },
    {
      title: "分類マスター",
      rows: [
        [
          "分類ID",
          "大分類ID",
          "分類名",
          "元年度",
          "元シート",
          "元セル",
          "選択可",
          "色",
        ],
        ...categories.map((c) => [
          c.id,
          c.parent_id || "",
          c.name,
          c.year,
          c.source_sheet,
          c.source_cell,
          c.selectable ? "可" : "不可",
          colorHex(c.color),
        ]),
        ["承認ルールID", "利用先", "分類ID", "利用先分類"],
        ...s.rules.map((r) => [
          r.id,
          safe(r.merchant_normalized),
          r.category_id,
          r.merchant_category || "",
        ]),
      ],
    },
  ];
}
