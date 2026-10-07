import { describe, expect, it } from 'vitest';
// @ts-expect-error Offline parser is plain JavaScript.
import { warehouseCodesFrom } from './warehouse-codes.mjs';

describe('explicit warehouse ranges', () => {
  it('expands full and abbreviated Canadian warehouse ranges', () => {
    const codes = warehouseCodesFrom('YYC1-YYC6；YVR1-4；YYZ1-Z9');
    expect(codes).toEqual(expect.arrayContaining(['YYC2', 'YYC6', 'YVR2', 'YVR4', 'YYZ2', 'YYZ9']));
  });
  it('does not invent intermediate warehouses for different prefixes or postcodes', () => {
    const codes = warehouseCodesFrom('ONT8-LAX9，90001-90009');
    expect(codes).toEqual(['ONT8', 'LAX9']);
  });
  it('preserves letter-only receiving codes', () => {
    expect(warehouseCodesFrom('IUSJ、IUTI、LAX2T')).toEqual(expect.arrayContaining(['IUSJ', 'IUTI', 'LAX2T']));
  });
});
