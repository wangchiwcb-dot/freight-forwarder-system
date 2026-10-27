-- User confirmation on 2026-10-26. Only the unchanged initial drafts from the
-- inspected own-US source qualify. Published versions and saved user revisions
-- remain untouched; quote-run snapshots already contain their original offers.
WITH candidates AS (
  SELECT r.id, r.billing AS previous_billing, r.review_reasons AS previous_reasons,
    r.notes AS previous_notes, d.channel_hint='美森限时达海派' AS matson
  FROM quotation_v2.channel_releases r
  JOIN quotation_v2.channels c ON c.id=r.channel_id
  JOIN quotation_v2.draft_release_links l ON l.release_id=r.id
  JOIN quotation_v2.price_drafts d ON d.id=l.price_draft_id
  WHERE r.status='draft' AND r.source_kind='workbook' AND r.revision=1
    AND NOT r.reviewed AND NOT r.cargo_reviewed AND r.country='US' AND c.mode='sea'
    AND d.source_id='97ea96986ab72065d60b6707adf3d6502ba4be724b5e72c38b7d5aa78981caf3'
    AND d.proposed_data->'source'->>'sheet'='美国海派'
    AND d.channel_hint IN ('美森限时达海派','盐田定时达海派','普船海派')
    AND jsonb_array_length(r.notes)<100
    AND r.billing=jsonb_build_object('basis','kg','aggregation','shipment','volumetricDivisor','6000',
      'quantityStep','1','dimensionStepCm','0','volumeStepCbm','0.1','minimumQuantity','0',
      'minimumPieceKg',CASE WHEN d.channel_hint='美森限时达海派' THEN '12' ELSE '0' END,
      'densityKgPerCbm',null,'verified',false)
), changed AS (
  UPDATE quotation_v2.channel_releases r SET
    billing=r.billing || jsonb_build_object('verified',true,
      'minimumQuantity',CASE WHEN c.matson THEN '0' ELSE '12' END,
      'minimumPieceApplication',CASE WHEN c.matson THEN 'actual_before_shipment_max' ELSE null END),
    review_reasons=(SELECT coalesce(jsonb_agg(item),'[]'::jsonb) FROM jsonb_array_elements(r.review_reasons) item
      WHERE item<>to_jsonb('核对最低起运量与单件最低计费'::text)),
    notes=r.notes || jsonb_build_array('2026-10-26 用户确认最低计费：无特殊说明按单票最低12kg；美森原表B11明确单件最低12kg，先将每箱实重补足12kg后合计，再与进位后的整票材积重取大。30kg和5kg两箱、整票0.15方，计费42kg。')
  FROM candidates c WHERE r.id=c.id
  RETURNING r.id,c.previous_billing,c.previous_reasons,c.previous_notes,r.billing
)
INSERT INTO quotation_v2.audit_logs(action,entity_id,detail)
SELECT 'own_us_minimum_confirmed',id,jsonb_build_object('confirmation','2026-10-26/42kg',
  'previousBilling',previous_billing,'previousReviewReasons',previous_reasons,'previousNotes',previous_notes,'billing',billing)
FROM changed;
