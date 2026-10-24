import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { encrypt, decrypt, localDir } from "./crypto";
import { emptyState, type State } from "./types";
import type { Identity } from "./auth";
let db: DatabaseSync | undefined;
function sqlite() {
  if (!db) {
    const path = join(localDir(), "expenses.sqlite");
    db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS expense_state(owner_id TEXT PRIMARY KEY,version INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transaction_records(owner_id TEXT NOT NULL,transaction_id TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner_id,transaction_id),UNIQUE(owner_id,fingerprint));
CREATE TABLE IF NOT EXISTS expense_history(owner_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(owner_id,version));
CREATE TABLE IF NOT EXISTS expense_secrets(owner_id TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner_id,name));
CREATE TABLE IF NOT EXISTS expense_locks(owner_id TEXT NOT NULL,name TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(owner_id,name));`);
  }
  return db;
}
export async function load(who: Identity): Promise<State> {
  let row: { version: number; payload: string } | null;
  if (who.client) {
    const { data, error } = await who.client
      .from("expense_state")
      .select("version,payload")
      .eq("owner_id", who.id)
      .maybeSingle();
    if (error) throw Error("データベース読み込みに失敗しました");
    row = data;
  } else
    row = sqlite()
      .prepare("SELECT version,payload FROM expense_state WHERE owner_id=?")
      .get(who.id) as typeof row;
  if (!row) return emptyState();
  const state = JSON.parse(decrypt(row.payload)) as State;
  state.version = row.version;
  return state;
}
export async function save(who: Identity, s: State) {
  const old = s.version,
    next = { ...s, version: old + 1 },
    payload = encrypt(JSON.stringify(next));
  const records = s.transactions.map((t) => ({
    transaction_id: t.transaction_id,
    fingerprint: t.fingerprint,
    payload: encrypt(JSON.stringify(t)),
  }));
  if (who.client) {
    const { error } = await who.client.rpc(
      who.background ? "save_expenses_job" : "save_expenses",
      {
        expected_version: old,
        new_payload: payload,
        records,
        ...(who.background ? { job_owner: who.id } : {}),
      },
    );
    if (error) {
      if (error.message.includes("VERSION_CONFLICT"))
        throw Error("VERSION_CONFLICT");
      throw Error("データベース保存に失敗しました");
    }
  } else {
    const d = sqlite();
    d.exec("BEGIN IMMEDIATE");
    try {
      const row = d
        .prepare("SELECT version FROM expense_state WHERE owner_id=?")
        .get(who.id) as { version: number } | undefined;
      if ((row?.version ?? 0) !== old) throw Error("VERSION_CONFLICT");
      d.prepare(
        "INSERT INTO expense_history(owner_id,version,payload) VALUES(?,?,?)",
      ).run(who.id, old + 1, payload);
      d.prepare(
        "INSERT INTO expense_state VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET version=excluded.version,payload=excluded.payload",
      ).run(who.id, old + 1, payload);
      const put = d.prepare(
        "INSERT INTO transaction_records VALUES(?,?,?,?) ON CONFLICT(owner_id,transaction_id) DO UPDATE SET payload=excluded.payload",
      );
      for (const r of records)
        put.run(who.id, r.transaction_id, r.fingerprint, r.payload);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  }
  s.version = old + 1;
}
export async function getSecret(who: Identity, name: string) {
  if (who.client) {
    const { data, error } = await who.client
      .from("expense_secrets")
      .select("payload")
      .eq("owner_id", who.id)
      .eq("name", name)
      .maybeSingle();
    if (error) throw Error("認証情報取得エラー");
    return data ? decrypt(data.payload) : null;
  }
  const row = sqlite()
    .prepare("SELECT payload FROM expense_secrets WHERE owner_id=? AND name=?")
    .get(who.id, name) as { payload: string } | undefined;
  return row ? decrypt(row.payload) : null;
}
export async function putSecret(who: Identity, name: string, value: string) {
  const payload = encrypt(value);
  if (who.client) {
    const { error } = await who.client
      .from("expense_secrets")
      .upsert({ owner_id: who.id, name, payload });
    if (error) throw Error("認証情報保存エラー");
  } else
    sqlite()
      .prepare(
        "INSERT INTO expense_secrets VALUES(?,?,?) ON CONFLICT(owner_id,name) DO UPDATE SET payload=excluded.payload",
      )
      .run(who.id, name, payload);
}
export async function lock(who: Identity, name: string) {
  if (who.client) {
    const { data, error } = await who.client.rpc(
      who.background ? "lock_expenses_job" : "lock_expenses",
      { lock_name: name, ...(who.background ? { job_owner: who.id } : {}) },
    );
    if (error) throw Error("同期ロックエラー");
    return data === true;
  }
  const d = sqlite();
  const n = Date.now();
  d.prepare(
    "INSERT INTO expense_locks VALUES(?,?,?) ON CONFLICT(owner_id,name) DO UPDATE SET expires=excluded.expires WHERE expense_locks.expires<?",
  ).run(who.id, name, n + 1800000, n);
  const r = d.prepare("SELECT changes() AS n").get() as { n: number };
  return r.n === 1;
}
export async function unlock(who: Identity, name: string) {
  if (who.client) {
    await who.client
      .from("expense_locks")
      .delete()
      .eq("owner_id", who.id)
      .eq("name", name);
  } else
    sqlite()
      .prepare("DELETE FROM expense_locks WHERE owner_id=? AND name=?")
      .run(who.id, name);
}
