import { expect, test, type Page } from '@playwright/test';

async function selectTime(page: Page, label: string) {
  await page.locator('.transit-time-search .ant-select-selector').click();
  await page.getByTitle(label, { exact: true }).click();
}

test('landing overview shows every channel and region with the visible snapshot period', async ({ page }) => {
  await page.goto('./#/transit');
  const overview = page.getByTestId('transit-overview');
  await expect(overview).toBeVisible();
  await expect(overview.locator('tbody tr')).toHaveCount(6);
  await expect(overview.getByRole('columnheader')).toHaveText(['运输渠道', '美西', '美中', '美东']);
  await expect(page.locator('.transit-scope-bar')).toContainText('2026-03-30 至 2026-09-25');
  await expect(page.locator('.transit-scope-bar')).toContainText('最新已记录到仓日：2026-09-25');
  await expect(overview.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '美森', exact: true }) })).toContainText('样本较少');
  await expect(overview).toContainText('暂无样本');
  await expect(page.getByTestId('transit-report')).toHaveCount(0);
  await expect(page.locator('.transit-chart canvas')).toHaveCount(0);
  await expect(page.getByTestId('transit-count')).toHaveText('4,174条');
  await expect(page.locator('.transit-details-card')).toHaveCount(0);
  await overview.getByRole('button', { name: /^美森 · 美西/ }).click();
  await expect(page.locator('.transit-warehouse-picks')).toContainText('美森 · 美西');
  await page.locator('.transit-warehouse-picks button').first().click();
  await expect(page.getByTestId('transit-comparison')).toBeVisible();
  await expect(page.locator('.transit-channel-card')).toHaveCount(3);
  await expect(page.locator('.transit-scope-bar')).toContainText('2026-03-30 至 2026-09-25');
});

test('warehouse search compares every channel before showing a selected route and its monthly trend', async ({ page }) => {
  await page.goto('./#/transit');
  const search = page.getByRole('combobox', { name: '目的仓库', exact: true });
  await search.fill('ONT8');
  await page.getByTitle('ONT8 · 美国 · Moreno Valley · 加利福尼亚州（CA） · 邮编 92551', { exact: true }).click();
  await selectTime(page, '全部历史');
  const cards = page.locator('.transit-channel-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('16');
  await expect(cards.nth(0)).toContainText('20 天');
  await expect(cards.nth(0)).toContainText('69 条');
  await expect(cards.nth(1)).toContainText('22');
  await expect(cards.nth(2)).toContainText('207 条');
  await expect(page.getByTestId('transit-comparison')).toContainText('另有 2 条');
  await expect(page.getByTestId('transit-median')).toHaveCount(0);
  await cards.nth(0).click();
  await expect(page.locator('.transit-conclusion')).toContainText('91.3%');
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
  await expect(page.locator('.transit-trend-panel')).toBeHidden();
  await page.getByRole('button', { name: '查看时效趋势', exact: true }).click();
  await expect(page.locator('.transit-trend-panel')).toContainText('每月开船');
  await selectTime(page, '截至数据日近 90 天');
  await expect(cards.nth(0)).toContainText('10 条');
  await expect(cards.nth(1)).toContainText('6 条');
  await expect(cards.nth(1)).toContainText('样本较少');
  await expect(page.getByTestId('transit-count')).toHaveText('10条');
  await page.reload();
  await expect(page.getByTestId('transit-count')).toHaveText('10条');
  await page.getByRole('button', { name: /重\s*置/ }).click();
  await expect(page.getByTestId('transit-overview')).toBeVisible();
  await expect(page.locator('.transit-scope-bar')).toContainText('2026-03-30 至 2026-09-25');
});

test('export opens the collapsed trend and printing excludes the overview and comparison', async ({ page }) => {
  await page.goto('./#/transit?warehouse=ONT8&channel=美森');
  await expect(page.locator('.transit-trend-panel')).toBeHidden();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出报告 PNG' }).click();
  const download = await downloaded;
  await download.saveAs('.local/transit/overview-report-export.png');
  await expect(page.locator('.transit-trend-panel')).toBeVisible();
  await expect(page.getByTestId('transit-trend-chart').locator('canvas')).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('transit-comparison')).toBeHidden();
  await expect(page.locator('.transit-controls')).toBeHidden();
  await expect(page.getByTestId('transit-report')).toBeVisible();
  await page.pdf({ path: '.local/transit/overview-report-print.pdf', preferCSSPageSize: true, printBackground: true });
});

test('clearing a custom period updates the visible preset as well as the shared URL', async ({ page }) => {
  await page.goto('./#/transit?warehouse=ONT8&channel=美森&start=2026-03-30&end=2026-09-25');
  await selectTime(page, '自定义开船日期');
  await expect(page.locator('.transit-custom-range')).toBeVisible();
  await page.getByRole('button', { name: /原始明细与数据核对/ }).click();
  await page.getByRole('button', { name: '清除日期限制' }).click();
  await expect(page.locator('.transit-time-search')).toContainText('全部历史');
  await expect(page.locator('.transit-custom-range')).toHaveCount(0);
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
  await expect(page).toHaveURL(/start=&end=/);
});

test('mobile overview switches regions without horizontal scrolling and warehouse comparison stays compact', async ({ page }) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('./#/transit');
    const overview = page.getByTestId('transit-overview');
    await expect(overview).toBeVisible();
    await expect(overview.getByRole('columnheader', { name: '美西', exact: true })).toBeVisible();
    await page.getByRole('group', { name: '总览显示区域' }).getByRole('button', { name: /美\s*东/ }).click();
    await expect(overview.getByRole('columnheader', { name: '美东', exact: true })).toBeVisible();
    await expect(overview.getByRole('columnheader', { name: '美西', exact: true })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.goto('./#/transit?warehouse=ONT8&channel=&start=&end=');
    await expect(page.locator('.transit-channel-card')).toHaveCount(3);
    const box = await page.locator('.transit-channel-card').last().boundingBox();
    expect(box!.y + box!.height).toBeLessThan(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `.local/transit/comparison-verified-${width}.png`, fullPage: true });
  }
});
