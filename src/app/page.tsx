"use client";
import { useEffect, useState, useCallback } from "react";
import { colorHex } from "@/lib/colors";
import { createBrowserClient } from "@supabase/ssr";
import {
  serviceNames,
  services,
  type Service,
  type State,
  type Transaction,
  type Category,
} from "@/lib/types";
import type { summary } from "@/lib/engine";
type PublicTx = Omit<Transaction, "raw_encrypted">;
type Payload = {
  state: Omit<State, "transactions"> & { transactions: PublicTx[] };
  categories: Category[];
  summary: ReturnType<typeof summary>;
  local: boolean;
  google: { configured: boolean; connected: boolean };
};
const yen = (n: number) =>
  new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(n);
const kindNames: Record<string, string> = {
  purchase: "購入",
  refund: "返金",
  card_settlement: "カード引落",
  transfer: "自己口座振替",
  charge: "チャージ",
  income: "入金",
  fee: "手数料",
  loan_principal: "借入元本返済",
  investment: "投資",
  tax: "税金",
  unknown: "未判定",
  failed: "引落不能",
  cancellation: "取消（要確認）",
};
const nav = [
  ["dashboard", "概況", "◫"],
  ["transactions", "明細管理", "☷"],
  ["review", "未分類確認", "◇"],
  ["reconciliation", "重複・照合", "⇄"],
  ["connections", "サービス連携", "⊞"],
  ["rules", "分類辞書", "≡"],
  ["monthly", "月別経費表", "▦"],
  ["audit", "操作履歴", "◷"],
] as const;
export default function App() {
  const [tab, setTab] = useState<string>("dashboard"),
    [month, setMonth] = useState(new Date().toISOString().slice(0, 7)),
    [data, setData] = useState<Payload | null>(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(""),
    [service, setService] = useState(""),
    [category, setCategory] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [selected, setSelected] = useState<PublicTx | null>(null),
    [checked, setChecked] = useState<string[]>([]),
    [reason, setReason] = useState(""),
    [matchKind, setMatchKind] = useState("transfer");
  const [source, setSource] = useState<Service>("smbc_card"),
    [account, setAccount] = useState("card-main"),
    [encoding, setEncoding] = useState("utf-8"),
    [mapping, setMapping] = useState("{}"),
    [feeMode, setFeeMode] = useState(""),
    [allowDedup, setAllowDedup] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [sheet, setSheet] = useState(""),
    [ruleId, setRuleId] = useState(""),
    [ruleMerchant, setRuleMerchant] = useState(""),
    [ruleCategory, setRuleCategory] = useState("");
  const refresh = useCallback(async () => {
    const r = await fetch(`/api/state?month=${month}`);
    if (r.status === 401) {
      location.href = "/login";
      return;
    }
    const body = await r.json();
    if (!r.ok) throw Error(body.error);
    setData(body);
    setSheet(body.state.settings.spreadsheet_id || "");
  }, [month]);
  useEffect(() => {
    refresh().catch((e) => setNotice(e.message));
  }, [refresh]);
  async function post(path: string, body: unknown) {
    const r = await fetch(`/api/${path}`, {
      method: "POST",
      headers:
        body instanceof FormData ? {} : { "Content-Type": "application/json" },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw Error(json.error);
    return json;
  }
  async function act(work: () => Promise<unknown>, message = "保存しました") {
    setBusy(true);
    try {
      await work();
      await refresh();
      setNotice(message);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const categories = data?.categories || [],
    tx = data?.state.transactions || [],
    stats = data?.summary;
  const catName = (id: string | null) =>
    categories.find((c) => c.id === id)?.name || "未分類";
  const options = (
    <>
      <option value="">分類を選択</option>
      {[2025, 2024, 2023].map((year) => (
        <optgroup label={`${year}年度の分類`} key={year}>
          {categories
            .filter((c) => c.selectable && c.year === year)
            .map((c) => (
              <option value={c.id} key={c.id}>
                {categories.find((p) => p.id === c.parent_id)?.name} › {c.name}{" "}
                [{c.source_cell}]
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
  const filtered = tx
    .filter(
      (t) =>
        (!search ||
          `${t.merchant_original} ${t.merchant_normalized} ${t.account_id}`
            .toLowerCase()
            .includes(search.toLowerCase())) &&
        (!service || t.source_service === service) &&
        (!category ||
          (category === "pending"
            ? t.classification_status === "pending"
            : t.category_id === category)) &&
        (!from || t.transaction_date >= from) &&
        (!to || t.transaction_date <= to) &&
        (tab !== "review" || t.classification_status === "pending"),
    )
    .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date));
  const txTable = (rows: PublicTx[], selectable = false) => (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {selectable && <th>選択</th>}
            <th>日付 / 決済手段</th>
            <th>利用先</th>
            <th>用途分類</th>
            <th>金額</th>
            <th>状態</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 500).map((t) => (
            <tr key={t.transaction_id}>
              {selectable && (
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${t.merchant_original} ${t.transaction_date}を照合対象に選択`}
                    checked={checked.includes(t.transaction_id)}
                    onChange={(e) =>
                      setChecked(
                        e.target.checked
                          ? [...checked, t.transaction_id]
                          : checked.filter((id) => id !== t.transaction_id),
                      )
                    }
                  />
                </td>
              )}
              <td>
                {t.transaction_date}
                <small>
                  {serviceNames[t.source_service]} · {t.account_id}
                </small>
              </td>
              <td>
                <strong>{t.merchant_original}</strong>
                <small>
                  {kindNames[t.transaction_type]}
                  {t.installment ? ` · ${t.installment}` : ""}
                </small>
              </td>
              <td>
                <span
                  className={
                    t.classification_status === "pending"
                      ? "pill amber"
                      : "pill"
                  }
                >
                  {catName(t.category_id)}
                </span>
                {t.merchant_category && (
                  <small>利用先分類: {t.merchant_category}</small>
                )}
              </td>
              <td className="money">
                {t.direction === "in" ? "−" : ""}
                {yen(t.amount)}
                <small>
                  {t.excluded
                    ? "重複除外"
                    : t.direction === "in"
                      ? "入金・返金"
                      : "出金"}
                </small>
              </td>
              <td>
                <span
                  className={
                    t.reconciliation_status === "pending"
                      ? "status pending"
                      : "status"
                  }
                >
                  {t.reconciliation_status === "pending"
                    ? "照合待ち"
                    : t.reconciliation_status === "matched"
                      ? "照合済"
                      : "照合不要"}
                </span>
              </td>
              <td>
                <button className="link" onClick={() => setSelected(t)}>
                  詳細・分類 →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <Empty
          title="該当する明細はありません"
          text="CSVを取り込むと、ここに取引が表示されます。"
        />
      )}
      {rows.length > 500 && (
        <p>先頭500件を表示しています。検索条件で絞り込んでください。</p>
      )}
    </div>
  );
  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-icon">G</span>
          <span>
            GALAPAGOS<small>EXPENSE MANAGER</small>
          </span>
        </a>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          {nav.map(([id, label, icon]) => (
            <button
              className={tab === id ? "nav active" : "nav"}
              key={id}
              onClick={() => setTab(id)}
            >
              <span>{icon}</span>
              {label}
              {id === "review" && !!stats?.unclassified && (
                <b>{stats.unclassified}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="dot" />
          {data?.local ? "ローカル検証環境" : "認証済みワークスペース"}
          <small>支出管理専用 · 売上とは独立</small>
          {data && !data.local && (
            <button
              className="link"
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
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">
              FINANCE / {nav.find((n) => n[0] === tab)?.[1]}
            </p>
            <h1>
              {tab === "dashboard"
                ? "お金の流れを、クリアに。"
                : nav.find((n) => n[0] === tab)?.[1]}
            </h1>
            <p className="muted">
              購入支出と資金移動を分けて、正確な毎月の記録を。
            </p>
          </div>
          <div className="header-actions">
            <label className="month-picker">
              対象月
              <input
                aria-label="対象月"
                type="month"
                value={month}
                onChange={(e) => e.target.value && setMonth(e.target.value)}
              />
            </label>
            <button onClick={() => setTab("connections")}>
              ＋ 明細を取り込む
            </button>
          </div>
        </header>
        {notice && (
          <div role="status" className="notice">
            <span>{notice}</span>
            <button
              aria-label="通知を閉じる"
              className="link"
              onClick={() => setNotice("")}
            >
              ×
            </button>
          </div>
        )}
        {data?.state.sync.error && (
          <div role="alert" className="notice error">
            Sheets同期エラー: {data.state.sync.error}
            。データはDBに保存済みです。
          </div>
        )}
        {!data ? (
          <section className="panel">
            <h2>環境を確認しています</h2>
            <p>初回起動時は .env.local の設定を確認してください。</p>
            <a href="/login">ログイン画面</a>
          </section>
        ) : (
          <>
            {tab === "dashboard" && stats && (
              <>
                <div className="section-line">
                  <span className="pill">
                    {month.replace("-", "年 ")}月の概況
                  </span>
                  <span className={stats.final ? "status" : "status pending"}>
                    {stats.final ? "照合確認済み" : "暫定集計 · 確認待ちあり"}
                  </span>
                </div>
                <section className="metrics">
                  <article className="metric primary">
                    <p>
                      月間購入支出 <span>↗</span>
                    </p>
                    <h2>{yen(stats.purchase)}</h2>
                    <small>前月比 {yen(stats.purchase - stats.previous)}</small>
                    <div className="metric-line" />
                  </article>
                  <article className="metric">
                    <p>年間購入支出</p>
                    <h2>{yen(stats.annual)}</h2>
                    <small>{month.slice(0, 4)}年 1月〜12月</small>
                  </article>
                  <article className="metric">
                    <p>銀行からの出金</p>
                    <h2>{yen(stats.bank_outflow)}</h2>
                    <small>購入支出とは別のキャッシュフロー</small>
                  </article>
                  <article className="metric">
                    <p>資金移動</p>
                    <h2>{yen(stats.transfers)}</h2>
                    <small>カード引落・振替・チャージの出金側</small>
                  </article>
                </section>
                <div className="grid-two">
                  <section className="panel">
                    <div className="panel-head">
                      <div>
                        <h2>月別の購入支出</h2>
                        <p>{month.slice(0, 4)}年の推移</p>
                      </div>
                      <span className="legend">
                        <i /> 購入・手数料 − 返金
                      </span>
                    </div>
                    <div
                      className="chart"
                      role="img"
                      aria-label="月別購入支出の棒グラフ"
                    >
                      {stats.monthly.map((m) => (
                        <div className="bar-column" key={m.month}>
                          <span className="chart-value">
                            {m.amount ? yen(m.amount) : ""}
                          </span>
                          <div
                            className={
                              m.month === Number(month.slice(5))
                                ? "bar current"
                                : "bar"
                            }
                            style={{
                              height: `${Math.max(2, (Math.abs(m.amount) / Math.max(1, ...stats.monthly.map((x) => Math.abs(x.amount)))) * 130)}px`,
                              background: m.amount < 0 ? "#b96949" : undefined,
                            }}
                            title={yen(m.amount)}
                          />
                          <small>{m.month}月</small>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section className="panel">
                    <div className="panel-head">
                      <div>
                        <h2>確認が必要な項目</h2>
                        <p>確かめるほど、次回からスムーズに。</p>
                      </div>
                      <span className="round-icon">◇</span>
                    </div>
                    <button
                      className="review-line"
                      onClick={() => setTab("review")}
                    >
                      <span>
                        用途分類の確認<small>初めての利用先・未分類</small>
                      </span>
                      <b>
                        {stats.unclassified}
                        <small>件 →</small>
                      </b>
                    </button>
                    <button
                      className="review-line"
                      onClick={() => setTab("reconciliation")}
                    >
                      <span>
                        明細の照合
                        <small>
                          未照合 {stats.unreconciled}件 / 重複候補{" "}
                          {stats.candidates}件
                        </small>
                      </span>
                      <b>
                        {stats.unreconciled}
                        <small>件 →</small>
                      </b>
                    </button>
                    <p className="footnote">
                      用途・事業利用は推測で確定しません。表示額は税務上の必要経費ではありません。
                    </p>
                  </section>
                </div>
                <div className="grid-two">
                  <Breakdown
                    title="利用先別の支出"
                    entries={Object.entries(stats.by_merchant)}
                    total={stats.purchase}
                  />
                  <Breakdown
                    title="用途カテゴリの内訳"
                    entries={Object.entries(stats.by_category).map(([k, v]) => [
                      catName(k),
                      v,
                    ])}
                    total={stats.purchase}
                  />
                </div>
                <div className="grid-two">
                  <Breakdown
                    title="決済サービス別の購入支出"
                    entries={Object.entries(stats.by_service).map(([k, v]) => [
                      serviceNames[k as Service],
                      v,
                    ])}
                    total={stats.purchase}
                  />
                  <Breakdown
                    title="銀行別の出金額"
                    entries={Object.entries(stats.by_bank).map(([k, v]) => [
                      serviceNames[k as Service],
                      v,
                    ])}
                    total={stats.bank_outflow}
                  />
                </div>
                <section className="panel">
                  <div className="panel-head">
                    <h2>最近の明細</h2>
                    <button
                      className="link"
                      onClick={() => setTab("transactions")}
                    >
                      すべての明細 →
                    </button>
                  </div>
                  {txTable(
                    [...tx]
                      .sort((a, b) =>
                        b.transaction_date.localeCompare(a.transaction_date),
                      )
                      .slice(0, 5),
                  )}
                </section>
              </>
            )}
            {(tab === "transactions" || tab === "review") && (
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2>
                      {tab === "review"
                        ? "用途を確認して、分類を記憶"
                        : "すべての取引明細"}
                    </h2>
                    <p>
                      {filtered.length}件 ·
                      この画面は全期間を対象。日付で絞り込みできます。
                    </p>
                  </div>
                  <a
                    className="button secondary"
                    href={`/api/export?year=${month.slice(0, 4)}`}
                  >
                    Excel出力
                  </a>
                </div>
                <div className="filters">
                  <input
                    aria-label="利用先検索"
                    placeholder="利用先・口座別名を検索"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <select
                    aria-label="決済手段"
                    value={service}
                    onChange={(e) => setService(e.target.value)}
                  >
                    <option value="">すべての決済手段</option>
                    {services.map((s) => (
                      <option key={s} value={s}>
                        {serviceNames[s]}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="分類フィルター"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    <option value="">すべての分類</option>
                    <option value="pending">未分類</option>
                    {categories
                      .filter((c) => c.selectable)
                      .map((c) => (
                        <option value={c.id} key={c.id}>
                          {c.name} ({c.year}/{c.source_cell})
                        </option>
                      ))}
                  </select>
                  <label>
                    開始日
                    <input
                      type="date"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </label>
                  <label>
                    終了日
                    <input
                      type="date"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </label>
                </div>
                {txTable(filtered)}
              </section>
            )}
            {tab === "reconciliation" && (
              <>
                <div className="notice">
                  金額だけでは自動確定しません。分割・リボ、再引落し、部分取得は請求書を確認してください。
                </div>
                <section className="panel">
                  <h2>照合候補</h2>
                  {!data.state.reconciliations.length && (
                    <Empty
                      title="照合候補はまだありません"
                      text="カードID・請求月・引落日・共通参照IDを含めると照合の精度が上がります。"
                    />
                  )}
                  {data.state.reconciliations.map((r) => (
                    <div className="match" key={r.id}>
                      <div>
                        <span
                          className={
                            r.status === "candidate" ? "pill amber" : "pill"
                          }
                        >
                          {r.status === "candidate"
                            ? "確認待ち"
                            : r.status === "confirmed"
                              ? "照合済み"
                              : "別の取引"}
                        </span>
                        <h3>{kindNames[r.kind] || "重複購入"}</h3>
                        <p>{r.reason}</p>
                        <ul>
                          {r.transaction_ids.map((id) => {
                            const t = tx.find((t) => t.transaction_id === id);
                            return (
                              <li key={id}>
                                {t?.transaction_date} · {t?.merchant_original} ·{" "}
                                {yen(t?.amount || 0)}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                      {r.status === "candidate" && (
                        <div className="match-actions">
                          <input
                            aria-label="確認根拠"
                            placeholder="請求書などの確認根拠"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                          />
                          <button
                            disabled={busy || reason.length < 3}
                            onClick={() =>
                              act(() =>
                                post("reconcile", {
                                  id: r.id,
                                  confirmed: true,
                                  reason,
                                }),
                              )
                            }
                          >
                            同一の取引として確定
                          </button>
                          <button
                            className="secondary"
                            disabled={busy || reason.length < 3}
                            onClick={() =>
                              act(() =>
                                post("reconcile", {
                                  id: r.id,
                                  confirmed: false,
                                  reason,
                                }),
                              )
                            }
                          >
                            別の取引
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </section>
                <section className="panel">
                  <h2>手動で対応付ける</h2>
                  <p className="muted">
                    不明な銀行取引は「詳細・分類」で種別を確認後に対応付けます。カード利用は複数選択できます。
                  </p>
                  <div className="filters">
                    <select
                      aria-label="照合種別"
                      value={matchKind}
                      onChange={(e) => setMatchKind(e.target.value)}
                    >
                      <option value="transfer">銀行間振替</option>
                      <option value="charge">PayPayチャージ</option>
                      <option value="card_settlement">カード引落</option>
                      <option value="duplicate">PayPay・カード重複</option>
                      <option value="cancellation">購入と利用取消</option>
                    </select>
                    <input
                      aria-label="手動照合の根拠"
                      placeholder="確認根拠（3文字以上）"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <button
                      disabled={busy || checked.length < 2 || reason.length < 3}
                      onClick={() =>
                        act(async () => {
                          await post("manual-match", {
                            ids: checked,
                            kind: matchKind,
                            reason,
                          });
                          setChecked([]);
                        })
                      }
                    >
                      {checked.length}件を照合
                    </button>
                  </div>
                  {txTable(
                    tx.filter((t) => t.reconciliation_status !== "matched"),
                    true,
                  )}
                </section>
              </>
            )}
            {tab === "connections" && (
              <>
                <div className="service-grid">
                  {services.map((s) => {
                    const last = data.state.batches
                      .filter((b) => b.source === s)
                      .at(-1);
                    return (
                      <article className="panel service" key={s}>
                        <span className="service-symbol">
                          {s === "paypay"
                            ? "P"
                            : s.endsWith("bank")
                              ? "▥"
                              : "▰"}
                        </span>
                        <h3>{serviceNames[s]}</h3>
                        <span className="pill">CSV取込</span>
                        <p>金融API: 未接続</p>
                        <small>
                          最終取込:{" "}
                          {last
                            ? new Date(last.at).toLocaleString("ja-JP")
                            : "まだありません"}
                        </small>
                        <button
                          className="secondary"
                          onClick={() => {
                            setSource(s);
                            setAccount(
                              s.endsWith("bank")
                                ? "bank-main"
                                : s === "paypay"
                                  ? "paypay-main"
                                  : "card-main",
                            );
                            document
                              .getElementById("upload")
                              ?.scrollIntoView({ behavior: "smooth" });
                          }}
                        >
                          明細を取り込む
                        </button>
                      </article>
                    );
                  })}
                </div>
                <div className="grid-two">
                  <section className="panel" id="upload">
                    <h2>CSVをアップロード</h2>
                    <p className="muted">
                      解析 → 分類候補 → 照合 → Sheets更新を自動で実行します。
                    </p>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!file) return;
                        const form = new FormData();
                        form.set("file", file);
                        form.set("source", source);
                        form.set("account", account);
                        form.set("encoding", encoding);
                        form.set("mapping", mapping);
                        form.set("allowFingerprintDedup", String(allowDedup));
                        if (feeMode) form.set("feeMode", feeMode);
                        act(async () => {
                          const r = await post("imports", form);
                          setNotice(
                            `${r.count}件を取込 / ${r.duplicates}件の重複をスキップ`,
                          );
                        }, "取込処理が完了しました。件数は取込履歴で確認できます。");
                      }}
                    >
                      <div className="form-grid">
                        <label>
                          金融サービス
                          <select
                            value={source}
                            onChange={(e) =>
                              setSource(e.target.value as Service)
                            }
                          >
                            {services.map((s) => (
                              <option key={s} value={s}>
                                {serviceNames[s]}
                              </option>
                            ))}
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
                          <small>実口座番号を入力しないでください。</small>
                        </label>
                        <label>
                          文字コード
                          <select
                            value={encoding}
                            onChange={(e) => setEncoding(e.target.value)}
                          >
                            <option value="utf-8">UTF-8</option>
                            <option value="shift_jis">Shift_JIS / CP932</option>
                          </select>
                        </label>
                        <label>
                          振込手数料列の扱い
                          <select
                            value={feeMode}
                            onChange={(e) => setFeeMode(e.target.value)}
                          >
                            <option value="">手数料列なし / 未指定</option>
                            <option value="included">出金額に含まれる</option>
                            <option value="additional">
                              出金額とは別に支払う
                            </option>
                          </select>
                        </label>
                      </div>
                      <label className="dropzone">
                        <b>↑ CSVファイルを選択</b>
                        <small>最大5MB / 20,000行 · 全行検証後に一括保存</small>
                        <input
                          aria-label="CSVファイル"
                          type="file"
                          accept=".csv,text/csv"
                          required
                          onChange={(e) => setFile(e.target.files?.[0] || null)}
                        />
                      </label>
                      <details>
                        <summary>列名が認識されない場合の対応設定</summary>
                        <p>
                          JSON例:{" "}
                          {`{"date":"お取引日","merchant":"摘要","outflow":"出金","inflow":"入金"}`}
                        </p>
                        <textarea
                          aria-label="列対応JSON"
                          value={mapping}
                          onChange={(e) => setMapping(e.target.value)}
                        />
                      </details>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={allowDedup}
                          onChange={(e) => setAllowDedup(e.target.checked)}
                        />
                        明細IDのない過去取込との一致を重複として除外する（内容を確認済み）
                      </label>
                      <button disabled={busy || !file}>
                        {busy ? "処理中…" : "明細を取り込む"}
                      </button>
                      <a
                        className="link"
                        href={`/samples/${source}.csv`}
                        download
                      >
                        検証用CSV（架空データ）
                      </a>
                    </form>
                  </section>
                  <section className="panel">
                    <h2>Google スプレッドシート</h2>
                    <div className="connection-state">
                      <span
                        className={data.google.connected ? "dot" : "dot gray"}
                      />
                      {data.google.connected ? "Google認証済み" : "未接続"}
                    </div>
                    <p>
                      専用のスプレッドシートを作成してIDを指定してください。データベースを正本として8種類のシートを更新します。
                    </p>
                    <label>
                      スプレッドシートID
                      <input
                        value={sheet}
                        onChange={(e) => setSheet(e.target.value)}
                        placeholder="URLの /d/ と /edit の間"
                      />
                    </label>
                    <div className="actions">
                      <button
                        disabled={busy || !sheet}
                        onClick={() =>
                          act(() => post("settings", { spreadsheet_id: sheet }))
                        }
                      >
                        保存
                      </button>
                      <button
                        className="secondary"
                        disabled={busy || !data.google.configured}
                        onClick={() =>
                          act(async () => {
                            const r = await post("google/connect", {});
                            location.href = r.url;
                          })
                        }
                      >
                        Googleで認証
                      </button>
                      <button
                        className="secondary"
                        disabled={busy || !data.google.connected}
                        onClick={() =>
                          act(
                            () =>
                              post("google/sync", {
                                year: Number(month.slice(0, 4)),
                              }),
                            "Sheetsを更新しました",
                          )
                        }
                      >
                        手動同期
                      </button>
                    </div>
                    <p className="footnote">
                      {data.google.configured
                        ? "OAuth設定済み"
                        : "管理者によるGoogle OAuth設定が必要です。"}
                      <br />
                      最終成功:{" "}
                      {data.state.sync.last_success
                        ? new Date(data.state.sync.last_success).toLocaleString(
                            "ja-JP",
                          )
                        : "未同期"}
                      <br />
                      更新状態:{" "}
                      {data.state.sync.dirty ? "同期待ち" : "変更なし"}
                    </p>
                    <div className="notice">
                      手動メモはAO列以降、または専用の別シートへ。A〜AN列はシステムが更新します。
                    </div>
                  </section>
                </div>
                <section className="panel">
                  <h2>取込履歴</h2>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>日時</th>
                          <th>サービス</th>
                          <th>口座別名</th>
                          <th>新規</th>
                          <th>重複</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...data.state.batches].reverse().map((b) => (
                          <tr key={b.id}>
                            <td>{new Date(b.at).toLocaleString("ja-JP")}</td>
                            <td>{serviceNames[b.source]}</td>
                            <td>{b.account_id}</td>
                            <td>{b.count}</td>
                            <td>{b.duplicates}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
                <section className="panel">
                  <h2>バックアップと復旧</h2>
                  <p>
                    暗号化バックアップと暗号鍵を別々の安全な場所に保管してください。復旧は不足明細を追加し、既存明細は削除しません。
                  </p>
                  <div className="actions">
                    <a href="/api/backup" className="button secondary">
                      暗号化バックアップ
                    </a>
                    <label>
                      バックアップから不足明細を復旧
                      <input
                        type="file"
                        accept=".enc"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f)
                            act(async () =>
                              post("restore", { backup: await f.text() }),
                            );
                        }}
                      />
                    </label>
                  </div>
                </section>
              </>
            )}
            {tab === "rules" && (
              <>
                <section className="panel">
                  <h2>承認済みの分類ルール</h2>
                  <p>
                    完全一致する正規化利用先に適用します。Amazon等の用途が変わる利用先には、安易に用途ルールを登録しないでください。
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      act(async () => {
                        await post("rules", {
                          id: ruleId || undefined,
                          merchant: ruleMerchant,
                          category_id: ruleCategory,
                        });
                        setRuleId("");
                        setRuleMerchant("");
                        setRuleCategory("");
                      });
                    }}
                  >
                    <div className="form-grid">
                      <label>
                        利用先
                        <input
                          required
                          value={ruleMerchant}
                          onChange={(e) => setRuleMerchant(e.target.value)}
                        />
                      </label>
                      <label>
                        用途分類
                        <select
                          required
                          value={ruleCategory}
                          onChange={(e) => setRuleCategory(e.target.value)}
                        >
                          {options}
                        </select>
                      </label>
                    </div>
                    <button disabled={busy}>
                      {ruleId ? "ルールを更新" : "承認して登録"}
                    </button>
                  </form>
                </section>
                <section className="panel">
                  <table>
                    <thead>
                      <tr>
                        <th>正規化利用先</th>
                        <th>用途分類</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.state.rules.map((r) => (
                        <tr key={r.id}>
                          <td>{r.merchant_normalized}</td>
                          <td>{catName(r.category_id)}</td>
                          <td>
                            <button
                              className="link"
                              onClick={() => {
                                setRuleId(r.id);
                                setRuleMerchant(r.merchant_normalized);
                                setRuleCategory(r.category_id);
                              }}
                            >
                              編集
                            </button>
                            <button
                              className="link danger"
                              disabled={busy}
                              onClick={() =>
                                act(() =>
                                  post("rules", { id: r.id, delete: true }),
                                )
                              }
                            >
                              削除
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!data.state.rules.length && (
                    <Empty
                      title="まだルールはありません"
                      text="明細の分類確認で「次回も適用」を選ぶと、ここに保存されます。"
                    />
                  )}
                </section>
              </>
            )}
            {tab === "monthly" && (
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2>{month.slice(0, 4)}年 月別経費</h2>
                    <p>
                      2025年の分類順・色を基本に、過去年度の分類を保持しています。
                    </p>
                  </div>
                  <a
                    className="button secondary"
                    href={`/api/export?year=${month.slice(0, 4)}`}
                  >
                    Excel出力
                  </a>
                </div>
                <Monthly
                  categories={categories}
                  transactions={tx}
                  year={month.slice(0, 4)}
                />
              </section>
            )}
            {tab === "audit" && (
              <section className="panel">
                <h2>操作・変更履歴</h2>
                <p>取込・分類・ルール変更・照合の操作を記録します。</p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>日時</th>
                        <th>操作</th>
                        <th>対象ID</th>
                        <th>変更内容</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...data.state.audit].reverse().map((a) => (
                        <tr key={a.id}>
                          <td>{new Date(a.at).toLocaleString("ja-JP")}</td>
                          <td>{a.action}</td>
                          <td>
                            <code>{a.entity_id.slice(0, 12)}</code>
                          </td>
                          <td>
                            <code>{JSON.stringify(a.detail)}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
        <footer>
          GALAPAGOS EXPENSES{" "}
          <span>購入支出の管理 · 税務上の経費判定は含みません</span>
        </footer>
      </main>
      {selected && (
        <Detail
          key={selected.transaction_id}
          tx={selected}
          options={options}
          categories={categories}
          busy={busy}
          close={() => setSelected(null)}
          submit={(path, b) =>
            act(async () => {
              await post(path, b);
              setSelected(null);
            })
          }
        />
      )}
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <span>▤</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function Breakdown({
  title,
  entries,
  total,
}: {
  title: string;
  entries: [string, number][];
  total: number;
}) {
  const list = entries
    .filter(([, n]) => n !== 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  return (
    <section className="panel">
      <h2>{title}</h2>
      {!list.length ? (
        <Empty
          title="集計データはまだありません"
          text="明細の取込後に自動で集計されます。"
        />
      ) : (
        list.map(([k, v]) => (
          <div className="breakdown" key={k}>
            <div>
              <span>{k}</span>
              <b>{yen(v)}</b>
            </div>
            <div className="track">
              <i
                style={{
                  width: `${Math.min(100, (Math.abs(v) / Math.max(1, Math.abs(total))) * 100)}%`,
                }}
              />
            </div>
          </div>
        ))
      )}
    </section>
  );
}
function Detail({
  tx,
  options,
  categories,
  busy,
  close,
  submit,
}: {
  tx: PublicTx;
  options: React.ReactNode;
  categories: Category[];
  busy: boolean;
  close: () => void;
  submit: (path: string, b: unknown) => void;
}) {
  const [cat, setCat] = useState(
      tx.category_id || tx.suggested_category_ids[0] || "",
    ),
    [remember, setRemember] = useState(false),
    [merchant, setMerchant] = useState(tx.merchant_category || ""),
    [note, setNote] = useState(tx.purpose_note),
    [use, setUse] = useState(tx.business_use),
    [kind, setKind] = useState(tx.transaction_type),
    [reason, setReason] = useState(""),
    [raw, setRaw] = useState("");
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <h2 id="detail-title">明細の詳細・分類確認</h2>
          <button className="link" onClick={close}>
            閉じる ×
          </button>
        </div>
        <h3>{tx.merchant_original}</h3>
        <p className="detail-amount">{yen(tx.amount)}</p>
        <p>
          {tx.transaction_date} · {serviceNames[tx.source_service]} ·{" "}
          {tx.account_id}
        </p>
        <dl>
          <dt>分類候補（未確定）</dt>
          <dd>
            {tx.suggested_category_ids
              .map((id) => categories.find((c) => c.id === id)?.name)
              .join(" / ") || "候補なし"}
          </dd>
          <dt>正規化利用先</dt>
          <dd>{tx.merchant_normalized}</dd>
          <dt>請求月 / 引落日</dt>
          <dd>
            {tx.billing_month || "未取得"} /{" "}
            {tx.scheduled_debit_date || "未取得"}
          </dd>
          <dt>分割・リボ</dt>
          <dd>{tx.installment || "未取得 / なし"}</dd>
        </dl>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit("classify", {
              id: tx.transaction_id,
              category_id: cat,
              remember,
              merchant_category: merchant || null,
              purpose_note: note,
              business_use: use,
            });
          }}
        >
          <label>
            用途分類
            <select
              required
              value={cat}
              onChange={(e) => setCat(e.target.value)}
            >
              {options}
            </select>
          </label>
          <label>
            利用先分類（用途とは別）
            <input
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
              placeholder="例: Amazon・コンビニ"
            />
          </label>
          <label>
            用途メモ
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
            />
          </label>
          <label>
            個人・事業
            <select
              value={use}
              onChange={(e) =>
                setUse(e.target.value as Transaction["business_use"])
              }
            >
              <option value="unknown">未判定</option>
              <option value="business">事業</option>
              <option value="personal">個人</option>
              <option value="mixed">混在</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            同じ利用先の用途分類を次回も適用する
          </label>
          <button disabled={busy || !cat}>分類を承認して保存</button>
        </form>
        <hr />
        <h3>取引種別の確認</h3>
        <p className="muted">
          銀行の未知の出金、返金、取消などは根拠を確認して変更します。
        </p>
        <select
          aria-label="取引種別"
          value={kind}
          onChange={(e) =>
            setKind(e.target.value as Transaction["transaction_type"])
          }
        >
          {Object.entries(kindNames).map(([k, n]) => (
            <option key={k} value={k}>
              {n}
            </option>
          ))}
        </select>
        <input
          aria-label="種別変更の根拠"
          placeholder="確認根拠（3文字以上）"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="secondary"
          disabled={busy || reason.length < 3}
          onClick={() =>
            submit("type", { id: tx.transaction_id, kind, reason })
          }
        >
          種別を更新
        </button>
        <details>
          <summary
            onClick={() => {
              if (!raw)
                fetch(`/api/original?id=${tx.transaction_id}`)
                  .then((r) => r.json())
                  .then((v) => setRaw(JSON.stringify(v, null, 2)));
            }}
          >
            原本行（長い数値はマスキング）
          </summary>
          <pre>{raw}</pre>
          <small>監査用ID: {tx.transaction_id}</small>
        </details>
      </section>
    </div>
  );
}
function Monthly({
  categories,
  transactions,
  year,
}: {
  categories: Category[];
  transactions: PublicTx[];
  year: string;
}) {
  const amount = (t: PublicTx) =>
    !t.excluded && ["purchase", "refund", "fee"].includes(t.transaction_type)
      ? t.amount * (t.direction === "in" ? -1 : 1)
      : 0;
  const months = (ids: (string | null)[]) =>
    Array.from({ length: 12 }, (_, i) =>
      transactions
        .filter(
          (t) =>
            ids.includes(t.category_id) &&
            t.transaction_date.startsWith(
              `${year}-${String(i + 1).padStart(2, "0")}`,
            ),
        )
        .reduce((n, t) => n + amount(t), 0),
    );
  const row = (
    key: string,
    label: string,
    values: number[],
    className = "",
  ) => (
    <tr key={key} className={className}>
      <th>{label}</th>
      {values.map((n, i) => (
        <td className="money" key={i}>
          {n ? yen(n) : "—"}
        </td>
      ))}
      <td className="money">{yen(values.reduce((a, b) => a + b, 0))}</td>
    </tr>
  );
  return (
    <div className="table-scroll monthly">
      <table>
        <thead>
          <tr>
            <th>分類 / 元年度</th>
            {Array.from({ length: 12 }, (_, i) => (
              <th key={i}>{i + 1}月</th>
            ))}
            <th>年間</th>
          </tr>
        </thead>
        <tbody>
          {categories
            .filter((c) => !c.selectable)
            .sort((a, b) => b.year - a.year || a.order - b.order)
            .flatMap((p) => {
              const kids = categories.filter((c) => c.parent_id === p.id);
              return [
                <tr
                  className="group"
                  key={p.id}
                  style={{ background: "#" + colorHex(p.color) }}
                >
                  <th colSpan={14}>
                    {p.name} / {p.year}
                  </th>
                </tr>,
                ...kids.map((c) => row(c.id, c.name, months([c.id]))),
                row(
                  p.id + "total",
                  p.name + " 小計",
                  months(kids.map((c) => c.id)),
                  "subtotal",
                ),
              ];
            })}
          {row("unknown", "未分類", months([null]))}
          {row(
            "total",
            "購入支出合計",
            months([
              null,
              ...categories.filter((c) => c.selectable).map((c) => c.id),
            ]),
            "subtotal",
          )}
        </tbody>
      </table>
    </div>
  );
}
