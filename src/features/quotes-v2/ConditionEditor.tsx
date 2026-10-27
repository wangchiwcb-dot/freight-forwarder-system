import { Button, Input, InputNumber, Select, Space } from 'antd';
import type { Condition } from '../../domain/v2/contracts';
import { cargoOptions } from './api';

const numeric = { 'shipment.actualKg':'整票实重 kg', 'shipment.pieces':'总件数', 'package.actualKg':'每箱实重 kg',
  'package.longestCm':'最长边 cm', 'package.secondCm':'次长边 cm', 'package.girthCm':'围长 cm' };
const textual = { 'destination.addressType':'地址类型', 'destination.countryCode':'国家代码', 'destination.postalCode':'邮编',
  'destination.warehouseCode':'仓码', 'cargo.intellectualProperty':'侵权仿牌情况', 'cargo.attributes':'货品属性' };
const valuesFor = (field: string) => field === 'destination.addressType' ? [
  { value:'residential',label:'私人地址' }, { value:'commercial',label:'商业地址' }, { value:'platform',label:'平台仓库' },
] : field === 'cargo.intellectualProperty' ? [{ value:'clear',label:'非侵权仿牌' }, { value:'infringing',label:'侵权仿牌' }]
  : field === 'cargo.attributes' ? cargoOptions : [];
const leaf: Condition = { field: 'destination.addressType', op: 'eq', value: 'residential' };

export function ConditionEditor({ value = null, onChange, depth = 0 }: { value?: Condition | null; onChange?: (value: Condition | null) => void; depth?: number }) {
  const change = (next: Condition | null) => onChange?.(next);
  const group = value && 'conditions' in value ? value : null;
  const term = value && 'field' in value ? value : null;
  const type = value === null ? 'always' : value.op === 'all' || value.op === 'any' || value.op === 'not' ? value.op : 'term';
  return <div className="v2-condition">
    <Space wrap>
      <Select aria-label="触发方式" value={type} style={{ minWidth: 180 }} options={[
        { value:'always',label:'无条件适用' }, { value:'term',label:'满足单项条件' },
        ...(depth < 5 ? [{ value:'all',label:'全部条件满足' },{ value:'any',label:'任一条件满足' },{ value:'not',label:'以下条件不满足' }] : []),
      ]} onChange={kind => change(kind === 'always' ? null : kind === 'term' ? leaf : kind === 'not' ? { op:'not',condition:leaf } : { op:kind as 'all'|'any',conditions:[leaf] })} />
      {term && <>
        <Select aria-label="判断项目" style={{ minWidth: 180 }} value={term.field} options={Object.entries({ ...numeric, ...textual }).map(([value,label]) => ({ value,label }))}
          onChange={field => change(field in numeric ? { op:'gte',field:field as keyof typeof numeric,value:'0' }
            : field === 'cargo.attributes' ? { op:'contains',field,value:'liquid' }
              : { op:'eq',field:field as keyof Omit<typeof textual,'cargo.attributes'>,value:valuesFor(field)[0]?.value ?? '待填写' })} />
        {term.field in numeric ? <>
          <Select aria-label="比较方式" style={{ minWidth: 100 }} value={term.op} options={[{ value:'gte',label:'大于等于' },{ value:'gt',label:'大于' },{ value:'lte',label:'小于等于' },{ value:'lt',label:'小于' }]}
            onChange={op => change({ ...term,op } as Condition)} />
          <InputNumber aria-label="阈值" stringMode min="0" value={'value' in term ? term.value : '0'} onChange={value => change({ ...term,value:value ?? '' } as Condition)} />
        </> : <>
          {term.field !== 'cargo.attributes' && <Select aria-label="匹配方式" value={term.op} options={[{ value:'eq',label:'等于' },{ value:'in',label:'属于列表' }]}
            onChange={op => change(op === 'in' ? { op,field:term.field as any,values:'value' in term ? [term.value] : term.values } : { op,field:term.field as any,value:'value' in term ? term.value : term.values[0] })} />}
          {term.op === 'in' ? <Select aria-label="匹配列表" mode="tags" style={{ minWidth:200 }} options={valuesFor(term.field)} value={term.values} onChange={values => change({ ...term,values })} />
            : valuesFor(term.field).length ? <Select aria-label="匹配值" style={{ minWidth:150 }} options={valuesFor(term.field)} value={'value' in term ? term.value : undefined} onChange={value => change({ ...term,value } as Condition)} />
              : <Input aria-label="匹配值" value={'value' in term ? term.value : ''} onChange={event => change({ ...term,value:event.target.value } as Condition)} />}
        </>}
      </>}
    </Space>
    {group && <div className="v2-condition-children">{group.conditions.map((condition,index) => <div key={index}>
      <ConditionEditor value={condition} depth={depth+1} onChange={next => change({ ...group,conditions:group.conditions.map((item,i) => i === index ? next ?? leaf : item) })} />
      <Button size="small" danger disabled={group.conditions.length === 1} onClick={() => change({ ...group,conditions:group.conditions.filter((_,i) => i !== index) })}>删除条件</Button>
    </div>)}<Button size="small" disabled={group.conditions.length >= 20} onClick={() => change({ ...group,conditions:[...group.conditions,leaf] })}>添加条件</Button></div>}
    {value?.op === 'not' && <ConditionEditor value={value.condition} depth={depth+1} onChange={condition => change({ op:'not',condition:condition ?? leaf })} />}
  </div>;
}
