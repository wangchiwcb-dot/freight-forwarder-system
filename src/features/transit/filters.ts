import { relativeRange, type TransitFilters } from './metrics';

export const filterKeys = ['warehouse', 'channel', 'region', 'group', 'start', 'end'] as const;

export function defaultTransitFilters(dataThrough: string): TransitFilters {
  const [start, end] = relativeRange(dataThrough, 180);
  return { warehouse: '', channel: '', region: '', group: '', start, end };
}

/** Old shared links without date keys retain their original, all-history scope. */
export function readTransitFilters(params: URLSearchParams, dataThrough: string): TransitFilters {
  if (!filterKeys.some(key => params.has(key))) return defaultTransitFilters(dataThrough);
  return Object.fromEntries(filterKeys.map(key => [key, params.get(key) ?? ''])) as unknown as TransitFilters;
}
