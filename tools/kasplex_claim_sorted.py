#!/usr/bin/env python3
"""Flatten the Kasplex NACHO oplist pull (CLAIM data, never replay input) into one opScore-ascending TSV.
Each seg-*.jsonl.gz is a descending page run; segments are checked to be disjoint opScore ranges,
then emitted in ascending order (no external sort needed).
Columns: opScore txid op tick amt from to utxo checkpoint opAccept extra(json: max/lim/pre/dec/mod/price)
usage: kasplex_claim_sorted.py OPS_DIR OUT.tsv.gz"""
import gzip, json, os, sys
ops_dir, out = sys.argv[1], sys.argv[2]
files = sorted(f for f in os.listdir(ops_dir) if f.endswith('.jsonl.gz'))
ranges = []
for f in files:
    lo = hi = None; n = 0
    with gzip.open(os.path.join(ops_dir, f), 'rt') as fh:
        for line in fh:
            if not line.strip(): continue
            s = int(json.loads(line)['opScore']); n += 1
            lo = s if lo is None else min(lo, s); hi = s if hi is None else max(hi, s)
    if n: ranges.append((lo, hi, n, f))
ranges.sort()
for a, b in zip(ranges, ranges[1:]):
    if a[1] >= b[0]: sys.exit(f'overlap {a} {b}')
seen = 0
with gzip.open(out, 'wt', compresslevel=3) as o:
    for lo, hi, n, f in ranges:
        rows = []
        with gzip.open(os.path.join(ops_dir, f), 'rt') as fh:
            for line in fh:
                if not line.strip(): continue
                d = json.loads(line)
                extra = {k: d[k] for k in ('max','lim','pre','dec','mod','price') if k in d}
                rows.append((int(d['opScore']), '\t'.join([d['opScore'], d['hashRev'], d['op'], d.get('tick') or d.get('ca',''), d.get('amt',''),
                    d.get('from',''), d.get('to',''), d.get('utxo',''), d.get('checkpoint',''), d.get('opAccept',''), json.dumps(extra, separators=(',',':')) if extra else ''])))
        rows.sort()
        for _, r in rows: o.write(r + '\n')
        seen += len(rows)
print(json.dumps({'segments': len(ranges), 'ops': seen, 'minOpScore': ranges[0][0], 'maxOpScore': ranges[-1][1]}))
