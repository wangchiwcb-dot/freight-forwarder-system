"""Generate a dependency-ordered D1 data patch from a verified SQLite revision."""
import argparse
import json
import sqlite3
from pathlib import Path


def literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--baseline', default='.local/d1-refinement/before.sqlite')
    ap.add_argument('--database', default='.local/d1-refinement/freight-quotes.sqlite')
    ap.add_argument('--output', default='.local/d1-refinement/refinement.sql')
    args = ap.parse_args()
    before = sqlite3.connect(f'file:{Path(args.baseline).as_posix()}?mode=ro', uri=True)
    after = sqlite3.connect(f'file:{Path(args.database).as_posix()}?mode=ro', uri=True)
    tables = [r[0] for r in after.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    original_tables = {r[0] for r in before.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    dependencies = {t: {r[2] for r in after.execute(f'PRAGMA foreign_key_list({t})')} for t in tables}
    order = []
    while len(order) < len(tables):
        available = [t for t in tables if t not in order and dependencies[t].issubset(order)]
        if not available:
            raise ValueError('Cyclic table dependencies')
        order.extend(available)
    stats, deletes = {}, {}
    with Path(args.output).open('w', encoding='utf-8', newline='\n') as out:
        for table in order:
            info = after.execute(f'PRAGMA table_info({table})').fetchall()
            columns = [r[1] for r in info]
            primary = [r[1] for r in sorted(info, key=lambda r: r[5]) if r[5]]
            indexes = [columns.index(c) for c in primary]
            key = lambda row: tuple(row[i] for i in indexes)
            old_columns = [r[1] for r in before.execute(f'PRAGMA table_info({table})')] if table in original_tables else []
            old = {}
            if old_columns:
                for row in before.execute(f'SELECT * FROM {table}'):
                    values = dict(zip(old_columns, row))
                    old[tuple(values[c] for c in primary)] = values
            retained, changed = set(), 0
            for row in after.execute(f'SELECT * FROM {table}'):
                row_key = key(row)
                retained.add(row_key)
                values = dict(zip(columns, row))
                if old.get(row_key) == values:
                    continue
                assignments = ','.join(f'{c}=excluded.{c}' for c in columns if c not in primary)
                suffix = f'DO UPDATE SET {assignments}' if assignments else 'DO NOTHING'
                sql = f'INSERT INTO {table} ({",".join(columns)}) VALUES ({",".join(literal(v) for v in row)}) ON CONFLICT({",".join(primary)}) {suffix};\n'
                if len(sql.encode()) > 95000:
                    raise ValueError('D1 statement too large: ' + table)
                out.write(sql)
                changed += 1
            deletes[table] = ['DELETE FROM '+table+' WHERE '+' AND '.join(f'{c}={literal(v)}' for c, v in zip(primary, k))+';\n' for k in old if k not in retained]
            stats[table] = {'upserted': changed, 'deleted': len(deletes[table])}
        for table in reversed(order):
            out.writelines(deletes[table])
    Path(args.output).with_suffix('.summary.json').write_text(json.dumps(stats, indent=2), encoding='utf-8')
    print(json.dumps(stats))
    before.close()
    after.close()


if __name__ == '__main__':
    main()
