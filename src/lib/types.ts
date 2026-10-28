export const services = [
  "smbc_card",
  "rakuten_card",
  "paypay",
  "chiba_bank",
  "sbi_bank",
] as const;
export type Service = (typeof services)[number];
export const serviceNames: Record<Service, string> = {
  smbc_card: "三井住友カード",
  rakuten_card: "楽天カード",
  paypay: "PayPay",
  chiba_bank: "千葉銀行",
  sbi_bank: "住信SBIネット銀行",
};
export type Kind =
  | "purchase"
  | "refund"
  | "card_settlement"
  | "transfer"
  | "charge"
  | "income"
  | "fee"
  | "loan_principal"
  | "investment"
  | "tax"
  | "unknown"
  | "failed"
  | "cancellation";
export type Category = {
  id: string;
  parent_id: string | null;
  name: string;
  year: number;
  source_sheet: string;
  source_cell: string;
  order: number;
  display_order?: number;
  selectable: boolean;
  color: { type: string; value: string; tint: number; pattern: string | null };
};
export type Transaction = {
  transaction_id: string;
  source_service: Service;
  account_id: string;
  transaction_date: string;
  posted_date: string | null;
  merchant_original: string;
  merchant_normalized: string;
  amount: number;
  direction: "out" | "in";
  transaction_type: Kind;
  parent_category_id: string | null;
  category_id: string | null;
  merchant_id: string;
  merchant_category: string | null;
  purpose_note: string;
  classification_status: "pending" | "confirmed";
  classification_source: "unknown" | "suggestion" | "user" | "rule";
  classification_confidence: number;
  reconciliation_status: "pending" | "matched" | "not_required";
  original_record_id: string | null;
  import_batch_id: string;
  created_at: string;
  updated_at: string;
  fingerprint: string;
  billing_month: string | null;
  scheduled_debit_date: string | null;
  statement_amount: number | null;
  card_id: string | null;
  counterparty_account_id: string | null;
  payment_reference: string | null;
  installment: string | null;
  balance: number | null;
  fee: number;
  business_use: "unknown" | "business" | "personal" | "mixed";
  excluded: boolean;
  raw_encrypted: string;
  suggested_category_ids: string[];
};
export type Rule = {
  id: string;
  merchant_normalized: string;
  category_id: string;
  merchant_category: string | null;
  approved: boolean;
  created_at: string;
};
export type Reconciliation = {
  id: string;
  kind:
    | "card_settlement"
    | "transfer"
    | "charge"
    | "duplicate"
    | "cancellation"
    | "manual";
  transaction_ids: string[];
  status: "candidate" | "confirmed" | "rejected";
  reason: string;
  created_at: string;
};
export type Audit = {
  id: string;
  at: string;
  action: string;
  entity_id: string;
  detail: Record<string, unknown>;
};
export type Batch = {
  id: string;
  source: Service;
  account_id: string;
  file_hash: string;
  at: string;
  count: number;
  duplicates: number;
};
export type State = {
  version: number;
  transactions: Transaction[];
  custom_categories: Category[];
  category_edits: Record<string, { name: string; parent_id: string | null; display_order?: number }>;
  rules: Rule[];
  reconciliations: Reconciliation[];
  batches: Batch[];
  audit: Audit[];
  sync: {
    last_success: string | null;
    last_attempt: string | null;
    error: string | null;
    dirty: boolean;
  };
  settings: { spreadsheet_id: string | null };
};
export const emptyState = (): State => ({
  version: 0,
  transactions: [],
  custom_categories: [],
  category_edits: {},
  rules: [],
  reconciliations: [],
  batches: [],
  audit: [],
  sync: { last_success: null, last_attempt: null, error: null, dirty: false },
  settings: { spreadsheet_id: null },
});
