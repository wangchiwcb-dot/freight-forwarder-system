import { describe, expect, it } from 'vitest';
import { evaluateCondition } from './conditions';
import type { Condition } from './contracts';

const battery: Condition = { op: 'contains', field: 'cargo.attributes', value: 'built_in_battery' };
const overweight: Condition = { op: 'gt', field: 'package.actualKg', value: '30' };

describe('V2 channel conditions', () => {
  it('matches overlapping cargo attributes instead of forcing a single cargo type', () => {
    const both: Condition = { op: 'all', conditions: [battery,
      { op: 'contains', field: 'cargo.attributes', value: 'magnetic' }] };
    expect(evaluateCondition(both, { 'cargo.attributes': ['built_in_battery', 'magnetic'] }).state).toBe('matched');
    expect(evaluateCondition(both, { 'cargo.attributes': ['built_in_battery'] }).state).toBe('not_matched');
  });

  it('distinguishes unknown cargo from a confirmed absence of special attributes', () => {
    expect(evaluateCondition(battery, {})).toEqual({ state: 'unknown', missingFields: ['cargo.attributes'] });
    expect(evaluateCondition(battery, { 'cargo.attributes': null }).state).toBe('unknown');
    expect(evaluateCondition(battery, { 'cargo.attributes': [] }).state).toBe('not_matched');
    expect(evaluateCondition({ op: 'not', condition: battery }, {}).state).toBe('unknown');
  });

  it('requires actual package facts and never substitutes shipment total or average', () => {
    expect(evaluateCondition(overweight, { 'shipment.actualKg': '100', 'shipment.pieces': '2' }))
      .toEqual({ state: 'unknown', missingFields: ['package.actualKg'] });
    expect(evaluateCondition(overweight, { 'package.actualKg': '30' }).state).toBe('not_matched');
    expect(evaluateCondition(overweight, { 'package.actualKg': '30.0000000000000001' }).state).toBe('matched');
  });

  it('does not ask for irrelevant facts after an AND condition has failed', () => {
    expect(evaluateCondition({ op: 'all', conditions: [battery, overweight] }, { 'cargo.attributes': [] }))
      .toEqual({ state: 'not_matched', missingFields: [] });
  });

  it('resolves an OR with a known match but keeps an unresolved OR pending', () => {
    const any: Condition = { op: 'any', conditions: [battery, overweight] };
    expect(evaluateCondition(any, { 'cargo.attributes': ['built_in_battery'] }))
      .toEqual({ state: 'matched', missingFields: [] });
    expect(evaluateCondition(any, { 'cargo.attributes': [] }))
      .toEqual({ state: 'unknown', missingFields: ['package.actualKg'] });
  });

  it('returns every required missing field without duplicating it', () => {
    expect(evaluateCondition({ op: 'all', conditions: [battery, overweight, battery] }, {}))
      .toEqual({ state: 'unknown', missingFields: ['cargo.attributes', 'package.actualKg'] });
  });

  it('preserves leading zeros and alphanumeric postal codes', () => {
    const region: Condition = { op: 'in', field: 'destination.postalCode', values: ['09001', 'SW1A 1AA'] };
    expect(evaluateCondition(region, { 'destination.postalCode': '09001' }).state).toBe('matched');
    expect(evaluateCondition(region, { 'destination.postalCode': '9001' }).state).toBe('not_matched');
    expect(evaluateCondition(region, { 'destination.postalCode': 'SW1A 1AA' }).state).toBe('matched');
  });

  it('rejects malformed rules and facts rather than interpreting them as free of charges', () => {
    for (const rule of [
      { op: 'eval', expression: 'true' },
      { op: 'all', conditions: [] },
      { ...overweight, field: 'cargo.attributes' },
      { ...overweight, value: '-1' },
    ]) expect(() => evaluateCondition(rule, {})).toThrow();
    for (const value of [30, 'NaN', 'Infinity', '-1', '3e1', '']) {
      expect(() => evaluateCondition(overweight, { 'package.actualKg': value })).toThrow();
    }
    expect(() => evaluateCondition(battery, { 'cargo.attributes': 'built_in_battery' })).toThrow();
    let deep: Condition = battery;
    for (let index = 0; index < 9; index++) deep = { op: 'not', condition: deep };
    expect(() => evaluateCondition(deep, {})).toThrow();
  });
});
