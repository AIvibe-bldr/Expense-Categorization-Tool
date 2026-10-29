import { randomUUID } from "node:crypto";
import { sortGroups } from "./category-order";
export { sortGroups } from "./category-order";
import sourceCategories from "../../data/categories.json";
import { normalize, parseCsv, type Mapping } from "./csv";
import { hash } from "./crypto";
import type {
  State,
  Transaction,
  Category,
  Service,
  Reconciliation,
  ReferenceRecord,
  Kind,
} from "./types";
export const categories = sourceCategories as Category[];
export function effectiveCategories(s: State): Category[] {
  return [...categories, ...(s.custom_categories || [])].map((category) => ({
    ...category,
    ...(s.category_edits?.[category.id] || {}),
  }));
}
export function moveCategory(s: State, id: string, direction: "up" | "down") {
  const groups = sortGroups(effectiveCategories(s));
  const from = groups.findIndex((c) => c.id === id);
  const to = from + (direction === "up" ? -1 : 1);
  if (from < 0 || to < 0 || to >= groups.length)
    throw Error("移動先の分類がありません");
  [groups[from], groups[to]] = [groups[to], groups[from]];
  for (const [index, group] of groups.entries())
    (s.category_edits ||= {})[group.id] = {
      ...s.category_edits?.[group.id],
      name: group.name,
      parent_id: null,
      display_order: index,
    };
  audit(s, "move_category", id, { direction, from, to });
}
export function addCategory(s: State, name: string, parentId: string | null) {
  const all = effectiveCategories(s);
  if (!name.trim() || name.trim().length > 100 || name.includes("合計"))
    throw Error("分類・項目名は1〜100文字で、合計を含めないでください");
  if (parentId && !all.some((c) => c.id === parentId && !c.selectable))
    throw Error("有効な分類を選択してください");
  const category: Category = {
    id: randomUUID(),
    parent_id: parentId,
    name: name.trim(),
    year: new Date().getUTCFullYear(),
    source_sheet: "ユーザー追加",
    source_cell: "",
    order: Math.max(0, ...all.map((c) => c.order)) + 1,
    selectable: !!parentId,
    color: { type: "rgb", value: "FFE8F1DF", tint: 0, pattern: "solid" },
  };
  (s.custom_categories ||= []).push(category);
  audit(s, "add_category", category.id, {
    parent_id: parentId,
    name: category.name,
  });
  return category;
}
export function updateCategory(
  s: State,
  id: string,
  name: string,
  parentId: string | null,
) {
  const all = effectiveCategories(s),
    current = all.find((c) => c.id === id);
  if (
    !current ||
    !name.trim() ||
    name.trim().length > 100 ||
    name.includes("合計")
  )
    throw Error("有効な分類・項目名を入力してください");
  if (
    current.selectable
      ? !parentId || !all.some((c) => c.id === parentId && !c.selectable)
      : parentId !== null
  )
    throw Error("項目は分類の下に、分類は最上位に配置してください");
  (s.category_edits ||= {})[id] = {
    ...s.category_edits?.[id], name: name.trim(), parent_id: parentId,
  };
  if (current.selectable && current.parent_id !== parentId)
    for (const t of s.transactions)
      if (t.category_id === id) t.parent_category_id = parentId;
  audit(s, "update_category", id, {
    before: { name: current.name, parent_id: current.parent_id },
    after: { name: name.trim(), parent_id: parentId },
  });
}
export function otherCategory(s: State): Category | undefined {
  const group = categories.find(
    (c) => !c.selectable && c.name === "その他" && c.year === 2025,
  );
  const original = categories.find(
    (c) => c.selectable && c.parent_id === group?.id && c.name === "その他",
  );
  return effectiveCategories(s).find((c) => c.id === original?.id);
}
export function audit(
  s: State,
  action: string,
  id: string,
  detail: Record<string, unknown> = {},
) {
  s.audit.push({
    id: randomUUID(),
    at: new Date().toISOString(),
    action,
    entity_id: id,
    detail,
  });
  s.sync.dirty = true;
}
export function classify(t: Transaction, s: State) {
  const all = effectiveCategories(s);
  const rule = s.rules.find(
    (r) => r.approved && r.merchant_normalized === t.merchant_normalized,
  );
  if (rule) {
    const c = all.find((c) => c.id === rule.category_id && c.selectable);
    if (c) {
      t.category_id = c.id;
      t.parent_category_id = c.parent_id;
      t.merchant_category = rule.merchant_category;
      t.classification_status = "confirmed";
      t.classification_source = "rule";
      t.classification_confidence = 1;
      return;
    }
  }
  const words: Record<string, string> = {
    ENEOS: "ガソリン",
    エネオス: "ガソリン",
    CLAUDE: "AIツール",
    ADOBE: "Adobe",
    AMAZON: "Amazon",
    セブンイレブン: "コンビニ",
  };
  const key = Object.keys(words).find((k) =>
    t.merchant_normalized.includes(normalize(k)),
  );
  let candidates = all.filter(
    (c) =>
      c.selectable &&
      c.year === 2025 &&
      (normalize(c.name) === t.merchant_normalized ||
        (key && c.name === words[key])),
  );
  if (key && words[key] === "AIツール")
    candidates = all.filter(
      (c) =>
        c.selectable &&
        c.year === 2025 &&
        all.find((p) => p.id === c.parent_id)?.name === "AIツール",
    );
  t.suggested_category_ids = candidates.map((c) => c.id);
  t.classification_source = candidates.length ? "suggestion" : "unknown";
  t.classification_confidence = candidates.length ? 0.6 : 0;
  const fallback = otherCategory(s);
  if (fallback) {
    t.category_id = fallback.id;
    t.parent_category_id = fallback.parent_id;
  }
  // Merchant type is not a claim about purchased goods or deductible expenses.
  if (/AMAZON/.test(t.merchant_normalized)) t.merchant_category = "Amazon";
  if (/セブンイレブン|ローソン|ファミリーマート/.test(t.merchant_normalized))
    t.merchant_category = "コンビニ";
}
export function importCsv(
  s: State,
  buffer: Buffer,
  source: Service,
  account: string,
  options: {
    mapping?: Mapping;
    encoding?: "utf-8" | "shift_jis";
    feeMode?: "included" | "additional";
    allowFingerprintDedup?: boolean;
  } = {},
) {
  const fileHash = hash(buffer);
  const prior = s.batches.find(
    (b) =>
      b.file_hash === fileHash &&
      b.source === source &&
      b.account_id === account,
  );
  if (prior)
    return {
      count: 0,
      duplicates: prior.count,
      batch_id: prior.id,
      repeated: true,
    };
  const id = randomUUID(),
    rows = parseCsv(buffer, source, account, id, options),
    seen = new Map(s.transactions.map((t) => [t.fingerprint, t]));
  let duplicates = 0;
  const fresh: Transaction[] = [];
  for (const t of rows) {
    const old = seen.get(t.fingerprint);
    if (old) {
      if (!t.original_record_id && !options.allowFingerprintDedup)
        throw Error(
          "明細IDのない過去取込との一致があります。同額の別取引でないことを確認し、指紋による重複除外を承認してください",
        );
      if (
        old.amount !== t.amount ||
        old.direction !== t.direction ||
        old.transaction_date !== t.transaction_date ||
        old.merchant_normalized !== t.merchant_normalized
      )
        throw Error("同じ明細IDに異なる内容があります。取込を中止しました");
      duplicates++;
      continue;
    }
    classify(t, s);
    seen.set(t.fingerprint, t);
    fresh.push(t);
  }
  s.transactions.push(...fresh);
  s.batches.push({
    id,
    source,
    account_id: account,
    file_hash: fileHash,
    at: new Date().toISOString(),
    count: fresh.length,
    duplicates,
  });
  audit(s, "import", id, { count: fresh.length, duplicates });
  reconcile(s);
  return { count: fresh.length, duplicates, batch_id: id, repeated: false };
}
export function approveCategory(
  s: State,
  id: string,
  categoryId: string,
  remember: boolean,
  merchantCategory: string | null,
  purposeNote: string,
  businessUse: Transaction["business_use"] = "unknown",
) {
  const t = s.transactions.find((t) => t.transaction_id === id),
    c = effectiveCategories(s).find((c) => c.id === categoryId && c.selectable);
  if (!t || !c) throw Error("有効な明細・分類を指定してください");
  const before = t.category_id;
  t.category_id = c.id;
  t.parent_category_id = c.parent_id;
  t.classification_status = "confirmed";
  t.classification_source = "user";
  t.classification_confidence = 1;
  t.merchant_category = merchantCategory;
  t.purpose_note = purposeNote;
  t.business_use = businessUse;
  t.updated_at = new Date().toISOString();
  if (remember) {
    s.rules = s.rules.filter(
      (r) => r.merchant_normalized !== t.merchant_normalized,
    );
    s.rules.push({
      id: randomUUID(),
      merchant_normalized: t.merchant_normalized,
      category_id: c.id,
      merchant_category: merchantCategory,
      approved: true,
      created_at: new Date().toISOString(),
    });
  }
  audit(s, "classify", id, { before, after: c.id, remember });
}
const bank = (t: Transaction) => t.source_service.endsWith("bank");
function similarMerchant(a: string, b: string) {
  const clean = (name: string) => normalize(name).replace(/[^\p{L}\p{N}]/gu, "");
  const left = clean(a), right = clean(b);
  if (left === right) return left.length >= 3;
  if (Math.min(left.length, right.length) < 4) return false;
  if (left.includes(right) || right.includes(left)) return true;
  const pairs = (value: string) => {
    const result = new Map<string, number>();
    for (let i = 0; i < value.length - 1; i++) {
      const pair = value.slice(i, i + 2);
      result.set(pair, (result.get(pair) || 0) + 1);
    }
    return result;
  };
  const first = pairs(left), second = pairs(right);
  let shared = 0;
  for (const [pair, count] of first)
    shared += Math.min(count, second.get(pair) || 0);
  return 2 * shared / (left.length + right.length - 2) >= 0.75;
}
function addMatch(
  s: State,
  kind: Reconciliation["kind"],
  ts: Transaction[],
  strong: boolean,
  reason: string,
) {
  const ids = ts.map((t) => t.transaction_id).sort();
  if (
    s.reconciliations.some(
      (r) =>
        r.kind === kind &&
        JSON.stringify([...r.transaction_ids].sort()) === JSON.stringify(ids),
    )
  )
    return;
  const r: Reconciliation = {
    id: randomUUID(),
    kind,
    transaction_ids: ids,
    status: strong ? "confirmed" : "candidate",
    reason,
    created_at: new Date().toISOString(),
  };
  s.reconciliations.push(r);
  if (strong) {
    for (const t of ts) t.reconciliation_status = "matched";
    if (kind === "duplicate")
      ts.filter((t) => t.source_service === "paypay").forEach(
        (t) => (t.excluded = true),
      );
    audit(s, "auto_reconcile", r.id, { kind, reason });
  }
}
export function reconcile(s: State) {
  const tx = s.transactions.filter(
    (t) => t.reconciliation_status !== "matched" && !t.excluded,
  );
  for (const debit of tx.filter(
    (t) =>
      bank(t) &&
      t.transaction_type === "card_settlement" &&
      t.direction === "out",
  )) {
    const purchases = tx.filter(
      (t) =>
        t.source_service.endsWith("card") &&
        ["purchase", "refund", "fee"].includes(t.transaction_type) &&
        t.card_id &&
        t.card_id === debit.card_id &&
        t.billing_month &&
        t.billing_month === debit.billing_month &&
        t.scheduled_debit_date === debit.transaction_date,
    );
    const sum = purchases.reduce(
      (n, t) => n + (t.direction === "in" ? -t.amount : t.amount),
      0,
    );
    const sameDebits = tx.filter(
      (t) =>
        bank(t) &&
        t.transaction_type === "card_settlement" &&
        t.card_id === debit.card_id &&
        t.billing_month === debit.billing_month &&
        t.transaction_date === debit.transaction_date,
    );
    const strong =
      purchases.length > 0 &&
      sum === debit.amount &&
      debit.statement_amount === debit.amount &&
      sameDebits.length === 1 &&
      purchases.every(
        (t) => !t.installment && t.statement_amount === debit.amount,
      );
    if (purchases.length)
      addMatch(
        s,
        "card_settlement",
        [debit, ...purchases],
        strong,
        strong
          ? "カードID・請求月・引落日・請求確定額・取得明細合計が一致"
          : "請求情報不足、部分取得、分割・リボまたは金額差。要確認",
      );
  }
  for (const a of tx) {
    if (a.reconciliation_status === "matched") continue;
    if (
      a.direction === "out" &&
      ["transfer", "charge"].includes(a.transaction_type)
    ) {
      const peers = tx.filter(
        (b) =>
          b.transaction_id !== a.transaction_id &&
          b.direction === "in" &&
          b.amount === a.amount &&
          b.transaction_date === a.transaction_date &&
          ["transfer", "charge"].includes(b.transaction_type) &&
          b.account_id !== a.account_id,
      );
      for (const b of peers) {
        const unique =
          tx.filter(
            (t) =>
              t.direction === "out" &&
              t.transaction_type === a.transaction_type &&
              t.amount === a.amount &&
              t.transaction_date === a.transaction_date &&
              t.payment_reference === a.payment_reference &&
              t.account_id === a.account_id,
          ).length === 1;
        const strong =
          unique &&
          b.reconciliation_status !== "matched" &&
          peers.length === 1 &&
          !!a.payment_reference &&
          a.payment_reference === b.payment_reference &&
          a.counterparty_account_id === b.account_id &&
          b.counterparty_account_id === a.account_id;
        addMatch(
          s,
          a.transaction_type === "charge" ? "charge" : "transfer",
          [a, b],
          strong,
          strong
            ? "双方向の口座ID・共通参照ID・日付・金額が一致"
            : "金額・日付のみ一致。自己口座・参照IDの確認が必要",
        );
      }
    }
    if (a.source_service === "paypay" && a.transaction_type === "purchase") {
      const peers = tx.filter(
        (b) =>
          b.source_service.endsWith("card") &&
          b.transaction_type === "purchase" &&
          a.amount === b.amount &&
          a.transaction_date === b.transaction_date &&
          (a.merchant_normalized === b.merchant_normalized ||
            (a.payment_reference &&
              a.payment_reference === b.payment_reference)),
      );
      for (const b of peers) {
        const unique =
          tx.filter(
            (t) =>
              t.source_service === "paypay" &&
              t.transaction_type === "purchase" &&
              t.amount === a.amount &&
              t.transaction_date === a.transaction_date &&
              t.payment_reference === a.payment_reference,
          ).length === 1;
        const strong =
          unique &&
          b.reconciliation_status !== "matched" &&
          peers.length === 1 &&
          !!a.payment_reference &&
          a.payment_reference === b.payment_reference;
        addMatch(
          s,
          "duplicate",
          [a, b],
          strong,
          strong
            ? "決済の共通参照ID・日付・金額が一致"
            : "PayPay／カード重複候補。金額だけでは確定しません",
        );
      }
    }
  }
  const byDate = new Map<string, Transaction[]>();
  const reviewable = s.transactions.filter((t) =>
    !t.excluded && ["purchase", "refund", "fee"].includes(t.transaction_type) &&
    !s.reconciliations.some((r) =>
      r.status === "confirmed" && r.kind !== "card_settlement" &&
      r.transaction_ids.includes(t.transaction_id),
    ));
  for (const t of reviewable) {
    const sameDate = byDate.get(t.transaction_date) || [];
    for (const other of sameDate) {
      if (t.direction !== other.direction || t.transaction_type !== other.transaction_type)
        continue;
      const sameAmount = t.amount === other.amount;
      const similarName = t.source_service !== other.source_service &&
        similarMerchant(t.merchant_original, other.merchant_original);
      if (!sameAmount && !similarName) continue;
      const ids = [t.transaction_id, other.transaction_id];
      if (s.reconciliations.some((r) =>
        r.transaction_ids.length === 2 && ids.every((id) => r.transaction_ids.includes(id)),
      )) continue;
      addMatch(s, "same_day_duplicate", [other, t], false,
        sameAmount && similarName
          ? "同日・同額で利用先名も類似。別経路の重複か要確認"
          : sameAmount
            ? "同日・同額。別の購入の可能性もあるため要確認"
            : "別経路で同日・利用先名が類似。金額差を含めて要確認",
      );
    }
    sameDate.push(t);
    byDate.set(t.transaction_date, sameDate);
  }
  const purchasesByDate = new Map<string, Transaction[]>();
  for (const t of s.transactions)
    if (!t.excluded && ["purchase", "refund", "fee"].includes(t.transaction_type)) {
      const rows = purchasesByDate.get(t.transaction_date) || [];
      rows.push(t);
      purchasesByDate.set(t.transaction_date, rows);
    }
  for (const reference of s.references || []) {
    if (!reference.active) continue;
    for (const t of purchasesByDate.get(reference.transaction_date) || []) {
      const sameAmount = reference.amount !== null && reference.amount === t.amount;
      const similarName = similarMerchant(reference.name, t.merchant_original);
      if (!sameAmount && !similarName) continue;
      if (s.reconciliations.some((r) => r.kind === "external_reference" &&
        r.transaction_ids.includes(t.transaction_id) &&
        r.reference_ids?.includes(reference.id))) continue;
      s.reconciliations.push({
        id: randomUUID(), kind: "external_reference",
        transaction_ids: [t.transaction_id], reference_ids: [reference.id],
        status: "candidate",
        reason: sameAmount && similarName
          ? "外部シートと同日・同額・名前が類似。売上と支出の関係を要確認"
          : sameAmount
            ? "外部シートと同日・同額。内容を要確認"
            : "外部シートと同日・名前が類似。金額差を含めて要確認",
        created_at: new Date().toISOString(),
      });
    }
  }
}
export function replaceReferences(s: State, records: ReferenceRecord[], sheetId: string, gid: number) {
  const current = new Set(records.map((r) => r.id));
  const old = s.references || [];
  for (const r of old) r.active = current.has(r.id);
  const known = new Set(old.map((r) => r.id));
  old.push(...records.filter((r) => !known.has(r.id)));
  s.references = old;
  for (const match of s.reconciliations)
    if (match.kind === "external_reference" && match.status === "candidate" &&
      match.reference_ids?.some((id) => !old.some((r) => r.id === id && r.active))) {
      match.status = "rejected";
      match.reason = "参照シートから該当行がなくなりました";
    }
  for (const match of s.reconciliations)
    if (match.kind === "external_reference" && match.status === "rejected" &&
      match.reason === "参照シートから該当行がなくなりました" &&
      match.reference_ids?.every((id) => old.some((r) => r.id === id && r.active))) {
      match.status = "candidate";
      match.reason = "参照行が再出現しました。内容を要確認";
    }
  reconcile(s);
  audit(s, "sync_reference", `${sheetId}:${gid}`, { active: records.length });
}
export function resolveMatch(
  s: State,
  id: string,
  confirmed: boolean,
  reason: string,
  keepId?: string,
) {
  const r = s.reconciliations.find((r) => r.id === id);
  if (!r || r.status !== "candidate" || reason.trim().length < 3)
    throw Error("確認待ち候補と確認根拠を指定してください");
  const ts = s.transactions.filter((t) =>
    r.transaction_ids.includes(t.transaction_id),
  );
  if (r.kind === "external_reference") {
    r.status = confirmed ? "confirmed" : "rejected";
    r.reason = reason;
    audit(s, "resolve_reference", id, { confirmed, reason });
    return;
  }
  if (confirmed && ts.some((t) =>
    t.reconciliation_status === "matched" &&
    (r.kind !== "same_day_duplicate" ||
      s.reconciliations.some((other) =>
        other.status === "confirmed" && other.kind !== "card_settlement" &&
        other.transaction_ids.includes(t.transaction_id),
      ))))
    throw Error("別の照合ですでに確定しています");
  if (confirmed && r.kind === "same_day_duplicate" &&
    (ts.length !== 2 || !ts.some((t) => t.transaction_id === keepId)))
    throw Error("計上する明細を1件選択してください");
  r.status = confirmed ? "confirmed" : "rejected";
  r.reason = reason;
  if (confirmed) {
    for (const t of ts) t.reconciliation_status = "matched";
    if (r.kind === "duplicate")
      ts.filter((t) => t.source_service === "paypay").forEach(
        (t) => (t.excluded = true),
      );
    if (r.kind === "same_day_duplicate")
      ts.filter((t) => t.transaction_id !== keepId).forEach((t) => (t.excluded = true));
    if (r.kind === "cancellation") ts.forEach((t) => (t.excluded = true));
  }
  if (confirmed)
    for (const other of s.reconciliations)
      if (
        other.id !== id &&
        other.status === "candidate" &&
        other.transaction_ids.some((t) => r.transaction_ids.includes(t))
      ) {
        other.status = "rejected";
        other.reason = "別の照合で確定済み";
      }
  audit(s, "resolve_match", id, { confirmed, reason, keep_id: keepId });
}
export function resolveTransaction(
  s: State,
  id: string,
  kind: Kind,
  reason: string,
) {
  const t = s.transactions.find((t) => t.transaction_id === id);
  if (!t || reason.trim().length < 3) throw Error("根拠を入力してください");
  if (t.reconciliation_status === "matched")
    throw Error("照合済み明細の種別は変更できません");
  const before = t.transaction_type;
  t.transaction_type = kind;
  t.reconciliation_status = [
    "purchase",
    "refund",
    "fee",
    "income",
    "tax",
    "investment",
    "loan_principal",
  ].includes(kind)
    ? "not_required"
    : "pending";
  t.updated_at = new Date().toISOString();
  audit(s, "change_type", id, { before, after: kind, reason });
  reconcile(s);
}
export function purchaseAmount(t: Transaction) {
  return !t.excluded &&
    ["purchase", "fee", "refund"].includes(t.transaction_type)
    ? t.direction === "in"
      ? -t.amount
      : t.amount
    : 0;
}
export function sum(values: number[]) {
  let n = 0;
  for (const value of values) {
    n += value;
    if (!Number.isSafeInteger(n))
      throw Error("集計額が整数精度の上限を超えています");
  }
  return n;
}
export function summary(s: State, month: string) {
  const year = month.slice(0, 4),
    selected = s.transactions.filter((t) =>
      t.transaction_date.startsWith(month),
    );
  const prev = new Date(`${month}-01T00:00:00Z`);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const previous = prev.toISOString().slice(0, 7);
  const grouped = (
    key: (t: Transaction) => string,
    rows = selected,
    amount = (t: Transaction) => purchaseAmount(t),
  ) => {
    const result: Record<string, number> = {};
    for (const t of rows) {
      const k = key(t);
      result[k] = sum([result[k] || 0, amount(t)]);
    }
    return result;
  };
  const pending = selected.filter(
    (t) => t.reconciliation_status === "pending",
  ).length;
  const candidates = s.reconciliations.filter(
    (r) =>
      r.status === "candidate" &&
      r.transaction_ids.some((id) =>
        selected.some((t) => t.transaction_id === id),
      ),
  ).length;
  return {
    month,
    purchase: sum(selected.map(purchaseAmount)),
    annual: sum(
      s.transactions
        .filter((t) => t.transaction_date.startsWith(year))
        .map(purchaseAmount),
    ),
    previous: sum(
      s.transactions
        .filter((t) => t.transaction_date.startsWith(previous))
        .map(purchaseAmount),
    ),
    bank_outflow: sum(
      selected
        .filter(
          (t) =>
            bank(t) && t.direction === "out" && t.transaction_type !== "failed",
        )
        .map((t) => t.amount),
    ),
    transfers: sum(
      selected
        .filter(
          (t) =>
            ["transfer", "charge", "card_settlement"].includes(
              t.transaction_type,
            ) && t.direction === "out",
        )
        .map((t) => t.amount),
    ),
    unclassified: selected.filter((t) => t.classification_status === "pending")
      .length,
    unreconciled: pending,
    candidates,
    final:
      pending === 0 &&
      candidates === 0 &&
      selected.every((t) => t.classification_status !== "pending"),
    by_merchant: grouped((t) => t.merchant_normalized),
    by_category: grouped((t) => t.category_id || "unclassified"),
    by_service: grouped((t) => t.source_service),
    by_bank: grouped(
      (t) => t.source_service,
      selected.filter(
        (t) =>
          bank(t) && t.direction === "out" && t.transaction_type !== "failed",
      ),
      (t) => t.amount,
    ),
    monthly: Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      amount: sum(
        s.transactions
          .filter((t) =>
            t.transaction_date.startsWith(
              `${year}-${String(i + 1).padStart(2, "0")}`,
            ),
          )
          .map(purchaseAmount),
      ),
    })),
  };
}

