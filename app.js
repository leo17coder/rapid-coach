/* Rapid Coach — free chess coach for chess.com and Lichess games. GPL-3.0. */
{
/* ---------- utils ---------- */
const $=s=>document.querySelector(s);
const DRAWS=new Set(["agreed","repetition","stalemate","insufficient","50move","timevsinsufficient"]);
const wp=cp=>50+50*(2/(1+Math.exp(-0.00368208*cp))-1);
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const mmss=s=>s==null?"—":Math.floor(s/60)+":"+String(Math.max(0,Math.round(s%60))).padStart(2,"0");
const median=a=>{if(!a.length)return null;const s=a.slice().sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const LS={get(k,d){try{const v=localStorage.getItem("rc."+k);return v?JSON.parse(v):d}catch(e){return d}},set(k,v){try{localStorage.setItem("rc."+k,JSON.stringify(v))}catch(e){}}};
const evTxt=cp=>Math.abs(cp)>=9000?(cp>0?"+M":"−M"):(cp>0?"+":cp<0?"−":"")+(Math.abs(cp)/100).toFixed(1);
const mvLabel=i=>Math.floor(i/2)+1+(i%2?"…":".");
const TCL={"600":"10-minute rapid",rapid:"rapid",blitz:"blitz",bullet:"bullet"};

const SRC={cc:{name:"chess.com"},li:{name:"Lichess"}};
const srcOf=g=>g.source||(String(g.id).startsWith("li-")?"li":"cc");

/* ---------- state ---------- */
/* V1 keys were rc.<user>.<k>; V2 keys are rc.<source>:<user>.<k>. Rename once. */
(()=>{try{if(localStorage.getItem("rc.v2"))return;const ks=[];for(let i=0;i<localStorage.length;i++)ks.push(localStorage.key(i));
 for(const k of ks){const m=k.match(/^rc\.([^.:]+)\.(.+)$/);if(!m)continue;localStorage.setItem("rc.cc:"+m[1]+"."+m[2],localStorage.getItem(k));localStorage.removeItem(k)}
 localStorage.setItem("rc.v2","1")}catch(e){}})();
let P=LS.get("profile",null);           // {source:"cc"|"li", user, tc}
if(P&&!P.source){P.source="cc";LS.set("profile",P)}
let ALL=[],GAMES=[],CUR=null,PLY=0,GEN=0;
const acct=()=>P.source+":"+P.user;            // also the account id used when syncing
const uk=k=>acct()+"."+k;

/* ---------- storage (IndexedDB, falls back to memory) ---------- */
const DB={db:null,
 open(){return new Promise(res=>{try{const r=indexedDB.open("rapid-coach",2);r.onupgradeneeded=()=>{const d=r.result;for(const n of ["games","pending"])if(!d.objectStoreNames.contains(n))d.createObjectStore(n,{keyPath:"id"})};r.onsuccess=()=>{this.db=r.result;res()};r.onerror=()=>res()}catch(e){res()}})},
 all(){return new Promise(res=>{if(!this.db)return res([]);try{const q=this.db.transaction("games").objectStore("games").getAll();q.onsuccess=()=>res(q.result||[]);q.onerror=()=>res([])}catch(e){res([])}})},
 put(gs){if(!this.db||!gs.length)return;try{const s=this.db.transaction("games","readwrite").objectStore("games");gs.forEach(g=>{const plain={};for(const k in g)if(k[0]!=="_")plain[k]=g[k];s.put(plain)})}catch(e){}},
 /* pending: {id: gameId, an} pulled from the account before the game itself was fetched on this device */
 pend(){return new Promise(res=>{if(!this.db)return res([]);try{const q=this.db.transaction("pending").objectStore("pending").getAll();q.onsuccess=()=>res(q.result||[]);q.onerror=()=>res([])}catch(e){res([])}})},
 pendPut(xs){if(!this.db||!xs.length)return;try{const s=this.db.transaction("pending","readwrite").objectStore("pending");xs.forEach(x=>s.put(x))}catch(e){}},
 pendDel(ids){if(!this.db||!ids.length)return;try{const s=this.db.transaction("pending","readwrite").objectStore("pending");ids.forEach(i=>s.delete(i))}catch(e){}}};
const PEND=new Map();

/* ---------- engine (Stockfish in a Web Worker) ---------- */
const Engine={w:null,q:[],cur:null,ready:null,
 init(){if(this.ready)return this.ready;this.ready=new Promise((res,rej)=>{try{this.w=new Worker("vendor/stockfish-19-lite-single.js")}catch(e){return rej(e)}
  this._r=res;this.w.onmessage=e=>this.line(String(e.data));this.w.onerror=e=>rej(e);this.w.postMessage("uci");this.w.postMessage("isready")});return this.ready},
 line(l){if(l==="readyok"&&this._r){this._r();this._r=null;return}const c=this.cur;if(!c)return;
  if(l.startsWith("info")&&l.includes(" score ")){const m=l.match(/score (cp|mate) (-?\d+)/);if(m){c.t=m[1];c.v=+m[2]}const i=l.indexOf(" pv ");if(i>0)c.pv=l.slice(i+4).trim().split(/\s+/)}
  if(l.startsWith("bestmove")){const b=l.split(" ")[1],best=b&&b!=="(none)"?b:null;this.cur=null;let cp=c.t==="mate"?(c.v>0?10000-c.v:-10000-c.v):(c.v||0);if(!c.white)cp=-cp;
   c.res({cp,best,pv:c.pv&&c.pv[0]===best?c.pv:best?[best]:[]});this.next()}},
 /* resolves {cp (white's view, mate = ±(10000-n)), best (UCI), pv (principal variation, UCI)}; front: run next, ahead of queued analysis */
 eval(fen,depth,front){return this.init().then(()=>new Promise(res=>{const j={fen,depth,res,white:fen.split(" ")[1]==="w"};front?this.q.unshift(j):this.q.push(j);if(!this.cur)this.next()}))},
 next(){const j=this.q.shift();if(!j)return;this.cur=j;this.w.postMessage("position fen "+j.fen);this.w.postMessage("go depth "+j.depth)}};
const DEPTH=12;

/* ---------- job indicator ---------- */
const JOBS={};
function job(k,txt,frac){if(txt==null)delete JOBS[k];else JOBS[k]={txt,frac};const ks=Object.keys(JOBS);$("#job").hidden=!ks.length;if(ks.length){const j=JOBS[ks[ks.length-1]];$("#jobTxt").textContent=ks.map(k=>JOBS[k].txt).join(" · ");$("#jobBar").style.width=(j.frac*100)+"%"}}

/* ---------- game sources: chess.com and Lichess ---------- */
function parseMoves(pgn){let body=pgn.replace(/\r/g,"").replace(/^\s*\[[^\]]*\]\s*$/gm,"");const clocks=[];
 body=body.replace(/\{[^}]*\}/g,m=>{const c=m.match(/%clk (\d+):(\d+):(\d+(?:\.\d+)?)/);return c?" @"+(+c[1]*3600+ +c[2]*60+Math.floor(+c[3]))+" ":" "});
 while(/\([^()]*\)/.test(body))body=body.replace(/\([^()]*\)/g," ");
 const moves=[];for(const t of body.replace(/\$\d+/g," ").split(/\s+/).filter(Boolean)){if(t[0]==="@"){clocks[moves.length-1]=+t.slice(1);continue}
  if(/^\d+\.+$/.test(t)||/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t))continue;const s=t.replace(/^\d+\.+/,"").replace(/[?!]+$/,"");if(s)moves.push(s)}
 return {moves,clocks}}
const tcParts=tc=>{const m=String(tc||"").match(/^(\d+)(?:\+(\d+))?$/);return m?{base:+m[1],inc:+(m[2]||0)}:{base:600,inc:0}};
const matchTc=(x,tc)=>x.rules==="chess"&&(tc==="600"?x.time_control==="600":x.time_class===tc);
function fromApi(x,user){if(!x.pgn||!x.white||!x.black)return null;const w=x.white.username.toLowerCase()===user,me=w?x.white:x.black,op=w?x.black:x.white;
 const {moves,clocks}=parseMoves(x.pgn);if(!moves.length)return null;
 const result=me.result==="win"?"win":DRAWS.has(me.result)?"draw":"loss";
 const eco=x.eco?decodeURIComponent(x.eco.split("/").pop()).replace(/-/g," "):((x.pgn.match(/\[ECO "([^"]+)"/)||[])[1]||"Unknown");
 const ts=(x.end_time||0)*1000;
 return {id:"cc-"+(x.uuid||x.url),source:"cc",user,ts,date:new Date(ts).toISOString().slice(0,10),color:w?"w":"b",opp:op.username,myR:me.rating,oppR:op.rating,result,
  how:result==="win"?op.result:me.result,eco,moves,clocks,tc:x.time_control,tclass:x.time_class,rules:x.rules,link:x.url||""}}
/* o: {h: headers, raw: return the Response, sig: AbortSignal, wait: ms to wait after a 429, onWait} */
async function api(url,o){o=o||{};for(let a=0;a<4;a++){let r;try{r=await fetch(url,{headers:o.h||{},signal:o.sig})}catch(e){if(e.name==="AbortError")throw e;if(a===3)throw new Error("network");await sleep(1500);continue}
  if(r.status===404||r.status===410)throw new Error("notfound");if(r.status===429){if(o.onWait)o.onWait();await sleep(o.wait||2000*(a+1));continue}if(!r.ok)throw new Error("http "+r.status);return o.raw?r:r.json()}throw new Error("busy")}
const sync=onFirst=>P.source==="li"?syncLi(onFirst):syncCc(onFirst);
async function syncCc(onFirst){const gen=GEN,u=P.user,tc=P.tc,base=`https://api.chess.com/pub/player/${encodeURIComponent(u)}/games`;
 job("sync","Looking up games",0);
 const arc=await api(base+"/archives");const months=(arc.archives||[]).slice().reverse();const done=LS.get(uk("months."+tc),{});
 const todo=months.filter((m,i)=>i<2||!done[m]);const have=new Set(ALL.map(g=>g.id));let added=0;
 for(let i=0;i<todo.length;i++){if(gen!==GEN)return;const m=todo[i],lab=m.split("/").slice(-2).reverse().join("/");job("sync",`Fetching games ${lab} (${i+1}/${todo.length})`,i/todo.length);
  let j;try{j=await api(m)}catch(e){if(e.message==="notfound")continue;throw e}
  const add=[];for(const x of j.games||[]){if(!matchTc(x,tc))continue;const g=fromApi(x,u);if(!g||have.has(g.id))continue;have.add(g.id);add.push(g)}
  if(add.length){ALL.push(...add);DB.put(add);added+=add.length;refreshGames()}
  if(months.indexOf(m)>=2){done[m]=1;LS.set(uk("months."+tc),done)}
  if(i===0&&onFirst)onFirst()}
 job("sync",null);return added}

/* Lichess: one NDJSON stream per sync. Lichess asks for one request at a time and a full minute's pause after a 429. */
const LI="https://lichess.org",LI_MAX=2000,LI_WAIT=61000;
const LI_PERF={"600":"rapid",rapid:"rapid",blitz:"blitz",bullet:"bullet"};
const LI_HOW={mate:"checkmated",resign:"resigned",outoftime:"timeout",timeout:"abandoned",stalemate:"stalemate",draw:"agreed",insufficientMaterialClaim:"insufficient",cheat:"cheat"};
const liOpts=x=>({wait:LI_WAIT,onWait:()=>job("sync","Lichess asked us to slow down. Waiting a minute",0),...x});
function fromLichess(x,user){if(!x||!x.moves||!x.players||x.variant!=="standard"||!LI_HOW[x.status])return null;
 const pid=p=>p&&p.user?p.user.id:"",pname=p=>p.user?p.user.name:p.aiLevel?"Stockfish level "+p.aiLevel:"Anonymous";
 const w=pid(x.players.white)===user;if(!w&&pid(x.players.black)!==user)return null;const me=w?x.players.white:x.players.black,op=w?x.players.black:x.players.white;
 const moves=x.moves.trim().split(/\s+/).filter(Boolean);if(!moves.length)return null;
 const result=x.winner?(x.winner===(w?"white":"black")?"win":"loss"):"draw",ini=x.clock?x.clock.initial:600,inc=x.clock?x.clock.increment:0,ts=x.lastMoveAt||x.createdAt||0;
 return {id:"li-"+x.id,source:"li",user,ts,date:new Date(ts).toISOString().slice(0,10),color:w?"w":"b",opp:pname(op),myR:me.rating,oppR:op.rating,result,how:LI_HOW[x.status],
  eco:x.opening&&x.opening.name?x.opening.name.replace(/[:,]/g,"").replace(/\s+/g," "):"Unknown",moves,clocks:Array.isArray(x.clocks)?x.clocks.map(c=>Math.floor(c/100)):[],
  tc:inc?ini+"+"+inc:String(ini),tclass:x.speed,rules:"chess",link:LI+"/"+x.id+(w?"":"/black")}}
async function syncLi(onFirst){const gen=GEN,u=P.user,tc=P.tc,key=uk("last."+tc),since=LS.get(key,0);
 job("sync","Looking up games",0);let total=LI_MAX;
 if(!since){try{const p=await api(`${LI}/api/user/${encodeURIComponent(u)}`,liOpts()),pf=p.perfs&&p.perfs[LI_PERF[tc]];if(pf&&pf.games)total=Math.min(pf.games,LI_MAX)}catch(e){}}
 if(gen!==GEN)return 0;
 const q=new URLSearchParams({perfType:LI_PERF[tc],clocks:"true",opening:"true",moves:"true"});if(since)q.set("since",since+1);else q.set("max",LI_MAX);
 const ctl=new AbortController(),r=await api(`${LI}/api/games/user/${encodeURIComponent(u)}?${q}`,liOpts({h:{Accept:"application/x-ndjson"},raw:true,sig:ctl.signal}));
 const have=new Set(ALL.map(g=>g.id)),rd=r.body.getReader(),dec=new TextDecoder();let added=0,seen=0,newest=since,buf="",batch=[],first=true;
 const flush=()=>{if(!batch.length)return;ALL.push(...batch);DB.put(batch);added+=batch.length;batch=[];refreshGames();if(first&&onFirst){first=false;onFirst()}};
 const take=line=>{line=line.trim();if(!line)return;let x;try{x=JSON.parse(line)}catch(e){return}seen++;if(x.createdAt>newest)newest=x.createdAt;
  const g=fromLichess(x,u);if(g&&!have.has(g.id)&&matchTc({rules:g.rules,time_control:g.tc,time_class:g.tclass},tc)){have.add(g.id);batch.push(g)}};
 try{for(;;){if(gen!==GEN){ctl.abort();return added}const {done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});
  let nl;while((nl=buf.indexOf("\n"))>=0){take(buf.slice(0,nl));buf=buf.slice(nl+1)}
  if(batch.length>=(first?10:50))flush();job("sync",`Fetching Lichess games (${seen}${since?"":" of about "+total})`,since?.5:Math.min(1,seen/total))}
  take(buf)}
 catch(e){if(gen!==GEN)return added;flush();throw new Error("network")}
 if(gen!==GEN)return added;flush();if(newest>since)LS.set(key,newest);job("sync",null);return added}

/* ---------- game helpers ---------- */
function refreshGames(){GAMES=ALL.filter(g=>g.user===P.user&&srcOf(g)===P.source&&matchTc({rules:g.rules||"chess",time_control:g.tc,time_class:g.tclass},P.tc)).sort((a,b)=>a.ts-b.ts);
 if(PEND.size){const got=GAMES.filter(g=>!g.an&&PEND.has(g.id));got.forEach(g=>{g.an=PEND.get(g.id);PEND.delete(g.id)});if(got.length){DB.put(got);DB.pendDel(got.map(g=>g.id))}}
 fillPicker();buildPuzzles()}
const famOf=e=>{const w=(e||"Unknown").split(" ");const o=[];for(const x of w){if(/\d|\.\.\./.test(x)&&o.length>=2){o.push(x);break}o.push(x)}return o.slice(0,5).join(" ")};
function replay(g){if(g._f)return g;const c=new Chess(),f=[c.fen()],mv=[];for(const s of g.moves){const m=c.move(s);if(!m)break;mv.push(m);f.push(c.fen())}g._f=f;g._m=mv;return g}
function errorsOf(g){const an=g.an,out=[];if(!an)return out;for(let i=0;i<an.ev.length-1;i++){const white=i%2===0,b=an.ev[i],a=an.ev[i+1];if(a==null||b==null)continue;const s=white?1:-1,drop=wp(s*b)-wp(s*a),k=drop>=30?"blunder":drop>=20?"mistake":drop>=10?"inacc":null;
 if(k)out.push({i,mine:(g.color==="w")===white,drop,kind:k,before:s*b,after:s*a,best:an.best[i]})}return out}
const serious=g=>errorsOf(g).filter(e=>e.mine&&e.kind!=="inacc");
function uciSan(fen,u){if(!u)return null;const c=new Chess(fen);const m=c.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]||"q"});return m?m.san:u}
function spent(g,i){if(!g.clocks||g.clocks[i]==null)return null;const {base,inc}=tcParts(g.tc);const p=i>=2?g.clocks[i-2]:base;return Math.max(0,p+inc-g.clocks[i])}
function timeUsed(g){if(!g.clocks)return null;const {base,inc}=tcParts(g.tc),me=g.color==="w"?0:1;let last=null,n=0;for(let i=me;i<g.moves.length;i+=2)if(g.clocks[i]!=null){last=g.clocks[i];n++}return n>=15?base+inc*n-last:null}
const baseSecs=()=>tcParts(P.tc==="600"?"600":(GAMES.length?GAMES[GAMES.length-1].tc:"600")).base;
const score=a=>a.length?(a.filter(g=>g.result==="win").length+a.filter(g=>g.result==="draw").length/2)/a.length*100:null;

/* ---------- board ---------- */
/* ---------- display settings, icons, sounds ---------- */
/* UI = rc.ui (this browser only): theme "system"|"light"|"dark", board "green"|"wood"|"slate", pieces "cburnett"|"bold", sound */
const UI=Object.assign({theme:"system",board:"green",pieces:"cburnett",sound:false},LS.get("ui",{})),BOARDS=[];
const RM=()=>matchMedia("(prefers-reduced-motion: reduce)").matches;
const ic=(n,c)=>`<svg class="ic${c?" "+c:""}" aria-hidden="true" focusable="false"><use href="vendor/icons.svg#i-${n}"/></svg>`;
function applyUI(){const d=document.documentElement;if(UI.theme==="system")delete d.dataset.theme;else d.dataset.theme=UI.theme;d.dataset.board=UI.board;BOARDS.forEach(b=>b.draw())}
/* sounds are synthesised with Web Audio (no audio files); off unless switched on in settings */
const Snd={ctx:null,nb:null,
 play(k){if(!UI.sound)return;try{const C=this.ctx||(this.ctx=new (window.AudioContext||window.webkitAudioContext)()),t=C.currentTime;if(C.state==="suspended")C.resume();
  if(!this.nb){this.nb=C.createBuffer(1,C.sampleRate*.08,C.sampleRate);const d=this.nb.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,3)}
  const knock=(f,v,at)=>{const s=C.createBufferSource(),bp=C.createBiquadFilter(),g=C.createGain();s.buffer=this.nb;bp.type="bandpass";bp.frequency.value=f;bp.Q.value=1.6;g.gain.value=v;s.connect(bp).connect(g).connect(C.destination);s.start(t+at)};
  const tone=(f,d,v,at,type)=>{const o=C.createOscillator(),g=C.createGain();o.type=type||"sine";o.frequency.setValueAtTime(f,t+at);g.gain.setValueAtTime(0,t+at);g.gain.linearRampToValueAtTime(v,t+at+.008);g.gain.exponentialRampToValueAtTime(.0001,t+at+d);o.connect(g).connect(C.destination);o.start(t+at);o.stop(t+at+d+.05)};
  if(k==="move")knock(1100,1.4,0);else if(k==="capture"){knock(700,1.8,0);knock(1500,1,.045)}
  else if(k==="correct"){tone(660,.14,.16,0);tone(990,.22,.16,.09)}else if(k==="wrong"){tone(233,.22,.14,0,"triangle");tone(196,.3,.12,.12,"triangle")}
  else if(k==="goal")[523,659,784,1047].forEach((f,i)=>tone(f,.28,.13,i*.09))}catch(e){}}};

/* ---------- board: SVG pieces, click or drag to move, keyboard play, move animation ----------
   opts: onMove(from, to), sound (default: on for playable boards), label (aria). Board.lock blocks input. */
function Board(el,opts){opts=opts||{};this.el=el;this.flip=false;this.sel=null;this.onMove=opts.onMove;this.fen=new Chess().fen();this.arrows=[];this.last=null;this.targets=[];this.kb=null;
 this.sound=opts.sound!=null?opts.sound:!!opts.onMove;el.innerHTML='<div class="bsvg"></div><span class="sr-only" aria-live="polite"></span>';this.host=el.firstChild;this.live=el.lastChild;BOARDS.push(this);
 el.setAttribute("role","group");el.setAttribute("aria-label",(opts.label||"Chess board")+(this.onMove?". Click or drag pieces; with the keyboard use the arrow keys, then Enter to pick up and drop.":""));
 if(!this.onMove)return;el.tabIndex=0;
 const sqAt=e=>{const r=el.getBoundingClientRect();let x=Math.floor((e.clientX-r.left)/r.width*8),y=Math.floor((e.clientY-r.top)/r.height*8);if(x<0||y<0||x>7||y>7)return null;if(this.flip){x=7-x;y=7-y}return "abcdefgh"[x]+(8-y)};
 el.addEventListener("pointerdown",e=>{if(this.lock||e.button>0)return;const sq=sqAt(e);if(!sq)return;this.kbOn=false;const c=new Chess(this.fen),p=c.get(sq);
  if(this.sel&&this.targets.includes(sq)){e.preventDefault();this.click(sq);return}
  if(p&&p.color===c.turn()){const was=this.sel===sq;if(!was)this.click(sq);this.drag={from:sq,x:e.clientX,y:e.clientY,moved:false,id:e.pointerId,p,was};try{el.setPointerCapture(e.pointerId)}catch(x){}e.preventDefault()}else this.click(sq)});
 el.addEventListener("pointermove",e=>{const d=this.drag;if(!d||d.id!==e.pointerId)return;
  if(!d.moved){if(Math.hypot(e.clientX-d.x,e.clientY-d.y)<5)return;d.moved=true;el.classList.add("dragging");const r=el.getBoundingClientRect(),g=document.createElement("img");g.className="ghost-pc";g.alt="";g.src=this.pcSrc(d.p);g.style.width=g.style.height=r.width/8+"px";el.appendChild(g);d.g=g;this.dragFrom=d.from;this.draw()}
  const r=el.getBoundingClientRect();d.g.style.left=e.clientX-r.left+"px";d.g.style.top=e.clientY-r.top+"px"});
 const end=(e,drop)=>{const d=this.drag;if(!d||d.id!==e.pointerId)return;this.drag=null;this.dragFrom=null;el.classList.remove("dragging");if(d.g)d.g.remove();
  if(!d.moved){if(d.was){this.sel=null;this.targets=[];this.draw()}return}const to=drop&&sqAt(e);
  if(to&&to!==d.from&&this.targets.includes(to)){this.sel=null;this.targets=[];this.noAnim=true;this.onMove(d.from,to)}else this.draw()};
 el.addEventListener("pointerup",e=>end(e,true));el.addEventListener("pointercancel",e=>end(e,false));
 el.addEventListener("keydown",e=>{if(this.lock)return;const k=e.key,F="abcdefgh";if(!this.kb)this.kb=this.flip?"e7":"e2";let f=F.indexOf(this.kb[0]),r=+this.kb[1];const dir=this.flip?-1:1;
  if(k==="ArrowUp")r=Math.min(8,Math.max(1,r+dir));else if(k==="ArrowDown")r=Math.min(8,Math.max(1,r-dir));else if(k==="ArrowLeft")f=Math.min(7,Math.max(0,f-dir));else if(k==="ArrowRight")f=Math.min(7,Math.max(0,f+dir));
  else if(k==="Enter"||k===" "){e.preventDefault();this.kbOn=true;this.click(this.kb);return}else if(k==="Escape"){this.sel=null;this.targets=[];this.draw();return}else return;
  e.preventDefault();this.kb=F[f]+r;this.kbOn=true;const p=new Chess(this.fen).get(this.kb);this.live.textContent=this.kb+(p?` ${p.color==="w"?"white":"black"} ${({p:"pawn",n:"knight",b:"bishop",r:"rook",q:"queen",k:"king"})[p.type]}`:"");this.draw()});
 el.addEventListener("blur",()=>{if(this.kbOn){this.kbOn=false;this.draw()}})}
Board.prototype.pcSrc=function(p){return `vendor/pieces/${UI.pieces==="bold"?"bold":"cburnett"}/${p.color}${p.type.toUpperCase()}.svg`};
Board.prototype.sqXY=function(sq){let x="abcdefgh".indexOf(sq[0]),y=8-+sq[1];if(this.flip){x=7-x;y=7-y}return [x,y]};
Board.prototype.click=function(sq){if(this.lock)return;const c=new Chess(this.fen);if(this.sel&&this.targets.includes(sq)){const from=this.sel;this.sel=null;this.targets=[];this.live.textContent=`${from} to ${sq}`;this.onMove(from,sq);return}
 const p=c.get(sq);if(p&&p.color===c.turn()){this.sel=sq;this.targets=c.moves({square:sq,verbose:true}).map(m=>m.to);this.live.textContent=`${sq} selected`}else{this.sel=null;this.targets=[]}this.draw()};
/* o: {last: {from, to}, arrows: [{from, to, c: "green"|"red"|"blue"}], hl: square}. A position reached by `last` from the shown one slides and may click. */
Board.prototype.set=function(fen,o){o=o||{};const prev=this.fen,L=o.last;let mv=null;
 if(L&&prev!==fen){const a=new Chess(prev).get(L.from),b=new Chess(fen).get(L.to);if(a&&b&&a.color===b.color)mv={...L,cap:(prev.split(" ")[0].match(/[a-z]/gi)||[]).length>(fen.split(" ")[0].match(/[a-z]/gi)||[]).length}}
 this.fen=fen;this.last=L||null;this.arrows=o.arrows||[];this.hl=o.hl||null;this.sel=null;this.targets=[];this.draw(mv&&!this.noAnim&&!RM()?mv:null);this.noAnim=false;
 if(mv&&this.sound)Snd.play(mv.cap?"capture":"move")};
Board.prototype.draw=function(anim){const c=new Chess(this.fen),B=c.board(),F="abcdefgh",AC={green:"var(--ar-green)",red:"var(--ar-red)",blue:"var(--ar-blue)"};let s='<svg viewBox="0 0 8 8" aria-hidden="true">';
 const chk=c.in_check()?(()=>{for(let r=0;r<8;r++)for(let f=0;f<8;f++){const p=B[r][f];if(p&&p.type==="k"&&p.color===c.turn())return F[f]+(8-r)}})():null;
 if(chk)s+='<defs><radialGradient id="chk'+this.el.id+'"><stop offset="0" stop-color="var(--hl-check)" stop-opacity=".95"/><stop offset=".55" stop-color="var(--hl-check)" stop-opacity=".45"/><stop offset="1" stop-color="var(--hl-check)" stop-opacity="0"/></radialGradient></defs>';
 for(let r=0;r<8;r++)for(let f=0;f<8;f++){const sq=F[f]+(8-r),[x,y]=this.sqXY(sq),lt=(r+f)%2===0;s+=`<rect x="${x}" y="${y}" width="1" height="1" style="fill:var(${lt?"--sq-l":"--sq-d"})"/>`;
  if(this.last&&(this.last.from===sq||this.last.to===sq))s+=`<rect x="${x}" y="${y}" width="1" height="1" style="fill:var(--hl-last)"/>`;
  if(this.sel===sq||this.hl===sq)s+=`<rect x="${x}" y="${y}" width="1" height="1" style="fill:var(--hl-sel)"/>`;
  if(chk===sq)s+=`<rect x="${x}" y="${y}" width="1" height="1" fill="url(#chk${this.el.id})"/>`;
  if(y===7)s+=`<text class="coord" x="${x+.94}" y="${y+.93}" text-anchor="end" style="fill:var(${lt?"--sq-d":"--sq-l"})">${sq[0]}</text>`;
  if(x===0)s+=`<text class="coord" x="${x+.06}" y="${y+.22}" style="fill:var(${lt?"--sq-d":"--sq-l"})">${sq[1]}</text>`}
 for(let r=0;r<8;r++)for(let f=0;f<8;f++){const p=B[r][f];if(!p)continue;const sq=F[f]+(8-r),[x,y]=this.sqXY(sq);s+=`<image class="pc" data-sq="${sq}" href="${this.pcSrc(p)}" x="${x}" y="${y}" width="1" height="1"${this.dragFrom===sq?' opacity=".3"':""}/>`}
 for(const t of this.targets){const [x,y]=this.sqXY(t);s+=c.get(t)?`<circle cx="${x+.5}" cy="${y+.5}" r=".45" fill="none" style="stroke:var(--dot)" stroke-width=".09"/>`:`<circle cx="${x+.5}" cy="${y+.5}" r=".16" style="fill:var(--dot)"/>`}
 if(this.kbOn&&this.kb){const [x,y]=this.sqXY(this.kb);s+=`<rect x="${x+.04}" y="${y+.04}" width=".92" height=".92" rx=".06" fill="none" style="stroke:var(--focus)" stroke-width=".08"/>`}
 for(const a of this.arrows){const [x1,y1]=this.sqXY(a.from),[x2,y2]=this.sqXY(a.to),dx=x2-x1,dy=y2-y1,L=Math.hypot(dx,dy)||1,ux=dx/L,uy=dy/L,col=AC[a.c]||AC.blue;
  const sx=x1+.5+ux*.22,sy=y1+.5+uy*.22,hx=x2+.5-ux*.12,hy=y2+.5-uy*.12,bx=hx-ux*.42,by=hy-uy*.42,w=.13,hw=.3;
  s+=`<g opacity=".82" style="fill:${col}"><path d="M${sx-uy*w/2},${sy+ux*w/2}L${bx-uy*w/2},${by+ux*w/2}L${bx-uy*hw},${by+ux*hw}L${hx},${hy}L${bx+uy*hw},${by-ux*hw}L${bx+uy*w/2},${by-ux*w/2}L${sx+uy*w/2},${sy-ux*w/2}Z"/></g>`}
 this.host.innerHTML=s+"</svg>";
 if(anim){const im=this.host.querySelector(`image[data-sq="${anim.to}"]`);if(im){const [x1,y1]=this.sqXY(anim.from),[x2,y2]=this.sqXY(anim.to);im.style.transition="none";im.style.transform=`translate(${x1-x2}px,${y1-y2}px)`;im.getBoundingClientRect();requestAnimationFrame(()=>{im.style.transition="";im.style.transform="";setTimeout(()=>im.removeAttribute("style"),260)})}}};
