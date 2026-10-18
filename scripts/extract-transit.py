"""Read-only, complete XLSX extraction for the transit dashboard (stdlib only).

Only the two explicitly selected fact sheets and warehouse dictionary are read.
No formula is executed. Dates are recalculated from source nodes, not formula caches.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from transit_geography import STATE_NAMES, postal_code

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
SHEETS = ('2025', '2026数据源')
STATES = set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split())
NODES = {'departure': 'F', 'arrival': 'G', 'unloaded': 'H', 'pickup': 'I', 'devanning': 'J', 'delivered': 'L'}
REVIEW_PATH = Path(__file__).with_name('transit-warehouse-review.json')


def resolve_warehouse(code, candidates, review):
    first = candidates[0] if candidates else {'code': code, 'city': '', 'state': '', 'region': '', 'group': '',
                                            'address': '', 'postalCode': '', 'sourceRow': None}
    identities = {(c['city'].casefold(), c['state'], c['region'], c['group']) for c in candidates}
    conflict = len(identities) > 1
    override = review['overrides'].get(code)
    value = {**first, 'country': 'US' if first['state'] in STATES else '',
             'mappingConflict': conflict, 'addressSource': 'workbook' if candidates else 'pending',
             'referenceUrls': [], 'reviewedAt': None, 'reviewNote': review['pendingNotes'].get(code, '')}
    if override:
        value.update({k: v for k, v in override.items() if k not in ('sources', 'note')})
        value.update(mappingConflict=False, addressSource='web', referenceUrls=override['sources'],
                     reviewedAt=review['reviewedAt'], reviewNote=override['note'])
    value['stateNameZh'] = value.get('stateNameZh', STATE_NAMES.get(value['state'], '') if value['country'] == 'US' else '')
    value['postalCode'] = postal_code(value['postalCode'], value['country'])
    value['mappingStatus'] = 'matched' if value['city'] and value['state'] and value['country'] and not value['mappingConflict'] else 'pending'
    value['verifiedUS'] = value['mappingStatus'] == 'matched' and value['country'] == 'US'
    if value['mappingStatus'] == 'pending':
        value['region'], value['group'] = '', ''
    return value


def digest(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:20]


def text(value):
    return str(value).strip() if value is not None else ''


def read_xlsx(source: Path):
    with zipfile.ZipFile(source) as archive:
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(n.text or '' for n in si.findall('.//s:t', NS))
                       for si in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('s:si', NS)]
        rels = {r.get('Id'): r.get('Target') for r in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        props = workbook.find('s:workbookPr', NS)
        epoch = dt.datetime(1904, 1, 1) if props is not None and props.get('date1904') in ('1', 'true') else dt.datetime(1899, 12, 30)
        sheets = {}
        for sheet in workbook.find('s:sheets', NS):
            name = sheet.get('name')
            if name not in (*SHEETS, '仓库详情'):
                continue
            rid = sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
            target = rels[rid]
            path = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
            root = ET.fromstring(archive.read(path))
            rows = []
            for row in root.findall('s:sheetData/s:row', NS):
                values = {}
                for cell in row.findall('s:c', NS):
                    v = cell.find('s:v', NS)
                    value = v.text if v is not None else None
                    kind = cell.get('t')
                    if kind == 's' and value is not None:
                        value = strings[int(value)]
                    elif kind == 'inlineStr':
                        value = ''.join(n.text or '' for n in cell.findall('.//s:t', NS))
                    elif value is not None and kind not in ('str', 'e'):
                        value = float(value)
                        if value.is_integer():
                            value = int(value)
                    values[re.sub(r'\d+', '', cell.get('r'))] = value
                rows.append((int(row.get('r')), values))
            sheets[name] = rows
        if set(sheets) != {*SHEETS, '仓库详情'}:
            raise ValueError('Missing required sheets; refusing a partial import')
        return sheets, epoch


def serial_date(value, epoch):
    # Values outside supported operational dates, and all free-form text, are unresolved.
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    result = epoch + dt.timedelta(seconds=round(value * 86400))
    if not 2000 <= result.year <= 2100:
        return None
    return result.isoformat(timespec='seconds')


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def extract(source: Path, output: Path, audit_dir: Path):
    sheets, epoch = read_xlsx(source)
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    # Universal newline reading makes the policy hash stable across Git checkouts.
    review_text = REVIEW_PATH.read_text(encoding='utf-8')
    review = json.loads(review_text)
    review_hash = hashlib.sha256(review_text.encode('utf-8')).hexdigest()
    warehouse_candidates = collections.defaultdict(list)
    rules = []
    for row_number, row in sheets['仓库详情']:
        if row_number < 3:
            continue
        code = text(row.get('A')).upper()
        if code and code not in review['excludedCodes']:
            warehouse_candidates[code].append({
                'code': code, 'city': text(row.get('C')), 'state': text(row.get('D')).upper(),
                'region': text(row.get('G')), 'group': text(row.get('H')),
                'address': text(row.get('B')), 'postalCode': postal_code(row.get('E')),
                'sourceRow': row_number,
            })
        if row.get('O') and isinstance(row.get('P'), (int, float)) and isinstance(row.get('Q'), (int, float)):
            rules.append({'group': text(row['O']), 'reminderDays': row['P'], 'compensationDays': row['Q'],
                          'effectiveFrom': None, 'effectiveTo': None, 'sourceRow': row_number})
    warehouse_map = {}
    used_input_codes = {text(row.get('K')).upper() for name in SHEETS for n, row in sheets[name] if n > 1}
    for code in used_input_codes - review['excludedCodes'].keys():
        warehouse_map[code] = resolve_warehouse(code, warehouse_candidates.get(code, []), review)

    records, audit, excluded, sheet_counts = [], [], [], []
    candidates = collections.defaultdict(list)
    for name in SHEETS:
        count, skipped, excluded_count = 0, 0, 0
        for row_number, row in sheets[name]:
            if row_number == 1:
                # F is authoritative in both years; 2025 also has a misleading E header.
                for col, expected in {'A': '渠道', 'C': '柜号', 'F': '开船时间', 'K': '仓库代码', 'L': '快递交付/送仓日期'}.items():
                    if row.get(col) != expected:
                        raise ValueError(f'{name}!{col}1 header changed; update the adapter explicitly')
                continue
            if not any(row.get(k) not in (None, '') for k in ('A', 'B', 'C', 'F', 'K', 'L')):
                skipped += 1
                continue
            count += 1
            nodes = {key: serial_date(row.get(col), epoch) for key, col in NODES.items()}
            code, channel = text(row.get('K')).upper(), text(row.get('A'))
            source_ref = {'sheet': name, 'row': row_number}
            row_id = 'tr_' + digest(f'{source.name}|{name}|{row_number}')
            audit.append({'id': row_id, 'source': source_ref, 'raw': row})
            if code in review['excludedCodes']:
                excluded_count += 1
                excluded.append({'id': row_id, 'source': source_ref, 'code': code, **review['excludedCodes'][code]})
                continue
            warehouse = warehouse_map.get(code)
            flags = []
            if code in review.get('operatorAmbiguousCodes', []):
                flags.append('warehouse_operator_unconfirmed')
            if not channel:
                flags.append('missing_channel')
            if not warehouse or warehouse['mappingStatus'] != 'matched':
                flags.append('unverified_warehouse')
            if warehouse and warehouse['mappingConflict']:
                flags.append('warehouse_conflict')
            if not nodes['departure']:
                flags.append('missing_departure')
            if not nodes['delivered']:
                flags.append('missing_delivery')
            if nodes['departure'] and nodes['delivered'] and nodes['delivered'] < nodes['departure']:
                flags.append('negative_total')
            dated = [v for v in nodes.values() if v]
            if any(a > b for a, b in zip(dated, dated[1:])):
                flags.append('reversed_stage')
            if any(text(row.get(k)).startswith(('#N/A', '#REF!', '#VALUE!', '#DIV/0!')) for k in ('U', 'V', 'P', 'Q')):
                flags.append('lookup_error')
            group = text(row.get('V'))
            if group.startswith('#') or group == '0':
                group = ''
            record = {
                'id': row_id,
                'containerTripId': ('ct_' + digest(f'{text(row.get("C")).upper()}|{nodes["departure"]}')) if row.get('C') else None,
                'channel': channel, 'warehouse': code, 'region': warehouse['region'] if warehouse else '',
                'group': warehouse['group'] if warehouse else '',
                'channelGroup': group, 'nodes': nodes,
                'status': 'invalid' if 'negative_total' in flags or 'missing_departure' in flags else 'arrived' if nodes['delivered'] else 'unknown',
                'flags': flags, 'duplicateGroup': None, 'source': {'sheet': name, 'row': row_number},
            }
            records.append(record)
            if all(row.get(k) not in (None, '') for k in ('A', 'C', 'F', 'K', 'L')):
                candidates[tuple(text(row.get(k)) for k in ('A', 'C', 'F', 'K', 'L'))].append(record)
        sheet_counts.append({'sheet': name, 'inputRows': len(sheets[name]) - 1, 'businessRows': count,
                             'includedRows': count - excluded_count, 'excludedRows': excluded_count, 'skippedRows': skipped})
    duplicate_groups = [values for values in candidates.values() if len(values) > 1]
    for values in duplicate_groups:
        group = 'dup_' + digest('|'.join(r['id'] for r in values))
        for record in values:
            record['duplicateGroup'] = group
            record['flags'].append('duplicate_candidate')
    used_codes = sorted({r['warehouse'] for r in records if r['warehouse']})
    warehouses = [warehouse_map[code] for code in used_codes]
    valid = [r for r in records if r['status'] == 'arrived']
    flags = dict(sorted(collections.Counter(flag for r in records for flag in r['flags']).items()))
    output.mkdir(parents=True, exist_ok=True)
    files = []

    def write_file(kind, label, value, count):
        contents = encode(value)
        sha = hashlib.sha256(contents).hexdigest()
        filename = f'{label}-{sha[:12]}.json'
        (output / filename).write_bytes(contents)
        descriptor = {'kind': kind, 'file': filename, 'sha256': sha, 'bytes': len(contents), 'count': count}
        files.append(descriptor)

    by_year = collections.defaultdict(list)
    for record in records:
        by_year[(record['nodes']['departure'] or 'unknown')[:4]].append(record)
    for year, values in sorted(by_year.items()):
        write_file('records', 'records-' + year, values, len(values))
    write_file('warehouses', 'warehouses', warehouses, len(warehouses))
    write_file('rules', 'rules', rules, len(rules))
    manifest = {
        'schemaVersion': 2, 'metricsVersion': 'elapsed-naive-seconds_nearest-rank_v1',
        'version': digest(source_hash + review_hash + ''.join(f['sha256'] for f in files)), 'sourceFile': source.name, 'sourceSha256': source_hash,
        'warehouseReviewSha256': review_hash, 'warehouseReviewedAt': review['reviewedAt'],
        'exclusions': {'records': len(excluded), 'codes': len({r['code'] for r in excluded}),
                       'byCategory': dict(collections.Counter(r['category'] for r in excluded))},
        'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'dataThrough': max(r['nodes']['delivered'] for r in valid)[:10],
        'departureRange': [min(r['nodes']['departure'] for r in valid)[:10], max(r['nodes']['departure'] for r in valid)[:10]],
        'counts': {'records': len(records), 'arrived': len(valid), 'unknown': sum(r['status'] == 'unknown' for r in records),
                   'invalid': sum(r['status'] == 'invalid' for r in records), 'warehouseCodes': len(used_codes),
                   'duplicateGroups': len(duplicate_groups), 'duplicateExtraRows': sum(len(g) - 1 for g in duplicate_groups)},
        'flags': flags, 'sheets': sheet_counts, 'files': files,
    }
    # Publish the manifest last so a failed extraction cannot advertise incomplete files.
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    audit_dir.mkdir(parents=True, exist_ok=True)
    (audit_dir / 'source-rows.json').write_bytes(encode(audit))
    (audit_dir / 'excluded-rows.json').write_bytes(encode(excluded))
    (audit_dir / 'quality-report.json').write_bytes(encode({**manifest, 'issues': [r for r in records if r['flags']]}))
    # Vite copies every public file: retire superseded shards so excluded data
    # cannot remain downloadable under an old hashed filename.
    active_files = {part['file'] for part in files}
    retired = [path for path in output.iterdir() if path.is_file() and path.name not in active_files
               and re.fullmatch(r'(?:records-[\w-]+|warehouses|rules)-[0-9a-f]{12}\.json', path.name)]
    if retired:
        archive_dir = audit_dir / 'archive' / dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%f')
        archive_dir.mkdir(parents=True)
        for path in retired:
            path.rename(archive_dir / path.name)
    print(json.dumps({'output': str(output), 'counts': manifest['counts'], 'flags': flags, 'sheets': sheet_counts}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=Path('public/transit'))
    parser.add_argument('--audit-dir', type=Path, default=Path('.local/transit'))
    args = parser.parse_args()
    extract(args.source, args.output, args.audit_dir)
