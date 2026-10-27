export interface QuoteUpdateInput {
  sourceId: string; previousSourceId: string | null; label: string; effectiveFrom: string;
  mappings: { draftId: string; previousDraftId: string | null }[];
}
export interface QuoteUpdateRow {
  id: string; channel: string; destination: string; country: string;
  previousDraftId: string | null; kind: 'new'|'changed'|'unchanged'|'ambiguous';
  changes: string[]; previousPrices: string; prices: string;
  candidates: { id: string; label: string }[];
}
export interface QuoteUpdatePreview {
  token: string;
  summary: { total: number; matched: number; added: number; changed: number; unchanged: number; retained: number; ambiguous: number };
  items: QuoteUpdateRow[]; page: number; pageSize: number;
  retainedExamples: string[];
}
export interface QuoteSource {
  id: string; name: string; price_drafts: number; pricing_state: 'legacy'|'pending'|'versioned';
  version_label: string | null; effective_from: string | null;
}