/* vertical eval bar (white's share); flip = black at the bottom */
function EvalBar(el){this.el=el;el.innerHTML='<b></b><span class="top"></span><span class="bot"></span>';el.setAttribute("role","img")}
EvalBar.prototype.set=function(cp,flip){const el=this.el;el.hidden=false;el.classList.toggle("flip",!!flip);if(cp==null){el.classList.add("wait");el.setAttribute("aria-label","Evaluation: working it out");return}
 el.classList.remove("wait");el.querySelector("b").style.height=Math.max(3,Math.min(97,wp(cp)))+"%";const w=flip?"top":"bot",bl=flip?"bot":"top",t=evTxt(cp);
 el.querySelector("."+w).textContent=cp>=0?t.replace("+",""):"";el.querySelector("."+bl).textContent=cp<0?t.replace("−",""):"";el.setAttribute("aria-label","Evaluation "+t)};
EvalBar.prototype.hide=function(){this.el.hidden=true};

/* ---------- REVIEW ---------- */
const RB=new Board($("#board"),{sound:true,label:"Game board"}),REB=new EvalBar($("#evBar"));
function filtered(){const f=$("#gameFilter").value;return GAMES.filter(g=>f==="all"||(f==="loss"&&g.result==="loss")||(f==="win"&&g.result==="win")||f===g.color||(f==="an"&&g.an)).slice().reverse()}
function fillPicker(){const list=filtered().slice(0,500),sel=$("#gamePick");
 sel.innerHTML=list.length?list.map(g=>{const e=g.an?serious(g).filter(x=>x.kind==="blunder").length:null;
  return `<option value="${esc(g.id)}">${g.date} · ${g.color==="w"?"White":"Black"} · ${g.result==="win"?"Won":g.result==="loss"?"Lost":"Draw"} vs ${esc(g.opp)} · ${esc(famOf(g.eco))}${e==null?" · not analysed":e?` · ${e} blunder${e>1?"s":""}`:" · clean"}</option>`}).join(""):"<option>No games match</option>";
 if(CUR)sel.value=CUR.id}
function openGame(g,ply){CUR=replay(g);RB.flip=g.color==="b";PLY=ply==null?0:ply;
 const res=g.result==="win"?"Won":g.result==="loss"?"Lost":"Drew",how={checkmated:"checkmate",resigned:"resignation",timeout:"on time",abandoned:"abandoned"}[g.how];
 $("#gTitle").textContent=`${res} with ${g.color==="w"?"White":"Black"}${how?` (${how})`:""}`;
 $("#gSub").innerHTML=`${esc(g.date)} · ${esc(famOf(g.eco))} · you ${g.myR} vs ${esc(g.opp)} ${g.oppR} · ${Math.ceil(g.moves.length/2)} moves${g.link?` · <a href="${esc(g.link)}" target="_blank" rel="noopener">on ${SRC[srcOf(g)].name}</a>`:""}`;
 renderMoves();renderKM();renderAnState();show();$("#gamePick").value=g.id}
function show(){const g=CUR;if(!g)return;if(g.an&&GS&&!GS.rev[g.id]){(g._seen||(g._seen=new Set())).add(PLY);if(g._seen.size>=8){GS.rev[g.id]=1;gAdd(g.result==="loss"?{rv:1,rvl:1}:{rv:1})}}const m=g._m[PLY-1],o={last:m?{from:m.from,to:m.to}:null,arrows:[]};
 if(g.an&&PLY<g.moves.length&&g.an.best[PLY]){const er=errorsOf(g).find(e=>e.i===PLY);if(er&&er.kind!=="inacc"){const nx=g._m[PLY],b=g.an.best[PLY];o.arrows.push({from:nx.from,to:nx.to,c:"red"},{from:b.slice(0,2),to:b.slice(2,4),c:"green"})}}
 RB.set(g._f[PLY],o);if(g.an&&g.an.ev[PLY]!=null)REB.set(g.an.ev[PLY],RB.flip);else REB.hide();document.querySelectorAll("#moves button,#km button").forEach(b=>b.classList.toggle("on",+b.dataset.p===PLY));
 const on=document.querySelector("#moves button.on"),mv=$("#moves");if(on){const t=on.offsetTop;if(t<mv.scrollTop||t>mv.scrollTop+mv.clientHeight-30)mv.scrollTop=t-mv.clientHeight/2}
 $("#evNow").textContent=g.an&&g.an.ev[PLY]!=null?`Move ${PLY?mvLabel(PLY-1):"0"} · ${evTxt(g.an.ev[PLY])}`:"";drawEval()}
/* scoresheet: move-quality marks from the analysis: ?? blunder, ? mistake, ?! inaccuracy, a check where the move was the engine's own */
function renderMoves(){const g=CUR,er=errorsOf(replay(g)),tag={blunder:"??",mistake:"?",inacc:"?!"},nm={blunder:"blunder",mistake:"mistake",inacc:"inaccuracy"};let h="";
 for(let i=0;i<g.moves.length;i+=2){h+=`<span class="n">${i/2+1}</span>`;for(const j of [i,i+1]){if(j>=g.moves.length){h+="<span></span>";continue}const e=er.find(x=>x.i===j),m=g._m[j],best=g.an&&m&&g.an.best[j]===m.from+m.to+(m.promotion||"");
  h+=`<span><button data-p="${j+1}" class="${e?"q-"+e.kind:best?"q-best":""}"${e?` aria-label="${esc(g.moves[j])}, ${nm[e.kind]}"`:best?` aria-label="${esc(g.moves[j])}, best move"`:""}>${esc(g.moves[j])}${e?`<span class="qm t-${e.kind}" aria-hidden="true">${tag[e.kind]}</span>`:best?`<span class="qm t-best" aria-hidden="true">${ic("check","sm")}</span>`:""}</button></span>`}}
 $("#moves").innerHTML=h}
function renderKM(){const g=CUR;if(!g.an){$("#km").innerHTML='<div class="empty">Analyse this game to see where it turned.</div>';return}
 const er=serious(g);if(!er.length){$("#km").innerHTML=`<div class="verdict v-ok">${ic("circle-check")}No blunders or mistakes from you in this game. Nicely played.</div>`;return}
 $("#km").innerHTML=er.map(e=>{const sp=spent(g,e.i),cl=g.clocks&&g.clocks[e.i],bs=uciSan(g._f[e.i],e.best),ctx=e.before>200?"You were winning. ":e.before<-200?"You were already worse. ":"";
  return `<button data-p="${e.i}"><span class="km-q t-${e.kind}" aria-hidden="true">${e.kind==="blunder"?"??":"?"}</span><span><b>${mvLabel(e.i)} ${esc(g.moves[e.i])}</b> <span class="km-kind t-${e.kind}">${e.kind}</span> · better <b>${esc(bs||"?")}</b><br><span class="small">${ctx}${evTxt(e.before)} → ${evTxt(e.after)}${sp!=null?` · thought ${sp}s, ${mmss(cl)} left`:""}</span></span><span class="small num">−${Math.round(e.drop)}%</span></button>`}).join("")}
function renderAnState(){const g=CUR;$("#anState").innerHTML=g.an?`<div class="small legend"><span><span class="k k-green"></span>better move</span><span><span class="k k-red"></span>what was played</span><span>Stockfish depth ${g.an.depth}</span></div>`:`<div class="row"><button class="pri" id="anOne">${ic("cpu")}Analyse this game</button><span class="small">About 30 seconds, on your device.</span></div>`;
 const b=$("#anOne");if(b)b.onclick=()=>{queue([g],true);b.disabled=true;b.textContent="Queued…"}}
function drawEval(){const el=$("#evFig"),g=CUR;if(!g||!g.an){el.innerHTML='<div class="empty" style="height:100%;display:grid;place-items:center">No evaluation yet</div>';el.onclick=null;return}
 const W=el.clientWidth||400,H=el.clientHeight,n=g.an.ev.length-1||1,X=i=>i/n*W,Y=cp=>H-(wp(Math.max(-1500,Math.min(1500,cp==null?0:cp)))/100)*H;
 const p=`M0,${H} `+g.an.ev.map((c,i)=>`L${X(i).toFixed(1)},${Y(c).toFixed(1)}`).join(" ")+` L${W},${H}Z`;
 el.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Evaluation through the game"><rect width="${W}" height="${H}" fill="#3b3540"/><path d="${p}" fill="#f4f1ec"/><line x1="0" x2="${W}" y1="${H/2}" y2="${H/2}" stroke="#8a8090" stroke-dasharray="4 4"/>
 ${serious(g).map(e=>`<circle cx="${X(e.i+1)}" cy="${Y(g.an.ev[e.i+1])}" r="5.5" style="fill:var(${e.kind==="blunder"?"--q-blunder":"--q-mistake"})" stroke="#fff" stroke-width="2"/>`).join("")}
 <line x1="${X(PLY)}" x2="${X(PLY)}" y1="0" y2="${H}" style="stroke:var(--primary)" stroke-width="2.5"/></svg>`;
 el.onclick=e=>{const r=el.getBoundingClientRect();PLY=Math.max(0,Math.min(CUR.moves.length,Math.round((e.clientX-r.left)/r.width*n)));show()}}
new ResizeObserver(()=>{if(CUR)drawEval()}).observe($("#evFig"));
function nav(a){if(!CUR)return;const n=CUR.moves.length;PLY=a==="start"?0:a==="end"?n:a==="prev"?Math.max(0,PLY-1):Math.min(n,PLY+1);show()}
document.querySelectorAll("[data-nav]").forEach(b=>b.onclick=()=>nav(b.dataset.nav));
$("#flipBtn").onclick=()=>{RB.flip=!RB.flip;show()};
$("#moves").onclick=e=>{const b=e.target.closest("button");if(b){PLY=+b.dataset.p;show()}};
$("#km").onclick=e=>{const b=e.target.closest("button");if(b){PLY=+b.dataset.p;show()}};
$("#gamePick").onchange=()=>{const g=GAMES.find(x=>x.id===$("#gamePick").value);if(g)openGame(g)};
$("#gameFilter").onchange=()=>{fillPicker();const g=GAMES.find(x=>x.id===$("#gamePick").value);if(g)openGame(g)};
function stepGame(d){const l=filtered(),i=l.indexOf(CUR),g=l[Math.max(0,Math.min(l.length-1,i+d))];if(g)openGame(g)}
$("#prevG").onclick=()=>stepGame(1);$("#nextG").onclick=()=>stepGame(-1);
document.addEventListener("keydown",e=>{if(route.cur!=="review"||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
 if(e.key==="ArrowLeft"){nav("prev");e.preventDefault()}if(e.key==="ArrowRight"){nav("next");e.preventDefault()}if(e.key==="Home")nav("start");if(e.key==="End")nav("end")});
function openDefault(){const g=GAMES.slice().reverse().find(g=>g.result==="loss"&&g.an&&serious(g).some(e=>e.kind==="blunder"))||GAMES[GAMES.length-1];
 if(g){const fe=serious(g).find(e=>e.kind==="blunder");openGame(g,fe?fe.i:0)}}

/* ---------- analysis queue ---------- */
let AQ=null;
async function queue(list,front){list=list.filter(g=>!g.an);if(!list.length)return;
 if(AQ){front?AQ.list.unshift(...list):AQ.list.push(...list);return}
 const gen=GEN;AQ={list,done:0};
 try{while(AQ.list.length&&gen===GEN){const g=replay(AQ.list.shift());if(g.an)continue;const ev=[],best=[];
  for(let i=0;i<g._f.length;i++){if(gen!==GEN)break;const c=new Chess(g._f[i]);if(c.game_over()){ev.push(c.in_checkmate()?(c.turn()==="w"?-10000:10000):0);best.push(null)}else{const r=await Engine.eval(g._f[i],DEPTH);ev.push(r.cp);best.push(r.best)}
   job("an",`Analysing game ${AQ.done+1} of ${AQ.done+AQ.list.length+1}`,(i+1)/g._f.length)}
  if(gen!==GEN)break;g.an={ev,best:best.slice(0,-1),depth:DEPTH};DB.put([g]);Sync.mark("an",g.id);Fr.soon();AQ.done++;maybeBaseline();
  if(CUR===g){renderMoves();renderKM();renderAnState();show()}fillPicker();buildPuzzles();if(route.cur==="progress")renderProgress();if(route.cur==="trainer"&&!PI)loadPuzzle(pickPuzzle());if(route.cur==="home")renderHome()}}
 catch(e){$("#anState").innerHTML=`<div class="verdict v-no">${ic("triangle-alert")}The engine couldn't start in this browser.</div>`}
 AQ=null;job("an",null);if(P&&gen===GEN){maybeBaseline();gCheck();TG.run()}if(route.cur==="progress")renderProgress();if(route.cur==="home"&&P)renderHome();if(CUR&&!CUR.an)renderAnState()}
function analyseRecent(n){queue(GAMES.slice().reverse().filter(g=>!g.an).slice(0,n))}

/* ---------- TRAINER ---------- */
/* ---------- WHY panel: engine lines that explain a move (shared by the Trainer and the opening drill) ----------
   Computed only on demand (wrong move, Show answer, Why?), at depth WHY_D, jumping the analysis queue; engine results
   are cached per position (WEV). Every line is replayed with chess.js and cut at the first illegal move; lines shorter
   than 6 plies are extended from their last position. Labels are fixed rules over material and mate at the line's end. */
const WHY_D=14,WHY_SHOW=8,WHY_MAX=16,WEV=new Map(),VAL={p:1,n:3,b:3,r:5,q:9};
const wEval=fen=>{const k=posKey(fen);if(!WEV.has(k))WEV.set(k,Engine.eval(fen,WHY_D,true).catch(e=>{WEV.delete(k);throw e}));return WEV.get(k)};
/* line from fen (starting with move `first` when given): {fen, L:[{san,from,to,cap,fen}], cp: eval after the first move, white's view} */
async function wLine(fen,first){const c=new Chess(fen),L=[];let cp=null;
 const push=u=>{const m=u&&c.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]||"q"});if(!m)return false;L.push({san:m.san,from:m.from,to:m.to,cap:!!m.captured,fen:c.fen()});return true};
 if(first&&!push(first))return null;
 for(let k=0;k<3&&L.length<WHY_SHOW&&!c.game_over();k++){const r=await wEval(c.fen());if(k===0)cp=r.cp;let n=0;for(const u of r.pv){if(L.length>=WHY_MAX||!push(u))break;n++}if(!n)break}
 if(cp==null&&c.in_checkmate())cp=c.turn()==="w"?-10000:10000;return {fen,L,cp}}
const matOf=fen=>{const m={w:{p:0,n:0,b:0,r:0,q:0},b:{p:0,n:0,b:0,r:0,q:0}};for(const ch of fen.split(" ")[0]){const t=ch.toLowerCase();if(VAL[t])m[ch===t?"b":"w"][t]++}return m};
const balOf=(m,me)=>{const op=me==="w"?"b":"w";let s=0;for(const t in VAL)s+=VAL[t]*(m[me][t]-m[op][t]);return s};
const piecesTxt=d=>{const PL={p:"pawns",n:"knights",b:"bishops",r:"rooks",q:"queens"},ONE={p:"a pawn",n:"a knight",b:"a bishop",r:"a rook",q:"the queen"},out=[];
 for(const t of ["q","r","b","n","p"]){const k=d[t]||0;if(k>0)out.push(k===1?ONE[t]:(k===2?"two ":k+" ")+PL[t])}return out.join(" and ")};
/* plain-language label of a line for `me` (the side to move at its start). keep: allow "keeps an extra pawn" (not for a wrong move) */
function wLabel(line,me,keep){if(!line||!line.L.length)return null;const L=line.L,op=me==="w"?"b":"w";let e=Math.min(L.length,WHY_SHOW);while(e<L.length&&L[e-1].cap)e++;   // don't stop mid-exchange
 const end=L[e-1].fen,c=new Chess(end),cp=line.cp==null?null:me==="w"?line.cp:-line.cp;
 if(c.in_checkmate())return c.turn()===me?{t:"gets mated",y:"you get mated"}:{t:"gives mate",y:"you give mate"};
 if(cp!=null&&Math.abs(cp)>=9000){const n=10000-Math.abs(cp);return cp>0?{t:`mates in ${n}`,y:`you mate in ${n}`}:{t:`allows mate in ${n}`,y:`they mate in ${n}`}}
 const m0=matOf(line.fen),m1=matOf(end),lost={},got={};for(const t in VAL){const a=m0[me][t]-m1[me][t],b=m0[op][t]-m1[op][t];if(a>0)lost[t]=a;if(b>0)got[t]=b}
 const net=balOf(m1,me)-balOf(m0,me),b0=balOf(m0,me),b1=balOf(m1,me),lt=piecesTxt(lost)||"material",gt=piecesTxt(got)||"material";
 const exch=(a,b)=>a.r===1&&!a.q&&!a.n&&!a.b&&!b.r&&!b.q&&(b.n||0)+(b.b||0)===1;
 if(net<=-2&&exch(lost,got))return {t:"loses the exchange",y:"you've lost the exchange"};
 if(net>=2&&exch(got,lost))return {t:"wins the exchange",y:"you win the exchange"};
 if(net<=-1)return {t:`loses ${lt}${piecesTxt(got)?` for ${gt}`:""}`,y:`you've lost ${lt}${piecesTxt(got)?` for ${gt}`:""}`};
 if(net>=1)return {t:`wins ${gt}${piecesTxt(lost)?` for ${lt}`:""}`,y:`you win ${gt}${piecesTxt(lost)?` for ${lt}`:""}`};
 if(keep&&b0>=1){const x={1:"an extra pawn",2:"two extra pawns",3:"an extra piece",4:"an extra piece",5:"an extra rook"}[b0]||"a material advantage";return {t:`keeps ${x}`,y:`you keep ${x}`}}
 if(b1===0&&cp!=null&&Math.abs(cp)>=60)return cp>0?{t:"equal material, better position",y:"you're better with equal material"}:{t:"equal material, worse position",y:"you're worse with equal material"};
 return null}
/* move text with move numbers from fen: "5. Nd6+ exd6 6. Bd3" / "5… exd6 6. Bd3" */
const wMoves=(fen,L)=>{const f=fen.split(" "),w=f[1]==="w",n0=+f[5]||1;return L.map((m,j)=>{const wm=(j%2===0)===w,n=n0+Math.floor((j+(w?0:1))/2);return {num:wm?n+".":j===0?n+"…":"",san:m.san}})};
function Why(el,board,bar){this.el=el;this.b=board;this.bar=bar;this.tok=0}
Why.prototype.clear=function(){this.tok++;this.el.innerHTML="";this.b.lock=false;if(this.bar)this.bar.hide()};
/* o: {fen, played: UCI of the move being explained, best: UCI of the right move (optional), ok: played was right, restore(): redraw the drill/puzzle position} */
Why.prototype.show=async function(o){const t=++this.tok,gen=GEN;this.o=o;this.b.lock=false;this.el.innerHTML='<div class="why-wait" role="status"><span class="sr-only">Working out why…</span><span class="skel" style="width:85%"></span><span class="skel" style="width:60%"></span><span class="skel" style="width:72%"></span></div>';
 const me=o.fen.split(" ")[1],opp=me==="w"?"Black":"White";let ev0=null,A=null,B=null;
 try{ev0=(await wEval(o.fen)).cp;if(t!==this.tok)return;if(o.played)A=await wLine(o.fen,o.played);if(t!==this.tok)return;
  if(!o.ok){const pv0=(await wEval(o.fen)).pv[0],b=o.best&&o.best!==o.played?o.best:pv0&&pv0!==o.played?pv0:null;if(b)B=await wLine(o.fen,b!==pv0?b:null)}}catch(e){}
 if(t!==this.tok||gen!==GEN)return;if(!A&&!B){this.el.innerHTML='<p class="small">Couldn\'t work out the lines for this position.</p>';return}
 const la=wLabel(A,me,!!o.ok),lb=wLabel(B,me,true),sw=(a,b)=>a!=null&&b!=null?`the evaluation goes ${evTxt(a)} → ${evTxt(b)}`:"",S=[];
 if(A&&!o.ok){const r=A.L[1];S.push(`After ${A.L[0].san}${r?`, ${opp} plays ${r.san}`:""}${la?` and ${la.y}`:sw(ev0,A.cp)?`: ${sw(ev0,A.cp)}`:""}.`)}
 if(A&&o.ok)S.push(`${A.L[0].san} works: ${la?la.t:`it keeps the evaluation at ${evTxt(A.cp)}`}.`);
 if(B)S.push(`${B.L[0].san} is better: ${lb?lb.t:`the evaluation stays ${evTxt(B.cp)}`}.`);
 this.render(S.join(" "),[A&&{title:o.ok?"Why it works":"Your move",c:o.ok?"green":"red",x:A,lab:la},B&&{title:"Better",c:"green",x:B,lab:lb}].filter(Boolean))};
/* draw a sentence and lines ({title, c: "red"|"green", x: {fen, L}, lab: {t}}); also used by the start screen's demo */
Why.prototype.render=function(say,lines){this.lines=lines;this.cur=null;
 this.el.innerHTML=`<p class="why-say">${esc(say)}</p>`+this.lines.map((l,i)=>`<div class="why-line ${l.c}" data-i="${i}"><div class="why-head"><b>${l.title}</b>${l.lab?` <span class="tag">${esc(l.lab.t)}</span>`:""}</div>`+
  `<p class="why-moves">${wMoves(l.x.fen,l.x.L.slice(0,WHY_SHOW)).map((m,k)=>`${m.num?`<span class="num">${m.num}</span> `:""}<button class="why-mv" type="button" data-k="${k+1}">${esc(m.san)}</button>`).join(" ")}</p>`+
  `<div class="why-nav"><button type="button" data-a="back" aria-label="Back one move">${ic("chevron-left","sm")}Back</button><button type="button" data-a="fwd" aria-label="Forward one move">Forward${ic("chevron-right","sm")}</button><button class="link" type="button" data-a="reset">Back to the position</button></div></div>`).join("");
 this.el.querySelectorAll(".why-line").forEach(d=>{const i=+d.dataset.i;d.querySelectorAll("[data-k]").forEach(b=>b.onclick=()=>this.step(i,+b.dataset.k));
  d.querySelector('[data-a="back"]').onclick=()=>this.step(i,(this.cur&&this.cur.i===i?this.cur.k:1)-1);d.querySelector('[data-a="fwd"]').onclick=()=>this.step(i,(this.cur&&this.cur.i===i?this.cur.k:0)+1);
  d.querySelector('[data-a="reset"]').onclick=()=>this.reset()})};
/* show line i after k plies: last move highlighted, arrow for the next move */
Why.prototype.step=function(i,k){const l=this.lines[i];if(!l)return;const L=l.x.L.slice(0,WHY_SHOW);k=Math.max(0,Math.min(L.length,k));this.cur={i,k};this.b.lock=true;
 const m=L[k-1],nx=L[k],fen=k?m.fen:l.x.fen;this.b.set(fen,{last:m?{from:m.from,to:m.to}:null,arrows:nx?[{from:nx.from,to:nx.to,c:l.c}]:[]});
 if(this.bar){const bar=this.bar,t=this.tok,cur=this.cur;bar.set(null,this.b.flip);wEval(fen).then(r=>{if(t===this.tok&&this.cur===cur)bar.set(r.cp,this.b.flip)}).catch(()=>{})}
 this.el.querySelectorAll(".why-mv").forEach(b=>b.classList.toggle("on",+b.closest(".why-line").dataset.i===i&&+b.dataset.k===k))};
Why.prototype.reset=function(){this.cur=null;this.b.lock=false;this.b.noAnim=true;if(this.bar)this.bar.hide();this.el.querySelectorAll(".why-mv.on").forEach(b=>b.classList.remove("on"));if(this.o&&this.o.restore)this.o.restore()};

/* session counters (this visit only): attempts, solved, current run of correct answers */
const TSS={n:0,ok:0,run:0,best:0},OSS={n:0,ok:0,run:0,best:0};
function sess(S,ok,el){S.n++;if(ok){S.ok++;S.run++;S.best=Math.max(S.best,S.run)}else S.run=0;
 $(el).innerHTML=`<span class="chip">${ic("target","sm")}${S.ok}/${S.n} this session</span><span class="chip xp">${ic("flame","sm")}${S.run} in a row</span>${S.best>2?`<span class="chip gold">${ic("trophy","sm")}best ${S.best}</span>`:""}`}
const TB=new Board($("#tboard"),{onMove:tryMove,label:"Puzzle board"}),TW=new Why($("#tWhy"),TB,new EvalBar($("#tEv")));let PZ=[],PI=null,HINT=0,DONE=false;
const TST=()=>{const t=LS.get(uk("trainer"),{});return t};let TS={};
function buildPuzzles(){PZ=[];for(const g of GAMES){if(!g.an)continue;replay(g);for(const e of serious(g))if(wp(e.before)>=30&&e.best)PZ.push({id:g.id+":"+e.i,g,e})}PZ.sort((a,b)=>b.g.ts-a.g.ts);if(route.cur==="trainer")renderTStats()}
function pickPuzzle(){const st=id=>TS[id]||{};const failed=PZ.filter(p=>st(p.id).fail&&!st(p.id).ok),fresh=PZ.filter(p=>!st(p.id).seen);const pool=failed.length?failed:fresh.length?fresh:PZ;return pool[0]||null}
function loadPuzzle(p){PI=p;HINT=0;DONE=false;TW.clear();$("#tFeedback").innerHTML="";$("#tMeta").innerHTML="";
 $("#tPrompt").className="verdict v-info";if(!p){$("#tPrompt").textContent=AQ?"Your games are being analysed — puzzles appear here as soon as the first one is done.":"No puzzles yet. Analyse a few games first (Progress → Analyse 20 more games).";TB.flip=false;TB.set(new Chess().fen());renderTStats();return}
 const g=p.g,e=p.e,c=new Chess(g._f[e.i]),m=g._m[e.i-1];TB.flip=c.turn()==="b";TB.set(g._f[e.i],{last:m?{from:m.from,to:m.to}:null});
 $("#tPrompt").innerHTML=`${ic("target")}<b>${c.turn()==="w"?"White":"Black"} to move.</b> Find the best move.`;$("#tPrompt").className="verdict v-move";
 $("#tMeta").innerHTML=`<span>From your game on ${esc(g.date)} vs ${esc(g.opp)} · ${esc(famOf(g.eco))} · move ${Math.floor(e.i/2)+1}</span>`;renderTStats()}
const saveTS=()=>{LS.set(uk("trainer"),TS);if(PI)Sync.mark("pz",acct()+"|"+PI.id);Fr.soon()};
async function tryMove(from,to){if(!PI||DONE)return;const p=PI,fen=p.g._f[p.e.i],c=new Chess(fen),mv=c.move({from,to,promotion:"q"});if(!mv)return;const u=from+to;TW.clear();
 const back=()=>TB.set(c.fen(),{last:{from,to}});
 TB.set(c.fen(),{last:{from,to}});const st=TS[p.id]||(TS[p.id]={}),was=!!st.ok;st.seen=1;let ok=u===p.e.best.slice(0,4),note="";
 if(!ok){$("#tFeedback").innerHTML='<div class="skel-wrap" role="status"><span class="sr-only">Checking your move…</span><span class="skel" style="width:55%"></span></div>';try{const r=await Engine.eval(c.fen(),12),s=fen.split(" ")[1]==="w"?1:-1;ok=wp(s*p.g.an.ev[p.e.i])-wp(s*r.cp)<8;if(ok)note=" Not the engine's first choice, but just as good."}catch(x){}}
 if(PI!==p)return;
 Snd.play(ok?"correct":"wrong");sess(TSS,ok,"#tSess");if(ok){DONE=true;st.ok=1;const award=!was&&!st.x;if(award)st.x=1;saveTS();if(award)gAdd(st.fail?{pz:1}:{pz:1,p1:1});const bs=uciSan(fen,p.e.best);$("#tFeedback").innerHTML=`<div class="verdict v-ok">${ic("circle-check")}Correct — ${esc(mv.san)}.${note} In the game you played ${esc(p.g.moves[p.e.i])}${bs&&bs!==mv.san?`; the engine's move is ${esc(bs)}`:""}.</div><button class="link" id="tWhyBtn" type="button">Why?</button>`;
  $("#tWhyBtn").onclick=()=>{$("#tWhyBtn").remove();TW.show({fen,played:mv.from+mv.to+(mv.promotion||""),ok:true,restore:back})}}
 else{st.fail=(st.fail||0)+1;st.ok=0;saveTS();$("#tFeedback").innerHTML=`<div class="verdict v-no">${ic("circle-x")}${esc(mv.san)} isn't it. Look again at checks, captures and threats — for both sides.</div><div class="v-actions"><button id="tRetry" type="button">${ic("rotate-ccw","sm")}Try again</button></div>`;$("#tRetry").onclick=()=>loadPuzzle(p);
  TW.show({fen,played:mv.from+mv.to+(mv.promotion||""),best:p.e.best,restore:back})}
 renderTStats()}
$("#tHint").onclick=()=>{if(!PI||DONE)return;HINT++;const b=PI.e.best,c=new Chess(PI.g._f[PI.e.i]),m=c.move({from:b.slice(0,2),to:b.slice(2,4),promotion:"q"});
 const kind=m.san.includes("#")?"There's a checkmate.":m.captured?"There's material to win.":m.san.includes("+")?"Start with a check.":"Think about what your opponent is threatening.";
 if(HINT===1)$("#tFeedback").innerHTML=`<div class="verdict v-info">${ic("info")}${kind}</div>`;else{TB.set(PI.g._f[PI.e.i],{hl:b.slice(0,2)});$("#tFeedback").innerHTML=`<div class="verdict v-info">${ic("info")}${kind} Move the highlighted piece.</div>`}};
$("#tShow").onclick=()=>{if(!PI)return;const p=PI,b=p.e.best,st=TS[p.id]||(TS[p.id]={});if(!DONE){st.seen=1;st.fail=(st.fail||0)+1;st.ok=0;saveTS()}DONE=true;
 const fen=p.g._f[p.e.i],bs=uciSan(fen,b),pl=p.g._m[p.e.i];TB.set(fen,{arrows:[{from:pl.from,to:pl.to,c:"red"},{from:b.slice(0,2),to:b.slice(2,4),c:"green"}]});
 $("#tFeedback").innerHTML=`<div class="verdict v-info">${ic("info")}The move was <b>${esc(bs)}</b> (green). You played ${esc(p.g.moves[p.e.i])} (red), which swung the game ${evTxt(p.e.before)} → ${evTxt(p.e.after)}.</div>`;renderTStats();
 const ar=[{from:pl.from,to:pl.to,c:"red"},{from:b.slice(0,2),to:b.slice(2,4),c:"green"}];TW.show({fen,played:pl.from+pl.to+(pl.promotion||""),best:b,restore:()=>TB.set(fen,{arrows:ar})})};
