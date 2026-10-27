import type { Database } from './database';
import { getPriceDraft, prepareOffer } from './review';
import { saveDraft } from './repository';

// This source was inspected against its original workbook. Only the billing
// parameters explicitly confirmed by the user are prefilled; no publication.
export async function prepareOwnUs(db: Database) {
  const rows = (await db.query<{ id:string }>(`SELECT d.id FROM quotation_v2.price_drafts d JOIN quotation_v2.source_files s ON s.id=d.source_id
    WHERE d.source_id='97ea96986ab72065d60b6707adf3d6502ba4be724b5e72c38b7d5aa78981caf3'
      AND d.proposed_data->'source'->>'sheet'='美国海派'
      AND s.pricing_state<>'pending'
      AND NOT EXISTS(SELECT 1 FROM quotation_v2.draft_release_links l WHERE l.price_draft_id=d.id)
    ORDER BY d.id`)).rows;
  let created=0;
  for (const row of rows) {
    const draft=await getPriceDraft(db,row.id);
    if (!draft) continue;
    const offer=prepareOffer(draft,{ mode:'sea',country:'US' });
    offer.sourceEvidence.push({ sourceId:draft.source_id,sheet:'附加费',cells:['C9','C12','C26','E26','C27','E27','C28','E28','C33','E33','C35','C36','C44','C45'],
      text:'已核对公共附加费页：私人/商业地址海派+1元/kg，偏远+3元/kg、超级偏远+4元/kg；部分产品加费与拒收条款冲突，超尺寸收费叠加方式待核。' });
    offer.rules=[{ id:'address',label:'私人/商业地址附加费',kind:'fee',scope:'shipment',
      condition:{ op:'in',field:'destination.addressType',values:['residential','commercial'] },inclusion:'additional',basis:'chargeable_kg',rate:'1',percentBase:[],minimum:null,maximum:null,
      evidence:'自有美线原表“附加费”C26:E27：商业地址及住宅地址，海派RMB1/KG；计费量采用渠道计费重。' }];
    offer.reviewReasons.push('偏远与超级偏远地址的识别条件待核','超长、超重、围长费的叠加及330cm边界待核','原表重货优惠档位及计重口径待核','部分产品在加收费和拒收清单中重复，承运范围待核');
    await saveDraft(db,offer,draft.id);created++;
  }
  return { created,published:0 };
}
