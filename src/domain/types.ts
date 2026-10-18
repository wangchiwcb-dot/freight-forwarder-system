export type CountryCode = 'US' | 'CA' | 'MX' | 'GB' | 'DE' | 'FR' | 'IT' | 'ES' | 'PL' | 'CZ' | 'EU' | 'BR' | 'AU' | 'OTHER';
export type TransportMode = 'sea' | 'air' | 'rail' | 'road' | 'express' | 'parcel' | 'unknown';
export type CargoType = 'general' | 'battery' | 'magnetic' | 'liquid' | 'powder' | 'pure_battery' | 'sensitive';
export type BillingBasis = 'kg' | 'cbm' | 'parcel' | 'first_increment' | 'unknown';
export interface RateTier {
  id?: string;
  tax?: TaxTerms;
  label: string;
  min: number | null;
  max: number | null;
  minInclusive?: boolean;
  maxInclusive?: boolean;
  price: number | null;
  status: 'priced' | 'inquiry' | 'unavailable';
  sourceCell: string;
  fixedFee?: number;
  fixedFeeBasis?: 'shipment' | 'piece' | 'unknown';
  fixedFeeConfirmed?: boolean;
}
export interface TaxTerms {
  mode: string; duty: string; vat: string; settlement: string; evidenceKind: string; evidence: string;
}
export interface CargoAcceptance {
  type: CargoType; acceptance: 'allowed' | 'forbidden' | 'conditional' | 'unknown';
  evidenceKind: string; conditions: string[]; evidence: string;
}
export interface ChargeRule {
  id: string; label: string; amount: string | null; currency: string | null; basis: string;
  reviewStatus: string; conditions: Record<string, unknown>; evidence: string;
}
export interface QuoteSource {
  fileId: string;
  fileName: string;
  sheet: string;
  cells: string[];
  hidden: boolean;
}
export interface Quote {
  itemId?: string;
  validTo?: string | null;
  tax?: TaxTerms;
  cargoAcceptance?: CargoAcceptance[];
  charges?: ChargeRule[];
  id: string;
  providerId: string;
  providerName: string;
  isOwn: boolean;
  channelName: string;
  countryCode: CountryCode;
  mode: TransportMode;
  delivery: 'amazon' | 'commercial' | 'residential' | 'all' | 'unknown';
  origin: string;
  destinationLabel: string;
  warehouseCodes: string[];
  postalPrefixes: string[];
  postalRanges?: { start: string; end: string }[];
  postalCodes?: string[];
  cargoTypes: CargoType[];
  cargoCertainty: 'explicit' | 'inferred' | 'unknown';
  billingBasis: BillingBasis;
  currency: 'CNY' | 'USD' | 'EUR' | 'GBP' | null;
  currencyEvidence: 'explicit' | 'context' | 'unconfirmed';
  tiers: RateTier[];
  volumetricDivisor: number | null;
  minShipmentKg: number | null;
  minPieceKg: number | null;
  minCbm: number | null;
  maxKgPerCbm: number | null;
  densityConversionKgPerCbm?: number | null;
  volumeEquivalentKgPerCbm?: number | null;
  transitText: string;
  notes: string[];
  priceDate: string | null;
  effectiveAt: string | null;
  dateKind: 'explicit' | 'filename' | 'unknown';
  status: 'reference' | 'needs_review' | 'suspended';
  reviewReasons: string[];
  reliability: { level: 'verified' | 'concern' | 'unknown'; note: string; reviewedAt?: string };
  source: QuoteSource;
}
export interface SourceFile {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  sha256: string;
  sheets: number;
  hiddenSheets: number;
  quoteCount: number;
  status: 'parsed' | 'partial' | 'failed';
  warnings: string[];
}
export interface Catalog {
  schemaVersion: '1.0';
  version: string;
  generatedAt: string;
  files: SourceFile[];
  chunks: { country: CountryCode; path: string; rulesPath?: string; count: number }[];
  stats: { quotes: number; providers: number; countries: number; sources: number; cbmQuotes: number };
  snapshotId?: string;
  snapshots?: { id: string; name: string; observedDate: string | null; sourceKind: string }[];
}
export interface SearchResponse {
  items: QuoteResult[]; total: number; computedCount: number; pendingCount: number;
  page: number; pageSize: number; snapshotId: string;
}
export interface HistoryEntry {
  id: string; quotedOn: string | null; validFrom: string | null; validTo: string | null;
  dateEvidence: string; fileName: string; sheet: string; taxMode: string;
  snapshots: string[]; tiers: RateTier[];
}
export interface SearchCriteria {
  country: CountryCode | 'ALL';
  origin?: string;
  mode: TransportMode | 'all';
  delivery?: 'all' | 'amazon' | 'commercial' | 'residential';
  destination: string;
  cargo: CargoType;
  cargoShape: 'all' | 'dense' | 'bulky';
  actualKg: number | null;
  volumeCbm: number | null;
  pieces: number | null;
  providerId: string;
  onlyOwn: boolean;
  includePending: boolean;
  sort: 'cost' | 'unit' | 'updated' | 'reliability';
  asOf: string;
}
export interface QuoteResult {
  quote: Quote;
  tier: RateTier | null;
  estimatedCost: number | null;
  chargeableQuantity: number | null;
  estimateLabel: string;
  warnings: string[];
  eligible: boolean;
}