$("#tNext").onclick=()=>{if(PI){(TS[PI.id]||(TS[PI.id]={})).seen=1;saveTS()}const cur=PI;let p=pickPuzzle();if(p===cur&&PZ.length>1)p=PZ[(PZ.indexOf(cur)+1)%PZ.length];loadPuzzle(p)};
function renderTStats(){const st=id=>TS[id]||{};const solved=PZ.filter(p=>st(p.id).ok).length,missed=PZ.filter(p=>st(p.id).fail&&!st(p.id).ok).length,fresh=PZ.filter(p=>!st(p.id).seen).length;
 $("#tStats").innerHTML=`<div class="kpi"><b>${PZ.length}</b>puzzles from your games</div><div class="kpi"><b>${solved}</b>solved</div><div class="kpi goal"><b>${missed}</b>to retry</div><div class="kpi"><b>${fresh}</b>not seen yet</div>`}

/* ---------- OPENING TRAINER ----------
   For one colour + opening family (famOf, as in the openings table) the first 12 moves of the current account's
   games are merged into a tree keyed by position (posKey: first four FEN fields, so transpositions merge).
   Weak spots come from the stored analyses; the right move is the pinned repertoire move, else the engine's move
   from the analyses, else a quick deeper eval. Progress per position, like puzzle progress:
   uk("openings") = {posKey: {s: correct streak, due: next review (ms), ok, miss, pin: repertoire move (UCI), at: last change (ms)}},
   uk("opstart") = {"w|<family>": first drill (ms)}. Opponent moves follow how often my opponents played them;
   with a Lichess connection, thin spots are filled from the Lichess opening explorer (Explorer, cached locally). */
const OP_PLY=24,OP_TOL=6,OP_IV=[0,1,3,7,16,35,80],OP_LEARNED=3;   // plies, win-% tolerance, days to next review by streak, streak = learned
const posKey=fen=>fen.split(" ").slice(0,4).join(" "),opRes=g=>g.result==="win"?1:g.result==="draw"?.5:0;
const movesTxt=path=>path.map((m,i)=>i%2===0?mvLabel(i)+" "+m:m).join(" ");
let OPSEL=null,OT=null,OD=null,OPS={};
const OB=new Board($("#oboard"),{onMove:(f,t)=>opMove(f,t),label:"Opening board"}),OEV=new Map(),OW=new Why($("#oWhy"),OB,new EvalBar($("#oEv")));
const opBack=()=>{if(!OD)return;const h=OD.c.history({verbose:true}).slice(-1)[0];OB.set(OD.c.fen(),{last:h?{from:h.from,to:h.to}:null})};
const saveOPS=k=>{LS.set(uk("openings"),OPS);if(k)Sync.mark("op",acct()+"|"+k);Fr.soon()};
const opGames=(col,fam)=>GAMES.filter(g=>g.color===col&&famOf(g.eco)===fam);
const opLearned=()=>Object.values(OPS).filter(x=>(x.s||0)>=OP_LEARNED).length;
const isDue=k=>{const x=OPS[k];return !x||!x.due||x.due<=Date.now()};
function buildTree(col,fam){const T=new Map(),gs=opGames(col,fam),fs=score(gs)||0;
 for(const g of gs){replay(g);const er=g.an?errorsOf(g):[],r=opRes(g),N=Math.min(OP_PLY,g._m.length);
  for(let i=0;i<N;i++){const k=posKey(g._f[i]);let n=T.get(k);
   if(!n)T.set(k,n={k,fen:g._f[i],ply:i,path:g.moves.slice(0,i),mine:(i%2===0)===(g.color==="w"),n:0,sc:0,mv:{},anN:0,err:0,bv:{},ev:null});
   const m=g._m[i],u=m.from+m.to+(m.promotion||""),x=n.mv[u]||(n.mv[u]={u,san:m.san,n:0,sc:0,ck:posKey(g._f[i+1])});n.n++;n.sc+=r;x.n++;x.sc+=r;
   if(g.an&&g.an.ev[i]!=null){n.anN++;if(n.ev==null)n.ev=g.an.ev[i];const b=g.an.best[i];if(b)n.bv[b]=(n.bv[b]||0)+1;if(n.mine&&er.some(e=>e.i===i&&e.mine))n.err++}}}
 for(const n of T.values()){n.score=n.sc/n.n*100;n.best=Object.keys(n.bv).sort((a,b)=>n.bv[b]-n.bv[a])[0]||null;n.errRate=n.anN?n.err/n.anN:0;
  n.drop=n.n>=3?Math.max(0,fs-n.score):0;n.weak=n.mine&&((n.err>=1&&n.errRate>=.34)||n.drop>=10);n.prio=n.mine?n.n*(n.errRate+n.drop/100):0}
 return {col,fam,key:col+"|"+fam,T,games:gs,score:fs,sig:gs.length+"/"+gs.filter(g=>g.an).length}}
const opCore=()=>OT?[...OT.T.values()].filter(n=>n.mine&&(n.n>=2||n.weak)):[];
/* how much a subtree needs practice: a due core position within d plies */
function opNeed(k,d){const n=OT.T.get(k);if(!n||d<0)return 0;let v=n.mine&&(n.n>=2||n.weak)&&isDue(k)?1:0;if(d>0&&!v)for(const x of Object.values(n.mv)){v=Math.max(v,opNeed(x.ck,d-1));if(v)break}return v}
async function opEval(fen,d){const k=posKey(fen)+"|"+d;if(OEV.has(k))return OEV.get(k);const r=await Engine.eval(fen,d);OEV.set(k,r);return r}
function opGrade(k,ok){const x=OPS[k]||(OPS[k]={s:0,ok:0,miss:0}),now=Date.now();
 let xp=null;if(ok){if(!x.due||x.due<=now){x.s=(x.s||0)+1;x.due=now+OP_IV[Math.min(x.s,OP_IV.length-1)]*864e5;xp=x.s===OP_LEARNED?{op:1,ol:1}:{op:1}}x.ok=(x.ok||0)+1}
 else{x.s=0;x.due=now+10*6e4;x.miss=(x.miss||0)+1}     // a miss comes back within the session
 x.at=now;saveOPS(k);const st=LS.get(uk("opstart"),{});if(!st[OT.key]){st[OT.key]=now;LS.set(uk("opstart"),st);Sync.mark("ops",acct()+"|"+OT.key)}if(xp)gAdd(xp)}
/* opponent move: weighted by how often my opponents played it, nudged towards lines with positions due for review;
   where my games are thin (< 3 games), add the Lichess explorer's moves at my rating (worth 2 games in total) */
async function opPickOpp(fen,n){const own=n?Object.values(n.mv):[],tot=own.reduce((a,x)=>a+x.n,0),W=new Map();
 own.forEach(x=>W.set(x.san,{san:x.san,w:x.n*(1+2*opNeed(x.ck,5)),src:"games"}));
 if(tot<3){const ex=await Explorer.moves(fen);if(ex&&ex.length){const et=ex.reduce((a,x)=>a+x.n,0);
  ex.filter(x=>x.n/et>=.05).forEach(x=>{const o=W.get(x.san)||{san:x.san,w:0,src:"lichess"};o.w+=2*x.n/et;W.set(x.san,o)})}}
 const L=[...W.values()];if(!L.length)return null;let r=Math.random()*L.reduce((a,x)=>a+x.w,0);for(const x of L)if((r-=x.w)<=0)return x;return L[L.length-1]}
function opStartLine(replay,at){if(!OT)return;const start=replay&&OD?OD.start:at||null;
 OD={gen:GEN,key:OT.key,c:new Chess(start?start.fen:undefined),ply:start?start.ply:0,opp:replay&&OD?OD.opp:[],start,miss:false,wait:false,viaEx:false};
 OB.flip=OT.col==="b";OW.clear();OB.set(OD.c.fen());$("#oFeedback").innerHTML="";opStep()}
async function opStep(){const d=OD;if(!d||d.gen!==GEN||d.key!==(OT&&OT.key))return;const c=d.c,fen=c.fen(),k=posKey(fen),n=OT.T.get(k),mine=(c.turn()==="w")===(OT.col==="w");
 if(d.ply>=OP_PLY||c.game_over())return opLineDone(d,"end");
 if(mine){if(!n&&!d.viaEx)return opLineDone(d,"data");d.wait=true;const x=OPS[k];
  $("#oPrompt").className="verdict v-move";$("#oPrompt").innerHTML=`${ic("target")}<b>Your move.</b> ${n?`Seen in ${n.n} of your games.`:"From Lichess games at your rating."}${n&&n.weak?' <span class="tag">weak spot</span>':""}${x&&x.pin?' <span class="tag">repertoire</span>':""}`;return}
 let x=d.opp[d.ply];if(!x){$("#oPrompt").className="verdict v-info";$("#oPrompt").innerHTML=`${ic("hourglass")}Your opponent is choosing a move…`;x=await opPickOpp(fen,n);if(d!==OD)return;if(!x)return opLineDone(d,"data");d.opp[d.ply]=x}
 const m=c.move(x.san);if(!m)return opLineDone(d,"data");d.viaEx=x.src==="lichess";d.ply++;OB.set(c.fen(),{last:{from:m.from,to:m.to}});setTimeout(()=>{if(d===OD)opStep()},450)}
async function opMove(from,to){const d=OD;if(!d||!d.wait)return;const c=d.c,fen=c.fen(),t=new Chess(fen),mv=t.move({from,to,promotion:"q"});if(!mv)return;d.wait=false;OW.clear();
 const k=posKey(fen),n=OT.T.get(k),u=mv.from+mv.to+(mv.promotion||""),pin=(OPS[k]||{}).pin,s=c.turn()==="w"?1:-1;OB.set(t.fen(),{last:{from,to}});
 $("#oFeedback").innerHTML='<div class="skel-wrap" role="status"><span class="sr-only">Checking your move…</span><span class="skel" style="width:55%"></span></div>';let best=pin||(n&&n.best),bev=n?n.ev:null,aev=null;
 try{if(!best||bev==null){const r=await opEval(fen,14);best=best||r.best;if(bev==null)bev=r.cp}}catch(e){}
 if(d!==OD)return;let ok=!best||u===best,play=false;
 if(!ok){try{aev=(await opEval(t.fen(),12)).cp}catch(e){}if(d!==OD)return;const near=aev!=null&&bev!=null&&wp(s*bev)-wp(s*aev)<OP_TOL;if(pin&&near)play=true;else ok=near}
 const bs=best?uciSan(fen,best):null;
 if(play){d.wait=true;OB.set(fen,{last:c.history({verbose:true}).slice(-1).map(m=>({from:m.from,to:m.to}))[0]||null,arrows:[{from:pin.slice(0,2),to:pin.slice(2,4),c:"green"}]});
  $("#oFeedback").innerHTML=`<div class="verdict v-info">${ic("info")}${esc(mv.san)} is playable, but your repertoire move here is <b>${esc(bs)}</b>. Play it.</div>`;return}
 opGrade(k,ok);Snd.play(ok?"correct":"wrong");sess(OSS,ok,"#oSess");
 if(ok){c.move(mv.san);d.ply++;d.last={k,u,san:mv.san};const pinned=pin===u;
  $("#oFeedback").innerHTML=`<div class="verdict v-ok">${ic("circle-check")}${esc(mv.san)} — correct.${!pinned&&bs&&bs!==mv.san?` The engine's first choice is ${esc(bs)}, but yours is just as good.`:""}</div>`+
   `<button class="link" id="oPin" type="button">${pinned?`Unpin ${esc(mv.san)}`:`Pin ${esc(mv.san)} as my move here`}</button> <button class="link" id="oWhyBtn" type="button">Why?</button>`;
  $("#oWhyBtn").onclick=()=>{$("#oWhyBtn").remove();OW.show({fen,played:u,ok:true,restore:opBack})};
  $("#oPin").onclick=()=>{const x=OPS[k]||(OPS[k]={s:0,ok:0,miss:0});x.pin=pinned?null:u;if(!x.pin)delete x.pin;x.at=Date.now();saveOPS(k);$("#oPin").outerHTML=`<span class="small">${x.pin?`Pinned ${esc(mv.san)} as your repertoire move.`:"Unpinned."}</span>`};
  setTimeout(()=>{if(d===OD)opStep()},350)}
 else{d.miss=true;const arrows=[{from:mv.from,to:mv.to,c:"red"}];if(best)arrows.push({from:best.slice(0,2),to:best.slice(2,4),c:"green"});OB.set(fen,{arrows});
  $("#oPrompt").className="verdict v-info";$("#oPrompt").innerHTML=`${ic("rotate-ccw")}<b>Not this time.</b> Replay the line and lock it in.`;
  $("#oFeedback").innerHTML=`<div class="verdict v-no">${ic("circle-x")}${esc(mv.san)} isn't it. ${pin?"Your repertoire move":"The move"} here is <b>${esc(bs||"?")}</b> (green)${bev!=null&&aev!=null?`: ${esc(mv.san)} swings it ${evTxt(bev)} → ${evTxt(aev)}`:""}.</div><div class="v-actions"><button class="pri" id="oReplay" type="button">${ic("rotate-ccw","sm")}Replay the line</button></div>`;
  $("#oReplay").onclick=()=>opStartLine(true);OW.show({fen,played:u,best,restore:()=>OB.set(fen,{arrows})})}
 renderOpStats()}
function opLineDone(d,why){if(d!==OD)return;d.done=true;$("#oPrompt").className="verdict "+(d.miss?"v-info":"v-ok");$("#oPrompt").innerHTML=ic(d.miss?"rotate-ccw":"flag")+(why==="end"?"<b>Line complete.</b> ":"<b>That's as far as your games go here.</b> ")+(d.miss?"You missed a move: replay it to lock it in.":"On to the next line.");renderOpStats()}
function opEffect(key,t){const gs=opGames(key[0],key.slice(2)),b=gs.filter(g=>g.ts<t&&g.ts>=t-365*864e5),a=gs.filter(g=>g.ts>=t);
 return a.length>=5&&b.length>=5?{col:key[0],fam:key.slice(2),a:score(a),b:score(b),na:a.length,nb:b.length,date:new Date(t).toISOString().slice(0,10)}:null}
function renderOpStats(){if(!OT)return;const core=opCore(),learned=core.filter(n=>((OPS[n.k]||{}).s||0)>=OP_LEARNED).length,due=core.filter(n=>isDue(n.k)).length,weak=core.filter(n=>n.weak).length;
 $("#oKpis").innerHTML=`<div class="kpi"><b>${OT.games.length}</b>games in this opening</div><div class="kpi${OT.score<45?" goal":""}"><b>${Math.round(OT.score)}%</b>your score</div><div class="kpi"><b>${learned}<s>of ${core.length}</s></b>positions learned</div><div class="kpi goal"><b>${due}</b>due for review</div><div class="kpi"><b>${weak}</b>weak spots</div>`}
function renderOpenings(){const opts=[];for(const col of ["w","b"]){const m={};GAMES.filter(g=>g.color===col).forEach(g=>{const f=famOf(g.eco);m[f]=(m[f]||0)+1});
  Object.entries(m).filter(([,n])=>n>=3).sort((a,b)=>b[1]-a[1]).forEach(([f,n])=>opts.push({v:col+"|"+f,t:`${f} as ${col==="w"?"White":"Black"} (${n})`}))}
 if(OPSEL&&!opts.some(o=>o.v===OPSEL))OPSEL=null;if(!OPSEL&&opts.length)OPSEL=opts[0].v;
 $("#oPick").innerHTML=opts.map(o=>`<option value="${esc(o.v)}"${o.v===OPSEL?" selected":""}>${esc(o.t)}</option>`).join("");
 $("#oEmpty").hidden=!!OPSEL;$("#oMain").hidden=!OPSEL;if(!OPSEL){OT=null;OD=null;return}
 const col=OPSEL[0],fam=OPSEL.slice(2),sig=opGames(col,fam).length+"/"+opGames(col,fam).filter(g=>g.an).length;
 if(!OT||OT.key!==OPSEL||OT.sig!==sig){OT=buildTree(col,fam)}
 $("#oTitle").textContent=`${fam} as ${col==="w"?"White":"Black"}`;
 const W=[...OT.T.values()].filter(n=>n.weak).sort((a,b)=>b.prio-a.prio).slice(0,6);
 $("#oWeak").innerHTML=W.length?W.map((n,i)=>{const top=Object.values(n.mv).sort((a,b)=>b.n-a.n)[0];
  return `<li><button class="link" type="button" data-w="${i}">${esc(n.path.length?movesTxt(n.path)+" …":"Starting position")}</button><span class="small"> seen ${n.n}×${n.err?`, an inaccuracy or worse in ${n.err} of ${n.anN} analysed games`:""}${n.drop>=10?`, you score ${Math.round(n.score)}% from here`:""}. You usually play ${esc(top.san)}.</span></li>`}).join("")
  :'<li class="small">No weak spots found yet. Analyse more games in this opening to find them.</li>';
 $("#oWeak").querySelectorAll("[data-w]").forEach(b=>b.onclick=()=>opStartLine(false,W[+b.dataset.w]));
 const st=LS.get(uk("opstart"),{})[OT.key],e=st?opEffect(OT.key,st):null;
 $("#oEffect").textContent=st?(e?`Since you started practising on ${e.date}: ${Math.round(e.a)}% over ${e.na} games (was ${Math.round(e.b)}% over ${e.nb} games).`:`Practising since ${new Date(st).toISOString().slice(0,10)}. Your before-and-after score appears once you've played 5 games in this opening since then.`):"";
 renderExplorer();renderOpStats();if(!OD||OD.key!==OT.key||OD.gen!==GEN)opStartLine(false)}
$("#oPick").onchange=()=>{OPSEL=$("#oPick").value;LS.set(uk("opsel"),OPSEL);OD=null;renderOpenings()};
$("#oRestart").onclick=()=>opStartLine(true);$("#oNext").onclick=()=>opStartLine(false);

/* Lichess connection (OAuth with PKCE; no app registration). The token stays in this browser and is only used
   for the opening explorer, which needs one. */
const LI_CLIENT="rapid-coach",LIX="https://explorer.lichess.org",b64u=a=>btoa(String.fromCharCode(...a)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const LiAuth={msg:"",token(){return LS.get("li.token",null)},redirect(){return location.origin+location.pathname},
 async connect(){const v=b64u(crypto.getRandomValues(new Uint8Array(32))),st=b64u(crypto.getRandomValues(new Uint8Array(16))),ch=b64u(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v))));
  try{sessionStorage.setItem("rc.li.oauth",JSON.stringify({v,st,back:location.hash}))}catch(e){}
  location.href=LI+"/oauth?"+new URLSearchParams({response_type:"code",client_id:LI_CLIENT,redirect_uri:this.redirect(),code_challenge_method:"S256",code_challenge:ch,state:st})},
 async callback(){const q=new URLSearchParams(location.search);if(!q.has("state"))return;let o=null;try{o=JSON.parse(sessionStorage.getItem("rc.li.oauth"))}catch(e){}
  if(!o||o.st!==q.get("state"))return;sessionStorage.removeItem("rc.li.oauth");history.replaceState(null,"",location.pathname+(o.back||""));
  if(!q.has("code")){this.msg="Connecting Lichess was cancelled.";return}
  try{const r=await fetch(LI+"/api/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"authorization_code",code:q.get("code"),code_verifier:o.v,redirect_uri:this.redirect(),client_id:LI_CLIENT})});
   const j=await r.json();if(!r.ok||!j.access_token)throw 0;LS.set("li.token",j.access_token);this.msg="Lichess connected."}catch(e){this.msg="Couldn't connect Lichess. Try again."}},
 async disconnect(){const t=this.token();LS.set("li.token",null);LS.set("lx",{});if(t)try{await fetch(LI+"/api/token",{method:"DELETE",headers:{Authorization:"Bearer "+t}})}catch(e){}}};
/* Lichess opening explorer: one request at a time, results cached in localStorage (rc.lx, newest 600 positions).
   Unavailable (no connection, error, timeout, rate limit) = null, and the trainer uses my games only. */
const Explorer={busy:Promise.resolve(),cool:0,
 band(){const r=(GAMES.length&&GAMES[GAMES.length-1].myR)||1500,B=[0,1000,1200,1400,1600,1800,2000,2200,2500];let i=B.length-1;while(i>0&&B[i]>r)i--;return B[i]},
 moves(fen){const t=LiAuth.token();if(!t||!P)return Promise.resolve(null);const sp=P.tc==="600"?"rapid":P.tc,rb=this.band(),ck=sp+"|"+rb+"|"+posKey(fen),hit=LS.get("lx",{})[ck];
  if(hit)return Promise.resolve(hit.m);
  const run=async()=>{if(Date.now()<this.cool)return null;const ctl=new AbortController(),tm=setTimeout(()=>ctl.abort(),6000);
   try{const r=await fetch(LIX+"/lichess?"+new URLSearchParams({variant:"standard",fen,speeds:sp,ratings:rb,moves:"8",topGames:"0",recentGames:"0"}),{headers:{Authorization:"Bearer "+t},signal:ctl.signal});
    if(r.status===429){this.cool=Date.now()+LI_WAIT;return null}
    if(r.status===401){LS.set("li.token",null);LiAuth.msg="Your Lichess connection has expired. Connect again to get more opponent moves.";renderExplorer();return null}
    if(!r.ok)return null;const j=await r.json(),m=(j.moves||[]).map(x=>({san:x.san,n:(x.white||0)+(x.draws||0)+(x.black||0)})).filter(x=>x.san&&x.n>0);
    const c=LS.get("lx",{}),ks=Object.keys(c);if(ks.length>=600)ks.sort((a,b)=>c[a].t-c[b].t).slice(0,100).forEach(k=>delete c[k]);c[ck]={t:Date.now(),m};LS.set("lx",c);return m}
   catch(e){return null}finally{clearTimeout(tm)}};
  const p=this.busy.then(run);this.busy=p.catch(()=>{});return p}};
function renderExplorer(){const on=!!LiAuth.token();$("#oExNote").textContent=LiAuth.msg||(on?"Connected. Where your own games run out, your opponents' moves come from Lichess games at your rating.":"Connect a Lichess account (any account works) to fill gaps in your games with the most common moves at your rating. Without it, the trainer uses your own games only.");
 $("#oExBtn").textContent=on?"Disconnect Lichess":"Connect Lichess"}
$("#oExBtn").onclick=async()=>{if(LiAuth.token()){await LiAuth.disconnect();LiAuth.msg="Lichess disconnected.";renderExplorer()}else{try{await LiAuth.connect()}catch(e){LiAuth.msg="Couldn't start the Lichess connection in this browser.";renderExplorer()}}};

/* ---------- WEAKNESS PROFILE ----------
   Each of my mistakes and blunders in the stored analyses is tagged once (cached on the game as g.mt, local only) by fixed
   rules over two Stockfish lines: my best line from the position (what I missed) and the opponent's best line after my move
   (what I allowed). Tags (MOT) go with the phase (opening/middlegame/endgame) and, in endgames, the ending type (ENDT).
   Costs are win-% points lost (e.drop), summed per tag and divided by the tagged games. */
const MT_V=1,MT_GAMES=60,PVAL={p:1,n:3,b:3,r:5,q:9,k:0},FILES="abcdefgh";
const MOT={mate_missed:{n:"Missed checkmates",to:"pz-mate2",fs:"fs-mate1"},mate_allowed:{n:"Allowing checkmate",to:"pz-mate1",fs:"fs-mate1"},backrank:{n:"Back-rank weakness",to:"pz-back-rank",fs:"fs-mate1"},
 hang:{n:"Hanging pieces",to:"pz-hanging",fs:"fs-save"},material_missed:{n:"Free material left on the board",to:"pz-hanging",fs:"fs-free"},
 fork_missed:{n:"Missed forks",to:"pz-fork"},fork_allowed:{n:"Allowing forks",to:"pz-fork"},pin_missed:{n:"Missed pins",to:"pz-pin"},skewer_missed:{n:"Missed skewers",to:"pz-skewer"},
 pin_allowed:{n:"Allowing pins and skewers",to:"pz-pin"},tactic_missed:{n:"Other missed tactics",to:"pz-discovered"},tactic_allowed:{n:"Other tactics allowed",to:"pz-discovered"},positional:{n:"Positional slips",to:null}};
const ENDT={kp:"King and pawn endings",rook:"Rook endings",minor:"Minor-piece endings",queen:"Queen endings",mixed:"Other endings"},PHN={opening:"Opening",middlegame:"Middlegame",endgame:"Endgame"};
const sqi=s=>[FILES.indexOf(s[0]),+s[1]-1];
function bMap(fen){const m={},c=new Chess(fen);c.board().forEach((row,r)=>row.forEach((p,f)=>{if(p)m[FILES[f]+(8-r)]=p}));return m}
/* does the piece on `from` attack `to` (geometry and blockers; pawns by capture direction) */
function attacks(M,from,to){const p=M[from];if(!p||from===to)return false;const [f1,r1]=sqi(from),[f2,r2]=sqi(to),df=f2-f1,dr=r2-r1,a=Math.abs(df),b=Math.abs(dr);
 if(p.type==="p")return a===1&&dr===(p.color==="w"?1:-1);if(p.type==="n")return a*b===2;if(p.type==="k")return a<=1&&b<=1;
 if(!((p.type!=="b"&&(!df||!dr))||(p.type!=="r"&&a===b)))return false;const sf=Math.sign(df),sr=Math.sign(dr);
 for(let k=1;k<Math.max(a,b);k++)if(M[FILES[f1+sf*k]+(r1+sr*k+1)])return false;return true}
const attackersOf=(M,sq,col)=>Object.keys(M).filter(s=>M[s].color===col&&attacks(M,s,sq));
/* fork: the piece on t attacks two or more enemy targets worth winning (king, or a piece that is undefended or worth more than the attacker) */
function isFork(M,t){const p=M[t];if(!p)return false;const opp=p.color==="w"?"b":"w";
 return Object.keys(M).filter(s=>M[s].color===opp&&attacks(M,t,s)&&(M[s].type==="k"||(PVAL[M[s].type]>=3&&(PVAL[M[s].type]>PVAL[p.type]||!attackersOf(M,s,opp).length)))).length>=2}
/* pin or skewer along a line from the slider on t: first enemy piece X, then the next piece Y behind it (also enemy) */
function lineTactic(M,t){const p=M[t];if(!p||!"brq".includes(p.type))return null;const opp=p.color==="w"?"b":"w",[f,r]=sqi(t),D=[];
 if(p.type!=="b")D.push([1,0],[-1,0],[0,1],[0,-1]);if(p.type!=="r")D.push([1,1],[1,-1],[-1,1],[-1,-1]);
 for(const [a,b] of D){let X=null;for(let k=1;k<8;k++){const x=f+a*k,y=r+b*k;if(x<0||x>7||y<0||y>7)break;const q=M[FILES[x]+(y+1)];if(!q)continue;
  if(!X){if(q.color!==opp)break;X=q;continue}if(q.color!==opp)break;const vx=X.type==="k"?100:PVAL[X.type],vy=q.type==="k"?100:PVAL[q.type];
  if(vy>vx&&vx>=1)return "pin";if(vx>vy&&vy>=3)return "skewer";break}}return null}
/* play a UCI line (legal moves only), not stopping mid-exchange; material change for `me`, mate at the end, last move */
function lineEnd(fen,ucis,me,max){const c=new Chess(fen),b0=balOf(matOf(fen),me);let last=null,n=0;
 for(const u of ucis||[]){if(n>=max&&!(last&&last.captured))break;const m=c.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]||"q"});if(!m)break;last=m;n++}
 return {d:balOf(matOf(c.fen()),me)-b0,mate:c.in_checkmate(),fen:c.fen(),last}}
function phaseOf(fen,ply){const m=matOf(fen),np=k=>["n","b","r","q"].reduce((s,t)=>s+PVAL[t]*m[k][t],0),tot=np("w")+np("b"),q=m.w.q+m.b.q;
 return tot<=26||(!q&&tot<=32)?"endgame":ply<20&&tot>=52?"opening":"middlegame"}
function endType(fen){const m=matOf(fen),has=t=>m.w[t]+m.b[t]>0,minor=has("n")||has("b");
 return !minor&&!has("r")&&!has("q")?"kp":!minor&&has("r")&&!has("q")?"rook":minor&&!has("r")&&!has("q")?"minor":!minor&&!has("r")&&has("q")?"queen":"mixed"}
/* tags for one mistake e (from errorsOf) given my best line rF and the opponent's best line rA after my move */
function tagOne(g,e,rF,rA){const F=g._f[e.i],A=g._f[e.i+1],me=F.split(" ")[1],t=[],add=k=>{if(!t.includes(k))t.push(k)};
 if(e.before>=9000&&e.after<9000)add("mate_missed");
 if(e.after<=-9000){add("mate_allowed");const l=lineEnd(A,rA,me,40);if(l.mate&&l.last&&"rq".includes(l.last.piece)){const M=bMap(l.fen),k=Object.keys(M).find(s=>M[s].type==="k"&&M[s].color===me);
  if(k&&k[1]===(me==="w"?"1":"8")&&l.last.to[1]===k[1])add("backrank")}}
 const la=lineEnd(A,rA,me,8),lf=lineEnd(F,rF,me,8);
 if(!t.length&&la.d<=-2&&rA&&rA[0]){const r=rA[0],M=bMap(A),to=r.slice(2,4),X=M[to],att=M[r.slice(0,2)];
  if(X&&X.color===me&&(!attackersOf(M,to,me).length||PVAL[X.type]>PVAL[att.type]))add("hang");
  else{const c=new Chess(A);c.move({from:r.slice(0,2),to,promotion:r[4]||"q"});const M2=bMap(c.fen());add(isFork(M2,to)?"fork_allowed":lineTactic(M2,to)?"pin_allowed":"tactic_allowed")}}
 if(!t.length&&lf.d>=2&&rF&&rF[0]){const b=rF[0],M=bMap(F),to=b.slice(2,4),X=M[to],c=new Chess(F);c.move({from:b.slice(0,2),to,promotion:b[4]||"q"});const M2=bMap(c.fen()),lt=lineTactic(M2,to);
  add(isFork(M2,to)?"fork_missed":lt==="pin"?"pin_missed":lt==="skewer"?"skewer_missed":X&&X.color!==me?"material_missed":"tactic_missed")}
 if(!t.length)add("positional");const ph=phaseOf(F,e.i);return {t,ph,et:ph==="endgame"?endType(F):null,d:Math.round(e.drop*10)/10}}
/* background tagger: newest analysed games first, at most MT_GAMES; one engine job at a time behind any analysis */
const TG={busy:false,async run(){if(this.busy||!P)return;this.busy=true;const gen=GEN;let done=0;
 try{for(const g of GAMES.filter(g=>g.an).slice(-MT_GAMES).reverse()){if(gen!==GEN)break;if(g.mt&&g.mt.v===MT_V)continue;replay(g);const mt={v:MT_V,e:{}};
  for(const e of serious(g)){if(gen!==GEN)break;const rF=(await Engine.eval(g._f[e.i],12)).pv,rA=(await Engine.eval(g._f[e.i+1],12)).pv;if(gen!==GEN)break;mt.e[e.i]=tagOne(g,e,rF,rA)}
  if(gen!==GEN)break;g.mt=mt;DB.put([g]);if(++done%3===0&&route.cur==="lessons"&&!LP)renderLessons()}}
 catch(x){}finally{this.busy=false}if(gen===GEN&&done){if(route.cur==="lessons"&&!LP)renderLessons();if(route.cur==="home")renderHome()}}};
