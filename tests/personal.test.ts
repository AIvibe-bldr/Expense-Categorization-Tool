import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseCsv } from "../src/lib/csv";
import { categories } from "../src/lib/engine";
import { personalReports } from "../src/lib/spreadsheet";
import type { Transaction } from "../src/lib/types";
function tx(overrides: Partial<Transaction> = {}) {
  return {
    ...parseCsv(
      Buffer.from(
        "利用日,利用先,利用金額,取引種別,利用明細ID\n2026-01-15,架空のお店,1000,購入,synthetic",
      ),
      "rakuten_card",
      "demo",
      randomUUID(),
    )[0],
    ...overrides,
  };
}
const item = (name: string, year = 2025) =>
  categories.find((c) => c.selectable && c.year === year && c.name === name)!;
test("personal annual table counts tax, investments and personal purchases by use date, refunds by refund date", () => {
  const data = [
    tx({
      category_id: item("投資").id,
      transaction_type: "investment",
      amount: 5000,
      business_use: "personal",
      billing_month: "2026-02",
    }),
    tx({
      category_id: item("所得税").id,
      transaction_type: "tax",
      amount: 2000,
      business_use: "personal",
    }),
    tx({
      category_id: item("Amazon").id,
      amount: 1000,
      business_use: "personal",
    }),
    tx({
      category_id: item("Amazon").id,
      amount: 300,
      transaction_date: "2026-02-03",
      direction: "in",
      transaction_type: "refund",
    }),
    tx({
      category_id: item("Amazon").id,
      amount: 99999,
      transaction_date: "2025-12-31",
      billing_month: "2026-01",
    }),
    tx({ transaction_type: "card_settlement", amount: 8000 }),
    tx({ transaction_type: "transfer", amount: 10000 }),
    tx({ transaction_type: "charge", amount: 1000 }),
    tx({ transaction_type: "income", direction: "in", amount: 50000 }),
    tx({ amount: 1000, excluded: true }),
  ];
  const reports = personalReports(data, categories, 2026);
  assert.equal(reports.length, 13);
  const annual = reports[0];
  assert.equal(
    annual.rows.find(
      (row) => String(row[0]).trim() === "投資" && row.length === 14,
    )?.[1],
    5000,
  );
  assert.equal(
    annual.rows.find((row) => String(row[0]).trim() === "所得税")?.[1],
    2000,
  );
  const amazon = annual.rows.find((row) => String(row[0]).trim() === "Amazon")!;
  assert.equal(amazon[1], 1000);
  assert.equal(amazon[2], -300);
  const total = annual.rows.at(-1)!;
  assert.equal(total[1], 8000);
  assert.equal(total[2], -300);
  assert.equal(total[13], 7700);
  for (let month = 1; month <= 12; month++) {
    assert.equal(
      reports[month].rows
        .slice(1)
        .reduce((sum, row) => sum + Number(row[5]), 0),
      total[month],
    );
  }
  assert.ok(reports[1].rows.some((row) => String(row[8]).includes("資金移動")));
});
test("pending unknown bank outflow remains visible and refunds are not confused with income", () => {
  const reports = personalReports(
    [
      tx({
        transaction_type: "unknown",
        source_service: "sbi_bank",
        category_id: null,
      }),
      tx({ transaction_type: "income", direction: "in", amount: 4000 }),
    ],
    categories,
    2026,
  );
  assert.equal(reports[0].rows.find((row) => row[0] === "未分類")?.[1], 1000);
  assert.equal(reports[0].rows.at(-1)?.[1], 1000);
});
test("empty annual template retains its items and custom or historical classification is not lost", () => {
  const custom = {
    ...item("Amazon"),
    id: randomUUID(),
    name: "個人の記録項目",
    year: 2026,
  };
  const all = [...categories, custom];
  const reports = personalReports([tx({ category_id: custom.id })], all, 2026);
  assert.equal(
    reports[0].rows.find((row) => String(row[0]).trim() === custom.name)?.[1],
    1000,
  );
  const empty = personalReports([], categories, 2026)[0];
  assert.ok(empty.rows.some((row) => String(row[0]).trim() === "くもん"));
  assert.equal(
    empty.rows.filter((row) => String(row[0]).startsWith("　")).length,
    116,
  );
  assert.equal(empty.rows.at(-1)?.[13], 0);
});

test("historical unique items retain their amounts in the personal layout", () => {
  const old = categories.find((c) => c.selectable && c.year === 2023)!;
  const reports = personalReports(
    [tx({ category_id: old.id, amount: 1234 })],
    categories,
    2026,
  );
  assert.equal(reports[0].rows.at(-1)?.[1], 1234);
  const itemRows = reports[0].rows.filter((row) =>
    String(row[0]).startsWith("　"),
  );
  assert.equal(
    itemRows.reduce((sum, row) => sum + Number(row[1]), 0),
    1234,
  );
});
