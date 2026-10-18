"""Verify immutable facts and real-workbook regression cases after refinement."""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


def fingerprint(db, table, columns):
    pk = [r[1] for r in sorted(db.execute(f'PRAGMA table_info({table})'), key=lambda r: r[5]) if r[5]]
    h = hashlib.sha256()
    n = 0
    for row in db.execute(f'SELECT {",".join(columns)} FROM {table} ORDER BY {",".join(pk)}'):
        h.update(json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode())
        h.update(b'\n')
        n += 1
    return {'rows': n, 'sha256': h.hexdigest()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--database', default='.local/d1-refinement/freight-quotes.sqlite')
    ap.add_argument('--baseline')
    ap.add_argument('--if-applied', action='store_true', help='Skip semantic checks on a database that still uses migration 0001')
    ap.add_argument('--output', default='.local/d1-refinement/refinement-verification.json')
    args = ap.parse_args()
    db = sqlite3.connect(f'file:{Path(args.database).as_posix()}?mode=ro', uri=True)
    if args.if_applied and 'semantic_parser_version' not in [r[1] for r in db.execute('PRAGMA table_info(quote_versions)')]:
        print(json.dumps({'applied': False, 'skipped': True, 'reason': 'Semantic refinement has not been applied to this database'}))
        db.close()
        return
    failures, invariants, cases = [], {}, []

    def check(ok, message):
        if not ok:
            failures.append(message)

    if args.baseline:
        old = sqlite3.connect(f'file:{Path(args.baseline).as_posix()}?mode=ro', uri=True)
        stable = ['providers', 'channels', 'source_files', 'dataset_snapshots', 'import_batches',
                  'snapshot_batches', 'quote_rules', 'quote_targets', 'import_rows', 'app_users', 'quote_tiers']
        for table in stable + ['quote_versions', 'warehouses']:
            columns = [r[1] for r in old.execute(f'PRAGMA table_info({table})')]
            if table == 'quote_versions':
                columns = [c for c in columns if c not in ['quote_item_id', 'tax_mode', 'duty_inclusion', 'vat_inclusion', 'tax_settlement', 'tax_evidence']]
            before, after = fingerprint(old, table, columns), fingerprint(db, table, columns)
            invariants[table] = {'before': before, 'after': after, 'matched': before == after}
            check(before == after, f'Immutable facts changed in {table}')
        for row in old.execute('SELECT id,quote_version_id,tier_id,amount_micros,amount_decimal,currency FROM quote_charge_rules'):
            actual = db.execute('SELECT id,quote_version_id,tier_id,amount_micros,amount_decimal,currency FROM quote_charge_rules WHERE id=?', (row[0],)).fetchone()
            check(row == actual, 'Original fixed fee changed: ' + row[0])
        old.close()

    check(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'SQLite integrity')
    check(not db.execute('PRAGMA foreign_key_check').fetchall(), 'Foreign keys')
    check(db.execute("SELECT count(*) FROM quote_versions WHERE semantic_parser_version<>'quote-semantics/2'").fetchone()[0] == 0, 'Incomplete semantic refinement')
    check(db.execute("SELECT count(*) FROM import_issues WHERE severity='review' AND resolved_at IS NULL").fetchone()[0] == 0, 'Old review flags not consolidated')
    check(db.execute("SELECT count(*) FROM import_issues WHERE severity='error' AND resolved_at IS NULL").fetchone()[0] == 0, 'Unresolved import errors')
    check(db.execute("SELECT count(*) FROM quote_tiers WHERE tax_evidence_kind='legacy'").fetchone()[0] == 0, 'Unrefined tiers')
    check(db.execute("SELECT count(*) FROM quote_tiers WHERE tax_evidence_kind='business_default' AND (tax_mode<>'included' OR tax_settlement<>'unknown')").fetchone()[0] == 0, 'Default policy incorrectly applied')
    check(db.execute("SELECT count(*) FROM quote_tiers WHERE tax_settlement IN ('deferred','customer_tax','deferred_or_customer_tax') AND (tax_mode='included' OR vat_inclusion<>'excluded')").fetchone()[0] == 0, 'VAT self/deferred mislabeled as tax included')
    check(db.execute("SELECT count(*) FROM import_issues WHERE resolution='已归并至共享复核任务' AND review_task_id IS NULL").fetchone()[0] == 0, 'Lost grouped review flags')
    # Numerical prices were independently checked against actual workbooks in the
    # initial migration; invariants above prove those exact values did not change.
    expected = [
        ('xinghang', '美西FBA海卡-定提', 'E60', 'excluded', 'unknown'),
        ('lingxun', '全球专线-超敏感', 'D14', 'included', 'unknown'),
        ('yingmei', '英国空派带电', 'C4', 'conditional', 'customer_tax'),
        ('yingmei', '英国空派带电', 'C7', 'conditional', 'deferred'),
        ('yingmei', '英国空派带电', 'C10', 'included', 'unknown'),
        ('zhuofan', '英国海运特惠系', 'D3', 'conditional', 'customer_tax'),
        ('zhuofan', '英国海运特惠系', 'D4', 'conditional', 'deferred'),
        ('zhuofan', '英国海运特惠系', 'D5', 'included', 'unknown'),
        ('zhuofan', '英国铁路', 'C24', 'included', 'unknown'),
        ('zhonghang', '欧洲卡航包税（航乐）', 'D21', 'conditional', 'deferred'),
    ]
    for provider, sheet, cell, mode, settlement in expected:
        actual = db.execute('''SELECT t.tax_mode,t.tax_settlement,t.tax_evidence FROM quote_tiers t
          JOIN quote_versions v ON v.id=t.quote_version_id JOIN import_batches b ON b.id=v.batch_id
          JOIN import_rows r ON r.quote_version_id=v.id WHERE b.provider_id=? AND r.sheet_name=? AND t.source_cell=?''', (provider, sheet, cell)).fetchall()
        ok = bool(actual) and all(r[:2] == (mode, settlement) for r in actual)
        cases.append({'provider': provider, 'sheet': sheet, 'cell': cell, 'expected': [mode, settlement], 'actual': actual, 'passed': ok})
        check(ok, f'Regression {provider}/{sheet}!{cell}')

    fee = db.execute('''SELECT c.amount_decimal,c.charge_basis,c.review_status FROM quote_charge_rules c
      JOIN quote_tiers t ON t.id=c.tier_id JOIN import_rows r ON r.quote_version_id=c.quote_version_id
      JOIN quote_versions v ON v.id=r.quote_version_id JOIN import_batches b ON b.id=v.batch_id
      WHERE b.provider_id='lingxun' AND r.sheet_name='全球专线-超敏感' AND t.source_cell='D14' ''').fetchall()
    check(bool(fee) and all(r == ('34', 'shipment', 'verified') for r in fee), 'Lingxun processing fee per shipment')
    cargo = db.execute('''SELECT c.acceptance FROM quote_cargo_types c JOIN import_rows r ON r.quote_version_id=c.quote_version_id
       JOIN quote_tiers t ON t.quote_version_id=c.quote_version_id JOIN quote_versions v ON v.id=c.quote_version_id
       JOIN import_batches b ON b.id=v.batch_id WHERE b.provider_id='lingxun' AND r.sheet_name='全球专线-超敏感'
       AND t.source_cell='D14' AND c.cargo_type='health_supplement' ''').fetchall()
    check(bool(cargo) and all(r == ('allowed',) for r in cargo), 'Lingxun supplements acceptance')
    for fee_code, amount, conditions in [('liftgate', '60', {'recipient_can_unload': False}),
        ('residential', '100', {'address_type': 'residential', 'postal_prefixes': ['75', '76']})]:
        actual = db.execute('''SELECT c.amount_decimal,c.currency,c.charge_basis,c.conditions_json FROM quote_charge_rules c
          JOIN import_rows r ON r.quote_version_id=c.quote_version_id JOIN quote_versions v ON v.id=c.quote_version_id
          JOIN import_batches b ON b.id=v.batch_id WHERE b.provider_id='yiyang' AND r.sheet_name='休斯顿普船商私卡' AND c.fee_code=?''', (fee_code,)).fetchall()
        check(bool(actual) and all(r[:3] == (amount, 'USD', 'shipment') and json.loads(r[3]) == conditions for r in actual), 'Yiyang conditional surcharge: ' + fee_code)

    report = {'passed': not failures, 'invariants': invariants, 'regressions': cases, 'failures': failures,
              'quoteVersions': db.execute('SELECT count(*) FROM quote_versions').fetchone()[0],
              'priceTiers': db.execute('SELECT count(*) FROM quote_tiers').fetchone()[0],
              'openTasks': db.execute("SELECT count(*) FROM review_tasks WHERE status='open'").fetchone()[0]}
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k not in ['invariants', 'regressions']}, ensure_ascii=False))
    db.close()
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