function wkProfile(){const an=GAMES.filter(g=>g.an).slice(-MT_GAMES),tg=an.filter(g=>g.mt&&g.mt.v===MT_V),n=tg.length,T={},PH={opening:{n:0,d:0},middlegame:{n:0,d:0},endgame:{n:0,d:0}},ET={},inc=(o,k,d)=>{const x=o[k]||(o[k]={n:0,d:0});x.n++;x.d+=d};
 for(const g of tg)for(const i in g.mt.e){const x=g.mt.e[i];inc(T,x.t[0],x.d);PH[x.ph].n++;PH[x.ph].d+=x.d;if(x.et)inc(ET,x.et,x.d)}return {n,an:an.length,T,PH,ET}}
/* where a theme is practised: a puzzle course (its chapter comes from pzRec), or the First steps lesson for new players and beginners until it's done */
const motTo=k=>{const m=MOT[k];return m.fs&&["new","beg"].includes(lvl())&&!lsDone(m.fs)?m.fs:m.to};
/* priority list: every weakness with its cost (win-% points per game) and a one-line reason; habits from what Progress measures */
function lsPriority(){const W=wkProfile(),out=[],n=W.n;if(n<3)return out;const pg=x=>x.d/n,times=k=>k===1?"once":k===2?"twice":k+" times";
 for(const k in W.T){if(k==="positional")continue;const x=W.T[k];out.push({k,name:MOT[k].n,cost:pg(x),to:motTo(k),reason:`${times(x.n)} in your last ${n} analysed games, about ${pg(x).toFixed(1)} points a game.`})}
 for(const k in W.ET){const x=W.ET[k];if(x.n>=2)out.push({k:"end_"+k,name:ENDT[k],cost:pg(x)*.8,to:"endgames",reason:`${times(x.n)} you went wrong in ${ENDT[k].toLowerCase()}, about ${pg(x).toFixed(1)} points a game.`})}
 const s=stats(),B=baseSecs(),errs=[];GAMES.filter(g=>g.mt).slice(-MT_GAMES).forEach(g=>{for(const i in g.mt.e)errs.push({g,i:+i,x:g.mt.e[i]})});
 const win=errs.filter(o=>(errorsOf(o.g).find(e=>e.i===o.i)||{}).before>200);if(win.length>=2){const d=win.reduce((a,o)=>a+o.x.d,0)/n,tc={};win.forEach(o=>{const t=o.x.t[0];if(MOT[t].to)tc[t]=(tc[t]||0)+o.x.d});const top=Object.keys(tc).sort((a,b)=>tc[b]-tc[a])[0];
  out.push({k:"winning",name:"Letting winning positions slip",cost:d*.6,to:top?motTo(top):"pz-hanging",reason:`${times(win.length)} you went wrong when already clearly winning, about ${d.toFixed(1)} points a game.`})}
 if(s.time!=null&&s.time<B*.5){const quick=errs.filter(o=>{const sp=spent(o.g,o.i);return sp!=null&&sp<10}),d=quick.reduce((a,o)=>a+o.x.d,0)/n;
  if(quick.length)out.push({k:"clock",name:"Playing too fast",cost:d*.7,to:null,reason:`You use ${mmss(s.time)} of ${mmss(B)}; ${times(quick.length)} you erred after under 10 seconds of thought.`})}
 const yr=GAMES.filter(g=>g.ts>Date.now()-365*864e5),om={};yr.forEach(g=>{const k=g.color+"|"+famOf(g.eco);(om[k]=om[k]||[]).push(g)});
 const wo=Object.entries(om).filter(([,a])=>a.length>=5).map(([k,a])=>({k,a,s:score(a)})).sort((a,b)=>a.s-b.s)[0];
 if(wo&&wo.s<45)out.push({k:"opening",name:`The ${wo.k.slice(2)} as ${wo.k[0]==="w"?"White":"Black"}`,cost:(50-wo.s)*wo.a.length/Math.max(1,yr.length),to:"openings",op:wo.k,reason:`You score ${Math.round(wo.s)}% in it over ${wo.a.length} games this year.`});
 return out.filter(o=>o.cost>0).sort((a,b)=>b.cost-a.cost)}
/* level: rating (Lichess ratings run about 250 higher than chess.com's) nudged by accuracy; the player can override it */
const LVLS=[["new","New to chess"],["beg","Beginner"],["imp","Improver"],["int","Intermediate"],["club","Club player"]];
function lvlAuto(){if(!GAMES.length)return "new";const s=stats();let r=(s.rating||0)-(P.source==="li"?250:0),i=r<400?0:r<800?1:r<1100?2:r<1400?3:4;
 if(s.nAn>=10&&s.errs!=null){if(s.errs>=4&&i>1)i--;else if(s.errs<=1.2&&i>0&&i<4)i++}return LVLS[i][0]}
const lvl=()=>(LSP.lvl&&LSP.lvl.v)||lvlAuto(),lvlName=id=>(LVLS.find(l=>l[0]===id)||LVLS[1])[1];

/* ---------- PUZZLE COURSES ----------
   Real-game puzzles from the Lichess puzzle database (CC0): a fixed subset made by tools/build-puzzles.py, vendored one file per
   course in PZ_DIR and fetched from this site the first time a course is opened. A puzzle is [id, FEN, UCI moves, rating(, pattern)];
   the first move is the opponent's (played for you), then the solution, where any checkmate also counts. A course has a chapter per
   rating band (PZB) with three lessons of PZ_N puzzles picked around the course skill (Elo-style, LSP["c:pz-<course>"].v) plus a
   placement check of PZ_T puzzles from the top of the band. n: the coach note for each lesson; ask: the prompt. */
const PZ_DIR="vendor/lichess-puzzles-2026-11/",PZ_N=6,PZ_T=4,PZB=[[400,1000,"Up to 1000"],[1000,1200,"1000–1200"],[1200,1400,"1200–1400"],[1400,1600,"1400–1600"],[1600,1800,"1600–1800"]],PZL=[["a","Warm-up",-120],["b","Practice",0],["c","Challenge",120]];
const PZC=[
 {id:"hanging",name:"Hanging pieces",desc:"Spot pieces left without a defender, and take them.",ask:"Something is loose. Win it.",n:["Look at every enemy piece and ask: is it defended? Start with the piece that just moved.","Count attackers and defenders. More attackers than defenders means you can take.","The free piece can hide behind a check or a threat. Look at checks first."]},
 {id:"mate1",name:"Mate in one",desc:"Look at every check and find the one with no way out.",ask:"Checkmate in one move.",n:["Try every check in your head. For each one: can the king run, block or capture?","Count the king's escape squares first. Which check covers them all?","The mating move isn't always the obvious one. Look for checks from far away too."]},
 {id:"fork",name:"Forks",desc:"One piece, two targets: win material with a double attack.",ask:"Find the fork.",n:["Find a square where one of your pieces attacks two valuable targets at once.","Forks with check are the strongest: the king must move, and the other piece falls.","Sometimes a first move drags a piece onto the fork square."]},
 {id:"pin",name:"Pins",desc:"Freeze a piece in front of a bigger one, then attack it.",ask:"Use a pin to win material.",n:["Line up a bishop, rook or queen with two enemy pieces, the bigger one behind.","A pinned piece is a sitting target: attack it again, ideally with a pawn.","A pinned piece doesn't really defend. What is it pretending to guard?"]},
 {id:"skewer",name:"Skewers",desc:"Attack a big piece so the one behind it falls.",ask:"Find the skewer.",n:["Look for the enemy king or queen on a line with another piece behind it.","Checks along open files and diagonals often turn into skewers.","Endgame kings love the centre, and that's where they get skewered."]},
 {id:"back-rank",name:"Back-rank mate",desc:"Punish a king stuck behind its own pawns.",ask:"The back rank is weak. Find the win.",n:["A king behind three pawns has no air. Can a rook or queen reach its back rank?","If one piece guards the back rank, remove it or lure it away first.","A sacrifice that removes the last defender often mates."]},
 {id:"mate2",name:"Mate in two",desc:"A forcing first move, then mate.",ask:"Checkmate in two moves.",n:["Start with checks. After each one, does every reply allow mate?","A sacrifice is fine if it forces the king where you want it.","If no check works, look for a quiet move that takes the last escape square."]},
 {id:"discovered",name:"Discovered attacks",desc:"Move one piece to unleash another.",ask:"Find the discovered attack.",n:["Look for one of your pieces standing between your bishop, rook or queen and an enemy target.","The piece that moves should make a threat of its own: a check or a capture.","A discovered check lets the moving piece go anywhere, even where it can be taken."]},
 {id:"double-check",name:"Double check",desc:"Check with two pieces at once: the king must run.",ask:"Find the double check.",n:["Look for a discovered check where the moving piece gives check too.","After a double check only a king move helps. Where can it go?","Double check makes sacrifices work: neither checking piece can be taken."]},
 {id:"deflection",name:"Deflection",desc:"Lure a defender away from its job.",ask:"Lure a defender away and win.",n:["Find the defender: which enemy piece is the only guard of something important?","Attack that defender, or offer it something it must take.","Checks deflect best: they leave no time to think."]},
 {id:"smothered",name:"Smothered mate",desc:"A knight mates a king boxed in by its own pieces.",ask:"Find the smothered mate.",n:["A king surrounded by its own pieces: a knight check can be mate.","The classic: a queen check forces a rook into the corner, then the knight mates.","Watch the squares f7 and h6 (f2 and h3 for White) when the king has castled."]},
 {id:"mate3",name:"Mate in three",desc:"Longer forcing lines that end in mate.",ask:"Checkmate in three moves.",n:["Checks keep the opponent's choices small. Follow each one to the end.","Picture where the king goes after each check and which squares are left.","When the checks run out, look for one quiet move that seals the net."]},
 {id:"patterns",name:"Mating patterns",desc:"Arabian, Anastasia's, Boden's, hook, dovetail and two-bishop mates.",ask:"Find the mate.",n:["Know the shape: a few pieces in a fixed pattern around the king.","Spot the pattern first, then work out how to get your pieces there.","Patterns often hide behind a sacrifice that opens the king."]}];
const pzCourse=c=>({id:"pz-"+c.id,name:c.name,desc:c.desc,lv:["new","beg","imp","int","club"],pz:c,chapters:PZB.map((b,i)=>({id:`${c.id}-${i+1}`,name:`${c.name} · ${b[2]}`,short:b[2],band:i,pz:c,test:Array(PZ_T).fill(null),
 lessons:PZL.map(([s,n,o],j)=>({id:`${c.id}-${i+1}-${s}`,name:n,note:c.n[j],off:o,band:i,pz:c,steps:Array(PZ_N).fill(null)}))}))});

/* ---------- LESSON CONTENT ----------
   TRACKS > courses (lv: levels it suits) > chapters (test: placement check) > lessons (steps, page: teaching page).
   Step: f FEN, g goal ("best": the move in s, or with tolerance a move just as good; "x":1 means exactly s/alt;
   "check": any check; "mate": any checkmate; "legal": any legal move), n coach note, ok note after success. */
const TRACKS=[
 {id:"tactics",name:"Tactics & checkmate patterns",icon:"crosshair",courses:[
  {id:"fs",name:"First steps",lv:["new","beg"],desc:"How the pieces move, check and checkmate, and keeping your pieces safe.",chapters:[
   {id:"fs-moves",name:"How the pieces move",lessons:[
    {id:"fs-rook",name:"Rook and bishop",steps:[
     {f:"k7/8/8/p7/8/8/8/R6K w - - 0 1",s:["a1a5"],x:1,n:"The rook moves in straight lines: up, down and sideways. Take the pawn on a5.",ok:"Rooks love open lines."},
     {f:"7k/8/8/8/8/8/8/R3n2K w - - 0 1",s:["a1e1"],x:1,n:"Sideways works too. Capture the knight.",ok:"Straight along the rank."},
     {f:"k7/8/8/4n3/8/8/8/B6K w - - 0 1",s:["a1e5"],x:1,n:"The bishop moves diagonally and always stays on its colour. Take the knight.",ok:"Diagonals can be long."}]},
    {id:"fs-knight",name:"The knight",steps:[
     {f:"k7/8/8/8/8/2p5/8/1N5K w - - 0 1",s:["b1c3"],x:1,n:"The knight jumps in an L: two squares one way, then one to the side. Take the pawn.",ok:"That's the L."},
     {f:"k7/8/8/3p4/8/4N3/8/7K w - - 0 1",s:["e3d5"],x:1,n:"Knights jump over anything in the way. Find the L that reaches the pawn.",ok:"Knights are sneaky."}]},
    {id:"fs-queen",name:"Queen and king",steps:[
     {f:"7k/8/8/8/8/8/1r6/Q6K w - - 0 1",s:["a1b2"],x:1,n:"The queen moves like a rook and a bishop together. Take the rook.",ok:"The queen is your strongest piece."},
     {f:"k7/8/8/8/8/8/6p1/7K w - - 0 1",s:["h1g2"],x:1,n:"The king moves one square in any direction. That pawn is giving check: take it with the king.",ok:"The king can capture too, when it's safe."}]},
    {id:"fs-pawn",name:"Pawns",steps:[
     {f:"k7/8/8/8/8/8/4P3/4K2R w - - 0 1",s:["e2e4"],x:1,n:"A pawn moves straight forward. On its first move it may go two squares. Push it two.",ok:"Pawns never move backwards."},
     {f:"k7/8/8/8/3p4/4P3/8/7K w - - 0 1",s:["e3d4"],x:1,n:"Pawns capture one square diagonally forward. Take the black pawn.",ok:"Forward to move, diagonal to capture."}]}]},
   {id:"fs-check",name:"Check and checkmate",test:[
     {f:"6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1",g:"mate",n:"Checkmate in one."},{f:"7k/6pp/8/8/8/8/1Q6/K7 w - - 0 1",g:"mate",n:"Checkmate in one."}],lessons:[
    {id:"fs-givecheck",name:"Check",steps:[
     {f:"k7/8/8/8/8/8/8/1R5K w - - 0 1",g:"check",n:"Check means attacking the king. Give check with your rook.",ok:"The king must deal with a check at once."},
     {f:"k5r1/8/8/8/8/8/8/6K1 w - - 0 1",g:"legal",n:"You're in check from the rook. Step out of its line.",ok:"In check, every legal move gets you out of check."},
     {f:"k5r1/8/8/8/8/7B/8/6K1 w - - 0 1",s:["h3g2"],x:1,n:"You can also block a check. Put your bishop in the way, next to your king so it stays protected.",ok:"Blocking works best when the blocker is defended."}]},
    {id:"fs-mate1",name:"Checkmate in one",steps:[
     {f:"6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1",g:"mate",n:"Checkmate is a check with no way out. The king's own pawns trap it: find the mate.",ok:"A back-rank mate."},
     {f:"k7/8/1K6/8/8/8/7Q/8 w - - 0 1",g:"mate",n:"Your king helps. Find a checkmate with the queen.",ok:"King and queen together."}]}]},
   {id:"fs-hang",name:"Don't hang pieces",lessons:[
    {id:"fs-save",name:"Save your piece",steps:[
     {f:"k7/8/8/8/3r4/8/3N4/6K1 w - - 0 1",s:["d2f3"],alt:["d2b3","d2f1"],x:1,n:"The rook attacks your knight and nothing defends it. Move it to a safe square.",ok:"Before every move, ask: what is attacked?"},
     {f:"k7/8/8/8/8/2n5/4B3/6K1 w - - 0 1",s:["e2d3"],alt:["e2f3","e2g4","e2h5","e2f1","e2c4","e2a6"],x:1,n:"The knight attacks your bishop. Find a square where it's safe.",ok:"Safe means no enemy piece can take it."}]},
    {id:"fs-free",name:"Take free material",steps:[
     {f:"k7/8/8/3b4/8/8/8/3Q2K1 w - - 0 1",s:["d1d5"],x:1,n:"Nothing defends that bishop. Take it.",ok:"A free piece is a big advantage."},
     {f:"k7/8/8/8/8/5n2/8/5RK1 w - - 0 1",s:["f1f3"],x:1,n:"The knight gives check, but it's undefended. Win it.",ok:"Answering a check by taking the checker is often best."}]}]}]},
  ...PZC.map(pzCourse)]},
 {id:"openings",name:"Openings",icon:"book-open",courses:[],soon:"Opening courses arrive in a later update. Until then, drill the lines you really play in the opening trainer."},
 {id:"endgames",name:"Endgames",icon:"flag",courses:[],soon:"Endgame courses arrive in a later update."}];
/* teaching pages: the idea in a few sentences, with board diagrams (d: FEN, a: arrows) */
const PAGES={
 "fs-rook":[{p:"Rooks move any number of squares along a rank (row) or file (column). Bishops move along diagonals, so a bishop that starts on a light square stays on light squares all game."},{d:"k7/8/8/p7/8/8/8/R6K w - - 0 1",a:[["a1","a5","green"],["a1","g1","blue"]],c:"The rook on a1 reaches the whole a-file and the first rank."},{d:"k7/8/8/4n3/8/8/8/B6K w - - 0 1",a:[["a1","e5","green"]],c:"The bishop sweeps the long diagonal."}],
 "fs-knight":[{p:"The knight moves two squares in one direction and then one square sideways: an L. It is the only piece that can jump over others, which makes it great in crowded positions."},{d:"k7/8/8/8/3N4/8/8/7K w - - 0 1",a:[["d4","e6","green"],["d4","c6","green"],["d4","f5","green"],["d4","f3","green"],["d4","e2","green"],["d4","c2","green"],["d4","b3","green"],["d4","b5","green"]],c:"From the centre a knight reaches eight squares."}],
 "fs-queen":[{p:"The queen combines the rook and the bishop: any distance, in any straight line. The king moves just one square at a time, in any direction, and can never move into check."},{d:"k7/8/8/8/3Q4/8/8/7K w - - 0 1",a:[["d4","d8","green"],["d4","h8","green"],["d4","a4","green"],["d4","a1","green"]],c:"The queen covers ranks, files and diagonals."}],
 "fs-pawn":[{p:"Pawns move one square forward, or two on their very first move. They capture one square diagonally forward. A pawn that reaches the last rank becomes a queen (or another piece)."},{d:"k7/8/8/8/3p4/4P3/8/7K w - - 0 1",a:[["e3","d4","green"],["e3","e4","blue"]],c:"Straight to move, diagonal to capture."}],
 "fs-givecheck":[{p:"A check is an attack on the king. The player in check must get out of it at once, in one of three ways: move the king, block the line, or capture the checking piece."},{d:"k5r1/8/8/8/8/7B/8/6K1 w - - 0 1",a:[["g8","g1","red"],["h3","g2","green"]],c:"The rook checks along the g-file; the bishop blocks on g2, protected by the king."}],
 "fs-mate1":[{p:"Checkmate is a check that can't be answered: the king can't move, the check can't be blocked and the checker can't be taken. A king stuck behind its own pawns is a classic target: the back-rank mate."},{d:"6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1",a:[["a1","a8","green"]],c:"Ra8 is mate: the pawns on f7, g7 and h7 take away the king's escape squares."}],
 "fs-save":[{p:"A piece is hanging when it can be taken for free. Before each move, check what your opponent attacks. If a piece is attacked and not defended, move it, defend it, or block the attack."},{d:"k7/8/8/8/3r4/8/3N4/6K1 w - - 0 1",a:[["d4","d2","red"],["d2","f3","green"]],c:"The rook attacks the knight; Nf3 moves it to safety."}],
 "fs-free":[{p:"The other side of the coin: after your opponent moves, check what they left undefended. Taking a free piece is often the best move on the board."},{d:"k7/8/8/3b4/8/8/8/3Q2K1 w - - 0 1",a:[["d1","d5","green"]],c:"Qxd5 wins a bishop for nothing, with check."}],
 // puzzle courses: the idea, diagrams (o: "w" keeps White at the bottom), a worked example from a real game (w: FEN, m: moves, t: a caption per move), a checklist (l)
 "pz-hanging":[{p:"A piece is hanging when it can be taken for free: it's attacked and nothing defends it. Below 1500, more games are decided by a hanging piece than by anything else, so this is the habit that pays most."},
  {d:"r5k1/5ppp/8/3n4/8/2N5/5PPP/3R2K1 w - - 0 1",a:[["c3","d5","green"],["d1","d5","green"]],c:"Black's knight on d5 is attacked twice and defended by nothing. It's hanging."},
  {p:"Count before you take: attackers against defenders. If you attack it more often than it's defended, the capture wins. Take with your least valuable piece first, so you never give back more than you won."},
  {w:"r3r1k1/1b3p2/p1n2bpp/1p1p4/2pP1N2/NPP4P/P4PP1/R2BR1K1 b - - 1 21",m:["e8e1"],c:"Black to move. White's knight just went from e2 to f4. What did it leave behind?",t:["Rxe1+. The knight was standing between the two rooks. Now the e-file is open and nothing defends White's rook, so Black takes it for free, with check."],src:"WCr0k"},
  {h:"Every move, ask three questions",l:["What does my opponent's last move attack?","Which of my pieces are undefended?","Which of their pieces are undefended?"]}],
 "pz-mate1":[{p:"Mate in one starts with one habit: look at every check you have. For each check, ask three questions. Can the king move away? Can the check be blocked? Can the checking piece be taken? Three times no means checkmate."},
  {d:"k7/1Q6/1K6/8/8/8/8/8 b - - 0 1",o:"w",c:"The queen right next to the king, protected by her own king: a mate you'll give many times."},
  {p:"Pieces next to the enemy king matter most: they block its escape squares. Count its free squares, then look for the check that covers them all."},
  {w:"r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4",m:["h5f7"],c:"White to move. A position almost every beginner meets.",t:["Qxf7#. The bishop on c4 protects the queen, so the king can't take her, and Black's own pieces block every escape square."]},
  {h:"How to find it",l:["List every check, even the silly-looking ones.","For each: can the king run, block or capture?","If one check has no answer, play it."]}],
 "pz-fork":[{p:"A fork is one piece attacking two things at once. Your opponent can save only one of them. Knights are the champion forkers because their attacks are easy to miss, but any piece can fork, even a pawn or the king."},
  {d:"4k3/8/8/1q6/4N3/8/8/4K3 w - - 0 1",a:[["e4","d6","green"],["d6","e8","red"],["d6","b5","red"]],c:"Nd6+ attacks the king and the queen. The king must move, and the queen falls."},
  {d:"4k3/8/8/2n1b3/8/2PP4/8/4K3 w - - 0 1",a:[["d3","d4","green"],["d4","c5","red"],["d4","e5","red"]],c:"Even a pawn can fork: d4 hits both pieces, and only one can escape."},
  {p:"The best forks come with check, so there's no time to save the other piece. Look for squares where one of your pieces would attack the king and something valuable, then ask: can I get there safely?"},
  {w:"8/1p4k1/p7/2pp4/7N/2P3rP/PP4P1/6K1 w - - 0 36",m:["h4f5","g7f6","f5g3"],c:"White to move. Black's king and rook are a knight's jump apart.",t:["Nf5+ checks the king and attacks the rook on g3 at the same time.","The king has to move, so Black can't save the rook.","Nxg3 wins the rook."],src:"GhrwM"},
  {h:"How to find forks",l:["Find the targets: the king, the queen, loose pieces.","Look for one square that attacks two of them.","Check that your piece is safe there, or that the check leaves no time."]}],
 "pz-pin":[{p:"A pin attacks a piece that can't move away without exposing something more valuable behind it. If the piece behind is the king, the pinned piece isn't allowed to move at all. Bishops, rooks and queens pin along lines."},
  {d:"rn1qkbnr/ppp2ppp/3p4/4p3/2B1P1b1/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 4",a:[["g4","f3","red"],["f3","d1","red"]],c:"A pin from a real opening: if the knight on f3 moves, Black's bishop takes the queen."},
  {p:"Pinned pieces are sitting ducks. Attack them again, ideally with a pawn. And remember that a pinned piece doesn't really defend anything."},
  {w:"5bk1/1p5p/p5p1/4p3/P1p1P3/2R5/6PP/4K3 b - - 1 34",m:["f8b4","e1d1","b4c3"],c:"Black to move. White's rook and king stand on the same diagonal.",t:["Bb4 pins the rook on c3 to the king on e1. The rook can't move away.","Kd1. Wherever the king goes, the rook stays stuck.","Bxc3 wins the rook. At best White could win the bishop back, and a rook is worth more."],src:"uE408"},
  {h:"How to use pins",l:["Line up your bishop, rook or queen with two enemy pieces.","The piece behind should be worth more than the one in front.","Then pile up on the pinned piece."]}],
 "pz-skewer":[{p:"A skewer is a pin in reverse: the more valuable piece is in front. When it steps out of the line (a king in check has to), the piece behind it is lost."},
  {d:"8/1q6/8/3k4/8/8/4B3/6K1 w - - 0 1",a:[["e2","f3","green"],["f3","d5","red"],["d5","b7","red"]],c:"Bf3+ checks the king. Once it moves, Bxb7 takes the queen."},
  {p:"Skewers live on open lines. Whenever the enemy king or queen shares a file, rank or diagonal with another piece, look for a check or an attack along that line."},
  {w:"3k2r1/R1p5/8/8/PP6/2PK3p/7b/8 w - - 0 32",m:["a7a8","d8d7","a8g8"],c:"White to move. Black's king and rook share the eighth rank.",t:["Ra8+ checks along the back rank, with the rook on g8 behind the king.","The king must step off the rank.","Rxg8 takes the rook."],src:"EDuVh"},
  {h:"How to find skewers",l:["Find enemy pieces lined up on a file, rank or diagonal.","Attack the front one, ideally with check.","Make sure your attacking piece can't simply be taken."]}],
 "pz-back-rank":[{p:"A king behind three unmoved pawns looks safe, but it has no air. If a rook or queen reaches its back rank with check, it's mate. It's the most common checkmate in club games."},
  {d:"6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1",a:[["a1","a8","green"]],c:"Ra8 is mate: Black's own pawns block every escape square."},
  {p:"Defenders often guard the back rank, so the trick is to remove or distract them first, sometimes with a big sacrifice. And look after your own king: one pawn move like h3 gives it an escape square."},
  {w:"r5k1/p4ppp/1pp5/2nn4/8/8/q1P1QPPP/3RRK2 w - - 0 23",m:["e2e8","a8e8","e1e8"],c:"White to move. Only Black's rook guards the back rank.",t:["Qe8+! The queen offers herself on the back rank.","Black has to take: Rxe8 is the only move.","Rxe8#. The pawns on f7, g7 and h7 trap their own king."],src:"USfAZ"},
  {h:"Check the back rank",l:["Does the enemy king have an escape square?","Can my rook or queen reach its back rank?","Who guards that rank, and can I remove or distract them?"]}],
 "pz-mate2":[{p:"Mate in two is a forcing first move, then mate. The first move is usually a check or a capture that leaves your opponent only one or two replies, and you need a mate after each of them."},
  {w:"8/1p2b2p/2p1N1pk/8/8/2K2R2/8/r7 w - - 20 55",m:["f3h3","e7h4","h3h4"],c:"White to move. Black's king is short of squares.",t:["Rh3+. The knight on e6 already covers g5 and g7, so the king can't run.","Black's only move is to block with the bishop.","Rxh4# takes the blocker, and it's mate."],src:"Nu3jq"},
  {p:"Checks first, then captures, then threats. If a check leaves only one reply, play that reply in your head and look for mate in one again."},
  {h:"How to find it",l:["Which checks leave only one or two replies?","After each reply, is there a mate in one?","If every reply loses, that's your first move."]}],
 "pz-discovered":[{p:"A discovered attack happens when one piece moves out of the way and uncovers an attack by the piece behind it. Suddenly two pieces attack at once: the one that moved and the one behind it. When the uncovered attack is a check, it's a discovered check."},
  {d:"4k3/8/8/3q4/8/8/4N3/4R1K1 w - - 0 1",a:[["e2","c3","green"],["e1","e8","red"],["c3","d5","red"]],c:"Nc3+ uncovers a check from the rook and attacks the queen at the same time."},
  {w:"r3r1k1/pbp2ppp/1p6/3p4/3P1q2/2P1RP2/PP1Q2PP/5RK1 w - - 0 21",m:["e3e8","a8e8","d2f4"],c:"White to move. White's rook on e3 stands between the queen on d2 and Black's queen on f4.",t:["Rxe8+ takes a rook with check, and moving the rook uncovers the queen on d2: now it attacks Black's queen.","Black must answer the check first: Rxe8.","Qxf4 wins the queen."],src:"9dXnX"},
  {h:"How to find discovered attacks",l:["Find your pieces standing in front of your own bishop, rook or queen.","Is there an enemy target at the end of that line?","Move the front piece with a threat of its own: a check or a capture."]}],
 "pz-double-check":[{p:"A double check is a discovered check where the piece that moves gives check too. One move can't block two lines or capture two pieces, so the king has to move. That makes it the most forcing move in chess, and it often ends in mate."},
  {w:"r2qkb1r/3p1ppp/p7/np1p4/4N3/5N2/PB3PPP/R3R1K1 w kq - 0 15",m:["e4f6"],c:"White to move. The knight on e4 stands between White's rook and Black's king.",t:["Nf6#. The knight checks, and so does the rook it uncovered. Taking the knight would leave the rook's check, and the king has no square to go to: checkmate."],src:"Tgcw5"},
  {p:"Because only a king move helps, the checking pieces can stand anywhere, even where they could be taken. That's why double check makes daring sacrifices work."},
  {h:"How to find it",l:["Look for a discovered check first.","Can the moving piece give check too?","Then only king moves are left: count the king's squares."]}],
 "pz-deflection":[{p:"Deflection drags a defender away from its job. When one enemy piece guards something important, attack it, check it, or offer it something it can't refuse. Once it leaves, whatever it guarded falls."},
  {d:"2r3k1/5ppp/2q5/1Q6/8/8/5PPP/3R2K1 w - - 0 1",a:[["b5","c6","green"],["d1","d8","blue"]],c:"Black's rook guards both the queen and the back rank. After Qxc6 Rxc6, Rd8 is mate."},
  {w:"2n5/1KPk4/8/4P2p/7P/8/8/8 w - h6 0 78",m:["e5e6","d7e6","b7c8"],c:"White to move. One black piece is doing an important job.",t:["e6+! Black's king is the only guard of the knight on c8, and this pawn check pulls it away.","Kxe6. The king had to leave d7, and from its new square it can't guard the knight.","Kxc8 wins the knight."],src:"K2I6o"},
  {h:"How to find deflections",l:["Which enemy piece is the only guard of something important?","Can I attack it, check it, or offer it something it must take?","Once it moves, what falls?"]}],
 "pz-smothered":[{p:"In a smothered mate a knight checks a king that can't move because its own pieces are all around it. It usually happens with the king in the corner, hemmed in by its rook and pawns."},
  {d:"6rk/5Npp/8/8/8/8/8/6K1 b - - 0 1",o:"w",c:"Nf7#: the king is boxed in by its own rook and pawns."},
  {p:"The famous version starts with a queen check on g8: the rook has to take, it fills the king's last free square, and the knight mates on f7. It's called Philidor's legacy."},
  {w:"r1b3rk/pp3qbp/6p1/2P2pN1/1P6/4P1P1/P4P1P/2B2R1K w - - 0 23",m:["g5f7"],c:"White to move. Black's queen just took on f7. Look at the king in the corner.",t:["Nxf7#. The knight takes the queen with check, and the king can't move: its rook, bishop and pawn fill every square around it."],src:"IPcMx"},
  {h:"How to find it",l:["Is the enemy king surrounded by its own pieces?","Can a knight give check?","If not yet, can a sacrifice force a piece onto the last free square?"]}],
 "pz-mate3":[{p:"Mate in three is about staying forcing. A chain of checks keeps your opponent's choices small, so you can follow every line to the end. Picture where the king goes after each check and which squares stay open."},
  {w:"6k1/5ppp/2p1b3/r2r4/5K2/4P3/2P3PP/1R5R w - - 0 26",m:["b1b8","e6c8","b8c8","d5d8","c8d8"],c:"White to move. Black's king is stuck behind its pawns.",t:["Rb8+ goes for the back rank.","Bc8 blocks.","Rxc8+ takes the blocker, with check again.","Rd8 blocks once more.","Rxd8#. Black has run out of blockers."],src:"C4c57"},
  {h:"How to find it",l:["Start with checks that leave few replies.","Follow each reply to the end before you move.","If the checks run out, look for one quiet move that takes the last square."]}],
 "pz-patterns":[{p:"Some mates come up again and again. Learn their shapes and you'll recognise them in your own games, often a move or two before they happen. Just look at each picture for a moment: the puzzles will make them stick."},
  {d:"7k/7R/5N2/8/8/8/8/6K1 b - - 0 1",o:"w",c:"Arabian mate: the knight guards the rook and the last free square."},
  {d:"8/4N1pk/8/7R/8/8/8/6K1 b - - 0 1",o:"w",c:"Anastasia's mate: the knight covers g6 and g8, the rook mates along the h-file."},
  {d:"2kr4/3p4/B7/8/5B2/8/8/6K1 b - - 0 1",o:"w",c:"Boden's mate: two bishops on crossing diagonals against a king that castled long."},
  {d:"6bk/8/5B2/7K/4B3/8/8/8 b - - 0 1",o:"w",c:"Two-bishop mate: bishops on neighbouring diagonals take every square."},
  {d:"5r2/6kR/5Np1/6P1/8/8/8/6K1 b - - 0 1",o:"w",c:"Hook mate: the rook is guarded by the knight, and the knight by a pawn."},
  {d:"5Q2/3bk3/4p2B/8/8/8/8/6K1 b - - 0 1",o:"w",c:"Dovetail mate: the queen right next to the king, the squares behind it blocked by the king's own pieces."},
  {w:"7k/pp3p2/3rbN1p/4p3/4P3/2r2PR1/P4K1P/8 w - - 0 26",m:["g3g8"],c:"White to move. The knight on f6 is already in place.",t:["Rg8#. An Arabian mate: the knight guards the rook and the h7 square."],src:"XZsR0"}]};
