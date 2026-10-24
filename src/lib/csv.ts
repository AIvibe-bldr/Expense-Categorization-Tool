import { parse } from "csv-parse/sync";
import { randomUUID } from "node:crypto";
import { hash, encrypt } from "./crypto";
import { services, type Service, type Transaction, type Kind } from "./types";
export const MAX_FILE_SIZE = 5 * 1024 * 1024;
export const fields = [
  "date",
  "merchant",
  "amount",
  "outflow",
  "inflow",
  "type",
  "id",
  "posted_date",
  "billing_month",
  "debit_date",
  "statement_amount",
  "card_id",
  "counterparty",
  "reference",
  "installment",
  "balance",
  "fee",
] as const;
export type Field = (typeof fields)[number];
export type Mapping = Partial<Record<Field, string>>;
const common: Record<Field, string[]> = {
  date: [
    "取引日",
    "利用日",
    "ご利用日",
    "利用年月日",
    "日付",
    "取引日時",
    "date",
  ],
  merchant: [
    "利用先",
    "ご利用店名",
    "利用店名・商品名",
    "取引内容",
    "摘要",
    "内容",
    "取引先",
    "merchant",
  ],
  amount: [
    "利用金額",
    "ご利用金額",
    "利用金額（円）",
    "金額",
    "取引金額",
    "金額（円）",
    "amount",
  ],
  outflow: [
    "出金額",
    "お支払金額",
    "お引出し金額",
    "出金金額（円）",
    "outflow",
  ],
  inflow: ["入金額", "お預り金額", "お預入れ金額", "入金金額（円）", "inflow"],
  type: ["取引種別", "取引種類", "種別", "type"],
  id: ["利用明細ID", "取引番号", "取引ID", "明細ID", "id"],
  posted_date: ["計上日", "posted_date"],
  billing_month: ["請求月", "billing_month"],
  debit_date: ["引落予定日", "引落日", "debit_date"],
  statement_amount: ["請求確定額", "statement_amount"],
  card_id: ["カード識別子", "card_id"],
  counterparty: ["相手口座ID", "counterparty"],
  reference: ["共通参照ID", "reference"],
  installment: ["支払区分", "分割・リボ", "installment"],
  balance: ["残高", "お取引後残高", "balance"],
  fee: ["振込手数料", "fee"],
};
export interface Adapter {
  source: Service;
  aliases: Record<Field, string[]>;
}
// Independent adapters share only parsing/validation; formats can evolve separately.
export const adapters: Record<Service, Adapter> = {
  smbc_card: {
    source: "smbc_card",
    aliases: { ...common, merchant: ["ご利用店名", ...common.merchant] },
  },
  rakuten_card: {
    source: "rakuten_card",
    aliases: { ...common, merchant: ["利用店名・商品名", ...common.merchant] },
  },
  paypay: {
    source: "paypay",
    aliases: {
      ...common,
      merchant: ["取引先", ...common.merchant],
      date: ["取引日時", ...common.date],
    },
  },
  chiba_bank: {
    source: "chiba_bank",
    aliases: { ...common, merchant: ["摘要", ...common.merchant] },
  },
  sbi_bank: {
    source: "sbi_bank",
    aliases: { ...common, merchant: ["内容", ...common.merchant] },
  },
};
export function yen(value: string, optional = false): number | null {
  const v = value
    .trim()
    .normalize("NFKC")
    .replace(/[,￥¥円\s]/g, "");
  if (!v && optional) return null;
  if (!/^-?\d+$/.test(v)) throw Error("金額は円単位の整数で指定してください");
  const n = Number(v);
  if (!Number.isSafeInteger(n) || Math.abs(n) > 1_000_000_000_000)
    throw Error("金額が許容範囲外です");
  return n;
}
export function date(value: string) {
  const m = value
    .trim()
    .match(/^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:日|\b)/);
  if (!m) throw Error("日付は YYYY-MM-DD 形式が必要です");
  const s = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  if (new Date(s + "T00:00:00Z").toISOString().slice(0, 10) !== s)
    throw Error("存在しない日付です");
  return s;
}
export function normalize(s: string) {
  return s
    .normalize("NFKC")
    .toUpperCase()
    .replace(/株式会社|有限会社|\(株\)|（株）/g, "")
    .replace(/[\s・･ー‐‑–—-]/g, "")
    .trim();
}
const types: Record<string, Kind> = {
  purchase: "purchase",
  店舗決済: "purchase",
  支払い: "purchase",
  購入: "purchase",
  refund: "refund",
  返金: "refund",
  charge: "charge",
  チャージ: "charge",
  transfer: "transfer",
  送金: "transfer",
  残高移動: "transfer",
  自己口座振替: "transfer",
  card_settlement: "card_settlement",
  カード引落: "card_settlement",
  fee: "fee",
  手数料: "fee",
  income: "income",
  入金: "income",
  loan_principal: "loan_principal",
  元本返済: "loan_principal",
  investment: "investment",
  投資: "investment",
  tax: "tax",
  税金: "tax",
  unknown: "unknown",
  その他: "unknown",
  failed: "failed",
  引落不能: "failed",
  cancellation: "cancellation",
  取消: "cancellation",
};
export function readCsv(
  buffer: Buffer,
  encoding: "utf-8" | "shift_jis" = "utf-8",
) {
  if (!buffer.length || buffer.length > MAX_FILE_SIZE)
    throw Error("CSVは1バイト〜5MBです");
  const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
  if (text.includes("\0")) throw Error("CSVに不正な文字があります");
  const rows = parse(text, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    max_record_size: 65536,
  }) as string[][];
  if (rows.length > 20001) throw Error("最大20,000行です");
  return rows;
}
export function parseCsv(
  buffer: Buffer,
  source: Service,
  account: string,
  batch: string,
  options: {
    mapping?: Mapping;
    encoding?: "utf-8" | "shift_jis";
    feeMode?: "included" | "additional";
  } = {},
): Transaction[] {
  if (!services.includes(source) || !/^[-\w]{1,64}$/.test(account))
    throw Error(
      "サービスまたは口座IDが不正です。口座IDには実口座番号ではなく別名を使用してください",
    );
  const rows = readCsv(buffer, options.encoding),
    aliases = adapters[source].aliases;
  const start = rows.findIndex((r) =>
    r.some((c) => [...aliases.date, options.mapping?.date].includes(c.trim())),
  );
  if (start < 0)
    throw Error("日付ヘッダーを認識できません。列対応を指定してください");
  const header = rows[start].map((s) => s.trim());
  if (new Set(header).size !== header.length)
    throw Error("CSVの列名が重複しています");
  const indexes = Object.fromEntries(
    fields.map((f) => [
      f,
      header.findIndex((h) =>
        options.mapping?.[f]
          ? h === options.mapping[f]
          : aliases[f].includes(h),
      ),
    ]),
  ) as Record<Field, number>;
  if (
    indexes.merchant < 0 ||
    (indexes.amount < 0 && indexes.outflow < 0 && indexes.inflow < 0)
  )
    throw Error("利用先と金額、または入出金列が必要です");
  const occurrences = new Map<string, number>();
  const now = new Date().toISOString();
  const result: Transaction[] = [];
  rows.slice(start + 1).forEach((row, i) => {
    try {
      if (row.length !== header.length) throw Error("列数が一致しません");
      const get = (f: Field) =>
        indexes[f] < 0 ? "" : String(row[indexes[f]] ?? "").trim();
      const merchant = get("merchant");
      if (!merchant || merchant.length > 500)
        throw Error("利用先は1〜500文字です");
      let amount: number;
      let direction: "out" | "in" = "out";
      const out = yen(get("outflow"), true),
        inc = yen(get("inflow"), true);
      if (out !== null || inc !== null) {
        if (
          (out ?? 0) < 0 ||
          (inc ?? 0) < 0 ||
          ((out ?? 0) > 0 && (inc ?? 0) > 0)
        )
          throw Error("入出金の同時指定や負値は使用できません");
        amount = out || inc || 0;
        direction = out ? "out" : "in";
      } else {
        amount = yen(get("amount"))!;
        if (amount < 0) direction = "in";
        amount = Math.abs(amount);
      }
      if (amount === 0) throw Error("ゼロ円取引は取り込めません");
      const explicit = get("type");
      if (explicit && !types[explicit])
        throw Error(`未対応の取引種別: ${explicit}`);
      let kind: Kind = explicit
        ? types[explicit]
        : source.endsWith("card")
          ? direction === "in"
            ? "refund"
            : "purchase"
          : "unknown";
      if (kind === "refund") direction = "in";
      if (!explicit && source.endsWith("bank")) {
        if (
          /楽天カード|ラクテンカード|三井住友カード|ミツイスミトモカード/i.test(
            merchant,
          )
        )
          kind = "card_settlement";
        else if (/PAYPAY|ペイペイ/i.test(merchant) && direction === "out")
          kind = "charge";
      }
      const fee = yen(get("fee"), true) ?? 0;
      if (fee < 0) throw Error("手数料は正数です");
      if (fee && !options.feeMode)
        throw Error("手数料が出金額に含まれるかを選択してください");
      const d = date(get("date"));
      const id = get("id") || null;
      const canonical = JSON.stringify([
        d,
        normalize(merchant),
        amount,
        direction,
        kind,
        get("card_id"),
        get("billing_month"),
        get("installment"),
      ]);
      const occurrence = (occurrences.get(canonical) || 0) + 1;
      occurrences.set(canonical, occurrence);
      const fingerprint = hash(
        JSON.stringify([
          source,
          account,
          id ? ["id", id] : ["row", canonical, occurrence],
        ]),
      );
      const month = get("billing_month").replace("/", "-");
      if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
        throw Error("請求月は YYYY-MM 形式です");
      const installment = get("installment") || null;
      const t: Transaction = {
        transaction_id: randomUUID(),
        source_service: source,
        account_id: account,
        transaction_date: d,
        posted_date: get("posted_date") ? date(get("posted_date")) : null,
        merchant_original: merchant,
        merchant_normalized: normalize(merchant),
        amount,
        direction,
        transaction_type: kind,
        parent_category_id: null,
        category_id: null,
        merchant_id: hash(normalize(merchant)),
        merchant_category: null,
        purpose_note: "",
        classification_status: "pending",
        classification_source: "unknown",
        classification_confidence: 0,
        reconciliation_status:
          [
            "transfer",
            "charge",
            "card_settlement",
            "unknown",
            "cancellation",
            "failed",
          ].includes(kind) || !!installment
            ? "pending"
            : "not_required",
        original_record_id: id,
        import_batch_id: batch,
        created_at: now,
        updated_at: now,
        fingerprint,
        billing_month: month || null,
        scheduled_debit_date: get("debit_date")
          ? date(get("debit_date"))
          : null,
        statement_amount: yen(get("statement_amount"), true),
        card_id: get("card_id") || null,
        counterparty_account_id: get("counterparty") || null,
        payment_reference: get("reference") || null,
        installment,
        balance: yen(get("balance"), true),
        fee,
        business_use: "unknown",
        excluded: false,
        raw_encrypted: encrypt(
          JSON.stringify({ header, row, line: start + i + 2 }),
        ),
        suggested_category_ids: [],
      };
      if (fee) {
        if (direction !== "out")
          throw Error("入金に手数料分割は指定できません");
        if (options.feeMode === "included") {
          if (fee >= amount) throw Error("手数料は出金額未満にしてください");
          t.amount -= fee;
        }
        result.push({
          ...t,
          transaction_id: randomUUID(),
          fingerprint: hash(fingerprint + ":fee"),
          amount: fee,
          fee: 0,
          transaction_type: "fee",
          merchant_original: merchant + " 手数料",
          reconciliation_status: "not_required",
        });
      }
      result.push(t);
    } catch (e) {
      throw Error(`${start + i + 2}行目: ${(e as Error).message}`);
    }
  });
  if (!result.length) throw Error("明細がありません");
  return result;
}
