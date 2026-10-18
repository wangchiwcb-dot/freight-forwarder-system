import { expect, test } from '@playwright/test';

test('charts reuse their canvas while resizing the window and sidebar', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto('./#/transit?warehouse=ONT8&channel=美森&start=&end=');
  await page.getByRole('button', { name: '查看时效趋势', exact: true }).click();
  for (const label of ['渠道对比图', '运输环节耗时', '各仓库时效分布']) await page.getByRole('button', { name: label }).click();
  await expect(page.locator('.transit-chart canvas')).toHaveCount(4);
  const canvases = await page.locator('.transit-chart canvas').elementHandles();
  async function checkSizes() {
    await expect
      .poll(() =>
        page.locator('.transit-chart').evaluateAll((elements) =>
          elements.every((el) => {
            const canvas = el.querySelector('canvas');
            return (
              canvas &&
              Math.abs(canvas.width / devicePixelRatio - el.clientWidth) < 2
            );
          }),
        ),
      )
      .toBe(true);
    for (const canvas of canvases)
      expect(await canvas.evaluate((el) => el.isConnected)).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await checkSizes();
  await page.getByRole('button', { name: '收起菜单' }).click();
  await checkSizes();
  await page.getByRole('button', { name: '展开菜单' }).click();
  await checkSizes();
  for (const width of [1024, 768, 390, 320, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await checkSizes();
  }
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
  expect(failures).toEqual([]);
});

test('navigation, browser history and report print styling share the app theme', async ({
  page,
}) => {
  await page.route('**/api/catalog*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '主题导航验证' } }),
    }),
  );
  await page.goto('./#/transit?warehouse=ONT8&channel=美森&start=&end=');
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
  await page.getByRole('menuitem', { name: '渠道报价台' }).click();
  await expect(page).toHaveTitle('中航环球 · 渠道报价台');
  await page.goBack();
  await expect(page).toHaveTitle('中航环球 · 渠道时效');
  await expect(page.getByRole('menuitem', { name: '渠道时效' })).toHaveClass(
    /ant-menu-item-selected/,
  );
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.app-sider')).toBeHidden();
  await expect(page.locator('.app-header')).toBeHidden();
  await expect(page.getByTestId('transit-report')).toBeVisible();
});
