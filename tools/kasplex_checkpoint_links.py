#!/usr/bin/env python3
"""Offline recomputation of Kasplex's own per-op `checkpoint` field for one tick (pre-HfDaaScore2026Q1 formula).

Source of the formula: go-krc20d @ a9754ffd operation/init.go (accepted ops only):
  cpHeader   = blake2b256_hex(opScore + "," + txid + "," + acceptingBlockHash + "," + p + "," + op)
  cpState    = blake2b256_hex(";".join(StAfter))          # StAfter lines from makeStLine* (same file)
  checkpoint = blake2b256_hex(checkpointPrev + cpHeader + cpState)   # if daaScore < 408300500
checkpointPrev is the previous accepted op of ANY tick, so a tick-only replay can only confirm a link when
the previous accepted op globally is also this tick's. A match pins the full post-op state lines AND the
accepting block hash. A mismatch is inconclusive unless the two ops have adjacent opScores (index+1, same DAA)
and no other accepted op can sit between them.

State is rebuilt here from the CLAIM rows themselves (amounts as Kasplex reports them); the accepting block
hash for each DAA comes from the L1 replay unit file (chainBlock column). So a match means: Kasplex's committed
post-state equals the state implied by its own op list, anchored to the chain block the replay found.

Send orders: send.lua keys the order by txInputs[op.index].prevTxId (go-krc20d @ a9754ffd
operation/contract/KRC-20/send.lua init/run). The claim rows carry no utxo for sends, so the order id must come
from L1 (SEND_ORDERS env: TSV txid, opIndex(=input index), prevTxId, extracted from the replay candidates). Without it the
script falls back to guessing among open orders with the same tamt, which can consume the wrong order and
corrupt later state.

usage: kasplex_checkpoint_links.py CLAIM_SORTED.tsv.gz DEPLOY.json UNITS_A.tsv.gz OUT_DIR [TICK]
"""
import gzip, hashlib, json, os, sys

HF = 408300500
claim_path, deploy_path, units_path, out_dir = sys.argv[1:5]
TICK = sys.argv[5] if len(sys.argv) > 5 else "NACHO"
DEBUG_TX = os.environ.get("DEBUG_TX", "")
DEBUG_STOP = int(os.environ.get("DEBUG_STOP", "0"))
SEND_ORDERS = {}
if os.environ.get("SEND_ORDERS"):
    for _l in open(os.environ["SEND_ORDERS"]):
        _t, _i, _p = _l.rstrip("\n").split("\t")
        SEND_ORDERS[_t] = _p   # op index is the input index (cancels use index 1)
b2 = lambda s: hashlib.blake2b(s.encode(), digest_size=32).hexdigest()

blk = {}
with gzip.open(units_path, "rt") as f:
    next(f)
    for line in f:
        d, _, _, _, h = line.rstrip("\n").split("\t")
        blk[int(d)] = h

dep = json.load(open(deploy_path))
dec = dep["dec"]
tok = {"minted": "0" if dep.get("pre", "0") == "0" else dep["pre"], "opmod": dep["opScore"], "burned": "0", "to": dep["to"]}
bal = {}      # addr -> [balance:int, locked:int, opmod:str]
mkt = {}      # (from, uTxId) -> dict(uaddr, uamt, tamt, opadd)
assert dep.get("pre", "0") == "0", "pre-mint deploy not handled"

kt = f"sttoken_{TICK}"
kb = lambda a: f"stbalance_{a}_{TICK}"
km = lambda a, u: f"stmarket_{TICK}_{a}_{u}"
lt = lambda: f"{kt},{tok['minted']},{tok['opmod']}"
def lb(a):
    b = bal.get(a)
    return kb(a) if b is None else f"{kb(a)},{dec},{b[0]},{b[1]},{b[2]}"
def getb(a, opmod_new="0"):
    if a not in bal: bal[a] = [0, 0, opmod_new]
    return bal[a]

