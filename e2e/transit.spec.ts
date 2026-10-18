import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs/promises';

test('transit dashboard filters, data evidence, drill-down, customer mode and PNG export', async ({ page }) => {
  const failures: string[] = [], requests: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await goRoute(page);
  await expect(page.getByTestId('transit-count')).toHaveText('69条', { timeout: 60000 });
  await expect(page.getByTestId('transit-median')).toHaveText('16天');
  await expect(page.getByTestId('transit-p90')).toHaveText('20天');
  await expect(page.getByText('历史时效数据', { exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '渠道时效' })).toHaveClass(/ant-menu-item-selected/);
  await expect(page.locator('.transit-chart canvas')).toHaveCount(4);
  expect(requests.some(url => new URL(url).pathname.startsWith('/api/'))).toBe(false);
  await page.getByRole('button', { name: '数据与口径' }).click();
  await expect(page.getByText('数据来源与统计口径', { exact: true })).toBeVisible();
  await expect(page.locator('.ant-modal')).toContainText('12,519 条');
  await page.locator('.ant-modal-footer').getByRole('button', { name: /关\s*闭/ }).click();
  await page.getByRole('button', { name: /定时达 · \d+ 条/ }).click();
  await expect(page.getByTestId('transit-count')).toHaveText('63条');
  await expect(page.getByTestId('transit-median')).toHaveText('22天');
  await page.getByRole('button', { name: /美森 · \d+ 条/ }).click();
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
  await page.getByRole('spinbutton', { name: '观察天数' }).fill('16');
  await page.getByRole('spinbutton', { name: '观察天数' }).blur();
  await expect(page.locator('.transit-evidence-copy')).toContainText('16 天');
  await selectTime(page, '截至数据日近 90 天');
  await expect(page).toHaveURL(/start=2026-06-28/);
  await expect(page.getByTestId('transit-count')).toHaveText('10条');
  await selectTime(page, '全部历史');
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
  await page.locator('.transit-record-link').first().click();
  await expect(page.locator('.ant-drawer')).toContainText('原表位置');
  await expect(page.locator('.ant-drawer .ant-timeline-item')).toHaveCount(6);
  await page.locator('.ant-drawer-close').click();
  await page.getByRole('switch', { name: '客户展示' }).click();
  await expect(page.locator('.transit-details-card')).toBeHidden();
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出报告 PNG' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('ONT8');
  const path = '.local/transit/exported-report.png';
  await download.saveAs(path);
  expect((await fs.stat(path)).size).toBeGreaterThan(30_000);
  await page.screenshot({ path: '.local/transit/customer-desktop.png', fullPage: true });
  expect(failures).toEqual([]);
});

test('empty, low-sample, invalid and unknown records remain distinct', async ({ page }) => {
  await page.goto('./#/transit?warehouse=NO_SUCH_WAREHOUSE&channel=美森');
  await expect(page.getByText('当前筛选条件下暂无有效到仓样本')).toBeVisible();
  await expect(page.getByRole('button', { name: '导出报告 PNG' })).toBeDisabled();
  await page.goto('./#/transit?warehouse=ABE8&channel=定时达');
  await expect(page.getByText(/当前不足 10 条/)).toBeVisible();
  await page.goto('./#/transit?warehouse=&channel=');
  await openPanel(page, '原始明细与数据核对');
  await expect(page.getByTestId('transit-count')).toHaveText('12,281条');
  await expect(page.locator('.transit-coverage-line')).toContainText('到仓未回填 76 条');
  await expect(page.locator('.transit-coverage-line')).toContainText('日期异常 11 条');
  await page.locator('.transit-details-card .ant-select-selector').click();
  await page.getByTitle('日期异常', { exact: true }).click();
  await expect(page.locator('.transit-table-summary')).toContainText('11 条');
  await page.locator('.transit-record-link').first().click();
  await expect(page.locator('.transit-drawer-total')).toContainText('—');
});

