import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
test("CSV → category → editable Excel, including mobile", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "CSVを、項目別のExcelに。" }),
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
    label: labels.find((v) => v.includes("Amazon [A137]"))!,
  });
  await expect(page.getByRole("status")).toHaveText("振り分けを保存しました。");
  const preview = page.getByRole("region", { name: "Excel出力プレビュー" });
  await expect(preview.locator("tbody tr")).toHaveCount(1);
  await expect(preview.locator("tbody td").first()).toContainText("Amazon");
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
  expect(book.worksheets).toHaveLength(1);
  expect(book.worksheets[0].getCell("A2").text).toContain("Amazon");
  expect(book.worksheets[0].getCell("D2").value).toBe(30000);
  const previewCells = await preview
    .locator("tbody tr")
    .first()
    .locator("td")
    .allTextContents();
  const excelCells = Array.from({ length: 8 }, (_, i) => {
    const cell = book.worksheets[0].getRow(2).getCell(i + 1);
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
