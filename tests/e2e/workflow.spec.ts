import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
test("CSV → category → editable Excel, including mobile", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "自分のお金の使い道を、月ごとに。" }),
  ).toBeVisible();
  await page.getByLabel("金融サービス").selectOption("rakuten_card");
  await page
    .getByLabel("CSVファイル")
    .setInputFiles("public/samples/rakuten_card.csv");
  await page
    .getByRole("button", { name: "CSVを取り込む", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("1件を取り込みました");
  await page.getByLabel("対象年").fill("2026");
  const category = page.getByRole("combobox", {
    name: "Amazon 2026-10-05の項目",
  });
  await expect(category).toBeVisible();
  const labels = await category.locator("option").allTextContents();
  await category.selectOption({
    label: labels.find((v) => v === "Amazon")!,
  });
  await expect(page.getByRole("status")).toHaveText("振り分けを保存しました。");
  const preview = page.getByRole("region", { name: "Excel出力プレビュー" });
  const amazonRow = preview
    .locator("tbody tr")
    .filter({ has: page.getByRole("cell", { name: "Amazon", exact: true }) });
  await expect(amazonRow.locator("td").nth(10)).toHaveText("30,000");
  await expect(amazonRow.locator("td").nth(13)).toHaveText("30,000");
  await page.getByLabel("表示するシート").selectOption("10");
  await expect(preview.locator("tbody tr")).toHaveCount(1);
  await expect(preview.locator("tbody td").nth(2)).toContainText("Amazon");
  await page.getByLabel("明細を検索").fill("存在しない利用先");
  await expect(preview.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("明細を検索").fill("");

  await page.reload();
  await page.getByLabel("対象年").fill("2026");
  await expect(category).not.toHaveValue("");
  const response = await request.get("/api/export?year=2026&format=simple");
  expect(response.ok()).toBe(true);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    (await response.body()) as unknown as Parameters<typeof book.xlsx.load>[0],
  );
  expect(book.worksheets).toHaveLength(13);
  const annualRow = book.worksheets[0]
    .getRows(2, book.worksheets[0].rowCount - 1)!
    .find((row) => row.getCell(1).text.trim() === "Amazon")!;
  expect(annualRow.getCell(11).value).toBe(30000);
  expect(annualRow.getCell(14).value).toBe(30000);
  await expect(amazonRow.locator("td").nth(10)).toHaveText("30,000");
  await page.getByLabel("表示するシート").selectOption("10");
  expect(book.worksheets[10].getCell("F2").value).toBe(30000);
  const previewCells = await preview
    .locator("tbody tr")
    .first()
    .locator("td")
    .allTextContents();
  const excelCells = Array.from({ length: 9 }, (_, i) => {
    const cell = book.worksheets[10].getRow(2).getCell(i + 1);
    return typeof cell.value === "number"
      ? cell.value.toLocaleString("ja-JP")
      : cell.text;
  });
  expect(previewCells).toEqual(excelCells);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Excelをダウンロード" }).click();
  expect((await download).suggestedFilename()).toBe("galapagos-2026.xlsx");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(preview).toBeVisible();
  await page.getByLabel("対象年").fill("2000");
  await page.getByLabel("表示するシート").selectOption("10");
  await expect(preview.locator("tbody tr")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Excelをダウンロード" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("sheet follows import, immediate merchant updates, failure rollback and future reuse", async ({
  page,
  request,
}) => {
  const origin = "http://127.0.0.1:3100";
  async function importRows(rows: string[], service = "rakuten_card") {
    const response = await request.post("/api/imports", {
      headers: { Origin: origin },
      multipart: {
        source: service,
        account: "merchant-reuse",
        file: {
          name: "synthetic.csv",
          mimeType: "text/csv",
          buffer: Buffer.from(
            ["利用日,利用先,利用金額,取引種別,利用明細ID", ...rows].join("\n"),
          ),
        },
      },
    });
    expect(response.ok()).toBe(true);
  }
  await importRows([
    "2026-10-11,架空のカフェ,100,購入,reuse1",
    "2025-09-10,架空のカフェ,300,購入,reuse2",
    "2026-10-12,架空のカフェ駅前,400,購入,reuse3",
  ]);
  await importRows(["2026-11-12,架空のカフェ,200,購入,reuse4"], "smbc_card");
  await page.goto("/");
  await page.getByLabel("対象年").fill("2026");
  expect(await page.locator("main > section h2").allTextContents()).toEqual([
    "1. CSVを取り込む",
    "2. 振り分け結果を確認・出力",
    "3. 項目に振り分ける",
  ]);
  const preview = page.getByRole("region", { name: "Excel出力プレビュー" });
  const row = preview
    .locator("tbody tr")
    .filter({ has: page.getByRole("cell", { name: "外食", exact: true }) });
  const category = page.getByRole("combobox", {
    name: "架空のカフェ 2026-10-11の項目",
    exact: true,
  });
  let release!: () => void;
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  await page.route("**/api/classify", async (route) => {
    await gate;
    if (fail)
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "テスト用の保存失敗" }),
      });
    else await route.continue();
  });
  const original = await category.inputValue();
  await category.selectOption({ label: "外食" });
  // Server is deliberately blocked: these changes must happen before saving finishes.
  await expect(row.locator("td").nth(10)).toHaveText("100");
  await expect(row.locator("td").nth(11)).toHaveText("200");
  await expect(
    page.getByRole("combobox", {
      name: "架空のカフェ 2026-11-12の項目",
      exact: true,
    }),
  ).toHaveValue(await category.inputValue());
  release();
  await expect(page.locator("main").getByRole("alert")).toHaveText(
    "テスト用の保存失敗",
  );
  await expect(category).toHaveValue(original);
  await expect(row.locator("td").nth(10)).toHaveText("0");
  fail = false;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await category.selectOption({ label: "外食" });
  await expect(row.locator("td").nth(10)).toHaveText("100");
  release();
  await expect(page.getByRole("status")).toHaveText("振り分けを保存しました。");
  const state = (await (await request.get("/api/state")).json()).state;
  const matching = state.transactions.filter(
    (t: { merchant_original: string }) =>
      t.merchant_original === "架空のカフェ",
  );
  expect(matching).toHaveLength(3);
  const assigned = matching[0].category_id;
  expect(
    matching.every((t: { category_id: string }) => t.category_id === assigned),
  ).toBe(true);
  expect(
    state.transactions.find(
      (t: { merchant_original: string }) =>
        t.merchant_original === "架空のカフェ駅前",
    ).category_id,
  ).not.toBe(assigned);
  await importRows(["2026-12-01,架空のカフェ,500,購入,reuse5"]);
  const latest = (await (await request.get("/api/state")).json()).state;
  expect(latest.transactions.at(-1).category_id).toBe(assigned);
  expect(latest.transactions.at(-1).classification_source).toBe("rule");
});

