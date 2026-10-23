#!/usr/bin/env python3
"""Classify NACHO-inscribed dump txs that have no dump acceptance row.
Inputs (in $NACHO_DATA, default ./data): analysis/unaccepted/{unacc_sigs.tsv,unacc_inputs.tsv,conflicts.tsv},
replay/api/unaccepted_status.tsv, prep/acc_by_tx.tsv.gz (txId block blue daa), prep/claim_sorted.tsv.gz.
Writes analysis/unaccepted/unaccepted_classified.tsv and prints a JSON summary."""
import gzip, json, re, collections, datetime, sys
import os
D = os.environ.get("NACHO_DATA", "data")
def tsv(p):
    op = gzip.open if p.endswith(".gz") else open
    with op(p, "rt") as f:
        for l in f:
            l = l.rstrip("\n")
            if l: yield l.split("\t")
sig = {r[0]: bytes.fromhex(r[1]) for r in tsv(f"{D}/analysis/unaccepted/unacc_sigs.tsv")}
inp = {r[0]: (r[2], int(r[3])) for r in tsv(f"{D}/analysis/unaccepted/unacc_inputs.tsv")}
status = {r[0]: r for r in tsv(f"{D}/replay/api/unaccepted_status.tsv")}
conf = collections.defaultdict(list)
for r in tsv(f"{D}/analysis/unaccepted/conflicts.tsv"): conf[r[0]].append(r[2])
need = {c for v in conf.values() for c in v}
acc = {}
for r in tsv(f"{D}/prep/acc_by_tx.tsv.gz"):
    if r[0] in need: acc[r[0]] = r
claim = {}
for r in tsv(f"{D}/prep/claim_sorted.tsv.gz"):
    if r[0] in need or r[0] in sig: claim[r[0]] = r
def op_of(b):
    m = re.search(rb'\{[^{}]*\}', b[max(b.find(b'kasplex'), 0):])
    if not m: return ("?", "")
    try: j = json.loads(m.group(0))
    except Exception: return ("badjson", "")
    return (str(j.get("op", "?")).lower(), str(j.get("tick", j.get("ca", ""))))
out, summ = [], collections.Counter()
for t in sorted(sig):
    op, tick = op_of(sig[t])
    st = status[t]
    api = "accepted" if st[1] == "1" else ("not_accepted" if st[1] == "0" else st[1])
    cs = conf.get(t, [])
    acc_c = [c for c in cs if c in acc]
    if api == "accepted": cls = "dump_missing_acceptance_row_api_accepted"
    elif acc_c: cls = "double_spend_lost_to_accepted_nacho_reveal"
    elif cs: cls = "double_spend_with_other_unaccepted_nacho_reveal"
    else: cls = "not_accepted_no_competing_nacho_reveal_in_dump"
    in_claim = t in claim
    winner_claim = ";".join(f"{c}:{claim[c][2]}:{claim[c][3]}" if c in claim else f"{c}:not_in_claim" for c in acc_c)
    bt = int(inp[t][1])
    out.append([t, op, tick, cls, api, str(in_claim).lower(), datetime.datetime.fromtimestamp(bt/1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), inp[t][0], ";".join(acc_c), winner_claim])
    summ[(cls, op, in_claim)] += 1
with open(f"{D}/analysis/unaccepted/unaccepted_classified.tsv", "w") as f:
    f.write("txId\top\ttick\tclass\tapiKaspaOrg\tinKasplexClaim\tblockTimeUTC\tspentOutpoint\tacceptedCompetitor\tcompetitorInClaim(op:opAccept)\n")
    for r in out: f.write("\t".join(r) + "\n")
print(json.dumps({"|".join(map(str, k)): v for k, v in sorted(summ.items())}, indent=1))
win = collections.Counter(x.split(":",1)[1] if ":" in x else x for r in out for x in r[9].split(";") if x)
print("competitor claim status:", dict(win))
bt = sorted(r[6] for r in out); print("blockTime range:", bt[0], bt[-1])
by_month = collections.Counter(r[6][:7] for r in out); print(dict(sorted(by_month.items())))
