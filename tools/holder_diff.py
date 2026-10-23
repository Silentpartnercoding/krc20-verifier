#!/usr/bin/env python3
"""Diff replay holders (address balance locked) against the Kasplex-claim ledger and Kasplex's reported top holders.
usage: holder_diff.py REPLAY_HOLDERS CLAIM_LEDGER_HOLDERS KASPLEX_TOKEN_JSON OUT_DIR"""
import json, sys, os
rp, cp, tj, out = sys.argv[1:5]
os.makedirs(out, exist_ok=True)
def load(p):
    d = {}
    for line in open(p):
        f = line.rstrip("\n").split("\t")
        if len(f) < 3 or not f[0]: continue
        d[f[0]] = (int(f[1]), int(f[2]))
    return d
R, C = load(rp), load(cp)
rows = []
for a in set(R) | set(C):
    rb, rl = R.get(a, (0, 0)); cb, cl = C.get(a, (0, 0))
    if (rb, rl) != (cb, cl):
        rows.append((a, rb, rl, cb, cl, (rb + rl) - (cb + cl)))
rows.sort(key=lambda r: -abs(r[5]))
with open(f"{out}/holder_diff.tsv", "w") as f:
    f.write("address\treplayBalance\treplayLocked\tclaimBalance\tclaimLocked\tdeltaTotal\n")
    for r in rows: f.write("\t".join(map(str, r)) + "\n")
tok = json.load(open(tj))
top = tok.get("holder", [])
# Kasplex's holder "amount" may be balance or balance+locked; count a match if it equals either.
topDiff = [(h["address"], int(h["amount"]), *R.get(h["address"], (0, 0))) for h in top
           if int(h["amount"]) not in (R.get(h["address"], (0, 0))[0], sum(R.get(h["address"], (0, 0))))]
summ = {
    "replayHolders": len(R), "claimHolders": len(C),
    "onlyReplay": sum(1 for a in R if a not in C), "onlyClaim": sum(1 for a in C if a not in R),
    "differing": len(rows), "differingTotal": sum(1 for r in rows if r[5] != 0), "differingSplitOnly": sum(1 for r in rows if r[5] == 0),
    "largest": rows[:10] and [dict(zip(["address", "replayBalance", "replayLocked", "claimBalance", "claimLocked", "deltaTotal"], map(str, r))) for r in rows[:10]],
    "sumAbsDelta": str(sum(abs(r[5]) for r in rows)), "netDelta": str(sum(r[5] for r in rows)),
    "replaySumBalance": str(sum(v[0] for v in R.values())), "replaySumLocked": str(sum(v[1] for v in R.values())),
    "claimSumBalance": str(sum(v[0] for v in C.values())), "claimSumLocked": str(sum(v[1] for v in C.values())),
    "kasplexTopHolders": len(top), "kasplexTopHoldersDifferingFromReplay[address,kasplexAmount,replayBalance,replayLocked]": [list(map(str, x)) for x in topDiff],
    "kasplexHolderTotal": tok.get("holderTotal"),
}
json.dump(summ, open(f"{out}/holder_diff_summary.json", "w"), indent=1)
print(json.dumps(summ, indent=1))
