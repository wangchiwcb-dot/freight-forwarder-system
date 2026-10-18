import { z } from 'zod';
import { idSchema, searchSchema } from '../src/api/contracts';
import { ApiError, type Database } from './db';
import { getCatalog, getHistory, requireQuote } from './repository';
import { search } from './search';

export interface Env { DB: Database; ASSETS?: { fetch(request: Request): Promise<Response> }; }
const corsOrigin = 'https://wangchiwcb-dot.github.io';
const pagination = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(15) }).strict();
const querySchema = z.object({ snapshotId: idSchema.optional() }).strict();

async function jsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.split(';')[0].trim().match(/^application\/json$/i))
    throw new ApiError(415,'UNSUPPORTED_MEDIA_TYPE','请使用 application/json');
  // Stream limit also applies to chunked requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400,'INVALID_JSON','请求内容不能为空');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 16_384) { await reader.cancel(); throw new ApiError(413,'BODY_TOO_LARGE','查询条件超过大小限制'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400,'INVALID_JSON','JSON 格式无效'); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/'))
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found',{ status:404 });
    const requestId = crypto.randomUUID();
    const headers = new Headers({ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff', 'X-Request-Id':requestId, 'Vary':'Origin' });
    if (request.headers.get('origin') === corsOrigin) headers.set('Access-Control-Allow-Origin',corsOrigin);
    const reply = (data: unknown, status=200) => new Response(JSON.stringify(data),{status,headers});
    try {
      if (request.method === 'OPTIONS') {
        headers.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');
        headers.set('Access-Control-Allow-Headers','Content-Type');
        headers.set('Access-Control-Max-Age','600');
        return new Response(null,{status:204,headers});
      }
      const path = url.pathname;
      const detail = /^\/api\/quotes\/([^/]+)(\/history)?$/.exec(path);
      const known = ['/api/health','/api/catalog','/api/sources','/api/quotes/search'].includes(path) || detail;
      if (!known) throw new ApiError(404,'NOT_FOUND','接口不存在');
      const method = path === '/api/quotes/search' ? 'POST' : 'GET';
      if (request.method !== method) { headers.set('Allow',`${method}, OPTIONS`); throw new ApiError(405,'METHOD_NOT_ALLOWED','此接口不支持该请求方法'); }
      if (new Set(url.searchParams.keys()).size !== [...url.searchParams].length)
        throw new ApiError(400,'INVALID_QUERY','查询参数不能重复');
      const params = Object.fromEntries(url.searchParams);
      if (path === '/api/health') {
        z.object({}).strict().parse(params);
        await env.DB.prepare('SELECT 1').first();
        return reply({ status:'ok', database:'ok', apiVersion:'1' });
      }
      if (path === '/api/catalog' || path === '/api/sources') {
        const { snapshotId } = querySchema.parse(params);
        const catalog = await getCatalog(env.DB,snapshotId);
        return reply(path === '/api/catalog' ? catalog : { items:catalog.files,snapshotId:catalog.snapshotId });
      }
      if (path === '/api/quotes/search') {
        z.object({}).strict().parse(params);
        return reply(await search(env.DB,searchSchema.parse(await jsonBody(request))));
      }
      if (detail) {
        const id = idSchema.parse(detail[1]);
        if (detail[2]) {
          const { page, pageSize } = pagination.parse(params);
          return reply(await getHistory(env.DB,id,page,pageSize));
        }
        z.object({}).strict().parse(params);
        return reply(await requireQuote(env.DB,id));
      }
      throw new ApiError(404,'NOT_FOUND','接口不存在');
    } catch (error) {
      if (error instanceof z.ZodError) return reply({ error:{ code:'VALIDATION_ERROR',message:'请求参数无效',
        details:error.issues.map(issue => ({ path:issue.path.join('.'),message:issue.message })),requestId } },400);
      if (error instanceof ApiError) return reply({ error:{ code:error.code,message:error.message,requestId } },error.status);
      console.error(JSON.stringify({ requestId,message:error instanceof Error ? error.message : 'Unknown error' }));
      return reply({ error:{ code:'INTERNAL_ERROR',message:'报价服务暂时不可用，请稍后重试',requestId } },503);
    }
  },
};
