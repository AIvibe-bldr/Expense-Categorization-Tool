import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
test("PostgreSQL migration + RLS isolation + RPC transaction + job permissions", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;insert into auth.users values('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');`,
    );
    await db.exec(
      readFileSync("supabase/migrations/202610220001_expenses.sql", "utf8"),
    );
    await db.exec(
      `set role authenticated;select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);`,
    );
    await db.query(`select public.save_expenses($1,$2,$3::jsonb)`, [
      0,
      "ciphertext-a",
      JSON.stringify([
        {
          transaction_id: "10000000-0000-4000-8000-000000000001",
          fingerprint: "fingerprint-a",
          payload: "encrypted-record",
        },
      ]),
    ]);
    assert.equal(
      (await db.query("select * from expense_state")).rows.length,
      1,
    );
    await assert.rejects(
      () => db.query(`select public.save_expenses(0,'stale','[]'::jsonb)`),
      /VERSION_CONFLICT/,
    );
    assert.equal(
      (await db.query("select * from expense_history")).rows.length,
      1,
    );
    await assert.rejects(
      () => db.exec("delete from transaction_records"),
      /permission denied/,
    );
    await assert.rejects(
      () =>
        db.exec(
          `select save_expenses_job('00000000-0000-4000-8000-000000000002',0,'bad','[]'::jsonb)`,
        ),
      /permission denied/,
    );
    await db.exec(
      `select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false)`,
    );
    for (const table of [
      "expense_state",
      "transaction_records",
      "expense_history",
    ])
      assert.equal((await db.query(`select * from ${table}`)).rows.length, 0);
    await assert.rejects(
      () =>
        db.exec(
          `insert into expense_secrets values('00000000-0000-4000-8000-000000000001','token','bad')`,
        ),
      /row-level security/,
    );
    await db.exec(
      `reset role;set role anon;select set_config('request.jwt.claim.sub','',false)`,
    );
    await assert.rejects(
      () => db.exec("select * from expense_state"),
      /permission denied/,
    );
    await db.exec(
      `reset role;set role service_role;select save_expenses_job('00000000-0000-4000-8000-000000000002',0,'ciphertext-b','[]'::jsonb)`,
    );
    assert.equal(
      (await db.query("select * from expense_state")).rows.length,
      2,
    );
  } finally {
    await db.close();
  }
});
