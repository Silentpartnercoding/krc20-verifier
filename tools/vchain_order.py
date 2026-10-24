#!/usr/bin/env python3
"""Build accept_order.tsv (chainBlock daa txId rank) from vchain.tsv (node acceptance order per chain block).

  build_order.py vchain.tsv units_multi.tsv OUT_accept_order.tsv OUT_stats.json [tail_acceptance.tsv]

units_multi.tsv: chainBlock daa txid,txid,...  (multi-tx units; single-tx units need no order).
With tail_acceptance.tsv, tail chain blocks holding >1 accepted tx are added as units too.
A unit is written only when every one of its txs is listed under that chain block in vchain.tsv; its rank is the
API list position. Units not fully covered are counted and left to the caller's fallback (txid sort).
"""
import json, sys
from collections import defaultdict
vc, um, out, st = sys.argv[1:5]
tail = sys.argv[5] if len(sys.argv) > 5 else None
pos = {}; daa = {}
for l in open(vc):
    f = l.rstrip("\n").split("\t")
    daa[f[1]] = int(f[3])
    for h in (f[5].split(",") if f[5] else []):
        t, j = h.split(":"); pos[(f[1], t)] = int(j)
units = {}
for l in open(um):
    c, d, txs = l.rstrip("\n").split("\t"); units[c] = (int(d), txs.split(","))
if tail:
    cb = defaultdict(list)
    for l in open(tail):
        f = l.rstrip("\n").split("\t")
        if len(f) >= 6 and f[1] == "1": cb[f[2]].append(f[0])
    for c, txs in cb.items():
        if len(txs) > 1 and c not in units: units[c] = (None, txs)
s = defaultdict(int); rows = []
for c in sorted(units):
    d, txs = units[c]
    if c not in daa: s["chainNotFetched"] += 1; continue
    if d is not None and d != daa[c]: s["daaMismatch"] += 1
    if any((c, t) not in pos for t in txs): s["txNotUnderChain"] += 1; continue
    s["unitsOrdered"] += 1
    o = sorted(txs, key=lambda t: pos[(c, t)])
    if o != sorted(txs): s["unitsDifferFromTxid"] += 1
    for r, t in enumerate(o): rows.append(f"{c}\t{daa[c]}\t{t}\t{r}\n")
s["units"] = len(units)
open(out, "w").writelines(rows)
json.dump(dict(s), open(st, "w"), indent=1, sort_keys=True); print(json.dumps(dict(s), sort_keys=True))
