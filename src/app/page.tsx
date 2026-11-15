"use client";
import { categoryDisplayName } from "@/lib/category-order";
import { useEffect, useState } from "react";
import { personalReports, personalCategoryChoices } from "@/lib/spreadsheet";
import { createBrowserClient } from "@supabase/ssr";
import {
  services,
  serviceNames,
  type Service,
  type Transaction,
  type Category,
} from "@/lib/types";
type Tx = Omit<Transaction, "raw_encrypted">;
type Payload = {
  state: { transactions: Tx[] };
  categories: Category[];
  local: boolean;
};
const yen = (n: number) =>
  new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(n);
export default function App() {
  const [data, setData] = useState<Payload | null>(null);
  const [source, setSource] = useState<Service>("smbc_card");
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState("auto");
  const [account, setAccount] = useState("main");
  const [mapping, setMapping] = useState("{}");
  const [feeMode, setFeeMode] = useState("");
  const [dedup, setDedup] = useState(false);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [search, setSearch] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [limit, setLimit] = useState(100);
  const [previewLimit, setPreviewLimit] = useState(100);
  const [previewSheet, setPreviewSheet] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function refresh() {
    const r = await fetch("/api/state");
    if (r.status === 401) {
      location.href = "/login";
      return;
    }
    const body = await r.json();
    if (!r.ok) throw Error(body.error);
    setData(body);
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  async function save(path: string, body: FormData | object) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch(`/api/${path}`, {
        method: "POST",
        headers:
          body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" },
        body: body instanceof FormData ? body : JSON.stringify(body),
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error);
      await refresh();
      setNotice(
        path === "imports"
          ? `${result.count}件を取り込みました（重複${result.duplicates}件をスキップ）。項目を選んで振り分けてください。`
          : "振り分けを保存しました。",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const categories = data?.categories ?? [];
  const transactions = (data?.state.transactions ?? []).filter((t) =>
    t.transaction_date.startsWith(`${year}-`),
  );
  const pending = transactions.filter(
    (t) => t.classification_status === "pending",
  ).length;
  const rows = transactions
    .filter(
      (t) =>
        (!pendingOnly || t.classification_status === "pending") &&
        `${t.merchant_original} ${t.transaction_date}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date));
  const choices = personalCategoryChoices(
    categories,
    data?.state.transactions ?? [],
  );
  const selectableIds = new Set(
    [...choices.children.values()].flat().map((c) => c.id),
  );
  const sheets = personalReports(
    data?.state.transactions ?? [],
    categories,
    Number(year),
  );
  const spreadsheet = sheets[previewSheet];
  const previewRows = spreadsheet.rows.slice(1);
  return (
    <main className="simple-main">
      <header>
        <div>
          <p className="eyebrow">GALAPAGOS</p>
          <h1>自分のお金の使い道を、月ごとに。</h1>
          <p className="muted">
            CSVを取り込み、分類・項目に振り分けて、毎月の資金用途を記録します。
          </p>
        </div>
        {data && !data.local && (
          <button
            className="secondary"
            onClick={async () => {
              await createBrowserClient(
                process.env.NEXT_PUBLIC_SUPABASE_URL!,
                process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
              ).auth.signOut();
              location.href = "/login";
            }}
          >
            ログアウト
          </button>
        )}
      </header>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {!data ? (
        <p>
          {error ? "読み込めませんでした。" : "読み込み中…"}
          <button
            className="link"
            onClick={() => refresh().catch((e) => setError(e.message))}
          >
            再読み込み
          </button>
        </p>
      ) : (
        <>
          <section className="panel">
            <h2>1. CSVを取り込む</h2>
            <p className="muted">
              カード・銀行などのサイトで取得したCSVを選択してください。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!file) return;
                const form = new FormData();
                form.set("source", source);
                form.set("file", file);
                form.set("account", account);
                form.set("encoding", encoding);
                form.set("mapping", mapping);
                form.set("allowFingerprintDedup", String(dedup));
                if (feeMode) form.set("feeMode", feeMode);
                void save("imports", form);
              }}
            >
              <div className="form-grid">
                <label>
                  金融サービス
                  <select
                    value={source}
                    onChange={(e) => setSource(e.target.value as Service)}
                  >
                    {services.map((s) => (
                      <option key={s} value={s}>
                        {serviceNames[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  CSVファイル
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    required
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                  <small>最大5MB</small>
                </label>
              </div>
              <details>
                <summary>読み込み設定（文字化け・列名の調整など）</summary>
                <div className="form-grid">
                  <label>
                    文字コード
                    <select
                      value={encoding}
                      onChange={(e) => setEncoding(e.target.value)}
                    >
                      <option value="auto">自動判定</option>
                      <option value="utf-8">UTF-8</option>
                      <option value="shift_jis">Shift_JIS / CP932</option>
                    </select>
                  </label>
                  <label>
                    口座・カードの別名
                    <input
                      required
                      pattern="[-A-Za-z0-9_]{1,64}"
                      value={account}
                      onChange={(e) => setAccount(e.target.value)}
                    />
                    <small>複数口座がある場合は別名で区別します。</small>
                  </label>
                  <label>
                    振込手数料列の扱い
                    <select
                      value={feeMode}
                      onChange={(e) => setFeeMode(e.target.value)}
                    >
                      <option value="">手数料列なし / 未指定</option>
                      <option value="included">出金額に含まれる</option>
                      <option value="additional">出金額とは別に支払う</option>
                    </select>
                  </label>
                </div>
                <label>
                  列対応JSON
                  <textarea
                    value={mapping}
                    onChange={(e) => setMapping(e.target.value)}
                  />
                  <small>
                    {
                      '{"date":"お取引日","merchant":"摘要","outflow":"出金","inflow":"入金"}'
                    }
                  </small>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={dedup}
                    onChange={(e) => setDedup(e.target.checked)}
                  />
                  明細IDのない過去取込との一致を重複として除外する（内容を確認済み）
                </label>
              </details>
              <button disabled={busy || !file}>
                {busy ? "処理中…" : "CSVを取り込む"}
              </button>
            </form>
          </section>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>2. 項目に振り分ける</h2>
                <p>
                  {transactions.length}件 ／ 未分類 {pending}件
                </p>
              </div>
              <label>
                対象年
                <input
                  type="number"
                  min="2000"
                  max="2100"
                  required
                  value={year}
                  onChange={(e) => {
                    setYear(e.target.value);
                    setLimit(100);
                    setPreviewLimit(100);
                    setPreviewSheet(0);
                  }}
                />
              </label>
            </div>
            <div className="filters">
              <label>
                明細を検索
                <input
                  type="search"
                  placeholder="利用先・日付"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setLimit(100);
                  }}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={pendingOnly}
                  onChange={(e) => {
                    setPendingOnly(e.target.checked);
                    setLimit(100);
                  }}
                />
                未分類だけ表示
              </label>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>日付</th>
                    <th>利用先</th>
                    <th>金額</th>
                    <th>振り分け項目</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, limit).map((t) => (
                    <tr key={t.transaction_id}>
                      <td>
                        {t.transaction_date}
                        <small>{serviceNames[t.source_service]}</small>
                      </td>
                      <td>
                        {t.merchant_original}
                        <small>
                          {t.excluded
                            ? "重複除外"
                            : t.direction === "in"
                              ? "入金・返金"
                              : "出金"}
                        </small>
                      </td>
                      <td className="money">
                        {yen(t.direction === "in" ? -t.amount : t.amount)}
                      </td>
                      <td>
                        <select
                          aria-label={`${t.merchant_original} ${t.transaction_date}の項目`}
                          disabled={busy}
                          value={t.category_id ?? ""}
                          onChange={(e) => {
                            if (e.target.value)
                              void save("classify", {
                                id: t.transaction_id,
                                category_id: e.target.value,
                                remember: false,
                                merchant_category: t.merchant_category,
                                purpose_note: t.purpose_note,
                                business_use: "personal",
                              });
                          }}
                        >
                          <option value="" disabled>
                            未分類 — 項目を選択
                          </option>
                          {choices.groups.map((group) => (
                            <optgroup
                              key={group.id}
                              label={categoryDisplayName(group.name)}
                            >
                              {(choices.children.get(group.id) || []).map(
                                (item) => (
                                  <option key={item.id} value={item.id}>
                                    {categoryDisplayName(item.name)}
                                  </option>
                                ),
                              )}
                            </optgroup>
                          ))}
                          {t.category_id &&
                            !selectableIds.has(t.category_id) && (
                              <option value={t.category_id}>
                                {categories.find((c) => c.id === t.category_id)
                                  ?.name || "過去の項目"}
                              </option>
                            )}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && (
              <p className="empty">
                {transactions.length
                  ? "該当する明細はありません。"
                  : `${year}年の明細はありません。CSVを取り込むか、対象年を変更してください。`}
              </p>
            )}
            {rows.length > limit && (
              <button
                className="secondary"
                onClick={() => setLimit(limit + 100)}
              >
                次の100件を表示
              </button>
            )}
          </section>
          <section className="panel" aria-labelledby="excel-preview-title">
            <div className="export-panel">
              <div>
                <h2 id="excel-preview-title">3. 振り分け結果を確認・出力</h2>
                <p>
                  {year}
                  年の年間表と月別明細を確認できます。同じ内容をExcelに出力します。
                </p>
                <small>
                  利用日を基準に集計します。税金・保険・投資も含めた、ご自身の資金用途の記録です。
                </small>
              </div>
              <button
                disabled={
                  busy || !transactions.length || !/^20\d{2}$|^2100$/.test(year)
                }
                onClick={() => {
                  location.href = `/api/export?year=${year}&format=simple`;
                }}
              >
                Excelをダウンロード
              </button>
            </div>
            <p className="muted">
              Google
              スプレッドシートで確認する場合は、ダウンロードしたExcelを「ファイル
              → インポート → アップロード」で開いてください。
            </p>
            <label className="sheet-picker">
              表示するシート
              <select
                value={previewSheet}
                onChange={(e) => {
                  setPreviewSheet(Number(e.target.value));
                  setPreviewLimit(100);
                }}
              >
                <option value={0}>年間_項目別（1〜12月）</option>
                {sheets.slice(1).map((sheet, i) => (
                  <option key={i} value={i + 1}>
                    {i + 1}月の明細
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              利用した月で集計します（請求月・引落月ではありません）。返金は返金された月に差し引きます。カード引落・振替・チャージ・重複除外は年間表に加算しません。入金や集計対象外の取引も月別明細で確認できます。
            </p>
            <p className="muted">
              上の検索・未分類フィルターは年間表と出力には影響しません。
            </p>
            <div
              className="table-scroll spreadsheet-preview"
              tabIndex={0}
              role="region"
              aria-label="Excel出力プレビュー"
            >
              <table>
                <caption>{spreadsheet.title}</caption>
                <thead>
                  <tr className="sheet-columns">
                    <th aria-label="行番号"></th>
                    {spreadsheet.rows[0].map((_, i) => (
                      <th key={i} scope="col">
                        {String.fromCharCode(65 + i)}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row">1</th>
                    {spreadsheet.rows[0].map((cell, i) => (
                      <th key={i} scope="col">
                        {cell}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows
                    .slice(
                      0,
                      previewSheet === 0 ? previewRows.length : previewLimit,
                    )
                    .map((row, i) => (
                      <tr
                        key={i}
                        style={
                          spreadsheet.colors?.[i + 1]
                            ? {
                                backgroundColor:
                                  "#" + spreadsheet.colors[i + 1],
                                fontWeight: 600,
                              }
                            : undefined
                        }
                      >
                        <th scope="row">{i + 2}</th>
                        {row.map((cell, j) => (
                          <td
                            key={j}
                            className={
                              typeof cell === "number" ? "money" : undefined
                            }
                          >
                            {typeof cell === "number"
                              ? cell.toLocaleString("ja-JP")
                              : cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {!previewRows.length && (
              <p className="empty">
                対象年の明細を取り込むと、ここに月別明細が表示されます。
              </p>
            )}
            {previewSheet !== 0 && previewRows.length > previewLimit && (
              <button
                className="secondary"
                onClick={() => setPreviewLimit(previewLimit + 100)}
              >
                プレビューの次の100件を表示
              </button>
            )}
            <small>
              年間表の月別合計は、月別明細の「資金用途
              集計額」の合計と一致します。画面で項目を変更すると、保存後に表も更新されます。Excel・スプレッドシートでの編集はこのツールには反映されません。
            </small>
          </section>
        </>
      )}
    </main>
  );
}