const LIDX={},CIDX={},COIDX={};for(const t of TRACKS)for(const co of t.courses){COIDX[co.id]={t,co};for(const ch of co.chapters){CIDX[ch.id]={t,co,ch};for(const l of ch.lessons)LIDX[l.id]={t,co,ch,l}}}
/* progress: LSP = uk("lessons") = {"l:<lesson>": {s: steps done, d: completed (ms)}, "c:<chapter>": {p: check passed (ms), d: completed (ms)},
   "c:pz-<course>": {v: puzzle skill as text}, lvl: {v}; each with at (ms)} */
let LSP={},LP=null,PZS={};
const lsDone=id=>!!(LSP["l:"+id]||{}).d,lsCount=()=>Object.keys(LSP).filter(k=>k.startsWith("l:")&&LSP[k].d).length;
const saveLSP=k=>{LSP[k].at=Date.now();LS.set(uk("lessons"),LSP);Sync.mark("ls",acct()+"|"+k);Fr.soon()};
const chDone=ch=>ch.lessons.every(l=>lsDone(l.id)),nextLesson=ch=>ch.lessons.find(l=>!lsDone(l.id))||ch.lessons[0];
/* puzzle courses: each course file is fetched from this site once; PZS = uk("pzs") {puzzleId: 1 solved cleanly, 2 missed or hinted} stays in this browser */
const PZD={},savePZS=()=>LS.set(uk("pzs"),PZS);
async function pzLoad(c){if(!PZD[c.id]){const r=await fetch(PZ_DIR+c.id+".json");if(!r.ok)throw new Error("HTTP "+r.status);PZD[c.id]=(await r.json()).bands}return PZD[c.id]}
const pzKey=c=>"c:pz-"+c.id,pzSkill=c=>+((LSP[pzKey(c)]||{}).v)||null,pzBand=r=>{const i=PZB.findIndex(b=>r<b[1]);return i<0?PZB.length-1:i},pzMid=i=>(PZB[i][0]+PZB[i][1])/2;
/* rating on chess.com's scale (Lichess ratings run about 250 higher) */
function pzR0(){const s=GAMES.length?stats():{};return s.rating?s.rating-(P.source==="li"?250:0):700}
/* the chapter to work on: the band of the course skill or, before any practice, of the rating (one band higher when the theme
   never shows up among the mistakes of 8+ tagged games); then the first unfinished chapter from there */
function pzRec(co,W){const sk=pzSkill(co.pz);let i=pzBand(sk||pzR0());if(!sk&&W&&W.n>=8&&!Object.keys(W.T).some(k=>MOT[k].to===co.id))i=Math.min(i+1,PZB.length-1);
 return co.chapters.slice(i).find(ch=>!chDone(ch))||co.chapters.find(ch=>!chDone(ch))||null}
/* Elo-style skill update after a puzzle: res 1 solved first try, .5 with a hint, 0 missed */
function pzRate(L,st,res){const c=L.x.co.pz,k=pzKey(c),R=pzSkill(c)||pzMid(L.x.ch.band),E=1/(1+Math.pow(10,(st.r-R)/400)),o=LSP[k]||(LSP[k]={});
 o.v=String(Math.max(400,Math.min(2200,Math.round(R+60*(res-E)))));saveLSP(k)}
/* next puzzle: in Practice and Challenge one missed earlier comes back first; otherwise the unseen puzzle closest to skill + the lesson's offset */
function pzPick(L){const l=L.x.l,ch=L.x.ch,pool=PZD[ch.pz.id][ch.band],B=PZB[ch.band],t=Math.max(B[0],Math.min(B[1],(pzSkill(ch.pz)||pzMid(ch.band))+l.off)),free=pool.filter(p=>!L.used.has(p[0]));
 const miss=l.off>=0&&!L.back&&free.find(p=>PZS[p[0]]===2);if(miss){L.back=1;return miss}
 const fresh=free.filter(p=>!PZS[p[0]]),c=fresh.length?fresh:free;return c.reduce((a,p)=>Math.abs(p[3]-t)<Math.abs(a[3]-t)?p:a)}
const pzStep=p=>({f:p[1],m:p[2].split(" "),pz:p[0],r:p[3]}),lsN=L=>L.len||L.steps.length,pzPlay=(c,u)=>{const m=c.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]||"q"});return m&&{from:m.from,to:m.to}};
const PNM={p:"pawn",n:"knight",b:"bishop",r:"rook",q:"queen",k:"king"};

/* ---------- LESSONS TAB: priority list, profile, tracks; lesson player; teaching pages ---------- */
const LB=new Board($("#lboard"),{onMove:(f,t)=>lsMove(f,t),label:"Lesson board"}),LW=new Why($("#lWhy"),LB,new EvalBar($("#lEv")));let PGB=[],LTK=0;
function lsView(v){$("#lsHome").hidden=v!=="home";$("#lsPlay").hidden=v!=="play";$("#lsPage").hidden=v!=="page";if(v!=="play")LW.clear();window.scrollTo(0,0)}
/* a priority target: a lesson id, or a puzzle course, which resolves to its next lesson in the chapter from pzRec */
function lsTarget(x,W){if(!x)return null;if(LIDX[x])return LIDX[x];const C=COIDX[x];if(!C||!C.co.pz)return null;const ch=pzRec(C.co,W);return ch?{...CIDX[ch.id],l:nextLesson(ch)}:null}
function prioBtn(x,i,W){const T=lsTarget(x.to,W),cl=i===0?"pri":"";
 if(T&&T.co.pz)return `<button class="${cl}" type="button" data-ch="${T.ch.id}">${T.ch.lessons.some(l=>(LSP["l:"+l.id]||{}).s)?"Continue":"Start"}: ${esc(T.co.name)} ${esc(T.ch.short)}</button>`;
 if(T){const p=LSP["l:"+x.to]||{};return `<button class="${cl}" type="button" data-ls="${x.to}">${p.d?"Practise again":p.s?"Continue":"Start lesson"}</button>`}
 if(x.to==="openings")return `<button type="button" data-op="${esc(x.op||"")}">${ic("book-open","sm")}Opening trainer</button>`;
 if(x.to==="endgames")return '<span class="chip">Endgame lessons soon</span>';
 return x.k==="clock"?'<a class="small" href="#progress">See your clock use</a>':'<a class="small" href="#review">Review your games</a>'}
function renderLessons(){LP=null;lsView("home");const L=lvl(),auto=lvlAuto(),s=stats(),B=baseSecs();
 $("#lsLevel").innerHTML=LVLS.map(([id,n])=>`<option value="${id}"${id===L?" selected":""}>${n}${id===auto?" (suggested)":""}</option>`).join("");
 $("#lsLevelNote").textContent=GAMES.length?`Suggested from your rating${s.rating?` (${s.rating}${P.source==="li"?" on Lichess":""})`:""}${s.nAn>=10&&s.errs!=null?` and accuracy (${s.errs.toFixed(1)} mistakes a game)`:""}. Change it any time.`:"Suggested because there are no games yet.";
 const an=GAMES.filter(g=>g.an),pend=an.slice(-MT_GAMES).filter(g=>!(g.mt&&g.mt.v===MT_V)).length,pr=lsPriority().slice(0,5),W=wkProfile();
 // work on these first; beginners get First steps at the top until it's done
 const fsOpen=["new","beg"].includes(L)&&TRACKS[0].courses[0].chapters.some(ch=>!chDone(ch)),fsL=fsOpen?TRACKS[0].courses[0].chapters.map(nextLesson).find(l=>!lsDone(l.id)):null;
 const items=(fsL?[{k:"fs",name:"First steps",to:fsL.id,reason:"The basics every game is built on: moves, checkmate and keeping pieces safe."}]:[]).concat(pr).slice(0,5);
 $("#lsPrio").innerHTML=items.length?items.map((x,i)=>`<li class="prio-item${i===0?" top":""}"><span class="prio-n">${i+1}</span><div class="prio-txt"><b>${esc(x.name)}</b><span class="small">${esc(x.reason)}</span></div>${prioBtn(x,i,W)}</li>`).join("")
  :`<li class="empty">${an.length?pend?"Working out your weak spots from your analysed games…":"Not enough mistakes to rank yet. Nicely played.":"Analyse a few games and your personal list appears here."}</li>`;
 // profile by theme (longer bar = more points lost a game) and strengths
 const rows=Object.entries(W.T).map(([k,x])=>({k,n:MOT[k].n,c:x.d/W.n,cnt:x.n})).sort((a,b)=>b.c-a.c),mx=Math.max(.1,...rows.map(r=>r.c)),bar=(n,c,cnt,col,m)=>`<li><span class="bar-l">${esc(n)}</span><span class="bar-t"><b style="width:${Math.max(3,c/(m||mx)*100)}%;background:${col}"></b></span><span class="bar-v num" title="${cnt} mistakes">${c.toFixed(1)}</span></li>`;
 const good=[];if(W.n>=8){[["hang","No hanging pieces"],["fork_missed","No missed forks"],["mate_missed","No missed mates"],["fork_allowed","No forks allowed"]].forEach(([k,t])=>{if(!W.T[k])good.push(`${t} in your last ${W.n} games`)});
  const ph=Object.entries(W.PH).filter(([,x])=>x.n).sort((a,b)=>a[1].d-b[1].d)[0];if(ph)good.push(`Your strongest phase: the ${ph[0]}`)}
 if(s.time!=null&&s.time>=B*.5)good.push("You use your clock well");
 $("#lsProfile").innerHTML=W.n?`<p class="small">From ${W.n} analysed game${W.n>1?"s":""}${pend?` (${pend} more being checked)`:""}. Points lost a game per theme: longer is weaker.</p><ul class="bars">${rows.map(r=>bar(r.n,r.c,r.cnt,r.k==="positional"?"var(--border-strong)":"var(--q-blunder)")).join("")}</ul>`+(good.length?`<h3 class="h-small">Strengths</h3><ul class="good">${good.map(g=>`<li>${ic("circle-check","sm")}${esc(g)}</li>`).join("")}</ul>`:"")
  :`<div class="empty">${an.length?"Checking your mistakes with Stockfish…":"Your profile appears after a few analysed games."}</div>`;
 const pm=Math.max(.1,...Object.values(W.PH).map(x=>x.d/Math.max(1,W.n)));
 $("#lsPhase").innerHTML=W.n?`<ul class="bars">${Object.entries(W.PH).map(([k,x])=>bar(PHN[k],x.d/W.n,x.n,"var(--q-mistake)",pm)).join("")}</ul>`+
  (Object.keys(W.ET).length?`<h3 class="h-small">Endings</h3><ul class="good">${Object.entries(W.ET).sort((a,b)=>b[1].d-a[1].d).map(([k,x])=>`<li>${ic("flag","sm")}${esc(ENDT[k])}: ${x.n} mistake${x.n>1?"s":""}</li>`).join("")}</ul>`:"")
  :'<div class="empty">Phases appear with your profile.</div>';
 // tracks > courses > chapters > lessons; puzzle courses on your priority list are marked "For you" and open
 const fy=new Set(pr.map(x=>x.to).filter(t=>COIDX[t]));
 $("#lsTracks").innerHTML=TRACKS.map(t=>`<div class="track"><h2>${ic(t.icon)}${esc(t.name)}</h2>${t.courses.length?t.courses.map((co,i)=>(co.pz&&!t.courses[i-1].pz?`<h3 class="h-small pz-h">Puzzle courses</h3><p class="small">Real positions from the Lichess puzzle database, from easy to hard. Each course has a chapter per rating range; you start at the one that fits you.</p>`:"")+courseHTML(co,L,W,fy)).join(""):`<p class="small">${esc(t.soon)}</p>${t.id==="openings"?`<button type="button" data-op="">${ic("book-open","sm")}Open the opening trainer</button>`:""}`}</div>`).join("");
 if(pend)TG.run()}
/* placement checks may have one miss in four (none in shorter checks) */
const lsAllow=n=>n>=4?1:0;
function courseHTML(co,L,W,fy){if(co.pz)return pzCourseHTML(co,W,fy);const rec=co.lv.includes(L);
 return `<div class="course${rec?" rec":""}"><div class="course-h"><b>${esc(co.name)}</b><span class="chip${rec?" xp":""}">${rec?"Recommended":co.lv.map(lvlName).join(" · ")}</span></div><p class="small">${esc(co.desc)}</p>`+co.chapters.map(ch=>{
  const d=ch.lessons.filter(l=>lsDone(l.id)).length,c=LSP["c:"+ch.id]||{},started=ch.lessons.some(l=>(LSP["l:"+l.id]||{}).s),done=chDone(ch);
  return `<div class="chapter"><div class="ch-h"><span class="ch-name">${done?ic("circle-check","sm"):""}${esc(ch.name)}</span><span class="small num">${d}/${ch.lessons.length} lessons</span></div><div class="meter"><b style="width:${d/ch.lessons.length*100}%;background:var(--primary)"></b></div>`+
   `<ul class="ls-list">${ch.lessons.map(l=>{const p=LSP["l:"+l.id]||{};return `<li><button class="link" type="button" data-ls="${l.id}">${p.d?ic("check","sm"):""}${esc(l.name)}</button><span class="small num">${p.s||0}/${l.steps.length}</span>${PAGES[l.id]?`<button class="link small" type="button" data-pg="${l.id}">Learn more</button>`:""}</li>`}).join("")}</ul>`+
   `<div class="row">${done?'<span class="chip gold">'+ic("award","sm")+"Completed</span>":`<button class="${rec?"pri":""}" type="button" data-ch="${ch.id}">${started?"Continue":"Start"}</button>`}${ch.test&&!c.p&&!done&&!started?`<button type="button" data-test="${ch.id}">${ic("graduation-cap","sm")}Take the ${ch.test.length}-puzzle check</button>`:""}${c.p&&!done?'<span class="chip gold">Check passed</span>':""}</div></div>`}).join("")+"</div>"}
/* a puzzle course: one collapsible card, a dot per chapter, the chapter to start at marked; checks let you skip ahead from there */
function pzCourseHTML(co,W,fy){const rec=pzRec(co,W),sk=pzSkill(co.pz),nd=co.chapters.filter(chDone).length,f=fy.has(co.id);
 return `<details class="course pzc${f?" rec":""}"${f?" open":""}><summary><span class="course-h"><b>${esc(co.name)}</b><span class="chips">${f?'<span class="chip xp">For you</span>':""}${rec?`<span class="chip">Your chapter: ${esc(rec.short)}</span>`:`<span class="chip gold">${ic("award","sm")}Completed</span>`}${ic("chevron-right","pz-chev")}</span></span>`+
  `<span class="small">${esc(co.desc)}</span><span class="bands" role="img" aria-label="${nd} of ${co.chapters.length} chapters done">${co.chapters.map(ch=>`<i class="${chDone(ch)?"done":ch===rec?"on":""}"></i>`).join("")}</span></summary>`+
  `<div class="pz-body"><div class="row"><button type="button" data-pg="${co.id}">${ic("book-open","sm")}Learn the idea</button>${sk?`<span class="small">Your puzzle level here: about <b class="num">${sk}</b></span>`:""}</div>`+
  co.chapters.map(ch=>{const d=ch.lessons.filter(l=>lsDone(l.id)).length,c=LSP["c:"+ch.id]||{},started=ch.lessons.some(l=>(LSP["l:"+l.id]||{}).s),done=chDone(ch),me=ch===rec;
   return `<div class="chapter${me?" me":""}"><div class="ch-h"><span class="ch-name">${done?ic("circle-check","sm"):""}${esc(ch.short)}${me?' <span class="chip xp">Start here</span>':""}</span><span class="small num">${d}/${ch.lessons.length} lessons</span></div>`+
    `<div class="ls-row">${ch.lessons.map(l=>{const p=LSP["l:"+l.id]||{};return `<button class="link" type="button" data-ls="${l.id}">${p.d?ic("check","sm"):""}${esc(l.name)}<span class="small num">${p.s||0}/${PZ_N}</span></button>`}).join("")}</div>`+
    (done?"":`<div class="row"><button class="${me?"pri":""}" type="button" data-ch="${ch.id}">${started?"Continue":"Start"}</button>${!c.p&&rec&&ch.band>=rec.band?`<button type="button" data-test="${ch.id}">${ic("graduation-cap","sm")}Skip ahead: ${PZ_T}-puzzle check</button>`:""}</div>`)+"</div>"}).join("")+"</div></details>"}
/* one handler for every lessons button */
$("#v-lessons").addEventListener("click",e=>{const b=e.target.closest("button[data-ls],button[data-pg],button[data-ch],button[data-test],button[data-op]");if(!b)return;
 if(b.dataset.ls)openLesson(b.dataset.ls);else if(b.dataset.pg)openPage(b.dataset.pg);else if(b.dataset.ch)openLesson(nextLesson(CIDX[b.dataset.ch].ch).id);else if(b.dataset.test)openTest(b.dataset.test);
 else if(b.dataset.op!=null){if(b.dataset.op){OPSEL=b.dataset.op;LS.set(uk("opsel"),OPSEL);OD=null}location.hash="openings"}});
$("#lsLevel").onchange=()=>{LSP.lvl={v:$("#lsLevel").value};saveLSP("lvl");renderLessons()};
$("#lBack").onclick=$("#pgBack").onclick=()=>renderLessons();
/* player: a lesson (steps in order, progress saved) or a placement check (first try counts). Puzzle lessons pick each puzzle when
   it's reached (pzPick); puzzle steps have m (moves: the opponent's setup move, then the solution) and track miss/help. */
const lsCrumb=L=>`${L.x.t.name} › ${L.x.co.name} › ${L.x.ch.short||L.x.ch.name}`;
async function openLesson(id,i){const x=LIDX[id];if(!x)return;const p=LSP["l:"+id]||{};
 const L=LP={kind:"lesson",x,steps:x.l.pz?[]:x.l.steps,len:x.l.steps.length,i:i!=null?i:p.d?0:Math.min(p.s||0,x.l.steps.length-1),fails:0,used:new Set()};lsView("play");
 if(x.l.pz&&!(await lsLoad(L)))return;lsStep()}
async function openTest(id){const x=CIDX[id];if(!x||!x.ch.test)return;const L=LP={kind:"test",x,steps:x.ch.pz?[]:x.ch.test,len:x.ch.test.length,i:0,fails:0,used:new Set()};lsView("play");
 if(x.ch.pz){if(!(await lsLoad(L)))return;const pool=PZD[x.ch.pz.id][x.ch.band];L.steps=[.55,.7,.82,.94].map(f=>pzStep(pool[Math.min(pool.length-1,Math.floor(f*pool.length))]))}lsStep()}
/* fetch a course's puzzles (from this site); false if that failed or the player left meanwhile */
async function lsLoad(L){$("#lCrumb").textContent=lsCrumb(L);$("#lTitle").textContent=L.kind==="test"?"Placement check":L.x.l.name;$("#lDots").innerHTML="";$("#lFeedback").innerHTML="";$("#lSrc").hidden=true;
 $("#lPrompt").className="verdict v-info";$("#lPrompt").innerHTML='<span class="skel" style="width:60%" aria-label="Loading puzzles"></span>';
 try{await pzLoad(L.x.ch.pz)}catch(e){if(LP===L){$("#lPrompt").className="verdict v-no";$("#lPrompt").innerHTML=`${ic("circle-x")}Couldn't load the puzzles. Check your connection and try again.`}return false}return LP===L}
const hintBtn=(L,st,t)=>{$("#lFeedback").innerHTML=`<div class="v-actions"><button class="ghost" type="button" id="lHint">${ic("lightbulb","sm")}${t||"Hint"}</button></div>`;$("#lHint").onclick=()=>pzHint(L,st)};
function lsStep(){const L=LP;if(L.x.l&&L.x.l.pz&&!L.steps[L.i]){const p=pzPick(L);L.used.add(p[0]);L.steps[L.i]=pzStep(p)}
 const st=L.steps[L.i],n=lsN(L),tk=L.tk=++LTK,c=new Chess(st.f),pz=!!st.m,side=(c.turn()==="w")!==pz?"White":"Black";L.wait=!pz;LW.clear();
 if(pz){L.k=1;L.c=null;LB.flip=c.turn()==="w";LB.set(st.f);setTimeout(()=>{if(LP!==L||L.tk!==tk)return;const m=pzPlay(c,st.m[0]);L.c=c;LB.set(c.fen(),{last:m});L.wait=true},500)}
 else{LB.flip=c.turn()==="b";LB.set(st.f)}
 $("#lCrumb").textContent=lsCrumb(L);$("#lTitle").textContent=L.kind==="test"?"Placement check":L.x.l.name;
 $("#lDots").innerHTML=Array.from({length:n},(s,k)=>`<span class="sdot${k<L.i?" done":k===L.i?" on":""}"></span>`).join("")+`<span class="small">${pz||L.kind==="test"?"Puzzle":"Step"} ${L.i+1} of ${n}</span>`;
 const ask=pz?(L.kind==="test"?"Find the best move. Only your first try counts.":L.x.l.pz.ask):st.n;
 $("#lPrompt").className="verdict v-move";$("#lPrompt").innerHTML=`${ic("target")}<b>${side} to move.</b> ${esc(ask)}${pz&&L.kind==="lesson"?`<span class="coach-note">${esc(L.x.l.note)}</span>`:""}`;
 $("#lFeedback").innerHTML="";if(pz&&L.kind==="lesson")hintBtn(L,st);
 $("#lSrc").hidden=!pz;if(pz)$("#lSrc").innerHTML=`Puzzle rating ${st.r} · from a real game: <a href="https://lichess.org/training/${encodeURIComponent(st.pz)}" target="_blank" rel="noopener noreferrer">Lichess puzzle ${esc(st.pz)}</a>`;
 $("#lPage").hidden=!(L.kind==="lesson"&&(PAGES[L.x.l.id]||PAGES[L.x.co.id]));$("#lSkip").hidden=L.kind!=="test"}
async function lsMove(from,to){const L=LP;if(!L||!L.wait)return;const st=L.steps[L.i];if(st.m)return pzMove(L,st,from,to);const fen=st.f,c=new Chess(fen),mv=c.move({from,to,promotion:"q"});if(!mv)return;L.wait=false;
 const u=mv.from+mv.to,g=st.g||"best";LB.set(c.fen(),{last:{from,to}});let ok=false,also=false;
 if(g==="legal")ok=true;else if(g==="check")ok=c.in_check();else if(g==="mate")ok=c.in_checkmate();
 else{ok=[...(st.s||[]),...(st.alt||[])].some(s=>s.slice(0,4)===u);
  if(!ok&&!st.x&&st.s){$("#lFeedback").innerHTML='<div class="skel-wrap" role="status"><span class="sr-only">Checking your move…</span><span class="skel" style="width:55%"></span></div>';
   try{const sd=fen.split(" ")[1]==="w"?1:-1,t=new Chess(fen);t.move({from:st.s[0].slice(0,2),to:st.s[0].slice(2,4),promotion:st.s[0][4]||"q"});const a=await wEval(t.fen()),b=await wEval(c.fen());if(LP!==L)return;
    if(wp(sd*a.cp)-wp(sd*b.cp)<OP_TOL){ok=true;also=true}}catch(e){}}}
 if(LP!==L)return;Snd.play(ok?"correct":"wrong");if(ok)lsRight(L,mv,also);else lsWrong(L,fen,c,mv,u)}
/* a puzzle move: the solution move or any checkmate is right; the opponent's reply follows */
function pzMove(L,st,from,to){const pre=L.c.fen(),c=new Chess(pre),w=st.m[L.k];let mv=c.move({from,to,promotion:"q"});if(!mv)return;L.wait=false;
 const hit=w.slice(0,4)===from+to;if(hit&&w[4]&&w[4]!==mv.promotion){c.undo();mv=c.move({from,to,promotion:w[4]})}
 const ok=hit||c.in_checkmate();LB.set(c.fen(),{last:{from,to}});
 if(!ok){Snd.play("wrong");return pzWrong(L,st,pre,c,mv)}
 if(c.in_checkmate()||L.k+1>=st.m.length){Snd.play("correct");L.c=new Chess(pre);return L.kind==="test"?lsTestNext(L,true,mv):pzDone(L,st,mv)}
 $("#lFeedback").innerHTML=`<div class="verdict v-ok">${ic("circle-check")}<b>${esc(mv.san)}.</b> Good. Keep going.</div>`;const tk=L.tk;
 setTimeout(()=>{if(LP!==L||L.tk!==tk)return;const r=pzPlay(c,st.m[L.k+1]);L.k+=2;L.c=c;LB.set(c.fen(),{last:r});L.wait=true;if(L.kind==="lesson")hintBtn(L,st);else $("#lFeedback").innerHTML=""},550)}
function pzDone(L,st,mv){if(!st.miss)pzRate(L,st,st.help?.5:1);PZS[st.pz]=st.miss||st.help?2:1;savePZS();lsRight(L,mv,false)}
function pzWrong(L,st,pre,c,mv){if(L.kind==="test"){L.fails++;return lsTestNext(L,false,mv)}
 if(!st.miss){st.miss=true;pzRate(L,st,0);PZS[st.pz]=2;savePZS()}
 const w=st.m[L.k],back=()=>LB.set(c.fen(),{last:{from:mv.from,to:mv.to}});
 $("#lFeedback").innerHTML=`<div class="verdict v-no">${ic("circle-x")}<b>${esc(mv.san)}</b> isn't it. Look again.</div><div class="v-actions"><button type="button" id="lRetry">${ic("rotate-ccw","sm")}Try again</button><button class="ghost" type="button" id="lShow">${ic("eye","sm")}Show me</button></div>`;
 $("#lRetry").onclick=()=>{LW.clear();LB.set(pre);L.wait=true;hintBtn(L,st)};
 $("#lShow").onclick=()=>{LW.clear();st.help=2;LB.set(pre,{arrows:[{from:w.slice(0,2),to:w.slice(2,4),c:"green"}]});L.wait=true;$("#lFeedback").innerHTML=`<div class="verdict v-info">${ic("info")}Play the green arrow to carry on.</div>`};
 LW.show({fen:pre,played:mv.from+mv.to+(mv.promotion||""),best:w,restore:back})}
/* hints: first the piece to move, then the arrow; a hinted puzzle counts half and comes back later */
function pzHint(L,st){if(!L.wait||!L.c)return;const w=st.m[L.k],fen=L.c.fen(),p=L.c.get(w.slice(0,2));st.help=(st.help||0)+1;
 if(st.help===1){LB.set(fen,{hl:w.slice(0,2)});hintBtn(L,st,"Show the move");$("#lFeedback").insertAdjacentHTML("afterbegin",`<div class="verdict v-info">${ic("lightbulb")}Move your ${PNM[p.type]} on ${w.slice(0,2)}.</div>`)}
 else{LB.set(fen,{arrows:[{from:w.slice(0,2),to:w.slice(2,4),c:"green"}]});$("#lFeedback").innerHTML=`<div class="verdict v-info">${ic("lightbulb")}Play the green arrow.</div>`}}
function lsChapterDone(ch){const k="c:"+ch.id,c=LSP[k]||(LSP[k]={});if(c.d||!chDone(ch))return;c.d=Date.now();saveLSP(k);gAdd({lc:1});gToast(`Chapter complete: ${ch.name}! +${GX.lc} XP`)}
/* after a puzzle lesson: suggest the next or previous chapter when the skill has left this band */
function pzShift(L){const ch=L.x.ch,co=L.x.co,i=co.chapters.indexOf(ch),sk=pzSkill(co.pz)||0,B=PZB[ch.band];
 if(sk>=B[1]+40&&co.chapters[i+1]&&!chDone(co.chapters[i+1]))return {ch:co.chapters[i+1],t:"These are getting easy for you. Ready for the next chapter?"};
 if(sk&&sk<B[0]-60&&i>0&&!chDone(co.chapters[i-1]))return {ch:co.chapters[i-1],t:"These are tough ones. The previous chapter may suit you better for now."};return null}