test('mobile charts follow the collapsed sidebar and navigation remains usable', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await goRoute(page);
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.getByTestId('transit-trend-chart').evaluate(el => {
    const canvas = el.querySelector('canvas');
    return canvas ? Math.abs(canvas.width / devicePixelRatio - el.clientWidth) : 999;
  })).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator('.transit-trend-panel').getByText('按月', { exact: true }).click();
  await page.locator('[data-testid="transit-trend-chart"] canvas').waitFor();
  await page.screenshot({ path: '.local/transit/mobile-verified.png', fullPage: true });
  await page.getByRole('button', { name: '展开菜单' }).click();
  await expect(page.getByRole('menuitem', { name: '渠道时效' })).toBeVisible();
  await page.route('**/api/catalog*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '本地导航测试' } }) }));
  await page.getByRole('menuitem', { name: '渠道报价台' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page).toHaveTitle('中航环球 · 渠道报价台');
  await expect(page.getByRole('menuitem', { name: '渠道报价台' })).toHaveClass(/ant-menu-item-selected/);
  await page.getByRole('menuitem', { name: '渠道时效' }).click();
  await expect(page.getByTestId('transit-count')).toHaveText('4,174条');
  expect(failures).toEqual([]);
});

test('missing static files show a retry state instead of fabricated metrics', async ({ page }) => {
  await page.route('**/transit/records-*.json', route => route.fulfill({ status: 404, body: '{}' }));
  await page.goto('./#/transit');
  await expect(page.getByText('时效数据暂时无法加载')).toBeVisible();
  await expect(page.getByTestId('transit-count')).toHaveCount(0);
  await page.unroute('**/transit/records-*.json');
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByTestId('transit-count')).toHaveText('4,174条');
});

test('the quote landing page does not preload transit datasets or chart bundles', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.route('**/api/catalog*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '只验证导航与按需加载' } }) }));
  await page.goto('./');
  await expect(page.getByText('云端报价库', { exact: true })).toBeVisible();
  expect(requests.some(url => url.includes('/transit/') || url.includes('/assets/transit-charts-'))).toBe(false);
  await page.getByRole('menuitem', { name: '渠道时效' }).click();
  await expect(page.getByTestId('transit-count')).toHaveText('4,174条');
  expect(requests.some(url => url.includes('/transit/manifest.json'))).toBe(true);
});

test('native chart marks drill into the matching period and warehouse', async ({ page }) => {
  await page.goto('./#/transit?warehouse=ONT8&channel=美森&start=2026-08-10&end=2026-08-23');
  await openRouteDetails(page);
  await expect(page.getByTestId('transit-count')).toHaveText('4条');
  const canvas = page.getByTestId('transit-trend-chart').locator('canvas');
  await expect.poll(() => findTrendMarks(canvas)).not.toHaveLength(0);
  const mark = (await findTrendMarks(canvas))[0];
  await canvas.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await canvas.hover({ position: mark });
  await expect(page.locator('.g2-tooltip').filter({ hasText: '2026-08-10 至 2026-08-16' })).toBeVisible();
  await expect(page.locator('.g2-tooltip').filter({ hasText: '2026-08-10 至 2026-08-16' })).toContainText('3 条');
  const tooltip = await page.locator('.g2-tooltip').filter({ hasText: '2026-08-10 至 2026-08-16' }).innerText();
  expect(tooltip.match(/到仓记录/g)).toHaveLength(1);
  await canvas.click({ position: mark });
  await expect(page.locator('.transit-table-summary')).toContainText('3 条');
  await expect(page.locator('.transit-table-summary')).toContainText('2026-08-10 至 2026-08-16');
  await goRoute(page);
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
  await page.getByTestId('transit-heatmap').locator('canvas').click({ position: { x: 100, y: 25 } });
  await expect(page).toHaveURL(/warehouse=LAS1/);
  await expect(page.locator('.transit-report-heading h2')).toContainText('美森 → LAS1');
});

