"""Read-only inventory/extraction for the 2026-10-07 quote workbooks.

The extractor deliberately keeps source values and formulas as evidence. Regular
price sheets are read through their last used row. Large reference tables and
mixed price/postcode sheets retain a bounded 500-row head plus a small tail.
"""
from __future__ import annotations
import argparse, datetime as dt, hashlib, json, os, re, sys, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import openpyxl

DEPS = Path(__file__).resolve().parents[1] / "analysis" / ".deps"
if DEPS.exists():
    sys.path.insert(0, str(DEPS))
try:
    import xlrd  # optional dependency for legacy BIFF .xls files
except Exception:
    xlrd = None

MAX_ROWS = 500
MAX_COLS = 100
TAIL_ROWS = 20
LARGE_ROWS = 5000
LARGE_CELLS = 50000

def read_policy(name: str, maxr: int, maxc: int):
    """Bound appendices, but never truncate a regular 628-row price sheet.

    Workbook dimensions often include formatting down to row 1,048,576. Large
    mixed sheets therefore need an explicit later adapter rather than allocating
    their entire rectangular range. Australian parcel sheets embed postcode lists.
    """
    appendix = re.search(r"邮编|偏远|分区|对照|地址库|仓库地址|FBA地址|汇总|查询|目录|首页|须知|必读|通讯|规则|清单|说明|发货|联系|反倾销|赔偿|赔付|模板|内陆义乌", name, re.I)
    mixed = maxr > MAX_ROWS and ("澳大利亚" in name or "英国专线小包" in name or "欧洲专线小包" in name or "全球专线-普货(欧洲)" in name)
    huge = maxr >= LARGE_ROWS
    if maxr > MAX_ROWS and (appendix or mixed or huge):
        reason = "mixed_price_reference" if mixed else "large_reference_or_formatted_dimension" if huge else "reference_or_query"
        return MAX_ROWS, True, reason
    return maxr, False, "full_price_sheet"

def serialise(v):
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray)):
        return f"<bytes:{len(v)}>"
    if isinstance(v, float) and v != v:
        return None
    # openpyxl represents dynamic/array formulas as lightweight objects.
    if type(v).__name__ in ("ArrayFormula", "DataTableFormula"):
        return getattr(v, "text", None) or getattr(v, "ref", None) or str(v)
    if not isinstance(v, (str, int, float, bool, type(None), list, dict)):
        return str(v)
    return v

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def agency_from_name(name: str) -> str:
    # Keep this conservative: file names are evidence, not a canonical vendor id.
    n = name
    for token in ["20261008", "2026", "VIP", "vip", "报价表", "价格表", "报价", "价格", "更新", "最新", "公布价"]:
        n = n.replace(token, " ")
    n = re.sub(r"[（(].*?[）)]|\d[\d.：: -]*|[._-]+", " ", n)
    return re.sub(r"\s+", " ", n).strip() or name

def xml_merges(path: Path):
    """Extract merge refs without loading a potentially huge workbook in memory."""
    if path.suffix.lower() not in (".xlsx", ".xlsm", ".xltx", ".xltm"):
        return {}
    out = {}
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
          "p": "http://schemas.openxmlformats.org/package/2006/relationships"}
    try:
        with zipfile.ZipFile(path) as z:
            wb = ET.fromstring(z.read("xl/workbook.xml"))
            rel = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
            rid_to_target = {}
            for x in rel:
                rid = x.attrib.get("Id")
                target = x.attrib.get("Target", "")
                if target.startswith("/"):
                    target = target[1:]
                elif not target.startswith("xl/"):
                    target = "xl/" + target
                rid_to_target[rid] = target
            sheets_element = wb.find("m:sheets", ns)
            for sh in list(sheets_element) if sheets_element is not None else []:
                title = sh.attrib.get("name")
                target = rid_to_target.get(sh.attrib.get("{" + ns["r"] + "}id"))
                if not target:
                    continue
                root = ET.fromstring(z.read(target))
                merge = root.find("m:mergeCells", ns)
                out[title] = [x.attrib.get("ref") for x in list(merge)] if merge is not None else []
    except Exception:
        return {}
    return out

