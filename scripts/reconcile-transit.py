"""Independently reconcile every source fact row/cell with the published transit JSON.

Read only: does not import the extractor or change the workbook/dataset.
"""
import argparse
import collections
import datetime as dt
from decimal import Decimal, ROUND_HALF_EVEN
import hashlib
import io
import json
from pathlib import Path
import posixpath
import re
import zipfile
from xml.etree import ElementTree as ET

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
FACT_SHEETS = ('2025', '2026数据源')
NODE_COLUMNS = {'departure': 'F', 'arrival': 'G', 'unloaded': 'H', 'pickup': 'I', 'devanning': 'J', 'delivered': 'L'}
STATES = set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split())


def main(source, data_dir, output):
    source_bytes = source.read_bytes()
    manifest = json.loads((data_dir / 'manifest.json').read_text(encoding='utf-8'))
    review_path = Path(__file__).with_name('transit-warehouse-review.json')
    review = json.loads(review_path.read_text(encoding='utf-8'))
    mismatches, records, dictionaries, rules = [], [], [], []
    def check(equal, location, field, expected=None, actual=None):
        if not equal:
            mismatches.append(dict(location=location, field=field, expected=expected, actual=actual))
    check(hashlib.sha256(source_bytes).hexdigest() == manifest['sourceSha256'], 'workbook', 'sourceSha256')
    check(hashlib.sha256(review_path.read_text(encoding='utf-8').encode('utf-8')).hexdigest() == manifest['warehouseReviewSha256'], 'review', 'sha256')
    for part in manifest['files']:
        raw = (data_dir / part['file']).read_bytes()
        values = json.loads(raw)
        check(hashlib.sha256(raw).hexdigest() == part['sha256'], part['file'], 'sha256')
        check(len(raw) == part['bytes'] and len(values) == part['count'], part['file'], 'size/count')
        {'records': records, 'warehouses': dictionaries, 'rules': rules}[part['kind']].extend(values)
    by_source = {(r['source']['sheet'], r['source']['row']): r for r in records}
    check(len(by_source) == len(records), 'records', 'unique source rows')
    parsed, inventory = {}, []
    with zipfile.ZipFile(io.BytesIO(source_bytes)) as archive:
        shared = [''.join(t.text or '' for t in si.findall('.//s:t', NS))
                  for si in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
        rels = {rel.get('Id'): rel.get('Target') for rel in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        book = ET.fromstring(archive.read('xl/workbook.xml'))
        props = book.find('s:workbookPr', NS)
        epoch = dt.datetime(1904, 1, 1) if props is not None and props.get('date1904') in ('1', 'true') else dt.datetime(1899, 12, 30)
        for sheet in book.find('s:sheets', NS):
            name = sheet.get('name')
            if name.lower() in ('sheet1', '透视表'):
                inventory.append({'sheet': name, 'role': '用户指定忽略'})
                continue
            target = rels[sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')]
            path = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
            root = ET.fromstring(archive.read(path))
            rows = []
            for row in root.findall('s:sheetData/s:row', NS):
                cells = {}
                for cell in row.findall('s:c', NS):
                    value = cell.find('s:v', NS)
                    value = value.text if value is not None else None
                    kind = cell.get('t')
                    if kind == 's' and value is not None:
                        value = shared[int(value)]
                    elif kind == 'inlineStr':
                        value = ''.join(t.text or '' for t in cell.findall('.//s:t', NS))
                    elif kind not in ('str', 'e', 'd') and value is not None:
                        value = Decimal(value)
                    cells[re.sub(r'\d', '', cell.get('r'))] = {'value': value, 'formula': cell.find('s:f', NS) is not None}
                rows.append({'row': int(row.get('r')), 'hidden': row.get('hidden') == '1', 'cells': cells})
            parsed[name] = rows
            inventory.append({'sheet': name, 'role': '业务明细' if name in FACT_SHEETS else '字典/汇总/图表', 'xmlRows': len(rows)})
    def val(row, col):
        return row['cells'].get(col, {}).get('value')
    def text(value):
        return '' if value is None else str(value).strip()
    def timestamp(value):
        if not isinstance(value, Decimal) or not value.is_finite():
            return None
        date = epoch + dt.timedelta(seconds=int((value * 86400).quantize(Decimal(1), rounding=ROUND_HALF_EVEN)))
        return date.isoformat(timespec='seconds') if 2000 <= date.year <= 2100 else None
    def zip_text(value, country='US'):
        result = text(value)
        if country != 'US' or not result:
            return result
        if result.isdigit() and len(result) <= 5:
            return result.rjust(5, '0')
        if result.isdigit() and len(result) == 9:
            return result[:5] + '-' + result[5:]
        return result if re.fullmatch(r'\d{5}-\d{4}', result) else ''
    candidates = collections.defaultdict(list)
    expected_rules = []
    for row in parsed['仓库详情']:
        if row['row'] < 3:
            continue
        code = text(val(row, 'A')).upper()
        if code:
            candidates[code].append({'code': code, 'city': text(val(row, 'C')), 'state': text(val(row, 'D')).upper(),
                                     'region': text(val(row, 'G')), 'group': text(val(row, 'H')), 'sourceRow': row['row'],
                                     'address': text(val(row, 'B')), 'postalCode': zip_text(val(row, 'E'))})
        if val(row, 'O') and isinstance(val(row, 'P'), Decimal) and isinstance(val(row, 'Q'), Decimal):
            expected_rules.append({'group': text(val(row, 'O')), 'reminderDays': float(val(row, 'P')), 'compensationDays': float(val(row, 'Q')),
                                   'sourceRow': row['row'], 'effectiveFrom': None, 'effectiveTo': None})
    expected_maps = {}
    for code, values in candidates.items():
        conflict = len({(r['city'].casefold(), r['state'], r['region'], r['group']) for r in values}) > 1
        expected_maps[code] = {**values[0], 'mappingConflict': conflict}
    for warehouse in dictionaries:
        code = warehouse['code']
        check(code not in review['excludedCodes'], code, 'excluded warehouse absent')
        expected = dict(expected_maps.get(code, {'code': code, 'city': '', 'state': '', 'region': '', 'group': '', 'address': '', 'postalCode': '', 'sourceRow': None, 'mappingConflict': False}))
        expected.update(country='US' if expected['state'] in STATES else '',
                        addressSource='workbook' if code in candidates else 'pending', referenceUrls=[], reviewedAt=None,
                        reviewNote=review['pendingNotes'].get(code, ''))
        patch = review['overrides'].get(code)
        if patch:
            expected.update({k: v for k, v in patch.items() if k not in ('sources', 'note')})
            expected.update(mappingConflict=False, addressSource='web', referenceUrls=patch['sources'],
                            reviewedAt=review['reviewedAt'], reviewNote=patch['note'])
        expected['postalCode'] = zip_text(expected['postalCode'], expected['country'])
        matched = bool(expected['city'] and expected['state'] and expected['country'] and not expected['mappingConflict'])
        expected.update(mappingStatus='matched' if matched else 'pending', verifiedUS=matched and expected['country'] == 'US')
        if not matched:
            expected.update(region='', group='')
        # Chinese labels are checked for completeness here; exact translations have unit coverage.
        if expected['state'] and expected['country']:
            check(bool(warehouse['stateNameZh']), code, 'Chinese state/province label')
        for field, value in expected.items():
            check(warehouse[field] == value, code, field, value, warehouse[field])
        expected_maps[code] = expected
    check(rules == expected_rules, '仓库详情', 'all rules')
    expected_sources, excluded_sources, sheet_totals, unresolved_nodes = set(), [], [], []
    node_count = 0
    for name in FACT_SHEETS:
        skipped, business, hidden, excluded_count, status_counts = [], 0, 0, 0, collections.Counter()
        for row in parsed[name]:
            number = row['row']
            if number == 1:
                continue
            # Check *all* input columns, including ones outside the extractor's row detection.
            input_cells = {col: c['value'] for col, c in row['cells'].items() if not c['formula'] and c['value'] not in (None, '')}
            is_business = any(val(row, col) not in (None, '') for col in ('A', 'B', 'C', 'F', 'K', 'L'))
            if not is_business:
                skipped.append({'row': number, 'inputColumns': sorted(input_cells), 'formulaColumns': [col for col, c in row['cells'].items() if c['formula']]})
                check(not input_cells, f'{name}!{number}', 'excluded row contains source input', [], sorted(input_cells))
                continue
            business += 1
            hidden += row['hidden']
            key, location = (name, number), f'{name}!{number}'
            code = text(val(row, 'K')).upper()
            if code in review['excludedCodes']:
                excluded_count += 1
                excluded_sources.append({'source': {'sheet': name, 'row': number}, 'code': code, **review['excludedCodes'][code]})
                check(key not in by_source, location, 'non-Amazon destination excluded')
                continue
            expected_sources.add(key)
            actual = by_source.get(key)
            check(actual is not None, location, 'row present')
            if not actual:
                continue
            nodes = {node: timestamp(val(row, column)) for node, column in NODE_COLUMNS.items()}
            for node, column in NODE_COLUMNS.items():
                node_count += 1
                check(nodes[node] == actual['nodes'][node], f'{name}!{column}{number}', node, nodes[node], actual['nodes'][node])
                if val(row, column) not in (None, '') and nodes[node] is None:
                    unresolved_nodes.append({'source': location, 'column': column, 'value': text(val(row, column))})
            status = 'invalid' if not nodes['departure'] or nodes['delivered'] and nodes['delivered'] < nodes['departure'] else 'arrived' if nodes['delivered'] else 'unknown'
            status_counts[status] += 1
            code = text(val(row, 'K')).upper()
            warehouse = expected_maps.get(code)
            group = text(val(row, 'V'))
            expected_fields = {'channel': text(val(row, 'A')), 'warehouse': code, 'status': status,
                               'channelGroup': '' if group.startswith('#') or group == '0' else group,
                               'region': warehouse['region'] if warehouse else '',
                               'group': warehouse['group'] if warehouse else ''}
            for field, expected in expected_fields.items():
                check(actual[field] == expected, location, field, expected, actual[field])
        descriptor = next(s for s in manifest['sheets'] if s['sheet'] == name)
        check(descriptor['businessRows'] == business and descriptor['excludedRows'] == excluded_count and descriptor['includedRows'] == business - excluded_count,
              name, 'source = included + excluded')
        sheet_totals.append({'sheet': name, 'business': business, 'included': business - excluded_count, 'excluded': excluded_count,
                             'hiddenBusinessRows': hidden, 'status': dict(status_counts), 'skipped': skipped})
    check(set(by_source) == expected_sources, 'records', 'source row coverage', len(expected_sources), len(by_source))
    check(manifest['exclusions']['records'] == len(excluded_sources), 'records', 'excluded count')
    check(manifest['exclusions']['codes'] == len({r['code'] for r in excluded_sources}), 'records', 'excluded code count')
    check(manifest['exclusions']['byCategory'] == dict(collections.Counter(r['category'] for r in excluded_sources)), 'records', 'exclusion categories')
    def date_range(rows, node):
        dates = sorted(r['nodes'][node][:10] for r in rows if r['nodes'][node])
        return [dates[0], dates[-1]] if dates else []
    def describe(rows):
        return {'records': len(rows), 'status': dict(collections.Counter(r['status'] for r in rows)),
                'departure': date_range(rows, 'departure'), 'delivered': date_range(rows, 'delivered'),
                'departureYears': dict(sorted(collections.Counter(r['nodes']['departure'][:4] for r in rows if r['nodes']['departure']).items()))}
    route = [r for r in records if r['warehouse'] == 'ONT8' and r['channel'] == '美森']
    current = [r for r in route if r['nodes']['departure'] and '2026-03-30' <= r['nodes']['departure'][:10] <= '2026-09-25']
    late = [r for r in records if r['nodes']['delivered'] and r['nodes']['delivered'][:10] in ('2026-09-24', '2026-09-25')]
    report = {'ok': not mismatches, 'sourceSha256': hashlib.sha256(source_bytes).hexdigest(), 'inventory': inventory,
              'summary': describe(records), 'sheetTotals': sheet_totals, 'checkedNodeCells': node_count,
              'exclusions': {'count': len(excluded_sources), 'rows': excluded_sources},
              'checkedWarehouses': len(dictionaries), 'checkedRules': len(rules), 'mismatches': mismatches,
              'unresolvedNonemptyNodes': unresolved_nodes,
              'yearBySheet': {name: describe([r for r in records if r['source']['sheet'] == name]) for name in FACT_SHEETS},
              'yearByDeparture': {year: describe([r for r in records if (r['nodes']['departure'] or '').startswith(year)]) for year in ('2025', '2026')},
              'invalidRows': [{k: r[k] for k in ('source', 'channel', 'warehouse', 'nodes', 'flags')} for r in records if r['status'] == 'invalid'],
              'monthlyDepartures': dict(sorted(collections.Counter(r['nodes']['departure'][:7] for r in records if r['nodes']['departure']).items())),
              'routeAll': describe(route), 'routeCurrent': describe(current),
              'lateDeliveries': {'count': len(late), 'byDate': dict(collections.Counter(r['nodes']['delivered'][:10] for r in late)),
                                 'rows': [{k: r[k] for k in ('source', 'channel', 'warehouse', 'nodes', 'status')} for r in late]},
              'routeLastRows': [{k: r[k] for k in ('source', 'channel', 'warehouse', 'nodes', 'status')} for r in sorted(route, key=lambda r: r['nodes']['delivered'] or '')[-3:]]}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({**{k: report[k] for k in ('ok', 'summary', 'checkedNodeCells', 'checkedWarehouses', 'checkedRules', 'yearBySheet', 'routeAll', 'routeCurrent')},
                      'skippedRows': {s['sheet']: len(s['skipped']) for s in sheet_totals}, 'mismatches': mismatches[:10], 'unresolvedNodes': len(unresolved_nodes),
                      'lateDeliveryCounts': report['lateDeliveries']['byDate'], 'output': str(output)}, ensure_ascii=False))
    if mismatches:
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--data-dir', type=Path, default=Path('public/transit'))
    parser.add_argument('--output', type=Path, default=Path('.local/transit/source-reconciliation.json'))
    args = parser.parse_args()
    main(args.source, args.data_dir, args.output)
