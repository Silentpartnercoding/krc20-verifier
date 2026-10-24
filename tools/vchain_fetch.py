#!/usr/bin/env python3
"""Resumable fetch of api.kaspa.org /virtual-chain pages (node acceptance order per chain block).

  vc_fetch.py PAGES.txt RELEVANT_TXIDS.txt OUT_DIR [rate=1.9]

PAGES.txt: one blueScoreGte per line (multiple of 100). For each page, GET /virtual-chain?blueScoreGte=P&limit=100
and append to OUT_DIR/vchain.tsv one row per chain block:
  page  chainHash  blueScore  daaScore  nTx  relevantTx:pos,...   (pos = 0-based index in the API's list)
Only txids in RELEVANT_TXIDS are listed. OUT_DIR/done.txt records finished pages (the checkpoint), so a restart
skips them. OUT_DIR/progress.json is rewritten every 20 pages. Rate: one process, sequential, <= rate req/s
(AGENTS.md: <= 2 req/s total across all processes). L1 data only.
"""
import json, os, sys, time, urllib.request

pages_f, rel_f, out = sys.argv[1], sys.argv[2], sys.argv[3]
rate = float(sys.argv[4]) if len(sys.argv) > 4 else 1.9
os.makedirs(out, exist_ok=True)
pages = [int(x) for x in open(pages_f).read().split()]
rel = set(open(rel_f).read().split())
done_p = f"{out}/done.txt"
done = set(int(x) for x in open(done_p).read().split()) if os.path.exists(done_p) else set()
todo = [p for p in pages if p not in done]
gap = 1.0 / rate
last = 0.0
t0 = time.time(); calls = 0

def get(p):
    global last, calls
    for attempt in range(6):
        w = last + gap - time.time()
        if w > 0: time.sleep(w)
        last = time.time(); calls += 1
        try:
            req = urllib.request.Request(f"https://api.kaspa.org/virtual-chain?blueScoreGte={p}&limit=100",
                                         headers={"User-Agent": "krc20-verifier"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:
            sys.stderr.write(f"{time.strftime('%H:%M:%S')} page {p} attempt {attempt}: {e}\n")
            time.sleep(min(60, 5 * 2 ** attempt))
    raise SystemExit(f"page {p} failed")

with open(f"{out}/vchain.tsv", "a") as fo, open(done_p, "a") as fd:
    for i, p in enumerate(todo):
        d = get(p)
        for b in d:
            ids = [t["transaction_id"] for t in b.get("transactions") or []]
            hits = ",".join(f"{t}:{j}" for j, t in enumerate(ids) if t in rel)
            fo.write(f"{p}\t{b['hash']}\t{b['blue_score']}\t{b['daa_score']}\t{len(ids)}\t{hits}\n")
        fo.flush(); os.fsync(fo.fileno())
        fd.write(f"{p}\n"); fd.flush()
        if (i + 1) % 20 == 0 or i + 1 == len(todo):
            el = time.time() - t0
            json.dump({"done": len(done) + i + 1, "total": len(pages), "calls": calls, "elapsedSec": round(el),
                       "etaSec": round((len(todo) - i - 1) * el / (i + 1)),
                       "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, open(f"{out}/progress.json.tmp", "w"))
            os.replace(f"{out}/progress.json.tmp", f"{out}/progress.json")
print(f"done {len(pages)} pages, {calls} calls", file=sys.stderr)
