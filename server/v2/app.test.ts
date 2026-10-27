import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from './app';
import { connectDatabase, migrate, type Database } from './database';
import { exampleOffers } from './examples';
import { getOffers, importPriceDrafts, publishRelease, saveDraft } from './repository';
import type { Offer, PricingRequest } from '../../src/domain/v2/pricing-contracts';

let db: Database;
let app: ReturnType<typeof createApp>;
const request: PricingRequest = {
  country: 'ES', origin: '', postalCode: '', warehouseCode: '', addressType: 'commercial', cargoAttributes: [],
  intellectualProperty: 'clear', modes: ['sea','rail','road','air'], asOf: '2026-10-26', measurementStage: 'estimated',
  packages: [], actualKg: '300', volumeCbm: '1', pieces: 10, includeExamples: true,
  trialBilling: { basis: 'kg', aggregation: 'shipment', volumetricDivisor: '6000', quantityStep: '1', dimensionStepCm: '0',
    minimumQuantity: '0', minimumPieceKg: '0', densityKgPerCbm: null, verified: true },
};
const publishable = (name: string): Offer => ({ ...structuredClone(exampleOffers[3]), id: name, channelId: name,
  providerId: 'test_supplier', providerName: '测试供应商', name, sourceKind: 'manual', reviewed: true, cargoReviewed: true,
  validFrom: '2026-10-01', origin: '深圳', scopeKey: 'door_duty_included', reviewReasons: [], billing: structuredClone(request.trialBilling!),
});

beforeAll(async () => {
  db = await connectDatabase({ memory: true }); await migrate(db);
  for (const offer of exampleOffers) await saveDraft(db, offer);
  app = createApp(db);
}, 30000);
afterAll(async () => { await app?.close(); await db?.close(); });

describe('PostgreSQL quotation V2 API', () => {
  it('migrates idempotently and preserves separate transport modes without login', async () => {
    await migrate(db);
    const response = await app.inject({ method: 'GET', url: '/api/v2/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().transportModes).toEqual(['sea', 'rail', 'road', 'air']);
    expect((await getOffers(db)).length).toBe(4);
  });
  it('calculates every candidate before ranking and saves an immutable result snapshot', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v2/quotes/calculate', payload: { request } });
    expect(response.statusCode).toBe(200);
    const run = response.json();
    expect(run.items.map((item: any) => item.total)).toEqual(['4250.00', '6050.00']);
    const page = await app.inject({ method: 'GET', url: `/api/v2/quotes/runs/${run.runId}?page=2&pageSize=1` });
    expect(page.json().items[0].total).toBe('6050.00'); expect(page.json().total).toBe(2);
    const recalc = await app.inject({ method: 'POST', url: '/api/v2/quotes/calculate', payload: {
      request: { ...request, actualKg: '350', measurementStage: 'warehouse' }, supersedes: run.runId,
    } });
    expect(recalc.statusCode).toBe(200); expect(recalc.json().items[0].total).toBe('4925.00');
    expect((await app.inject({ method: 'GET', url: `/api/v2/quotes/runs/${run.runId}` })).json().items[0].total).toBe('4250.00');
  });
  it('will not publish an example or an incomplete draft', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/v2/offers/${exampleOffers[0].id}/publish` })).statusCode).toBe(409);
    const offer = publishable('incomplete'); offer.billing.volumetricDivisor = null;
    await saveDraft(db, offer);
    await expect(publishRelease(db, offer.id)).rejects.toThrow('计费规则');
  });
  it('publishes a complete version and rejects changes to prices, rules and dates', async () => {
    const offer = publishable('immutable'); offer.billing = { ...request.trialBilling!, volumetricDivisor: '6000' };
    await saveDraft(db, offer); await publishRelease(db, offer.id);
    await expect(db.query('UPDATE quotation_v2.rate_tiers SET unit_price=1 WHERE release_id=$1', [offer.id])).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM quotation_v2.release_rules WHERE release_id=$1', [offer.id])).rejects.toThrow('immutable');
    await expect(db.query("UPDATE quotation_v2.channel_releases SET valid_from='2026-09-01' WHERE id=$1", [offer.id])).rejects.toThrow('immutable');
    expect(Number((await getOffers(db, { id: offer.id }))[0].tiers[0].unitPrice)).toBe(12.5);
  });
  it('rejects overlapping releases and overlapping price tiers', async () => {
    const offer = publishable('overlapping'); offer.channelId = 'immutable'; offer.billing = { ...request.trialBilling!, volumetricDivisor: '6000' };
    await saveDraft(db, offer);
    await expect(publishRelease(db, offer.id)).rejects.toThrow('Overlapping');
    const tiers = publishable('overlapping_tiers'); tiers.billing = { ...request.trialBilling!, volumetricDivisor: '6000' };
    tiers.tiers.push({ ...tiers.tiers[0], id: 'duplicate' });
    await saveDraft(db, tiers); await expect(publishRelease(db, tiers.id)).rejects.toThrow('档位重叠');
  });
  it('rejects cross-provider channel assignment and invalid user inputs', async () => {
    const offer = publishable('wrong_provider'); offer.channelId = exampleOffers[0].channelId;
    await expect(saveDraft(db, offer)).rejects.toThrow('渠道身份');
    expect((await app.inject({ method: 'POST', url: '/api/v2/quotes/calculate', payload: { request: { ...request, actualKg: -1 } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v2/quotes/runs/missing' })).statusCode).toBe(404);
  });
  it('preserves split source notes, source cells and draft identities on repeated imports', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quotation-v2-test-'));
    try {
      const sourceId = 'a'.repeat(64);
      await db.query(`INSERT INTO quotation_v2.source_files(id,sha256,original_name,byte_size,storage_path,evidence_path,extraction_status,metadata)
        VALUES($1,$1,'test.xlsx',1,'private/original','private/evidence','extracted','{}')`, [sourceId]);
      await writeFile(join(directory, 'catalog.json'), JSON.stringify({ version: 'test', files: [{ id: 'legacy', sha256: sourceId }], chunks: [{ path: 'quotes.json', rulesPath: 'rules.json' }] }));
      await writeFile(join(directory, 'quotes.json'), JSON.stringify([{ id: 'q1', source: { fileId: 'legacy', sheet: '海运', cells: ['C12'] },
        providerName: '测试', channelName: '海运', countryCode: 'DE', mode: 'sea', notes: [], ruleRef: 'r1' }]));
      await writeFile(join(directory, 'rules.json'), JSON.stringify({ r1: ['A32：私人地址 +1/kg；按计费重。'] }));
      await importPriceDrafts(db, directory);
      expect((await importPriceDrafts(db, directory)).reused).toBe(true);
      const response = await app.inject({ method: 'GET', url: `/api/v2/sources/${sourceId}/drafts` });
      expect(response.json().total).toBe(1);
      expect(response.json().items[0].proposed_data.notes).toEqual(['A32：私人地址 +1/kg；按计费重。']);
      expect(response.json().items[0].proposed_data.source.cells).toEqual(['C12']);
      const sources = await app.inject({ method: 'GET', url: '/api/v2/sources' });
      expect(sources.body).not.toContain('private/');
    } finally {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory');
      await rm(directory, { recursive: true, force: true });
    }
  });
});