function lsRight(L,mv,also){const st=L.steps[L.i],n=lsN(L),last=L.i===n-1;let nx="",tip="";
 if(L.kind==="lesson"){const k="l:"+L.x.l.id,p=LSP[k]||(LSP[k]={s:0}),fresh=L.i>=(p.s||0);if(fresh)p.s=L.i+1;if(last&&!p.d)p.d=Date.now();saveLSP(k);if(fresh)gAdd({ls:1});if(last)lsChapterDone(L.x.ch);
  const nl=L.x.ch.lessons[L.x.ch.lessons.indexOf(L.x.l)+1],nch=L.x.co.chapters[L.x.co.chapters.indexOf(L.x.ch)+1],mv2=last&&st.m?pzShift(L):null;
  const go=!last?["Next "+(st.m?"puzzle":"step"),()=>{L.i++;lsStep()}]:nl?["Next lesson: "+nl.name,()=>openLesson(nl.id,0)]:nch&&L.x.co.pz?["Next chapter: "+nch.short,()=>openLesson(nextLesson(nch).id)]:["Back to lessons",()=>renderLessons()];
  nx=`<button class="pri" type="button" id="lNext">${esc(go[0])}${ic("arrow-right","sm")}</button>`+(mv2?`<button type="button" id="lAlt">${esc(mv2.ch.short)}</button>`:"");if(mv2)tip=` ${mv2.t}`;
  const okTxt=st.m?(st.miss?"Solved.":st.help?"Solved with a hint.":"Solved first try!"):st.ok||"Correct.";
  $("#lFeedback").innerHTML=`<div class="verdict v-ok">${ic("circle-check")}<b>${esc(mv.san)}.</b> ${also?"That works just as well. ":""}${esc(okTxt)}${last?` <b>Lesson complete.</b>`:""}${esc(tip)}</div><div class="v-actions">${nx}<button class="link" type="button" id="lWhyBtn">Why?</button></div>`;
  $("#lNext").onclick=go[1];if(mv2)$("#lAlt").onclick=()=>openLesson(nextLesson(mv2.ch).id)}
 else lsTestNext(L,true,mv);
 const w=$("#lWhyBtn");if(w)w.onclick=()=>{w.remove();const f=st.m?L.c.fen():st.f;LW.show({fen:f,played:mv.from+mv.to+(mv.promotion||""),ok:true,restore:()=>LB.set(new Chess(f).fen())})}}
function lsWrong(L,fen,c,mv,u){const st=L.steps[L.i],back=()=>LB.set(c.fen(),{last:{from:mv.from,to:mv.to}});
 if(L.kind==="test"){L.fails++;return lsTestNext(L,false,mv)}
 $("#lFeedback").innerHTML=`<div class="verdict v-no">${ic("circle-x")}<b>${esc(mv.san)}</b> isn't it. ${st.g==="mate"?"That doesn't give checkmate.":st.g==="check"?"That isn't check.":"Look again."}</div><div class="v-actions"><button type="button" id="lRetry">${ic("rotate-ccw","sm")}Try again</button><button class="ghost" type="button" id="lShow">${ic("eye","sm")}Show me</button></div>`;
 $("#lRetry").onclick=()=>lsStep();$("#lShow").onclick=async()=>{let b=st.s&&st.s[0];if(!b)try{b=(await wEval(fen)).best}catch(e){}if(b&&LP===L)LB.set(fen,{arrows:[{from:b.slice(0,2),to:b.slice(2,4),c:"green"}]})};
 if(st.g!=="legal"&&st.g!=="check")LW.show({fen,played:u,best:st.s&&st.s[0],restore:back})}
function lsTestNext(L,ok,mv){const n=lsN(L),last=L.i===n-1,ch=L.x.ch,co=L.x.co;let html=`<div class="verdict ${ok?"v-ok":"v-no"}">${ic(ok?"circle-check":"circle-x")}<b>${esc(mv.san)}</b> ${ok?"is right.":"isn't it."}`;
 if(!last){$("#lFeedback").innerHTML=html+`</div><div class="v-actions"><button class="pri" type="button" id="lNext">Next puzzle${ic("arrow-right","sm")}</button></div>`;$("#lNext").onclick=()=>{L.i++;lsStep()};return}
 if(L.fails<=lsAllow(n)){const k="c:"+ch.id,c=LSP[k]||(LSP[k]={});c.p=Date.now();saveLSP(k);ch.lessons.forEach(l=>{const q=LSP["l:"+l.id]||(LSP["l:"+l.id]={s:0});if(!q.d){q.s=l.steps.length;q.d=Date.now();saveLSP("l:"+l.id)}});lsChapterDone(ch);
  if(ch.pz){const sk=LSP[pzKey(ch.pz)]||(LSP[pzKey(ch.pz)]={});if((+sk.v||0)<PZB[ch.band][1]){sk.v=String(PZB[ch.band][1]);saveLSP(pzKey(ch.pz))}}
  const nch=ch.pz?co.chapters[co.chapters.indexOf(ch)+1]:null;
  $("#lFeedback").innerHTML=html+` <b>You passed the check</b> (${n-L.fails} of ${n}): this chapter is marked complete, so you can skip ahead.</div><div class="v-actions"><button class="pri" type="button" id="lNext">${nch?`Next chapter: ${esc(nch.short)}`:"Back to lessons"}${ic("arrow-right","sm")}</button></div>`;
  $("#lNext").onclick=()=>nch?openLesson(nextLesson(nch).id):renderLessons()}
 else{const c=LSP["c:"+ch.id]||(LSP["c:"+ch.id]={});c.t=Date.now();saveLSP("c:"+ch.id);
  $("#lFeedback").innerHTML=html+` You got ${n-L.fails} of ${n}. Work through the lessons first; they're short.</div><div class="v-actions"><button class="pri" type="button" id="lNext">Start the first lesson${ic("arrow-right","sm")}</button></div>`;$("#lNext").onclick=()=>openLesson(ch.lessons[0].id,0)}}
$("#lPage").onclick=()=>{if(LP&&LP.kind==="lesson")openPage(PAGES[LP.x.l.id]?LP.x.l.id:LP.x.co.id)};$("#lSkip").onclick=()=>{if(LP)openLesson(LP.x.ch.lessons[0].id,0)};$("#lRestart").onclick=()=>{if(LP&&LP.steps[LP.i])lsStep()};
/* teaching page: text, diagrams, a worked example to step through and a checklist, then practice */
function openPage(id){const x=LIDX[id]||COIDX[id],pg=PAGES[id];if(!x||!pg)return;LP=null;lsView("page");$("#pgCrumb").textContent=x.ch?`${x.t.name} › ${x.co.name} › ${x.ch.name}`:`${x.t.name} › Puzzle courses`;$("#pgTitle").textContent=x.l?x.l.name:x.co.name;
 PGB.forEach(b=>{const i=BOARDS.indexOf(b);if(i>=0)BOARDS.splice(i,1)});PGB=[];
 $("#pgBody").innerHTML=pg.map((b,k)=>b.p?`<p>${esc(b.p)}</p>`:b.l?`<h2 class="h-small">${esc(b.h)}</h2><ul class="pg-list">${b.l.map(t=>`<li>${ic("check","sm")}${esc(t)}</li>`).join("")}</ul>`
  :b.w?`<figure class="pg-fig pg-ex"><div class="boardwrap" id="pgb${k}"></div><figcaption><p class="pg-cap" id="pgc${k}" aria-live="polite"></p><div class="row"><button class="icon-btn" type="button" id="pgp${k}" aria-label="Previous move">${ic("chevron-left")}</button><span class="small num" id="pgn${k}"></span><button class="pri" type="button" id="pgx${k}">Next move${ic("chevron-right","sm")}</button></div>${b.src?`<span class="small">From a real game: Lichess puzzle ${esc(b.src)}</span>`:""}</figcaption></figure>`
  :`<figure class="pg-fig"><div class="boardwrap" id="pgb${k}"></div><figcaption class="small">${esc(b.c||"")}</figcaption></figure>`).join("");
 pg.forEach((b,k)=>{if(!b.d&&!b.w)return;const B=new Board($("#pgb"+k),{label:b.c||"Diagram"});PGB.push(B);
  if(b.d){B.flip=b.o?b.o==="b":b.d.split(" ")[1]==="b";B.set(b.d,{arrows:(b.a||[]).map(([f,t,c])=>({from:f,to:t,c}))});return}
  // worked example: step through the moves, a caption for each
  const c=new Chess(b.w),F=[{fen:c.fen()}];for(const u of b.m){const m=pzPlay(c,u);F.push({fen:c.fen(),last:m})}B.flip=b.w.split(" ")[1]==="b";let j=0;
  const draw=()=>{const nx=b.m[j];B.set(F[j].fen,{last:F[j].last,arrows:nx?[{from:nx.slice(0,2),to:nx.slice(2,4),c:"green"}]:[]});$("#pgc"+k).textContent=j?b.t[j-1]:b.c;$("#pgn"+k).textContent=`${j}/${b.m.length}`;$("#pgp"+k).disabled=!j;$("#pgx"+k).disabled=j>=b.m.length};
  $("#pgp"+k).onclick=()=>{if(j){j--;draw()}};$("#pgx"+k).onclick=()=>{if(j<b.m.length){j++;draw()}};draw()});
 const T=x.l?null:lsTarget(id),pr=$("#pgPractice");pr.hidden=!x.l&&!T;pr.innerHTML=`${T?`Practise: ${esc(T.ch.short)}`:"Practise this"}${ic("arrow-right")}`;pr.onclick=()=>T?openLesson(T.l.id):openLesson(id,0)}

/* ---------- GAMIFICATION (rule-based, from local data; synced as one row per account) ----------
   GS = uk("game") = {days: {"YYYY-MM-DD": {pz, p1, op, ol, rv, rvl, g, n, e}}, badges: {id: ms}, rec: {bw, ls, bb}, set: {int, hide, at}, rev: {gameId: 1}, at}
   days counts (local date): pz puzzles solved (first solve only), p1 of them on the first try, op opening positions right on review,
   ol positions that became learned, rv games reviewed (rvl losses), g daily goal met, n/e trained late at night / early.
   XP, streak, freezes, level, weekly challenge and best week are derived from days, so merging devices = per-field max/union. XP is for training only. */
