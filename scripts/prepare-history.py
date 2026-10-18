"""Extract historical Excel files without changing the published frontend snapshot.

Reuse cached extraction only when the file SHA-256 matches. Keep originals in place.
Every file is registered, including backups and non-quote workbooks.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from extract_workbooks import extract_xls, extract_xlsx, sha256, agency_from_name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    ap.add_argument('--output', default='.local/history')
    ap.add_argument('--cache', default='analysis/latest-extract.json')
    args = ap.parse_args()
    root = Path(args.root).resolve()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    cache = {}
    cache_path = Path(args.cache)
    if cache_path.exists():
        for f in json.loads(cache_path.read_text(encoding='utf-8'))['files']:
            if f.get('readable'):
                cache[f['sha256']] = f
    manifest = {'root': str(root), 'snapshots': []}
    for folder in sorted(p for p in root.iterdir() if p.is_dir()):
        folder_out = out / folder.name
        folder_out.mkdir(exist_ok=True)
        extract_path = folder_out / 'extract.json'
        if extract_path.exists():
            for f in json.loads(extract_path.read_text(encoding='utf-8'))['files']:
                if f.get('readable'):
                    cache[f['sha256']] = f
        result = {'schema_version': 'quote-workbook-extract/v1', 'source_dir': str(folder), 'files': []}
        for file in sorted(folder.rglob('*')):
            if not file.is_file() or file.suffix.lower() not in ('.xls', '.xlsx', '.xlsm', '.xltx', '.xltm') or file.name.startswith('~$'):
                continue
            digest = sha256(file)
            record = {'id': hashlib.sha1(file.name.encode()).hexdigest()[:12], 'name': file.name,
                      'path': str(file), 'extension': file.suffix.lower()[1:], 'size_bytes': file.stat().st_size,
                      'sha256': digest, 'agency_hint': agency_from_name(file.name), 'readable': False}
            if '货箱材积明细' in file.name:
                record.update(status='excluded_non_quote', error='货箱明细，不是代理报价表', sheets=[])
            elif digest in cache:
                record.update(sheets=cache[digest]['sheets'], readable=True, status='cached_verified_sha256')
            else:
                try:
                    record.update(sheets=extract_xls(file) if file.suffix.lower() == '.xls' else extract_xlsx(file),
                                  readable=True, status='extracted')
                    cache[digest] = record
                except Exception as exc:
                    record.update(status='failed', error=f'{type(exc).__name__}: {exc}', sheets=[])
            result['files'].append(record)
            print(folder.name, file.name, record['status'], flush=True)
        if not result['files']:
            continue
        extract_path.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
        data_dir = folder_out / 'data'
        subprocess.run(['node', 'scripts/normalize-quotes.mjs', str(extract_path), str(data_dir)], check=True)
        manifest['snapshots'].append({'name': folder.name, 'observedDate': folder.name.replace('.', '-'),
                                      'kind': 'historical_excel', 'dataDir': str(data_dir), 'extract': str(extract_path)})
    manifest_path = out / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Manifest:', manifest_path, flush=True)


if __name__ == '__main__':
    main()
