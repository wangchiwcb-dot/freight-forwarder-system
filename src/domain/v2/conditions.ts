import Decimal from 'decimal.js';
import { conditionSchema, factsSchema, type Condition, type FactField, type Facts } from './contracts';

export interface ConditionResult {
  state: 'matched' | 'not_matched' | 'unknown';
  missingFields: FactField[];
}
const known = (matched: boolean): ConditionResult => ({
  state: matched ? 'matched' : 'not_matched', missingFields: [],
});

function evaluate(condition: Condition, facts: Facts): ConditionResult {
  if (condition.op === 'all' || condition.op === 'any') {
    const results = condition.conditions.map(child => evaluate(child, facts));
    const isAll = condition.op === 'all';
    const decisive = isAll ? 'not_matched' : 'matched';
    if (results.some(result => result.state === decisive)) return known(!isAll);
    if (results.some(result => result.state === 'unknown')) {
      return { state: 'unknown', missingFields: [...new Set(results.flatMap(result => result.missingFields))] };
    }
    return known(isAll);
  }
  if (condition.op === 'not') {
    const result = evaluate(condition.condition, facts);
    return result.state === 'unknown' ? result : known(result.state === 'not_matched');
  }
  // The composite union uses a shared op field; this guard also narrows its shape.
  if (!('field' in condition)) throw new Error('Unsupported condition');
  const fact = facts[condition.field];
  if (fact == null) return { state: 'unknown', missingFields: [condition.field] };
  switch (condition.op) {
    case 'eq': return known(fact === condition.value);
    case 'in': return known(condition.values.includes(fact as string));
    case 'contains': return known((fact as string[]).includes(condition.value));
    case 'gt': return known(new Decimal(fact as string).gt(condition.value));
    case 'gte': return known(new Decimal(fact as string).gte(condition.value));
    case 'lt': return known(new Decimal(fact as string).lt(condition.value));
    case 'lte': return known(new Decimal(fact as string).lte(condition.value));
  }
}

/** Evaluate one cargo or package context. Do not replace unknown attributes with []. */
export function evaluateCondition(condition: unknown, facts: unknown): ConditionResult {
  return evaluate(conditionSchema.parse(condition), factsSchema.parse(facts));
}
