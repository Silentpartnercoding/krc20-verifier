#!/usr/bin/env python3
"""claim_counterfactual.py: independent cascade re-derivation (does not use the TypeScript replay).

Usage: python3 claim_counterfactual.py OPS_DIR LINKS_TSV [SENDTX_DIR] [--compare CASCADE_TSV] [--out FAILS_TSV] [--holders-out DIFF_TSV]
  OPS_DIR     Kasplex oplist pages as *.jsonl.gz (from `kasplexPull`)
  LINKS_TSV   send_txid<TAB>list_txid<TAB>input_index  (send -> list-order links from L1 inputs)
  SENDTX_DIR  optional directory of api.kaspa.org /transactions/<id> JSON for extra send links
Input: Kasplex's own accepted NACHO op list.
Model: minimal KRC-20 balance semantics applied to Kasplex's ops in opScore order:
  mint: amt=min(lim, max-minted) else 'mint finished'; transfer: needs balance;
  list: balance->locked; send: consumes the open order whose list tx it spends (L1 input link; else first open order with same seller+amt) -> buyer balance; fails if that order is not open.
Runs twice: (A) Kasplex list as-is, (B) Kasplex list + the single mint 80d736ba inserted
inside its accepting block (DAA 90114862). Reports ops that fail in B, and holders that differ."""
import gzip,json,glob,sys,collections,argparse,os
ap=argparse.ArgumentParser(); ap.add_argument('ops_dir'); ap.add_argument('links'); ap.add_argument('sendtx_dir',nargs='?')
ap.add_argument('--compare'); ap.add_argument('--out',default='claim_counterfactual_fails.tsv')
ap.add_argument('--holders-out',help='write address,A_bal,A_locked,B_bal,B_locked for every differing holder'); args=ap.parse_args()
MAX=28700000000000000000; LIM=2870000000000
EXTRA=('80d736ba74376ea909ff4e2ae849b7e6178bffd1f3ac71345876c12acbed4795',
       'mint','kaspa:qr08qfv4veqtwvxzcw964q9tn70ne70n0gzsf5j4cgjzxtytvrdwuwk76m0ms',
       'kaspa:qr08qfv4veqtwvxzcw964q9tn70ne70n0gzsf5j4cgjzxtytvrdwuwk76m0ms',0)
ops={}
for f in sorted(glob.glob(os.path.join(args.ops_dir,'*.jsonl.gz'))):
    with gzip.open(f,'rt') as fh:
        for line in fh:
            o=json.loads(line)
            if o.get('opAccept')!='1': continue
            ops[o['hashRev']]=(int(o['opScore'])*10,o['op'],o.get('from',''),o.get('to',''),int(o.get('amt') or 0))
print('kasplex accepted ops (dedup):',len(ops),file=sys.stderr)
# send -> list-order links: a send spends its order's list-tx output. Raw L1 inputs (dump extract + api.kaspa.org).
LISTS={k for k,v in ops.items() if v[1]=='list'}
LINK={}
for l in open(args.links):
    t,p,_=l.split('\t'); LINK[t]=p
import os
for f in (glob.glob(os.path.join(args.sendtx_dir,'*.json')) if args.sendtx_dir else []):
    d=json.load(open(f))
    if not isinstance(d,dict) or 'inputs' not in d: continue
    # the order is the list tx's output 0 (the P2SH holding the send script); take the lowest-index input spending <list>:0
    for i in sorted(d['inputs'] or [], key=lambda i:int(i['index'])):
        if i['previous_outpoint_hash'] in LISTS and int(i['previous_outpoint_index'])==0: LINK[d['transaction_id']]=i['previous_outpoint_hash']; break
print('send links:',len(LINK),file=sys.stderr)
base=sorted(((v[0],k,v[1],v[2],v[3],v[4]) for k,v in ops.items()))
del ops
def run(seq):
    bal=collections.defaultdict(int); lck=collections.defaultdict(int); orders={}; bykey=collections.defaultdict(list); minted=0; fails=[]
    for key,tx,op,fr,to,amt in seq:
        if op=='deploy': continue
        if op=='mint':
            left=MAX-minted
            if left<=0: fails.append((tx,key//10,op,'mint finished')); continue
            a=min(LIM,left); minted+=a; bal[to or fr]+=a
        elif op=='transfer':
            if bal[fr]<amt: fails.append((tx,key//10,op,'balance insuff')); continue
            bal[fr]-=amt; bal[to]+=amt
        elif op=='list':
            if bal[fr]<amt: fails.append((tx,key//10,op,'balance insuff')); continue
            bal[fr]-=amt; lck[fr]+=amt; orders[tx]=(fr,amt); bykey[(fr,amt)].append(tx)
        elif op=='send':
            lt=LINK.get(tx)
            if lt is None:  # unlinked: first open order with the same (seller, amt)
                lt=next((x for x in bykey[(fr,amt)] if x in orders),None)
            if lt is None or lt not in orders or orders[lt][0]!=fr: fails.append((tx,key//10,op,'order not found')); continue
            sfr,samt=orders.pop(lt); bykey[(sfr,samt)].remove(lt); lck[fr]-=samt; bal[to]+=samt
        else: fails.append((tx,key//10,op,'unknown op'))
    return bal,lck,minted,fails
A=run(base)
print('A (kasplex as-is): fails',len(A[3]),'minted',A[2])
tx,op,fr,to,_=EXTRA
B_seq=base+[(9011486200885,tx,op,fr,to,0)]; B_seq.sort()
B=run(B_seq)
print('B (+80d736ba): fails',len(B[3]),'minted',B[2], collections.Counter((f[2],f[3]) for f in B[3]))
def holders(s): b,l=s[0],s[1]; return {a:(b[a],l[a]) for a in set(b)|set(l) if b[a]+l[a]>0}
hA,hB=holders(A),holders(B)
diff=[a for a in set(hA)|set(hB) if hA.get(a,(0,0))!=hB.get(a,(0,0))]
print('holders A',len(hA),'holders B',len(hB),'differing',len(diff),'onlyA',len(set(hA)-set(hB)),'onlyB',len(set(hB)-set(hA)))
for a in ('kaspa:qpwztwfam65p88zpw44m6ht6ghpvx8k3qszcwghkgvwe644kzp0g2p8jvych2','kaspa:qrf3rcpvkgkeqhsa7n4gndnvppj5edp7zh2mqj35mfc4rdm4ymkm7cdjrdl7y','kaspa:qryuv3pt4u5wnfah50zywenv3hfzu6uhqwxwnv0dddmjmxezq0mt60e9j6ghw'):
    print(a[:14],'A',hA.get(a,(0,0)),'B',hB.get(a,(0,0)))
rank=sorted(hA.items(),key=lambda x:-(x[1][0]+x[1][1]))[:3]; print('A top3',[(r[0][:14],r[1][0]) for r in rank])
mine=set(f[0] for f in B[3])
if args.compare:
    casc=set(l.split('\t')[0] for l in open(args.compare) if l.strip())
    print('fail set == cascade.tsv set:',mine==casc,'|mine-casc|',len(mine-casc),'|casc-mine|',len(casc-mine))
with open(args.out,'w') as w:
    for f in B[3]: w.write('\t'.join(map(str,f))+'\n')
if args.holders_out:
    with open(args.holders_out,'w') as w:
        w.write('address\tA_balance\tA_locked\tB_balance\tB_locked\n')
        for a in sorted(diff):
            x=hA.get(a,(0,0)); y=hB.get(a,(0,0)); w.write(f'{a}\t{x[0]}\t{x[1]}\t{y[0]}\t{y[1]}\n')
