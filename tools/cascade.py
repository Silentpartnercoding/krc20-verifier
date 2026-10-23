#!/usr/bin/env python3
"""Cascade check: starting from the addresses touched by replay-only accepted ops (seed),
walk replay-reject/claim-accept rows in opScore order. A row is 'explained' if its sender
(or, for send, the seller) is already tainted; its recipients then become tainted.
Also checks whether every differing holder is in the final taint set.
usage: cascade.py compare_dir holder_diff.tsv seed_addr[,seed_addr...] out_tsv"""
import sys, csv
cmp_dir, hd, seeds, out = sys.argv[1:5]
taint = set(seeds.split(','))
rows = [l.rstrip('\n').split('\t') for l in open(f'{cmp_dir}/reject_vs_claim_accept.tsv')]
rows.sort(key=lambda r: int(r[1]))
unexpl = []; first_unexpl = None
with open(out, 'w') as f:
    for r in rows:
        tx, op, frm, to = r[0], r[4], r[15], r[16]
        ok = frm in taint or (op == 'send' and (to in taint))
        if not ok:
            unexpl.append(r)
        f.write('\t'.join([tx, r[1], r[2], op, r[6], frm, to, r[12], 'explained' if ok else 'UNEXPLAINED']) + '\n')
        taint.add(frm)
        if to: taint.add(to)
# holders
hrows = list(csv.reader(open(hd), delimiter='\t'))
hdr = hrows[0]; ai = hdr.index('address') if 'address' in hdr else 0
addrs = [h[ai] for h in hrows[1:]]
outside = [a for a in addrs if a not in taint]
print(f'rows={len(rows)} explained={len(rows)-len(unexpl)} unexplained={len(unexpl)}')
for r in unexpl[:20]: print('UNEXPL', r[0], r[1], r[4], r[6], r[15], r[16], 'tied=', r[12])
print(f'taint={len(taint)} differingHolders={len(addrs)} outsideTaint={len(outside)}')
for a in outside[:20]: print('OUTSIDE', a)