def nonempty_row(cells):
    return any(c.get("value") is not None and c.get("value") != "" for c in cells)

def row_record(row_idx, row, cached_row=None):
    cells = []
    for j, cell in enumerate(row[:MAX_COLS], 1):
        val = serialise(cell.value)
        if val is None or val == "":
            continue
        item = {"coord": cell.coordinate if hasattr(cell, "coordinate") else f"{openpyxl.utils.get_column_letter(j)}{row_idx}",
                "value": val}
        if isinstance(val, str) and val.startswith("="):
            item["formula"] = val
            if cached_row is not None and j - 1 < len(cached_row):
                item["cached"] = serialise(cached_row[j - 1].value)
        cells.append(item)
    return {"row": row_idx, "cells": cells} if cells else None

def tail_rows_from_rows(rows):
    vals = [r for r in rows if r]
    return vals[-TAIL_ROWS:]

def extract_xlsx(path: Path, only_sheets: set[str] | None = None):
    merges = xml_merges(path)
    wb = openpyxl.load_workbook(path, read_only=True, data_only=False, keep_links=False)
    # A second read gives cached formula results where Excel stored them.
    try:
        cached_wb = openpyxl.load_workbook(path, read_only=True, data_only=True, keep_links=False)
    except Exception:
        cached_wb = None
    sheets = []
    for idx, ws in enumerate(wb.worksheets):
        if only_sheets is not None and ws.title not in only_sheets:
            continue
        cws = cached_wb.worksheets[idx] if cached_wb is not None else None
        maxr, maxc = int(ws.max_row or 0), int(ws.max_column or 0)
        row_limit, sampled, sampling_reason = read_policy(ws.title, maxr, maxc)
        reference = sampled
        first = []
        all_tail = []
        # Iterate once only over the bounded head; for tail, seek by row index.
        cached_iter = iter(cws.iter_rows(min_row=1, max_row=row_limit, max_col=min(MAX_COLS, maxc))) if cws else None
        for r, row in enumerate(ws.iter_rows(min_row=1, max_row=row_limit, max_col=min(MAX_COLS, maxc)), 1):
            cached_row = next(cached_iter, None) if cached_iter is not None else None
            rec = row_record(r, row, cached_row)
            if rec:
                first.append(rec)
        # Tail sampling by reopening the iterator and retaining the last 20 rows.
        for r, row in enumerate(ws.iter_rows(min_row=max(1, maxr - TAIL_ROWS + 1), max_row=maxr, max_col=min(MAX_COLS, maxc)), max(1, maxr - TAIL_ROWS + 1)):
            rec = row_record(r, row)
            if rec:
                all_tail.append(rec)
        sheets.append({"index": idx, "name": ws.title, "state": ws.sheet_state,
                       "rows": maxr, "cols": maxc, "reference": reference,
                       "head_rows_limit": row_limit, "requires_deeper_read": sampled,
                       "sampling_reason": sampling_reason,
                       "head": first,
                       "tail": all_tail, "merged_ranges": merges.get(ws.title, [])})
    if cached_wb is not None: cached_wb.close()
    wb.close()
    return sheets

