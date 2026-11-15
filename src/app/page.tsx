"use client";
import { categoryDisplayName } from "@/lib/category-order";
import { useEffect, useState, useRef, Fragment } from "react";
import { personalReports, personalCategoryChoices } from "@/lib/spreadsheet";
import { createBrowserClient } from "@supabase/ssr";
import {
  services,
  serviceNames,
  type Service,
  type Transaction,
  type Category,
} from "@/lib/types";
type EditorMode = "rename" | "add-group" | "add-item" | "move" | "delete";
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
  const [lastCategoryId, setLastCategoryId] = useState("");
  const previewRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDialogElement>(null);
  const [editor, setEditor] = useState<{
    mode: EditorMode;
    id?: string;
    parentId?: string;
  } | null>(null);
  const [editName, setEditName] = useState("");
  const [editParent, setEditParent] = useState("");
  const [replacement, setReplacement] = useState("");
  useEffect(() => {
    if (editor) editorRef.current?.showModal();
    else editorRef.current?.close();
  }, [editor]);
  async function refresh() {
    const r = await fetch("/api/state", { cache: "no-store" });
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
  async function save(
    path: string,
    body: FormData | object,
    optimistic?: Payload,
  ) {
    const previous = data;
    let persisted = false;
    if (optimistic) setData(optimistic);
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
      persisted = true;
      if (
        (path === "classify" || path.startsWith("categories")) &&
        result.state &&
        result.categories
      ) {
        setData((current) =>
          current
            ? { ...current, state: result.state, categories: result.categories }
            : current,
        );
      } else {
        await refresh();
      }
      setNotice(
        path === "imports"
          ? `${result.count}件を取り込みました（重複${result.duplicates}件をスキップ）。項目を選んで振り分けてください。`
          : path.startsWith("categories")
            ? "シートを更新しました。"
            : "振り分けを保存しました。",
      );
      return true;
    } catch (e) {
      if (optimistic && !persisted) setData(previous);
      setError(
        persisted
          ? "保存済みですが、最新情報を取得できませんでした。再読み込みしてください。"
          : (e as Error).message,
      );
      return false;
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
  const highlightedCategory =
    choices.canonicalIdById.get(lastCategoryId) || lastCategoryId;
  useEffect(() => {
    const container = previewRef.current;
    const row = container?.querySelector<HTMLElement>('[data-updated="true"]');
    if (container && row) {
      container.scrollTop +=
        row.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        100;
    }
  }, [data, highlightedCategory, previewSheet]);
  function openEditor(mode: EditorMode, id?: string, parentId?: string) {
    const category = categories.find((c) => c.id === id);
    setEditName(category?.name || "");
    setEditParent(parentId || category?.parent_id || "");
    setReplacement("");
    setError("");
    setEditor({ mode, id, parentId });
  }
  const editedCategory = categories.find((c) => c.id === editor?.id);
  function categoryCell(id: string) {
    const category = categories.find((c) => c.id === id);
    if (!category) return null;
    const kind = category.selectable ? "項目" : "分類";
    const name = categoryDisplayName(category.name);
    const peers = category.selectable
      ? choices.children.get(
          choices.displayGroupByItemId.get(id) || category.parent_id || "",
        ) || []
      : choices.groups;
    const index = peers.findIndex((c) => c.id === id);
    return (
      <div className="sheet-category-cell">
        <span className="category-name">{name}</span>
        <span className="sheet-row-actions">
          <button
            type="button"
            className="sheet-icon"
            disabled={busy}
            aria-label={`${kind}「${name}」の名前を変更`}
            onClick={() => openEditor("rename", id)}
          >
            🖋
          </button>
          {(["up", "down"] as const).map((direction) => {
            const neighbor = peers[index + (direction === "up" ? -1 : 1)];
            return (
              <button
                key={direction}
                type="button"
                className="sheet-icon"
                disabled={busy || !neighbor}
                aria-label={`${kind}「${name}」を${direction === "up" ? "上" : "下"}へ移動`}
                onClick={() =>
                  void save("categories/reorder", {
                    id,
                    direction,
                    relative_id: neighbor?.id,
                  })
                }
              >
                {direction === "up" ? "↑" : "↓"}
              </button>
            );
          })}
          {category.selectable && (
            <button
              type="button"
              className="sheet-icon"
              disabled={busy}
              aria-label={`項目「${name}」を別の分類へ移動`}
              onClick={() => openEditor("move", id)}
            >
              移動
            </button>
          )}
          <button
            type="button"
            className="sheet-icon"
            disabled={busy}
            aria-label={`${kind}「${name}」を削除`}
            onClick={() => openEditor("delete", id)}
          >
            削除
          </button>
        </span>
      </div>
    );
  }
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
          <section className="panel" aria-labelledby="excel-preview-title">
            <div className="export-panel">
              <div>
                <h2 id="excel-preview-title">2. 振り分け結果を確認・出力</h2>
                <p>
                  {year}
                  年の年間表と月別明細を確認できます。同じ内容をExcelに出力します。
                </p>
                <small>
                  利用日を基準に集計します。税金・保険・投資も含めた、ご自身の資金用途の記録です。
                </small>
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
              検索・未分類フィルターは年間表と出力には影響しません。項目を選ぶと年間表の該当行を強調表示します。
            </p>
            {previewSheet === 0 && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => openEditor("add-group")}
              >
                ＋ 分類を追加
              </button>
            )}
            <div
              className="table-scroll spreadsheet-preview"
              ref={previewRef}
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
                      <Fragment key={i}>
                        <tr
                          data-category-id={
                            spreadsheet.editableRows?.[i + 1]?.id
                          }
                          data-row-kind={
                            spreadsheet.editableRows?.[i + 1]?.kind
                          }
                          data-updated={
                            spreadsheet.categoryIds?.[i + 1] ===
                              highlightedCategory && !!highlightedCategory
                          }
                          className={
                            spreadsheet.categoryIds?.[i + 1] ===
                              highlightedCategory && highlightedCategory
                              ? "updated-row"
                              : undefined
                          }
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
                              aria-label={
                                j === 0 ? String(cell).trim() : undefined
                              }
                              className={
                                typeof cell === "number" ? "money" : undefined
                              }
                            >
                              {j === 0 &&
                              spreadsheet.editableRows?.[i + 1] &&
                              spreadsheet.editableRows[i + 1].kind !==
                                "subtotal"
                                ? categoryCell(
                                    spreadsheet.editableRows[i + 1].id,
                                  )
                                : typeof cell === "number"
                                  ? cell.toLocaleString("ja-JP")
                                  : cell}
                            </td>
                          ))}
                        </tr>
                        {spreadsheet.editableRows?.[i + 1]?.kind ===
                          "subtotal" && (
                          <tr className="sheet-add-item">
                            <td colSpan={spreadsheet.rows[0].length + 1}>
                              <button
                                type="button"
                                className="link"
                                disabled={busy}
                                aria-label={`分類「${categories.find((c) => c.id === spreadsheet.editableRows![i + 1].id)?.name}」に項目を追加`}
                                onClick={() =>
                                  openEditor(
                                    "add-item",
                                    undefined,
                                    spreadsheet.editableRows![i + 1].id,
                                  )
                                }
                              >
                                ＋ 項目を追加
                              </button>
                            </td>
                          </tr>
                        )}
                      </Fragment>
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
              集計額」の合計と一致します。項目を選ぶと、同じ利用先の明細とこの表をすぐに更新して保存します。Excel・スプレッドシートでの編集はこのツールには反映されません。
            </small>
          </section>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>3. 項目に振り分ける</h2>
                <p>
                  {transactions.length}件 ／ 未分類 {pending}件
                </p>
              </div>
            </div>
            <p className="muted">
              項目を選ぶと、同じ利用先のすべての明細に反映します。今後取り込む同じ利用先にも適用します（全角・半角、空白などの表記をそろえて照合します）。
            </p>
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
                          value={
                            t.classification_status === "pending"
                              ? ""
                              : (t.category_id ?? "")
                          }
                          onChange={(e) => {
                            const categoryId = e.target.value;
                            if (!categoryId) return;
                            setLastCategoryId(categoryId);
                            setPreviewSheet(0);
                            void save(
                              "classify",
                              {
                                id: t.transaction_id,
                                category_id: categoryId,
                                remember: true,
                                apply_existing: true,
                                all_merchant_types: true,
                                merchant_category: t.merchant_category,
                                purpose_note: t.purpose_note,
                                business_use: "personal",
                              },
                              {
                                ...data,
                                state: {
                                  ...data.state,
                                  transactions: data.state.transactions.map(
                                    (other) =>
                                      other.merchant_normalized ===
                                      t.merchant_normalized
                                        ? {
                                            ...other,
                                            category_id: categoryId,
                                            parent_category_id:
                                              categories.find(
                                                (c) => c.id === categoryId,
                                              )?.parent_id ?? null,
                                            classification_status: "confirmed",
                                            classification_source: "user",
                                            classification_confidence: 1,
                                          }
                                        : other,
                                  ),
                                },
                              },
                            );
                          }}
                        >
                          <option value="" disabled>
                            未確認 — 項目を選択
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
        </>
      )}
      <dialog
        ref={editorRef}
        className="sheet-editor"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setEditor(null);
        }}
      >
        {editor && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const path =
                editor.mode === "delete" ? "categories/delete" : "categories";
              const body =
                editor.mode === "delete"
                  ? {
                      id: editor.id,
                      ...(replacement ? { replacement_id: replacement } : {}),
                    }
                  : {
                      id: editor.id,
                      name: editName,
                      parent_id:
                        editor.mode === "add-group" ||
                        (editedCategory && !editedCategory.selectable)
                          ? null
                          : editParent,
                    };
              if (await save(path, body)) setEditor(null);
            }}
          >
            <h2>
              {editor.mode === "delete"
                ? "分類・項目の削除"
                : editor.mode === "move"
                  ? "項目の移動"
                  : editor.mode.startsWith("add")
                    ? "分類・項目の追加"
                    : "分類・項目の名前を変更"}
            </h2>
            {error && (
              <p role="alert" className="notice error">
                {error}
              </p>
            )}
            {editor.mode === "delete" ? (
              <>
                <p>「{editedCategory?.name}」を削除します。</p>
                <p>
                  使用中の項目は明細と分類ルールを移動します。分類に項目がある場合は、項目を別の分類へ移してから削除します。
                </p>
                <label>
                  削除後の移動先
                  <select
                    value={replacement}
                    onChange={(e) => setReplacement(e.target.value)}
                  >
                    <option value="">未使用・空の場合は移動先なしで削除</option>
                    {(editedCategory?.selectable
                      ? [...choices.children.values()].flat()
                      : choices.groups
                    )
                      .filter((c) => c.id !== editor.id)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.selectable
                            ? `${categories.find((p) => p.id === c.parent_id)?.name} › `
                            : ""}
                          {c.name}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label>
                  名前
                  <input
                    required
                    maxLength={100}
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </label>
                {(editor.mode === "add-item" || editedCategory?.selectable) && (
                  <label>
                    所属する分類
                    <select
                      required
                      value={editParent}
                      onChange={(e) => setEditParent(e.target.value)}
                    >
                      {choices.groups.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
            <div className="actions">
              <button type="submit" disabled={busy}>
                {busy
                  ? "保存中…"
                  : editor.mode === "delete"
                    ? "削除する"
                    : "保存"}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                キャンセル
              </button>
            </div>
          </form>
        )}
      </dialog>
    </main>
  );
}
