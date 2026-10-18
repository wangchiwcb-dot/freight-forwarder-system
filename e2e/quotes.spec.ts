import { expect, test } from '@playwright/test';

test('search, pagination, detail, history and source coverage in live or published mode',async({page})=>{
  const failures:string[]=[];page.on('pageerror',error=>failures.push(error.message));
  const requests:string[]=[];page.on('request',request=>requests.push(request.url()));
  await page.goto('./');
  await expect(page.getByText('云端报价库')).toBeVisible();
  await expect(page.locator('.channel-name').first()).toBeVisible({timeout:30000});
  const snapshot=await page.getByText('已核对发布快照',{exact:true}).isVisible();
  if(snapshot)await expect(page.getByText('实时服务读取额度已用尽，当前使用已核对发布快照',{exact:true})).toBeVisible();
  await page.getByRole('spinbutton',{name:'货物实重'}).fill('300');
  await page.getByRole('spinbutton',{name:'货物体积'}).fill('1');
  await page.getByRole('spinbutton',{name:'货物件数'}).fill('10');
  const searchResponse=snapshot?null:page.waitForResponse(r=>r.url().includes('/api/quotes/search') && r.request().method()==='POST');
  await page.getByRole('button',{name:'搜索报价'}).click();
  if(searchResponse){const search=await (await searchResponse).json();expect(search.computedCount).toBeGreaterThan(0);}
  await expect(page.locator('.is-estimated').first()).toBeVisible();
  await page.screenshot({path:'.local/api-acceptance/search-desktop.png',fullPage:true});
  const firstId=await page.locator('.ant-table-row').first().getAttribute('data-row-key');
  await page.getByTitle('2',{exact:true}).click();
  await expect(page.locator('.ant-pagination-item-active')).toHaveAttribute('title','2');
  await expect(page.locator('.ant-table-row').first()).not.toHaveAttribute('data-row-key',firstId!);
  await page.locator('.channel-name').first().click();
  await expect(page.getByText('税费口径',{exact:true})).toBeVisible();
  await page.getByText('同条件历史报价',{exact:true}).click();
  await expect(page.getByText(/同条件多来源均保留，不自动认定最新导入记录为当前价。/)).toBeVisible();
  await expect(page.locator('.ant-collapse .ant-table-row').first()).toBeVisible();
  await page.screenshot({path:'.local/api-acceptance/detail-history.png',fullPage:true});
  await page.locator('.ant-drawer-close').click();
  await page.getByRole('button',{name:/数据源/}).click();
  await expect(page.getByText('数据源与覆盖范围',{exact:true})).toBeVisible();
  await expect(page.locator('.ant-modal .ant-table-row')).toHaveCount(8);
  await page.getByRole('button',{name:/^关\s*闭$/}).click();
  await expect(page.getByText('数据源与覆盖范围',{exact:true})).toBeHidden();
  await page.locator('.dataset-bar .ant-select-selector').click();
  await page.getByText('历史资料 · 2026.09.26',{exact:true}).click();
  await expect(page.locator('.page-footer')).toContainText('2026.09.26');
  await expect(page.locator('.channel-name').first()).toBeVisible();
  expect(requests.some(url=>url.includes('/data/quotes-'))).toBe(false);
  if(snapshot){
    expect(requests.some(url=>url.includes('/published/')&&url.includes('/items-'))).toBe(true);
    expect(requests.some(url=>url.includes('/api/quotes/search'))).toBe(false);
  }else expect(requests.some(url=>/\/api\/quotes\/[^/]+\/history/.test(url))).toBe(true);
  expect(failures).toEqual([]);
});

test('mobile layout and a no-results search remain usable',async({page})=>{
  await page.setViewportSize({width:390,height:844}); await page.goto('./');
  await expect(page.locator('.channel-name').first()).toBeVisible({timeout:30000});
  await page.getByRole('textbox',{name:'仓库代码 / 邮编'}).fill('NO_SUCH_WAREHOUSE_999');
  await page.getByRole('button',{name:'搜索报价'}).click();
  // Unknown destination coverage may remain as pending candidates; exclude them explicitly.
  await page.getByRole('button',{name:'高级筛选'}).click();
  await page.getByRole('switch',{name:'保留待核候选'}).click();
  await page.getByRole('button',{name:'搜索报价'}).click();
  await expect(page.getByText('暂无匹配渠道，试试调整国家、货品或目的地')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await page.screenshot({path:'.local/api-acceptance/search-mobile.png',fullPage:true});
});
