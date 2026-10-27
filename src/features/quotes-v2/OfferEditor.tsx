import { newId } from './api';
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Form, Input, InputNumber, Select, Space, Tabs, Typography } from 'antd';
import { offerSchema, type Offer, type Rule } from '../../domain/v2/pricing-contracts';
import type { ReviewedOffer } from '../../domain/v2/review-contracts';
import { TRANSPORT_MODES, transportLabels } from '../../domain/v2/contracts';
import { cargoOptions, countryNames, quotationApi } from './api';
import { ConditionEditor } from './ConditionEditor';

function LinesInput({ value = [], onChange }: { value?: string[]; onChange?: (value: string[]) => void }) {
  return <Input.TextArea rows={5} value={value.join('\n')} onChange={event => onChange?.(event.target.value.split('\n').filter(line => line.trim()))} />;
}
const newRule = (): Rule => ({ id:`rule_${newId()}`,label:'新附加费',kind:'fee',scope:'shipment',condition:null,
  inclusion:'additional',basis:'shipment',rate:null,percentBase:[],minimum:null,maximum:null,evidence:'请填写原表条款及收费依据' });

export function OfferEditor({ record, sourceDraftId, persisted, onSaved }: {
  record: ReviewedOffer; sourceDraftId: string | null; persisted: boolean;
  onSaved: (record: ReviewedOffer) => void;
}) {
  const [form] = Form.useForm();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [dirty,setDirty] = useState(false);
  const currentRules = Form.useWatch('rules', { form, preserve:true }) as Rule[] | undefined;
  const offer = record.offer;
  useEffect(() => {
    form.resetFields(); form.setFieldsValue({ ...offer,billing:{ ...offer.billing,volumeStepCbm:offer.billing.volumeStepCbm === undefined ? '0' : offer.billing.volumeStepCbm } });
    setDirty(false); setError('');
  },[offer,form]);
  async function save() {
    // Tabs may not have mounted their fields yet; preserve the complete draft.
    const values = form.getFieldsValue(true);
    setBusy(true); setError('');
    try {
      const changedProvider = values.providerName !== offer.providerName || values.isOwn !== offer.isOwn;
      const changedChannel = changedProvider || values.mode !== offer.mode || values.lastMile !== offer.lastMile || values.country !== offer.country;
      const candidate = { ...offer,...values,id:newId(),status:'draft',
        providerId:changedProvider ? `provider_${newId()}` : offer.providerId,
        channelId:changedChannel ? `channel_${newId()}` : offer.channelId,
        origin:values.origin?.trim() || null,scopeKey:values.scopeKey || null,validFrom:values.validFrom || null,validTo:values.validTo || null,
        billing:{ ...offer.billing,...values.billing },
      };
      const parsed = offerSchema.safeParse(candidate);
      if (!parsed.success) { setError(`资料格式有误：${parsed.error.issues.slice(0,4).map(issue => issue.message).join('；')}。请检查空白的计费参数、档位和规则。`); return; }
      onSaved(await quotationApi<ReviewedOffer>('/review/offers',{ offer:parsed.data,sourceDraftId }));
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function publish() {
    setBusy(true); setError('');
    try {
      await quotationApi(`/offers/${offer.id}/publish`,{});
      onSaved({ offer:{ ...offer,status:'published' },issues:[] });
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  const number = (path: (string|number)[], label: string, allowZero = true) => <Form.Item name={path} label={label}><InputNumber stringMode min={allowZero ? '0' : '0.000001'} /></Form.Item>;
  return <div className="v2-offer-editor">
    <Alert type={offer.status === 'published' ? 'success' : 'info'} showIcon
      message={offer.status === 'published' ? '该版本已发布；修改将保存为新的草稿版本' : '先核对价格与规则，再发布为正式比价方案'}
      description="保存草稿不会改变现有正式价格。未知收费和未确认条件需保留为待核，不能填成零。" />
    <Form form={form} layout="vertical" onFinish={save} onValuesChange={() => setDirty(true)} requiredMark={false}>
      <Tabs items={[
        { key:'base',label:'渠道资料',children:<>
          <div className="v2-editor-grid">
            <Form.Item name="providerName" label="供应商 / 代理" rules={[{ required:true }]}><Input /></Form.Item>
            <Form.Item name="isOwn" label="是否自有渠道" valuePropName="checked"><Checkbox>自有渠道</Checkbox></Form.Item>
            <Form.Item name="name" label="渠道与目的地名称" rules={[{ required:true }]}><Input /></Form.Item>
            <Form.Item name="country" label="目的国家"><Select options={Object.entries(countryNames).filter(([value]) => !['EU','OTHER'].includes(value)).map(([value,label]) => ({ value,label }))} /></Form.Item>
            <Form.Item name="mode" label="主干运输"><Select options={TRANSPORT_MODES.map(value => ({ value,label:transportLabels[value] }))} /></Form.Item>
            <Form.Item name="lastMile" label="末端派送"><Select options={[{ value:'express',label:'快递派送' },{ value:'truck',label:'卡车派送' },{ value:'other',label:'其他 / 自提' }]} /></Form.Item>
            <Form.Item name="origin" label="交仓点"><Input placeholder="例如：深圳石岩仓" /></Form.Item>
            <Form.Item name="currency" label="币种"><Select options={['CNY','USD','EUR','GBP','CAD','AUD'].map(value => ({ value,label:value }))} /></Form.Item>
            <Form.Item name="costBasis" label="价格口径"><Select options={[{ value:'internal_settlement',label:'自有内部结算成本' },{ value:'supplier_purchase',label:'同行采购成本' }]} /></Form.Item>
            <Form.Item name="scopeKey" label="比价服务范围"><Select allowClear options={[{ value:'door_tax_included',label:'门到门，含税' },{ value:'door_tax_excluded',label:'门到门，不含税' },{ value:'door_tax_deferred',label:'门到门，递延清关' },{ value:'pickup_tax_included',label:'到仓自提，含税' }]} /></Form.Item>
            <Form.Item name="validFrom" label="生效日期"><Input type="date" /></Form.Item>
            <Form.Item name="validTo" label="失效日期（当天起不适用）"><Input type="date" /></Form.Item>
          </div>
          <Form.Item name="serviceDescription" label="服务及税费范围说明"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="transitText" label="时效及起止口径"><Input placeholder="保留原表开船后、提取或签收等口径" /></Form.Item>
          <Form.List name="targets">{(fields,{ add,remove }) => <>
            <Typography.Text strong>覆盖仓码与邮编（各行满足任一即可；留空表示该国家全域，请确认）</Typography.Text>
            {fields.map(field => <Space key={field.key} align="start" wrap>
              <Form.Item name={[field.name,'kind']} label="覆盖类型"><Select style={{ width:140 }} options={[{ value:'warehouse',label:'仓码' },{ value:'postal',label:'完整邮编' },{ value:'postal_prefix',label:'邮编前缀' },{ value:'postal_range',label:'五位邮编区间' }]} /></Form.Item>
              <Form.Item name={[field.name,'value']} label="覆盖值"><Input placeholder="例如 ONT8 或 80001-96999" /></Form.Item>
              <Button danger onClick={() => remove(field.name)}>删除</Button>
            </Space>)}
            <Button onClick={() => add({ kind:'warehouse',value:'' })}>添加覆盖范围</Button>
          </>}</Form.List>
        </> },
        { key:'billing',label:'计费规则',children:<>
          <div className="v2-editor-grid">
            <Form.Item name={['billing','basis']} label="基础单价单位"><Select options={[{ value:'kg',label:'每计费公斤' },{ value:'cbm',label:'每计费方' }]} /></Form.Item>
            <Form.Item name={['billing','aggregation']} label="实重与材积取大方式"><Select options={[{ value:'shipment',label:'整票取大' },{ value:'piece',label:'逐箱取大后相加' }]} /></Form.Item>
            {number(['billing','volumetricDivisor'],'材积系数（按公斤时必填）',false)}
            {number(['billing','quantityStep'],'最终计费量进位（0表示不进位）')}
            {number(['billing','dimensionStepCm'],'每条边进位 cm（0表示不进位）')}
            {number(['billing','volumeStepCbm'],'整票体积进位 CBM（0表示不进位）')}
            {number(['billing','minimumQuantity'],'整票最低计费量')}
            {number(['billing','minimumPieceKg'],'单箱最低计费 kg')}
            <Form.Item name={['billing','minimumPieceApplication']} label="整票取大时，单箱最低如何执行"><Select allowClear placeholder="有单箱最低时必须明确" options={[{ value:'actual_before_shipment_max',label:'每箱实重补足最低值后合计，再与整票材积重取大' }]} /></Form.Item>
            {number(['billing','densityKgPerCbm'],'按方密度换算 kg/CBM（不适用留空）',false)}
          </div>
          <Alert type="info" showIcon message="整票体积进位先于材积重换算；每条边进位与整票体积进位分别设置。" />
          <Form.Item name={['billing','verified']} valuePropName="checked"><Checkbox>已核实上述计费方式、进位及最低计费</Checkbox></Form.Item>
        </> },
        { key:'tiers',label:'价格档位',children:<Form.List name="tiers">{(fields,{ add,remove }) => <>
          {fields.map(field => <div key={field.key} className="v2-editor-block"><div className="v2-editor-grid">
            <Form.Item name={[field.name,'id']} hidden><Input /></Form.Item>
            {number([field.name,'min'],'下限')}{number([field.name,'max'],'上限（无上限留空）')}
            <Form.Item name={[field.name,'minInclusive']} valuePropName="checked"><Checkbox>包含下限</Checkbox></Form.Item>
            <Form.Item name={[field.name,'maxInclusive']} valuePropName="checked"><Checkbox>包含上限</Checkbox></Form.Item>
            {number([field.name,'unitPrice'],'成本单价')}
            <Form.Item name={[field.name,'status']} label="价格状态"><Select options={[{ value:'priced',label:'有明确价格' },{ value:'inquiry',label:'需询价（单价留空）' },{ value:'unavailable',label:'不承运（单价留空）' }]} /></Form.Item>
          </div><Button danger disabled={fields.length === 1} onClick={() => remove(field.name)}>删除档位</Button></div>)}
          <Button onClick={() => add({ id:`tier_${newId()}`,min:'0',max:null,minInclusive:true,maxInclusive:false,unitPrice:null,status:'inquiry' })}>添加档位</Button>
        </>}</Form.List> },
        { key:'rules',label:'附加费与拒收',children:<>
          <Form.Item name="acceptedAttributes" label="明确可承运的特殊属性（可输入自定义属性）"><Select mode="tags" options={cargoOptions} /></Form.Item>
          <Form.List name="rules">{(fields,{ add,remove }) => <>
            {fields.map(field => <div className="v2-editor-block" key={field.key}>
              <Form.Item name={[field.name,'id']} hidden><Input /></Form.Item>
              <div className="v2-editor-grid">
                <Form.Item name={[field.name,'label']} label="规则名称"><Input /></Form.Item>
                <Form.Item name={[field.name,'kind']} label="规则类型"><Select options={[{ value:'fee',label:'收费规则' },{ value:'deny',label:'拒收规则' }]} /></Form.Item>
                <Form.Item name={[field.name,'scope']} label="判断范围"><Select options={[{ value:'shipment',label:'整票判断' },{ value:'package',label:'逐箱判断' }]} /></Form.Item>
                <Form.Item name={[field.name,'inclusion']} label="收费状态"><Select options={[{ value:'additional',label:'另行收费' },{ value:'included',label:'运费已含' },{ value:'exempt',label:'明确免收' },{ value:'unknown',label:'待确认' }]} /></Form.Item>
                <Form.Item name={[field.name,'basis']} label="费用单位"><Select options={[{ value:'shipment',label:'每票' },{ value:'piece',label:'每件' },{ value:'chargeable_kg',label:'每计费公斤' },{ value:'chargeable_cbm',label:'每计费方' },{ value:'chargeable_quantity',label:'沿用基础计费量' },{ value:'percentage',label:'百分比' }]} /></Form.Item>
                {number([field.name,'rate'],'费率 / 金额（拒收或待核可留空）')}
                {number([field.name,'minimum'],'最低收费（无则留空）')}{number([field.name,'maximum'],'最高收费（无则留空）')}
              </div>
              <Form.Item name={[field.name,'percentBase']} label="百分比费用基数（仅百分比规则填写）"><Select mode="multiple" options={[{ value:'base',label:'基础运费' },...(currentRules ?? offer.rules).filter((rule,index) => rule.kind === 'fee' && index !== field.name).map(rule => ({ value:rule.id,label:rule.label }))]} /></Form.Item>
              <Form.Item name={[field.name,'condition']} label="触发条件"><ConditionEditor /></Form.Item>
              <Form.Item name={[field.name,'evidence']} label="原表条款或确认依据"><Input.TextArea rows={2} maxLength={500} /></Form.Item>
              <Button danger onClick={() => remove(field.name)}>删除规则</Button>
            </div>)}
            <Button onClick={() => add(newRule())}>添加附加费或拒收规则</Button>
          </>}</Form.List>
        </> },
        { key:'review',label:'复核与依据',children:<>
          <Form.Item name="reviewReasons" label="尚未解决的事项（逐项核实后删除，全部完成才可发布）"><LinesInput /></Form.Item>
          <Form.Item name="cargoReviewed" valuePropName="checked"><Checkbox>已核实承运产品、禁运及限制条件</Checkbox></Form.Item>
          <Form.Item name="reviewed" valuePropName="checked"><Checkbox>已核实原表价格、收费和服务范围</Checkbox></Form.Item>
          <Typography.Text strong>报价原件依据</Typography.Text>
          {offer.sourceEvidence.map((item,index) => <p key={index}>{item.sheet} {item.cells.join('、')}<br />{item.text}
            {item.sourceId && <><br /><a href={`/api/v2/sources/${item.sourceId}/download`}>下载对应原表</a></>}</p>)}
          <Collapse items={[{ key:'notes',label:'保留的原表备注与确认记录',children:offer.notes.map((note,index) => <p style={{ whiteSpace:'pre-wrap' }} key={index}>{note}</p>) }]} />
        </> },
      ]} />
      {error && <Alert type="error" showIcon message={error} />}
      {record.issues.length > 0 && <Alert type="warning" showIcon message="当前保存版本尚不能发布" description={<ul>{record.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>} />}
      <Space wrap className="v2-editor-actions">
        <Button type="primary" htmlType="submit" loading={busy}>保存新草稿版本</Button>
        <Button disabled={!persisted || dirty || record.issues.length > 0 || offer.status !== 'draft'} loading={busy} onClick={() => void publish()}>发布当前版本</Button>
        <Typography.Text type="secondary">{dirty ? '修改后先保存，再检查发布条件' : persisted ? `版本：${offer.id}` : '尚未保存'}</Typography.Text>
      </Space>
    </Form>
  </div>;
}
