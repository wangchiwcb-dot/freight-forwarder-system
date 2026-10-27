import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import Decimal from 'decimal.js';
import { offerSchema, type Offer, type PricingRequest, type QuoteResult } from '../../src/domain/v2/pricing-contracts';
import { ENGINE_VERSION } from '../../src/domain/v2/pricing';
import type { Database } from './database';

const json = (value: unknown) => JSON.stringify(value);
export async function saveDraft(db: Database, raw: unknown, sourceDraftId: string | null = null): Promise<Offer> {
  const offer = offerSchema.parse(raw);
  if (offer.status !== 'draft') throw new Error('请先保存草稿，再单独发布');
  if (new Set(offer.rules.map(rule => rule.id)).size !== offer.rules.length || offer.rules.some(rule => rule.id === 'base')) throw new Error('规则编号重复或使用了保留编号');
  await db.transaction(async tx => {
    if (sourceDraftId) {
      const source = (await tx.query<{ source_id: string }>('SELECT source_id FROM quotation_v2.price_drafts WHERE id=$1', [sourceDraftId])).rows[0];
      if (!source || !offer.sourceEvidence.some(evidence => evidence.sourceId === source.source_id)) throw new Error('规则草稿必须保留所选价格草稿的原件关联');
    }
    // Existing identities never change ownership because of a pasted/imported quote.
    await tx.query('INSERT INTO quotation_v2.providers(id,name,is_own) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [offer.providerId, offer.providerName, offer.isOwn]);
    const provider = (await tx.query<{ is_own: boolean }>('SELECT is_own FROM quotation_v2.providers WHERE id=$1', [offer.providerId])).rows[0];
    if (provider.is_own !== offer.isOwn) throw new Error('供应商自有/代理身份冲突');
    await tx.query('INSERT INTO quotation_v2.channels(id,provider_id,name,mode,last_mile) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
      [offer.channelId, offer.providerId, offer.name, offer.mode, offer.lastMile]);
    const channel = (await tx.query<{ provider_id: string; mode: string; last_mile: string }>('SELECT provider_id,mode,last_mile FROM quotation_v2.channels WHERE id=$1 FOR UPDATE', [offer.channelId])).rows[0];
    if (channel.provider_id !== offer.providerId || channel.mode !== offer.mode || channel.last_mile !== offer.lastMile) throw new Error('渠道身份或运输方式冲突');
    if ((await tx.query('SELECT id FROM quotation_v2.channel_releases WHERE id=$1', [offer.id])).rows.length) throw new Error('版本编号已存在；修改请创建新版本');
    const revision = (await tx.query<{ next: number }>('SELECT coalesce(max(revision),0)+1 AS next FROM quotation_v2.channel_releases WHERE channel_id=$1', [offer.channelId])).rows[0].next;
    await tx.query(`INSERT INTO quotation_v2.channel_releases
      (id,channel_id,provider_id,revision,name,country,origin,scope_key,service_description,currency,cost_basis,status,source_kind,
       valid_from,valid_to,reviewed,cargo_reviewed,accepted_attributes,review_reasons,billing,notes,transit_text)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [offer.id, offer.channelId, offer.providerId, revision, offer.name, offer.country, offer.origin, offer.scopeKey,
        offer.serviceDescription, offer.currency, offer.costBasis, 'draft', offer.sourceKind, offer.validFrom, offer.validTo,
        offer.reviewed, offer.cargoReviewed, json(offer.acceptedAttributes), json(offer.reviewReasons), json(offer.billing), json(offer.notes), offer.transitText]);
    for (const target of offer.targets) await tx.query('INSERT INTO quotation_v2.release_targets VALUES($1,$2,$3)', [offer.id, target.kind, target.value]);
    for (const tier of offer.tiers) await tx.query('INSERT INTO quotation_v2.rate_tiers VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [offer.id, tier.id, tier.min, tier.max, tier.minInclusive, tier.maxInclusive, tier.unitPrice, tier.status]);
    for (const [index, rule] of offer.rules.entries()) await tx.query('INSERT INTO quotation_v2.release_rules VALUES($1,$2,$3,$4)', [offer.id, rule.id, index, json(rule)]);
    for (const evidence of offer.sourceEvidence) await tx.query('INSERT INTO quotation_v2.source_evidence(id,release_id,source_id,sheet,cells,evidence_text) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), offer.id, evidence.sourceId, evidence.sheet, json(evidence.cells), evidence.text]);
    await tx.query('INSERT INTO quotation_v2.audit_logs(action,entity_id,detail) VALUES($1,$2,$3)', ['draft_created', offer.id, json({ revision })]);
    if (sourceDraftId) {
      await tx.query('INSERT INTO quotation_v2.draft_release_links(price_draft_id,release_id) VALUES($1,$2)', [sourceDraftId, offer.id]);
      await tx.query("UPDATE quotation_v2.price_drafts SET status='mapped' WHERE id=$1", [sourceDraftId]);
    }
  });
  return offer;
}

export async function getOffers(db: Database, filters: { country?: string; modes?: string[]; id?: string } = {}): Promise<Offer[]> {
  const args: unknown[] = [];
  const where = ['c.active=true', 'p.active=true'];
  if (filters.country) { args.push(filters.country); where.push(`r.country=$${args.length}`); }
  if (filters.modes) { args.push(filters.modes); where.push(`c.mode=ANY($${args.length}::text[])`); }
  if (filters.id) { args.push(filters.id); where.push(`r.id=$${args.length}`); }
  const { rows } = await db.query<Record<string, any>>(`SELECT r.*,to_char(r.valid_from,'YYYY-MM-DD') AS starts,to_char(r.valid_to,'YYYY-MM-DD') AS ends,
    p.name AS provider_name,p.is_own,c.mode,c.last_mile,
    coalesce((SELECT jsonb_agg(jsonb_build_object('kind',t.kind,'value',t.value)) FROM quotation_v2.release_targets t WHERE t.release_id=r.id),'[]'::jsonb) AS targets,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'min',t.min_quantity::text,'max',t.max_quantity::text,
      'minInclusive',t.min_inclusive,'maxInclusive',t.max_inclusive,'unitPrice',t.unit_price::text,'status',t.price_status) ORDER BY t.min_quantity,t.id)
      FROM quotation_v2.rate_tiers t WHERE t.release_id=r.id),'[]'::jsonb) AS tiers,
    coalesce((SELECT jsonb_agg(t.definition ORDER BY t.ordinal) FROM quotation_v2.release_rules t WHERE t.release_id=r.id),'[]'::jsonb) AS rules,
    coalesce((SELECT jsonb_agg(jsonb_build_object('sourceId',e.source_id,'sheet',e.sheet,'cells',e.cells,'text',e.evidence_text) ORDER BY e.id)
      FROM quotation_v2.source_evidence e WHERE e.release_id=r.id),'[]'::jsonb) AS evidence
    FROM quotation_v2.channel_releases r JOIN quotation_v2.channels c ON c.id=r.channel_id JOIN quotation_v2.providers p ON p.id=r.provider_id
    WHERE ${where.join(' AND ')} ORDER BY r.id`, args);
  return rows.map(row => offerSchema.parse({ id: row.id, providerId: row.provider_id, providerName: row.provider_name,
    isOwn: row.is_own, channelId: row.channel_id, name: row.name, mode: row.mode, lastMile: row.last_mile,
    country: row.country, origin: row.origin, targets: row.targets, scopeKey: row.scope_key,
    serviceDescription: row.service_description, currency: row.currency, costBasis: row.cost_basis,
    status: row.status, sourceKind: row.source_kind, validFrom: row.starts, validTo: row.ends,
    reviewed: row.reviewed, cargoReviewed: row.cargo_reviewed, acceptedAttributes: row.accepted_attributes,
    reviewReasons: row.review_reasons, billing: row.billing, tiers: row.tiers, rules: row.rules, notes: row.notes, transitText: row.transit_text,
    sourceEvidence: row.evidence }));
}

export function publicationIssues(offer: Offer): string[] {
  const issues: string[] = [];
  if (offer.sourceKind === 'example') issues.push('示例不得作为正式渠道发布');
  if (offer.sourceKind === 'workbook' && !offer.sourceEvidence.some(evidence => evidence.sourceId && evidence.sheet && evidence.cells.length)) issues.push('缺少原表与价格单元格关联');
  if (!offer.reviewed || !offer.cargoReviewed || offer.reviewReasons.length) issues.push('收费及承运复核未完成');
  if (!offer.origin || !offer.scopeKey || !offer.validFrom) issues.push('缺少交仓点、比较口径或生效日期');
  if (!['supplier_purchase', 'internal_settlement'].includes(offer.costBasis)) issues.push('必须为采购成本价');
  if (!offer.billing.verified || offer.billing.quantityStep === null || offer.billing.dimensionStepCm === null ||
    (offer.billing.basis === 'kg' && !offer.billing.volumetricDivisor)) issues.push('计费规则未补齐');
  if (offer.billing.aggregation === 'shipment' && new Decimal(offer.billing.minimumPieceKg).gt(0) &&
    offer.billing.minimumPieceApplication !== 'actual_before_shipment_max') issues.push('单箱最低计费与整票取大的计算顺序尚未核实');
  if (offer.billing.basis !== 'kg' && new Decimal(offer.billing.minimumPieceKg).gt(0)) issues.push('按方运费的单件最低公斤计费暂不支持');
  if (offer.billing.basis === 'cbm' && offer.billing.aggregation === 'piece') issues.push('按方逐件计费暂不支持');
  if (offer.billing.volumeStepCbm === null) issues.push('整票体积进位规则未补齐');
  if (offer.billing.aggregation === 'piece' && new Decimal(offer.billing.volumeStepCbm ?? '0').gt(0)) issues.push('整票体积进位与逐箱取大的组合尚需核实');
  for (const [index, tier] of offer.tiers.entries()) {
    if ((tier.status === 'priced') !== (tier.unitPrice !== null)) issues.push('档位价格状态冲突');
    for (const other of offer.tiers.slice(index + 1)) {
      const before = tier.max !== null && (new Decimal(tier.max).lt(other.min) || new Decimal(tier.max).eq(other.min) && !(tier.maxInclusive && other.minInclusive));
      const after = other.max !== null && (new Decimal(other.max).lt(tier.min) || new Decimal(other.max).eq(tier.min) && !(other.maxInclusive && tier.minInclusive));
      if (!before && !after) issues.push('价格档位重叠');
    }
  }
  const known = new Set(['base']);
  const pending = offer.rules.filter(rule => rule.kind === 'fee');
  while (pending.length) {
    const index = pending.findIndex(rule => rule.basis !== 'percentage' || rule.percentBase.length > 0 && rule.percentBase.every(ref => known.has(ref)));
    if (index < 0) { issues.push('百分比费用引用缺失或循环'); break; }
    const rule = pending.splice(index, 1)[0]; known.add(rule.id);
    if (rule.scope === 'package' && ['chargeable_quantity','chargeable_kg','chargeable_cbm'].includes(rule.basis)) issues.push(`${rule.label}逐箱计费量附加费暂不支持`);
    if (rule.basis === 'chargeable_kg' && offer.billing.basis !== 'kg' || rule.basis === 'chargeable_cbm' && offer.billing.basis !== 'cbm') issues.push(`${rule.label}与基础运费单位不一致，需核实独立计费量`);
    if (rule.inclusion === 'unknown' || rule.inclusion === 'additional' && rule.rate === null) issues.push(`${rule.label}待核`);
    if (rule.minimum !== null && rule.maximum !== null && new Decimal(rule.minimum).gt(rule.maximum)) issues.push(`${rule.label}最低额超过最高额`);
  }
  return [...new Set(issues)];
}

export async function publishRelease(db: Database, id: string) {
  return db.transaction(async tx => {
    await tx.query('SELECT id FROM quotation_v2.channel_releases WHERE id=$1 FOR UPDATE', [id]);
    const offer = (await getOffers(tx, { id }))[0];
    if (!offer || offer.status !== 'draft') throw new Error('找不到可发布草稿');
    const issues = publicationIssues(offer);
    if (issues.length) throw new Error(issues.join('；'));
    await tx.query("UPDATE quotation_v2.channel_releases SET status='published',published_at=now() WHERE id=$1", [id]);
    await tx.query('INSERT INTO quotation_v2.audit_logs(action,entity_id,detail) VALUES($1,$2,$3)', ['published', id, '{}']);
    return { id, status: 'published' };
  });
}

export async function saveRun(db: Database, request: PricingRequest, results: QuoteResult[], supersedes: string | null = null) {
  const id = randomUUID();
  await db.transaction(async tx => {
    await tx.query('INSERT INTO quotation_v2.quote_runs(id,request,engine_version,supersedes) VALUES($1,$2,$3,$4)', [id, json(request), ENGINE_VERSION, supersedes]);
    for (const [ordinal, result] of results.entries()) await tx.query('INSERT INTO quotation_v2.quote_run_items VALUES($1,$2,$3,$4)', [id, ordinal, result.offer.id, json(result)]);
  });
  return id;
}
export async function loadRun(db: Database, id: string, page = 1, pageSize = 20) {
  const run = (await db.query<{ id: string; request: PricingRequest; engine_version: string; created_at: string; supersedes: string | null }>('SELECT id,request,engine_version,created_at,supersedes FROM quotation_v2.quote_runs WHERE id=$1', [id])).rows[0];
  if (!run) return null;
  const count = (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM quotation_v2.quote_run_items WHERE run_id=$1', [id])).rows[0].count;
  const rows = (await db.query<{ result: QuoteResult }>('SELECT result FROM quotation_v2.quote_run_items WHERE run_id=$1 ORDER BY ordinal LIMIT $2 OFFSET $3', [id, pageSize, (page - 1) * pageSize])).rows;
  return { ...run, items: rows.map(row => row.result), total: count, page, pageSize };
}

export async function importManifest(db: Database, manifestPath: string) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('不支持的来源清单');
  const hash = createHash('sha256').update(json(manifest.files.map((file: any) => [file.sha256, file.name]).sort())).digest('hex');
  return db.transaction(async tx => {
    if ((await tx.query('SELECT id FROM quotation_v2.import_batches WHERE manifest_hash=$1', [hash])).rows.length) return { imported: 0, reused: true };
    await tx.query('INSERT INTO quotation_v2.import_batches(id,manifest_hash,source_count,status) VALUES($1,$2,$3,$4)', [hash, hash, manifest.files.length, 'staged']);
    for (const file of manifest.files) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || !['.xlsx','.xls','.xlsm','.pdf'].includes(extname(file.name).toLowerCase())) throw new Error('来源摘要或文件类型无效');
      const archivePath = resolve(dirname(manifestPath), file.sha256, 'original' + extname(file.name).toLowerCase());
      const evidencePath = resolve(dirname(manifestPath), file.sha256, 'evidence.jsonl.gz');
      const archiveHash = createHash('sha256');
      for await (const block of createReadStream(archivePath)) archiveHash.update(block);
      if (archiveHash.digest('hex') !== file.sha256) throw new Error(`原件归档校验失败：${file.name}`);
      await tx.query(`INSERT INTO quotation_v2.source_files(id,sha256,original_name,byte_size,storage_path,evidence_path,extraction_status,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(sha256) DO NOTHING`,
        [file.sha256, file.sha256, file.name, file.size_bytes, archivePath, evidencePath, file.status, json(file)]);
      await tx.query('INSERT INTO quotation_v2.import_batch_sources VALUES($1,$2,$3)', [hash, file.sha256, file.name]);
      await tx.query('INSERT INTO quotation_v2.review_tasks(id,source_id,code,detail) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
        [`source_${file.sha256}`, file.sha256, 'channel_mapping', '原件与来源证据已归档，待核对代理、渠道、价格档位及费用规则；未自动发布。']);
    }
    return { imported: manifest.files.length, reused: false };
  });
}

export async function importPriceDrafts(db: Database, directory: string) {
  const catalog = JSON.parse(await readFile(resolve(directory, 'catalog.json'), 'utf8'));
  const parserVersion = 'initial-adapter/2';
  const importId = createHash('sha256').update(`${catalog.version}:${parserVersion}`).digest('hex');
  const existing = (await db.query<{ row_count: number }>('SELECT row_count FROM quotation_v2.price_draft_imports WHERE id=$1', [importId])).rows[0];
  if (existing) return { inspected: existing.row_count, reused: true, readiness: 'needs_review' };
  const files = new Map<string, string>(catalog.files.map((file: any) => [file.id, file.sha256]));
  let count = 0;
  await db.transaction(async tx => {
    const noteIds = new Set<string>();
    for (const chunk of catalog.chunks) {
      const quotes = JSON.parse(await readFile(resolve(directory, chunk.path), 'utf8'));
      const rules = chunk.rulesPath ? JSON.parse(await readFile(resolve(directory, chunk.rulesPath), 'utf8')) : {};
      for (const quote of quotes) {
        const sourceId = files.get(quote.source.fileId);
        if (!sourceId) throw new Error('标准化报价缺少对应原件摘要');
        if (quote.ruleRef && !Array.isArray(rules[quote.ruleRef])) throw new Error('标准化报价缺少原备注分片');
        const notes = quote.ruleRef ? rules[quote.ruleRef] : quote.notes ?? [];
        const noteId = createHash('sha256').update(json(notes)).digest('hex');
        if (!noteIds.has(noteId)) {
          await tx.query('INSERT INTO quotation_v2.draft_note_sets(id,notes) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [noteId, json(notes)]);
          noteIds.add(noteId);
        }
        // Keep the original draft identity when correcting its parser output.
        const draftId = createHash('sha256').update(`${sourceId}:${quote.id}:initial-adapter/1`).digest('hex');
        await tx.query(`INSERT INTO quotation_v2.price_drafts(id,source_id,source_quote_id,parser_version,provider_hint,channel_hint,country_hint,mode_hint,proposed_data,note_set_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET
            proposed_data=EXCLUDED.proposed_data,note_set_id=EXCLUDED.note_set_id,parser_version=EXCLUDED.parser_version
          WHERE price_drafts.status='needs_review'`,
          [draftId, sourceId, quote.id, parserVersion, quote.providerName, quote.channelName, quote.countryCode, quote.mode, json({ ...quote, notes: [] }), noteId]);
        count++;
      }
    }
    await tx.query('INSERT INTO quotation_v2.price_draft_imports(id,parser_version,row_count) VALUES($1,$2,$3)', [importId, parserVersion, count]);
  });
  return { inspected: count, readiness: 'needs_review' };
}