test('weekly and monthly charts share a paged calendar without changing the filtered totals', async ({ page }) => {
  await goRoute(page);
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
  const trend = page.locator('.transit-trend-panel'), distribution = page.locator('.transit-distribution-panel');
  await expect(trend.locator('.transit-period-nav')).toContainText('2026-06-15');
  await expect(distribution.locator('.transit-period-nav')).toContainText('2026-06-15');
  await expect(trend.locator('.transit-sample-strip button')).toHaveCount(12);
  await expect(trend.locator('.transit-sample-strip button').first()).toHaveText('—');
  await trend.getByRole('button', { name: '更早的开船周' }).click();
  await expect(trend.locator('.transit-period-nav')).toContainText('2026-03-23');
  await expect(distribution.locator('.transit-period-nav')).toContainText('2026-03-23');
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
  await distribution.getByText('按月', { exact: true }).click();
  await expect(trend.locator('.ant-card-head-title')).toContainText('每月开船');
  await expect(trend.locator('.transit-period-nav')).toContainText('2025-10');
  await expect(distribution.locator('.transit-period-nav')).toContainText('2025-10');
  await expect(page.getByTestId('transit-median')).toHaveText('16天');
  await trend.getByText('按周', { exact: true }).click();
  await selectTime(page, '截至数据日近 90 天');
  await expect(page.getByTestId('transit-count')).toHaveText('10条');
  await expect(trend.locator('.transit-period-nav')).toContainText('2026-07-06');
});

test('year shortcuts and calendar navigation expose the full imported history', async ({ page }) => {
  await page.goto('./#/transit?warehouse=ONT8&channel=美森&start=2026-03-30&end=2026-09-25');
  await openRouteDetails(page);
  await expect(page.getByTestId('transit-count')).toHaveText('25条');
  await expect(page.getByTestId('transit-date-filter-hint')).toContainText('全部时间共有 69 条');
  await expect(page.getByTestId('transit-date-filter-hint')).toContainText('44 条在日期范围外');
  await selectTime(page, '2025 年');
  await expect(page.getByTestId('transit-count')).toHaveText('38条');
  await expect(page).toHaveURL(/start=2025-01-01/);
  await selectTime(page, '全部历史');
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
  await expect(page.getByTestId('transit-date-filter-hint')).toHaveCount(0);
  const trend = page.locator('.transit-trend-panel');
  await trend.getByRole('button', { name: '最早的开船周' }).click();
  await expect(trend.locator('.transit-period-nav')).toContainText('2025-01-06');
  await expect(trend.locator('.transit-calendar-coverage')).toContainText('第 1 /');
  await expect(page.locator('.transit-distribution-panel .transit-period-nav')).toContainText('2025-01-06');
  await expect(page.getByTestId('transit-count')).toHaveText('69条');
});

test('both departure years and September 24 deliveries reconcile with the source workbook', async ({ page }) => {
  await page.goto('./#/transit?warehouse=&channel=&region=&group=&start=&end=');
  await openPanel(page, '原始明细与数据核对');
  await expect(page.getByTestId('transit-count')).toHaveText('12,281条');
  await selectTime(page, '2025 年');
  await expect(page.getByTestId('transit-count')).toHaveText('6,647条');
  await expect(page.locator('.transit-coverage-line')).toContainText('所选源表记录 6,704 条');
  await selectTime(page, '2026 年');
  await expect(page.getByTestId('transit-count')).toHaveText('5,634条');
  await expect(page.locator('.transit-coverage-line')).toContainText('所选源表记录 5,664 条');
  await page.goto('./#/transit?warehouse=MDW2&channel=美森&start=2026-09-02&end=2026-09-02');
  await openRouteDetails(page);
  await expect(page.getByTestId('transit-count')).toHaveText('1条');
  await expect(page.locator('.transit-details-card')).toContainText('2026-09-24');
  await expect(page.locator('.transit-details-card')).toContainText('2026数据源 · 第 5931 行');
  await expect(page.locator('.transit-trend-panel .transit-period-nav')).toContainText('2026-08-31');
});