const GX={pz:10,p1:5,op:3,ol:15,rv:10,ls:5,lc:50,g:25},GU={pz:1,op:1,rv:3,ls:1},GOAL={light:5,normal:10,serious:20},WK_BONUS=100,FZ_MAX=2;
const LEVELS=[["Pawn",0],["Knight",500],["Bishop",1500],["Rook",3500],["Queen",7000],["King",12000]],ROMAN=["I","II","III","IV","V","VI","VII","VIII","IX","X"];
const CH=[{t:"Solve 30 puzzles",n:30,k:"pz"},{t:"Get 40 opening positions right",n:40,k:"op"},{t:"Review 3 of your losses",n:3,k:"rvl"},{t:"Meet your daily goal on 5 days",n:5,k:"g"},{t:"Solve 10 puzzles on the first try",n:10,k:"p1"}];
const dkey=t=>{const d=new Date(t==null?Date.now():t);return new Date(d-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)};
const dAdd=(k,n)=>{const d=new Date(k+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const wkOf=k=>dAdd(k,-((new Date(k+"T12:00:00Z").getUTCDay()+6)%7)),chOf=wk=>CH[Math.floor(Date.parse(wk+"T12:00:00Z")/(7*864e5))%CH.length];
let GS=null,SEEN0=null;
const gNew=()=>({days:{},badges:{},rec:{},set:{int:"normal",hide:false,at:0},rev:{},at:0});
const gLoad=()=>{GS=Object.assign(gNew(),LS.get(uk("game"),{}))},gSave=()=>{GS.at=Date.now();LS.set(uk("game"),GS);Sync.mark("gm",acct());Fr.soon()};
const dayXP=d=>{let x=0;for(const k in GX)x+=(d[k]||0)*GX[k];return x},dayU=d=>{let u=0;for(const k in GU)u+=(d[k]||0)*GU[k];return u},gGoal=()=>GOAL[GS.set.int]||GOAL.normal;
function wkSum(wk){const w={pz:0,p1:0,op:0,ol:0,rv:0,rvl:0,g:0,xp:0};for(let i=0;i<7;i++){const d=GS.days[dAdd(wk,i)];if(!d)continue;for(const k in w)if(k!=="xp")w[k]+=d[k]||0;w.xp+=dayXP(d)}
 const c=chOf(wk);w.ch=c;w.chv=Math.min(c.n,w[c.k]);w.done=w.chv>=c.n;if(w.done)w.xp+=WK_BONUS;return w}
const gWeeks=()=>[...new Set(Object.keys(GS.days).map(wkOf))].sort();
const gXP=()=>gWeeks().reduce((a,wk)=>a+wkSum(wk).xp,0);
/* streak: consecutive days with the goal met; a freeze (one per 7 streak days, max 2) covers a missed day. Today counts once met. */
function gStreak(){const ks=Object.keys(GS.days).filter(k=>GS.days[k].g).sort(),today=dkey();let s=0,best=0,fz=0;const used=[];
 if(ks.length)for(let d=ks[0];d<today;d=dAdd(d,1)){if((GS.days[d]||{}).g){s++;if(s%7===0)fz=Math.min(FZ_MAX,fz+1)}else if(s>0&&fz>0){fz--;used.push(d)}else s=0;best=Math.max(best,s)}
 if((GS.days[today]||{}).g){s++;if(s%7===0)fz=Math.min(FZ_MAX,fz+1)}return {cur:s,best:Math.max(best,s),fz,used}}
function gLevel(xp){let i=0;while(i+1<LEVELS.length&&xp>=LEVELS[i+1][1])i++;
 if(i<LEVELS.length-1)return {name:LEVELS[i][0],next:LEVELS[i+1][0],from:LEVELS[i][1],to:LEVELS[i+1][1]};
 const k=xp<20000?-1:Math.floor((xp-20000)/8000),nm=j=>j<0?"King":"King "+(ROMAN[j]||j+1),from=k<0?12000:20000+k*8000;return {name:nm(k),next:nm(k+1),from,to:k<0?20000:from+8000}}
/* badges: [id, name, how, test(context)] */
const BADGES=[["pz1","First puzzle","Solve a puzzle",c=>c.pz>=1],["pz25","Puzzle regular","Solve 25 puzzles",c=>c.pz>=25],["pz100","Puzzle machine","Solve 100 puzzles",c=>c.pz>=100],["pz500","Puzzle master","Solve 500 puzzles",c=>c.pz>=500],
 ["ol10","Repertoire started","Learn 10 opening positions",c=>c.ol>=10],["ol50","Book knowledge","Learn 50 opening positions",c=>c.ol>=50],["ol200","Theory buff","Learn 200 opening positions",c=>c.ol>=200],
 ["s3","Three in a row","Meet your daily goal 3 days running",c=>c.best>=3],["s7","Full week","Keep a 7-day streak",c=>c.best>=7],["s30","Monthly habit","Keep a 30-day streak",c=>c.best>=30],["s100","Unstoppable","Keep a 100-day streak",c=>c.best>=100],
 ["rv10","Self-reviewer","Review 10 of your games",c=>c.rv>=10],["rv50","Game historian","Review 50 of your games",c=>c.rv>=50],
 ["imp_bl","Fewer blunders","Cut blunders and mistakes per game by 25% from your baseline",c=>c.blDown>=.25],
 ["imp_clk","Clock manager","Use at least half your clock per game after starting below that",c=>c.clk],
 ["imp_op","Opening fixed","Score 10+ points more in an opening since you started practising it",c=>c.opUp>=10],
 ["fun_night","Night owl","Train after 11 pm",c=>c.n],["fun_early","Early bird","Train before 7 am",c=>c.e],["fun_wknd","Weekend warrior","Meet your goal on a Saturday and the Sunday after",c=>c.wknd],
 ["ls1","First lesson","Complete a lesson step",c=>c.ls>=1],["lc1","Chapter done","Complete a lesson chapter",c=>c.lc>=1],["lc5","Scholar","Complete 5 lesson chapters",c=>c.lc>=5],
 ["fun_p1","Sharpshooter","Solve 10 puzzles on the first try in one day",c=>c.p1day>=10],["fun_wk","Challenge accepted","Complete a weekly challenge",c=>c.wkDone]];
const BICON={pz1:"puzzle",pz25:"puzzle",pz100:"puzzle",pz500:"crown",ol10:"book-open",ol50:"book-open",ol200:"graduation-cap",s3:"flame",s7:"flame",s30:"flame",s100:"flame",rv10:"search",rv50:"search",
 ls1:"graduation-cap",lc1:"graduation-cap",lc5:"graduation-cap",imp_bl:"shield-check",imp_clk:"timer",imp_op:"trending-up",fun_night:"moon",fun_early:"sunrise",fun_wknd:"calendar-check",fun_p1:"crosshair",fun_wk:"trophy"};
function gCtx(){const c={pz:0,ol:0,rv:0,ls:0,lc:0,p1day:0,n:0,e:0,wknd:0},D=GS.days;for(const k in D){const d=D[k];c.pz+=d.pz||0;c.ls+=d.ls||0;c.lc+=d.lc||0;c.ol+=d.ol||0;c.rv+=d.rv||0;c.p1day=Math.max(c.p1day,d.p1||0);if(d.n)c.n=1;if(d.e)c.e=1;
  if(d.g&&new Date(k+"T12:00:00Z").getUTCDay()===6&&(D[dAdd(k,1)]||{}).g)c.wknd=1}
 const st=gStreak(),s=stats(),b=LS.get(uk("base."+P.tc),null),B=baseSecs();c.best=st.best;c.cur=st.cur;c.wkDone=gWeeks().some(w=>wkSum(w).done);
 c.blDown=b&&b.errs>0&&s.errs!=null&&s.nAn>=b.nAn+10?(b.errs-s.errs)/b.errs:0;c.clk=!!(b&&b.time!=null&&s.time!=null&&b.time<B*.5&&s.time>=B*.5);
 c.opUp=Math.max(0,...Object.entries(LS.get(uk("opstart"),{})).map(([k,t])=>{const e=opEffect(k,t);return e?e.a-e.b:0}));return c}
const toastQ=[];let toastOn=false;
function gToast(msg){if(!GS||GS.set.hide)return;toastQ.push(msg);if(toastOn)return;const nx=()=>{const m=toastQ.shift();if(!m){toastOn=false;$("#toast").hidden=true;return}toastOn=true;const t=$("#toast");t.textContent=m;t.hidden=false;t.classList.remove("pop");void t.offsetWidth;t.classList.add("pop");setTimeout(nx,3200)};nx()}
/* after any change: level-ups, new badges, beaten records (first values are recorded silently) */
function gCheck(xp0){if(!P||!GS)return;const xp=gXP(),l0=gLevel(xp0==null?xp:xp0).name,l1=gLevel(xp).name;if(l1!==l0)gToast(`Level up: you're now a ${l1}!`);
 const c=gCtx();let ch=false;for(const [id,nm] of BADGES.map(x=>[x[0],x[1],x[3]]).filter(x=>x[2](c))){if(!GS.badges[id]){GS.badges[id]=Date.now();ch=true;gToast(`Badge earned: ${nm}`)}}
 const R=GS.rec,bw=Math.max(0,...gWeeks().filter(w=>w<wkOf(dkey())).map(w=>wkSum(w).xp),wkSum(wkOf(dkey())).xp),s=stats();
 const beat=(k,v,better,txt)=>{if(v==null)return;if(R[k]==null){R[k]=v;ch=true}else if(better(v,R[k])){R[k]=v;ch=true;gToast(txt)}};
 beat("bw",bw||null,(a,b)=>a>b,`New record: your best week, ${bw} XP!`);beat("ls",c.best||null,(a,b)=>a>b,`New record: your longest streak, ${c.best} days!`);
 if(s.nAn>=20&&s.errs!=null)beat("bb",+s.errs.toFixed(2),(a,b)=>a<b-.04,`New record: your lowest blunder rate, ${s.errs.toFixed(1)} per game!`);
 if(ch)gSave()}
/* record training: o = {pz: 1, p1: 1, ...} */
function gAdd(o){if(!P||!GS)return;const xp0=gXP(),t=dkey(),d=GS.days[t]||(GS.days[t]={}),h=new Date().getHours();for(const k in o)d[k]=(d[k]||0)+o[k];
 if(h>=23||h<4)d.n=1;else if(h<7)d.e=1;if(!d.g&&dayU(d)>=gGoal()){d.g=1;gToast(`Daily goal met! +${GX.g} XP`);Snd.play("goal")}
 const w=wkSum(wkOf(t));if(w.done&&!(GS.wkt===wkOf(t))){GS.wkt=wkOf(t);gToast(`Weekly challenge complete: ${w.ch.t}! +${WK_BONUS} XP`)}
 gSave();gCheck(xp0);if(route.cur==="home")renderHome()}
/* merge two states (sync): day counts max, badges earliest, records best, settings newest, reviewed union */
function gMerge(a,b){const o=gNew();o.days=JSON.parse(JSON.stringify(a.days||{}));for(const k in b.days||{}){const d=o.days[k]||(o.days[k]={});for(const f in b.days[k])d[f]=Math.max(d[f]||0,b.days[k][f]||0)}
 o.badges={...(a.badges||{})};for(const k in b.badges||{})o.badges[k]=Math.min(o.badges[k]||Infinity,b.badges[k]);
 const ra=a.rec||{},rb=b.rec||{},mx=(x,y)=>x==null?y:y==null?x:Math.max(x,y),mn=(x,y)=>x==null?y:y==null?x:Math.min(x,y);o.rec={bw:mx(ra.bw,rb.bw),ls:mx(ra.ls,rb.ls),bb:mn(ra.bb,rb.bb)};
 o.set=((b.set||{}).at||0)>((a.set||{}).at||0)?{...o.set,...b.set}:{...o.set,...(a.set||{})};o.rev={...(a.rev||{}),...(b.rev||{})};o.wkt=a.wkt||b.wkt;o.at=Math.max(a.at||0,b.at||0);return o}
const gRow=()=>({weekly_xp:GS?wkSum(wkOf(dkey())).xp:0,xp_week:wkOf(dkey()),streak:GS?gStreak().cur:0});
/* "You passed X this week!": friends ahead of me last time I looked, behind me now */
function lbPassed(rows){const wk=wkOf(dkey()),xp=r=>r.xp_week===wk?r.weekly_xp||0:0,me=rows.find(r=>r.is_me);if(!me)return [];const mine=xp(me),ahead=rows.filter(r=>!r.is_me&&xp(r)>mine).map(r=>r.display_name||"?");
 const prev=LS.get(uk("lbseen"),null),out=prev&&prev.wk===wk?prev.ahead.filter(n=>!ahead.includes(n)&&rows.some(r=>(r.display_name||"?")===n)):[];LS.set(uk("lbseen"),{wk,ahead});return out}

/* ---------- HOME ---------- */
const HTB=new Board($("#hThumb"),{label:"Biggest swing"});let HOMEtok=0,HSW=null;
function planCards(){const C=[],st=id=>TS[id]||{},retry=PZ.filter(p=>st(p.id).fail&&!st(p.id).ok),fresh=PZ.filter(p=>!st(p.id).seen),un=GAMES.filter(g=>!g.an).length,now=Date.now();
 const due=Object.values(OPS).filter(x=>x.due&&x.due<=now).length,loss=GAMES.slice().reverse().find(g=>g.result==="loss"&&g.an),pl=(n,w)=>n+" "+w+(n===1?"":"s");
 if(retry.length){const n=Math.min(retry.length,5);C.push({imp:30+retry.length*3,t:`Retry ${pl(n,"puzzle")} you missed`,p:"Positions where you went wrong before. Getting them right is the fastest way to fix a habit.",xp:n*GX.pz,go:"#trainer",i:"rotate-ccw",cta:"Retry"})}
 if(due){const n=Math.min(due,10);C.push({imp:26+due*2,t:`Review ${pl(n,"opening position")}`,p:"They're due today. Missed ones come back sooner.",xp:n*GX.op,go:"#openings",i:"book-open",cta:"Review"})}
 if(loss&&!GS.rev[loss.id]){const e=errorsOf(replay(loss)).filter(x=>x.mine).sort((a,b)=>b.drop-a.drop)[0];
  C.push({imp:28,t:`Review your loss vs ${loss.opp}`,p:e?`The game turned on move ${mvLabel(e.i)} ${loss.moves[e.i]} (${evTxt(e.before)} → ${evTxt(e.after)}).`:"Step through it and see where it turned.",xp:GX.rv,i:"scan-search",cta:"Review",act:()=>{openGame(loss,e?e.i:0);location.hash="review"}})}
 if(fresh.length){const n=Math.min(fresh.length,5);C.push({imp:20,t:`Solve ${pl(n,"new puzzle")} from your games`,p:"Every one is a position you got wrong in a real game.",xp:n*GX.pz,go:"#trainer",i:"puzzle",cta:"Solve"})}
 if(un){const n=Math.min(un,20);C.push({imp:15+n,t:`Analyse ${pl(n,"new game")}`,p:"Analysis finds your mistakes and turns them into puzzles.",xp:null,i:"cpu",cta:"Analyse",act:()=>{analyseRecent(20);renderHome()}})}
 const ost=LS.get(uk("opstart"),{}),m={};GAMES.filter(g=>g.ts>now-365*864e5).forEach(g=>{const k=g.color+"|"+famOf(g.eco);(m[k]=m[k]||[]).push(g)});
 const weak=Object.entries(m).filter(([k,a])=>a.length>=5&&!ost[k]&&score(a)<45).sort((a,b)=>score(a[1])-score(b[1]))[0];
 if(weak)C.push({imp:18,t:`Start practising the ${weak[0].slice(2)} as ${weak[0][0]==="w"?"White":"Black"}`,p:`You score ${Math.round(score(weak[1]))}% in it over ${weak[1].length} games this year.`,xp:5*GX.op,i:"book-open",cta:"Start",act:()=>{OPSEL=weak[0];LS.set(uk("opsel"),OPSEL);OD=null;location.hash="openings"}});
 const W=wkProfile(),lp=lsPriority().find(x=>{const T=lsTarget(x.to,W);return T&&!lsDone(T.l.id)}),fs=["new","beg"].includes(lvl())?TRACKS[0].courses[0].chapters.map(nextLesson).find(l=>!lsDone(l.id)):null,lx=fs?{to:fs.id,name:"First steps",reason:"The basics: moves, checkmate and keeping pieces safe."}:lp;
 if(lx){const T=lsTarget(lx.to,W),left=T.l.steps.length-((LSP["l:"+T.l.id]||{}).s||0);C.push({imp:fs?40:27+Math.min(12,lx.cost*2||0),t:`Lesson: ${T.co.pz?T.ch.name:T.l.name}`,p:lx.reason,xp:Math.max(1,left)*GX.ls,i:"graduation-cap",cta:"Start",act:()=>{location.hash="lessons";openLesson(T.l.id)}})}
 // fallbacks so there are always a few things to do
 const last=GAMES.slice().reverse().find(g=>g.an&&!GS.rev[g.id]&&g!==loss);if(C.length<3&&last)C.push({imp:8,t:`Review your game vs ${last.opp}`,p:"Step through it: wins have lessons too.",xp:GX.rv,i:"scan-search",cta:"Review",act:()=>{openGame(last,0);location.hash="review"}});
 const top=Object.entries(m).filter(([,a])=>a.length>=3).sort((a,b)=>b[1].length-a[1].length)[0];
 if(C.length<3&&top&&!C.some(c=>/practising/.test(c.t)))C.push({imp:6,t:`Drill your ${top[0].slice(2)} as ${top[0][0]==="w"?"White":"Black"}`,p:`Your most played opening: ${top[1].length} games this year.`,xp:5*GX.op,i:"book-open",cta:"Drill",act:()=>{OPSEL=top[0];LS.set(uk("opsel"),OPSEL);OD=null;location.hash="openings"}});
 return C.sort((a,b)=>b.imp-a.imp).slice(0,5)}
function ringSVG(d,goal){const R=42,L=2*Math.PI*R;let off=0,s=`<svg viewBox="0 0 100 100" class="ring" role="img" aria-label="Daily goal ${Math.min(dayU(d),goal)} of ${goal}"><circle cx="50" cy="50" r="${R}" fill="none" stroke="var(--border)" stroke-width="10"/>`;
 for(const [k,col] of [["pz","var(--q-blunder)"],["op","var(--q-best)"],["rv","var(--secondary)"],["ls","var(--xp)"]]){const f=Math.min((d[k]||0)*GU[k],Math.max(0,goal-off))/goal;if(f<=0)continue;
  s+=`<circle cx="50" cy="50" r="${R}" fill="none" stroke="${col}" stroke-width="10" stroke-dasharray="${f*L} ${L}" stroke-dashoffset="${-off/goal*L}" transform="rotate(-90 50 50)"/>`;off+=f*goal}
 return s+`<text x="50" y="47" text-anchor="middle" class="ring-n">${Math.min(dayU(d),goal)}/${goal}</text><text x="50" y="63" text-anchor="middle" class="ring-l">${d.g?"goal met":"today"}</text></svg>`}
function renderHome(){if(!P||!GS)return;const tok=++HOMEtok,hide=GS.set.hide,today=GS.days[dkey()]||{},goal=gGoal(),st=gStreak(),xp=gXP(),lv=gLevel(xp),w=wkSum(wkOf(dkey()));
 const hr=new Date().getHours();$("#hHello").textContent=`${hr<5?"Late session":hr<12?"Good morning":hr<18?"Good afternoon":"Good evening"}, ${P.user}.`;
 // plan
 const C=planCards();
 $("#hPlan").innerHTML=C.length?C.map((c,i)=>`<li class="plan-card${i===0?" top":""}"><span class="plan-ic" aria-hidden="true">${ic(c.i||"target")}</span><div class="plan-txt"><b>${esc(c.t)}</b><p>${esc(c.p)}</p></div><div class="plan-go">${!hide&&c.xp?`<span class="xp">${ic("zap","sm")}+${c.xp} XP</span>`:""}<button class="${i===0?"pri":""}" type="button" data-plan="${i}">${esc(c.cta||"Open")}</button></div></li>`).join("")
  :'<li class="small">Nothing urgent. Play a few games and check back.</li>';
 $("#hPlan").querySelectorAll("[data-plan]").forEach(b=>b.onclick=()=>{const c=C[+b.dataset.plan];if(c.go)location.hash=c.go.slice(1);else c.act()});
 // gamification
 $("#hGame").hidden=hide;$("#hBadgesSec").hidden=hide;
 if(!hide){$("#hRing").innerHTML=ringSVG(today,goal);
  $("#hRingTxt").innerHTML=`<h2>Daily goal</h2><ul class="goal-key"><li><span class="k" style="background:var(--q-blunder)"></span>Puzzles <b>${today.pz||0}</b></li><li><span class="k" style="background:var(--q-best)"></span>Opening positions <b>${today.op||0}</b></li><li><span class="k" style="background:var(--secondary)"></span>Games reviewed <b>${today.rv||0}</b></li><li><span class="k" style="background:var(--xp)"></span>Lesson steps <b>${today.ls||0}</b></li></ul><span class="small">A reviewed game counts 3.</span>`;
  $("#hStreak").innerHTML=`<span class="streak-ic${st.cur?" on":""}" aria-hidden="true">${ic("flame","lg")}</span><div><b class="num">${st.cur}</b> <span class="streak-l">day streak</span><span class="small">${st.fz?`${ic("snowflake","sm")} ${st.fz} freeze${st.fz>1?"s":""} ready`:"A freeze every 7 days"} · best ${Math.max(st.best,GS.rec.ls||0)}</span></div>`;
  $("#hLevel").innerHTML=`<div class="lv-row"><span class="lv-name">${ic("shield-check")}<b>${esc(lv.name)}</b></span><span class="small num">${xp} XP · ${lv.to-xp} to ${esc(lv.next)}</span></div><div class="meter"><b style="width:${Math.round((xp-lv.from)/(lv.to-lv.from)*100)}%;background:var(--xp)"></b></div>`;
  $("#hChallenge").innerHTML=`<div class="lv-row"><span class="lv-name">${ic("trophy")}<b>${esc(w.ch.t)}</b></span><span class="small num">${w.chv}/${w.ch.n} · +${WK_BONUS} XP</span></div><div class="meter"><b style="width:${Math.round(w.chv/w.ch.n*100)}%;background:var(--gold)"></b></div>`;
  $("#hBadges").innerHTML=BADGES.map(([id,nm,how])=>`<li class="badge${GS.badges[id]?"":" locked"}" title="${esc(how)}"><span class="bdg" aria-hidden="true">${ic(BICON[id]||"award")}</span><b>${esc(nm)}</b><span class="small">${GS.badges[id]?"Earned "+dkey(GS.badges[id]):esc(how)}</span></li>`).join("");
  const R=GS.rec;$("#hRecords").innerHTML=`<li>${ic("zap")}<div><b class="num">${R.bw||0}</b> XP<span class="small">best week</span></div></li><li>${ic("flame")}<div><b class="num">${Math.max(R.ls||0,st.best)}</b> days<span class="small">longest streak</span></div></li><li>${ic("shield-check")}<div><b class="num">${R.bb==null?"—":R.bb.toFixed(1)}</b><span class="small">fewest blunders + mistakes per game</span></div></li>`}
 $("#hInt").value=GS.set.int||"normal";$("#hHide").checked=!!hide;
 // since last visit
 const nw=SEEN0?GAMES.filter(g=>g.ts>SEEN0):GAMES.slice(-5),W=nw.filter(g=>g.result==="win").length,D=nw.filter(g=>g.result==="draw").length;
 $("#hSinceT").textContent=SEEN0?`Since your last visit (${dkey(SEEN0)})`:"Your latest games";
 let big=null;const rows=nw.slice().reverse().slice(0,6).map(g=>{const e=g.an?errorsOf(replay(g)).filter(x=>x.mine&&x.kind!=="inacc").sort((a,b)=>b.drop-a.drop)[0]:null;if(e&&(!big||e.drop>big.e.drop))big={g,e};
  return `<li><span class="res ${g.result}">${g.result==="win"?"W":g.result==="loss"?"L":"D"}</span> vs ${esc(g.opp)} <span class="small">${esc(famOf(g.eco))}</span><br><span class="small">${!g.an?"Not analysed yet":e?`Worst moment: ${mvLabel(e.i)} ${esc(g.moves[e.i])} (${evTxt(e.before)} → ${evTxt(e.after)})`:"No serious mistakes"}</span></li>`});
 $("#hSince").innerHTML=nw.length?`<p class="small">${nw.length} game${nw.length>1?"s":""}: ${W} won, ${D} drawn, ${nw.length-W-D} lost · ${GAMES.filter(g=>g.an).length} of ${GAMES.length} analysed${AQ?" (analysing now)":""}</p><ul class="since">${rows.join("")}</ul>`:`<p class="small">No new games yet. ${GAMES.filter(g=>g.an).length} of ${GAMES.length} games analysed.</p>`;
 $("#hSwing").hidden=!big;HSW=big;if(big){const g=big.g,e=big.e,m=g._m[e.i];HTB.flip=g.color==="b";HTB.set(g._f[e.i],{arrows:[{from:m.from,to:m.to,c:"red"}].concat(e.best?[{from:e.best.slice(0,2),to:e.best.slice(2,4),c:"green"}]:[])});
  $("#hSwingTxt").textContent=`Biggest swing: ${mvLabel(e.i)} ${g.moves[e.i]} vs ${g.opp}, ${evTxt(e.before)} → ${evTxt(e.after)}. Open it in Review.`}
 // at a glance
 const s=stats(),b=LS.get(uk("base."+P.tc),null),B=baseSecs(),arr=(v,bv,goodUp,f)=>bv==null||v==null||/^[0.]+%?$/.test(f(Math.abs(v-bv)))?"":`<span class="${(v>bv)===goodUp?"up-good":"up-bad"}">${ic(v>bv?"arrow-up":"arrow-down","sm")} ${f(Math.abs(v-bv))}</span>`;
 const tGood=b&&b.time!=null&&s.time!=null?Math.abs(s.time-B*.7)<Math.abs(b.time-B*.7):true;
 $("#hGlance").innerHTML=[["Rating",s.rating??"—",arr(s.rating,b&&b.rating,true,Math.round)],["Blunders + mistakes / game",s.errs==null?"—":s.errs.toFixed(1),arr(s.errs,b&&b.errs,false,x=>x.toFixed(1))],
  ["Median time used",mmss(s.time),b&&b.time!=null&&s.time!=null&&Math.abs(s.time-b.time)>=1?`<span class="${tGood?"up-good":"up-bad"}">${ic(s.time>b.time?"arrow-up":"arrow-down","sm")} ${mmss(Math.abs(s.time-b.time))}</span>`:""],
  ["Score, last 30",s.score==null?"—":Math.round(s.score)+"%",arr(s.score,b&&b.score,true,x=>Math.round(x)+"%")]].map(([l,v,a])=>`<div class="kpi"><b class="num">${v}</b>${l}<s>${a||"&nbsp;"}</s></div>`).join("")+
  `<p class="small" style="grid-column:1/-1">${b?`Arrows compare with your baseline from ${b.date}.`:"Arrows appear once your baseline is set (after 10 analysed games)."}</p>`;
 const ins=insights(),eff=Object.entries(LS.get(uk("opstart"),{})).map(([k,t])=>opEffect(k,t)).filter(Boolean).sort((a,b)=>(b.a-b.b)-(a.a-a.b))[0];
 $("#hInsight").innerHTML=(ins[0]?`<div class="ins ${ins[0].c}"><b>${esc(ins[0].t)}</b><p>${esc(ins[0].p)}</p></div>`:"")+(eff&&!(ins[0]&&/practising/.test(ins[0].t))?`<p class="small">Since practising the ${esc(eff.fam)}: ${Math.round(eff.a)}% (was ${Math.round(eff.b)}%).</p>`:"");
 $("#hSign").hidden=!SB_ON||!!Sync.me;
 // mini leaderboard
 $("#hLb").hidden=true;if(SB_ON&&Sync.me)(async()=>{try{const pr=await Fr.profile();if(!pr.share||tok!==HOMEtok)return;const {data,error}=await Sync.sb.rpc("friends_leaderboard",{p_tc:P.tc});if(error||tok!==HOMEtok)return;
  const wk=wkOf(dkey()),xpOf=r=>r.xp_week===wk?r.weekly_xp||0:0,rows=(data||[]).slice().sort((a,b)=>xpOf(b)-xpOf(a)),me=rows.findIndex(r=>r.is_me),top=rows.slice(0,3);if(me>2)top.push(rows[me]);
  const pass=lbPassed(data||[]);if(!rows.length)return;$("#hLb").hidden=false;
  $("#hLbBody").innerHTML=(pass.length?`<p class="verdict v-ok">${ic("party-popper")}You passed ${esc(pass.join(" and "))} this week!</p>`:"")+`<ol class="mini-lb">${top.map(r=>`<li class="${r.is_me?"me":""}"><span class="rank">${rows.indexOf(r)+1}</span><span class="who-n">${esc(r.display_name||"(no name)")}${r.is_me?" (you)":""}</span><span class="num">${ic("zap","sm")}${xpOf(r)} · ${ic("flame","sm")}${r.streak||0}</span></li>`).join("")}</ol>`}catch(e){}})()}
$("#hInt").onchange=()=>{GS.set={...GS.set,int:$("#hInt").value,at:Date.now()};const d=GS.days[dkey()];if(d&&!d.g&&dayU(d)>=gGoal())d.g=1;gSave();renderHome()};
$("#hHide").onchange=()=>{GS.set={...GS.set,hide:$("#hHide").checked,at:Date.now()};gSave();renderHome()};
$("#hSwing").onclick=()=>{if(HSW){openGame(HSW.g,HSW.e.i);location.hash="review"}};
$("#hSync").onclick=async()=>{$("#hSync").disabled=true;$("#hNote").textContent="Checking…";try{const n=await sync();$("#hNote").textContent=n?`${n} new game${n>1?"s":""} found.`:"No new games.";if(n)analyseRecent(n)}catch(e){$("#hNote").textContent=`Couldn't reach ${SRC[P.source].name}. Try again in a minute.`}$("#hSync").disabled=false;renderHome()};
$("#hAn").onclick=()=>{analyseRecent(20);$("#hNote").textContent="Analysing up to 20 more games; see the bar at the top.";renderHome()};
$("#hSwitch").onclick=()=>$("#switchBtn").click();$("#hSign").onclick=()=>acctOpen();

/* ---------- PROGRESS + rule-based insights ---------- */
function stats(){const G=GAMES,recent=G.slice(-30),an=G.filter(g=>g.an),lastAn=an.slice(-20);
 const tu=recent.map(timeUsed).filter(x=>x!=null),errs=lastAn.map(g=>serious(g).length);
 return {rating:G.length?G[G.length-1].myR:null,time:median(tu),errs:errs.length?errs.reduce((a,b)=>a+b,0)/errs.length:null,score:score(recent),nAn:an.length}}
function maybeBaseline(){if(LS.get(uk("base."+P.tc),null))return;const s=stats();if(s.nAn>=10){LS.set(uk("base."+P.tc),{...s,date:new Date().toISOString().slice(0,10)});Sync.mark("base",acct()+"|"+P.tc)}}
function insights(){const G=GAMES,yr=G.filter(g=>g.ts>Date.now()-365*864e5),an=G.filter(g=>g.an).slice(-50),out=[];const B=baseSecs();
 if(!an.length&&!yr.length)return out;
 const errs=[];an.forEach(g=>{replay(g);const all=errorsOf(g);all.filter(e=>e.mine&&e.kind!=="inacc").forEach(e=>errs.push({g,e,prev:all.find(o=>o.i===e.i-1&&!o.mine&&o.kind!=="inacc")}))});
 const tu=G.slice(-30).map(timeUsed).filter(x=>x!=null),med=median(tu);
 if(med!=null&&med<B*.5){const plenty=errs.filter(o=>o.g.clocks&&o.g.clocks[o.e.i]>B*.3).length,think=median(errs.map(o=>spent(o.g,o.e.i)).filter(x=>x!=null));
  out.push({w:10,c:"hi",t:`You use only ${mmss(med)} of your ${Math.round(B/60)} minutes`,p:`${errs.length?`${Math.round(plenty/errs.length*100)}% of your blunders and mistakes came with plenty of time left, after a median of ${think}s thought. `:""}Aim to use ${mmss(B*.7)}: spend the extra time checking your opponent's checks, captures and threats before every move.`})}
 if(errs.length>=5){const win=errs.filter(o=>o.e.before>200).length;if(win/errs.length>=.35)out.push({w:9,c:"hi",t:"You let winning positions slip",p:`${win} of your ${errs.length} blunders and mistakes in the last ${an.length} analysed games came when you were already clearly winning. When you're ahead, slow down and look for your opponent's counterplay before cashing in.`})}
 const unp=errs.filter(o=>o.prev).length;if(unp>=3)out.push({w:8,c:"hi",t:"You don't punish their blunders",p:`${unp} times your opponent blundered and your reply let them off the hook. After every opponent move, ask: what did that move leave undefended?`});
 const mates=errs.filter(o=>o.e.after<=-9000||(o.e.before>=9000&&o.e.after<9000)).length;if(mates>=2)out.push({w:7,c:"hi",t:"Mate blind spots",p:`${mates} times you allowed or missed a forced mate. Before each move, check every check available — to you and to your opponent.`});
 if(errs.length>=8){const ph={opening:0,middlegame:0,endgame:0};errs.forEach(o=>{const m=o.e.i/2+1;ph[m<=12?"opening":m<=30?"middlegame":"endgame"]++});const top=Object.entries(ph).sort((a,b)=>b[1]-a[1])[0];
  if(top[1]/errs.length>=.45)out.push({w:5,c:"",t:`Most errors happen in the ${top[0]}`,p:`${top[1]} of ${errs.length} serious errors came in the ${top[0]} (${top[0]==="opening"?"moves 1–12":top[0]==="middlegame"?"moves 13–30":"move 31 onwards"}).${top[0]==="opening"?" Learning the plans behind your two main openings will pay off quickly.":top[0]==="endgame"?" Basic king-and-pawn and rook endings are worth an hour a week.":" Tactics puzzles are the fastest fix."}`})}
 const losses=yr.filter(g=>g.result==="loss");if(losses.length>=10){const to=losses.filter(g=>g.how==="timeout").length;if(to/losses.length>=.2)out.push({w:8,c:"hi",t:"You lose on time",p:`${to} of your ${losses.length} losses in the last year were on time. Set a rough budget: about a third of your clock for the first 15 moves.`})}
 const op={};yr.forEach(g=>{const k=g.color+"|"+famOf(g.eco);(op[k]=op[k]||[]).push(g)});const ops=Object.entries(op).filter(([,a])=>a.length>=15).map(([k,a])=>({k,n:a.length,s:score(a)}));
 const worst=ops.slice().sort((a,b)=>a.s-b.s)[0],best=ops.slice().sort((a,b)=>b.s-a.s)[0];
 if(worst&&worst.s<44)out.push({w:6,c:"hi",t:`Fix your ${worst.k.split("|")[1]}`,p:`As ${worst.k[0]==="w"?"White":"Black"} it scores ${Math.round(worst.s)}% over ${worst.n} games this year. Review your losses in it, or switch to a line you understand better.`});
 if(best&&best.s>58)out.push({w:3,c:"ok",t:`Your ${best.k.split("|")[1]} works`,p:`${Math.round(best.s)}% over ${best.n} games as ${best.k[0]==="w"?"White":"Black"} this year. Keep steering towards it.`});
 const long=yr.filter(g=>g.moves.length>=120);if(long.length>=10){const d=score(yr)-score(long);if(d>=10)out.push({w:5,c:"",t:"Long games cost you",p:`You score ${Math.round(score(long))}% in games past move 60, against ${Math.round(score(yr))}% overall. Endgame technique is a cheap source of rating points.`})}
 const w=yr.filter(g=>g.color==="w"),b=yr.filter(g=>g.color==="b");if(w.length>=30&&b.length>=30){const d=score(w)-score(b);if(Math.abs(d)>=8)out.push({w:4,c:"",t:`Weaker with ${d>0?"Black":"White"}`,p:`${Math.round(score(w))}% with White vs ${Math.round(score(b))}% with Black over the last year.`})}
 const ost=LS.get(uk("opstart"),{});for(const k in ost){const e=opEffect(k,ost[k]);if(e)out.push({w:6.5,c:e.a>=e.b?"ok":"",t:`Since practising the ${e.fam} you score ${Math.round(e.a)}% (was ${Math.round(e.b)}%)`,
  p:`As ${e.col==="w"?"White":"Black"}: ${e.na} games since you started on ${e.date}, against ${e.nb} games in the year before.${e.a>=e.b?" Keep drilling it.":" Keep at it: the weak spots in the opening trainer show where the points go."}`})}
 if(!out.length&&an.length>=10)out.push({w:1,c:"ok",t:"No big leaks right now",p:"Nothing stands out across your recent games. Keep doing puzzles from your own mistakes and review every loss."});
 return out.sort((a,b)=>b.w-a.w).slice(0,5)}
function chart(el,pts,o){const draw=()=>{const W=el.clientWidth||500,H=el.clientHeight||260,pad={l:44,r:10,t:10,b:24};if(pts.length<2){el.innerHTML='<div class="empty" style="height:100%;display:grid;place-items:center">Not enough games yet</div>';return}
 const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y).concat(o.goal!=null?[o.goal]:[]),x0=Math.min(...xs),x1=Math.max(...xs),y0=o.y0!=null?o.y0:Math.min(...ys),y1=Math.max(...ys)+(o.pad||0);
 const X=x=>pad.l+(x1===x0?.5:(x-x0)/(x1-x0))*(W-pad.l-pad.r),Y=y=>pad.t+(1-(y-y0)/((y1-y0)||1))*(H-pad.t-pad.b);
 let s=`<svg viewBox="0 0 ${W} ${H}">`+[0,.5,1].map(t=>y0+t*(y1-y0)).map(t=>`<line x1="${pad.l}" x2="${W-pad.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--border)"/><text x="${pad.l-6}" y="${Y(t)+4}" text-anchor="end" font-size="12" font-weight="700" style="fill:var(--muted)" font-family="Nunito,system-ui,sans-serif">${o.fmt?o.fmt(t):Math.round(t)}</text>`).join("");
 if(o.goal!=null)s+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${Y(o.goal)}" y2="${Y(o.goal)}" stroke="var(--q-mistake)" stroke-width="2" stroke-dasharray="6 4"/>`;
 if(o.line)s+=`<path d="${pts.map((p,i)=>(i?"L":"M")+X(p.x).toFixed(1)+","+Y(p.y).toFixed(1)).join("")}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linejoin="round"/>`;
 if(o.dots)s+=pts.map(p=>`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${W<520?2.5:3.5}" fill="${p.c||"var(--text)"}" opacity=".75"/>`).join("");
 if(o.avg){const av=pts.map((p,i)=>{const w=pts.slice(Math.max(0,i-9),i+1);return {x:p.x,y:w.reduce((s,q)=>s+q.y,0)/w.length}});s+=`<path d="${av.map((p,i)=>(i?"L":"M")+X(p.x).toFixed(1)+","+Y(p.y).toFixed(1)).join("")}" fill="none" stroke="var(--secondary)" stroke-width="2.5"/>`}
 if(o.xl){const l=o.xl(x0,x1);s+=l.filter((_,i,a)=>W>=520||i===0||i===a.length-1).map(q=>`<text x="${X(q.x)}" y="${H-6}" text-anchor="middle" font-size="12" font-weight="700" style="fill:var(--muted)" font-family="Nunito,system-ui,sans-serif">${q.t}</text>`).join("")}
 el.innerHTML=s+"</svg>"};el._draw=draw;draw();if(!el._ro){el._ro=new ResizeObserver(()=>el._draw());el._ro.observe(el)}}
function timeLabels(x0,x1){const span=x1-x0,out=[];if(span>540*864e5){for(let y=new Date(x0).getFullYear()+1;y<=new Date(x1).getFullYear();y++)out.push({x:Date.UTC(y,0,1),t:y})}else{const d=new Date(x0);d.setUTCDate(1);const step=span>180*864e5?3:span>60*864e5?1:0;if(!step)return out;for(d.setUTCMonth(d.getUTCMonth()+1);d.getTime()<=x1;d.setUTCMonth(d.getUTCMonth()+step))out.push({x:d.getTime(),t:d.toLocaleString("en",{month:"short",timeZone:"UTC"})})}return out}
function renderProgress(){const G=GAMES,s=stats(),base=LS.get(uk("base."+P.tc),null),B=baseSecs(),ins=insights();
 $("#pTitle").textContent=ins.length&&ins[0].c==="hi"?ins[0].t:"Your progress";
 $("#pSub").textContent=`${G.length} ${TCL[P.tc]} games · ${s.nAn} analysed · `+(base?`compared with your baseline from ${base.date}`:"your baseline is set after 10 analysed games");
 $("#insights").innerHTML=ins.length?ins.map(i=>`<div class="ins ${i.c}"><b>${esc(i.t)}</b><p>${esc(i.p)}</p></div>`).join(""):`<div class="empty">${AQ?"Analysing your games — insights appear as results come in.":"Analyse some games to get personalised advice."}</div>`;
 const dl=(v,b,f,good)=>b==null||v==null?"":`<s>${v-b>0?"+":v-b<0?"−":"±"}${f(Math.abs(v-b))} since baseline</s>`;
 const k=(v,l,goal,extra)=>`<div class="kpi${goal?" goal":""}"><b class="num">${v}</b>${l}${extra||""}</div>`;
 $("#pKpis").innerHTML=k(s.rating??"—","current rating",0,base&&dl(s.rating,base.rating,Math.round))+k(s.score==null?"—":Math.round(s.score)+"%","score, last 30 games")+
  k(mmss(s.time),`median time used · goal ${mmss(B*.7)}`,1,base&&dl(s.time,base.time,mmss))+k(s.errs==null?"—":s.errs.toFixed(1),"blunders + mistakes per game · goal under 1",1,base&&base.errs!=null&&s.errs!=null?dl(s.errs,base.errs,x=>x.toFixed(1)):"")+
  k(PZ.filter(p=>(TS[p.id]||{}).ok).length,"puzzles solved");
 const day={};G.forEach(g=>{day[g.date]=g});const rp=Object.values(day).map(g=>({x:g.ts,y:g.myR}));chart($("#ratingFig"),rp,{line:1,xl:timeLabels});
 $("#timeGoal").textContent=`(goal: ${mmss(B*.7)} of ${Math.round(B/60)}:00)`;
 const tp=G.map(g=>({g,t:timeUsed(g)})).filter(o=>o.t!=null).slice(-60).map((o,i)=>({x:i,y:o.t,c:o.g.result==="win"?"var(--q-best)":o.g.result==="loss"?"var(--q-blunder)":"var(--muted)"}));
 chart($("#timeFig"),tp,{dots:1,avg:1,goal:B*.7,y0:0,fmt:t=>mmss(t)});
 const an=G.filter(g=>g.an).slice(-60);chart($("#errFig"),an.map((g,i)=>({x:i,y:serious(g).length})),{dots:1,avg:1,goal:1,y0:0,pad:.5});
 $("#errNote").textContent=`Your last ${an.length} analysed games. Red dashed line: goal (under 1 per game).`;
 const yr=G.filter(g=>g.ts>Date.now()-365*864e5),kinds={checkmated:"checkmate",resigned:"resignation",abandoned:"abandoned (left the game)",timeout:"on time"};
 const tbl=(a,col,lab)=>{const c={};a.forEach(g=>{const k=kinds[g.how]||"other";c[k]=(c[k]||0)+1});const rows=Object.entries(c).sort((x,y)=>y[1]-x[1]);
  return `<table style="margin-bottom:14px"><thead><tr><th>${lab} (${a.length})</th><th class="r">n</th><th></th></tr></thead><tbody>${rows.map(([k,n])=>`<tr><td>${k}</td><td class="r">${n}</td><td style="width:45%"><div class="meter"><b style="width:${n/a.length*100}%;background:${col}"></b></div></td></tr>`).join("")||'<tr><td colspan="3" class="small">None</td></tr>'}</tbody></table>`};
 $("#ends").innerHTML=tbl(yr.filter(g=>g.result==="loss"),"var(--q-blunder)","Losses")+tbl(yr.filter(g=>g.result==="win"),"var(--q-best)","Wins");
 renderOps();const un=G.filter(g=>!g.an).length;$("#anMore").disabled=!un;$("#anNote").textContent=un?`${un} games not analysed yet.`:"Every game is analysed."}
function renderOps(){const col=$("#opColor").value,m={};GAMES.filter(g=>g.color===col&&g.ts>Date.now()-365*864e5).forEach(g=>{const f=famOf(g.eco);(m[f]=m[f]||[]).push(g)});
 const rows=Object.entries(m).filter(([,a])=>a.length>=5).sort((a,b)=>b[1].length-a[1].length).slice(0,15);
 $("#opBody").innerHTML=rows.length?rows.map(([f,a])=>{const w=a.filter(g=>g.result==="win").length,d=a.filter(g=>g.result==="draw").length,l=a.length-w-d,s=score(a);
  return `<tr><td data-l="Opening">${esc(f)}</td><td class="r" data-l="Games">${a.length}</td><td class="r" data-l="Score" style="color:${s<45?"var(--q-blunder)":s>55?"var(--q-best)":"inherit"};font-weight:700">${Math.round(s)}%</td><td data-l="W / D / L"><span class="num">${w} / ${d} / ${l}</span></td><td class="r" data-l=""><button class="link" type="button" data-op="${esc(col+"|"+f)}">Practise</button></td></tr>`}).join(""):'<tr><td colspan="5" class="small">No opening with 5+ games in the last year.</td></tr>';
 $("#opBody").querySelectorAll("[data-op]").forEach(b=>b.onclick=()=>{OPSEL=b.dataset.op;LS.set(uk("opsel"),OPSEL);OD=null;location.hash="openings"})}
$("#opColor").onchange=renderOps;
$("#anMore").onclick=()=>{analyseRecent(20);$("#anNote").textContent="Queued — see progress at the top."};
$("#resetBase").onclick=()=>{const s=stats();LS.set(uk("base."+P.tc),{...s,date:new Date().toISOString().slice(0,10),manual:new Date().toISOString()});Sync.mark("base",acct()+"|"+P.tc);Fr.soon();renderProgress()};
$("#syncBtn").onclick=async()=>{$("#syncBtn").disabled=true;try{const n=await sync();$("#anNote").textContent=n?`${n} new game${n>1?"s":""} found.`:"No new games.";if(n)analyseRecent(n)}catch(e){$("#anNote").textContent=`Couldn't reach ${SRC[P.source].name}. Try again in a minute.`}$("#syncBtn").disabled=false;renderProgress()};

/* ---------- onboarding ---------- */
const HB=new Board($("#heroBoard"),{label:"Example position"}),HW=new Why($("#heroWhy"),HB),DEMO_FEN="rn1qkbnr/pp2pppp/2p5/5b2/3PN3/8/PPP2PPP/R1BQKBNR w KQkq - 1 5";
const demoLine=(fen,sans)=>{const c=new Chess(fen),L=[];for(const s of sans){const m=c.move(s);if(!m)break;L.push({san:m.san,from:m.from,to:m.to,cap:!!m.captured,fen:c.fen()})}return {fen,L}};
let demoT=null,demoK=0,demoOff=false;
function demoStart(){if(!HW.lines){HW.render("After Nd6+, Black plays Qxd6 and you've lost a knight. Ng3 is better: the evaluation stays +0.3.",
 [{title:"Your move",c:"red",x:demoLine(DEMO_FEN,["Nd6+","Qxd6","Qf3","Qd7"]),lab:{t:"loses a knight"}},{title:"Better",c:"green",x:demoLine(DEMO_FEN,["Ng3","Bg6","Nf3","e6","h4","h6","h5","Bh7"]),lab:null}]);
 HW.o={restore:()=>HB.set(DEMO_FEN)};HB.set(DEMO_FEN);$("#heroWhy").addEventListener("click",()=>{demoOff=true;demoStop()},{once:true})}   // any click there hands control to the visitor
 if(demoT||demoOff||matchMedia("(prefers-reduced-motion: reduce)").matches)return;
 demoT=setInterval(()=>{const seq=[[0,1],[0,2],[0,0],[1,1],[1,2],[1,3],[1,4],[1,5],[1,6],[1,0]],[i,k]=seq[demoK++%seq.length];if(k)HW.step(i,k);else HW.reset()},1600)}
function demoStop(){clearInterval(demoT);demoT=null}
function inviteBanner(on){$("#inviteBanner").hidden=!on}
$("#invSign").onclick=()=>acctOpen();
const srcPick=()=>(document.querySelector('input[name="uSrc"]:checked')||{}).value||"cc";
function srcLabel(){const s=srcPick();$("#uNameLbl").textContent=SRC[s].name+" username";$("#uName").placeholder=s==="li"?"e.g. thibault":"e.g. magnuscarlsen"}
document.querySelectorAll('input[name="uSrc"]').forEach(r=>r.onchange=()=>{srcLabel();LS.set("lastSrc",srcPick())});
$("#startForm").onsubmit=async e=>{e.preventDefault();const u=$("#uName").value.trim().toLowerCase(),tc=$("#uTc").value,s=srcPick(),nm=SRC[s].name;if(!u)return;
 $("#startBtn").disabled=true;$("#startMsg").textContent=`Looking you up on ${nm}…`;
 try{const p=s==="li"?await api(`${LI}/api/user/${encodeURIComponent(u)}`,liOpts()):await api(`https://api.chess.com/pub/player/${encodeURIComponent(u)}`);if(p&&p.disabled)throw new Error("notfound")}
 catch(x){$("#startMsg").textContent=x.message==="notfound"?`No ${nm} player called “${u}”.`:`Couldn't reach ${nm}. Check your connection and try again.`;$("#startBtn").disabled=false;return}
 P={source:s,user:u,tc};LS.set("profile",P);await enter(true)};
$("#switchBtn").onclick=()=>{GEN++;Engine.q.length=0;LS.set("profile",null);P=null;location.hash="";boot()};

/* ---------- account + sync (optional; Supabase) ----------
   Off unless config.js has a URL and key. The browser stays the source of truth: changes are saved
   locally first, queued in an outbox (rc.sb.out) and uploaded in the background; pulls fetch only rows
   changed since the last pull. Games are never uploaded, only analyses, puzzle progress, baselines and
   which accounts are reviewed. supabase-js is loaded only for people who sign in. */
const CFG=window.RC_CONFIG||{},SB_ON=!!(CFG.supabaseUrl&&CFG.supabaseKey);
const ACCT_RE=/^(cc|li):[a-z0-9_-]{1,40}$/,TCS=["600","rapid","blitz","bullet"];
const Sync={sb:null,me:null,_load:null,_t:null,busy:false,pulled:0,err:"",
 load(){return this._load||(this._load=new Promise((res,rej)=>{const s=document.createElement("script");s.src="vendor/supabase-2.118.0.js";
  s.onload=()=>{this.sb=supabase.createClient(CFG.supabaseUrl,CFG.supabaseKey,{auth:{flowType:"pkce",persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
   this.sb.auth.onAuthStateChange((ev,ses)=>setTimeout(()=>this.onAuth(ses),0));res(this.sb)};
  s.onerror=()=>{this._load=null;rej(new Error("load"))};document.head.appendChild(s)}))},
 hasSession(){try{const ref=new URL(CFG.supabaseUrl).hostname.split(".")[0];return !!localStorage.getItem("sb-"+ref+"-auth-token")}catch(e){return false}},
 async start(){if(!SB_ON)return;document.querySelectorAll(".acct-only").forEach(e=>e.hidden=false);const q=new URLSearchParams(location.search);
  if(q.has("invite")){LS.set("invite",q.get("invite").toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,40));history.replaceState(null,"",location.pathname+location.hash);
   if(!this.hasSession()){if(P){acctOpen();acctMsg("A friend invited you. Sign in to accept, then you can compare your games.")}else inviteBanner(true)}}
  if(q.has("error_description")){acctOpen();acctMsg(q.get("error_description")+" Ask for a new link, or enter the code from the email.");}
  if(!q.has("code")&&!this.hasSession()){if(q.has("error_description"))history.replaceState(null,"",location.pathname+location.hash);return}
  try{await this.load();const {error}=await this.sb.auth.initialize();
   if(error&&q.has("code")){acctOpen();acctMsg("That link didn't work here, usually because it was opened in a different browser. Enter the code from the email instead, or ask for a new link.")}}
  catch(e){acctMsg("Couldn't reach the sync service. Your data is still saved in this browser.")}
  if(q.has("code")||q.has("error_description"))history.replaceState(null,"",location.pathname+location.hash);
  document.addEventListener("visibilitychange",()=>{if(!this.me)return;if(document.hidden)this.flush();else if(Date.now()-this.pulled>5*60e3)this.run()})},
 onAuth(ses){const u=ses&&ses.user;
  if(u&&(!this.me||this.me.id!==u.id)){this.me={id:u.id,email:u.email};Fr.prof=null;acctUI();this.run();Fr.onSignIn()}
  else if(!u&&this.me){this.me=null;Fr.prof=null;acctUI();if(route.cur==="friends")Fr.render()}},
 /* outbox: {an:{gameId:1}, pz:{"acct|puzzleId":1}, base:{"acct|tc":1}, la:{"acct|tc":1}, op:{"acct|posKey":1}, ops:{"acct|w|<family>":1}, gm:{acct:1}, ls:{"acct|item":1}} */
 mark(kind,key){if(!SB_ON)return;const o=LS.get("sb.out",{});(o[kind]=o[kind]||{})[key]=1;LS.set("sb.out",o);if(this.me){clearTimeout(this._t);this._t=setTimeout(()=>this.flush(),2000)}},
 async run(){if(!this.me||this.busy)return;this.busy=true;this.err="";acctUI();
  try{await this.pull();const k="sb.init."+this.me.id;if(!LS.get(k,0)){this.markAll();LS.set(k,1)}this.busy=false;await this.flush()}
  catch(e){this.err="Sync failed. It will retry later; nothing is lost.";this.busy=false}acctUI()},
 markAll(){ALL.forEach(g=>{if(g.an)this.mark("an",g.id)});
  for(const k of Object.keys(localStorage)){let m=k.match(/^rc\.((?:cc|li):[^.]+)\.trainer$/);if(m)Object.keys(LS.get(m[1]+".trainer",{})).forEach(id=>this.mark("pz",m[1]+"|"+id));
   m=k.match(/^rc\.((?:cc|li):[^.]+)\.base\.(\w+)$/);if(m)this.mark("base",m[1]+"|"+m[2]);
   m=k.match(/^rc\.((?:cc|li):[^.]+)\.openings$/);if(m)Object.keys(LS.get(m[1]+".openings",{})).forEach(p=>this.mark("op",m[1]+"|"+p));
   m=k.match(/^rc\.((?:cc|li):[^.]+)\.game$/);if(m)this.mark("gm",m[1]);
   m=k.match(/^rc\.((?:cc|li):[^.]+)\.lessons$/);if(m)Object.keys(LS.get(m[1]+".lessons",{})).forEach(it=>this.mark("ls",m[1]+"|"+it));
   m=k.match(/^rc\.((?:cc|li):[^.]+)\.opstart$/);if(m)Object.keys(LS.get(m[1]+".opstart",{})).forEach(o=>this.mark("ops",m[1]+"|"+o))}
  if(P)this.mark("la",acct()+"|"+P.tc)},
 async flush(){if(!this.me)return;if(this.busy){clearTimeout(this._t);this._t=setTimeout(()=>this.flush(),5000);return}const o=LS.get("sb.out",{});if(!Object.keys(o).some(k=>Object.keys(o[k]).length))return;
  this.busy=true;LS.set("sb.out",{});const uid=this.me.id,ok=a=>ACCT_RE.test(a),keys=k=>Object.keys(o[k]||{}),sp=x=>{const i=x.indexOf("|");return [x.slice(0,i),x.slice(i+1)]};
  const byId=new Map(ALL.map(g=>[g.id,g])),clamp=v=>Math.max(-32000,Math.min(32000,Math.round(v||0)));
  const rows={
   analyses:keys("an").map(id=>byId.get(id)).filter(g=>g&&g.an).map(g=>({user_id:uid,game_id:g.id,depth:g.an.depth,ev:g.an.ev.map(clamp),best:g.an.best})),
   puzzle_progress:keys("pz").map(sp).filter(([a])=>ok(a)).map(([a,id])=>{const st=LS.get(a+".trainer",{})[id]||{};return {user_id:uid,account:a,puzzle_id:id,seen:!!st.seen,ok:!!st.ok,fail:st.fail||0}}),
   baselines:keys("base").map(sp).filter(([a,tc])=>ok(a)&&TCS.includes(tc)).map(([a,tc])=>({a,tc,b:LS.get(a+".base."+tc,null)})).filter(x=>x.b).map(x=>({user_id:uid,account:x.a,tc:x.tc,stats:x.b})),
   linked_accounts:keys("la").map(sp).filter(([a,tc])=>ok(a)&&TCS.includes(tc)).map(([a,tc])=>({user_id:uid,account:a,tc})),
   opening_progress:keys("op").map(sp).filter(([a])=>ok(a)).map(([a,pos])=>({a,pos,x:LS.get(a+".openings",{})[pos]})).filter(r=>r.x).map(({a,pos,x})=>({user_id:uid,account:a,pos,streak:x.s||0,due:x.due?new Date(x.due).toISOString():null,correct:x.ok||0,misses:x.miss||0,pinned:x.pin||null,changed_at:x.at||0})),
   gamification:keys("gm").filter(ok).map(a=>({a,g:LS.get(a+".game",null)})).filter(r=>r.g).map(({a,g})=>({user_id:uid,account:a,days:g.days||{},badges:g.badges||{},records:g.rec||{},settings:g.set||{},reviewed:g.rev||{},changed_at:g.at||0})),
   lesson_progress:keys("ls").map(sp).filter(([a])=>ok(a)).map(([a,it])=>({a,it,x:LS.get(a+".lessons",{})[it]})).filter(r=>r.x).map(({a,it,x})=>({user_id:uid,account:a,item:it,steps:Math.min(200,x.s||0),done_at:x.d?new Date(x.d).toISOString():null,passed_at:x.p?new Date(x.p).toISOString():null,val:x.v||null,changed_at:x.at||0})),
   opening_practice:keys("ops").map(sp).filter(([a])=>ok(a)).map(([a,o])=>({a,o,t:LS.get(a+".opstart",{})[o]})).filter(r=>r.t).map(({a,o,t})=>({user_id:uid,account:a,opening:o,started_at:new Date(t).toISOString()}))};
  const pk={analyses:"user_id,game_id",puzzle_progress:"user_id,account,puzzle_id",baselines:"user_id,account,tc",linked_accounts:"user_id,account,tc",opening_progress:"user_id,account,pos",opening_practice:"user_id,account,opening",gamification:"user_id,account",lesson_progress:"user_id,account,item"};
  // table by table: a failing table keeps only its own changes queued
  const kind={analyses:"an",puzzle_progress:"pz",baselines:"base",linked_accounts:"la",opening_progress:"op",opening_practice:"ops",gamification:"gm",lesson_progress:"ls"},bad=[];
  for(const t in rows){try{for(let i=0;i<rows[t].length;i+=200){const {error}=await this.sb.from(t).upsert(rows[t].slice(i,i+200),{onConflict:pk[t]});if(error)throw error}}catch(e){bad.push(kind[t])}}
  if(bad.length){const n=LS.get("sb.out",{});for(const k of bad)if(o[k])n[k]={...o[k],...(n[k]||{})};LS.set("sb.out",n);this.err="Couldn't upload some changes. Retrying in a minute.";clearTimeout(this._t);this._t=setTimeout(()=>this.flush(),60e3)}else this.err="";
  this.busy=false;acctUI()},
 async rows(t,cols,since){const out=[];for(let i=0;;i+=1000){let q=this.sb.from(t).select(cols+",updated_at").order("updated_at").range(i,i+999);if(since)q=q.gt("updated_at",since);
  const {data,error}=await q;if(error)throw error;out.push(...data);if(data.length<1000)return out}},
 async pull(){const wk="sb.pull."+this.me.id,w=LS.get(wk,{}),hi=(r,k)=>{r.forEach(x=>{if(!w[k]||x.updated_at>w[k])w[k]=x.updated_at})};
  // analyses: attach to games we have; keep the rest until those games are fetched
  const an=await this.rows("analyses","game_id,depth,ev,best",w.an),byId=new Map(ALL.map(g=>[g.id,g])),got=[],pend=[];
  for(const r of an){const a={ev:r.ev,best:r.best,depth:r.depth},g=byId.get(r.game_id);if(g){if(!g.an||g.an.depth<a.depth){g.an=a;got.push(g)}}else{PEND.set(r.game_id,a);pend.push({id:r.game_id,an:a})}}
  DB.put(got);DB.pendPut(pend);hi(an,"an");
  // puzzle progress: seen/ok are OR-ed, fail takes the larger count
  const pz=await this.rows("puzzle_progress","account,puzzle_id,seen,ok,fail",w.pz),tr={};
  for(const r of pz){const t=tr[r.account]||(tr[r.account]=LS.get(r.account+".trainer",{})),c=t[r.puzzle_id]||(t[r.puzzle_id]={});if(r.seen)c.seen=1;if(r.ok)c.ok=1;if(r.fail>(c.fail||0))c.fail=r.fail}
  for(const a in tr)LS.set(a+".trainer",tr[a]);if(P&&tr[acct()])TS=tr[acct()];hi(pz,"pz");
  // baselines: a manual reset beats an automatic one (latest reset wins); otherwise the earlier date wins
  const bs=await this.rows("baselines","account,tc,stats",w.base);
  for(const r of bs){const k=r.account+".base."+r.tc,l=LS.get(k,null),rm=r.stats;let use=rm;
   if(l){if(l.manual||rm.manual)use=(l.manual||"")>=(rm.manual||"")?l:rm;else use=(l.date||"")<=(rm.date||"")?l:rm}
   if(use===rm)LS.set(k,rm);else this.mark("base",r.account+"|"+r.tc)}
  hi(bs,"base");
  // opening progress: the most recent change wins (changed_at, device time); practice start: the earliest wins
  const op=await this.rows("opening_progress","account,pos,streak,due,correct,misses,pinned,changed_at",w.op),om={};
  for(const r of op){const m=om[r.account]||(om[r.account]=LS.get(r.account+".openings",{})),l=m[r.pos],at=+r.changed_at||0;
   if(!l||(l.at||0)<at){m[r.pos]={s:r.streak,due:r.due?Date.parse(r.due):0,ok:r.correct,miss:r.misses,at};if(r.pinned)m[r.pos].pin=r.pinned}else if((l.at||0)>at)this.mark("op",r.account+"|"+r.pos)}
  for(const a in om)LS.set(a+".openings",om[a]);hi(op,"op");
  const opr=await this.rows("opening_practice","account,opening,started_at",w.ops),os={};
  for(const r of opr){const m=os[r.account]||(os[r.account]=LS.get(r.account+".opstart",{})),t=Date.parse(r.started_at);if(!m[r.opening]||t<m[r.opening])m[r.opening]=t;else if(m[r.opening]<t)this.mark("ops",r.account+"|"+r.opening)}
  for(const a in os)LS.set(a+".opstart",os[a]);hi(opr,"ops");if(P)OPS=LS.get(uk("openings"),{});
  // gamification: merge per field (see gMerge); push back if this device had something the server lacked
  const gm=await this.rows("gamification","account,days,badges,records,settings,reviewed,changed_at",w.gm);
  const gk=g=>JSON.stringify([g.days,g.badges,g.rec,g.rev]);
  for(const r of gm){const l=LS.get(r.account+".game",null),rem={days:r.days,badges:r.badges,rec:r.records,set:r.settings,rev:r.reviewed,at:+r.changed_at||0},m=gMerge(l||gNew(),rem);
   LS.set(r.account+".game",m);if(gk(m)!==gk(gMerge(gNew(),rem)))this.mark("gm",r.account)}
  hi(gm,"gm");if(P&&gm.length){gLoad();gCheck()}
  // lessons: steps max, completed/passed earliest, level newest
  const lr=await this.rows("lesson_progress","account,item,steps,done_at,passed_at,val,changed_at",w.ls),lm={},mn=(a,b)=>a&&b?Math.min(a,b):a||b;
  for(const r of lr){const m=lm[r.account]||(lm[r.account]=LS.get(r.account+".lessons",{})),l=m[r.item]||{},at=+r.changed_at||0,rd=r.done_at?Date.parse(r.done_at):0,rp=r.passed_at?Date.parse(r.passed_at):0;
   const n={s:Math.max(l.s||0,r.steps||0),at:Math.max(l.at||0,at)};const d=mn(l.d,rd),p=mn(l.p,rp);if(d)n.d=d;if(p)n.p=p;if(l.t)n.t=l.t;const v=(l.at||0)>=at?l.v||r.val:r.val||l.v;if(v)n.v=v;
   if((l.s||0)>(r.steps||0)||(l.d&&!rd)||(l.p&&!rp)||(l.v&&(l.at||0)>at))this.mark("ls",r.account+"|"+r.item);m[r.item]=n}
  for(const a in lm)LS.set(a+".lessons",lm[a]);hi(lr,"ls");if(P&&lr.length)LSP=LS.get(uk("lessons"),{});
  // linked accounts: on a device with no profile yet, open the most recently used one
  const la=await this.rows("linked_accounts","account,tc",w.la);hi(la,"la");LS.set(wk,w);this.pulled=Date.now();
  if(P){refreshGames();if(CUR&&CUR.an){renderMoves();renderKM();renderAnState();show()}if(route.cur==="progress")renderProgress();if(route.cur==="trainer")renderTStats();if(route.cur==="home")renderHome();Fr.soon()}
  else if(la.length){const r=la[la.length-1],i=r.account.indexOf(":");P={source:r.account.slice(0,i),user:r.account.slice(i+1),tc:r.tc};LS.set("profile",P);enter(false)}},
 async exportAll(){const out={exported:new Date().toISOString(),account:this.me.email};for(const t of ["linked_accounts","analyses","puzzle_progress","baselines","opening_progress","opening_practice","gamification","lesson_progress","profiles","leaderboard_stats"])out[t]=await this.rows(t,"*");
  const f=await this.sb.rpc("my_friends");if(f.error)throw f.error;out.friends=f.data;return out},
 async signOut(){try{await this.sb.auth.signOut({scope:"local"})}catch(e){}this.me=null;Fr.prof=null;LS.set("sb.out",{});acctUI();if(route.cur==="friends")Fr.render()},
 async deleteAccount(){const {error}=await this.sb.rpc("delete_my_account");if(error)throw error;const id=this.me.id;await this.signOut();try{localStorage.removeItem("rc.sb.init."+id);localStorage.removeItem("rc.sb.pull."+id)}catch(e){}}};

/* account panel */
let acctEmail="",acctDel=false;
function acctMsg(t){$("#acctMsg").textContent=t||""}
function acctOpen(){acctDel=false;acctUI();const d=$("#acct");if(!d.open)d.showModal()}
function acctUI(){if(!SB_ON)return;const me=Sync.me,step=me?"in":acctEmail?"code":"email";
 document.querySelectorAll("[data-acct]").forEach(e=>e.hidden=e.dataset.acct!==step);
 document.querySelectorAll(".acctBtn").forEach(b=>{const l=b.querySelector(".lbl");if(l)l.textContent=me?"Account":"Sign in to sync";else b.textContent=me?"Account":"Sign in to sync"});
 if(acctEmail)$("#acctSent").textContent=acctEmail;
 if(me){$("#acctWho").textContent=me.email;const o=LS.get("sb.out",{}),n=Object.values(o).reduce((a,x)=>a+Object.keys(x).length,0);
  $("#acctState").textContent=Sync.err||(Sync.busy?"Syncing…":n?`${n} change${n>1?"s":""} waiting to upload.`:Sync.pulled?"Everything is synced.":"");
  $("#acctDelete").textContent=acctDel?"Yes, delete my account and synced data":"Delete account";$("#acctDelNote").hidden=!acctDel}}
document.querySelectorAll(".acctBtn").forEach(b=>b.onclick=acctOpen);
$("#acctClose").onclick=()=>$("#acct").close();
$("#acctEmailForm").onsubmit=async e=>{e.preventDefault();const em=$("#acctEmail").value.trim();if(!em)return;$("#acctSend").disabled=true;acctMsg("Sending…");
 try{await Sync.load();const {error}=await Sync.sb.auth.signInWithOtp({email:em,options:{emailRedirectTo:location.origin+location.pathname,shouldCreateUser:true}});if(error)throw error;
  acctEmail=em;acctMsg("");acctUI();$("#acctCode").focus()}
 catch(x){acctMsg(x&&x.message&&x.message!=="load"?x.message:"Couldn't send the email. Check your connection and try again.")}$("#acctSend").disabled=false};
$("#acctCodeForm").onsubmit=async e=>{e.preventDefault();const code=$("#acctCode").value.replace(/\D/g,"");if(code.length<6)return acctMsg("Enter the code from the email.");
 $("#acctVerify").disabled=true;acctMsg("Checking…");
 try{const {data,error}=await Sync.sb.auth.verifyOtp({email:acctEmail,token:code,type:"email"});if(error)throw error;acctEmail="";acctMsg("");Sync.onAuth(data.session)}
 catch(x){acctMsg("That code didn't work. It may have expired: ask for a new email.")}$("#acctVerify").disabled=false};
$("#acctBack").onclick=()=>{acctEmail="";acctMsg("");acctUI()};
$("#acctOut").onclick=async()=>{await Sync.signOut();acctMsg("Signed out. Your data stays in this browser.")};
$("#acctExport").onclick=async()=>{acctMsg("Preparing your data…");try{const d=await Sync.exportAll(),a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(d,null,1)],{type:"application/json"}));
 a.download="rapid-coach-data.json";document.body.appendChild(a);a.click();a.remove();acctMsg("")}catch(x){acctMsg("Couldn't download your data. Try again in a minute.")}};
