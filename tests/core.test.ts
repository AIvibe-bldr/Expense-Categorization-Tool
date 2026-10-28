import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { emptyState, type Transaction, type Service } from "../src/lib/types";
import { parseCsv, normalize, yen, readCsv } from "../src/lib/csv";
import {
  categories,
  effectiveCategories,
  addCategory,
  updateCategory,
  moveCategory,
  sortGroups,
  otherCategory,
  importCsv,
  summary,
  approveCategory,
  reconcile,
  purchaseAmount,
  resolveMatch,
  resolveTransaction,
  restoreMissing,
  sum,
} from "../src/lib/engine";
import { encrypt, decrypt } from "../src/lib/crypto";
import { load, save, putSecret, lock, unlock } from "../src/lib/store";
import { reports } from "../src/lib/reports";
import { syncGoogle, authorizationUrl, callback } from "../src/lib/google";
process.env.GALAPAGOS_LOCAL_MODE = "1";
process.env.GALAPAGOS_DATA_DIR = mkdtempSync(join(tmpdir(), "galapagos-test-"));
const csv = (
  rows: string[],
  header = "利用日,利用先,利用金額,取引種別,利用明細ID",
) => Buffer.from([header, ...rows].join("\n"));
const make = (overrides: Partial<Transaction> = {}) => ({
  ...parseCsv(
    csv(["2026-10-05,Amazon,30000,購入,p1"]),
    "rakuten_card",
    "card1",
    randomUUID(),
  )[0],
  ...overrides,
});
for (const service of [
  "smbc_card",
  "rakuten_card",
  "paypay",
  "chiba_bank",
  "sbi_bank",
] as Service[])
  test(`${service}: synthetic CSV adapter`, () => {
    const s = emptyState();
    const buffer = readFileSync(`public/samples/${service}.csv`);
    assert.equal(importCsv(s, buffer, service, "demo").count, 1);
    assert.equal(s.transactions.length, 1);
    assert.ok(s.transactions[0].raw_encrypted);
    assert.equal(
      JSON.parse(decrypt(s.transactions[0].raw_encrypted)).row.length,
      11,
    );
  });
