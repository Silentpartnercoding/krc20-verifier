#!/usr/bin/env python3
"""Per-address export of every holder whose (balance, locked) differs between the replay
WITH 80d736ba (run3) and the Kasplex claim ledger at the 2026-10-20 checkpoint.
For each address: Kasplex vs replay balance/locked/total, deltas, the first causal op
(first cascade row touching the address, opScore order), and the causal chain back to
80d736ba (each hop = the row that first tainted the address, and the already-tainted
counterparty). Optional: independent-model diff (claim_counterfactual --holders-out) for a
cross-check, and a directory of live Kasplex responses.
usage: affected_export.py HOLDER_DIFF CASCADE_TSV OPS_DIR OUT_CSV [--indep TSV] [--live DIR]"""
import sys, csv, gzip, json, glob, os, argparse, datetime, zoneinfo
ap = argparse.ArgumentParser()
ap.add_argument('holder_diff'); ap.add_argument('cascade'); ap.add_argument('ops_dir'); ap.add_argument('out')
ap.add_argument('--indep'); ap.add_argument('--live'); a = ap.parse_args()
PDT = zoneinfo.ZoneInfo('America/Los_Angeles')
ROOT = '80d736ba74376ea909ff4e2ae849b7e6178bffd1f3ac71345876c12acbed4795'
ROOT_DAA = 90114862
ROOT_MS = 1726425573873  # api.kaspa.org block_time of 80d736ba (2024-09-15 11:39:33 PDT)
MINTER = 'kaspa:qr08qfv4veqtwvxzcw964q9tn70ne70n0gzsf5j4cgjzxtytvrdwuwk76m0ms'
SEED2_MINT = '16054c2b649741533e9e7b9b45c5001ea5c4e24fabd8b28662ad405a1f50e29c'
SEED2 = 'kaspa:qryuv3pt4u5wnfah50zywenv3hfzu6uhqwxwnv0dddmjmxezq0mt60e9j6ghw'
hd = list(csv.DictReader(open(a.holder_diff), delimiter='\t'))
rows = [l.rstrip('\n').split('\t') for l in open(a.cascade) if l.strip()]
rows.sort(key=lambda r: int(r[1]))
need = {r[0] for r in rows}
mts = {}
for f in sorted(glob.glob(os.path.join(a.ops_dir, '*.jsonl.gz'))):
    with gzip.open(f, 'rt') as fh:
        for line in fh:
            o = json.loads(line)
            if o.get('hashRev') in need and o.get('opAccept') == '1':
                mts[o['hashRev']] = int(o['mtsAdd'])
print('mtsAdd found', len(mts), 'of', len(need), file=sys.stderr)
# taint walk (same rule as cascade.py), recording who tainted whom
taint = {MINTER: ('root', ROOT, None), SEED2: ('root', SEED2_MINT, MINTER)}
first = {}  # address -> first cascade row touching it
for r in rows:
    tx, sc, daa, op, err, frm, to = r[:7]
    for x in (frm, to):
        if x and x not in first: first[x] = r
    if frm not in taint:
        taint[frm] = ('row', tx, to)      # only possible for send explained via buyer
    if to and to not in taint:
        taint[to] = ('row', tx, frm)
def chain(addr):
    hops = []; seen = set()
    while addr and addr not in seen:
        seen.add(addr)
        k, tx, parent = taint.get(addr, ('?', '', None))
        if k == 'root':
            if addr == MINTER: hops.append(f'{ROOT[:8]}(mint accepted in replay)->{addr[6:14]}'); break
            hops.append(f'{tx[:8]}(mint fails: supply exhausted)->{addr[6:14]}'); addr = parent; continue
        hops.append(f'{tx[:8]}->{addr[6:14]}'); addr = parent
    hops.append(ROOT[:8]) if not hops[-1].startswith(ROOT[:8]) else None
    return ' <= '.join(hops)
def t(ms): return datetime.datetime.fromtimestamp(ms/1000, PDT).strftime('%Y-%m-%d %H:%M:%S %Z') if ms else ''
indep = {}
if a.indep:
    for r in csv.DictReader(open(a.indep), delimiter='\t'): indep[r['address']] = r
live = {}
if a.live:
    for r in hd:
        p = os.path.join(a.live, r['address'] + '.json')
        try:
            j = json.load(open(p)); res = j['result'][0]; live[r['address']] = (int(res['balance']), int(res['locked']), j['message'])
        except Exception as e: live[r['address']] = ('', '', f'ERR {e}')
out = []; mism = 0
for r in hd:
    ad = r['address']; rb, rl, kb, kl = (int(r[k]) for k in ('replayBalance','replayLocked','claimBalance','claimLocked'))
    f = first.get(ad)
    if ad == MINTER: ftx, fop, fdaa, fms, fres = ROOT, 'mint', ROOT_DAA, ROOT_MS, 'accepted in replay; absent from Kasplex'; tsrc = 'api.kaspa.org block_time'
    else: ftx, fop, fdaa, fres = f[0], f[3], f[2], f[4]; fms = mts.get(f[0]); tsrc = 'Kasplex mtsAdd'
    d = dict(address=ad, kasplex_balance=kb, kasplex_locked=kl, kasplex_total=kb+kl,
             replay_balance=rb, replay_locked=rl, replay_total=rb+rl,
             delta_balance=rb-kb, delta_locked=rl-kl, delta_total=rb+rl-kb-kl,
             first_causal_txid=ftx, first_causal_op=fop, first_causal_replay_result=fres,
             first_causal_daa=fdaa, first_causal_time_pdt=t(fms), first_causal_time_source=tsrc,
             causal_chain=chain(ad), in_taint_173=ad in taint)
    if a.indep:
        x = indep.get(ad)
        ok = x is not None and (int(x['A_balance']), int(x['A_locked']), int(x['B_balance']), int(x['B_locked'])) == (kb, kl, rb, rl)
        d['indep_model_match'] = ok; mism += (not ok)
    if a.live:
        lb, ll, msg = live[ad]
        d['live_kasplex_balance'] = lb; d['live_kasplex_locked'] = ll
        d['live_kasplex_total'] = (lb + ll) if lb != '' else ''
        d['live_changed_since_checkpoint'] = (lb + ll != kb + kl or lb != kb) if lb != '' else ''
    out.append(d)
out.sort(key=lambda d: -abs(d['delta_total']))
with open(a.out, 'w', newline='') as w:
    cw = csv.DictWriter(w, fieldnames=list(out[0].keys())); cw.writeheader(); cw.writerows(out)
print('rows', len(out), 'taint', len(taint), 'in_taint', sum(d['in_taint_173'] for d in out),
      'net_delta_total', sum(d['delta_total'] for d in out), 'sum_abs_delta', sum(abs(d['delta_total']) for d in out), file=sys.stderr)
if a.indep:
    extra = set(indep) - {d['address'] for d in out}
    print('indep rows', len(indep), 'mismatch', mism, 'indep-only addresses', len(extra), file=sys.stderr)
if a.live:
    print('live changed', sum(1 for d in out if d.get('live_changed_since_checkpoint') is True), file=sys.stderr)
