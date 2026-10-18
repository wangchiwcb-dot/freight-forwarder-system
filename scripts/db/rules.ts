import crypto from 'node:crypto';
import Decimal from 'decimal.js';
import type { Quote, CargoType } from '../../src/domain/types.ts';

export const MIGRATION_PARSER_VERSION = 'history-migration/1';
export const digest = (value: unknown): string => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const idFor = (kind: string, value: unknown): string => `${kind}_${digest(value).slice(0, 32)}`;

export function money(value: number | null | undefined) {
  if (value == null) return { micros: null, decimal: null };
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid monetary amount: ${value}`);
  const exact = new Decimal(value);
  const scaled = exact.mul(1_000_000).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  if (scaled.gt(Number.MAX_SAFE_INTEGER)) throw new Error('Money exceeds safe integer range');
  return { micros: scaled.toNumber(), decimal: exact.toString() };
}

export function taxTerms(title: string) {
  // Only the row/channel-specific title is used. Page-wide notes can describe
  // multiple competing products and must never assign tax treatment to every row.
  const excluded = /不包税|不含税|未含税|税费另计|税金另计/.test(title);
  const withoutNegative = title.replace(/不包税|不含税|未含税|非包税/g, '');
  const included = /包税|含税/.test(withoutNegative);
  const duty = /不含关税|关税另计/.test(title) ? 'excluded' : /含关税|关税已含/.test(title) ? 'included' : 'unknown';
  const vat = /(?:不含|未含)\s*VAT|VAT\s*(?:不含|另计)/i.test(title) ? 'excluded'
    : /(?:含|包含)\s*VAT|VAT\s*已含/i.test(title) ? 'included' : 'unknown';
  let mode = excluded && included ? 'unknown' : excluded ? 'excluded' : included ? 'included' : 'unknown';
  if ((duty === 'included' && vat === 'excluded') || (duty === 'excluded' && vat === 'included')) mode = 'partial';
  if (included && (duty === 'excluded' || vat === 'excluded')) mode = 'partial';
  if (mode === 'included' && /限|除外|仅|条件/.test(title)) mode = 'conditional';
  return { mode, duty, vat, settlement: /递延/.test(title) ? 'deferred' : /自税/.test(title) ? 'customer_tax' : 'unknown',
    evidence: title, conflict: excluded && included };
}

const cargoPatterns: Partial<Record<CargoType, string>> = {
  general: '普货', battery: '带电', magnetic: '带磁', pure_battery: '纯电',
  liquid: '液体', powder: '粉末', sensitive: '敏感|特货|杂货',
};
export function cargoRules(quote: Quote) {
  const title = quote.channelName;
  const types = new Set<CargoType>(quote.cargoTypes);
  for (const [type, token] of Object.entries(cargoPatterns)) {
    if (new RegExp(token).test(title)) types.add(type as CargoType);
  }
  return [...types].sort().map(type => {
    const token = cargoPatterns[type];
    const negative = !!token && new RegExp(`(?:不(?:接|收|可接|可收)?|禁(?:收|运)?|不可|不能|拒收)(?:[^，,；;。/·]{0,6})?(?:${token})`).test(title);
    const explicit = !!token && new RegExp(token).test(title) && !negative;
    const conditional = explicit && /需|仅|限|提供|鉴定/.test(title);
    return { type, acceptance: negative ? 'forbidden' : conditional ? 'conditional' : explicit ? 'allowed' : 'unknown',
      evidenceKind: negative || explicit ? 'explicit' : quote.cargoCertainty === 'unknown' ? 'unknown' : 'inferred',
      evidence: title, conditions: conditional ? ['原表有承运条件，需核验后才可判定适用'] : [] };
  });
}

export function itemIdentity(quote: Quote, taxMode: string) {
  // Never use workbook IDs or coordinates as a business identity. Destination
  // group changes remain provisional until a human confirms the group mapping.
  return {
    provider: quote.providerId, channel: quote.channelName.normalize('NFKC').trim(), mode: quote.mode,
    country: quote.countryCode, origin: quote.origin.normalize('NFKC').trim(),
    destination: quote.destinationLabel.normalize('NFKC').trim(), delivery: quote.delivery,
    basis: quote.billingBasis, currency: quote.currency, tax: taxMode,
    cargo: [...quote.cargoTypes].sort(),
  };
}

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite SQL number');
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}