test("pending Other can be confirmed and a stale state read cannot undo sheet updates", async ({
  page,
  request,
}) => {
  const imported = await request.post("/api/imports", {
    headers: { Origin: "http://127.0.0.1:3100" },
    multipart: {
      source: "rakuten_card",
      account: "other-regression",
      file: {
        name: "synthetic.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          "利用日,利用先,利用金額,取引種別,利用明細ID\n2026-08-21,その他選択の検証店,789,購入,other-regression",
        ),
      },
    },
  });
  expect(imported.ok()).toBe(true);
  await page.goto("/");
  await page.getByLabel("対象年").fill("2026");
  const category = page.getByRole("combobox", {
    name: "その他選択の検証店 2026-08-21の項目",
  });
  await expect(category).toHaveValue("");
  const stale = await (await request.get("/api/state")).json();
  let reads = 0;
  await page.route("**/api/state", async (route) => {
    reads++;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(stale),
    });
  });
  await page.getByLabel("表示するシート").selectOption("1");
  const savedResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/classify") && r.request().method() === "POST",
  );
  await category.selectOption({ label: "その他" });
  await expect(page.getByRole("status")).toHaveText("振り分けを保存しました。");
  await expect(page.getByLabel("表示するシート")).toHaveValue("0");
  await expect(category).not.toHaveValue("");
  const result = await (await savedResponse).json();
  expect(
    result.state.transactions.find(
      (t: { merchant_original: string }) =>
        t.merchant_original === "その他選択の検証店",
    ).classification_status,
  ).toBe("confirmed");
  expect(
    result.state.transactions.every((t: object) => !("raw_encrypted" in t)),
  ).toBe(true);
  expect(reads).toBe(0);
  const updated = page
    .getByRole("region", { name: "Excel出力プレビュー" })
    .locator('[data-updated="true"]');
  await expect(updated).toHaveCount(1);
  await expect(updated.locator("td").first()).toHaveText("その他");
  await expect(updated.locator("td").nth(8)).toHaveText("789");
  await page.unroute("**/api/state");
  await page.reload();
  await page.getByLabel("対象年").fill("2026");
  await expect(category).not.toHaveValue("");
});
