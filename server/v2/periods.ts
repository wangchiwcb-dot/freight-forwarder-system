/** Parameters are SQL placeholders chosen by callers, never user-provided SQL. */
export function visiblePriceSql(asOf: string) {
  return `(s.pricing_state<>'pending' AND (vp.draft_id IS NULL OR
    ((vp.valid_from IS NULL OR vp.valid_from<=${asOf}::date) AND (vp.valid_to IS NULL OR vp.valid_to>${asOf}::date))))`;
}
export const pricePeriodJoins = `LEFT JOIN quotation_v2.price_periods vp ON vp.draft_id=d.id
  LEFT JOIN quotation_v2.quote_updates vu ON vu.id=vp.update_id`;
export const pricePeriodFields = `to_char(vp.valid_from,'YYYY-MM-DD') AS version_from,
  to_char(vp.valid_to,'YYYY-MM-DD') AS version_to,vu.label AS version_label,s.pricing_state`;
export const todayInChina = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
