#!/usr/bin/env python3
"""send_links.py: build send -> list-order links from L1 inputs.
Usage: python3 send_links.py OPS_DIR INPUTS_TSV_GZ > send_links.tsv
  INPUTS_TSV_GZ  rows: txid  input_index  prev_txid  prev_index  ... (prep output, hex may be '\\x'-prefixed)
A send's order is the list tx's output 0; a link is the lowest-index input of the send that spends <list>:0.
Output: send_txid<TAB>list_txid<TAB>input_index"""
import gzip,json,glob,os,sys
ops_dir,inp=sys.argv[1],sys.argv[2]
L=set();S=set()
for f in glob.glob(os.path.join(ops_dir,'*.jsonl.gz')):
    for line in gzip.open(f,'rt'):
        o=json.loads(line)
        if o.get('opAccept')!='1': continue
        if o['op']=='list': L.add(o['hashRev'])
        elif o['op']=='send': S.add(o['hashRev'])
best={}
h=lambda x:x.replace('\\\\x','').replace('\\x','').lower()
for line in gzip.open(inp,'rt'):
    p=line.rstrip('\n').split('\t')
    if len(p)<4: continue
    t,i,pt,pi=h(p[0]),int(p[1]),h(p[2]),int(p[3])
    if t in S and pt in L and pi==0 and (t not in best or i<best[t][1]): best[t]=(pt,i)
for t in sorted(best): print(f'{t}\t{best[t][0]}\t{best[t][1]}')
print('links',len(best),'of sends',len(S),file=sys.stderr)
