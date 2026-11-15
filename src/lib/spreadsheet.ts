import { currentCategoryChoices, categoryDisplayName } from "./category-order";
import { colorHex } from "./colors";
import { serviceNames, type Transaction, type Category } from "./types";

function safe(s: string) {
  return /^[=+@\-\t\r]/.test(s) ? "'" + s : s;
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

export type SpreadsheetReport = {
  title: string;
  rows: (string | number)[][];
  colors?: Record<number, string>;
};

/** Personal use of funds, independent of business/tax eligibility. */
export function personalAmount(t: Omit<Transaction, "raw_encrypted">): number {
  if (
    t.excluded ||
    [
      "card_settlement",
      "transfer",
      "charge",
      "income",
      "failed",
      "cancellation",
    ].includes(t.transaction_type)
  )
    return 0;
  if (t.direction === "in")
    return t.transaction_type === "refund" ? -t.amount : 0;
  return t.amount;
}

/** Use the supplied 2025 layout; retain custom and referenced historical items. */
export function personalCategoryChoices(
  categories: Category[],
  transactions: Omit<Transaction, "raw_encrypted">[] = [],
) {
  const choices = currentCategoryChoices(categories);
  const used = new Set(
    transactions.map((t) =>
      t.category_id
        ? choices.canonicalIdById.get(t.category_id) || t.category_id
        : "",
    ),
  );
  const children = new Map(
    [...choices.children].map(([id, items]) => [
      id,
      items.filter(
        (item) =>
          item.year >= 2025 ||
          item.source_sheet === "ユーザー追加" ||
          used.has(item.id),
      ),
    ]),
  );
  const groups = choices.groups.filter(
    (group) =>
      group.year >= 2025 ||
      group.source_sheet === "ユーザー追加" ||
      children.get(group.id)?.length,
  );
  return { ...choices, groups, children };
}

export function personalReports(
  transactions: Omit<Transaction, "raw_encrypted">[],
  categories: Category[],
  year: number,
): SpreadsheetReport[] {
  const { groups, children, canonicalIdById } = personalCategoryChoices(
    categories,
    transactions,
  );
  const yearTx = transactions.filter((t) =>
    t.transaction_date.startsWith(`${year}-`),
  );
  const values = new Map<string, number[]>();
  const totals = Array<number>(12).fill(0);
  for (const t of yearTx) {
    const id = t.category_id
      ? canonicalIdById.get(t.category_id) || t.category_id
      : "unclassified";
    const month = Number(t.transaction_date.slice(5, 7)) - 1;
    const amount = personalAmount(t);
    if (!values.has(id)) values.set(id, Array<number>(12).fill(0));
    values.get(id)![month] += amount;
    totals[month] += amount;
  }
  const annual: SpreadsheetReport = {
    title: `${year}年 年間_項目別`,
    rows: [
      [
        "分類・項目",
        ...Array.from({ length: 12 }, (_, i) => `${i + 1}月`),
        "年間合計",
      ],
    ],
    colors: {},
  };
  const append = (name: string, amounts: number[]) =>
    annual.rows.push([
      safe(name),
      ...amounts,
      amounts.reduce((a, b) => a + b, 0),
    ]);
  const displayedIds = new Set<string>();
  for (const group of groups) {
    annual.colors![annual.rows.length] = colorHex(group.color);
    annual.rows.push([safe(categoryDisplayName(group.name))]);
    const subtotal = Array<number>(12).fill(0);
    for (const item of children.get(group.id) || []) {
      displayedIds.add(item.id);
      const amounts = values.get(item.id) || Array<number>(12).fill(0);
      append(`　${categoryDisplayName(item.name)}`, amounts);
      amounts.forEach((n, i) => (subtotal[i] += n));
    }
    annual.colors![annual.rows.length] = colorHex(group.color);
    append(`${categoryDisplayName(group.name)} 合計`, subtotal);
  }
  const unknown = Array<number>(12).fill(0);
  for (const [id, amounts] of values)
    if (!displayedIds.has(id)) amounts.forEach((n, i) => (unknown[i] += n));
  append("未分類", unknown);
  annual.colors![annual.rows.length] = "E6F1E9";
  append("資金用途 合計", totals);
  const monthly = Array.from({ length: 12 }, (_, i): SpreadsheetReport => {
    const month = `${year}-${String(i + 1).padStart(2, "0")}`;
    const monthlyTx = yearTx
      .filter((t) => t.transaction_date.startsWith(month))
      .sort(
        (a, b) =>
          a.transaction_date.localeCompare(b.transaction_date) ||
          a.transaction_id.localeCompare(b.transaction_id),
      );
    return {
      title: `${month}_明細`,
      rows: [
        [
          "利用日",
          "利用先",
          "分類・項目",
          "出金額",
          "入金額",
          "資金用途 集計額",
          "サービス",
          "口座・カード",
          "確認状態・備考",
        ],
        ...monthlyTx.map((t) => {
          const id = t.category_id
            ? canonicalIdById.get(t.category_id) || t.category_id
            : null;
          const item = categories.find((c) => c.id === id);
          const group = groups.find((g) =>
            children.get(g.id)?.some((c) => c.id === id),
          );
          const label = item
            ? `${group ? categoryDisplayName(group.name) + " › " : ""}${categoryDisplayName(item.name)}`
            : "未分類";
          const excluded = t.excluded
            ? "重複除外"
            : ["card_settlement", "transfer", "charge"].includes(
                  t.transaction_type,
                )
              ? "資金移動（集計対象外）"
              : ["income", "failed", "cancellation"].includes(
                    t.transaction_type,
                  ) ||
                  (t.direction === "in" && t.transaction_type !== "refund")
                ? "集計対象外"
                : "";
          return [
            t.transaction_date,
            safe(t.merchant_original),
            safe(label),
            t.direction === "out" ? t.amount : 0,
            t.direction === "in" ? t.amount : 0,
            personalAmount(t),
            serviceNames[t.source_service],
            safe(t.account_id),
            safe(
              [
                excluded,
                t.classification_status === "pending" ? "項目を要確認" : "",
                t.purpose_note,
              ]
                .filter(Boolean)
                .join(" / "),
            ),
          ];
        }),
      ],
    };
  });
  return [annual, ...monthly];
}