def extract_xls(path: Path, only_sheets: set[str] | None = None):
    if xlrd is None:
        raise RuntimeError("xlrd is not installed; install xlrd==2.0.2 in analysis/.deps")
    book = xlrd.open_workbook(str(path), on_demand=True, formatting_info=True)
    sheets = []
    vis = list(getattr(book, "_sheet_visibility", []))
    for idx, name in enumerate(book.sheet_names()):
        if only_sheets is not None and name not in only_sheets:
            continue
        sh = book.sheet_by_index(idx)
        maxr, maxc = sh.nrows, sh.ncols
        row_limit, sampled, sampling_reason = read_policy(name, maxr, maxc)
        reference = sampled
        def make_row(r):
            cells = []
            for c in range(min(MAX_COLS, maxc)):
                raw_cell = sh.cell(r, c)
                val = xlrd.error_text_from_code.get(raw_cell.value, "#ERROR!") if raw_cell.ctype == xlrd.XL_CELL_ERROR else serialise(raw_cell.value)
                if val is None or val == "": continue
                cells.append({"coord": f"{openpyxl.utils.get_column_letter(c+1)}{r+1}", "value": val})
            return {"row": r+1, "cells": cells} if cells else None
        head = [x for x in (make_row(r) for r in range(row_limit)) if x]
        start = max(0, maxr - TAIL_ROWS)
        tail = [x for x in (make_row(r) for r in range(start, maxr)) if x]
        sheets.append({"index": idx, "name": name, "state": "hidden" if (idx < len(vis) and vis[idx]) else "visible",
                       "rows": maxr, "cols": maxc, "reference": reference,
                       "head_rows_limit": row_limit, "requires_deeper_read": sampled,
                       "sampling_reason": sampling_reason,
                       "formula_note": "xlrd exposes cached values but not original BIFF formula text",
                       "head": head, "tail": tail,
                       "merged_ranges": [
                           f"{openpyxl.utils.get_column_letter(c1+1)}{r1+1}:{openpyxl.utils.get_column_letter(c2)}{r2}"
                           for r1, r2, c1, c2 in getattr(sh, "merged_cells", [])]})
    book.release_resources()
    return sheets

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=r"D:\Wants\中航环球\报价表\2026.10.07")
    ap.add_argument("--output", default=r"D:\Wants\freight-forwarder-system\analysis\latest-extract.json")
    ap.add_argument("--refresh-incomplete", action="store_true", help="Only expand formerly sampled regular price sheets in the existing JSON")
    args = ap.parse_args()
    root = Path(args.root)
    if args.refresh_incomplete:
        output = Path(args.output)
        result = json.loads(output.read_text(encoding="utf-8"))
        count = 0
        for rec in result["files"]:
            wanted = set()
            for s in rec.get("sheets", []):
                limit, sampled, reason = read_policy(s["name"], s["rows"], s["cols"])
                if limit > s.get("head_rows_limit", MAX_ROWS) and not sampled:
                    wanted.add(s["name"])
                elif not sampled:
                    s.update(reference=False, requires_deeper_read=False, sampling_reason=reason)
            if not wanted:
                continue
            path = Path(rec["path"])
            expanded = extract_xls(path, wanted) if path.suffix.lower() == ".xls" else extract_xlsx(path, wanted)
            mapped = {s["name"]: s for s in expanded}
            rec["sheets"] = [mapped.get(s["name"], s) for s in rec["sheets"]]
            count += len(expanded)
            print(path.name, "expanded", ", ".join(wanted), flush=True)
        result["limits"]["regular_price_sheets"] = "complete; large/mixed/reference sheets retain bounded samples"
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print("expanded price sheets", count)
        return
    result = {"schema_version": "quote-workbook-extract/v1", "source_dir": str(root),
              "limits": {"head_rows": MAX_ROWS, "head_cols": MAX_COLS, "tail_rows": TAIL_ROWS},
              "files": []}
    for path in sorted(root.iterdir()):
        if path.suffix.lower() not in (".xlsx", ".xls", ".xlsm", ".xltx", ".xltm"):
            continue
        rec = {"id": hashlib.sha1(path.name.encode("utf-8")).hexdigest()[:12], "name": path.name,
               "path": str(path), "extension": path.suffix.lower().lstrip("."), "size_bytes": path.stat().st_size,
               "sha256": sha256(path), "agency_hint": agency_from_name(path.name), "readable": False}
        try:
            rec["sheets"] = extract_xls(path) if path.suffix.lower() == ".xls" else extract_xlsx(path)
            rec["readable"] = True
            rec["status"] = "reference sheets are head/tail sampled" if any(s["reference"] for s in rec["sheets"]) else "head/tail sampled"
        except Exception as e:
            rec["status"] = "error"
            rec["error"] = f"{type(e).__name__}: {e}"
        result["files"].append(rec)
        print(path.name, "OK" if rec["readable"] else rec.get("error"), flush=True)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", args.output)

if __name__ == "__main__": main()
