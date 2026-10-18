import { expect, test } from '@playwright/test';

test('destination search accepts Chinese state and postal code and excludes removed destinations', async ({ page }) => {
  await page.goto('./#/transit');
  const search = page.getByRole('combobox', { name: '目的仓库', exact: true });
  await search.fill('08873');
  const teb9 = page.getByTitle('TEB9 · 美国 · Somerset · 新泽西州（NJ） · 邮编 08873', { exact: true });
  await expect(teb9).toBeVisible();
  await teb9.click();
  await expect(page.getByTestId('transit-destination')).toContainText('Somerset · 新泽西州（NJ） · 邮编 08873');
  await search.fill('弗吉尼亚州');
  const orf2 = page.getByTitle('ORF2 · 美国 · Chesapeake · 弗吉尼亚州（VA） · 邮编 23321-1425', { exact: true });
  await expect(orf2).toBeVisible();
  await orf2.click();
  await expect(page.getByTestId('transit-destination')).toContainText('Chesapeake');
  for (const code of ['LAX1T', 'DFW6S', 'FBM-95125', 'FEDEX/UPS']) {
    await search.fill(code);
    await expect(page.locator('.ant-select-dropdown:visible .ant-empty-description')).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '数据与口径' }).click();
  await expect(page.locator('.ant-modal')).toContainText('保留 12,368 条 + 排除 151 条');
  await expect(page.locator('.ant-modal')).toContainText('12 个代码，20 条记录');
});

test('actual warehouse address and sources are traceable, ambiguous operator remains visible', async ({ page }) => {
  await page.goto('./#/transit?warehouse=ORF2&channel=美森&start=&end=');
  await expect(page.getByTestId('transit-destination')).toContainText('Chesapeake · 弗吉尼亚州（VA） · 邮编 23321-1425');
  await page.getByRole('button', { name: /原始明细与数据核对/ }).click();
  await page.locator('.transit-record-link').first().click();
  const drawer = page.locator('.ant-drawer');
  await expect(drawer).toContainText('5045 PORTSMOUTH BLVD');
  await expect(drawer).toContainText('Richmond 9603 Coach Road / 23297 为 UPS 专用转运地址');
  await expect(drawer.getByRole('link', { name: '公开来源 1', exact: true })).toHaveAttribute('href', 'https://www.jiufanglogistics.com/amazon-fba-warehouse-locations/');
  await page.goto('./#/transit?warehouse=MCO1&channel=&start=&end=');
  await expect(page.getByTestId('transit-destination')).toContainText('Orlando · 佛罗里达州（FL） · 邮编 32824');
  await expect(page.getByTestId('transit-destination')).toContainText('历史记录运营商仍待核');
  await page.goto('./#/transit?warehouse=BER8&channel=&start=&end=');
  await expect(page.getByTestId('transit-destination')).toContainText('德国 · Schönefeld · 勃兰登堡州');
  await expect(page.getByTestId('transit-destination')).toContainText('邮编 12529');
});