$("#acctDelete").onclick=async()=>{if(!acctDel){acctDel=true;acctUI();return}acctMsg("Deleting…");
 try{await Sync.deleteAccount();acctDel=false;acctMsg("Your account and its synced data are deleted. Data in this browser is kept.")}catch(x){acctMsg("Couldn't delete the account. Try again in a minute.")}};

/* ---------- friends + leaderboard (optional; needs an account) ----------
   Stats are worked out here from the current account's games and uploaded (only while sharing is on,
   at most every 20 s). Friends' rows come from friends_leaderboard(); see supabase/migrations/002_friends.sql. */
const Fr={prof:null,_t:null,
 err(e){const m=(e&&e.message)||"";return /invite not found/.test(m)?"That invite link doesn't work any more. Ask your friend for a new one.":/own invite/.test(m)?"That's your own invite link. Send it to a friend instead.":"Couldn't reach the server. Try again in a minute."},
 msg(t){$("#fMsg").textContent=t||""},
 async profile(){if(this.prof)return this.prof;const sb=Sync.sb,cols="display_name,share,invite_code";let {data,error}=await sb.from("profiles").select(cols).maybeSingle();if(error)throw error;
  if(!data){const r=await sb.from("profiles").insert({share:false}).select(cols).single();if(r.error)throw r.error;data=r.data}return this.prof=data},
 async onSignIn(){try{await this.profile();const code=LS.get("invite",null);if(code){LS.set("invite",null);await this.accept(code)}this.soon(1000)}catch(e){}if(route.cur==="friends")this.render()},
 async accept(code){let t;try{const {data,error}=await Sync.sb.rpc("add_friend",{code});if(error)throw error;t=`You and ${data||"your friend"} are now friends.`}catch(e){t=this.err(e)}
  if($("#acct").open)$("#acct").close();inviteBanner(false);if(P){if(location.hash!=="#friends")location.hash="friends";this.msg(t)}else $("#startMsg").textContent=t+" Enter your username to start."},
 soon(ms){if(!SB_ON)return;clearTimeout(this._t);this._t=setTimeout(()=>this.publish(),ms==null?20000:ms)},
 row(){const an=GAMES.filter(g=>g.an),last=an.slice(-20),n=last.length,r=x=>x==null?null:Math.round(x);let bl=0,mi=0;
  last.forEach(g=>errorsOf(g).forEach(e=>{if(e.mine){if(e.kind==="blunder")bl++;else if(e.kind==="mistake")mi++}}));
  const s=stats(),b=LS.get(uk("base."+P.tc),null);
  return {user_id:Sync.me.id,account:acct(),tc:P.tc,games_analysed:an.length,blunders_per_game:n?bl/n:null,mistakes_per_game:n?mi/n:null,median_time_used:r(s.time),
   puzzles_solved:PZ.filter(p=>(TS[p.id]||{}).ok).length,openings_learned:opLearned(),lessons_completed:lsCount(),...gRow(),rating_now:r(s.rating),rating_base:b?r(b.rating):null,base_date:b?b.date:null}},
 async publish(){if(!Sync.me||!P||!GAMES.length||!ACCT_RE.test(acct()))return;
  try{const pr=await this.profile();if(!pr.share)return;const {error}=await Sync.sb.from("leaderboard_stats").upsert(this.row(),{onConflict:"user_id,account,tc"});if(error)throw error;
   if(route.cur==="friends")await this.board()}catch(e){this.soon(120000)}},
 async render(){const on=!!Sync.me;$("#fOut").hidden=on;$("#fIn").hidden=!on;if(!on)return;
  try{const pr=await this.profile();$("#fName").value=pr.display_name||"";$("#fShare").checked=pr.share;$("#fLink").value=location.origin+location.pathname+"?invite="+pr.invite_code;
   await this.board();await this.friends()}catch(e){this.msg(this.err(e))}},
 async board(){$("#fBoardTitle").textContent="Leaderboard · "+TCL[P.tc];const {data,error}=await Sync.sb.rpc("friends_leaderboard",{p_tc:P.tc});if(error)throw error;
  const few=r=>r.games_analysed<10,num=(v,d)=>v==null?"–":v.toFixed(d),bpg=r=>r.blunders_per_game==null?99:r.blunders_per_game;
  const rows=(data||[]).slice().sort((a,b)=>(few(a)-few(b))||(bpg(a)-bpg(b))),pass=lbPassed(data||[]);if(pass.length)this.msg(`You passed ${pass.join(" and ")} this week!`);
  $("#fBody").innerHTML=rows.length?rows.map(r=>{const d=r.rating_now!=null&&r.rating_base!=null?r.rating_now-r.rating_base:null;
   return `<tr class="${r.is_me?"me":""}"><td>${esc(r.display_name||"(no name)")}${r.is_me?" (you)":""}<span class="src">${esc((SRC[r.source]||{}).name||"")}</span></td>`+
    `<td class="r">${few(r)?"–":num(r.blunders_per_game,2)}</td><td class="r">${few(r)?"–":num(r.mistakes_per_game,2)}</td><td class="r">${mmss(r.median_time_used)}</td>`+
    `<td class="r">${r.puzzles_solved}</td><td class="r">${d==null?"–":(d>0?"+":d<0?"−":"±")+Math.abs(d)}${r.base_date?` <span class="small">since ${esc(r.base_date)}</span>`:""}</td><td class="r">${r.openings_learned||0}</td><td class="r">${r.lessons_completed||0}</td><td class="r">${r.xp_week===wkOf(dkey())?r.weekly_xp||0:0}</td><td class="r">${r.streak||0}</td><td class="r">${r.games_analysed}</td></tr>`}).join("")
   :`<tr><td colspan="11" class="small">No ${esc(TCL[P.tc])} stats shared yet. Switch on sharing below and send your invite link to friends.</td></tr>`},
 async friends(){const {data,error}=await Sync.sb.rpc("my_friends");if(error)throw error;const L=$("#fList");
  L.innerHTML=(data||[]).length?data.map(f=>`<li><span>${esc(f.display_name||"(no name yet)")}${f.sharing?"":'<span class="small">not sharing</span>'}</span><button class="link" type="button" data-rm="${esc(f.friend_id)}">Remove</button></li>`).join("")
   :'<li class="small">No friends yet. Send them your invite link.</li>';
  L.querySelectorAll("[data-rm]").forEach(b=>b.onclick=async()=>{if(b.dataset.ok!=="1"){b.dataset.ok="1";b.textContent="Click again to remove";return}
   const id=b.dataset.rm,me=Sync.me.id,[a,c]=me<id?[me,id]:[id,me],{error}=await Sync.sb.from("friendships").delete().eq("user_a",a).eq("user_b",c);
   this.msg(error?this.err(error):"Friend removed.");await this.render()})}};
$("#fShareForm").onsubmit=async e=>{e.preventDefault();const name=$("#fName").value.trim(),share=$("#fShare").checked;
 if(share&&!name)return Fr.msg("Add a name so your friends know it's you.");$("#fSave").disabled=true;
 try{const {error}=await Sync.sb.from("profiles").update({display_name:name||null,share}).eq("user_id",Sync.me.id);if(error)throw error;Fr.prof=null;
  Fr.msg(share?"Saved. Your stats are shared with your friends.":"Saved. Your stats aren't shared.");if(share)await Fr.publish();await Fr.render()}
 catch(x){Fr.msg(Fr.err(x))}$("#fSave").disabled=false};
$("#fCopy").onclick=()=>{const v=$("#fLink").value,done=()=>Fr.msg("Link copied.");try{navigator.clipboard.writeText(v).then(done,()=>{$("#fLink").select();document.execCommand("copy");done()})}catch(e){$("#fLink").select()}};
$("#fNewLink").onclick=async()=>{try{const {data,error}=await Sync.sb.rpc("new_invite_code");if(error)throw error;Fr.prof.invite_code=data;$("#fLink").value=location.origin+location.pathname+"?invite="+data;Fr.msg("New link made. The old one no longer works.")}catch(e){Fr.msg(Fr.err(e))}};

/* ---------- settings dialog (display settings are local to this browser) ---------- */
function setOpen(){const d=$("#settings");document.querySelectorAll('[name="sTheme"]').forEach(r=>r.checked=r.value===UI.theme);document.querySelectorAll('[name="sBoard"]').forEach(r=>r.checked=r.value===UI.board);
 document.querySelectorAll('[name="sPieces"]').forEach(r=>r.checked=r.value===UI.pieces);$("#sSound").checked=!!UI.sound;$("#sHideRow").hidden=!GS;if(GS)$("#sHide").checked=!!GS.set.hide;if(!d.open)d.showModal()}
const setSave=()=>{LS.set("ui",UI);applyUI()};
document.querySelectorAll('[name="sTheme"]').forEach(r=>r.onchange=()=>{UI.theme=r.value;setSave()});
document.querySelectorAll('[name="sBoard"]').forEach(r=>r.onchange=()=>{UI.board=r.value;setSave()});
document.querySelectorAll('[name="sPieces"]').forEach(r=>r.onchange=()=>{UI.pieces=r.value;setSave()});
$("#sSound").onchange=()=>{UI.sound=$("#sSound").checked;setSave();if(UI.sound)Snd.play("correct")};
$("#sHide").onchange=()=>{if(!GS)return;GS.set={...GS.set,hide:$("#sHide").checked,at:Date.now()};gSave();if(route.cur==="home")renderHome()};
$("#setBtn").onclick=setOpen;$("#setClose").onclick=()=>$("#settings").close();
applyUI();

/* ---------- routing ---------- */
function route(){if(!P){show1("start");return}const t=["home","review","trainer","lessons","progress","openings"].concat(SB_ON?["friends"]:[]).includes(location.hash.slice(1))?location.hash.slice(1):"home";route.cur=t;show1(t);
 document.querySelectorAll("nav a").forEach(a=>{if(a.dataset.t===t)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current")});
 if(t==="progress")renderProgress();if(t==="trainer"){renderTStats();if(!PI)loadPuzzle(pickPuzzle())}if(t==="review"&&CUR)show();if(t==="friends")Fr.render();if(t==="openings")renderOpenings();if(t==="home")renderHome();if(t==="lessons"&&!LP)renderLessons()}
function show1(t){document.querySelectorAll("main>section").forEach(s=>s.hidden=s.id!=="v-"+t);$("#hdr").hidden=t==="start";document.body.classList.toggle("has-side",t!=="start");if(t==="start")demoStart();else demoStop()}
window.addEventListener("hashchange",route);

/* ---------- boot ---------- */
async function enter(fresh){GEN++;CUR=null;PI=null;TS=LS.get(uk("trainer"),{});OPS=LS.get(uk("openings"),{});OPSEL=LS.get(uk("opsel"),null);OT=null;OD=null;LSP=LS.get(uk("lessons"),{});PZS=LS.get(uk("pzs"),{});LP=null;gLoad();SEEN0=LS.get(uk("seen"),null);LS.set(uk("seen"),Date.now());Sync.mark("la",acct()+"|"+P.tc);$("#whoName").textContent=P.user+" · "+SRC[P.source].name+" · "+TCL[P.tc];refreshGames();gCheck();
 if(GAMES.length){openDefault();route()}
 const first=()=>{if(!CUR&&GAMES.length){openDefault();if(fresh)location.hash="review";route()}};
 try{const n=await sync(first);if(!GAMES.length){$("#startMsg").textContent=`No ${TCL[P.tc]} games found for ${P.user} on ${SRC[P.source].name}. Try another time control.`;$("#startBtn").disabled=false;LS.set("profile",null);P=null;route();return}
  first();analyseRecent(fresh?20:Math.max(n,0)?Math.min(n,20):0)}
 catch(e){if(fresh&&!GAMES.length){$("#startMsg").textContent=`Couldn't load your games from ${SRC[P.source].name}. Try again in a minute.`;$("#startBtn").disabled=false;P=null;LS.set("profile",null);route()}else job("sync",null)}
 if(!fresh&&!AQ)analyseRecent(5);if(!AQ)TG.run()}
async function boot(){const ls=document.querySelector(`input[name="uSrc"][value="${LS.get("lastSrc","cc")}"]`);if(ls)ls.checked=true;srcLabel();$("#startBtn").disabled=false;$("#startMsg").textContent="";if(!P){route();$("#uName").focus();return}await enter(false)}
(async()=>{await DB.open();ALL=await DB.all();(await DB.pend()).forEach(x=>PEND.set(x.id,x.an));await LiAuth.callback();Sync.start();boot()})();
}