test('native tooltips remain fully visible at viewport edges on desktop and narrow screens', async ({ page }) => {
  await page.goto('./#/transit?warehouse=ONT8&channel=美森&start=2026-08-10&end=2026-08-23');
  await openRouteDetails(page);
  await expect(page.getByTestId('transit-count')).toHaveText('4条');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const canvas = page.getByTestId('transit-trend-chart').locator('canvas');
    await expect.poll(() => page.getByTestId('transit-trend-chart').evaluate(el => {
      const chartCanvas = el.querySelector('canvas');
      return chartCanvas ? Math.abs(chartCanvas.width / devicePixelRatio - el.clientWidth) : 999;
    })).toBeLessThan(2);
    // Wait for the native backing canvas to resize, not just its CSS max-width.
    await expect.poll(() => findTrendMarks(canvas)).not.toHaveLength(0);
    const marks = await findTrendMarks(canvas);
    for (const top of [25, 880 - Math.max(...marks.map(mark => mark.y))]) {
      await canvas.evaluate((el, top) => window.scrollBy(0, el.getBoundingClientRect().top - top), top);
      const box = (await canvas.boundingBox())!;
      for (const point of await findTrendMarks(canvas)) {
        await page.mouse.move(box.x + point.x, box.y + point.y);
        const tip = page.locator('.transit-tooltip-layer .g2-tooltip:visible');
        await expect(tip).toContainText('到仓记录');
        await expect.poll(() => tip.evaluate(el => {
          const r = el.getBoundingClientRect();
          return r.left >= 11 && r.top >= 11 && r.right <= innerWidth - 11 && r.bottom <= innerHeight - 11 && el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1;
        })).toBe(true);
        expect((await tip.innerText()).match(/到仓记录/g)).toHaveLength(1);
      }
    }
    const heat = page.getByTestId('transit-heatmap').locator('canvas');
    await heat.scrollIntoViewIfNeeded();
    for (const edge of ['left', 'right']) {
      const box = (await heat.boundingBox())!;
      await heat.hover({ position: { x: edge === 'left' ? 85 : box.width - 65, y: 25 } });
      const tip = page.locator('.transit-tooltip-layer .g2-tooltip:visible');
      await expect(tip).toContainText('到仓记录');
      await expect.poll(() => tip.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 11 && r.top >= 11 && r.right <= innerWidth - 11 && r.bottom <= innerHeight - 11; })).toBe(true);
    }
  }
});

// Locate native Line point marks below its built-in legend, using both theme colors.
async function findTrendMarks(canvas: Locator) {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const pixels = el.getContext('2d')!.getImageData(0, 0, el.width, el.height);
    const points = ['--color-primary', '--color-purple'].flatMap(variable => {
      const hex = getComputedStyle(document.documentElement).getPropertyValue(variable).trim().slice(1);
      const rgb = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
      const groups: { x: number; y: number }[][] = [];
      for (let x = 50 * devicePixelRatio; x < el.width - 22 * devicePixelRatio; x++) {
        let start = 0;
        for (let y = 65 * devicePixelRatio; y < el.height - 50 * devicePixelRatio; y++) {
          const i = (y * el.width + x) * 4;
          const hit = rgb.every((value, channel) => Math.abs(pixels.data[i + channel] - value) < 4) && pixels.data[i + 3] > 240;
          if (hit && !start) start = y;
          if (!hit && start) {
            if (y - start >= 5 * devicePixelRatio) {
              const point = { x, y: (start + y) / 2 };
              const group = groups.find(group => point.x - group.at(-1)!.x <= 4 * devicePixelRatio && Math.abs(point.y - group.at(-1)!.y) <= 5 * devicePixelRatio);
              if (group) group.push(point); else groups.push([point]);
            }
            start = 0;
          }
        }
      }
      return groups.filter(group => group.length >= 2).map(group => ({
        x: group.reduce((sum, point) => sum + point.x, 0) / group.length / devicePixelRatio,
        y: group.reduce((sum, point) => sum + point.y, 0) / group.length / devicePixelRatio,
      }));
    });
    if (!points.length) return [];
    return [points[0], points.reduce((right, point) => point.x > right.x ? point : right)];
  });
}


async function selectTime(page: Page, label: string) {
  await page.locator('.transit-time-search .ant-select-selector').click();
  await page.getByTitle(label, { exact: true }).click();
}

async function openPanel(page: Page, label: string) {
  const button = page.getByRole('button', { name: new RegExp(label) }).first();
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}

async function openRouteDetails(page: Page) {
  const toggle = page.locator('.transit-trend-toggle');
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('.transit-trend-panel .ant-segmented').getByText('按周', { exact: true }).click();
  for (const label of ['渠道对比图', '运输环节耗时', '按指定天数查看到仓占比', '各仓库时效分布', '原始明细与数据核对']) await openPanel(page, label);
}

async function goRoute(page: Page) {
  await page.goto('./#/transit?warehouse=ONT8&channel=美森&start=&end=');
  await openRouteDetails(page);
}
