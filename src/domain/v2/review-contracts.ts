import type { Offer } from './pricing-contracts';

export interface DraftRateTier {
  id?: string;
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

export interface DraftCargoAcceptance {
  type: string;
  acceptance: 'allowed' | 'forbidden' | 'conditional' | 'unknown';
  evidenceKind: string;
  conditions: string[];
  evidence: string;
}

export interface DraftQuoteSource {
  fileId: string;
  fileName: string;
  sheet: string;
  cells: string[];
  hidden: boolean;
}

/** Normalized price data extracted from a source workbook before review. */
export interface DraftQuote {
  id: string;
  providerId: string;
  providerName: string;
  isOwn: boolean;
  channelName: string;
  countryCode: string;
  mode: string;
  delivery: 'amazon' | 'commercial' | 'residential' | 'all' | 'unknown';
  origin: string;
  destinationLabel: string;
  warehouseCodes: string[];
  postalPrefixes: string[];
  postalRanges?: { start: string; end: string }[];
  postalCodes?: string[];
  cargoTypes: string[];
  cargoCertainty: 'explicit' | 'inferred' | 'unknown';
  cargoAcceptance?: DraftCargoAcceptance[];
  billingBasis: string;
  currency: string | null;
  currencyEvidence: string;
  tiers: DraftRateTier[];
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
  validTo?: string | null;
  dateKind: string;
  status: 'reference' | 'needs_review' | 'suspended';
  reviewReasons: string[];
  reliability?: { level: 'verified' | 'concern' | 'unknown'; note: string; reviewedAt?: string };
  source: DraftQuoteSource;
}

export interface PriceDraftRecord {
  id: string; source_id: string; source_name: string;
  provider_hint: string; channel_hint: string; country_hint: string; mode_hint: string;
  status: 'needs_review' | 'mapped' | 'excluded'; proposed_data: DraftQuote;
}
export interface Readiness {
  sources: number; priceDrafts: number; published: number; examples: number; ruleDrafts: number;
  countries: { value: string; count: number }[];
  providers: { value: string; count: number }[];
}
export interface ReviewedOffer { offer: Offer; issues: string[] }
