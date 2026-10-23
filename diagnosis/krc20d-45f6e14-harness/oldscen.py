import json,subprocess,sys
old=json.load(open(sys.argv[1]))
for tid in sys.argv[2:]:
    d=json.loads(subprocess.run(['curl','-s',f'https://api.kaspa.org/transactions/{tid}?inputs=true&outputs=true&resolve_previous_outpoints=light'],capture_output=True,text=True).stdout)
    ins,outs=d['inputs'],d['outputs']
    amout=sum(o['amount'] for o in outs)
    full=sum(i['previous_outpoint_amount'] for i in ins)
    miss=sum(i['previous_outpoint_amount'] for i in ins if i['previous_outpoint_hash'] not in old)
    oldin=[(i['index'],i['previous_outpoint_hash'][:8],old.get(i['previous_outpoint_hash'])) for i in ins if i['previous_outpoint_hash'] in old]
    acc=d.get('accepting_block_hash')
    blk=json.loads(subprocess.run(['curl','-s',f'https://api.kaspa.org/blocks/{acc}?includeTransactions=false'],capture_output=True,text=True).stdout)['header']['daaScore']
    s=ins[0]['signature_script'];o0=outs[0]['script_public_key_address']
    A=subprocess.run(['./oldharness/oldharness',s,str(blk),str(full),str(amout),o0],capture_output=True,text=True).stdout.strip()
    B=subprocess.run(['./oldharness/oldharness',s,str(blk),str(miss) if miss else '-1',str(amout),o0],capture_output=True,text=True).stdout.strip()
    print(tid[:8],'DAA',blk,'nin',len(ins),'oldInputs',oldin,'\n  all-present:',A,'\n  old-missing:',B)
