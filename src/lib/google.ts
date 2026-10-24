import { randomBytes } from "node:crypto";
import { encrypt, decrypt, hash } from "./crypto";
import { getSecret, putSecret, lock, unlock, load, save } from "./store";
import type { Identity } from "./auth";
import { reports } from "./reports";
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
  if (!r.ok) throw Error(`Google Sheets 更新エラー (${r.status})`);
  return r.json();
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
