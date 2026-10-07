/** Expand explicit same-prefix warehouse ranges without treating postcode ranges as warehouses. */
export function warehouseCodesFrom(text) {
  const label = text.toUpperCase();
  const codes = new Set(label.match(/\b[A-Z]{2,4}\d{1,2}[A-Z]?\b/g) || []);
  // Some new Amazon receiving warehouses use four letters, such as IUSJ and IUTI.
  for (const code of label.match(/\bI(?:US|UT)[A-Z]\b/g) || []) codes.add(code);
  const ranges = /\b([A-Z]{2,4})(\d{1,2})\s*[-–—~至]\s*([A-Z]{1,4})?(\d{1,2})\b/g;
  for (const match of label.matchAll(ranges)) {
    const [, prefix, from, endPrefix, to] = match;
    if (endPrefix && prefix !== endPrefix && !prefix.endsWith(endPrefix)) continue;
    const start = Number(from), end = Number(to);
    if (end < start || end - start > 50) continue;
    for (let number = start; number <= end; number++) codes.add(`${prefix}${from.startsWith('0') ? String(number).padStart(from.length, '0') : number}`);
  }
  return [...codes];
}
