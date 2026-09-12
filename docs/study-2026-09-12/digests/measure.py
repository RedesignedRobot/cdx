import json,re,csv,collections,statistics,datetime
from pathlib import Path
P=Path('/tmp/cdx-study')
ledger=json.loads((P/'ledger-48h.json').read_text())
def dt(s):
 try:return datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
 except:return None
feed=collections.defaultdict(list)
for no,line in enumerate((P/'feed.log').open(),1):
 try:d=json.loads(line)
 except:continue
 if d.get('lane') in ledger and d.get('round'):d['line']=no;feed[d['lane'],d['round']].append(d)
def category(name,args):
 s=args if isinstance(args,str) else json.dumps(args)
 if name in ['command_status','wait','wait_5_seconds'] or re.search(r'\bcdx\s+(wait|status|tail|feed|inbox|questions)\b|\bsleep\s+\d',s):return 'wait_status'
 if name in ['replace_file_content','multi_replace_file_content','write_to_file','apply_patch','notebook_edit','delete_knowledge']:return 'write'
 if name.startswith('browser_') or name in ['open_browser_url','execute_browser_javascript','capture_browser_screenshot','read_browser_page','click_browser_pixel']:return 'browser'
 if name in ['view_file','list_dir','grep_search','find_by_name','read_url_content','search_web','read_resource','list_resources']:return 'read'
 if re.search(r'\b(?:bunx vp (?:test|check)|bun (?:test|run check)|vp run land|qa\.ts validate|wall\.ts)\b',s):return 'test_gate'
 if re.search(r'\bcdx\s+(spawn|consult|review|reply|send|resume|ask|close)\b|spawn_agent|send_message|wait_agent',s):return 'coordinate'
 if re.search(r'write_text|writeFile|write_to_file|apply_patch|replace_file|\bsed\s+-i|\b(?:cp|mv|mkdir|touch)\s|qa\.ts (?:attempt|finding).*?(?:record|close)|\b(?:curl|wget)\b.*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)|\bgit\s+(?:commit|add|cherry-pick|merge|checkout|switch)',s):return 'write'
 if re.search(r'\b(?:codegraph|ctx7|cat|sed|rg|grep|find|head|tail|ls|wc|pwd|stat|readlink|jq)\b|\bgit\s+(?:status|diff|show|log|rev-parse)',s) and not re.search(r'\b(?:python|python3|node|bun)\b',s):return 'read'
 return 'other'
rows=[]
for lane,e in ledger.items():
 for rnd in range(1,e['rounds']+1):
  stem=f'{lane}-r{rnd}';sp=P/'specs'/f'{stem}.json';spec=json.loads(sp.read_text()) if sp.exists() else {}
  engine=spec.get('engine',e.get('engine','gpt'))
  kind='consult' if spec.get('reviewDir') and ('CONSULT.' in spec.get('prompt','') or e.get('consult')) else 'review' if spec.get('reviewDir') or spec.get('mode','').startswith('review') else 'work'
  ev=feed[lane,rnd];terminal=[d for d in ev if d['kind']=='terminal'];term=terminal[-1] if terminal else {}
  tm=term.get('message','');m=re.search(r'kind=(\w+)',tm)
  if m and kind!='consult':kind=m[1]
  end=dt(term.get('timestamp',''));start=None;time_method='unknown'
  if rnd==1:start=dt(e.get('createdAt',''));time_method='created_to_terminal'
  elif rnd==e['rounds']:start=dt(e.get('roundStartedAt',''));time_method='round_start_to_terminal'
  else:
   starts=[dt(x['timestamp']) for x in ev if x['kind']=='started']
   if starts:start=starts[0];time_method='started_to_terminal'
  seconds=end-start if end is not None and start is not None and end>=start else None
  upper=None
  if seconds is None and end:
   prev=[dt(x['timestamp']) for x in feed[lane,rnd-1] if x['kind']=='terminal']
   if prev:upper=end-max(prev)
  tokens=collections.Counter();tools={};agent_secs=0;results=[];malformed=0;events=0;times=[];app_usage={};app_baselines={};tool_started={}
  lp=P/'logs'/f'{stem}.jsonl'
  if lp.exists():
   for no,line in enumerate(lp.open(),1):
    try:d=json.loads(line)
    except:malformed+=1;continue
    events+=1
    if d.get('timestamp'):times.append(d['timestamp'])
    if d.get('emittedAtMs'):times.append(d['emittedAtMs'])
    typ=d.get('event',d.get('type',d.get('method')))
    if typ=='thread/tokenUsage/updated':
     pp=d.get('params',{});tid=pp.get('threadId');u=pp.get('tokenUsage',{});total=u.get('total',{});last=u.get('last',{})
     app_baselines.setdefault(tid,{k:total.get(k,0)-last.get(k,0) for k in ['inputTokens','outputTokens','cachedInputTokens']});app_usage[tid]=total
    elif typ in ['item/started','item/completed']:
     pp=d.get('params',{});it=pp.get('item',{});name=it.get('type','')
     if name not in ['agentMessage','reasoning','userMessage','plan']:
      key=it.get('id',str(no));old=tools.get(key,{})
      if typ=='item/started':tool_started[key]=d.get('emittedAtMs')
      args=it.get('command',it.get('arguments',it.get('changes',{})))
      cat='write' if name=='fileChange' else 'coordinate' if name.startswith('collab') else category(name,args)
      sec=it.get('durationMs');sec=sec/1000 if sec is not None else ((d['emittedAtMs']-tool_started[key])/1000 if typ=='item/completed' and d.get('emittedAtMs') and tool_started.get(key) else old.get('seconds'))
      tools[key]={'name':name,'args':args,'cat':cat,'seconds':sec,'line':old.get('line',no)}
    elif typ=='step_update':
     s=d.get('step_update',{});u=s.get('usage',{})
     for a,b in [('input','input_tokens'),('output','output_tokens'),('cached','cache_read_tokens')]:tokens[a]+=u.get(b,0)
     if s.get('step_type')=='agent_response':agent_secs+=s.get('duration_seconds',0)
     if s.get('step_type')=='tool':
      key=str(s.get('step_index'));old=tools.get(key,{})
      inf=s.get('tool_info',{});name=s.get('tool_name',inf.get('name',old.get('name','unknown')));args=inf.get('parameters',old.get('args',{}))
      tools[key]={'name':name,'args':args,'cat':category(name,args),'seconds':s.get('duration_seconds',old.get('seconds')),'line':old.get('line',no)}
    elif typ=='turn.completed':
     u=d.get('usage',{})
     for a,b in [('input','input_tokens'),('output','output_tokens'),('cached','cached_input_tokens')]:tokens[a]+=u.get(b,0)
    elif typ in ['item.started','item.completed']:
     it=d.get('item',{});name=it.get('type','')
     if name not in ['agent_message','reasoning']:
      key=it.get('id',str(no));old=tools.get(key,{})
      args=it.get('command',it.get('arguments',{}));tools[key]={'name':name,'args':args,'cat':category(name,args),'seconds':None,'line':old.get('line',no)}
    elif typ=='result':
     r=d.get('result',{});results.append({'line':no,'status':r.get('status'),'duration_cumulative':r.get('duration_seconds'),'error':r.get('error','')[:500]})
  for tid,u in app_usage.items():
   for a,b in [('input','inputTokens'),('output','outputTokens'),('cached','cachedInputTokens')]:tokens[a]+=max(0,u.get(b,0)-app_baselines[tid][b])
  counts=collections.Counter(t['cat'] for t in tools.values());dur=collections.Counter()
  for t in tools.values():
   if t['seconds'] is not None:dur[t['cat']]+=t['seconds']
  for r in results:r['error']=re.sub(r'(?i)(authorization|token|key|password)\s*[=:]\s*[^\s,;]+',r'\1=[REDACTED]',r['error'])
  brief=P/'briefs'/f'{stem}.md';full=brief.read_text() if brief.exists() else spec.get('prompt','')
  task=full.split('\nTask:\n',1)[-1]
  m=re.search(r'\bstate=(\w+)',tm);state=m[1] if m else 'unknown'
  x=re.search(r'\bexit=(-?\d+)',tm)
  rows.append(dict(lane=lane,round=rnd,engine=engine,kind=kind,state=state,exit=int(x[1]) if x else None,seconds=seconds,time_method=time_method if seconds is not None else 'unknown',upper_seconds=upper,start=start,end=end,tokens=dict(tokens),token_observed=bool(tokens),native_threads=len(app_usage),counts=dict(counts),tool_seconds=dict(dur),agent_seconds=agent_secs,tool_calls=len(tools),events=events,timestamped_events=len(times),malformed=malformed,results=results,terminal_line=term.get('line'),terminal_message=tm,full_words=len(full.split()),task_words=len(task.split()),partial=(P/'reports'/f'{stem}.partial.md').exists(),spec_exists=bool(spec),log_exists=lp.exists()))
