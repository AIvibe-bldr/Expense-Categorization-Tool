import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test("CSV import → classify → reuse → dashboard → mobile", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "お金の流れを、クリアに。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "＋ 明細を取り込む" }).click();
  await page
    .getByRole("combobox", { name: "金融サービス", exact: true })
    .selectOption("rakuten_card");
  await page.getByLabel("口座・カードの別名").fill("rakuten-main");
  await page
    .getByLabel("CSVファイル", { exact: true })
    .setInputFiles("public/samples/rakuten_card.csv");
  await page
    .getByRole("button", { name: "明細を取り込む", exact: true })
    .last()
    .click();
  await expect(page.getByRole("status")).toContainText("取込処理が完了");
  await page.getByRole("button", { name: /明細管理/ }).click();
  await expect(
    page.getByRole("cell", { name: "Amazon 購入", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "詳細・分類 →" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const dialog = page.getByRole("dialog");
  const options = await dialog
    .getByRole("combobox", { name: "用途分類", exact: true })
    .locator("option")
    .allTextContents();
  const label = options.find((v) => v.includes("Amazon [A137]"))!;
  await dialog
    .getByRole("combobox", { name: "用途分類", exact: true })
    .selectOption({ label });
  await dialog.getByLabel("同じ利用先の用途分類を次回も適用する").check();
  await dialog.getByRole("button", { name: "分類を承認して保存" }).click();
  await expect(dialog).toBeHidden();
  const r = await request.get("/api/state?month=2026-10");
  const s = await r.json();
  expect(s.state.transactions).toHaveLength(1);
  expect(s.state.rules).toHaveLength(1);
  expect(s.summary.purchase).toBe(30000);
  expect(s.state.transactions[0].raw_encrypted).toBeUndefined();
  const duplicate = await request.post("/api/imports", {
    headers: { Origin: "http://127.0.0.1:3100" },
    multipart: {
      source: "rakuten_card",
      account: "rakuten-main",
      file: {
        name: "repeat.csv",
        mimeType: "text/csv",
        buffer: readFileSync("public/samples/rakuten_card.csv"),
      },
    },
  });
  expect(duplicate.ok()).toBe(true);
  expect((await duplicate.json()).count).toBe(0);
  const second = await request.post("/api/imports", {
    headers: { Origin: "http://127.0.0.1:3100" },
    multipart: {
      source: "rakuten_card",
      account: "rakuten-main",
      file: {
        name: "next.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          "利用日,利用先,利用金額,取引種別,利用明細ID\n2026-10-06,Ａｍａｚｏｎ,1000,購入,second",
        ),
      },
    },
  });
  expect(second.ok()).toBe(true);
  const next = await (await request.get("/api/state?month=2026-10")).json();
  expect(next.state.transactions[1].classification_source).toBe("rule");
  const forbidden = await request.post("/api/rules", {
    headers: { Origin: "https://evil.invalid" },
    data: {},
  });
  expect(forbidden.status()).toBe(403);
  const cron = await request.post("/api/jobs/daily");
  expect(cron.status()).toBe(401);
  const backup = await request.get("/api/backup");
  expect(backup.ok()).toBe(true);
  expect(await backup.text()).not.toContain("Amazon");
  const exportFile = await request.get("/api/export?year=2026");
  expect(exportFile.ok()).toBe(true);
  expect((await exportFile.body()).subarray(0, 2).toString()).toBe("PK");
  await page.getByRole("button", { name: /概況/ }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "月別の購入支出" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