test("same CSV imported twice adds no records", () => {
  const s = emptyState(),
    b = csv(["2026-10-05,Amazon,30000,購入,one"]);
  assert.equal(importCsv(s, b, "rakuten_card", "card").count, 1);
  assert.equal(importCsv(s, b, "rakuten_card", "card").count, 0);
  assert.equal(s.batches.length, 1);
});
test("overlapping exports deduplicate stable record IDs", () => {
  const s = emptyState();
  importCsv(
    s,
    csv(["2026-10-05,Amazon,30000,購入,one"]),
    "rakuten_card",
    "card",
  );
  const r = importCsv(
    s,
    csv(["2026-10-05,Amazon,30000,購入,one", "2026-10-06,Amazon,400,購入,two"]),
    "rakuten_card",
    "card",
  );
  assert.equal(r.count, 1);
  assert.equal(r.duplicates, 1);
});
test("same-value distinct records stay distinct", () => {
  const s = emptyState();
  importCsv(
    s,
    csv([
      "2026-10-05,Amazon,30000,購入,one",
      "2026-10-05,Amazon,30000,購入,two",
    ]),
    "rakuten_card",
    "card",
  );
  assert.equal(s.transactions.length, 2);
});
test("ID-less identical rows preserve multiplicity in one CSV", () => {
  const s = emptyState();
  importCsv(
    s,
    csv(["2026-10-05,Amazon,100,購入,", "2026-10-05,Amazon,100,購入,"]),
    "rakuten_card",
    "card",
  );
  assert.equal(s.transactions.length, 2);
});
test("conflicting stable ID rejects entire import", () => {
  const s = emptyState();
  importCsv(s, csv(["2026-10-05,Amazon,100,購入,one"]), "rakuten_card", "card");
  assert.throws(() =>
    importCsv(
      s,
      csv(["2026-10-06,New,20,購入,new", "2026-10-05,Amazon,101,購入,one"]),
      "rakuten_card",
      "card",
    ),
  );
  assert.equal(s.transactions.length, 1);
});
test("normalizes full-width, spaces and company prefix", () => {
  assert.equal(normalize("株式会社 Ａｍａｚｏｎ"), normalize("Amazon"));
  assert.equal(normalize("セブン・イレブン"), normalize("セブンイレブン"));
});
test("unknown merchant remains pending, not guessed", () => {
  const s = emptyState();
  importCsv(
    s,
    csv(["2026-10-05,知らないお店,100,購入,one"]),
    "smbc_card",
    "card",
  );
  assert.equal(s.transactions[0].classification_status, "pending");
  assert.equal(s.transactions[0].category_id, otherCategory(s)?.id);
  assert.equal(s.transactions[0].classification_status, "pending");
});
test("approved category rule is reused before suggestions", () => {
  const s = emptyState();
  importCsv(
    s,
    csv(["2026-10-05,Ａｍａｚｏｎ,100,購入,one"]),
    "rakuten_card",
    "card",
  );
  const c = categories.find((c) => c.name === "文房具" && c.year === 2025)!;
  approveCategory(
    s,
    s.transactions[0].transaction_id,
    c.id,
    true,
    "Amazon",
    "商品の内容を確認",
  );
  importCsv(s, csv(["2026-10-06,Amazon,200,購入,two"]), "rakuten_card", "card");
  assert.equal(s.transactions[1].category_id, c.id);
  assert.equal(s.transactions[1].classification_source, "rule");
});
test("Amazon merchant class does not confirm purpose", () => {
  const s = emptyState();
  importCsv(s, csv(["2026-10-05,Amazon,100,購入,one"]), "rakuten_card", "card");
  assert.equal(s.transactions[0].merchant_category, "Amazon");
  assert.equal(s.transactions[0].category_id, otherCategory(s)?.id);
});
test("subtotal IDs cannot be assigned", () => {
  const s = emptyState();
  s.transactions = [make()];
  assert.throws(() =>
    approveCategory(
      s,
      s.transactions[0].transaction_id,
      categories.find((c) => !c.selectable)!.id,
      false,
      null,
      "",
    ),
  );
});
test("purchase and later bank card debit count once across months", () => {
  const s = emptyState();
  s.transactions = [
    make(),
    make({
      transaction_id: randomUUID(),
      source_service: "chiba_bank",
      transaction_date: "2026-11-27",
      transaction_type: "card_settlement",
      reconciliation_status: "pending",
    }),
  ];
  assert.equal(summary(s, "2026-10").purchase, 30000);
  assert.equal(summary(s, "2026-11").purchase, 0);
  assert.equal(summary(s, "2026-11").bank_outflow, 30000);
  assert.equal(summary(s, "2026-11").annual, 30000);
});
function cardStatement() {
  const s = emptyState();
  const shared = {
    card_id: "rakuten",
    billing_month: "2026-11",
    scheduled_debit_date: "2026-11-27",
    statement_amount: 30000,
  };
  s.transactions = [
    make({ ...shared, amount: 10000 }),
    make({ ...shared, transaction_id: randomUUID(), amount: 20000 }),
    make({
      ...shared,
      transaction_id: randomUUID(),
      source_service: "chiba_bank",
      transaction_type: "card_settlement",
      transaction_date: "2026-11-27",
      reconciliation_status: "pending",
    }),
  ];
  return s;
}
test("one-to-many card match requires full billing evidence", () => {
  const s = cardStatement();
  reconcile(s);
  assert.equal(s.reconciliations[0].status, "confirmed");
  assert.equal(s.reconciliations[0].transaction_ids.length, 3);
});
test("amount alone never confirms card settlement", () => {
  const s = cardStatement();
  s.transactions.forEach((t) => (t.card_id = null));
  reconcile(s);
  assert.equal(
    s.reconciliations.filter((r) => r.status === "confirmed").length,
    0,
  );
});
test("partial acquisition remains pending", () => {
  const s = cardStatement();
  s.transactions.splice(0, 1);
  reconcile(s);
  assert.equal(s.reconciliations[0].status, "candidate");
});
test("installment/revolving repayment requires confirmation", () => {
  for (const value of ["リボ", "分割3回"]) {
    const s = cardStatement();
    s.transactions[0].installment = value;
    reconcile(s);
    assert.equal(s.reconciliations[0].status, "candidate");
  }
});
test("same amount multiple debits never auto-confirm", () => {
  const s = cardStatement();
  s.transactions.push({ ...s.transactions[2], transaction_id: randomUUID() });
  reconcile(s);
  assert.ok(s.reconciliations.every((r) => r.status === "candidate"));
});
test("bank transfers both directions excluded from purchases", () => {
  for (const a of ["chiba_bank", "sbi_bank"] as Service[]) {
    const s = emptyState();
    s.transactions = [
      make({
        source_service: a,
        transaction_type: "transfer",
        amount: 100000,
        direction: "out",
      }),
      make({
        source_service: a === "chiba_bank" ? "sbi_bank" : "chiba_bank",
        transaction_id: randomUUID(),
        transaction_type: "transfer",
        amount: 100000,
        direction: "in",
      }),
    ];
    assert.equal(summary(s, "2026-10").purchase, 0);
    assert.equal(summary(s, "2026-10").bank_outflow, 100000);
  }
});
test("transfer reference and reciprocal account IDs allow match", () => {
  const s = emptyState();
  s.transactions = [
    make({
      source_service: "chiba_bank",
      account_id: "chiba",
      counterparty_account_id: "sbi",
      payment_reference: "ref1",
      transaction_type: "transfer",
      direction: "out",
      reconciliation_status: "pending",
    }),
    make({
      transaction_id: randomUUID(),
      source_service: "sbi_bank",
      account_id: "sbi",
      counterparty_account_id: "chiba",
      payment_reference: "ref1",
      transaction_type: "transfer",
      direction: "in",
      reconciliation_status: "pending",
    }),
  ];
  reconcile(s);
  assert.equal(s.reconciliations[0].status, "confirmed");
});
test("PayPay charge 20000 then purchase 5000 => 5000", () => {
  const s = emptyState();
  s.transactions = [
    make({
      source_service: "chiba_bank",
      transaction_type: "charge",
      amount: 20000,
    }),
    make({
      source_service: "paypay",
      transaction_id: randomUUID(),
      transaction_type: "charge",
      amount: 20000,
      direction: "in",
    }),
    make({
      source_service: "paypay",
      transaction_id: randomUUID(),
      amount: 5000,
    }),
  ];
  assert.equal(summary(s, "2026-10").purchase, 5000);
});
test("PayPay/card common reference excludes duplicate purchase", () => {
  const s = emptyState();
  s.transactions = [
    make({ payment_reference: "shared" }),
    make({
      transaction_id: randomUUID(),
      source_service: "paypay",
      payment_reference: "shared",
    }),
  ];
  reconcile(s);
  assert.equal(summary(s, "2026-10").purchase, 30000);
  assert.equal(s.reconciliations[0].status, "confirmed");
});
test("PayPay/card amount-only candidate makes aggregate provisional", () => {
  const s = emptyState();
  s.transactions = [
    make(),
    make({ transaction_id: randomUUID(), source_service: "paypay" }),
  ];
  reconcile(s);
  assert.equal(s.reconciliations[0].status, "candidate");
  assert.equal(summary(s, "2026-10").final, false);
  resolveMatch(s, s.reconciliations[0].id, true, "領収書の決済番号を確認");
  assert.equal(summary(s, "2026-10").purchase, 30000);
});
test("refund reduces month in which refund occurs", () => {
  const s = emptyState();
  s.transactions = [
    make(),
    make({
      transaction_id: randomUUID(),
      transaction_type: "refund",
      direction: "in",
      amount: 5000,
      transaction_date: "2026-11-01",
    }),
  ];
  assert.equal(summary(s, "2026-11").purchase, -5000);
  assert.equal(summary(s, "2026-11").annual, 25000);
});
test("unknown bank transaction excluded and visibly pending", () => {
  const s = emptyState();
  importCsv(s, csv(["2026-10-05,不明出金,400,,one"]), "chiba_bank", "bank");
  assert.equal(summary(s, "2026-10").purchase, 0);
  assert.equal(summary(s, "2026-10").unreconciled, 1);
  resolveTransaction(
    s,
    s.transactions[0].transaction_id,
    "purchase",
    "領収書を確認",
  );
  assert.equal(summary(s, "2026-10").purchase, 400);
});
test("failed debit is neither purchase nor bank outflow", () => {
  const s = emptyState();
  s.transactions = [
    make({ source_service: "chiba_bank", transaction_type: "failed" }),
  ];
  assert.equal(summary(s, "2026-10").bank_outflow, 0);
  assert.equal(summary(s, "2026-10").purchase, 0);
});
test("loan principal, investments, taxes are not purchases", () => {
  for (const transaction_type of [
    "loan_principal",
    "investment",
    "tax",
  ] as const)
    assert.equal(purchaseAmount(make({ transaction_type })), 0);
});
test("fee split included in transfer preserves bank cash total", () => {
  const s = emptyState();
  importCsv(
    s,
    csv(
      ["2026-10-05,振替,100330,自己口座振替,one,330"],
      "利用日,利用先,利用金額,取引種別,利用明細ID,振込手数料",
    ),
    "chiba_bank",
    "bank",
    { feeMode: "included" },
  );
  assert.equal(summary(s, "2026-10").bank_outflow, 100330);
  assert.equal(summary(s, "2026-10").purchase, 330);
});
test("unqualified fee column rejects ambiguous handling", () => {
  assert.throws(() =>
    parseCsv(
      csv(
        ["2026-10-05,振替,100000,自己口座振替,one,330"],
        "利用日,利用先,利用金額,取引種別,利用明細ID,振込手数料",
      ),
      "chiba_bank",
      "bank",
      "batch",
    ),
  );
});
test("malformed row makes import atomic", () => {
  const s = emptyState();
  assert.throws(() =>
    importCsv(
      s,
      csv(["2026-10-05,Amazon,100,購入,one", "2026-02-30,Amazon,300,購入,two"]),
      "rakuten_card",
      "card",
    ),
  );
  assert.equal(s.transactions.length, 0);
  assert.equal(s.batches.length, 0);
});
test("decimal and unsafe integers rejected", () => {
  assert.throws(() => yen("1.5"));
  assert.throws(() => yen("99999999999999999"));
  assert.equal(yen("￥1,234"), 1234);
  assert.throws(() => sum([Number.MAX_SAFE_INTEGER, 1]));
});
test("size limit and invalid UTF-8 rejected", () => {
  assert.throws(() => readCsv(Buffer.alloc(5 * 1024 * 1024 + 1)));
  assert.throws(() => readCsv(Buffer.from([0xff, 0xff])));
});
test("custom column mapping works", () => {
  const t = parseCsv(
    Buffer.from("Day,Shop,JPY\n2026-10-05,Shop,123"),
    "smbc_card",
    "card",
    "batch",
    { mapping: { date: "Day", merchant: "Shop", amount: "JPY" } },
  );
  assert.equal(t[0].amount, 123);
});
test("monthly and previous month aggregation", () => {
  const s = emptyState();
  s.transactions = [
    make({ amount: 100 }),
    make({
      transaction_id: randomUUID(),
      amount: 80,
      transaction_date: "2026-09-30",
    }),
  ];
  const stats = summary(s, "2026-10");
  assert.equal(stats.purchase, 100);
  assert.equal(stats.previous, 80);
  assert.equal(stats.monthly[9].amount, 100);
  assert.equal(stats.annual, 180);
});
test("Excel labels and duplicate IDs retained without totals selectable", () => {
  assert.equal(
    categories.filter((c) => c.selectable && c.year === 2025).length,
    116,
  );
  assert.equal(
    categories.filter((c) => c.selectable && c.year === 2024).length,
    104,
  );
  assert.equal(
    categories.filter((c) => c.selectable && c.year === 2023).length,
    78,
  );
  assert.equal(new Set(categories.map((c) => c.id)).size, categories.length);
  assert.ok(!categories.some((c) => c.selectable && c.name.includes("合計")));
  assert.equal(
    categories.filter(
      (c) => c.selectable && c.name === "所得税" && c.year === 2024,
    ).length,
    2,
  );
  assert.equal(
    categories.filter(
      (c) => c.name === "交通費" && c.year === 2025 && !c.selectable,
    ).length,
    2,
  );
});
test("Sheets report totals equal ledger and preserve category IDs", () => {
  const s = emptyState();
  s.transactions = [
    make(),
    make({
      transaction_id: randomUUID(),
      transaction_type: "card_settlement",
      source_service: "chiba_bank",
    }),
  ];
  const output = reports(s, 2026);
  assert.equal(output.length, 8);
  const monthly = output.find((r) => r.title === "2026年 月別経費")!;
  assert.equal(monthly.rows.at(-1)!.at(-1), 30000);
  assert.equal(
    monthly.rows.filter((r) =>
      categories.some((c) => c.selectable && c.id === r[0]),
    ).length,
    298,
  );
});
test("spreadsheet formula injection neutralized", () => {
  const s = emptyState();
  s.transactions = [make({ merchant_original: '=IMPORTXML("evil")' })];
  const card = reports(s, 2026).find((r) => r.title === "カード明細")!;
  assert.equal(card.rows[1][4], '\'=IMPORTXML("evil")');
});
test("AES authenticated encryption detects tampering", () => {
  const c = encrypt("secret");
  assert.equal(decrypt(c), "secret");
  const b = Buffer.from(c, "base64");
  b[15] ^= 1;
  assert.throws(() => decrypt(b.toString("base64")));
});
test("SQLite isolation, persistence and optimistic concurrency", async () => {
  const who = { id: randomUUID(), client: null, local: true },
    other = { ...who, id: randomUUID() };
  const s = await load(who),
    stale = await load(who);
  s.transactions = [make()];
  await save(who, s);
  assert.equal((await load(who)).transactions.length, 1);
  assert.equal((await load(other)).transactions.length, 0);
  await assert.rejects(() => save(who, stale), /VERSION_CONFLICT/);
});
test("sync lock prevents concurrent updates and releases", async () => {
  const who = { id: randomUUID(), client: null, local: true };
  assert.equal(await lock(who, "sync"), true);
  assert.equal(await lock(who, "sync"), false);
  await unlock(who, "sync");
  assert.equal(await lock(who, "sync"), true);
});
test("Google Sheets mock: managed columns only, eight tabs, last success", async () => {
  const who = { id: randomUUID(), client: null, local: true },
    s = emptyState();
  s.settings.spreadsheet_id = "test-spreadsheet-id";
  s.transactions = [make()];
  await save(who, s);
  await putSecret(
    who,
    "google_tokens",
    JSON.stringify({
      access_token: "fake-test-only",
      expires: Date.now() + 3600000,
    }),
  );
  const original = globalThis.fetch;
  const calls: { url: string; method: string; body: any }[] = [];
  let id = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input),
      body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method || "GET", body });
    if (!init?.method || init.method === "GET")
      return Response.json({ sheets: [] });
    if (body?.requests?.[0]?.addSheet)
      return Response.json({
        replies: [
          {
            addSheet: {
              properties: { sheetId: ++id, gridProperties: { rowCount: 1000 } },
            },
          },
        ],
      });
    return Response.json({});
  };
  try {
    assert.equal((await syncGoogle(who, 2026)).sheets, 8);
    const writes = calls.filter((c) => c.method === "PUT");
    assert.equal(writes.length, 8);
    assert.ok(
      writes.every((c) =>
        c.body.values.every((row: unknown[]) => row.length === 40),
      ),
    );
    assert.ok(writes.every((c) => c.body.range.includes(":AN")));
    assert.ok((await load(who)).sync.last_success);
  } finally {
    globalThis.fetch = original;
  }
});
test("Google Sheets existing unmanaged sheet never overwritten", async () => {
  const who = { id: randomUUID(), client: null, local: true },
    s = emptyState();
  s.settings.spreadsheet_id = "test-spreadsheet-id";
  await save(who, s);
  await putSecret(
    who,
    "google_tokens",
    JSON.stringify({ access_token: "test", expires: Date.now() + 3600000 }),
  );
  const original = globalThis.fetch;
  let mutations = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "GET") mutations++;
    return Response.json({
      sheets: [{ properties: { title: "経費サマリー" } }],
    });
  };
  try {
    await assert.rejects(() => syncGoogle(who, 2026), /管理外/);
    assert.equal(mutations, 0);
    assert.ok((await load(who)).sync.error);
  } finally {
    globalThis.fetch = original;
  }
});
test("OAuth state cannot be used by another user or replayed", async () => {
  process.env.GOOGLE_CLIENT_ID = "test";
  process.env.GOOGLE_CLIENT_SECRET = "test";
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
  const who = { id: randomUUID(), client: null, local: true };
  const url = new URL(await authorizationUrl(who)),
    state = url.searchParams.get("state")!;
  await assert.rejects(
    () => callback({ ...who, id: randomUUID() }, "fake", state),
    /state/,
  );
  const old = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      access_token: "fake",
      refresh_token: "fake",
      expires_in: 3600,
    });
  try {
    await callback(who, "fake", state);
    await assert.rejects(() => callback(who, "fake", state), /state/);
  } finally {
    globalThis.fetch = old;
  }
});
test("confirmed cancellation excludes original purchase", () => {
  const s = emptyState();
  s.transactions = [
    make(),
    make({
      transaction_id: randomUUID(),
      transaction_type: "cancellation",
      reconciliation_status: "pending",
    }),
  ];
  const id = randomUUID();
  s.reconciliations = [
    {
      id,
      kind: "cancellation",
      transaction_ids: s.transactions.map((t) => t.transaction_id),
      status: "candidate",
      reason: "",
      created_at: new Date().toISOString(),
    },
  ];
  resolveMatch(s, id, true, "同一注文の取消を確認");
  assert.equal(summary(s, "2026-10").purchase, 0);
  assert.ok(s.transactions.every((t) => t.excluded));
});
test("overlapping ID-less export needs explicit dedup approval", () => {
  const s = emptyState();
  importCsv(s, csv(["2026-10-05,Amazon,100,購入,"]), "rakuten_card", "card");
  const next = csv(["2026-10-05,Amazon,100,購入,", "2026-10-06,New,200,購入,"]);
  assert.throws(() => importCsv(s, next, "rakuten_card", "card"), /明細ID/);
  assert.equal(s.transactions.length, 1);
  assert.equal(
    importCsv(s, next, "rakuten_card", "card", { allowFingerprintDedup: true })
      .count,
    1,
  );
});
test("multiple equal PayPay records with shared ref cannot auto-confirm", () => {
  const s = emptyState();
  s.transactions = [
    make({ payment_reference: "shared" }),
    make({
      transaction_id: randomUUID(),
      source_service: "paypay",
      payment_reference: "shared",
    }),
    make({
      transaction_id: randomUUID(),
      source_service: "paypay",
      payment_reference: "shared",
    }),
  ];
  reconcile(s);
  assert.ok(s.reconciliations.every((r) => r.status === "candidate"));
});
test("unfilled Excel groups do not become unreadable black rows", () => {
  const output = reports(emptyState(), 2026).find(
    (r) => r.title === "2026年 月別経費",
  )!;
  assert.ok(Object.values(output.colors!).every((c) => c !== "000000"));
});