(P/'digests/round-metrics.json').write_text(json.dumps(rows,indent=2)+'\n')
# Output no raw tool arguments.
lanes=[]
for name,e in ledger.items():
 rr=[r for r in rows if r['lane']==name];tok=e.get('tokens',{});known=[r['seconds'] for r in rr if r['seconds'] is not None]
 lanes.append(dict(lane=name,engine=e.get('engine'),kind=e.get('kind'),rounds=len(rr),seconds_known=sum(known),unknown_rounds=len(rr)-len(known),tokens=tok,log_tokens={k:sum(r['tokens'].get(k,0) for r in rr) for k in ['input','output','cached']},tool_calls=sum(r['tool_calls'] for r in rr),counts={k:sum(r['counts'].get(k,0) for r in rr) for k in ['read','write','browser','test_gate','coordinate','wait_status','other']}))
(P/'digests/lane-metrics.json').write_text(json.dumps(lanes,indent=2)+'\n')
summary=[]
for engine,kind in sorted(set((r['engine'],r['kind']) for r in rows)):
 rr=[r for r in rows if (r['engine'],r['kind'])==(engine,kind)];dur=[r['seconds']/60 for r in rr if r['seconds'] is not None]
 summary.append(dict(engine=engine,kind=kind,n=len(rr),known_time=len(dur),minutes=sum(dur),median_minutes=statistics.median(dur) if dur else None,worst_minutes=max(dur) if dur else None,missing_tokens=sum(not r['token_observed'] for r in rr),tokens={k:sum(r['tokens'].get(k,0) for r in rr) for k in ['input','output','cached']},calls={k:sum(r['counts'].get(k,0) for r in rr) for k in ['read','write','browser','test_gate','coordinate','wait_status','other']},tool_seconds={k:sum(r['tool_seconds'].get(k,0) for r in rr) for k in ['read','write','browser','test_gate','coordinate','wait_status','other']},agent_seconds=sum(r['agent_seconds'] for r in rr)))
(P/'digests/summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print('wrote digests/round-metrics.json, lane-metrics.json, summary.json; '+str(len(rows))+' rounds')
print(json.dumps(summary,indent=2))
print('unknown time',[(r['lane'],r['round'],r['upper_seconds']) for r in rows if r['seconds'] is None])
print('ledger/log differences',[(l['lane'],{k:l['tokens'].get(k,0)-l['log_tokens'].get(k,0) for k in ['input','output','cached']}) for l in lanes if l['tokens']!=l['log_tokens']])
