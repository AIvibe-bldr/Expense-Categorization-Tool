import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { identity, checkOrigin } from "@/lib/auth";
import { load, save, getSecret } from "@/lib/store";
import {
  categories,
  summary,
  importCsv,
  approveCategory,
  audit,
  resolveMatch,
  resolveTransaction,
  reconcile,
  restoreMissing,
} from "@/lib/engine";
import { MAX_FILE_SIZE, fields, normalize } from "@/lib/csv";
import { services, type State } from "@/lib/types";
import { encrypt, decrypt } from "@/lib/crypto";
import {
  authorizationUrl,
  callback,
  syncGoogle,
  oauthReady,
} from "@/lib/google";
import { reports } from "@/lib/reports";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const kinds = z.enum([
  "purchase",
  "refund",
  "card_settlement",
  "transfer",
  "charge",
  "income",
  "fee",
  "loan_principal",
  "investment",
  "tax",
  "unknown",
  "failed",
  "cancellation",
]);
async function boundedBody(req: Request, limit: number) {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw Error("リクエストのサイズ上限を超えました");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function handler(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const who = await identity(req);
    checkOrigin(req);
    const path = (await context.params).path.join("/");
    if (req.method === "GET" && path === "google/callback") {
      const code = req.nextUrl.searchParams.get("code"),
        state = req.nextUrl.searchParams.get("state");
      if (!code || !state) throw Error("Google認証がキャンセルされました");
      await callback(who, code, state);
      return NextResponse.redirect(
        new URL("/?google=connected", process.env.APP_ORIGIN || req.url),
      );
    }
    const s = await load(who);
    if (req.method === "GET") {
      if (path === "state") {
        const month = monthSchema.parse(
          req.nextUrl.searchParams.get("month") ||
            new Date().toISOString().slice(0, 7),
        );
        return NextResponse.json({
          state: {
            ...s,
            transactions: s.transactions.map(({ raw_encrypted, ...t }) => t),
          },
          categories,
          summary: summary(s, month),
          local: who.local,
          google: {
            configured: oauthReady(),
            connected: !!(await getSecret(who, "google_tokens")),
          },
          financial_api: "CSV（実サービスの認証・実CSV適合は未検証）",
        });
      }
      if (path === "backup") {
        return new Response(
          encrypt(JSON.stringify({ format: 1, owner: who.id, state: s })),
          {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition":
                'attachment; filename="galapagos-backup.enc"',
            },
          },
        );
      }
      if (path === "export") {
        const year = z.coerce
          .number()
          .int()
          .min(2000)
          .max(2100)
          .parse(
            req.nextUrl.searchParams.get("year") || new Date().getUTCFullYear(),
          );
        const book = new ExcelJS.Workbook();
        for (const report of reports(s, year)) {
          const sheet = book.addWorksheet(report.title);
          sheet.addRows(report.rows);
          sheet.views = [{ state: "frozen", ySplit: 1 }];
          sheet.getColumn(1).width = 38;
          sheet.getColumn(2).width = 35;
          for (const [row, color] of Object.entries(report.colors || {}))
            sheet.getRow(+row + 1).fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FF" + color },
            };
        }
        const buffer = await book.xlsx.writeBuffer();
        return new Response(new Uint8Array(buffer), {
          headers: {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="galapagos-${year}.xlsx"`,
          },
        });
      }
      if (path === "original") {
        const t = s.transactions.find(
          (t) => t.transaction_id === req.nextUrl.searchParams.get("id"),
        );
        if (!t) throw Error("明細が見つかりません");
        const raw = JSON.parse(decrypt(t.raw_encrypted));
        raw.row = raw.row.map((v: string) =>
          v.replace(/\d{7,}/g, (m) => "••••" + m.slice(-4)),
        );
        return NextResponse.json(raw);
      }
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    let result: unknown = { ok: true };
    if (path === "imports") {
      if (
        Number(req.headers.get("content-length") || 0) >
        MAX_FILE_SIZE + 65536
      )
        throw Error("ファイルサイズ上限は5MBです");
      const bytes = await boundedBody(req, MAX_FILE_SIZE + 65536);
      const form = await new Request(req.url, {
          method: "POST",
          headers: { "Content-Type": req.headers.get("content-type") || "" },
          body: bytes,
        }).formData(),
        file = form.get("file");
      if (
        !(file instanceof File) ||
        file.size > MAX_FILE_SIZE ||
        !file.name.toLowerCase().endsWith(".csv")
      )
        throw Error("5MB以下のCSVを選択してください");
      const source = z.enum(services).parse(form.get("source"));
      const account = z
        .string()
        .regex(/^[-\w]{1,64}$/)
        .parse(form.get("account"));
      const mapping = z
        .partialRecord(z.enum(fields), z.string().max(150))
        .parse(JSON.parse(String(form.get("mapping") || "{}")));
      const encoding = z
        .enum(["utf-8", "shift_jis"])
        .parse(form.get("encoding") || "utf-8");
      const feeMode = z
        .enum(["included", "additional"])
        .optional()
        .parse(form.get("feeMode") || undefined);
      result = importCsv(
        s,
        Buffer.from(await file.arrayBuffer()),
        source,
        account,
        {
          mapping,
          encoding,
          feeMode,
          allowFingerprintDedup: form.get("allowFingerprintDedup") === "true",
        },
      );
    } else {
      if (Number(req.headers.get("content-length") || 0) > 10 * 1024 * 1024)
        throw Error("リクエストが大きすぎます");
      const rawBody = Buffer.from(
        await boundedBody(req, 10 * 1024 * 1024),
      ).toString("utf8");
      if (Buffer.byteLength(rawBody) > 10 * 1024 * 1024)
        throw Error("リクエストが大きすぎます");
      const body = JSON.parse(rawBody);
      if (path === "classify") {
        const b = z
          .object({
            id: z.uuid(),
            category_id: z.uuid(),
            remember: z.boolean(),
            merchant_category: z.string().max(100).nullable(),
            purpose_note: z.string().max(1000),
            business_use: z
              .enum(["unknown", "business", "personal", "mixed"])
              .default("unknown"),
          })
          .parse(body);
        approveCategory(
          s,
          b.id,
          b.category_id,
          b.remember,
          b.merchant_category,
          b.purpose_note,
          b.business_use,
        );
      } else if (path === "rules") {
        const b = z
          .object({
            id: z.uuid().optional(),
            delete: z.boolean().optional(),
            merchant: z.string().min(1).max(500).optional(),
            category_id: z.uuid().optional(),
            merchant_category: z.string().max(100).nullable().optional(),
          })
          .parse(body);
        if (b.delete) {
          if (!b.id) throw Error("ルールIDが必要です");
          s.rules = s.rules.filter((r) => r.id !== b.id);
          audit(s, "delete_rule", b.id);
        } else {
          if (
            !b.merchant ||
            !categories.some((c) => c.id === b.category_id && c.selectable)
          )
            throw Error("利用先と分類を指定してください");
          const id = b.id || randomUUID(),
            merchant = normalize(b.merchant);
          s.rules = s.rules.filter(
            (r) => r.id !== id && r.merchant_normalized !== merchant,
          );
          s.rules.push({
            id,
            merchant_normalized: merchant,
            category_id: b.category_id!,
            merchant_category: b.merchant_category || null,
            approved: true,
            created_at: new Date().toISOString(),
          });
          audit(s, "save_rule", id);
        }
      } else if (path === "reconcile") {
        const b = z
          .object({
            id: z.uuid(),
            confirmed: z.boolean(),
            reason: z.string().min(3).max(1000),
          })
          .parse(body);
        resolveMatch(s, b.id, b.confirmed, b.reason);
      } else if (path === "type") {
        const b = z
          .object({
            id: z.uuid(),
            kind: kinds,
            reason: z.string().min(3).max(1000),
          })
          .parse(body);
        resolveTransaction(s, b.id, b.kind, b.reason);
      } else if (path === "manual-match") {
        const b = z
          .object({
            ids: z.array(z.uuid()).min(2).max(1000),
            kind: z.enum([
              "card_settlement",
              "transfer",
              "charge",
              "duplicate",
              "cancellation",
            ]),
            reason: z.string().min(3).max(1000),
          })
          .parse(body);
        const ts = s.transactions.filter((t) =>
          b.ids.includes(t.transaction_id),
        );
        if (
          ts.length !== new Set(b.ids).size ||
          ts.some((t) => t.reconciliation_status === "matched")
        )
          throw Error("照合可能な明細を選択してください");
        if (b.kind === "duplicate") {
          if (
            ts.length !== 2 ||
            !ts.some((t) => t.source_service === "paypay") ||
            !ts.some((t) => t.source_service.endsWith("card")) ||
            ts[0].amount !== ts[1].amount ||
            ts.some((t) => t.transaction_type !== "purchase")
          )
            throw Error("重複照合は同額のPayPay・カード購入各1件です");
        } else if (b.kind === "cancellation") {
          if (
            ts.length !== 2 ||
            ts[0].amount !== ts[1].amount ||
            !ts.some((t) => t.transaction_type === "cancellation") ||
            !ts.some((t) => t.transaction_type === "purchase") ||
            ts[0].source_service !== ts[1].source_service ||
            ts[0].account_id !== ts[1].account_id
          )
            throw Error("同一口座の購入と利用取消を各1件選択してください");
        } else if (b.kind === "card_settlement") {
          const debit = ts.filter(
            (t) =>
              t.transaction_type === "card_settlement" &&
              t.source_service.endsWith("bank"),
          );
          const card = ts.filter((t) => t.source_service.endsWith("card"));
          if (
            debit.length !== 1 ||
            card.length !== ts.length - 1 ||
            card.reduce(
              (n, t) => n + (t.direction === "in" ? -t.amount : t.amount),
              0,
            ) !== debit[0].amount
          )
            throw Error("カード利用合計と銀行引落額が一致していません");
        } else if (
          ts.length !== 2 ||
          ts[0].amount !== ts[1].amount ||
          ts[0].direction === ts[1].direction ||
          ts.some((t) => !["transfer", "charge"].includes(t.transaction_type))
        )
          throw Error("振替照合は同額・逆方向の資金移動2件です");
        const id = randomUUID();
        s.reconciliations.push({
          id,
          kind: b.kind,
          transaction_ids: b.ids,
          status: "candidate",
          reason: b.reason,
          created_at: new Date().toISOString(),
        });
        resolveMatch(s, id, true, b.reason);
      } else if (path === "settings") {
        const b = z
          .object({ spreadsheet_id: z.string().regex(/^[-\w]{10,150}$/) })
          .parse(body);
        s.settings.spreadsheet_id = b.spreadsheet_id;
        audit(s, "settings", "google");
      } else if (path === "google/connect")
        return NextResponse.json({ url: await authorizationUrl(who) });
      else if (path === "google/sync") {
        const b = z
          .object({ year: z.number().int().min(2000).max(2100).optional() })
          .parse(body);
        return NextResponse.json(await syncGoogle(who, b.year));
      } else if (path === "restore") {
        const b = z.object({ backup: z.string().max(10000000) }).parse(body);
        const restored = JSON.parse(decrypt(b.backup)) as {
          format: number;
          owner: string;
          state: State;
        };
        if (restored.format !== 1 || restored.owner !== who.id)
          throw Error("本人のバックアップではありません");
        restoreMissing(s, restored.state);
      } else return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    await save(who, s);
    if (s.settings.spreadsheet_id && (await getSecret(who, "google_tokens")))
      after(async () => {
        try {
          await syncGoogle(who);
        } catch {
          /* Persisted error is shown in the dashboard; avoid logging tokens/financial data. */
        }
      });
    return NextResponse.json(result);
  } catch (e) {
    const message =
      e instanceof z.ZodError ? "入力項目が不正です" : (e as Error).message;
    const status =
      message === "UNAUTHORIZED"
        ? 401
        : message === "ORIGIN_FORBIDDEN"
          ? 403
          : message === "VERSION_CONFLICT"
            ? 409
            : 400;
    return NextResponse.json(
      {
        error:
          message === "VERSION_CONFLICT"
            ? "他の更新と競合しました。再読込して再実行してください"
            : message,
      },
      { status },
    );
  }
}
export { handler as GET, handler as POST };
