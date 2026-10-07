import { Alert, Button, Modal, Space, Table, Tag, Typography } from 'antd';
import type { Catalog, SourceFile } from '../../domain/types';
export function SourceModal({ catalog, open, onClose }: { catalog?: Catalog; open: boolean; onClose: () => void }) {
  return <Modal title="数据源与覆盖范围" open={open} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={930}>
    <Alert type="info" showIcon message="报价按渠道提取，保留原表定位" description="已提取的记录可用于检索；复杂附表、邮编表或暂未确认的计费规则会列入覆盖说明。原始 Excel 未公开在页面中。" style={{ marginBottom: 18 }} />
    <Space style={{ marginBottom: 14 }} wrap><Tag>{catalog?.files.length ?? 0} 份文件</Tag><Tag>{catalog?.stats.providers ?? 0} 家代理</Tag><Typography.Text type="secondary">数据版本：{catalog?.version || '读取中'}</Typography.Text></Space>
    <Table<SourceFile> size="small" rowKey="id" pagination={{ pageSize: 8, showSizeChanger: false }} dataSource={catalog?.files ?? []} scroll={{ x: 670 }} expandable={{ expandedRowRender: (file) => <div className="source-notes">{file.warnings.length ? file.warnings.map((warning, index) => <p key={index}>{warning}</p>) : '无额外覆盖提示。'}<Typography.Text type="secondary">工作表 {file.sheets} 个，其中隐藏 {file.hiddenSheets} 个</Typography.Text></div>, rowExpandable: (file) => file.warnings.length > 0 }} columns={[{ title: '原始报价文件', dataIndex: 'name', width: 340 }, { title: '代理', dataIndex: 'providerName', width: 150 }, { title: '提取记录', dataIndex: 'quoteCount', width: 95 }, { title: '覆盖状态', dataIndex: 'status', width: 105, render: (value: string) => <Tag color={value === 'parsed' ? 'success' : value === 'failed' ? 'error' : 'gold'}>{value === 'parsed' ? '已解析' : value === 'partial' ? '部分覆盖' : '未提取'}</Tag> }]} />
  </Modal>;
}
