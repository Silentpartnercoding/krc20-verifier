import json,sys
old=json.load(open(sys.argv[1]))
rows=[l.rstrip('\n').split('\t') for l in open(sys.argv[2])]
rows.sort(key=lambda r:old[r[0]])
for p,t,D,op,tick,i in rows:
    try: d=json.load(open('kop/'+t))
    except Exception: print(old[p],t[:8],'nofile'); continue
    r=(d.get('result') or [None])[0]
    s= f"FOUND {r['opAccept']} {r['opError'] or '-'} feeRev={r['feeRev']} score={r['opScore']}" if r else 'NOT FOUND '+str(d.get('message',''))
    print(old[p],p[:8],t[:8],D,op,tick,'in'+i,s)
