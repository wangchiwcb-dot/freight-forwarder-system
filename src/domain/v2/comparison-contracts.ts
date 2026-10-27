import { z } from 'zod';
import { decimalSchema } from './contracts';
import { id, requestSchema, type CostLine } from './pricing-contracts';

export const comparisonOptionsSchema = z.object({
  selectedDraftIds:z.array(id).max(200).default([]),
  referenceAggregation:z.enum(['shipment','piece']).default('shipment'),
  referenceStep:decimalSchema.default('0'),
  fallbackDivisor:decimalSchema.refine(value=>Number(value)>0).nullable().default(null),
}).strict();
export const comparisonInputSchema=z.object({request:requestSchema,options:comparisonOptionsSchema.default({selectedDraftIds:[],referenceAggregation:'shipment',referenceStep:'0',fallbackDivisor:null}),supersedes:id.nullable().default(null)}).strict();
export type ComparisonOptions=z.infer<typeof comparisonOptionsSchema>;
export type ComparisonInput=z.infer<typeof comparisonInputSchema>;
export interface ComparisonItem {
  id:string; draftId:string|null; offerId:string|null;
  provider:string; channel:string; mode:string; country:string; destination:string; origin:string|null;
  currency:string|null; basis:string; quantity:string|null; unitPrice:string|null; tierLabel:string|null;
  baseFreight:string|null; knownSurcharges:string|null; knownCost:string|null; completeCost:string|null;
  status:'complete'|'reference'|'needs_parameters'|'inquiry'|'unavailable';
  coverage:'matched'|'unknown'|'rejected'; lowestReference:boolean; lowestComplete:boolean; comparisonKey:string|null;
  warnings:string[]; assumptions:string[]; lines:CostLine[];
  tiers:{label:string;price:string|null;status:string}[]; transitText:string;
  source:{id:string|null;name:string;sheet:string|null;cells:string[]} | null;
}
export interface ComparisonSummary {
  candidates:number; calculated:number; needsParameters:number; unavailable:number;
  sources:number; providers:number; selected:number; currencies:string[];
}
export interface ComparisonRun {
  id:string; request:ComparisonInput['request']; options:ComparisonOptions; supersedes:string|null;
  items:ComparisonItem[]; total:number; page:number; pageSize:number; summary:ComparisonSummary; engineVersion:string;
}