/** Restore missing records only; never overwrite live edits or invent a reconciliation. */
export function restoreMissing(s: State, backup: State) {
  if (!s.settings.reference_sheet && backup.settings.reference_sheet)
    s.settings.reference_sheet = structuredClone(backup.settings.reference_sheet);
  const knownCategories = new Set(effectiveCategories(s).map((c) => c.id));
  for (const category of backup.custom_categories || [])
    if (!knownCategories.has(category.id)) {
      (s.custom_categories ||= []).push(structuredClone(category));
      knownCategories.add(category.id);
    }
  for (const [id, edit] of Object.entries(backup.category_edits || {}))
    if (knownCategories.has(id) && !s.category_edits?.[id])
      (s.category_edits ||= {})[id] = structuredClone(edit);
  const seen = new Set(s.transactions.map((t) => t.fingerprint));
  const added: Transaction[] = [];
  for (const original of backup.transactions)
    if (!seen.has(original.fingerprint)) {
      const t = structuredClone(original);
      s.transactions.push(t);
      added.push(t);
      seen.add(t.fingerprint);
    }
  const batchIds = new Set(s.batches.map((b) => b.id));
  s.batches.push(...backup.batches.filter((b) => !batchIds.has(b.id)));
  const knownReferenceIds = new Set((s.references || []).map((r) => r.id));
  const addedReferenceIds = new Set<string>();
  for (const reference of backup.references || [])
    if (!knownReferenceIds.has(reference.id)) {
      (s.references ||= []).push(structuredClone(reference));
      addedReferenceIds.add(reference.id);
      knownReferenceIds.add(reference.id);
    }
  const allIds = new Set(s.transactions.map((t) => t.transaction_id));
  const addedIds = new Set(added.map((t) => t.transaction_id));
  for (const r of backup.reconciliations) {
    if (
      s.reconciliations.some((existing) => existing.id === r.id) ||
      !(r.transaction_ids.some((id) => addedIds.has(id)) ||
        r.reference_ids?.some((id) => addedReferenceIds.has(id))) ||
      !r.transaction_ids.every((id) => allIds.has(id)) ||
      !(r.reference_ids || []).every((id) => knownReferenceIds.has(id))
    )
      continue;
    const conflict = s.reconciliations.some(
      (existing) =>
        existing.status === "confirmed" &&
        existing.kind !== "external_reference" && r.kind !== "external_reference" &&
        existing.transaction_ids.some((id) => r.transaction_ids.includes(id)),
    );
    if (!conflict) s.reconciliations.push(structuredClone(r));
  }
  for (const t of added)
    if (
      t.reconciliation_status === "matched" &&
      !s.reconciliations.some(
        (r) =>
          r.status === "confirmed" &&
          r.transaction_ids.includes(t.transaction_id),
      )
    ) {
      t.reconciliation_status = "pending";
      t.excluded = false;
    }
  audit(s, "restore", "backup", {
    count: added.length,
    mode: "missing-records-and-related-matches",
  });
  reconcile(s);
}
