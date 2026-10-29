import { date, yen } from "./csv";
import { hash } from "./crypto";
import type { ReferenceRecord, ReferenceSheetSettings } from "./types";

export function parseSheetLink(value: string) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/spreadsheets\/d\/([-\w]{10,150})\/(?:edit)?$/);
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || !match)
    throw Error("GoogleスプレッドシートのURLを入力してください");
  const rawGid = url.searchParams.get("gid") || new URLSearchParams(url.hash.slice(1)).get("gid");
  const gid = rawGid === null ? null : Number(rawGid);
  if (gid !== null && (!Number.isSafeInteger(gid) || gid < 0)) throw Error("タブIDが不正です");
  return { sheet_id: match[1], gid };
}

export function suggestReferenceColumns(headers: string[]) {
  const find = (pattern: RegExp) => headers.findIndex((cell) => pattern.test(cell.trim()));
  const date_col = find(/日付|日時|支払日|入金日|診療日|施術日|^date$/i);
  const name_cols = headers.flatMap((cell, index) =>
    /支払先|領収先|利用先|取引先|氏名|患者|顧客|名前|^name$|^payee$/i.test(cell.trim()) ? [index] : [],
  ).slice(0, 2);
  const amount = find(/金額|売上|支払額|入金額|合計|^amount$|^price$/i);
  return { date_col, name_cols, amount_col: amount < 0 ? null : amount };
}

export function parseReferenceRows(
  rows: string[][],
  config: Omit<ReferenceSheetSettings, "last_sync">,
): ReferenceRecord[] {
  const { sheet_id, gid, header_row, date_col, name_cols, amount_col } = config;
  if (rows.length >= 5001) throw Error("参照シートが5,000行を超えました。対象範囲を分けてください");
  if (header_row < 1 || header_row > 20 || date_col < 0 || date_col > 25 ||
    !name_cols.length || name_cols.some((c) => c < 0 || c > 25) ||
    (amount_col !== null && (amount_col < 0 || amount_col > 25)))
    throw Error("参照シートの列指定が不正です");
  const result: ReferenceRecord[] = [];
  for (let index = header_row; index < rows.length; index++) {
    const row = rows[index];
    let transaction_date: string;
    try { transaction_date = date(String(row[date_col] || "")); }
    catch { continue; }
    const name = [...new Set(name_cols.map((c) => String(row[c] || "").trim()).filter(Boolean))].join(" / ");
    if (!name || name.length > 500) continue;
    let amount: number | null = null;
    if (amount_col !== null && String(row[amount_col] || "").trim()) {
      try { amount = Math.abs(yen(String(row[amount_col]))!); }
      catch { continue; }
    }
    const row_number = index + 1;
    result.push({
      id: hash(JSON.stringify([sheet_id, gid, row_number, transaction_date, name, amount])),
      sheet_id, gid, row_number, transaction_date, name, amount, active: true,
    });
  }
  return result;
}
