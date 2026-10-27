import { access } from 'node:fs/promises';
import { createApp } from './app';
import { connectDatabase, migrate } from './database';
import { exampleOffers } from './examples';
import { getOffers, importManifest, importPriceDrafts, saveDraft } from './repository';
import { prepareOwnUs } from './own-us';

const importOnly=process.env.V2_IMPORT_ONLY==='true';
if(importOnly && (!process.env.V2_IMPORT_MANIFEST || !process.env.V2_PRICE_DRAFTS)) throw new Error('导入需要同时指定原件清单和解析价格目录');
const db = await connectDatabase({ url: process.env.DATABASE_URL, localPath: process.env.V2_DATA_DIR });
await migrate(db);
if (!importOnly && process.env.V2_SEED_EXAMPLES === 'true') {
  for (const offer of exampleOffers) if (!(await getOffers(db, { id: offer.id })).length) await saveDraft(db, offer);
}
if (process.env.V2_IMPORT_MANIFEST) {
  await access(process.env.V2_IMPORT_MANIFEST);
  console.log('Source intake:', await importManifest(db, process.env.V2_IMPORT_MANIFEST));
}
if (process.env.V2_PRICE_DRAFTS) console.log('Price drafts:', await importPriceDrafts(db, process.env.V2_PRICE_DRAFTS));
if(importOnly) {
  await db.close();
  console.log('新原表已导入待生效区；请在“每周报价更新”中预览并确认生效日期。');
} else {
if (process.env.V2_PREPARE_OWN_US === 'true') console.log('Own US rule drafts:', await prepareOwnUs(db));
const app = createApp(db);
await app.listen({ host: process.env.V2_HOST ?? '127.0.0.1', port: Number(process.env.V2_PORT ?? '8790') });
console.log('Quotation V2 API listening:', app.server.address());
const shutdown = async () => { await app.close(); await db.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
}
