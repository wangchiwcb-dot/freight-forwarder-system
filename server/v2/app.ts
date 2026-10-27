import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { createReadStream } from 'node:fs';
import { calculateOffers } from '../../src/domain/v2/pricing';
import { id, offerSchema, requestSchema } from '../../src/domain/v2/pricing-contracts';
import type { Database } from './database';
import { getOffers, loadRun, publicationIssues, publishRelease, saveDraft, saveRun } from './repository';
import { getPriceDraft, prepareOffer, readiness, searchDrafts } from './review';
import { transportModeSchema } from '../../src/domain/v2/contracts';
import { comparisonInputSchema } from '../../src/domain/v2/comparison-contracts';
import { createComparison, loadComparison } from './comparison';

export function createApp(db: Database) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '输入资料或规则格式有误', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) } });
    const status = typeof (error as any).statusCode === 'number' ? (error as any).statusCode : 500;
    if (status >= 500) console.error('v2 request failed', request.id, error);
    return reply.code(status).send({ error: { code: status >= 500 ? 'SERVER_ERROR' : 'REQUEST_ERROR', message: status >= 500 ? '服务暂时无法完成请求，请重试或检查服务日志' : (error as Error).message } });
  });
  app.get('/api/v2/health', async () => {
    await db.query('SELECT name FROM quotation_v2.schema_migrations');
    return { ok: true, authentication: 'none', transportModes: ['sea', 'rail', 'road', 'air'] };
  });
  app.post('/api/v2/comparisons', async (request,reply) => {
    const input=comparisonInputSchema.parse(request.body);
    if(input.supersedes&&!(await loadComparison(db,input.supersedes))) return reply.code(404).send({error:{message:'原比价记录不存在'}});
    return loadComparison(db,await createComparison(db,input));
  });
  app.get('/api/v2/comparisons/:id', async (request,reply) => {
    const query=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(50).default(15),showUnavailable:z.enum(['true','false']).default('false')}).strict().parse(request.query);
    return await loadComparison(db,id.parse((request.params as any).id),query.page,query.pageSize,query.showUnavailable==='true')??reply.code(404).send({error:{message:'比价记录不存在'}});
  });
  app.get('/api/v2/offers', async () => ({ items: await getOffers(db) }));
  app.get('/api/v2/readiness', async () => readiness(db));
  app.get('/api/v2/price-drafts', async request => searchDrafts(db, request.query));
  app.get('/api/v2/price-drafts/:id', async (request, reply) => {
    const draft = await getPriceDraft(db, id.parse((request.params as any).id));
    return draft ?? reply.code(404).send({ error: { message: '价格草稿不存在' } });
  });
  app.post('/api/v2/price-drafts/:id/prepare', async (request, reply) => {
    const draft = await getPriceDraft(db, id.parse((request.params as any).id));
    if (!draft) return reply.code(404).send({ error: { message: '价格草稿不存在' } });
    const selection = z.object({ mode: transportModeSchema, country: z.string().regex(/^[A-Z]{2}$/) }).strict().parse(request.body);
    try { const offer = prepareOffer(draft, selection); return { offer, issues: publicationIssues(offer) }; }
    catch (error) { return reply.code(409).send({ error: { message: (error as Error).message } }); }
  });
  app.get('/api/v2/review/offers', async () => ({ items: (await getOffers(db)).filter(offer => offer.sourceKind !== 'example').map(offer => ({ offer, issues: publicationIssues(offer) })) }));
  app.post('/api/v2/review/offers', async (request, reply) => {
    const body = z.object({ offer: offerSchema, sourceDraftId: id.nullable().default(null) }).strict().parse(request.body);
    try { const offer = await saveDraft(db, body.offer, body.sourceDraftId); return { offer, issues: publicationIssues(offer) }; }
    catch (error) { return reply.code(409).send({ error: { message: (error as Error).message } }); }
  });
  app.post('/api/v2/review/preview', async request => {
    const body = z.object({ offer: offerSchema, request: requestSchema }).strict().parse(request.body);
    return { items: calculateOffers([{ ...body.offer, status: 'draft' }], body.request) };
  });
  app.get('/api/v2/sources/:id/download', async (request, reply) => {
    const source = (await db.query<{ storage_path: string; original_name: string }>('SELECT storage_path,original_name FROM quotation_v2.source_files WHERE id=$1', [id.parse((request.params as any).id)])).rows[0];
    if (!source) return reply.code(404).send({ error: { message: '原件不存在' } });
    reply.header('Content-Disposition', `attachment; filename="quotation-original"; filename*=UTF-8''${encodeURIComponent(source.original_name)}`);
    return reply.type('application/octet-stream').send(createReadStream(source.storage_path));
  });
  app.get('/api/v2/sources', async () => {
    const rows = (await db.query(`SELECT id,original_name AS name,byte_size::text AS bytes,extraction_status AS status,
      coalesce(metadata->>'cells','0') AS cells,
      coalesce(jsonb_array_length(metadata->'sheets'),0) AS sheets,
      coalesce(jsonb_array_length(metadata->'pages'),0) AS pages,
      'needs_review' AS pricing_readiness,
      (SELECT count(*)::int FROM quotation_v2.price_drafts d WHERE d.source_id=source_files.id) AS price_drafts
      FROM quotation_v2.source_files ORDER BY original_name`)).rows;
    return { items: rows };
  });
  app.get('/api/v2/sources/:id/drafts', async (request) => {
    const sourceId = id.parse((request.params as any).id);
    const query = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).strict().parse(request.query);
    const total = (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM quotation_v2.price_drafts WHERE source_id=$1', [sourceId])).rows[0].count;
    const items = (await db.query(`SELECT d.id,d.provider_hint,d.channel_hint,d.country_hint,d.mode_hint,d.status,
      d.proposed_data || jsonb_build_object('notes',coalesce(n.notes,d.proposed_data->'notes','[]'::jsonb)) AS proposed_data
      FROM quotation_v2.price_drafts d LEFT JOIN quotation_v2.draft_note_sets n ON n.id=d.note_set_id
      WHERE d.source_id=$1 ORDER BY d.id LIMIT $2 OFFSET $3`, [sourceId, query.pageSize, (query.page - 1) * query.pageSize])).rows;
    return { items, total, ...query };
  });
  app.post('/api/v2/quotes/calculate', async (request, reply) => {
    const body = z.object({ request: requestSchema, supersedes: id.nullable().default(null) }).strict().parse(request.body);
    if (body.supersedes && !(await loadRun(db, body.supersedes))) return reply.code(404).send({ error: { message: '原试算记录不存在' } });
    const offers = await getOffers(db, { country: body.request.country, modes: body.request.modes });
    const results = calculateOffers(offers, body.request);
    const runId = await saveRun(db, body.request, results, body.supersedes);
    return { runId, engineVersion: (await loadRun(db, runId))!.engine_version, items: results, total: results.length };
  });
  app.get('/api/v2/quotes/runs/:id', async (request, reply) => {
    const runId = id.parse((request.params as any).id);
    const query = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).strict().parse(request.query);
    const run = await loadRun(db, runId, query.page, query.pageSize);
    return run ?? reply.code(404).send({ error: { message: '试算记录不存在' } });
  });
  app.post('/api/v2/offers', async (request, reply) => {
    const offer = offerSchema.parse(request.body);
    try { return await saveDraft(db, offer); }
    catch (error) { return reply.code(409).send({ error: { message: (error as Error).message.startsWith('duplicate') ? '版本冲突' : (error as Error).message } }); }
  });
  app.post('/api/v2/offers/:id/publish', async (request, reply) => {
    const releaseId = id.parse((request.params as any).id);
    try { return await publishRelease(db, releaseId); }
    catch (error) { return reply.code(409).send({ error: { message: (error as Error).message } }); }
  });
  return app;
}