st = dict(rows=0, accepted=0, checked=0, match=0, mismatch=0, adjacentMismatch=0, noBlock=0, postHf=0,
          sendCandidatesTried=0, sendAmbiguousResolved=0, unsupported=0, byOp={})
prev_cp = dep["checkpoint"]; prev_score = int(dep["opScore"])
mism = []; first_match = last_match = None
for_rows = gzip.open(claim_path, "rt")
for line in for_rows:
    r = line.rstrip("\n").split("\t")
    score, txid, op, tick, amt, frm, to, utxo, cp, acc, extra = r
    st["rows"] += 1
    if acc != "1": continue
    st["accepted"] += 1
    s = int(score); daa = s // 10000
    check = daa < HF
    h = blk.get(daa)
    if check and h is None: st["noBlock"] += 1; check = False
    # candidate (state mutation fn, stAfter lines) list; send may have several order candidates
    cands = []
    if op == "mint":
        def mut(a=to, n=int(amt)):
            tok["minted"] = str(int(tok["minted"]) + n); tok["opmod"] = score
            b = getb(a); b[0] += n; b[2] = score
        cands.append(mut)
        lines_fn = lambda a=to: [lt(), lb(a)]
    elif op == "transfer":
        def mut(f=frm, t=to, n=int(amt)):
            bf = bal[f]; bf[0] -= n; bf[2] = score
            bt = getb(t); bt[0] += n; bt[2] = score
        cands.append(mut); lines_fn = lambda f=frm, t=to: [lb(f), lb(t)]
    elif op == "list":
        u_tx, u_addr, u_amt = utxo.split("_")
        def mut(f=frm, n=int(amt), u=(u_tx, u_addr, u_amt)):
            bf = bal[f]; bf[0] -= n; bf[1] += n; bf[2] = score
            mkt[(f, u[0])] = dict(uaddr=u[1], uamt=u[2], tamt=n, opadd=score)
        cands.append(mut)
        lines_fn = lambda f=frm, u=(u_tx, u_addr, u_amt): [lb(f), f"{km(f, u[0])},{u[1]},{u[2]},{mkt[(f, u[0])]['tamt']},{mkt[(f, u[0])]['opadd']}"]
    elif op == "send":
        n = int(amt)
        if txid in SEND_ORDERS:
            orders = [SEND_ORDERS[txid]] if (frm, SEND_ORDERS[txid]) in mkt else []
            st["sendOrderFromL1"] = st.get("sendOrderFromL1", 0) + 1
            if not orders:
                st["sendOrderMissing"] = st.get("sendOrderMissing", 0) + 1
                if st["sendOrderMissing"] <= 5: print(json.dumps(dict(missing=txid, score=score, frm=frm, order=SEND_ORDERS[txid], frmOrders=[k[1] for k in mkt if k[0] == frm][:8], anyFrom=[k[0] for k in mkt if k[1] == SEND_ORDERS[txid]])), file=sys.stderr, flush=True)
        else:
            orders = sorted(k[1] for k, m in mkt.items() if k[0] == frm and m["tamt"] == n)
        st["sendCandidatesTried"] += len(orders)
        for o in orders:
            def mut(f=frm, t=to, o=o):
                # send.lua order: read to-balance (reset if nil or 0/0) BEFORE unlocking from; to==from shares one table
                m = mkt.pop((f, o)); bf = bal[f]; bt = bal.get(t)
                if bt is None or (bt[0] == 0 and bt[1] == 0):
                    bt = [0, 0, score]
                    if t != f: bal[t] = bt
                    else: bal[t] = bt = bf if bf[1] else bt  # to==from: locked>0 so never reset
                bf[1] -= m["tamt"]
                bt[0] += m["tamt"]
                return o
            cands.append(mut)
        lines_fn = None
    elif op == "burn":
        def mut(f=frm, n=int(amt)):
            bal[f][0] -= n; bal[f][2] = score; tok["burned"] = str(int(tok["burned"]) + n); tok["opmod"] = score
        cands.append(mut); lines_fn = lambda f=frm: [lt(), lb(f)]
    elif op == "chown":
        def mut(t=to):
            tok["to"] = t; tok["opmod"] = score
        cands.append(mut); lines_fn = None  # chown token line uses deploy-style fields (isDeploy=true); not needed for NACHO
        st["unsupported"] += 1
    else:
        st["unsupported"] += 1; continue
    st["byOp"][op] = st["byOp"].get(op, 0) + 1
    if not cands:
        st["unsupported"] += 1; prev_cp = cp; prev_score = s; continue
    hdr = b2(f"{score},{txid},{h},KRC-20,{op}") if h else None
    if op == "send":
        import copy
        chosen = None
        for i, mut in enumerate(cands):
            saved = (copy.deepcopy(bal.get(frm)), copy.deepcopy(bal.get(to)), dict(mkt))
            ord_id = mut()
            lines = []
            for x in [lb(frm), lb(to), km(frm, ord_id)]:   # mergeStLineMap keeps one line per key
                if x.split(",", 1)[0] not in [y.split(",", 1)[0] for y in lines]: lines.append(x)
            ok = check and b2(prev_cp + hdr + b2(";".join(lines))) == cp
            if txid == DEBUG_TX:
                print(json.dumps(dict(debug=txid, score=score, order=ord_id, lines=lines, ok=ok, prev_cp=prev_cp, hdr=hdr, cp=cp, saved=[saved[0], saved[1]], mktFrm={k[1]: v for k, v in saved[2].items() if k[0] == frm})), file=sys.stderr, flush=True)
            if ok or not check or i == len(cands) - 1:
                if ok and len(cands) > 1: st["sendAmbiguousResolved"] += 1
                chosen = lines; break
            bf, bt, m = saved                                # undo and try the next candidate order
            if bf is None: bal.pop(frm, None)
            else: bal[frm] = bf
            if to != frm:
                if bt is None: bal.pop(to, None)
                else: bal[to] = bt
            mkt.clear(); mkt.update(m)
        lines = chosen
    else:
        cands[0]()
        lines = lines_fn() if lines_fn else None
    if not check:
        if daa >= HF: st["postHf"] += 1
    elif lines is not None:
        st["checked"] += 1
        mine = b2(prev_cp + hdr + b2(";".join(lines)))
        if mine == cp:
            st["match"] += 1; last_match = score
            if first_match is None: first_match = score
        else:
            st["mismatch"] += 1
            adj = (s == prev_score + 1)
            if adj: st["adjacentMismatch"] += 1
            if len(mism) < 2000 or adj: mism.append("\t".join([score, txid, op, str(int(adj)), cp, mine]))
    prev_cp = cp; prev_score = s
    if DEBUG_STOP and s >= DEBUG_STOP: break
    if st["rows"] % 1_000_000 == 0: print(json.dumps(st), file=sys.stderr, flush=True)

st.update(firstMatchOpScore=first_match, lastMatchOpScore=last_match, hfDaa=HF,
          finalTokenState=tok, holdersNonZero=sum(1 for b in bal.values() if b[0] or b[1]), openOrders=len(mkt))
os.makedirs(out_dir, exist_ok=True)
json.dump(st, open(os.path.join(out_dir, "checkpoint_links_summary.json"), "w"), indent=1, sort_keys=True)
with open(os.path.join(out_dir, "checkpoint_links_mismatches_sample.tsv"), "w") as f:
    f.write("opScore\ttxid\top\tadjacentToPrevTickOp\tkasplexCheckpoint\trecomputedWithPrevTickCheckpoint\n")
    f.write("\n".join(mism) + ("\n" if mism else ""))
print(json.dumps(st, indent=1, sort_keys=True))
