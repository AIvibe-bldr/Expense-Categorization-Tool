import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { identity, type Identity } from "@/lib/auth";
import { load, getSecret } from "@/lib/store";
import { syncGoogle, syncReferenceSheet } from "@/lib/google";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const key = process.env.CRON_SECRET,
    provided = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (
    !key ||
    key.length < 32 ||
    !provided ||
    Buffer.byteLength(key) !== Buffer.byteLength(provided) ||
    !timingSafeEqual(Buffer.from(key), Buffer.from(provided))
  )
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const users: Identity[] = [];
  if (process.env.GALAPAGOS_LOCAL_MODE === "1") users.push(await identity(req));
  else {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
      secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !secret)
      return Response.json(
        { error: "Scheduler credentials missing" },
        { status: 503 },
      );
    const client = createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (let start = 0; ; start += 1000) {
      const { data, error } = await client
        .from("expense_state")
        .select("owner_id")
        .order("owner_id")
        .range(start, start + 999);
      if (error)
        return Response.json(
          { error: "Scheduler database unavailable" },
          { status: 503 },
        );
      users.push(
        ...data.map((row) => ({
          id: row.owner_id,
          client,
          local: false,
          background: true,
        })),
      );
      if (data.length < 1000) break;
    }
  }
  let completed = 0,
    failed = 0,
    skipped = 0;
  for (const who of users) {
    try {
      const s = await load(who);
      if ((!s.settings.spreadsheet_id && !s.settings.reference_sheet) ||
        !(await getSecret(who, "google_tokens"))) {
        skipped++;
        continue;
      }
      if (s.settings.reference_sheet) await syncReferenceSheet(who);
      if (s.settings.spreadsheet_id) await syncGoogle(who);
      completed++;
    } catch {
      failed++;
    }
  }
  return Response.json(
    { completed, failed, skipped },
    { status: failed ? 503 : 200 },
  );
}
