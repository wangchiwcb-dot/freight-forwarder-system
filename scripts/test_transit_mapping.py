"""Regression cases for the source workbook's ambiguous warehouse mappings."""
import importlib.util
import datetime as dt
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from transit_geography import STATE_NAMES, postal_code

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('extract_transit', ROOT / 'extract-transit.py')
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)
REVIEW = json.loads((ROOT / 'transit-warehouse-review.json').read_text(encoding='utf-8'))


def candidate(code, city, state, region, group, zip_code='', row=3):
    return dict(code=code, city=city, state=state, region=region, group=group,
                address='', postalCode=zip_code, sourceRow=row)


class WarehouseMappingTests(unittest.TestCase):
    def test_excluded_destinations_leave_public_files_and_remain_in_local_audit(self):
        headers = {'A': '渠道', 'C': '柜号', 'F': '开船时间', 'K': '仓库代码', 'L': '快递交付/送仓日期'}
        def fact(code):
            return {'A': '美森', 'C': 'example', 'F': 46000, 'K': code, 'L': 46020}
        sheets = {
            '2025': [(1, headers), (2, fact('ONT8')), (3, fact('ATL3')), (4, fact('MCO1'))],
            '2026数据源': [(1, headers), (2, fact('FEDEX/UPS'))],
            '仓库详情': [(3, {'A': 'ONT8', 'C': 'Moreno Valley', 'D': 'CA', 'E': '92551', 'G': '美西'})],
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, public, audit = root / 'source.xlsx', root / 'public', root / 'audit'
            source.write_bytes(b'read-only source fixture')
            public.mkdir()
            old_name = 'records-2025-aaaaaaaaaaaa.json'
            (public / old_name).write_text('["old excluded row"]', encoding='utf-8')
            (public / 'unrelated.txt').write_text('preserve', encoding='utf-8')
            with patch.object(extractor, 'read_xlsx', return_value=(sheets, dt.datetime(1899, 12, 30))), contextlib.redirect_stdout(io.StringIO()):
                extractor.extract(source, public, audit)
            manifest = json.loads((public / 'manifest.json').read_text(encoding='utf-8'))
            rows = [row for part in manifest['files'] if part['kind'] == 'records'
                    for row in json.loads((public / part['file']).read_text(encoding='utf-8'))]
            self.assertEqual([row['warehouse'] for row in rows], ['ONT8', 'MCO1'])
            self.assertIn('warehouse_operator_unconfirmed', rows[1]['flags'])
            self.assertEqual(manifest['exclusions']['records'], 2)
            self.assertEqual(len(json.loads((audit / 'source-rows.json').read_text(encoding='utf-8'))), 4)
            self.assertEqual(len(json.loads((audit / 'excluded-rows.json').read_text(encoding='utf-8'))), 2)
            self.assertFalse((public / old_name).exists())
            self.assertEqual(len(list((audit / 'archive').glob('*/' + old_name))), 1)
            self.assertTrue((public / 'unrelated.txt').exists())
            self.assertEqual(source.read_bytes(), b'read-only source fixture')

    def test_us_zip_keeps_leading_zero_and_extension(self):
        self.assertEqual(postal_code(8873), '08873')
        self.assertEqual(postal_code('08077'), '08077')
        self.assertEqual(postal_code('233211425'), '23321-1425')
        self.assertEqual(postal_code('23321-1425'), '23321-1425')
        self.assertEqual(postal_code('#N/A'), '')
        self.assertEqual(postal_code('55-040', 'PL'), '55-040')

    def test_orf2_uses_actual_warehouse_instead_of_ups_relay(self):
        rows = [candidate('ORF2', 'Richmond', 'VA', '美东', '组合-9', '23297'),
                candidate('ORF2', 'CHESAPEAKE', 'VA', '美东', '组合-9', '23321')]
        mapped = extractor.resolve_warehouse('ORF2', rows, REVIEW)
        self.assertEqual((mapped['city'], mapped['postalCode'], mapped['stateNameZh']),
                         ('Chesapeake', '23321-1425', '弗吉尼亚州'))
        self.assertEqual(mapped['group'], '组合-9')
        self.assertEqual(mapped['mappingStatus'], 'matched')
        self.assertFalse(mapped['mappingConflict'])

    def test_teb9_corrects_region_preserving_business_group(self):
        mapped = extractor.resolve_warehouse('TEB9', [candidate('TEB9', 'SOMERSET', 'NJ', '美西', '组合-9', '8873')], REVIEW)
        self.assertEqual((mapped['region'], mapped['postalCode'], mapped['stateNameZh'], mapped['group']),
                         ('美东', '08873', '新泽西州', '组合-9'))

    def test_new_warehouse_does_not_require_an_invented_business_group(self):
        mapped = extractor.resolve_warehouse('PSP3', [], REVIEW)
        self.assertEqual((mapped['city'], mapped['postalCode'], mapped['region']),
                         ('Desert Hot Springs', '92240', '美西'))
        self.assertEqual(mapped['mappingStatus'], 'matched')
        self.assertEqual(mapped['group'], '')

    def test_european_amazon_warehouse_is_matched_without_becoming_us(self):
        mapped = extractor.resolve_warehouse('BER8', [], REVIEW)
        self.assertEqual((mapped['country'], mapped['postalCode'], mapped['region']), ('DE', '12529', '欧洲'))
        self.assertEqual(mapped['mappingStatus'], 'matched')
        self.assertFalse(mapped['verifiedUS'])

    def test_typo_candidates_are_not_silently_merged(self):
        for code in ('P0C1', '1GQ2', 'MC14', 'SKC8'):
            with self.subTest(code=code):
                mapped = extractor.resolve_warehouse(code, [], REVIEW)
                self.assertEqual(mapped['code'], code)
                self.assertEqual(mapped['mappingStatus'], 'pending')
                self.assertEqual(mapped['city'], '')

    def test_state_labels_are_complete_and_not_shifted(self):
        self.assertEqual(len(STATE_NAMES), 51)
        self.assertEqual(STATE_NAMES['CA'], '加利福尼亚州')
        self.assertEqual(STATE_NAMES['MO'], '密苏里州')
        self.assertEqual(STATE_NAMES['MS'], '密西西比州')
        self.assertEqual(STATE_NAMES['DC'], '哥伦比亚特区')
        self.assertEqual(STATE_NAMES['WY'], '怀俄明州')


if __name__ == '__main__':
    unittest.main()
