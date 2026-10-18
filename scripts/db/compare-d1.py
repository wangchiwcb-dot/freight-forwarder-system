"""Compare a downloaded D1 SQL export with the locally verified database."""
import argparse
import hashlib
import json
import sqlite3
import tempfile
from pathlib import Path


def fingerprint(db, table, columns, order):
    digest = hashlib.sha256()
    count = 0
    for row in db.execute(f'SELECT {",".join(columns)} FROM {table} ORDER BY {",".join(order)}'):
        digest.update(json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        digest.update(b'\n')
        count += 1
    return {'rows': count, 'sha256': digest.hexdigest()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--database', default='.local/d1-import/freight-quotes.sqlite')
    ap.add_argument('--remote-sql', required=True)
    ap.add_argument('--phase', choices=['staged', 'published'], default='staged')
    ap.add_argument('--output', default='.local/d1-import/remote-verification.json')
    args = ap.parse_args()
    local = sqlite3.connect(args.database)
    with tempfile.TemporaryDirectory(prefix='d1-verify-', dir='.local/d1-import') as temporary:
        remote = sqlite3.connect(str(Path(temporary) / 'remote.sqlite'))
        # The exported SQL has no transaction wrapper. Replay into this disposable
        # audit database in one transaction instead of fsyncing each of 250k rows.
        remote.executescript('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;')
        remote.executescript('BEGIN;\n' + Path(args.remote_sql).read_text(encoding='utf-8') + '\nCOMMIT;')
        results, differences = {}, []
        tables = [row[0] for row in local.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        for table in tables:
            if args.phase == 'staged' and table == 'audit_logs':
                continue
            columns = [r[1] for r in local.execute(f'PRAGMA table_info({table})')]
            order = [r[1] for r in sorted(local.execute(f'PRAGMA table_info({table})'), key=lambda r: r[5]) if r[5]]
            if args.phase == 'staged' and table == 'import_batches':
                columns = [c for c in columns if c not in ['status', 'published_at']]
            expected, actual = fingerprint(local, table, columns, order), fingerprint(remote, table, columns, order)
            results[table] = {'local': expected, 'remote': actual, 'matched': expected == actual}
            if expected != actual:
                differences.append(table)
        fk = remote.execute('PRAGMA foreign_key_check').fetchall()
        if fk:
            differences.append('foreign_keys')
        report = {'passed': not differences, 'phase': args.phase, 'tables': results, 'differences': differences, 'foreignKeyErrors': fk}
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        remote.close()
    local.close()
    print(json.dumps({'passed': report['passed'], 'tables': len(results), 'differences': differences}, ensure_ascii=False))
    if differences:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
