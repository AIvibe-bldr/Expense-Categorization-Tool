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
