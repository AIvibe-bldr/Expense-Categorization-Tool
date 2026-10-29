import { randomBytes } from "node:crypto";
import { encrypt, decrypt, hash } from "./crypto";
import { getSecret, putSecret, lock, unlock, load, save } from "./store";
import type { Identity } from "./auth";
import { reports } from "./reports";
import { parseReferenceRows, parseSheetLink, suggestReferenceColumns } from "./reference";
import type { ReferenceSheetSettings } from "./types";
import { replaceReferences } from "./engine";
const redirect = () => `${process.env.APP_ORIGIN}/api/google/callback`;
const oauthReady = () =>
  !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.APP_ORIGIN
  );
export { oauthReady };
async function tokenRequest(params: Record<string, string>) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...params,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw Error(`Google認証エラー (${response.status})。再接続してください`);
  return response.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  }>;
}
export async function authorizationUrl(who: Identity) {
  if (!oauthReady()) throw Error("Google OAuth設定が必要です");
  const nonce = randomBytes(32).toString("hex");
  await putSecret(who, "oauth_nonce", nonce);
  const state = encrypt(
    JSON.stringify({ owner: who.id, nonce, expires: Date.now() + 600000 }),
  );
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirect(),
    response_type: "code",
    scope: "https://www.googleapis.com/auth/spreadsheets",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
export async function callback(who: Identity, code: string, state: string) {
  const payload = JSON.parse(decrypt(state));
  if (
    payload.owner !== who.id ||
    payload.expires < Date.now() ||
    payload.nonce !== (await getSecret(who, "oauth_nonce"))
  )
    throw Error("OAuth stateが無効です");
  await putSecret(who, "oauth_nonce", "consumed");
  const token = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect(),
  });
  if (!token.refresh_token)
    throw Error("オフライン権限がありません。アクセスを再承認してください");
  await putSecret(
    who,
    "google_tokens",
    JSON.stringify({ ...token, expires: Date.now() + token.expires_in * 1000 }),
  );
}
async function accessToken(who: Identity) {
  const raw = await getSecret(who, "google_tokens");
  if (!raw) throw Error("Googleに接続してください");
  let token = JSON.parse(raw);
  if (token.expires < Date.now() + 60000) {
    const fresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    });
    token = {
      ...token,
      ...fresh,
      expires: Date.now() + fresh.expires_in * 1000,
    };
    await putSecret(who, "google_tokens", JSON.stringify(token));
  }
  return token.access_token as string;
}
async function api(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!r.ok) throw Error(`Google Sheets アクセスエラー (${r.status})。対象シートの権限を確認してください`);
  return r.json();
}
async function referenceTab(who: Identity, sheetId: string, gid: number | null) {
  const token = await accessToken(who);
  const metadata = await api(token, `${sheetId}?fields=sheets(properties(sheetId,title,gridProperties(rowCount)))`) as {
    sheets?: { properties: { sheetId: number; title: string; gridProperties?: { rowCount: number } } }[];
  };
  const tabs = (metadata.sheets || []).map((s) => ({
    gid: s.properties.sheetId, title: s.properties.title,
    rowCount: s.properties.gridProperties?.rowCount,
  }));
  const selected = tabs.find((t) => t.gid === gid) ||
    (gid === null ? tabs.find((t) => t.title === "支払いデータ") || tabs[0] : undefined);
  if (!selected) throw Error("指定したタブが見つかりません");
  return { token, tabs, selected };
}
function referenceRange(title: string, lastRow: number) {
  return encodeURIComponent(`'${title.replace(/'/g, "''")}'!A1:Z${lastRow}`);
}
export async function previewReferenceSheet(
  who: Identity, link: string, requestedGid?: number, headerRow?: number,
) {
  const parsed = parseSheetLink(link);
  const { token, tabs, selected } = await referenceTab(who, parsed.sheet_id, requestedGid ?? parsed.gid);
  const data = await api(token, `${parsed.sheet_id}/values/${referenceRange(selected.title, 20)}`) as { values?: string[][] };
  const rows = data.values || [];
  const detected = headerRow || rows.findIndex((row) =>
    suggestReferenceColumns(row).date_col >= 0 && suggestReferenceColumns(row).name_cols.length > 0,
  ) + 1 || 1;
  const headers = rows[detected - 1] || [];
  return { sheet_id: parsed.sheet_id, tabs, gid: selected.gid, header_row: detected, headers,
    suggested: suggestReferenceColumns(headers) };
}
export async function readReferenceSheet(
  who: Identity,
  config: Omit<ReferenceSheetSettings, "last_sync">,
) {
  const { token, selected } = await referenceTab(who, config.sheet_id, config.gid);
  if (selected.title === "未収金データ")
    throw Error("未収金データは入金済みの照合元として使用できません");
  if (selected.rowCount && selected.rowCount > 5001)
    throw Error("参照シートの物理行数が5,000行を超えています。未使用行を削除するか対象を分割してください");
  const data = await api(token, `${config.sheet_id}/values/${referenceRange(selected.title, 5001)}`) as { values?: string[][] };
  return parseReferenceRows(data.values || [], config);
}
export async function syncReferenceSheet(who: Identity) {
  if (!(await lock(who, "reference_sync"))) throw Error("参照シートの同期中です");
  try {
    const config = (await load(who)).settings.reference_sheet;
    if (!config) throw Error("参照シートが未設定です");
    const records = await readReferenceSheet(who, config);
    if (!records.length) throw Error("参照できる明細行がありません");
    const state = await load(who);
    replaceReferences(state, records, config.sheet_id, config.gid);
    state.settings.reference_sheet = { ...config, last_sync: new Date().toISOString() };
    await save(who, state);
    return { count: records.length };
  } finally {
    await unlock(who, "reference_sync");
  }
}
export async function syncGoogle(
  who: Identity,
  year = new Date().getUTCFullYear(),
) {
  if (!(await lock(who, "google_sync")))
    throw Error("同期処理中です。後でもう一度実行してください");
  const attempt = new Date().toISOString();
  try {
    const snapshot = await load(who);
    const id = snapshot.settings.spreadsheet_id;
    if (!id || !/^[-\w]{10,150}$/.test(id))
      throw Error("スプレッドシートIDを設定してください");
    const token = await accessToken(who),
      owner = hash(who.id).slice(0, 24);
    let metadata = await api(
      token,
      `${id}?fields=sheets(properties,developerMetadata)`,
    );
    const data = reports(snapshot, year);
    for (const previousYear of new Set(
      snapshot.transactions.map((t) => Number(t.transaction_date.slice(0, 4))),
    ))
      if (previousYear !== year)
        data.push(
          reports(snapshot, previousYear).find(
            (r) => r.title === `${previousYear}年 月別経費`,
          )!,
        );
    for (const report of data) {
      let sheet = metadata.sheets?.find(
        (s: { properties: { title: string } }) =>
          s.properties.title === report.title,
      );
      if (
        sheet &&
        !sheet.developerMetadata?.some(
          (m: { metadataKey: string; metadataValue: string }) =>
            m.metadataKey === "GALAPAGOS_EXPENSES" && m.metadataValue === owner,
        )
      )
        throw Error(
          `「${report.title}」は管理外シートです。既存シートを改名するか専用スプレッドシートを使用してください`,
        );
      if (!sheet) {
        const created = await api(token, `${id}:batchUpdate`, "POST", {
          requests: [
            {
              addSheet: {
                properties: {
                  title: report.title,
                  gridProperties: {
                    rowCount: Math.max(report.rows.length + 20, 1000),
                    columnCount: 50,
                  },
                },
              },
            },
          ],
        });
        sheet = { properties: created.replies[0].addSheet.properties };
        await api(token, `${id}:batchUpdate`, "POST", {
          requests: [
            {
              createDeveloperMetadata: {
                developerMetadata: {
                  metadataKey: "GALAPAGOS_EXPENSES",
                  metadataValue: owner,
                  visibility: "DOCUMENT",
                  location: { sheetId: sheet.properties.sheetId },
                },
              },
            },
          ],
        });
      }
      const sheetId = sheet.properties.sheetId,
        existingRows = sheet.properties.gridProperties.rowCount;
      if (existingRows < report.rows.length)
        await api(token, `${id}:batchUpdate`, "POST", {
          requests: [
            {
              appendDimension: {
                sheetId,
                dimension: "ROWS",
                length: report.rows.length - existingRows + 20,
              },
            },
          ],
        });
      // One atomic values update, padding old rows. AO onward is reserved for manual notes/settings.
      const padded = Array.from(
        { length: Math.max(existingRows, report.rows.length) },
        (_, i) =>
          Array.from({ length: 40 }, (_, j) => report.rows[i]?.[j] ?? ""),
      );
      await api(
        token,
        `${id}/values/${encodeURIComponent(`'${report.title}'!A1:AN${padded.length}`)}?valueInputOption=RAW`,
        "PUT",
        {
          range: `'${report.title}'!A1:AN${padded.length}`,
          majorDimension: "ROWS",
          values: padded,
        },
      );
      const requests: unknown[] = [
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 40,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.06, green: 0.22, blue: 0.19 },
                textFormat: {
                  bold: true,
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                },
              },
            },
            fields: "userEnteredFormat",
          },
        },
      ];
      for (const [row, hex] of Object.entries(report.colors || {})) {
        const rgb = hex.match(/../g)!.map((v) => parseInt(v, 16) / 255);
        requests.push({
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: +row,
              endRowIndex: +row + 1,
              startColumnIndex: 0,
              endColumnIndex: 15,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: rgb[0], green: rgb[1], blue: rgb[2] },
                textFormat: { bold: true },
              },
            },
            fields: "userEnteredFormat",
          },
        });
      }
      await api(token, `${id}:batchUpdate`, "POST", { requests });
    }
    for (let i = 0; i < 3; i++) {
      const latest = await load(who);
      latest.sync = {
        last_success: new Date().toISOString(),
        last_attempt: attempt,
        error: null,
        dirty: latest.version !== snapshot.version,
      };
      try {
        await save(who, latest);
        break;
      } catch (e) {
        if ((e as Error).message !== "VERSION_CONFLICT" || i === 2) throw e;
      }
    }
    return { sheets: data.length };
  } catch (e) {
    for (let i = 0; i < 3; i++) {
      const latest = await load(who);
      latest.sync = {
        ...latest.sync,
        last_attempt: attempt,
        error: (e as Error).message,
        dirty: true,
      };
      try {
        await save(who, latest);
        break;
      } catch (err) {
        if ((err as Error).message !== "VERSION_CONFLICT" || i === 2) break;
      }
    }
    throw e;
  } finally {
    await unlock(who, "google_sync");
  }
}