test("restore preserves matched duplicate state and reconciliation evidence", () => {
  const backup = emptyState();
  backup.transactions = [
    make({ payment_reference: "ref" }),
    make({
      transaction_id: randomUUID(),
      fingerprint: "different",
      source_service: "paypay",
      payment_reference: "ref",
    }),
  ];
  reconcile(backup);
  const live = emptyState();
  restoreMissing(live, backup);
  assert.equal(live.transactions.length, 2);
  assert.equal(live.reconciliations[0].status, "confirmed");
  assert.equal(summary(live, "2026-10").purchase, 30000);
  restoreMissing(live, backup);
  assert.equal(live.transactions.length, 2);
});

test("custom category and items can be added, renamed, and moved without changing IDs", () => {
  const s = emptyState();
  const rent = addCategory(s, "新しい家賃", null);
  const other = addCategory(s, "別の費用", null);
  const item = addCategory(s, "テナント料（柏院）", rent.id);
  assert.equal(
    effectiveCategories(s).find((c) => c.id === item.id)?.parent_id,
    rent.id,
  );
  const t = make({ category_id: item.id, parent_category_id: rent.id });
  s.transactions.push(t);
  updateCategory(s, item.id, "テナント料（野田院）", other.id);
  updateCategory(s, rent.id, "家賃", null);
  assert.equal(
    effectiveCategories(s).find((c) => c.id === item.id)?.name,
    "テナント料（野田院）",
  );
  assert.equal(
    effectiveCategories(s).find((c) => c.id === rent.id)?.name,
    "家賃",
  );
  assert.equal(s.transactions[0].parent_category_id, other.id);
  assert.equal(s.transactions[0].category_id, item.id);
  assert.ok(
    reports(s, 2026)
      .find((r) => r.title === "2026年 月別経費")!
      .rows.some((r) => r[0] === item.id && r[1] === "  テナント料（野田院）"),
  );
  assert.throws(() => updateCategory(s, item.id, "不正", null));
  assert.throws(() => addCategory(s, "合計", null));
});
test("moving a category changes monthly display order and survives renaming", () => {
  const s = emptyState();
  const a = addCategory(s, "一番目", null);
  const b = addCategory(s, "二番目", null);
  moveCategory(s, b.id, "up");
  assert.equal(sortGroups(effectiveCategories(s))[0].id, b.id);
  updateCategory(s, b.id, "改名後", null);
  assert.equal(sortGroups(effectiveCategories(s))[0].name, "改名後");
  const rows = reports(s, 2026).find((r) => r.title === "2026年 月別経費")!.rows;
  assert.ok(rows.findIndex((r) => r[0] === b.id) < rows.findIndex((r) => r[0] === a.id));
  assert.throws(() => moveCategory(s, b.id, "up"));
});
test("unclassified purchases fall into Other by month and remain pending for human review", () => {
  const s = emptyState();
  importCsv(
    s,
    csv(["2026-10-05,未知の店A,100,購入,a", "2026-11-05,未知の店B,200,購入,b"]),
    "rakuten_card",
    "card",
  );
  const other = otherCategory(s)!;
  assert.equal(
    s.transactions.filter(
      (t) =>
        t.category_id === other.id && t.classification_status === "pending",
    ).length,
    2,
  );
  assert.equal(summary(s, "2026-10").unclassified, 1);
  assert.equal(summary(s, "2026-11").unclassified, 1);
  const report = reports(s, 2026).find((r) => r.title === "2026年 月別経費")!;
  const row = report.rows.find((r) => r[0] === other.id)!;
  assert.equal(row[11], 100);
  assert.equal(row[12], 200);
  assert.equal(report.rows.at(-1)!.at(-1), 300);
  const item = addCategory(s, "新規用途", other.parent_id);
  approveCategory(
    s,
    s.transactions[0].transaction_id,
    item.id,
    true,
    null,
    "確認済み",
  );
  importCsv(
    s,
    csv(["2026-12-05,未知の店A,300,購入,c"]),
    "rakuten_card",
    "card",
  );
  assert.equal(s.transactions[2].category_id, item.id);
  assert.equal(s.transactions[2].classification_status, "confirmed");
});
test("renamed historical item retains its ID and approved merchant rule", () => {
  const s = emptyState();
  const item = categories.find(
    (c) => c.name === "家賃" && c.selectable && c.year === 2025,
  )!;
  importCsv(s, csv(["2026-10-05,借家,100,購入,a"]), "rakuten_card", "card");
  approveCategory(s, s.transactions[0].transaction_id, item.id, true, null, "");
  updateCategory(s, item.id, "家賃（旧契約）", item.parent_id);
  importCsv(s, csv(["2026-11-05,借家,200,購入,b"]), "rakuten_card", "card");
  assert.equal(s.transactions[1].category_id, item.id);
  assert.equal(
    effectiveCategories(s).find((c) => c.id === item.id)?.name,
    "家賃（旧契約）",
  );
});
test("restore carries custom categories needed by restored transactions", () => {
  const backup = emptyState();
  const group = addCategory(backup, "追加分類", null),
    item = addCategory(backup, "追加項目", group.id);
  backup.transactions = [
    make({ category_id: item.id, parent_category_id: group.id }),
  ];
  const live = emptyState();
  restoreMissing(live, backup);
  assert.equal(
    effectiveCategories(live).find((c) => c.id === item.id)?.name,
    "追加項目",
  );
  assert.equal(live.transactions[0].category_id, item.id);
});
test("monthly report does not show source year", () => {
  const monthly = reports(emptyState(), 2026).find(
    (r) => r.title === "2026年 月別経費",
  )!;
  assert.equal(monthly.rows[0][1], "分類");
  assert.ok(monthly.rows.some((r) => r[1] === "家賃"));
  assert.ok(!monthly.rows.some((r) => String(r[1]).includes("家賃 (2025)")));
});

test("renaming Other keeps the stable fallback for new unknown merchants", () => {
  const s = emptyState();
  const other = otherCategory(s)!;
  updateCategory(s, other.id, "その他（要確認）", other.parent_id);
  importCsv(
    s,
    csv(["2026-10-05,初めての店,150,購入,first"]),
    "rakuten_card",
    "card",
  );
  assert.equal(s.transactions[0].category_id, other.id);
  assert.equal(s.transactions[0].classification_status, "pending");
  assert.equal(summary(s, "2026-10").final, false);
});
