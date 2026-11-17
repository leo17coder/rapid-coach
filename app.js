/* Kibitz — free chess coach for chess.com and Lichess games. GPL-3.0. */
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
 buildPuzzles();if(route.sec==="review"&&!RV.game)renderReview()}
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
/* UI = rc.ui (this browser only): theme "dark"|"light"|"system" (dark is the default since the Kibitz redesign; v3 marks the
   one-time move from the old default "system" to dark), board "green"|"wood"|"slate", pieces "cburnett"|"bold", sound, lang */
const UI=Object.assign({theme:"dark",board:"green",pieces:"cburnett",sound:false},LS.get("ui",{})),BOARDS=[];
if(!UI.v3){if(UI.theme!=="light")UI.theme="dark";UI.v3=1;LS.set("ui",UI)}
/* ---------- interface text: i18n/<lang>.js (window.KZ_I18N), English as the fallback; dates and numbers through Intl ---------- */
const LANGS=["en","fr","de","da"],I18N=window.KZ_I18N||{en:{}};let LANG="en";
const T=(k,v)=>{let s=(I18N[LANG]||{})[k];if(s==null)s=I18N.en[k];if(s==null)s=k;return v?s.replace(/\{(\w+)\}/g,(m,x)=>v[x]!=null?v[x]:m):s};
/* TX: a translation of data text (badge names, themes, levels...) when the language has one, else the English from the data */
const TX=(k,d)=>{const v=(I18N[LANG]||{})[k];return v!=null?v:d};
const fmtN=(n,o)=>new Intl.NumberFormat(LANG,o).format(n),TP=(k,n,v)=>{const c=k+"."+new Intl.PluralRules(LANG).select(n);return T((I18N[LANG]||{})[c]!=null||I18N.en[c]!=null?c:k+".other",{n:fmtN(n),...(v||{})})};
function langPick(){if(LANGS.includes(UI.lang)&&I18N[UI.lang])return UI.lang;for(const l of navigator.languages||[navigator.language||"en"]){const b=String(l).slice(0,2).toLowerCase();if(LANGS.includes(b)&&I18N[b])return b}return "en"}
function applyI18n(root){(root||document).querySelectorAll("[data-i18n]").forEach(e=>e.textContent=T(e.dataset.i18n));(root||document).querySelectorAll("[data-i18n-html]").forEach(e=>e.innerHTML=T(e.dataset.i18nHtml));
 (root||document).querySelectorAll("[data-i18n-attr]").forEach(e=>e.dataset.i18nAttr.split(";").forEach(p=>{const [a,k]=p.split(":");e.setAttribute(a,T(k))}));document.documentElement.lang=LANG}
LANG=langPick();
/* dates: "Today, 14:32", "Yesterday", "Sun 15 Nov, 14:32" (year only when it isn't this year) */
const LOC=()=>LANG==="en"?"en-GB":LANG;
const dayKey=d=>d.getFullYear()+"-"+d.getMonth()+"-"+d.getDate();
function fmtDay(ts){const d=new Date(ts),n=new Date(),y=new Date(n-864e5);if(dayKey(d)===dayKey(n))return T("date.today");if(dayKey(d)===dayKey(y))return T("date.yesterday");
 return new Intl.DateTimeFormat(LOC(),{weekday:"short",day:"numeric",month:"short",...(d.getFullYear()!==n.getFullYear()?{year:"numeric"}:{})}).format(d)}
const fmtTime=ts=>new Intl.DateTimeFormat(LOC(),{hour:"2-digit",minute:"2-digit"}).format(new Date(ts)),fmtWhen=ts=>fmtDay(ts)+", "+fmtTime(ts);
const RM=()=>matchMedia("(prefers-reduced-motion: reduce)").matches;
const ic=(n,c)=>`<svg class="ic${c?" "+c:""}" aria-hidden="true" focusable="false"><use href="vendor/icons.svg#i-${n}"/></svg>`;
function applyUI(){const d=document.documentElement;d.dataset.theme=UI.theme;d.dataset.board=UI.board;BOARDS.forEach(b=>b.draw())}
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
/* the list: game cards grouped by day, filter chips, 20 at a time */
const RV={f:"all",n:20,game:false,ply:null},RVF=[["all","rv.fAll"],["win","rv.fWin"],["loss","rv.fLoss"],["w","rv.fWhite"],["b","rv.fBlack"],["un","rv.fUn"]];
function filtered(){const f=RV.f;return GAMES.filter(g=>f==="all"||(f==="loss"&&g.result==="loss")||(f==="win"&&g.result==="win")||f===g.color||(f==="un"&&!g.an)).slice().reverse()}
function dayGroup(ts){const d=new Date(ts),n=new Date(),k=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime(),days=Math.round((k(n)-k(d))/864e5);
 if(days<=0)return T("date.today");if(days===1)return T("date.yesterday");if(days<7)return T("rv.thisWeek");
 return new Intl.DateTimeFormat(LOC(),{month:"long",...(d.getFullYear()!==n.getFullYear()?{year:"numeric"}:{})}).format(d)}
function renderReview(){const ch=$("#rvChips");if(ch.dataset.l!==LANG||!ch.children.length){ch.innerHTML=RVF.map(([v,k])=>`<button type="button" class="fchip" data-f="${v}">${esc(T(k))}</button>`).join("");ch.dataset.l=LANG}
 ch.querySelectorAll("[data-f]").forEach(b=>b.setAttribute("aria-pressed",RV.f===b.dataset.f));
 const L=filtered(),show=L.slice(0,RV.n);let html="",cur=null;
 for(const g of show){const grp=dayGroup(g.ts);if(grp!==cur){html+=(cur?"</div>":"")+`<h2 class="rv-day">${esc(grp)}</h2><div class="rv-cards">`;cur=grp}html+=gameCard(g)}
 $("#rvGroups").innerHTML=show.length?html+"</div>":`<p class="empty-line">${esc(T(GAMES.length?"rv.noMatch":"home.noGames"))}</p>`;
 $("#rvMore").hidden=L.length<=RV.n;$("#rvMore").textContent=T("rv.more",{n:Math.min(20,L.length-RV.n)})}
$("#rvChips").onclick=e=>{const b=e.target.closest("[data-f]");if(!b)return;RV.f=b.dataset.f;RV.n=20;renderReview()};
$("#rvMore").onclick=()=>{RV.n+=20;renderReview()};
/* open a game in the game view (#review/<id>), at ply or its first key moment */
function openReview(g,ply){RV.ply=ply==null?keyPly(g):ply;const h="review/"+encodeURIComponent(g.id);if(location.hash.slice(1)===h)route();else location.hash=h}
function reviewView(id){const g=id&&GAMES.find(x=>x.id===id);RV.game=!!g;$("#rvList").hidden=!!g;$("#rvGame").hidden=!g;
 if(g){if(CUR!==g||RV.ply!=null)openGame(g,RV.ply!=null?RV.ply:keyPly(g));else show();RV.ply=null;drawEval()}else renderReview()}
function openGame(g,ply){CUR=replay(g);RB.flip=g.color==="b";PLY=ply==null?keyPly(g):ply;
 $("#gTitle").textContent=resultLine(g);
 $("#gSub").innerHTML=`${esc(fmtWhen(g.ts))}<br>${T("card.vs",{col:T(g.color==="w"?"card.white":"card.black"),opp:esc(g.opp),oppR:g.oppR||"?",myR:g.myR||"?"})}<br>${esc(famOf(g.eco))}, ${esc(tcName(g.tc))}${g.link?`. <a href="${esc(g.link)}" target="_blank" rel="noopener">${esc(T("rv.onSite",{site:SRC[srcOf(g)].name}))}</a>`:""}`;
 $("#gStory").textContent=g.an?gameStory(g).t:"";renderMoves();renderKM();renderAnState();show()}
function show(){const g=CUR;if(!g)return;if(g.an&&GS&&!GS.rev[g.id]){(g._seen||(g._seen=new Set())).add(PLY);if(g._seen.size>=8){GS.rev[g.id]=1;gAdd(g.result==="loss"?{rv:1,rvl:1}:{rv:1})}}const m=g._m[PLY-1],o={last:m?{from:m.from,to:m.to}:null,arrows:[]};
 if(g.an&&PLY<g.moves.length&&g.an.best[PLY]){const er=errorsOf(g).find(e=>e.i===PLY);if(er&&er.kind!=="inacc"){const nx=g._m[PLY],b=g.an.best[PLY];o.arrows.push({from:nx.from,to:nx.to,c:"red"},{from:b.slice(0,2),to:b.slice(2,4),c:"green"})}}
 RB.set(g._f[PLY],o);if(g.an&&g.an.ev[PLY]!=null)REB.set(g.an.ev[PLY],RB.flip);else REB.hide();document.querySelectorAll("#moves button,#km button").forEach(b=>b.classList.toggle("on",+b.dataset.p===PLY));
 const on=document.querySelector("#moves button.on"),mv=$("#moves");if(on){const t=on.offsetTop;if(t<mv.scrollTop||t>mv.scrollTop+mv.clientHeight-30)mv.scrollTop=t-mv.clientHeight/2}
 $("#evNow").textContent=g.an&&g.an.ev[PLY]!=null?T(PLY?"rv.evAt":"rv.evStart",{mv:PLY?mvTxt(g,PLY-1):"",ev:evWords((g.color==="w"?1:-1)*g.an.ev[PLY])}):"";$("#evNow").title=g.an&&g.an.ev[PLY]!=null?evTxt(g.an.ev[PLY]):"";drawEval()}
/* an evaluation in words, from the player's side */
const evPast=cp=>T(cp>=9000?"evp.mate":cp>=300?"evp.winning":cp>=120?"evp.better":cp>-120?"evp.equal":cp>-300?"evp.worse":cp>-9000?"evp.losing":"evp.mated"),cap1=t=>t.charAt(0).toUpperCase()+t.slice(1);
const evWords=cp=>T(cp>=9000?"ev.mate":cp>=300?"ev.winning":cp>=120?"ev.better":cp>-120?"ev.equal":cp>-300?"ev.worse":cp>-9000?"ev.losing":"ev.mated");
/* scoresheet: move-quality marks from the analysis: ?? blunder, ? mistake, ?! inaccuracy, a check where the move was the engine's own */
function renderMoves(){const g=CUR,er=errorsOf(replay(g)),tag={blunder:"??",mistake:"?",inacc:"?!"},nm={blunder:"blunder",mistake:"mistake",inacc:"inaccuracy"};let h="";
 for(let i=0;i<g.moves.length;i+=2){h+=`<span class="mp"><span class="n">${i/2+1}</span>`;for(const j of [i,i+1]){if(j>=g.moves.length)continue;const e=er.find(x=>x.i===j),m=g._m[j],best=g.an&&m&&g.an.best[j]===m.from+m.to+(m.promotion||"");
  h+=`<span><button data-p="${j+1}" class="${e?"q-"+e.kind:best?"q-best":""}"${e?` aria-label="${esc(g.moves[j])}, ${nm[e.kind]}"`:best?` aria-label="${esc(g.moves[j])}, best move"`:""}>${esc(g.moves[j])}${e?`<span class="qm t-${e.kind}" aria-hidden="true">${tag[e.kind]}</span>`:best?`<span class="qm t-best" aria-hidden="true">${ic("check","sm")}</span>`:""}</button></span>`}h+="</span>"}
 $("#moves").innerHTML=h}
/* key moments: my mistakes and blunders in plain words: the better move, what changed, and the clock */
function renderKM(){const g=CUR;if(!g.an){$("#km").innerHTML=`<p class="empty-line">${esc(T("rv.kmNone"))}</p>`;return}
 const er=serious(g);if(!er.length){$("#km").innerHTML=`<div class="verdict v-ok">${ic("circle-check")}${esc(T("rv.kmClean"))}</div>`;return}
 $("#km").innerHTML=er.map(e=>{const sp=spent(g,e.i),cl=g.clocks&&g.clocks[e.i],bs=uciSan(g._f[e.i],e.best),bw=evPast(e.before),aw=evPast(e.after);
  return `<button data-p="${e.i}"><span class="km-q t-${e.kind}" aria-hidden="true">${e.kind==="blunder"?"??":"?"}</span><span><span class="km-h"><b>${esc(mvTxt(g,e.i))}</b> <span class="km-kind t-${e.kind}">${esc(T("rv."+e.kind))}</span></span><span class="km-why">${esc(T("rv.kmBetter",{mv:bs||"?"}))} ${esc(cap1(bw===aw?T("rv.kmStill",{ev:aw}):T("rv.kmSwing",{b:bw,a:aw})))}</span>${sp!=null?`<span class="small">${esc(T("rv.kmClock",{s:sp,left:mmss(cl)}))}</span>`:""}</span></button>`}).join("")}
function renderAnState(){const g=CUR;$("#rvGraphD").hidden=!g.an;$("#evLegend").innerHTML=g.an?`<span><span class="k k-green"></span>${esc(T("rv.lgBetter"))}</span><span><span class="k k-red"></span>${esc(T("rv.lgPlayed"))}</span>`:"";
 $("#anState").innerHTML=g.an?"":`<div class="row"><button class="pri" id="anOne">${ic("cpu")}${esc(T("rv.analyse"))}</button><span class="small">${esc(T("rv.analyseP"))}</span></div>`;
 const b=$("#anOne");if(b)b.onclick=()=>{queue([g],true);b.disabled=true;b.textContent=T("card.queued")}}
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
function stepGame(d){const l=filtered(),i=l.indexOf(CUR),g=l[Math.max(0,Math.min(l.length-1,i+d))];if(g&&g!==CUR)openReview(g)}
$("#prevG").onclick=()=>stepGame(1);$("#nextG").onclick=()=>stepGame(-1);
document.addEventListener("keydown",e=>{if(route.sec!=="review"||!RV.game||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
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
   job("an",T("job.an",{n:AQ.done+1,all:AQ.done+AQ.list.length+1}),(i+1)/g._f.length)}
  if(gen!==GEN)break;g.an={ev,best:best.slice(0,-1),depth:DEPTH};DB.put([g]);Sync.mark("an",g.id);Fr.soon();AQ.done++;maybeBaseline();
  if(CUR===g){renderMoves();renderKM();renderAnState();$("#gStory").textContent=gameStory(g).t;show()}buildPuzzles();if(route.sec==="review"&&!RV.game)renderReview();if(route.sec==="progress")renderProgress();if(route.sec==="trainer"&&!TSN)renderTHub();if(route.sec==="home")renderHome()}}
 catch(e){$("#anState").innerHTML=`<div class="verdict v-no">${ic("triangle-alert")}${esc(T("rv.noEngine"))}</div>`}
 AQ=null;job("an",null);if(P&&gen===GEN){maybeBaseline();gCheck();TG.run()}if(route.sec==="progress")renderProgress();if(route.sec==="home"&&P)renderHome();if(CUR&&!CUR.an)renderAnState()}
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
const piecesTxt=d=>{const out=[];for(const t of ["q","r","b","n","p"]){const k=d[t]||0;if(k>0)out.push(TP("pc."+t,k))}return out.join(T("tr.and"))};
const wL=(k,v)=>({t:T("why.l."+k+".t",v),y:T("why.l."+k+".y",v)});
/* plain-language label of a line for `me` (the side to move at its start). keep: allow "keeps an extra pawn" (not for a wrong move) */
function wLabel(line,me,keep){if(!line||!line.L.length)return null;const L=line.L,op=me==="w"?"b":"w";let e=Math.min(L.length,WHY_SHOW);while(e<L.length&&L[e-1].cap)e++;   // don't stop mid-exchange
 const end=L[e-1].fen,c=new Chess(end),cp=line.cp==null?null:me==="w"?line.cp:-line.cp;
 if(c.in_checkmate())return wL(c.turn()===me?"mated":"mate");
 if(cp!=null&&Math.abs(cp)>=9000){const n=10000-Math.abs(cp);return wL(cp>0?"mateIn":"allowMate",{n})}
 const m0=matOf(line.fen),m1=matOf(end),lost={},got={};for(const t in VAL){const a=m0[me][t]-m1[me][t],b=m0[op][t]-m1[op][t];if(a>0)lost[t]=a;if(b>0)got[t]=b}
 const net=balOf(m1,me)-balOf(m0,me),b0=balOf(m0,me),b1=balOf(m1,me),lt=piecesTxt(lost)||T("why.material"),gt=piecesTxt(got)||T("why.material");
 const exch=(a,b)=>a.r===1&&!a.q&&!a.n&&!a.b&&!b.r&&!b.q&&(b.n||0)+(b.b||0)===1;
 if(net<=-2&&exch(lost,got))return wL("loseEx");
 if(net>=2&&exch(got,lost))return wL("winEx");
 if(net<=-1)return piecesTxt(got)?wL("loseFor",{a:lt,b:gt}):wL("lose",{a:lt});
 if(net>=1)return piecesTxt(lost)?wL("winFor",{a:gt,b:lt}):wL("win",{a:gt});
 if(keep&&b0>=1)return wL("keep",{x:T("why.x"+({1:1,2:2,3:3,4:3,5:5}[b0]||"M"))});
 if(b1===0&&cp!=null&&Math.abs(cp)>=60)return wL(cp>0?"eqB":"eqW");
 return null}
/* move text with move numbers from fen: "5. Nd6+ exd6 6. Bd3" / "5… exd6 6. Bd3" */
const wMoves=(fen,L)=>{const f=fen.split(" "),w=f[1]==="w",n0=+f[5]||1;return L.map((m,j)=>{const wm=(j%2===0)===w,n=n0+Math.floor((j+(w?0:1))/2);return {num:wm?n+".":j===0?n+"…":"",san:m.san}})};
function Why(el,board,bar){this.el=el;this.b=board;this.bar=bar;this.tok=0}
Why.prototype.clear=function(){this.tok++;this.el.innerHTML="";this.b.lock=false;if(this.bar)this.bar.hide()};
/* o: {fen, played: UCI of the move being explained, best: UCI of the right move (optional), ok: played was right, restore(): redraw the drill/puzzle position} */
Why.prototype.show=async function(o){const t=++this.tok,gen=GEN;this.o=o;this.b.lock=false;this.el.innerHTML='<div class="why-wait" role="status"><span class="sr-only">${esc(T("why.wait"))}</span><span class="skel" style="width:85%"></span><span class="skel" style="width:60%"></span><span class="skel" style="width:72%"></span></div>';
 const me=o.fen.split(" ")[1],opp=T(me==="w"?"card.black":"card.white"),ew=cp=>evWords(cp==null?0:me==="w"?cp:-cp);let ev0=null,A=null,B=null;
 try{ev0=(await wEval(o.fen)).cp;if(t!==this.tok)return;if(o.played)A=await wLine(o.fen,o.played);if(t!==this.tok)return;
  if(!o.ok){const pv0=(await wEval(o.fen)).pv[0],b=o.best&&o.best!==o.played?o.best:pv0&&pv0!==o.played?pv0:null;if(b)B=await wLine(o.fen,b!==pv0?b:null)}}catch(e){}
 if(t!==this.tok||gen!==GEN)return;if(!A&&!B){this.el.innerHTML=`<p class="small">${esc(T("why.none"))}</p>`;return}
 const la=wLabel(A,me,!!o.ok),lb=wLabel(B,me,true),S=[];
 // plain words, no evaluation numbers: "After Nd6+, Black plays Qxd6 and you've lost a knight." / "...: you were better, now you're worse."
 if(A&&!o.ok){const r=A.L[1],v={mv:A.L[0].san,side:opp,r:r?r.san:"",y:la?la.y:"",sw:ev0!=null&&A.cp!=null?T("why.sw",{b:evPast(me==="w"?ev0:-ev0),a:ew(A.cp)}):""};S.push(T("why.wrong"+(r?"R":"")+(la?"L":v.sw?"S":""),v))}
 if(A&&o.ok)S.push(la?T("why.okL",{mv:A.L[0].san,t:la.t}):T("why.okE",{mv:A.L[0].san,ev:ew(A.cp)}));
 if(B)S.push(lb?T("why.betterL",{mv:B.L[0].san,t:lb.t}):T("why.betterE",{mv:B.L[0].san,ev:ew(B.cp)}));
 this.render(cap1(S.join(" ")),[A&&{title:T(o.ok?"why.works":"why.your"),c:o.ok?"green":"red",x:A,lab:la},B&&{title:T("why.better"),c:"green",x:B,lab:lb}].filter(Boolean))};
/* draw a sentence and lines ({title, c: "red"|"green", x: {fen, L}, lab: {t}}); also used by the start screen's demo */
Why.prototype.render=function(say,lines){this.lines=lines;this.cur=null;
 this.el.innerHTML=`<p class="why-say">${esc(say)}</p>`+this.lines.map((l,i)=>`<div class="why-line ${l.c}" data-i="${i}"><div class="why-head"><b>${esc(l.title)}</b>${l.lab?` <span class="tag">${esc(l.lab.t)}</span>`:""}</div>`+
  `<p class="why-moves">${wMoves(l.x.fen,l.x.L.slice(0,WHY_SHOW)).map((m,k)=>`${m.num?`<span class="num">${m.num}</span> `:""}<button class="why-mv" type="button" data-k="${k+1}">${esc(m.san)}</button>`).join(" ")}</p></div>`).join("")+
  // one control row for all lines: it steps through the line last clicked (the better line to begin with)
  `<div class="why-nav"><button type="button" data-a="back" aria-label="${esc(T("why.backL"))}">${ic("chevron-left","sm")}${esc(T("why.back"))}</button><button type="button" data-a="fwd" aria-label="${esc(T("why.fwdL"))}">${esc(T("why.fwd"))}${ic("chevron-right","sm")}</button><button class="link" type="button" data-a="reset">${esc(T("why.reset"))}</button></div>`;
 this.el.querySelectorAll(".why-line").forEach(d=>{const i=+d.dataset.i;d.querySelectorAll("[data-k]").forEach(b=>b.onclick=()=>this.step(i,+b.dataset.k))});
 const li=()=>this.cur?this.cur.i:this.lines.length-1;
 this.el.querySelector('[data-a="back"]').onclick=()=>this.step(li(),(this.cur?this.cur.k:1)-1);this.el.querySelector('[data-a="fwd"]').onclick=()=>this.step(li(),(this.cur?this.cur.k:0)+1);
 this.el.querySelector('[data-a="reset"]').onclick=()=>this.reset()};
/* show line i after k plies: last move highlighted, arrow for the next move */
Why.prototype.step=function(i,k){const l=this.lines[i];if(!l)return;const L=l.x.L.slice(0,WHY_SHOW);k=Math.max(0,Math.min(L.length,k));this.cur={i,k};this.b.lock=true;
 const m=L[k-1],nx=L[k],fen=k?m.fen:l.x.fen;this.b.set(fen,{last:m?{from:m.from,to:m.to}:null,arrows:nx?[{from:nx.from,to:nx.to,c:l.c}]:[]});
 if(this.bar){const bar=this.bar,t=this.tok,cur=this.cur;bar.set(null,this.b.flip);wEval(fen).then(r=>{if(t===this.tok&&this.cur===cur)bar.set(r.cp,this.b.flip)}).catch(()=>{})}
 this.el.querySelectorAll(".why-mv").forEach(b=>b.classList.toggle("on",+b.closest(".why-line").dataset.i===i&&+b.dataset.k===k))};
Why.prototype.reset=function(){this.cur=null;this.b.lock=false;this.b.noAnim=true;if(this.bar)this.bar.hide();this.el.querySelectorAll(".why-mv.on").forEach(b=>b.classList.remove("on"));if(this.o&&this.o.restore)this.o.restore()};

/* session counters (this visit only): attempts, solved, current run of correct answers */
const TSS={n:0,ok:0,run:0,best:0},OSS={n:0,ok:0,run:0,best:0};
function sess(S,ok,el){S.n++;if(ok){S.ok++;S.run++;S.best=Math.max(S.best,S.run)}else S.run=0;
 $(el).innerHTML=`<span class="chip">${ic("target","sm")}${esc(T("sess.n",{ok:S.ok,n:S.n}))}</span><span class="chip xp">${ic("flame","sm")}${esc(T("sess.run",{n:S.run}))}</span>${S.best>2?`<span class="chip gold">${ic("trophy","sm")}${esc(T("sess.best",{n:S.best}))}</span>`:""}`}
const TB=new Board($("#tboard"),{onMove:tryMove,label:"Puzzle board"}),TW=new Why($("#tWhy"),TB,new EvalBar($("#tEv")));let PZ=[],PI=null,HINT=0,DONE=false;
let TS={};
function buildPuzzles(){PZ=[];for(const g of GAMES){if(!g.an)continue;replay(g);for(const e of serious(g))if(wp(e.before)>=30&&e.best)PZ.push({id:g.id+":"+e.i,g,e})}PZ.sort((a,b)=>b.g.ts-a.g.ts);renderTStats()}
/* Train › Puzzles: a hub (how the last 5 analysed games went, then a choice of sessions), the session (TSN), and its summary.
   TSN = {k: mode, ids: [puzzle ids], i: current index, res: {id: 1 solved | 0 missed}, done} for this visit only. */
let TSN=null;
const pzSt=id=>TS[id]||{},pzById=id=>PZ.find(p=>p.id===id),unsolvedFirst=L=>L.filter(p=>!pzSt(p.id).ok).concat(L.filter(p=>pzSt(p.id).ok));
const tagOf=p=>{const m=p.g.mt;return m&&m.v===MT_V&&m.e[p.e.i]?m.e[p.e.i].t[0]:null};
const last5=()=>GAMES.filter(g=>g.an).slice(-5).reverse();
function topThemes(G){const c={};for(const g of G){if(!g.mt||g.mt.v!==MT_V)continue;for(const i in g.mt.e){const t=g.mt.e[i].t[0];if(t&&t!=="positional"&&MOT[t])c[t]=(c[t]||0)+g.mt.e[i].d}}return Object.entries(c).sort((a,b)=>b[1]-a[1]).map(x=>x[0])}
function tModes(){const L5=new Set(last5()),M=[],shuf=a=>a.map(x=>[Math.random(),x]).sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
 const rec=unsolvedFirst(PZ.filter(p=>L5.has(p.g))).slice(0,10);if(rec.length)M.push({k:"recent",i:"scan-search",ids:rec});
 const re=PZ.filter(p=>pzSt(p.id).fail&&!pzSt(p.id).ok).slice(0,10);if(re.length)M.push({k:"retry",i:"rotate-ccw",ids:re});
 let th=topThemes(last5())[0];if(!th){const W=wkProfile();th=Object.entries(W.T).filter(([k])=>k!=="positional"&&MOT[k]).sort((a,b)=>b[1].d-a[1].d).map(x=>x[0])[0]}
 if(th){const tl=unsolvedFirst(PZ.filter(p=>tagOf(p)===th)).slice(0,8);M.push({k:"theme",i:"crosshair",ids:tl,th,course:tl.length<3?motTo(th):null})}
 if(PZ.length){const fr=PZ.filter(p=>!pzSt(p.id).seen),ns=PZ.filter(p=>pzSt(p.id).seen&&!pzSt(p.id).ok),ok=PZ.filter(p=>pzSt(p.id).ok);M.push({k:"warm",i:"flame",ids:shuf(fr).concat(shuf(ns),shuf(ok)).slice(0,5)})}
 return M}
const setHTML=(el,h)=>{if(el._h!==h){el.innerHTML=h;el._h=h}};
function renderTHub(){const G=last5();let h;
 if(!G.length)h=`<div class="panel t-empty"><span class="t-ic">${ic("puzzle")}</span><div><h2>${esc(T("tr.emptyH"))}</h2><p>${esc(T(AQ?"tr.emptyWait":"tr.emptyNo"))}</p>${AQ||!GAMES.length?"":`<button class="pri" type="button" id="tAnalyse">${ic("cpu")}${esc(T("plan.analyseGo"))}</button>`}</div></div>`;
 else{const er=G.flatMap(g=>serious(replay(g))),bl=er.filter(e=>e.kind==="blunder").length,mi=er.length-bl,th=topThemes(G).slice(0,2),tu=G.map(timeUsed).filter(x=>x!=null).sort((a,b)=>a-b),B=baseSecs(),med=tu.length?tu[tu.length>>1]:null;
  h=`<div class="panel"><h2>${esc(TP("tr.sumH",G.length))}</h2><ul class="t-games">${G.map(g=>`<li><a href="#review/${encodeURIComponent(g.id)}" class="t-g"><span class="rchip ${g.result}">${esc(T("tr.r."+g.result))}</span><span class="t-gs">${esc(gameStory(g).t)}</span></a></li>`).join("")}</ul>
  <div class="kpis t-facts"><div class="kpi"><b>${fmtN(bl)}</b>${esc(TP("tr.blunders",bl))}</div><div class="kpi"><b>${fmtN(mi)}</b>${esc(TP("tr.mistakes",mi))}</div>${med!=null?`<div class="kpi"><b>${mmss(med)}</b>${esc(T("tr.time"))}</div>`:""}</div>${med!=null?`<p class="t-themes">${ic("timer","sm")}<span>${esc(T(med>=B*.7?"tr.timeOk":"tr.timeGoal",{goal:mmss(B*.7)}))}</span></p>`:""}
  ${th.length?`<p class="t-themes">${ic("crosshair","sm")}<span>${esc(T("tr.themes",{t:th.map(k=>motN(k).toLowerCase()).join(T("tr.and"))}))}</span></p>`:er.length?"":`<p class="t-themes">${ic("circle-check","sm")}<span>${esc(T("tr.clean"))}</span></p>`}</div>`}
 setHTML($("#tSum"),h);const ab=$("#tAnalyse");if(ab)ab.onclick=()=>{analyseRecent(20);renderTHub()};
 const M=tModes(),first=M.find(m=>m.ids.length>=(m.course?3:1))||M.find(m=>m.course);
 setHTML($("#tModes"),M.length?M.map(m=>{const n=m.ids.length,course=m.course&&n<3,f=m===first,tn=m.th?motN(m.th).toLowerCase():"";
  return `<article class="t-mode${f?" first":""}"><span class="t-ic">${ic(m.i)}</span><div class="t-mt"><h3>${esc(T("tr.m."+m.k,{n:G.length,t:tn}))}</h3><p>${esc(T("tr.m."+m.k+(course?"C":"")+"P"))}</p><p class="t-meta">${ic("timer","sm")}${esc(course?T("tr.lessonMeta"):TP("tr.meta",n,{min:Math.max(1,Math.round(n*1.2))}))}</p></div><button type="button" class="${f?"pri":""}" data-mode="${m.k}">${esc(T(course?"tr.openCourse":"tr.start"))}${ic(course?"arrow-right":"play","sm")}</button></article>`}).join(""):`<p class="empty-line">${esc(T("tr.noModes"))}</p>`)}
$("#tModes").onclick=e=>{const b=e.target.closest("[data-mode]");if(b)tStart(b.dataset.mode)};
/* start a session of one mode (from the hub, Home's plan or "Train again"); returns false when that mode has nothing left */
function tStart(k){const m=tModes().find(x=>x.k===k);if(!m)return false;
 if(m.course&&m.ids.length<3){const Tg=lsTarget(m.course,wkProfile());location.hash="train/lessons";if(Tg)openLesson(Tg.l.id);return true}
 if(!m.ids.length)return false;TSN={k,th:m.th,ids:m.ids.map(p=>p.id),i:0,res:{}};Object.assign(TSS,{n:0,ok:0,run:0,best:0});$("#tSess").innerHTML="";
 if(route.sec!=="trainer")location.hash="train/puzzles";tView();loadPuzzle(pzById(TSN.ids[0]));return true}
function tView(){const s=!TSN?"hub":TSN.done?"done":"play";$("#tHub").hidden=s!=="hub";$("#tPlay").hidden=s!=="play";$("#tDone").hidden=s!=="done";if(s==="hub")renderTHub();if(s==="done")renderTDone();if(s==="play"&&!PI)loadPuzzle(pzById(TSN.ids[TSN.i]))}
function renderTStats(){if(route.sec==="trainer"&&!TSN)renderTHub()}
function renderTDone(){const r=Object.values(TSN.res),ok=r.filter(x=>x).length,miss=r.length-ok;
 $("#tDone").innerHTML=`<div class="panel t-done"><span class="t-ic">${ic(miss?"dumbbell":"trophy")}</span><h2>${esc(T(miss||!ok?"tr.doneH":"tr.doneAll"))}</h2><div class="kpis"><div class="kpi"><b>${fmtN(ok)}</b>${esc(T("tr.solved"))}</div><div class="kpi"><b>${fmtN(miss)}</b>${esc(T("tr.missed"))}</div><div class="kpi"><b>${fmtN(TSS.best)}</b>${esc(T("tr.bestRun"))}</div></div><p class="t-done-p">${esc(T(miss?"tr.doneMiss":"tr.doneP"))}</p><div class="t-done-act"><button class="pri lg" type="button" id="tAgain">${ic("rotate-ccw")}${esc(T("tr.again"))}</button><button class="lg" type="button" id="tBack">${esc(T("tr.back"))}</button></div></div>`;
 $("#tAgain").onclick=()=>{if(!tStart(TSN.k)){TSN=null;tView()}};$("#tBack").onclick=()=>{TSN=null;tView()}}
$("#tQuit").onclick=()=>{TSN=null;PI=null;TW.clear();tView()};
function loadPuzzle(p){PI=p;HINT=0;DONE=false;TW.clear();$("#tFeedback").innerHTML="";$("#tMeta").innerHTML="";
 if(TSN){$("#tProg").textContent=T("tr.prog",{i:TSN.i+1,n:TSN.ids.length});$("#tTitle").textContent=T("tr.m."+TSN.k,{n:last5().length,t:TSN.th?motN(TSN.th).toLowerCase():""});$("#tNextL").textContent=T(TSN.i+1>=TSN.ids.length?"tr.finish":"tr.next")}
 $("#tPrompt").className="verdict v-info";if(!p){$("#tPrompt").textContent=T("tr.gone");TB.flip=false;TB.set(new Chess().fen());return}
 const g=p.g,e=p.e,c=new Chess(g._f[e.i]),m=g._m[e.i-1];TB.flip=c.turn()==="b";TB.set(g._f[e.i],{last:m?{from:m.from,to:m.to}:null});
 $("#tPrompt").innerHTML=`${ic("target")}<b>${esc(T(c.turn()==="w"?"tr.wtm":"tr.btm"))}</b> ${esc(T("tr.find"))}`;$("#tPrompt").className="verdict v-move";
 $("#tMeta").innerHTML=`<span>${esc(T("tr.from",{opp:g.opp,when:fmtDay(g.ts),mv:Math.floor(e.i/2)+1}))}</span>`}
const saveTS=()=>{LS.set(uk("trainer"),TS);if(PI)Sync.mark("pz",acct()+"|"+PI.id);Fr.soon()};
const tRes=(p,ok)=>{if(TSN&&TSN.res[p.id]==null)TSN.res[p.id]=ok?1:0};
async function tryMove(from,to){if(!PI||DONE)return;const p=PI,fen=p.g._f[p.e.i],c=new Chess(fen),mv=c.move({from,to,promotion:"q"});if(!mv)return;const u=from+to;TW.clear();
 const back=()=>TB.set(c.fen(),{last:{from,to}});
 TB.set(c.fen(),{last:{from,to}});const st=TS[p.id]||(TS[p.id]={}),was=!!st.ok;st.seen=1;let ok=u===p.e.best.slice(0,4),note="";
 if(!ok){$("#tFeedback").innerHTML=`<div class="skel-wrap" role="status"><span class="sr-only">${esc(T("tr.checking"))}</span><span class="skel" style="width:55%"></span></div>`;try{const r=await Engine.eval(c.fen(),12),s=fen.split(" ")[1]==="w"?1:-1;ok=wp(s*p.g.an.ev[p.e.i])-wp(s*r.cp)<8;if(ok)note=" "+T("tr.alsoGood")}catch(x){}}
 if(PI!==p)return;
 Snd.play(ok?"correct":"wrong");sess(TSS,ok,"#tSess");tRes(p,ok);if(ok){DONE=true;st.ok=1;const award=!was&&!st.x;if(award)st.x=1;saveTS();if(award)gAdd(st.fail?{pz:1}:{pz:1,p1:1});const bs=uciSan(fen,p.e.best);$("#tFeedback").innerHTML=`<div class="verdict v-ok">${ic("circle-check")}${esc(T("tr.ok",{mv:mv.san})+note+" "+T("tr.inGame",{mv:p.g.moves[p.e.i]})+(bs&&bs!==mv.san?" "+T("tr.engine",{mv:bs}):""))}</div><button class="link" id="tWhyBtn" type="button">${esc(T("tr.why"))}</button>`;
  $("#tWhyBtn").onclick=()=>{$("#tWhyBtn").remove();TW.show({fen,played:mv.from+mv.to+(mv.promotion||""),ok:true,restore:back})}}
 else{st.fail=(st.fail||0)+1;st.ok=0;saveTS();$("#tFeedback").innerHTML=`<div class="verdict v-no">${ic("circle-x")}${esc(T("tr.wrong",{mv:mv.san}))}</div><div class="v-actions"><button id="tRetry" type="button">${ic("rotate-ccw","sm")}${esc(T("tr.retry"))}</button></div>`;$("#tRetry").onclick=()=>loadPuzzle(p);
  TW.show({fen,played:mv.from+mv.to+(mv.promotion||""),best:p.e.best,restore:back})}}
$("#tHint").onclick=()=>{if(!PI||DONE)return;HINT++;const b=PI.e.best,c=new Chess(PI.g._f[PI.e.i]),m=c.move({from:b.slice(0,2),to:b.slice(2,4),promotion:"q"});
 const kind=T(m.san.includes("#")?"tr.hMate":m.captured?"tr.hWin":m.san.includes("+")?"tr.hCheck":"tr.hThreat");
 if(HINT===1)$("#tFeedback").innerHTML=`<div class="verdict v-info">${ic("info")}${esc(kind)}</div>`;else{TB.set(PI.g._f[PI.e.i],{hl:b.slice(0,2)});$("#tFeedback").innerHTML=`<div class="verdict v-info">${ic("info")}${esc(kind+" "+T("tr.hPiece"))}</div>`}};
$("#tShow").onclick=()=>{if(!PI)return;const p=PI,b=p.e.best,st=TS[p.id]||(TS[p.id]={});if(!DONE){st.seen=1;st.fail=(st.fail||0)+1;st.ok=0;saveTS()}DONE=true;tRes(p,false);
 const fen=p.g._f[p.e.i],bs=uciSan(fen,b),pl=p.g._m[p.e.i],ar=[{from:pl.from,to:pl.to,c:"red"},{from:b.slice(0,2),to:b.slice(2,4),c:"green"}];TB.set(fen,{arrows:ar});
 const bw=evPast(p.e.before),aw=evPast(p.e.after);
 $("#tFeedback").innerHTML=`<div class="verdict v-info">${ic("info")}<span>${T("tr.answer",{b:`<b>${esc(bs)}</b>`,g:esc(p.g.moves[p.e.i])})} ${esc(cap1(bw===aw?T("rv.kmStill",{ev:aw}):T("rv.kmSwing",{b:bw,a:aw})))}</span></div>`;
 TW.show({fen,played:pl.from+pl.to+(pl.promotion||""),best:b,restore:()=>TB.set(fen,{arrows:ar})})};
$("#tNext").onclick=()=>{if(PI){(TS[PI.id]||(TS[PI.id]={})).seen=1;saveTS()}if(!TSN)return;
 for(;;){TSN.i++;if(TSN.i>=TSN.ids.length){TSN.done=true;PI=null;TW.clear();tView();return}const p=pzById(TSN.ids[TSN.i]);if(p){loadPuzzle(p);return}}};

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
/* lesson lines being drilled: at least two thirds of my moves in the line are pinned repertoire moves; they belong to an opening whose
   famOf name the course matches, or to the course's own name when I have no games in it */
function opLines(col,fam){const out=[];for(const co of OPC)for(const ch of co.chapters)for(const l of ch.lessons){const side=l.side||ch.side;if(side!==col||!((co.re&&co.re.test(fam))||co.name===fam))continue;
  const c=new Chess();let n=0,p=0;for(const [i,s] of l.m.split(" ").entries()){const k=posKey(c.fen()),m=c.move(s);if(!m)break;if((i%2===0)===(col==="w")&&!(l.bad||[]).includes(i+1)){n++;if((OPS[k]||{}).pin===m.from+m.to+(m.promotion||""))p++}}
  if(n&&p*3>=n*2)out.push(l)}return out}
const opSig=(col,fam)=>{const gs=opGames(col,fam);return gs.length+"/"+gs.filter(g=>g.an).length+"/"+opLines(col,fam).length};
function buildTree(col,fam){const T=new Map(),gs=opGames(col,fam),fs=score(gs)||0;
 for(const g of gs){replay(g);const er=g.an?errorsOf(g):[],r=opRes(g),N=Math.min(OP_PLY,g._m.length);
  for(let i=0;i<N;i++){const k=posKey(g._f[i]);let n=T.get(k);
   if(!n)T.set(k,n={k,fen:g._f[i],ply:i,path:g.moves.slice(0,i),mine:(i%2===0)===(g.color==="w"),n:0,sc:0,mv:{},anN:0,err:0,bv:{},ev:null});
   const m=g._m[i],u=m.from+m.to+(m.promotion||""),x=n.mv[u]||(n.mv[u]={u,san:m.san,n:0,sc:0,ck:posKey(g._f[i+1])});n.n++;n.sc+=r;x.n++;x.sc+=r;
   if(g.an&&g.an.ev[i]!=null){n.anN++;if(n.ev==null)n.ev=g.an.ev[i];const b=g.an.best[i];if(b)n.bv[b]=(n.bv[b]||0)+1;if(n.mine&&er.some(e=>e.i===i&&e.mine))n.err++}}}
 for(const l of opLines(col,fam)){const c=new Chess(),ms=l.m.split(" ");for(let i=0;i<ms.length&&i<OP_PLY;i++){const fen=c.fen(),k=posKey(fen);let n=T.get(k);
   if(!n)T.set(k,n={k,fen,ply:i,path:ms.slice(0,i),mine:(i%2===0)===(col==="w"),n:0,sc:0,mv:{},anN:0,err:0,bv:{},ev:null});n.ln=(n.ln||0)+1;const m=c.move(ms[i]);if(!m)break;
   const u=m.from+m.to+(m.promotion||""),x=n.mv[u]||(n.mv[u]={u,san:m.san,n:0,sc:0,ck:posKey(c.fen())});x.ln=(x.ln||0)+1}}
 for(const n of T.values()){n.score=n.n?n.sc/n.n*100:fs;n.best=Object.keys(n.bv).sort((a,b)=>n.bv[b]-n.bv[a])[0]||null;n.errRate=n.anN?n.err/n.anN:0;
  n.drop=n.n>=3?Math.max(0,fs-n.score):0;n.weak=n.mine&&((n.err>=1&&n.errRate>=.34)||n.drop>=10);n.prio=n.mine?n.n*(n.errRate+n.drop/100):0}
 return {col,fam,key:col+"|"+fam,T,games:gs,score:fs,sig:opSig(col,fam)}}
const opCore=()=>OT?[...OT.T.values()].filter(n=>n.mine&&(n.n>=2||n.weak||n.ln)):[];
/* how much a subtree needs practice: a due core position within d plies */
function opNeed(k,d){const n=OT.T.get(k);if(!n||d<0)return 0;let v=n.mine&&(n.n>=2||n.weak||n.ln)&&isDue(k)?1:0;if(d>0&&!v)for(const x of Object.values(n.mv)){v=Math.max(v,opNeed(x.ck,d-1));if(v)break}return v}
async function opEval(fen,d){const k=posKey(fen)+"|"+d;if(OEV.has(k))return OEV.get(k);const r=await Engine.eval(fen,d);OEV.set(k,r);return r}
function opGrade(k,ok){const x=OPS[k]||(OPS[k]={s:0,ok:0,miss:0}),now=Date.now();
 let xp=null;if(ok){if(!x.due||x.due<=now){x.s=(x.s||0)+1;x.due=now+OP_IV[Math.min(x.s,OP_IV.length-1)]*864e5;xp=x.s===OP_LEARNED?{op:1,ol:1}:{op:1}}x.ok=(x.ok||0)+1}
 else{x.s=0;x.due=now+10*6e4;x.miss=(x.miss||0)+1}     // a miss comes back within the session
 x.at=now;saveOPS(k);const st=LS.get(uk("opstart"),{});if(!st[OT.key]){st[OT.key]=now;LS.set(uk("opstart"),st);Sync.mark("ops",acct()+"|"+OT.key)}if(xp)gAdd(xp)}
/* opponent move: weighted by how often my opponents played it, nudged towards lines with positions due for review;
   where my games are thin (< 3 games), add the Lichess explorer's moves at my rating (worth 2 games in total) */
async function opPickOpp(fen,n){const own=n?Object.values(n.mv):[],tot=own.reduce((a,x)=>a+x.n+(x.ln||0)*3,0),W=new Map();
 own.forEach(x=>W.set(x.san,{san:x.san,w:(x.n+2*(x.ln||0))*(1+2*opNeed(x.ck,5)),src:"games"}));
 if(tot<3){const ex=await Explorer.moves(fen);if(ex&&ex.length){const et=ex.reduce((a,x)=>a+x.n,0);
  ex.filter(x=>x.n/et>=.05).forEach(x=>{const o=W.get(x.san)||{san:x.san,w:0,src:"lichess"};o.w+=2*x.n/et;W.set(x.san,o)})}}
 const L=[...W.values()];if(!L.length)return null;let r=Math.random()*L.reduce((a,x)=>a+x.w,0);for(const x of L)if((r-=x.w)<=0)return x;return L[L.length-1]}
function opStartLine(replay,at){if(!OT)return;const start=replay&&OD?OD.start:at||null;
 OD={gen:GEN,key:OT.key,c:new Chess(start?start.fen:undefined),ply:start?start.ply:0,opp:replay&&OD?OD.opp:[],start,miss:false,wait:false,viaEx:false};
 OB.flip=OT.col==="b";OW.clear();OB.set(OD.c.fen());$("#oFeedback").innerHTML="";opStep()}
async function opStep(){const d=OD;if(!d||d.gen!==GEN||d.key!==(OT&&OT.key))return;const c=d.c,fen=c.fen(),k=posKey(fen),n=OT.T.get(k),mine=(c.turn()==="w")===(OT.col==="w");
 if(d.ply>=OP_PLY||c.game_over())return opLineDone(d,"end");
 if(mine){if(!n&&!d.viaEx)return opLineDone(d,"data");d.wait=true;const x=OPS[k];
  $("#oPrompt").className="verdict v-move";$("#oPrompt").innerHTML=`${ic("target")}<b>Your move.</b> ${n?(n.n?`Seen in ${n.n} of your games.`:"From your lesson lines."):"From Lichess games at your rating."}${n&&n.weak?' <span class="tag">weak spot</span>':""}${x&&x.pin?' <span class="tag">repertoire</span>':""}`;return}
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
function renderOpStats(){if(!OT)return;const core=opCore(),learned=core.filter(n=>((OPS[n.k]||{}).s||0)>=OP_LEARNED).length,due=core.filter(n=>isDue(n.k)).length,g=OT.games.length;
 $("#oKpis").innerHTML=`<div class="kpi"><b>${fmtN(g)}</b>${esc(T("op.kGames"))}</div><div class="kpi${g&&OT.score<45?" goal":""}"><b>${g?Math.round(OT.score)+"%":"—"}</b>${esc(T("op.kScore"))}</div><div class="kpi"><b>${fmtN(learned)}<s>${esc(T("op.of",{n:core.length}))}</s></b>${esc(T("op.kLearned"))}</div><div class="kpi goal"><b>${fmtN(due)}</b>${esc(T("op.kDue"))}</div>`}
/* Train › Openings: a gallery of cards (#train/openings; my openings first, then popular ones), one opening's page
   (#train/openings/<key>) and the drill (#train/openings/<key>/practise). A key is "<w|b>|<family or course/popular name>". */
let OVW={v:"gal",k:null},OSTART=null,OPOP=null;const OPOP_FILE="vendor/openings-popular-2026-11.json",OTC=new Map();
const opPop=()=>OPOP?Promise.resolve(OPOP):fetch(OPOP_FILE).then(r=>r.ok?r.json():{w:[],b:[]}).catch(()=>({w:[],b:[]})).then(j=>OPOP=j);
const opNorm=s=>s.toLowerCase().replace(/defence/g,"defense").replace(/[^a-z]/g,"").replace(/s(opening|defense|game|gambit|attack)/g,"$1");
/* the last moves of a long path, numbered: "… 9. d3 Bd6 10. Nc6 Qd7" */
const opTail=p=>{const s=Math.max(0,p.length-6);return (s?"… ":"")+p.slice(s).map((m,j)=>{const i=s+j;return i%2===0||j===0?mvLabel(i)+" "+m:m}).join(" ")};
let OPALL=false;
const opGo=(k,drill)=>{OPSEL=k;LS.set(uk("opsel"),k);OD=null;const h="train/openings/"+encodeURIComponent(k)+(drill?"/practise":"");if(location.hash.slice(1)===h)route();else location.hash=h};
const opTitle=k=>T(k[0]==="w"?"op.asW":"op.asB",{n:k.slice(2)});
const opFen=m=>{const c=new Chess();for(const s of m.split(" "))if(!s||!c.move(s))break;return c};
/* the moves that define an opening in my games: the moves all of them share, at most three a side */
function opDef(gs){if(!gs.length)return "";const a=gs.map(g=>g.moves);let n=0;while(n<6&&a.every(m=>m[n]&&m[n]===a[0][n]))n++;return a[0].slice(0,Math.max(1,n)).join(" ")}
/* a tree per opening, cached until its games or lines change (cards need "positions learned") */
function opTreeOf(k){const sig=opSig(k[0],k.slice(2)),c=OTC.get(k);if(c&&c.sig===sig)return c;const t=buildTree(k[0],k.slice(2));OTC.set(k,t);return t}
const coreOf=t=>[...t.T.values()].filter(n=>n.mine&&(n.n>=2||n.weak||n.ln));
const learnedOf=t=>coreOf(t).filter(n=>((OPS[n.k]||{}).s||0)>=OP_LEARNED).length;
function opMine(col){const m={};GAMES.filter(g=>g.color===col).forEach(g=>{const f=famOf(g.eco);(m[f]=m[f]||[]).push(g)});
 const out=Object.entries(m).filter(([,a])=>a.length>=3).sort((a,b)=>b[1].length-a[1].length).map(([f,a])=>({k:col+"|"+f,n:f,gs:a,m:opDef(a)}));
 // openings I only know from lesson lines I chose to drill
 for(const co of OPC)if(opLines(col,co.name).length&&!out.some(o=>co.re&&co.re.test(o.n)&&opLines(col,o.n).length)){const p=(OPOP&&OPOP[col]||[]).find(x=>x.c===co.id),l=opLines(col,co.name)[0];out.push({k:col+"|"+co.name,n:co.name,gs:[],m:p?p.m:l.m.split(" ").slice(0,4).join(" ")})}
 return out}
function opCard(o,col){const c=opFen(o.m),h=c.history({verbose:true}),last=h[h.length-1],t=o.gs?opTreeOf(o.k):null,ln=t?learnedOf(t):0;
 const st=o.gs?(o.gs.length?`<p class="o-st"><b>${esc(TP("op.games",o.gs.length))}</b>${esc(T("op.score",{s:Math.round(score(o.gs))}))}</p>`:`<p class="o-st"><b>${esc(T("op.fromLines"))}</b></p>`)+(ln?`<p class="o-st">${esc(TP("op.learned",ln))}</p>`:""):(o.c?`<p class="o-st"><span class="chip">${ic("graduation-cap","sm")}${esc(T("op.hasLessons"))}</span></p>`:"");
 return `<a class="ocard" href="#train/openings/${encodeURIComponent(o.k)}" data-k="${esc(o.k)}"><span class="ocard-b">${miniBoard(c.fen(),col==="b",{last:last?{from:last.from,to:last.to}:null,label:o.n})}</span><span class="ocard-t"><h3>${esc(o.n)}</h3><span class="o-mv">${esc(movesTxt(o.m.split(" ")))}</span>${st}</span></a>`}
function renderOpGal(){const col=LS.get(uk("opcol"),OPSEL?OPSEL[0]:"w");document.querySelectorAll('input[name="oCol"]').forEach(r=>r.checked=r.value===col);
 if(!OPOP){opPop().then(()=>{if(route.sec==="openings"&&OVW.v==="gal")renderOpGal()})}
 const mine=opMine(col),mn=new Set(mine.map(o=>opNorm(o.n))),pop=(OPOP&&OPOP[col]||[]).filter(p=>{const b=opNorm(p.n.split(":")[0]),f=opNorm(p.n);return ![...mn].some(x=>x.startsWith(f)||f.startsWith(x)||(x.startsWith(b)&&!p.n.includes(":")))}).map(p=>({k:col+"|"+p.n,n:p.n,m:p.m,c:p.c}));
 setHTML($("#oMine"),mine.length?`<h2 class="o-h">${esc(T("op.mine"))}</h2><div class="o-grid">${mine.map(o=>opCard(o,col)).join("")}</div>`:`<div class="o-empty">${ic("book-open")}<p>${esc(T("op.mineNone"))}</p></div>`);
 const sh=OPALL?pop:pop.slice(0,12);setHTML($("#oPop"),OPOP?sh.map(o=>opCard(o,col)).join("")+(sh.length<pop.length?`<button type="button" class="o-more" id="oMore">${esc(T("op.more",{n:pop.length-sh.length}))}</button>`:""):`<span class="skel" style="width:40%"></span>`);const mb=$("#oMore");if(mb)mb.onclick=()=>{OPALL=true;renderOpGal()}}
document.querySelectorAll('input[name="oCol"]').forEach(r=>r.onchange=()=>{LS.set(uk("opcol"),r.value);renderOpGal()});
/* "Learn the main lines": the lesson course's recommended lesson */
function opLearn(id){if(!COIDX[id])return;LCO=id;LP=null;if(route.sec==="lessons")renderLessons();else location.hash="train/lessons"}
const opCourseOf=k=>{const p=(OPOP&&OPOP[k[0]]||[]).find(x=>k.slice(2)===x.n);return p&&p.c?(TRACKS[1].courses.find(c=>c.id===p.c)?p.c:null):opCourseFor(k[0],k.slice(2))};
function renderOpPage(){const k=OVW.k,col=k[0],fam=k.slice(2),gs=OT.games,p=(OPOP&&OPOP[col]||[]).find(x=>x.n===fam),m=gs.length?opDef(gs):p?p.m:(opLines(col,fam)[0]||{m:""}).m.split(" ").slice(0,4).join(" ");
 const c=opFen(m),h=c.history({verbose:true}),last=h[h.length-1];
 $("#opBoard").innerHTML=miniBoard(c.fen(),col==="b",{last:last?{from:last.from,to:last.to}:null,label:fam});$("#opName").textContent=opTitle(k);$("#opMoves").textContent=movesTxt(m.split(" ").filter(Boolean));
 renderOpStats();const core=opCore(),co=opCourseOf(k),can=core.length>0;
 const st=LS.get(uk("opstart"),{})[OT.key],e=st?opEffect(OT.key,st):null;
 $("#oEffect").textContent=st?(e?T("op.effect",{when:fmtDay(st),a:Math.round(e.a),na:e.na,b:Math.round(e.b),nb:e.nb}):T("op.effectWait",{when:fmtDay(st)})):"";
 $("#opAct").innerHTML=(can?`<button class="pri lg" type="button" id="opPractise">${ic("play")}${esc(T("op.practise"))}</button>`:"")+(co?`<button class="lg${can?"":" pri"}" type="button" id="opLearnBtn">${ic("graduation-cap")}${esc(T("op.learn"))}</button>`:"")+(!can?`<p class="small op-why">${esc(T(co?"op.noLinesC":"op.noLines"))}</p>`:"");
 const pb=$("#opPractise");if(pb)pb.onclick=()=>opGo(k,true);const lb=$("#opLearnBtn");if(lb)lb.onclick=()=>opLearn(co);
 const W=[...OT.T.values()].filter(n=>n.weak).sort((a,b)=>b.prio-a.prio).slice(0,6);$("#opWeakBox").hidden=!can;
 $("#oWeak").innerHTML=W.length?W.map((n,i)=>{const top=Object.values(n.mv).sort((a,b)=>b.n-a.n)[0],lm=n.path.length?opFen(n.path.join(" ")).history({verbose:true}).pop():null;
  return `<button class="o-ws" type="button" data-w="${i}"><span class="ocard-b">${miniBoard(n.fen,col==="b",{last:lm?{from:lm.from,to:lm.to}:null})}</span><span class="o-mv">${esc(n.path.length?opTail(n.path):T("op.startPos"))}</span><span class="small">${esc((n.err?TP("op.wsErr",n.anN,{e:n.err}):T("op.wsScore",{s:Math.round(n.score)}))+" "+T("op.wsUsual",{mv:top?top.san:"?"}))}</span></button>`}).join(""):`<p class="small">${esc(T("op.noWeak"))}</p>`;
 $("#oWeak").querySelectorAll("[data-w]").forEach(b=>b.onclick=()=>{OSTART=W[+b.dataset.w];opGo(k,true)});renderExplorer()}
function renderOpenings(){const v=OVW.v;$("#oGal").hidden=v!=="gal";$("#oPage").hidden=v!=="page";$("#oDrill").hidden=v!=="drill";
 if(v==="gal")return renderOpGal();
 const k=OVW.k;if(OPSEL!==k){OPSEL=k;LS.set(uk("opsel"),k);OD=null}LS.set(uk("opcol"),k[0]);
 const col=k[0],fam=k.slice(2),sig=opSig(col,fam);if(!OT||OT.key!==k||OT.sig!==sig)OT=buildTree(col,fam);
 if(!OPOP)opPop().then(()=>{if(route.sec==="openings"&&OVW.k===k)renderOpenings()});
 if(v==="page")return renderOpPage();
 $("#oTitle").textContent=opTitle(k);$("#oBack").href="#train/openings/"+encodeURIComponent(k);$("#oBackL").textContent=T("op.backTo",{n:fam});
 if(OSTART){const s=OSTART;OSTART=null;opStartLine(false,OT.T.get(s.k)||s)}else if(!OD||OD.key!==OT.key||OD.gen!==GEN)opStartLine(false)}
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
const motN=k=>TX("mot."+k,MOT[k].n),endN=k=>TX("end."+k,ENDT[k]),phN=k=>TX("ph."+k,PHN[k]);
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
  if(gen!==GEN)break;g.mt=mt;DB.put([g]);if(++done%3===0&&route.sec==="lessons"&&!LP)renderLessons()}}
 catch(x){}finally{this.busy=false}if(gen===GEN&&done){if(route.sec==="lessons"&&!LP)renderLessons();if(route.sec==="home")renderHome()}}};
function wkProfile(){const an=GAMES.filter(g=>g.an).slice(-MT_GAMES),tg=an.filter(g=>g.mt&&g.mt.v===MT_V),n=tg.length,T={},PH={opening:{n:0,d:0},middlegame:{n:0,d:0},endgame:{n:0,d:0}},ET={},inc=(o,k,d)=>{const x=o[k]||(o[k]={n:0,d:0});x.n++;x.d+=d};
 for(const g of tg)for(const i in g.mt.e){const x=g.mt.e[i];inc(T,x.t[0],x.d);PH[x.ph].n++;PH[x.ph].d+=x.d;if(x.et)inc(ET,x.et,x.d)}return {n,an:an.length,T,PH,ET}}
/* where a theme is practised: a puzzle course (its chapter comes from pzRec), or the First steps lesson for new players and beginners until it's done */
const motTo=k=>{const m=MOT[k];return m.fs&&["new","beg"].includes(lvl())&&!lsDone(m.fs)?m.fs:m.to};
/* priority list: every weakness with its cost (win-% points per game) and a one-line reason; habits from what Progress measures */
function lsPriority(){const W=wkProfile(),out=[],n=W.n;if(n<3)return out;const pg=x=>x.d/n,times=k=>k===1?"once":k===2?"twice":k+" times";
 for(const k in W.T){if(k==="positional")continue;const x=W.T[k];out.push({k,name:motN(k),cost:pg(x),to:motTo(k),reason:`${times(x.n)} in your last ${n} analysed games, about ${pg(x).toFixed(1)} points a game.`})}
 for(const k in W.ET){const x=W.ET[k];if(x.n>=2)out.push({k:"end_"+k,name:endN(k),cost:pg(x)*.8,to:egCourseFor(k),reason:`${times(x.n)} you went wrong in ${ENDT[k].toLowerCase()}, about ${pg(x).toFixed(1)} points a game.`})}
 const s=stats(),B=baseSecs(),errs=[];GAMES.filter(g=>g.mt).slice(-MT_GAMES).forEach(g=>{for(const i in g.mt.e)errs.push({g,i:+i,x:g.mt.e[i]})});
 const win=errs.filter(o=>(errorsOf(o.g).find(e=>e.i===o.i)||{}).before>200);if(win.length>=2){const d=win.reduce((a,o)=>a+o.x.d,0)/n,tc={};win.forEach(o=>{const t=o.x.t[0];if(MOT[t].to)tc[t]=(tc[t]||0)+o.x.d});const top=Object.keys(tc).sort((a,b)=>tc[b]-tc[a])[0];
  out.push({k:"winning",name:"Letting winning positions slip",cost:d*.6,to:top?motTo(top):"pz-hanging",reason:`${times(win.length)} you went wrong when already clearly winning, about ${d.toFixed(1)} points a game.`})}
 if(s.time!=null&&s.time<B*.5){const quick=errs.filter(o=>{const sp=spent(o.g,o.i);return sp!=null&&sp<10}),d=quick.reduce((a,o)=>a+o.x.d,0)/n;
  if(quick.length)out.push({k:"clock",name:"Playing too fast",cost:d*.7,to:null,reason:`You use ${mmss(s.time)} of ${mmss(B)}; ${times(quick.length)} you erred after under 10 seconds of thought.`})}
 const yr=GAMES.filter(g=>g.ts>Date.now()-365*864e5),om={};yr.forEach(g=>{const k=g.color+"|"+famOf(g.eco);(om[k]=om[k]||[]).push(g)});
 const wo=Object.entries(om).filter(([,a])=>a.length>=5).map(([k,a])=>({k,a,s:score(a)})).sort((a,b)=>a.s-b.s)[0];
 if(wo&&wo.s<45)out.push({k:"opening",name:`The ${wo.k.slice(2)} as ${wo.k[0]==="w"?"White":"Black"}`,cost:(50-wo.s)*wo.a.length/Math.max(1,yr.length),to:opCourseFor(wo.k[0],wo.k.slice(2))||"openings",op:wo.k,reason:`You score ${Math.round(wo.s)}% in it over ${wo.a.length} games this year.`});
 return out.filter(o=>o.cost>0).sort((a,b)=>b.cost-a.cost)}
/* level: rating (Lichess ratings run about 250 higher than chess.com's) nudged by accuracy; the player can override it */
const LVLS=[["new","New to chess"],["beg","Beginner"],["imp","Improver"],["int","Intermediate"],["club","Club player"]];
function lvlAuto(){if(!GAMES.length)return "new";const s=stats();let r=(s.rating||0)-(P.source==="li"?250:0),i=r<400?0:r<800?1:r<1100?2:r<1400?3:4;
 if(s.nAn>=10&&s.errs!=null){if(s.errs>=4&&i>1)i--;else if(s.errs<=1.2&&i>0&&i<4)i++}return LVLS[i][0]}
const lvl=()=>(LSP.lvl&&LSP.lvl.v)||lvlAuto(),lvlName=id=>{const l=LVLS.find(l=>l[0]===id)||LVLS[1];return TX("lv."+l[0],l[1])};

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

/* ---------- OPENING COURSES ----------
   Hand-written lines, every move checked with Stockfish (within OP_TOL of the best move, except moves listed in bad: the
   opponent's mistakes in trap lines). A course (re: matches famOf names of my games) has chapters (side "w"/"b", r: the
   rating range it suits) of lessons; a lesson is one line {m: SAN moves, n: {ply: note}, bad: [plies], end: closing note},
   played twice: guided with notes, then from memory. Plus a "tactics in this opening" puzzle chapter (op-<id>.json). */
const OPC=[
 {id:"principles",name:"Opening principles",side:"",re:null,desc:"Centre, development, castling, and the traps every beginner meets.",chapters:[
  {id:"principles-1",name:"Centre, development, castling",side:"w",r:[0,1000],lessons:[
   {id:"principles-1-a",name:"Take the centre",m:"e4 e5 Nf3 Nc6 Bc4 Bc5 O-O Nf6 d3 d6 c3 O-O",n:{1:"Start with a centre pawn. It controls d5 and f5 and opens lines for your queen and bishop.",3:"Develop a knight towards the centre, attacking e5 at the same time.",5:"The bishop aims at f7, the weakest square near Black's king.",7:"Castle early: your king is safe and your rook joins the game.",9:"d3 holds e4 firmly and opens the way for your other bishop.",11:"c3 prepares d4 later. Every piece is out, the king is safe: a model start."},end:"Centre pawns, knights before bishops, castle early. Follow those three and you're never badly off after the opening."},
   {id:"principles-1-b",name:"Develop and castle with Black",side:"b",m:"e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Be7 Re1 d6 c3 O-O",n:{2:"Answer in the centre with a pawn of your own.",4:"Defend e5 and develop at the same time.",6:"Another piece out, and it attacks e4.",8:"A quiet bishop move: it gets ready for castling.",10:"d6 holds e5 for good and opens your light-squared bishop.",12:"Castled. Same recipe as White: centre, develop, king to safety."},end:"With Black the same rules apply. Don't copy every move of your opponent; ask what each of your moves does for the centre."},
   {id:"principles-1-c",name:"Don't bring the queen out early",side:"b",m:"e4 e5 Qh5 Nc6 Bc4 g6 Qf3 Nf6 Ne2 Bg7 Nbc3 d6 d3 Bg4",bad:[3],n:{3:"An early queen sortie. It attacks e5 and eyes f7.",4:"First defend e5 with a developing move.",6:"g6 blocks the attack on f7 and kicks the queen.",8:"Nf6 develops and shuts the queen out of f7. Now she has to watch out.",10:"Your bishop goes to the long diagonal: development with a purpose.",14:"Bg4 hits the queen again. Every tempo White spends on the queen, you spend developing."},end:"An early queen is a target. Develop with threats against her and you gain time for free."}]},
  {id:"principles-2",name:"Beginner traps",side:"w",r:[0,1200],lessons:[
   {id:"principles-2-a",name:"Stop Scholar's mate",side:"b",m:"e4 e5 Bc4 Nc6 Qh5 g6 Qf3 Nf6 Ne2 Bg7 d3 d6 Bg5 h6 Bxf6 Bxf6",n:{5:"The queen and bishop both aim at f7. Qxf7 would be mate.",6:"g6! Blocks the queen's line and attacks her. Not ...Nf6??, when Qxf7 is mate.",7:"Again Qxf7 is the threat.",8:"Nf6 covers the f-file and blocks the queen. f7 is safe now.",14:"h6 asks the bishop a question.",16:"Black has the two bishops and a solid position."},end:"Against an early Qh5 and Bc4, watch f7. A move like g6 or Qe7 (and later Nf6) holds everything, and the white queen becomes a target."},
   {id:"principles-2-b",name:"Légal's trap",side:"w",m:"e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6 Nxe5 Bxd1 Bxf7+ Ke7 Nd5#",bad:[8,10],n:{6:"The bishop pins the knight to the queen... or does it?",8:"A careless move. Black is too slow, and the pin is not a real one.",9:"Nxe5! Breaking the pin. If Black takes the queen, it's mate.",10:"Black grabs the queen. Better was ...dxe5, losing only a pawn.",11:"Bxf7+ and the king has one square.",13:"Nd5#. Three minor pieces mate the king."},end:"Légal's mate: a pin on the queen is only relative. When it lets you mate, you may ignore it."},
   {id:"principles-2-c",name:"Punish the early queen raid",side:"w",m:"e4 e5 Nf3 Qf6 Nc3 Nc6 Nd5 Qd8 d4 d6 Bb5 a6 Ba4",bad:[4],n:{4:"An early queen move. She takes the knight's best square and becomes a target.",5:"Develop, and get ready to hit the queen.",7:"Nd5! The queen is attacked, and so is c7.",8:"Back home: Black has spent two moves on the queen for nothing.",9:"Take the centre while Black is behind.",11:"Bb5 pins the knight and develops.",13:"White has more space and is ahead in development."},end:"An early queen gives you free moves. Develop with threats against her and grab the centre."}]}]},
 {id:"italian",name:"Italian Game",side:"",re:/Italian|Giuoco|Two Knights|Evans|Hungarian Defense|Blackburne|Fried Liver|Rousseau/,desc:"1.e4 e5 2.Nf3 Nc6 3.Bc4: quick development and pressure on f7.",chapters:[
  {id:"italian-1",name:"Giuoco Piano for White",side:"w",r:[400,1400],lessons:[
   {id:"italian-1-a",name:"c3 and d4",m:"e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+ Bd2 Bxd2+ Nbxd2 d5 exd5 Nxd5 Qb3 Nce7 O-O O-O Rfe1 c6",n:{5:"The Italian bishop: it aims at f7 and the centre.",7:"c3 prepares d4: you want a big pawn centre.",9:"d4! Now Black has to give way in the centre.",13:"Block the check with the bishop and trade it: your centre stays.",15:"Recapture towards the centre with the knight.",19:"Qb3 hits the knight on d5 and the pawn on b7.",21:"Castle: White has an active game and an isolated but useful d-pawn."},end:"In the Giuoco Piano, c3 and d4 build a centre. If Black hits back with ...d5, develop fast and use the open lines."},
   {id:"italian-1-b",name:"The slow Italian with d3",m:"e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O Re1 a6 Bb3 Ba7 h3 h6 Nbd2 Re8 Nf1 Be6 Ng3",n:{9:"d3: a quieter plan. You keep e4 safe and play slowly for d4 later.",13:"The rook supports e4 and later d4.",15:"Bb3 keeps the bishop safe from ...Na5.",17:"h3 stops ...Bg4 and ...Ng4.",19:"The knight's journey: d2, f1, g3, eyeing f5.",23:"Ng3 completes the manoeuvre. Everything is ready for d4 or Nf5."},end:"The d3 Italian is about manoeuvring: Re1, h3, Nbd2-f1-g3, then d4 at the right moment."}]},
  {id:"italian-2",name:"Two Knights Defence",side:"w",r:[800,1600],lessons:[
   {id:"italian-2-a",name:"4.d3 against the Two Knights",m:"e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Be7 O-O O-O Re1 d6 c3 Na5 Bb5 a6 Ba4 b5 Bc2 c5 Nbd2",n:{6:"Black attacks e4 at once: the Two Knights Defence.",7:"d3 defends e4 calmly. No need for sharp lines.",14:"...Na5 hunts your bishop.",15:"Bb5 first, then retreat: the bishop finds a safe home on c2.",19:"On c2 it still points at the kingside.",21:"Nbd2, then Nf1-g3 as in the slow Italian."},end:"4.d3 keeps things simple: defend e4, castle, and play the slow-Italian plan."},
   {id:"italian-2-b",name:"Answering 4.Ng5 with Black",side:"b",m:"e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6 dxc6 bxc6 Be2 h6 Nf3 e4 Ne5 Bd6",n:{7:"Ng5 attacks f7 twice.",8:"d5! Block the bishop's line to f7.",10:"Not ...Nxd5?!, which allows Nxf7 or d4 with a big attack. Na5 hits the bishop instead.",12:"c6 offers a pawn for fast development.",16:"Kick the knight.",18:"e4 gains space and time: the knight must move again.",20:"Black is a pawn down but has great development and space. This is the main line."},end:"Against 4.Ng5, play ...d5 and ...Na5, and don't recapture on d5 with the knight. Your lead in development is worth the pawn."}]},
  {id:"italian-3",name:"Meeting the Italian with Black",side:"b",r:[600,1600],lessons:[
   {id:"italian-3-a",name:"...Bc5 against the slow Italian",side:"b",m:"e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O a6 a4 Ba7 Re1 O-O h3 h6 Nbd2 Re8 b4 Be6",n:{6:"The mirror move: your bishop also eyes the weak f-pawn.",8:"Develop and attack e4.",10:"d6 holds e5 and frees your bishop.",12:"a6 gives your bishop a retreat square on a7.",14:"On a7 the bishop is safe from b4 and d4 tricks.",18:"h6 stops Bg5 and Ng5.",22:"Trade White's best bishop or make it decide. Black is fine."},end:"Against the slow Italian, mirror White's plan: ...a6, ...Ba7, ...h6 and ...Re8. Solid and active."},
   {id:"italian-3-b",name:"Don't take the bait: the Blackburne Shilling",side:"w",m:"e4 e5 Nf3 Nc6 Bc4 Nd4 Nxd4 exd4 O-O Nf6 Re1 d6 c3 Be7 cxd4 d5 exd5 Nxd5 Nc3",bad:[6],n:{6:"A trap: ...Nd4. If 4.Nxe5?? Qg5! hits the knight and g2, and Black wins.",7:"Just take the knight. Simple and good.",9:"Castle, and the rook comes to e1.",11:"Re1 protects e4 and works on the open e-file.",13:"c3 attacks the pawn on d4.",15:"Pawn back, with a lead in development.",19:"Nc3: White develops with a clear plus, and you never fell for the trap."},end:"When a move looks like it gives a pawn away for nothing, look for the trick. Against ...Nd4, Nxd4 and c3 is safe and strong."}]}]},
 {id:"ruy",name:"Ruy Lopez",side:"",re:/Ruy Lopez|Spanish/,desc:"1.e4 e5 2.Nf3 Nc6 3.Bb5: the classical fight for the centre.",chapters:[
  {id:"ruy-1",name:"The closed Ruy Lopez for White",side:"w",r:[800,1800],lessons:[
   {id:"ruy-1-a",name:"Main line to move 12",m:"e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 Nbd2",n:{5:"Bb5 attacks the knight that defends e5.",7:"Keep the pin: the bishop retreats but stays on the diagonal.",9:"Castle first: e4 looks hanging, but Black can't really take it.",11:"Re1 defends e4 for good.",15:"c3 prepares d4, and gives the bishop a home on c2.",17:"h3 stops ...Bg4 before you play d4.",19:"Keep the bishop: it will aim at Black's king.",21:"d4: the centre is complete.",23:"Nbd2, then Nf1-g3: the classic Ruy Lopez knight tour."},end:"The closed Ruy Lopez: Re1, c3, h3 and d4, then the knight goes d2-f1-g3. Slow pressure for a long time."},
   {id:"ruy-1-b",name:"The Exchange variation",m:"e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 O-O f6 d4 exd4 Nxd4 c5 Nb3 Qxd1 Rxd1",n:{7:"Bxc6: you give the bishop to change the pawn structure.",9:"Castle first: Nxe5 isn't a real threat yet, but now it is.",11:"d4 opens the centre.",13:"Recapture with the knight.",15:"Avoid ...cxd4 tricks: the knight retreats.",17:"An endgame with a healthy kingside majority for White. Black's doubled pawns can't make a passed pawn."},end:"In the Exchange variation, White plays for the endgame: four pawns against three on the kingside can make a passed pawn, Black's queenside majority can't."}]},
  {id:"ruy-2",name:"The Berlin and other tries for White",side:"w",r:[1200,2000],lessons:[
   {id:"ruy-2-a",name:"The Berlin with 4.d3",m:"e4 e5 Nf3 Nc6 Bb5 Nf6 d3 Bc5 c3 O-O O-O d6 h3 a6 Ba4 Ba7 Re1 Ne7 Nbd2 Ng6 Nf1",n:{6:"The Berlin: Black attacks e4 at once.",7:"d3 avoids the famous Berlin endgame and keeps a slow game.",9:"c3 gives the bishop a retreat square and prepares d4.",13:"h3 stops ...Bg4.",15:"Keep the bishop on the a4-e8 diagonal.",17:"Re1 and Nbd2-f1: the usual set-up.",21:"White has a solid, flexible position."},end:"4.d3 against the Berlin is like a slow Italian with the bishop on b5. Play h3, Re1 and the Nbd2-f1-g3 tour."}]},
  {id:"ruy-3",name:"The Ruy Lopez for Black",side:"b",r:[1000,2000],lessons:[
   {id:"ruy-3-a",name:"The closed main line",side:"b",m:"e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Bb7 d4 Re8 Nbd2 Bf8",n:{6:"...a6 asks the bishop to decide at once.",8:"Develop and attack e4.",10:"A calm move: you get ready to castle.",12:"b5 pushes the bishop away: now e4 really is attacked.",14:"d6 holds e5.",18:"The bishop on b7 hits e4.",20:"Re8 adds pressure on e4.",22:"Bf8 regroups: the rook and bishop now both defend e5. This is the Zaitsev set-up."},end:"Against the closed Ruy Lopez, ...b5, ...d6, ...Bb7 and ...Re8 put steady pressure on e4."},
   {id:"ruy-3-b",name:"Noah's Ark trap",side:"b",m:"e4 e5 Nf3 Nc6 Bb5 a6 Ba4 d6 d4 b5 Bb3 Nxd4 Nxd4 exd4 Qxd4 c5 Qd5 Be6 Qc6+ Bd7 Qd5 c4",bad:[15],n:{8:"...d6, the Steinitz Deferred: solid.",10:"b5 drives the bishop to b3.",12:"Nxd4 sets the trap.",15:"The mistake: White takes back with the queen.",16:"c5! Now ...c4 will trap the bishop on b3.",18:"Gain time on the queen.",22:"c4 and the bishop is caught. Black wins a piece."},end:"Noah's Ark: the bishop on b3 can be trapped by ...a6, ...b5, ...c5 and ...c4. Remember it with both colours."}]}]},
 {id:"scotch",name:"Scotch Game",side:"",re:/Scotch/,desc:"1.e4 e5 2.Nf3 Nc6 3.d4: open the centre at once.",chapters:[
  {id:"scotch-1",name:"The Scotch for White",side:"w",r:[800,1800],lessons:[
   {id:"scotch-1-a",name:"Against 4...Bc5",m:"e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Bc5 Be3 Qf6 c3 Nge7 Bc4 O-O O-O Bb6 Nc2",n:{5:"d4: White opens the centre straight away.",7:"Recapture with the knight; it sits well on d4.",9:"Be3 defends the knight and develops.",11:"c3 supports d4 again, so the knight is safe.",13:"Bc4: develop with an eye on f7.",15:"Castle. White has a free, easy game.",17:"Nc2 steps out of the pin and keeps the e3 bishop protected."},end:"Against 4...Bc5, defend d4 with Be3 and c3, then develop and castle."},
   {id:"scotch-1-b",name:"Against 4...Nf6",m:"e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5 Qe7 Qe2 Nd5 c4 Ba6 b3",n:{9:"Trade knights: Black's pawns get split.",11:"e5 kicks the knight and grabs space.",13:"Qe2 holds e5 (the pin on the e-file is gone).",15:"c4 kicks the knight again.",17:"b3 defends c4. The Mieses variation: White has space, Black has active pieces."},end:"In the Scotch with 4...Nf6, Nxc6 and e5 gain space. Keep e5 and c4 defended."}]},
  {id:"scotch-2",name:"Meeting the Scotch with Black",side:"b",r:[800,1600],lessons:[
   {id:"scotch-2-a",name:"The Scotch Four Knights",side:"b",m:"e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nc3 Bb4 Nxc6 bxc6 Bd3 d5 exd5 cxd5 O-O O-O Bg5 c6",n:{8:"Develop and attack e4.",10:"Pin the knight that defends e4.",12:"Take back towards the centre.",14:"d5: Black takes his share of the centre.",16:"Recapture: now you have a strong pawn on d5.",18:"Castle: both kings safe.",20:"c6 makes d5 rock solid. Black is equal."},end:"Against the Scotch, develop fast with ...Nf6 and ...Bb4, then strike with ...d5."}]}]},
 {id:"london",name:"London System",side:"",re:/London/,desc:"1.d4 and Bf4: the same solid set-up against almost anything.",chapters:[
  {id:"london-1",name:"The London against ...d5",side:"w",r:[400,1400],lessons:[
   {id:"london-1-a",name:"The basic set-up",m:"d4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3 Nc6 Nbd2 Bd6 Bg3 O-O Bd3 b6 Ne5",n:{3:"Bf4: the bishop comes out before e3 locks it in.",5:"e3 supports d4 and opens your other bishop.",9:"c3 holds d4: the London pyramid of pawns.",11:"Nbd2 keeps c3 for the pawn and supports e4 later.",13:"Bg3 keeps the bishop: if Black takes, your h-file opens.",15:"Bd3 aims at h7.",17:"Ne5: a strong outpost. Next comes f4 and an attack on the kingside."},end:"The London set-up: d4, Bf4, e3, Nf3, c3, Nbd2, Bd3, then Ne5 and f4 or e4. Easy to learn, hard to crack."},
   {id:"london-1-b",name:"Against ...c5 and ...Qb6",m:"d4 d5 Bf4 c5 e3 Nc6 c3 Qb6 Qb3 c4 Qxb6 axb6 Nd2 b5 a3 Nf6",n:{4:"...c5: Black attacks d4 at once.",7:"c3 holds the centre.",8:"...Qb6 attacks b2, which your bishop left behind.",9:"Qb3 meets the queen. Your b2 pawn is covered.",11:"Trade queens: the pressure on b2 is gone for good.",13:"Nd2, ready for e4 or b3 to challenge Black's queenside pawns.",15:"a3 stops ...b4. A calm, equal endgame-like middlegame."},end:"The London's weak point is b2. Against ...Qb6, Qb3 covers it, and a queen trade is fine for White."}]},
  {id:"london-2",name:"The London against ...g6",side:"w",r:[1000,1800],lessons:[
   {id:"london-2-a",name:"Against the King's Indian set-up",m:"d4 Nf6 Bf4 g6 e3 Bg7 Nf3 O-O Be2 d6 h3 c5 c3 Nc6 O-O",n:{3:"Bf4 against ...Nf6 works too.",9:"Against ...g6, the bishop is better on e2: no target on h7.",11:"h3 gives the bishop a retreat on h2 and stops ...Nh5 or ...Bg4 tricks.",13:"c3 holds d4.",15:"Castle. Black's bishop on g7 bites on granite."},end:"Against ...g6, play Be2 and h3, keep d4 solid and castle."}]},
  {id:"london-3",name:"Meeting the London with Black",side:"b",r:[600,1600],lessons:[
   {id:"london-3-a",name:"...c5 and ...Qb6",side:"b",m:"d4 d5 Bf4 c5 e3 Nc6 c3 Qb6 Qb3 c4 Qxb6 axb6 Nd2 b5 a3 Nf6",n:{4:"...c5! The quickest way to hit d4.",8:"...Qb6 targets b2, which the bishop left undefended.",10:"c4 gains space and hits the queen.",12:"Recapture: your rook gets the open a-file.",14:"b5 and ...b4 next: a queenside pawn storm.",16:"Develop. Black has a pleasant game."},end:"Against the London, ...c5 and ...Qb6 hit b2 straight away. After the queen trade your queenside pawns roll forward."}]}]},
 {id:"qg",name:"Queen's Gambit",side:"",re:/Queen.?s Gambit|Slav/,desc:"1.d4 d5 2.c4: White offers a pawn for the centre.",chapters:[
  {id:"qg-1",name:"Against the Declined",side:"w",r:[800,1600],lessons:[
   {id:"qg-1-a",name:"Bg5 and the minority attack plan",m:"d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 Nbd7 Rc1 c6 Bd3 dxc4 Bxc4 Nd5 Bxe7 Qxe7 O-O",n:{3:"c4: the Queen's Gambit. You attack d5 with a wing pawn.",7:"Bg5 pins the knight that defends d5.",9:"e3 opens your other bishop.",13:"Rc1: the rook works on the c-file.",15:"Bd3, waiting for Black to take on c4.",17:"Black took on c4, so you recapture and gain a tempo.",19:"Trade on e7.",21:"Castle. White has easy development."},end:"Against the Declined: Nc3, Bg5, e3, Nf3, Rc1 and Bd3. Black is solid but a bit passive."}]},
  {id:"qg-2",name:"Against the Slav and the Accepted",side:"w",r:[1000,1800],lessons:[
   {id:"qg-2-a",name:"The main-line Slav",m:"d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 e3 e6 Bxc4 Bb4 O-O O-O Qe2",n:{4:"The Slav: Black defends d5 with the c-pawn and keeps the light bishop free.",8:"Black takes on c4.",9:"a4 stops ...b5, which would hold the pawn.",11:"e3 and Bxc4 win the pawn back.",15:"Castle.",17:"Qe2 and e4 next: White gets the central break."},end:"Against the Slav: a4 stops ...b5, then e3 and Bxc4 win the pawn back with a good centre."},
   {id:"qg-2-b",name:"Against the Accepted, and punishing ...b5",m:"d4 d5 c4 dxc4 e3 b5 a4 c6 axb5 cxb5 Qf3",bad:[6,8,10],n:{4:"Black takes the pawn: the Queen's Gambit Accepted.",5:"e3 opens the bishop: Bxc4 is coming.",6:"Black tries to hold the pawn. That's a mistake.",7:"a4 hits the b5 pawn.",8:"...c6 props up b5, but the pawn on c6 will be pinned against the rook.",9:"Take: ...cxb5 would open the long diagonal to a8.",10:"Black takes back, and the rook on a8 is undefended.",11:"Qf3! attacks the rook on a8, and the a-file is open too. White wins material."},end:"In the Queen's Gambit Accepted, Black can't keep the pawn. If he tries with ...b5, a4 and Qf3 punish it."}]}]},
 {id:"scandinavian",name:"Scandinavian Defence",side:"b",re:/Scandinavian|Center Counter|Centre Counter/,desc:"1.e4 d5: take on the centre at once.",chapters:[
  {id:"scandinavian-1",name:"2...Qxd5 3.Nc3 Qa5",side:"b",r:[400,1400],lessons:[
   {id:"scandinavian-1-a",name:"The main line",side:"b",m:"e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5 Bd2 e6 Qe2 Bb4",n:{2:"d5: challenge e4 at once.",4:"Recapture with the queen. She will lose a tempo, but she's safe.",6:"Qa5: out of the way, and she pins the knight after d4.",8:"Develop.",10:"c6 gives the queen a retreat on c7 and holds d5.",12:"The bishop comes out before ...e6.",14:"e6 completes the solid shell.",16:"Bb4: active development. Black is fine."},end:"In the Scandinavian, after ...Qa5, play ...Nf6, ...c6, ...Bf5 and ...e6. A solid, easy set-up."}]},
  {id:"scandinavian-2",name:"2...Nf6",side:"b",r:[1000,1800],lessons:[
   {id:"scandinavian-2-a",name:"The modern 2...Nf6",side:"b",m:"e4 d5 exd5 Nf6 d4 Nxd5 Nf3 g6 c4 Nb6 Nc3 Bg7 h3 O-O Be3 Nc6",n:{4:"...Nf6: take the pawn back with the knight later.",6:"Recapture.",8:"Fianchetto: the bishop on g7 will hit d4.",10:"The knight retreats; White has a broad centre to aim at.",12:"Bishop to the long diagonal.",16:"...Nc6 piles up on d4. Black attacks White's centre with pieces."},end:"With 2...Nf6, White gets a centre and Black attacks it with ...g6, ...Bg7 and ...Nc6."}]}]},
 {id:"caro",name:"Caro-Kann Defence",side:"b",re:/Caro.?Kann/,desc:"1.e4 c6: solid, with a free light-squared bishop.",chapters:[
  {id:"caro-1",name:"The Advance variation",side:"b",r:[400,1400],lessons:[
   {id:"caro-1-a",name:"...Bf5 and ...e6",side:"b",m:"e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5 Be3 Nd7 O-O Ne7 c4 dxc4",n:{2:"c6 prepares ...d5.",4:"d5: challenge the centre.",6:"Bf5: the bishop comes out before ...e6 locks it in. That's the point of the Caro-Kann.",8:"e6 builds the shell.",10:"c5 attacks White's pawn chain at its base.",12:"Develop, keeping an eye on e5.",14:"The knight goes to e7 and then g6 or c6.",16:"Take: White's centre has been broken up."},end:"Against the Advance: ...Bf5, ...e6 and ...c5. Attack the base of White's pawn chain."}]},
  {id:"caro-2",name:"The Classical variation",side:"b",r:[800,1600],lessons:[
   {id:"caro-2-a",name:"3.Nc3 dxe4 4.Nxe4 Bf5",side:"b",m:"e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7 h5 Bh7 Bd3 Bxd3 Qxd3 e6 Bd2 Ngf6 O-O-O Be7",n:{6:"Take on e4.",8:"Bf5 hits the knight.",10:"Keep the bishop on the diagonal.",12:"...h6 gives the bishop a safe retreat after h5.",14:"...Nd7 stops Ne5.",18:"Trade the bishops: your best piece for theirs.",22:"Develop and get ready to castle.",24:"Black is solid. The main line of the Caro-Kann."},end:"In the Classical: ...Bf5-g6-h7, ...Nd7, ...Bxd3, ...e6 and ...Ngf6. Solid and sound."},
   {id:"caro-2-b",name:"Avoid the Nd6 mate",side:"b",m:"e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nd7 Qe2 Ndf6 Nxf6+ Nxf6 Nf3 Bg4",n:{8:"...Nd7: a solid alternative to ...Bf5.",9:"Qe2 sets a famous trap.",10:"Not 5...Ngf6??, when Nd6 is mate: the e7 pawn is pinned by the queen and can't take. Play ...Ndf6.",12:"Recapture.",14:"Develop with a pin. Black is fine."},end:"After 5.Qe2 in this line, play ...Ndf6. 5...Ngf6?? 6.Nd6 is one of the shortest mates in chess."}]},
  {id:"caro-3",name:"The Exchange and Panov",side:"b",r:[1000,2000],lessons:[
   {id:"caro-3-a",name:"The Exchange variation",side:"b",m:"e4 c6 d4 d5 exd5 cxd5 Bd3 Nc6 c3 Nf6 Bf4 Bg4 Qb3 Qd7 Nd2 e6 Ngf3 Bd6",n:{6:"Recapture: a symmetrical pawn structure.",8:"Develop and watch d4.",10:"Another piece out.",12:"Bg4: the bishop comes out actively.",14:"Defend b7.",18:"Black is fully developed and equal."},end:"In the Exchange Caro-Kann, develop with ...Nc6, ...Nf6, ...Bg4, ...e6 and ...Bd6."},
   {id:"caro-3-b",name:"The Panov Attack",side:"b",m:"e4 c6 d4 d5 exd5 cxd5 c4 Nf6 Nc3 e6 Nf3 Bb4 cxd5 Nxd5 Qc2 Nc6",n:{7:"c4: White goes for an isolated d-pawn position.",8:"Develop.",10:"e6 and ...Bb4: pressure on c3.",14:"Recapture with the knight; d5 is a great square.",16:"Black blockades d5 and puts pressure on d4."},end:"Against the Panov, blockade d5 and put pressure on the isolated d4 pawn."}]}]},
 {id:"french",name:"French Defence",side:"b",re:/French/,desc:"1.e4 e6: a solid shell, then counterattack the centre.",chapters:[
  {id:"french-1",name:"The Advance variation",side:"b",r:[400,1400],lessons:[
   {id:"french-1-a",name:"...c5, ...Nc6 and ...Qb6",side:"b",m:"e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6 a3 c4 Nbd2 Bd7",n:{2:"e6 prepares ...d5.",6:"c5! Attack the base of White's pawn chain at once.",8:"More pressure on d4.",10:"Qb6: a third attacker on d4, and b2 is hit too.",12:"c4 gains space on the queenside.",14:"Develop, and get ready for ...Na5 and ...Ne7. The queenside is Black's."},end:"Against the Advance: ...c5, ...Nc6 and ...Qb6, all aimed at d4."}]},
  {id:"french-2",name:"The Exchange and the Rubinstein",side:"b",r:[800,1600],lessons:[
   {id:"french-2-a",name:"The Exchange variation",side:"b",m:"e4 e6 d4 d5 exd5 exd5 Nf3 Nf6 Bd3 Bd6 O-O O-O c3 Bg4",n:{6:"Symmetrical, and your light bishop is free.",8:"Develop.",10:"Mirror the bishop.",12:"Castle.",14:"Bg4: active, and it pins the knight. Black is equal."},end:"The Exchange French is quiet: develop actively with ...Bd6, ...O-O and ...Bg4."},
   {id:"french-2-b",name:"The Rubinstein against 3.Nc3",side:"b",m:"e4 e6 d4 d5 Nc3 dxe4 Nxe4 Nd7 Nf3 Ngf6 Nxf6+ Nxf6 Bd3 c5 dxc5 Bxc5",n:{6:"...dxe4: the Rubinstein. Simple and solid.",8:"Nd7 prepares ...Ngf6 so you can recapture with a knight.",10:"Challenge the e4 knight.",12:"Recapture.",14:"c5 frees your game.",16:"Black is fully free and equal."},end:"In the Rubinstein: ...dxe4, ...Nd7, ...Ngf6 and ...c5. Your pieces breathe easily."}]},
  {id:"french-3",name:"The Winawer",side:"b",r:[1400,2000],lessons:[
   {id:"french-3-a",name:"The poisoned pawn",side:"b",m:"e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7 Qg4 Qc7 Qxg7 Rg8 Qxh7 cxd4 Ne2 Nbc6 f4 Bd7",n:{6:"Bb4 pins the knight: the Winawer.",8:"c5 attacks d4.",10:"Take the knight: White gets the two bishops but doubled pawns.",12:"Ne7 heads for f5 or g6.",14:"Let White take on g7: you get huge pressure on c3 and d4.",16:"The rook takes the g-file.",18:"Take on d4.",20:"Develop with pressure on the centre.",22:"Bd7 and ...O-O-O: a sharp fight with chances for both."},end:"The Winawer's poisoned pawn: give the kingside pawns, take the centre. Sharp, for 1600 and up."}]}]},
 {id:"sicilian",name:"Sicilian Defence",side:"b",re:/Sicilian/,desc:"1.e4 c5: the fighting answer to 1.e4.",chapters:[
  {id:"sicilian-1",name:"The Alapin (2.c3)",side:"b",r:[600,1400],lessons:[
   {id:"sicilian-1-a",name:"2...Nf6",side:"b",m:"e4 c5 c3 Nf6 e5 Nd5 d4 cxd4 Nf3 Nc6 cxd4 d6 Bc4 Nb6 Bb5 dxe5 Nxe5 Bd7",n:{2:"c5: fight for d4 from the side.",4:"Nf6 attacks e4 at once, before d4 comes.",6:"The knight is happy on d5.",8:"Trade a wing pawn for a centre pawn.",10:"Develop and pressure d4.",12:"d6 strikes at e5.",14:"Retreat; the knight eyes c4 and d5.",16:"Take: White's centre is gone.",18:"Develop and break the pin. Black is fine."},end:"Against the Alapin: ...Nf6, ...Nd5, ...cxd4, ...Nc6 and ...d6. Attack White's centre before it settles."}]},
  {id:"sicilian-2",name:"Anti-Sicilians",side:"b",r:[800,1600],lessons:[
   {id:"sicilian-2-a",name:"3.Bb5+",side:"b",m:"e4 c5 Nf3 d6 Bb5+ Bd7 Bxd7+ Qxd7 O-O Nc6 c3 Nf6 Re1 e6 d4 cxd4 cxd4 d5 e5 Ne4",n:{4:"d6: the Najdorf move order.",6:"Block with the bishop and offer a trade.",8:"Recapture with the queen.",10:"Develop.",14:"e6 and ...d5 next.",16:"Trade on d4.",18:"d5: Black claims the centre.",20:"Ne4: an active knight. Black is comfortable."},end:"Against 3.Bb5+: ...Bd7, trade, then ...Nc6, ...e6 and ...d5."},
   {id:"sicilian-2-b",name:"The Grand Prix Attack",side:"b",m:"e4 c5 Nc3 d6 f4 Nc6 Nf3 g6 Bb5 Bd7 O-O Bg7 d3 a6 Bxc6 Bxc6",n:{4:"d6, keeping your options.",6:"Develop.",8:"Fianchetto: your bishop on g7 is a great defender and attacker.",10:"Block the pin.",12:"Bishop to the long diagonal.",14:"Ask the bishop.",16:"Black has the two bishops. Comfortable."},end:"Against f4 lines, ...Nc6, ...g6 and ...Bg7 give a solid, active position."}]},
  {id:"sicilian-3",name:"The Open Sicilian: Najdorf",side:"b",r:[1400,2000],lessons:[
   {id:"sicilian-3-a",name:"6.Be3: the English Attack",side:"b",m:"e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7 Qd2 O-O O-O-O Nbd7 g4 b5",n:{6:"Trade a wing pawn for a centre pawn.",8:"Attack e4.",10:"a6: the Najdorf. It stops Nb5 and Bb5, and prepares ...b5.",12:"...e5 kicks the knight and takes space.",14:"The bishop eyes the queenside and d5.",16:"Develop and castle.",20:"Nbd7 supports ...b5 and ...Nb6.",22:"b5! Race on the queenside: attack White's king."},end:"In the Najdorf English Attack, both sides castle opposite and race. Push ...b5 fast."},
   {id:"sicilian-3-b",name:"6.Be2: the classical line",side:"b",m:"e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5 Nb3 Be7 O-O O-O Be3 Be6 Qd2 Nbd7 a4 Rc8",n:{12:"...e5 again: the knight must retreat.",14:"Develop calmly.",16:"Castle.",18:"Bishop to e6, eyeing d5.",20:"Knight to d7, then ...Nb6 or ...Rc8.",22:"Rc8: the rook works on the c-file. Black is fine."},end:"Against 6.Be2, play ...e5, ...Be7, ...O-O, ...Be6, ...Nbd7 and ...Rc8. Fight for d5."}]}]},
 {id:"qgd",name:"Queen's Gambit Declined & Slav",side:"b",re:/Queen.?s Gambit Declined|Slav|Semi-Slav/,desc:"Answering 1.d4 d5 2.c4 with a solid ...e6 or ...c6.",chapters:[
  {id:"qgd-1",name:"The Queen's Gambit Declined",side:"b",r:[800,1600],lessons:[
   {id:"qgd-1-a",name:"The Tartakower",side:"b",m:"d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6 cxd5 Nxd5 Bxe7 Qxe7 Nxd5 exd5",n:{4:"e6: defend d5 solidly.",6:"Develop.",8:"Unpin.",10:"Castle.",12:"h6 asks the bishop to decide.",14:"b6 and ...Bb7: the Tartakower.",16:"Recapture with the knight to trade pieces.",20:"Black has a solid pawn on d5. Equal."},end:"In the QGD, ...e6, ...Nf6, ...Be7, ...O-O, ...h6 and ...b6. Solid as a rock."},
   {id:"qgd-1-b",name:"The elephant trap",side:"b",m:"d4 d5 c4 e6 Nc3 Nf6 Bg5 Nbd7 cxd5 exd5 Nxd5 Nxd5 Bxd8 Bb4+ Qd2 Bxd2+ Kxd2 Kxd8",bad:[11],n:{8:"Nbd7. Now d5 looks easy to win, because the knight on f6 is pinned...",11:"White grabs the d5 pawn: a mistake.",12:"Take! Bxd8 looks like it wins your queen...",14:"...but Bb4+ wins it back with interest.",18:"Black is a piece up."},end:"The elephant trap: in the QGD, the pin on f6 isn't real when ...Bb4+ is there."}]},
  {id:"qgd-2",name:"The Slav",side:"b",r:[1000,1800],lessons:[
   {id:"qgd-2-a",name:"The main-line Slav",side:"b",m:"d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 e3 e6 Bxc4 Bb4 O-O Nbd7 Qe2 Bg6 e4 O-O",n:{4:"c6: defend d5 and keep your light bishop free.",8:"Take on c4.",10:"Bf5: the bishop comes out before ...e6.",12:"e6 builds the shell.",14:"Pin the knight.",16:"Develop.",18:"Bg6 steps away from e4.",20:"Castle. Black is solid."},end:"In the Slav: ...dxc4, ...Bf5, ...e6, ...Bb4 and ...Nbd7."}]}]},
 {id:"english",name:"English & Réti",side:"",re:/English|Zukertort|Reti|Réti/,desc:"1.c4 and 1.Nf3: flank openings for both colours.",chapters:[
  {id:"english-1",name:"Against 1.c4 with Black",side:"b",r:[800,1600],lessons:[
   {id:"english-1-a",name:"The reversed Sicilian",side:"b",m:"c4 e5 Nc3 Nf6 Nf3 Nc6 g3 Bb4 Bg2 O-O O-O e4 Ng5 Bxc3 bxc3 Re8",n:{2:"e5: take the centre White left alone.",4:"Develop.",6:"Defend e5.",8:"Pin the knight.",12:"e4 kicks the knight away.",14:"Take on c3: White's pawns are damaged.",16:"Re8 holds e4. Black is comfortable."},end:"Against the English, ...e5, ...Nf6, ...Nc6 and ...Bb4: a reversed Sicilian with a useful extra tempo for White, and still fine for Black."}]},
  {id:"english-2",name:"Against 1.Nf3 with Black",side:"b",r:[800,1600],lessons:[
   {id:"english-2-a",name:"...d5 and ...c5",side:"b",m:"Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 d3 O-O Nbd2 c5 e4 Nc6",n:{2:"d5: take the centre.",4:"Develop.",6:"A solid shell.",8:"Bishop out, ready to castle.",10:"Castle.",12:"c5 grabs more space.",14:"Nc6. Black has a fine centre."},end:"Against 1.Nf3 and g3, build a classical centre with ...d5, ...e6 and ...c5."}]},
  {id:"english-3",name:"The English for White",side:"w",r:[1200,2000],lessons:[
   {id:"english-3-a",name:"1.c4 e5 2.Nc3 and g3",m:"c4 e5 Nc3 Nf6 g3 d5 cxd5 Nxd5 Bg2 Nb6 Nf3 Nc6 O-O Be7 d3 O-O a3",n:{1:"c4 controls d5 from the side.",3:"Develop.",5:"Fianchetto: the bishop on g2 rules the long diagonal.",7:"Trade a wing pawn for a centre pawn.",9:"The bishop hits the knight on d5.",11:"Develop.",13:"Castle.",17:"a3 and b4: White expands on the queenside."},end:"The English is a reversed Sicilian: g3, Bg2, Nf3, O-O, d3, then a3 and b4."}]}]}];

/* a course from OPC: line chapters (lessons played twice: guided, then from memory; a placement check of key moves from the
   chapter's lines) plus "tactics in this opening" (puzzles from op-<id>.json, all bands as one pool, rg: its rating range) */
const OP_TAC=["These positions come from real games in this opening. Look for checks, captures and threats first.","Many of these tactics grow out of the typical piece placement of this opening. Learn them and you'll spot them in your games.","Harder ones now. Take your time and calculate to the end."];
function opTest(ch){const cand=[];ch.lessons.forEach((l,j)=>{const c=new Chess(),side=l.side||ch.side;l.m.split(" ").forEach((s,i)=>{const fen=c.fen(),m=c.move(s);if(m&&(i%2===0)===(side==="w")&&l.n[i+1]&&!(l.bad||[]).includes(i+1))cand.push({j,i,f:fen,s:[m.from+m.to+(m.promotion||"")],x:1,n:`${l.name}: play the move from the line.`})})});
 const out=[];ch.lessons.forEach((l,j)=>{const c=cand.filter(x=>x.j===j);if(c.length)out.push(c[c.length-1])});cand.sort((a,b)=>b.i-a.i).forEach(x=>{if(out.length<PZ_T&&!out.includes(x))out.push(x)});return out.slice(0,PZ_T)}
const opCourse=c=>{const tp={id:"op-"+c.id,ask:"Find the best move.",n:OP_TAC},rg=c.id==="principles"?[400,1400]:[400,2000];
 return {id:"op-"+c.id,name:c.name,desc:c.desc,lv:["new","beg","imp","int","club"],op:c,chapters:c.chapters.map(ch=>({id:ch.id,name:`${c.name} · ${ch.name}`,short:ch.name,side:ch.side,r:ch.r,op:c,test:opTest(ch),
  lessons:ch.lessons.map(l=>{const L={...l,side:l.side||ch.side};L.steps=[{ln:L},{ln:L,mem:1}];return L})})).concat([{id:c.id+"-t",name:`${c.name} · tactics`,short:"Tactics in this opening",tac:1,all:1,rg,band:0,pz:tp,test:Array(PZ_T).fill(null),
  lessons:PZL.map(([s,n,o],j)=>({id:`${c.id}-t-${s}`,name:n,note:OP_TAC[j],off:o,band:0,pz:tp,steps:Array(PZ_N).fill(null)}))}])}};
/* opening names (lichess-org/chess-openings, CC0) for the positions of the lines above, vendored by tools/build-openings.js */
const OPN_FILE="vendor/chess-openings-2026-11/names.json";let OPN=null;
const opnKey=fen=>fen.split(" ").slice(0,3).join(" "),opName=fen=>OPN&&OPN[opnKey(fen)]||null;
function opNames(){if(!OPN)OPN=fetch(OPN_FILE).then(r=>r.ok?r.json():{}).catch(()=>({})).then(j=>OPN=j);return Promise.resolve(OPN)}

/* ---------- ENDGAME COURSES ----------
   Hand-written lessons (one pattern each, with a teaching page) of guided positions: "find the move" steps (as in First steps) and
   "play it out" steps {f, play: "win"|"draw", max: my moves, n, ok} against Stockfish (depth by level, EG_D). Each course with puzzles
   (pz) also gets a chapter per rating band (EGB) from eg-<pz>.json. et: the weakness-profile ending types (endType) it trains. */
const EGB=[[400,1000,"Up to 1000"],[1000,1200,"1000–1200"],[1200,1400,"1200–1400"],[1400,1600,"1400–1600"],[1600,1800,"1600–1800"],[1800,2200,"1800–2200"]];
const EG_D={new:6,beg:8,imp:10,int:12,club:14};
const EGC=[
 {id:"mates",name:"Basic mates",et:[],desc:"Checkmate with queen, rook, or two rooks against a lone king.",chapters:[
  {id:"mates-1",name:"Mating the lone king",r:[0,1200],lessons:[
   {id:"mates-q",name:"Queen and king",steps:[
    {f:"8/8/8/4k3/8/8/8/3QK3 w - - 0 1",s:["d1d7"],n:"Box the king in. A queen move that takes away a whole rank or file is a good start.",ok:"The king's box is getting smaller."},
    {f:"k7/8/1K6/8/8/8/8/2Q5 w - - 0 1",g:"mate",n:"Mate in one. Careful: one natural queen move here is stalemate.",ok:"Checkmate, not stalemate: the king is in check."},
    {f:"8/8/8/4k3/8/8/8/3QK3 w - - 0 1",play:"win",max:20,n:"Now the whole thing: checkmate the king. Shrink the box with the queen, then bring your king to help.",ok:"Queen and king did it together."}]},
   {id:"mates-r",name:"Rook and king",steps:[
    {f:"3k4/8/3K4/8/8/8/8/7R w - - 0 1",g:"mate",n:"The kings face each other. Find the mate.",ok:"The rook mates on the back rank while your king covers the escape squares."},
    {f:"3k4/8/4K3/8/8/8/8/7R w - - 0 1",s:["h1c1"],n:"No mate yet: the black king could slip out via c7. Take the c-file away first.",ok:"Now ...Ke8 and Rc8 is mate."},
    {f:"8/8/8/4k3/8/8/8/R3K3 w - - 0 1",play:"win",max:35,n:"Checkmate with king and rook. Cut the king off with the rook, bring your king opposite it, and check when the kings face each other.",ok:"The most useful mate of all."}]},
   {id:"mates-rr",name:"The two-rook ladder",steps:[
    {f:"8/8/8/8/7k/R7/1R6/K7 w - - 0 1",s:["b2b4"],n:"The ladder: one rook guards a rank, the other checks on the next rank up.",ok:"Each check pushes the king one rank back."},
    {f:"8/8/8/4k3/8/8/R7/1R5K w - - 0 1",play:"win",max:12,n:"Climb the ladder to mate. If the king attacks a rook, move that rook to the far side of the board.",ok:"The ladder never fails."}]}]}]},
 {id:"kp",name:"King and pawn endings",et:["kp"],pz:"kp",desc:"The square, opposition, key squares, outside passers and breakthroughs.",chapters:[
  {id:"kp-1",name:"The basics",r:[400,1400],lessons:[
   {id:"kp-sq",name:"The square rule",steps:[
    {f:"8/8/8/8/k4P2/8/8/6K1 w - - 0 1",s:["f4f5"],n:"Draw the pawn's square in your mind: from f4 up to f8, four squares wide. Black's king on a4 is outside it.",ok:"Black's king can't catch the pawn."},
    {f:"8/8/8/8/1k3P2/8/8/6K1 b - - 0 1",s:["b4c4"],n:"You're Black now. Step into the pawn's square and you catch it.",ok:"Inside the square: the pawn won't make it."},
    {f:"8/8/8/8/k4P2/8/8/6K1 w - - 0 1",play:"win",max:8,n:"Run with the pawn and make a queen.",ok:"The square rule said so."}]},
   {id:"kp-opp",name:"The opposition",steps:[
    {f:"8/8/4k3/8/8/4K3/4P3/8 b - - 0 1",s:["e6e5"],n:"You're Black. Take the opposition: kings facing each other with one square between, and White must give way.",ok:"White can't make progress."},
    {f:"8/8/4k3/8/8/4K3/4P3/8 b - - 0 1",play:"draw",max:15,n:"Hold the draw. Keep the opposition, and when the pawn comes, stay in front of it.",ok:"The king in front of the pawn holds."},
    {f:"4k3/8/8/8/8/4K3/4P3/8 w - - 0 1",s:["e3d4"],n:"Now you're White: king in front of the pawn first, pawn later.",ok:"Your king leads the way."},
    {f:"4k3/8/8/8/8/4K3/4P3/8 w - - 0 1",play:"win",max:25,n:"Win it: king in front of the pawn, take the opposition, and push only when your king controls the squares ahead.",ok:"King first, pawn later: that's the method."}]}]},
  {id:"kp-2",name:"Key squares and the outside passer",r:[800,1800],lessons:[
   {id:"kp-key",name:"Key squares",steps:[
    {f:"8/8/8/3k4/8/4K3/4P3/8 w - - 0 1",s:["e3f4"],n:"The key squares of a pawn on e2 are d4, e4 and f4. Get your king onto one and the pawn queens, wherever Black's king is.",ok:"On a key square: this wins."},
    {f:"8/8/8/3k4/8/4K3/4P3/8 w - - 0 1",play:"win",max:25,n:"Play it out. Keep your king ahead of the pawn on its key squares.",ok:"The key squares did the thinking."}]},
   {id:"kp-out",name:"The outside passed pawn",steps:[
    {f:"8/6pp/5k2/8/P7/8/6PP/6K1 w - - 0 1",s:["a4a5"],n:"Your a-pawn is far from everything. Push it: Black's king has to chase it.",ok:"The black king must run to the a-file and leave its own pawns."},
    {f:"8/6pp/5k2/8/P7/8/6PP/6K1 w - - 0 1",play:"win",max:30,n:"Win it: use the outside pawn as a decoy, then win Black's kingside pawns or queen.",ok:"The decoy worked."}]}]},
  {id:"kp-3",name:"Breakthroughs",r:[1400,2200],lessons:[
   {id:"kp-brk",name:"The pawn breakthrough",steps:[
    {f:"7k/ppp5/8/PPP5/8/8/8/K7 w - - 0 1",s:["b5b6"],x:1,n:"Three pawns against three, kings far away. One pawn move breaks through.",ok:"After ...axb6 c6, or ...cxb6 a6, a pawn runs through."},
    {f:"7k/ppp5/8/PPP5/8/8/8/K7 w - - 0 1",play:"win",max:10,n:"Play the breakthrough and queen.",ok:"Breakthrough!"}]}]}]},
 {id:"rook",name:"Rook endings",et:["rook"],pz:"rook",desc:"Lucena, Philidor, rooks behind passers, cutting off the king, active rooks.",chapters:[
  {id:"rook-1",name:"Rook ending principles",r:[1000,1800],lessons:[
   {id:"rook-behind",name:"Rooks behind passed pawns",steps:[
    {f:"1r4k1/5ppp/8/P7/8/8/5PPP/4R1K1 w - - 0 1",s:["e1a1"],n:"Rooks belong behind passed pawns: from behind, the rook gets stronger with every step the pawn takes.",ok:"Now every push makes your rook stronger and Black's weaker."}]},
   {id:"rook-cut",name:"Cutting off the king",steps:[
    {f:"r7/8/2k5/4K3/4P3/8/8/7R w - - 0 1",s:["h1h6"],n:"Use your rook as a fence: check along the sixth rank and Black's king is cut off from your pawn.",ok:"Cut off, Black's king can only watch."},
    {f:"1r6/8/2k5/4K3/4P3/8/8/7R w - - 0 1",play:"win",max:30,n:"Win it. Keep Black's king away from your pawn with your rook and king, and promote.",ok:"The king never got back in time."}]},
   {id:"rook-act",name:"Active rook, passive rook",steps:[
    {f:"R7/P5k1/8/8/8/6K1/r7/8 b - - 0 1",s:["a2a4"],n:"You're Black. White's rook is stuck in front of its pawn. Keep your rook active behind the pawn, and your king on g7 or h7.",ok:"An active rook draws this."},
    {f:"R7/P4pk1/6p1/8/8/6P1/r4PK1/8 b - - 0 1",play:"draw",max:15,n:"Hold the draw: rook behind the pawn, king near g7. Don't let your rook become passive.",ok:"The active rook saved you."}]}]},
  {id:"rook-2",name:"Lucena and Philidor",r:[1400,2200],lessons:[
   {id:"rook-luc",name:"The Lucena position",steps:[
    {f:"1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1",s:["c1d1"],n:"White's king is stuck in front of its pawn. First drive Black's king away with a check.",ok:"The king has to step away from the pawn."},
    {f:"1K6/1P2k3/8/8/8/8/r7/3R4 w - - 0 1",s:["d1d4"],n:"Now build the bridge: rook to the fourth rank. It will block the checks later.",ok:"The bridge is ready."},
    {f:"1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1",play:"win",max:20,n:"Play the whole Lucena: check, bridge, king out, block the checks with your rook, promote.",ok:"That's the Lucena method."}]},
   {id:"rook-phil",name:"The Philidor position",steps:[
    {f:"4k3/8/r7/4PK2/8/8/8/1R6 b - - 0 1",s:["e8e7"],n:"You're Black. Your rook on the sixth rank keeps White's king out. Just wait: a king move, or a rook move along the rank.",ok:"White's king can't reach the sixth rank."},
    {f:"4k3/8/1r2P3/5K2/8/8/8/R7 b - - 0 1",s:["b6b3"],n:"White has pushed e6, so the king has no shelter from behind any more. Drop your rook far back to check from behind. Not to b1, though: Ra8+ would mate you on the back rank.",ok:"Endless checks from behind: a draw."},
    {f:"4k3/8/r7/4PK2/8/8/8/1R6 b - - 0 1",play:"draw",max:15,n:"Hold the Philidor: rook on the sixth rank until the pawn reaches e6, then check from behind.",ok:"Philidor holds."}]}]}]},
 {id:"minor",name:"Minor-piece endings",et:["minor"],pz:"minor",desc:"Good and bad bishops, the wrong bishop, knights against pawns, bishop against knight.",chapters:[
  {id:"minor-1",name:"Drawing with less",r:[1000,1800],lessons:[
   {id:"minor-wrong",name:"The wrong-coloured bishop",steps:[
    {f:"7k/8/7P/6K1/8/8/2B5/8 b - - 0 1",s:["h8g8"],n:"You're Black, two pawns and a bishop down, and it's still a draw: the light bishop can't control h8, the corner your king sits in.",ok:"Just stay near the corner."},
    {f:"7k/8/7P/6K1/8/8/2B5/8 b - - 0 1",play:"draw",max:12,n:"Hold it: shuffle your king between g8 and h8 (and g7 when it's free).",ok:"A fortress: the wrong-coloured bishop can't win."}]},
   {id:"minor-n",name:"Knight against pawns",steps:[
    {f:"8/8/8/8/8/1p6/k7/3K1N2 w - - 0 1",s:["f1d2"],n:"Stop the pawn before it queens: from d2 the knight covers b1 and b3.",ok:"Knight and king together hold the pawn."},
    {f:"8/8/8/8/8/1p6/k7/3K1N2 w - - 0 1",play:"draw",max:12,n:"Hold the draw: keep the knight on the squares in front of the pawn and bring your king.",ok:"The pawn never got through."}]}]},
  {id:"minor-2",name:"Bishops and knights",r:[1400,2200],lessons:[
   {id:"minor-gb",name:"Good bishop, bad bishop",steps:[
    {f:"8/2k5/1p1b4/pPpPp3/P1P1P3/3K4/5B2/8 w - - 0 1",s:["f2g3"],n:"Black's pawns are all on dark squares, the colour of Black's bishop: it's a bad bishop. Yours attacks them.",ok:"The black pawns are targets."},
    {f:"8/3k4/1p1b4/pPpPp3/P1P1P3/3K4/5B2/8 w - - 0 1",play:"win",max:40,n:"Win it: bring your king round to the kingside, attack the pawns, and use zugzwang.",ok:"The good bishop won."}]},
   {id:"minor-bn",name:"Bishop against knight",steps:[
    {f:"8/8/8/3B4/8/7k/P7/n2K4 w - - 0 1",s:["d1c1"],n:"The knight in the corner has no safe squares: your bishop and pawn cover b3, your king covers c2. Go and get it.",ok:"The knight is trapped."},
    {f:"8/8/8/3B4/8/7k/P7/n2K4 w - - 0 1",play:"win",max:25,n:"Win it: take the knight, then queen the a-pawn. Your bishop controls a8, so this works.",ok:"The bishop controls the queening square."}]}]}]},
 {id:"tech",name:"Queen endings and technique",et:["queen","mixed"],pz:"tech",desc:"Converting an extra piece, trading down, and drawing tricks.",chapters:[
  {id:"tech-1",name:"Winning technique",r:[800,1800],lessons:[
   {id:"tech-conv",name:"Converting an extra piece",steps:[
    {f:"3r2k1/5pp1/7p/8/8/8/5PPP/3RR1K1 w - - 0 1",s:["d1d8"],n:"You're a rook up. Trade pieces: every trade makes your extra rook count for more.",ok:"Trades make the win simple."},
    {f:"8/8/8/4k3/8/8/4P3/3RK3 w - - 0 1",play:"win",max:25,n:"Convert it: cut the king off with your rook, then push the pawn and queen it.",ok:"Converted."}]},
   {id:"tech-trade",name:"Trading down",steps:[
    {f:"8/8/4k3/3r4/3R4/4K3/4P3/8 w - - 0 1",s:["d4d5"],x:1,n:"Trade rooks? Only if the pawn ending wins. Here it does: after Rxd5 Kxd5, your king gets in front of the pawn.",ok:"A won pawn ending: trading was right."},
    {f:"8/8/8/3k4/8/4K3/4P3/8 w - - 0 1",play:"win",max:25,n:"Now win the pawn ending you traded into.",ok:"The trade paid off."}]}]},
  {id:"tech-2",name:"Drawing tricks",r:[1200,2200],lessons:[
   {id:"tech-draw",name:"Stalemate tricks",steps:[
    {f:"7k/5Q2/7K/8/8/8/8/6r1 b - - 0 1",s:["g1g6"],x:1,n:"You're Black, a queen down, and your king has no moves. Offer your rook with check: if White takes it, it's stalemate.",ok:"The desperado rook: take it and it's stalemate, leave it and it keeps checking."},
    {f:"8/8/6K1/8/8/8/1kpQ4/8 b - - 0 1",s:["b2b1"],n:"Queen against a pawn on the seventh: go in front of it. If the queen checks you towards the corner, go there: taking the pawn would be stalemate.",ok:"The stalemate defence."},
    {f:"8/8/6K1/8/8/8/1kpQ4/8 b - - 0 1",play:"draw",max:15,n:"Hold the draw: keep the pawn protected and use the stalemate trick when the queen comes close.",ok:"White's king was too far away to help."}]}]}]}];
/* a course from EGC: hand-written chapters (placement check: the find-the-move steps) plus a puzzle chapter per EGB band */
const egCourse=c=>{const tp=c.pz&&{id:"eg-"+c.pz,ask:"Find the best move.",n:["Endgames reward patience: look for checks and captures, then for the quiet move that improves your king.","Count tempi: who gets there first decides most endgames.","Harder ones now. Calculate to the end before you move."]};
 return {id:"eg-"+c.id,name:c.name,desc:c.desc,lv:["new","beg","imp","int","club"],eg:c,chapters:c.chapters.map(ch=>({id:ch.id,name:`${c.name} · ${ch.name}`,short:ch.name,r:ch.r,eg:c,test:ch.lessons.flatMap(l=>l.steps.filter(s=>!s.play&&s.s)).slice(-PZ_T),lessons:ch.lessons})).concat(tp?EGB.map((b,i)=>({id:`${c.id}-p${i+1}`,name:`${c.name} · puzzles ${b[2]}`,short:`Puzzles · ${b[2]}`,band:i,rg:[b[0],b[1]],pz:tp,test:Array(PZ_T).fill(null),
  lessons:PZL.map(([s,n,o],j)=>({id:`${c.id}-p${i+1}-${s}`,name:n,note:tp.n[j],off:o,band:i,pz:tp,steps:Array(PZ_N).fill(null)}))})):[])}};

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
 {id:"openings",name:"Openings",icon:"book-open",courses:["principles","italian","london","scandinavian","caro","french","scotch","qg","qgd","ruy","sicilian","english"].map(id=>opCourse(OPC.find(c=>c.id===id)))},
 {id:"endgames",name:"Endgames",icon:"flag",courses:EGC.map(egCourse)}];
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
  {w:"7k/pp3p2/3rbN1p/4p3/4P3/2r2PR1/P4K1P/8 w - - 0 26",m:["g3g8"],c:"White to move. The knight on f6 is already in place.",t:["Rg8#. An Arabian mate: the knight guards the rook and the h7 square."],src:"XZsR0"}],
 // opening courses: plans, structure, piece placement; diagrams from a move list (s), a worked example from a real game, a checklist
 "op-principles":[{p:"The opening has one job: get your pieces out quickly and safely, so they're ready for the middlegame. Three habits do most of the work: take the centre, develop your pieces, and castle."},
  {s:"e4 e5 Nf3 Nc6 Bc4 Bc5 O-O Nf6 d3 d6",a:[["e4","d5","green"],["f3","e5","green"],["c4","f7","red"]],c:"A healthy start: pawns in the centre, pieces coming out towards it, and White already castled."},
  {p:"The centre (d4, e4, d5, e5) is the high ground: pieces there reach the most squares. Bring out knights and bishops before the queen and rooks, move each piece once if you can, and castle within the first ten moves."},
  {p:"The queen is your strongest piece, which makes her a target. Bring her out early and your opponent develops with tempo by attacking her. And watch f7 (f2 for White): only the king defends it at the start."},
  {s:"e4 e5 Bc4 Nc6 Qh5",a:[["h5","f7","red"],["c4","f7","red"]],c:"The Scholar's mate set-up: queen and bishop both hit f7. Defend with ...g6 or ...Qe7."},
  {w:"rnb1kb1r/ppp2ppp/5n2/3qp3/4N3/6P1/PPPP1PBP/R1BQK1NR w KQkq - 1 6",m:["e4f6","g7f6","g2d5"],c:"White to move. Black's queen came out early and stands on the long diagonal.",t:["Nxf6+! White's own knight was blocking the bishop's line to d5. Now it moves away with check.","Black takes back.","Bxd5 wins the queen. An early queen sortie got punished."],src:"sS8Rd"},
  {h:"In every opening",l:["Did I put a pawn in the centre?","Is every move getting a new piece out?","Is my king castled, or about to be?","Is f7 (or f2) safe?"]}],
 "op-italian":[{p:"The Italian Game starts 1.e4 e5 2.Nf3 Nc6 3.Bc4. White develops fast and aims the bishop at f7, the weakest point in Black's camp. It's the perfect first opening: natural moves and clear plans."},
  {s:"e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4",a:[["c3","d4","blue"],["c4","f7","red"]],c:"The Giuoco Piano with c3 and d4: White wants a big pawn centre."},
  {p:"White has two plans. The sharp one is c3 and d4 at once, building a centre. The slow one is c3 and d3, then Re1, h3 and the knight tour Nbd2-f1-g3, with d4 only later. Black wants ...d5 or ...d6, quick castling and ...h6 to stop Ng5 and Bg5 ideas."},
  {s:"e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O Re1 a6 Bb3 Ba7 h3 h6 Nbd2",a:[["d2","f1","blue"],["f1","g3","blue"]],c:"The slow Italian: the knight heads for g3 and then f5."},
  {p:"Typical piece placement: White's bishop on c4 or b3, knights on f3 and (later) g3, rook on e1. Black's bishop on c5 or a7, knights on c6 and f6."},
  {w:"1r1qkb1r/ppp2pp1/2np1n1p/4p3/2B1P3/1QP2b1P/PP1P1PP1/RNB1R1K1 w k - 0 9",m:["c4f7","e8d7","b3e6"],c:"White to move. Black's king is still in the centre, and queen and bishop both aim at f7.",t:["Bxf7+! The classic Italian target.","The king has to step up.","Qe6#. f7 and the light squares around Black's king give way."],src:"c6Gnb"},
  {h:"Italian checklist",l:["Is f7 (or f2) under fire, and is my king castled?","Am I going for c3 and d4, or the slow d3 plan?","As Black: have I played ...d6 or ...d5, and ...h6 against Ng5?"]}],
 "op-london":[{p:"The London System is 1.d4 with Bf4, e3, Nf3, c3, Nbd2 and Bd3. White plays almost the same set-up against everything, so there's little to memorise. The aim is a solid centre and, later, an attack on the kingside."},
  {s:"d4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3 Nc6 Nbd2 Bd6 Bg3 O-O Bd3",a:[["d3","h7","red"],["f3","e5","blue"]],c:"The full London: the pyramid c3-d4-e3, bishops on g3 and d3. Next comes Ne5 and f4, or e4."},
  {p:"The pawn structure is a pyramid: c3, d4 and e3. It's very hard to break. The dark-squared bishop comes out to f4 before e3 locks it in. The plans: Ne5 and f4 for a kingside attack, or e4 to open the centre."},
  {p:"The weak spot is b2. Once the bishop leaves c1, ...Qb6 hits b2. Answer with Qb3 or Qc1. As Black, that's exactly where to aim: ...c5 and ...Qb6."},
  {w:"r1b3k1/ppp2ppp/8/4r3/4B3/2P5/PP3PPP/R2R2K1 w - - 0 16",m:["d1d8","e5e8","d8e8"],c:"White to move. Black's king has no escape square and the rook on a8 can't help.",t:["Rd8+ on the open d-file.","Black can only block with the rook.","Rxe8#. A back-rank mate, a common way games in quiet openings end."],src:"0haA4"},
  {h:"London checklist",l:["Bf4 before e3.","c3, e3 and Nbd2: the pyramid is in place.","Is b2 covered against ...Qb6?","Plan: Ne5 and f4, or e4?"]}],
 "op-scandinavian":[{p:"The Scandinavian Defence is 1.e4 d5. Black challenges the centre at once and, after 2.exd5, takes back with the queen or the knight. It's easy to learn and Black gets a solid, active game."},
  {s:"e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5",a:[["a5","c3","red"],["f5","c2","blue"]],c:"The main line: queen on a5, pawn on c6, bishop out to f5 before ...e6."},
  {p:"After 2...Qxd5 3.Nc3 the queen goes to a5, where she's safe and pins the knight once d4 is played. Black's set-up is ...Nf6, ...c6, ...Bf5 (or ...Bg4) and ...e6: the Caro-Kann structure, with the queen already out."},
  {p:"The danger is the queen being chased. Keep a retreat open (...c6 gives c7) and don't grab pawns with her. With 2...Nf6, Black lets White keep the pawn for a while and attacks the centre with ...g6, ...Bg7 and ...Nc6."},
  {w:"r3kbnr/1pq1pppp/p1n5/8/B2PP3/N4Q1P/P4PP1/R1B1K2R b KQkq - 1 12",m:["c7a5","e1f1","a5a4"],c:"Black to move. White's bishop on a4 and king on e1 are both loose.",t:["Qa5+! A check that also attacks the bishop.","The king steps aside.","Qxa4 wins the bishop. Scandinavian queens love these checks."],src:"HHxoT"},
  {h:"Scandinavian checklist",l:["Queen to a5 (or d6), with a retreat square ready.","...Nf6, ...c6 and ...Bf5 before ...e6.","Is my queen safe from Bd2, Nb5 or Nd5 tricks?"]}],
 "op-caro":[{p:"The Caro-Kann Defence is 1.e4 c6 and 2...d5. Black builds a rock-solid centre and, unlike in the French, gets the light-squared bishop out before ...e6 locks it in. It's a great choice if you like safe, sound positions."},
  {s:"e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5",a:[["c5","d4","red"],["f5","b1","blue"]],c:"The Advance: the bishop is out on f5, then ...e6 and ...c5 hit the base of White's chain."},
  {p:"The structure: pawns on c6, d5 and e6, a wall against White's pieces. Against the Advance (3.e5), attack the chain with ...c5. In the Classical (3.Nc3 dxe4 4.Nxe4), the bishop goes to f5, then g6 and h7, and Black plays ...Nd7, ...Ngf6, ...e6 and castles."},
  {s:"e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7 h5 Bh7",a:[["h7","b1","blue"]],c:"The Classical main line: White's h-pawn chases the bishop, and ...h6 gives it h7."},
  {w:"r2qk2r/1p3ppp/p2bb3/8/4R3/2PQ3P/PP3PP1/RNB3K1 b kq - 0 14",m:["d6h2","g1h2","d8d3"],c:"Black to move. White's queen on d3 faces Black's queen, with only the bishop on d6 in between.",t:["Bh2+! The bishop gets out of the way with check.","The king takes. Any king move loses the queen just the same.","Qxd3: the queen was hanging once the bishop moved. A discovered attack."],src:"IHhWn"},
  {h:"Caro-Kann checklist",l:["Bishop out (f5 or g4) before ...e6.","Against e5: is ...c5 ready?","In the Classical: ...h6 before the h-pawn traps my bishop.","Watch for Nd6 mate ideas when e7 is blocked."]}],
 "op-french":[{p:"The French Defence is 1.e4 e6 and 2...d5. Black builds a solid chain of pawns and then attacks White's centre. The price: Black's light-squared bishop is shut in behind e6 for a while."},
  {s:"e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6",a:[["c5","d4","red"],["c6","d4","red"],["b6","d4","red"]],c:"The Advance: c5, Nc6 and Qb6 all aim at d4, the base of White's chain."},
  {p:"The key idea: attack the base of the pawn chain. If White plays e5, hit d4 with ...c5, ...Nc6 and ...Qb6, and sometimes e5 with ...f6. White usually attacks on the kingside, where the space is."},
  {p:"Against 3.Nc3, the Rubinstein (3...dxe4) gives a simple, solid game; the Winawer (3...Bb4) is sharp and double-edged. In the Exchange (3.exd5 exd5) the position is symmetrical and Black's bishop is free."},
  {w:"r2nk2r/ppp3bp/4b3/4Npp1/2P2n2/3BQ2P/PP3PP1/RN2K2R b KQkq - 1 15",m:["f4g2","e1e2","g2e3"],c:"Black to move. White's king and queen are a knight's jump from g2.",t:["Nxg2+ takes a pawn with check, and the knight attacks the queen.","The king must move.","Nxe3 wins the queen. A knight fork."],src:"5fSUV"},
  {h:"French checklist",l:["Did White play e5? Then attack d4 with ...c5.","Pile up on d4: ...Nc6, ...Qb6.","Plan for the light-squared bishop: ...b6 and ...Ba6, or ...Bd7.","Keep an eye on my kingside."]}],
 "op-scotch":[{p:"The Scotch Game is 1.e4 e5 2.Nf3 Nc6 3.d4. White opens the centre right away and gets free, active pieces. It's direct and much less theory-heavy than the Ruy Lopez."},
  {s:"e4 e5 Nf3 Nc6 d4 exd4 Nxd4",a:[["d4","c6","blue"],["e4","d5","green"]],c:"After 3...exd4 4.Nxd4 White has a strong knight in the centre and a free game."},
  {p:"Against 4...Bc5, White defends the knight with Be3 and c3 (or trades with Nxc6). Against 4...Nf6, Nxc6 and e5 gain space and split Black's pawns. Black's best answer is quick development and the ...d5 break."},
  {p:"Typical piece placement: White's knight on d4 (or traded on c6), bishops on e3 and c4 or d3, castled kingside. Black's bishop on c5 or b4, knight on f6, and an early ...d5."},
  {w:"r1b2rk1/ppp2ppp/3p1q2/4n3/3QPP2/1B5P/PPP3P1/R1B2RK1 b - f3 0 13",m:["e5f3","f1f3","f6d4"],c:"Black to move. Black's knight on e5 stands between the queen on f6 and White's queen on d4.",t:["Nf3+! The knight moves with check and uncovers the queen's attack on d4.","White takes the knight.","Qxd4+ wins the queen."],src:"cpAHT"},
  {h:"Scotch checklist",l:["As White: knight on d4 defended (Be3, c3), or trade on c6.","Against ...Nf6: Nxc6 and e5.","As Black: develop fast and look for ...d5."]}],
 "op-qg":[{p:"In the Queen's Gambit (1.d4 d5 2.c4) White offers a wing pawn to win the centre. It isn't a real gambit: if Black takes, White usually wins the pawn back. It leads to rich, strategic positions."},
  {s:"d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3",a:[["c4","d5","red"],["g5","f6","red"]],c:"Against the Declined: c4 and Bg5 put pressure on d5."},
  {p:"Against the Declined (2...e6), develop with Nc3, Bg5, e3, Nf3, Rc1 and Bd3. A common plan later is the minority attack: b4 and b5 to weaken Black's queenside pawns. Against the Slav (2...c6), a4 stops ...b5, and e3 and Bxc4 win back the pawn."},
  {s:"d4 d5 c4 dxc4 e3 Nf6 Bxc4",a:[["c4","f7","blue"]],c:"Against the Accepted: e3 and Bxc4, and White has the centre."},
  {w:"r1b2rk1/pp3ppp/5n2/8/3q4/P1NB4/1P3PPP/R2Q1RK1 w - - 0 15",m:["d3h7","f6h7","d1d4"],c:"White to move. White's bishop on d3 stands between the queen on d1 and Black's queen on d4.",t:["Bxh7+! The bishop moves with check and opens the d-file for the queen.","Black takes with the knight. Anything else loses the queen too.","Qxd4 wins the queen. A discovered attack."],src:"6MHL4"},
  {h:"Queen's Gambit checklist",l:["Pressure on d5: c4, Nc3 and Bg5.","Against ...dxc4: e3 and Bxc4, or a4 against ...b5.","Later: the minority attack with b4-b5."]}],
 "op-qgd":[{p:"The Queen's Gambit Declined (2...e6) and the Slav (2...c6) are Black's most solid answers to 1.d4 d5 2.c4. Black keeps a pawn on d5 and develops calmly. They are favourites of world champions."},
  {s:"d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6",a:[["h6","g5","blue"]],c:"The Tartakower: ...h6 and ...b6, then ...Bb7. A solid, flexible set-up."},
  {p:"In the QGD the light-squared bishop is the problem piece: it goes to b7 after ...b6, or comes out after ...dxc4 and ...c5 or ...e5. In the Slav, the bishop comes out to f5 before ...e6, so it never gets shut in."},
  {s:"d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5",a:[["f5","b1","blue"]],c:"The Slav: the bishop is out on f5 before ...e6."},
  {w:"r2qk2r/p4ppp/2n2b2/2pQ4/8/2N1PN2/PP3PPP/2R1K2R b Kkq - 0 13",m:["f6c3","c1c3","d8d5"],c:"Black to move. White's queen on d5 is defended only by the knight on c3.",t:["Bxc3+! Remove the defender, with check.","White takes back.","Qxd5 wins the queen."],src:"FrJKq"},
  {h:"QGD and Slav checklist",l:["Keep d5 solid: ...e6 or ...c6.","QGD: a plan for the light-squared bishop (...b6 and ...Bb7).","Slav: bishop out to f5 before ...e6.","Know the elephant trap: Nxd5? is met by ...Nxd5."]}],
 "op-ruy":[{p:"The Ruy Lopez (or Spanish) is 1.e4 e5 2.Nf3 Nc6 3.Bb5. White attacks the knight that defends e5 and builds slow, lasting pressure. It has been played at the top for over a century."},
  {s:"e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3",a:[["b3","f7","blue"],["c3","d4","green"]],c:"The closed main line: White prepares d4 with c3 and h3, the bishop on b3 eyes f7."},
  {p:"White's plan: castle, Re1, c3 and h3, then d4, and bring the queen's knight round via d2, f1 and g3. Black gets space with ...a6 and ...b5, defends e5 with ...d6, and puts pressure on e4 with ...Bb7 and ...Re8."},
  {p:"In the Exchange variation (4.Bxc6) White gives up the bishop for a better pawn structure: four against three on the kingside, while Black's doubled pawns can't make a passed pawn. And remember Noah's Ark: a bishop on b3 can be trapped by ...c5 and ...c4."},
  {w:"r1bqk2r/2p1n1pp/pp1b1p2/2p5/2P1P3/2NQ1N2/PP3PPP/R1B1R1K1 b kq - 1 11",m:["d6h2","f3h2","d8d3"],c:"Black to move. Queens face each other on the d-file, with a bishop in between.",t:["Bxh2+! The bishop gets out of the way with check.","The knight takes it.","Qxd3 wins the queen."],src:"67DaS"},
  {h:"Ruy Lopez checklist",l:["White: Re1, c3, h3, d4, then Nbd2-f1-g3.","Black: ...a6, ...b5, ...d6, then pressure on e4.","Watch the b3 bishop: Noah's Ark."]}],
 "op-sicilian":[{p:"The Sicilian Defence (1.e4 c5) is the most popular answer to 1.e4. Black fights for d4 from the side and creates an unbalanced position where both sides can win. It suits players who like a fight."},
  {s:"e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6",a:[["c8","h3","blue"],["a6","b5","green"]],c:"The Najdorf: ...a6 controls b5 and prepares ...e5 or ...b5."},
  {p:"In the Open Sicilian, Black trades the c-pawn for White's d-pawn. That leaves Black with two centre pawns against one and the half-open c-file. White gets space and quick development, and often attacks on the kingside while Black counterattacks on the queenside."},
  {p:"Many players at club level meet anti-Sicilians: the Alapin (2.c3), 3.Bb5+ and the Grand Prix (2.Nc3 and f4). Simple answers: ...Nf6 and ...Nd5 against 2.c3, trade bishops after Bb5+, and ...g6 and ...Bg7 against f4 set-ups."},
  {w:"r3r3/pp4kp/2n3p1/8/1b3B2/1Q1P4/PPP2PPP/RN2qRK1 b - - 0 16",m:["e1f1","g1f1","e8e1"],c:"Black to move. White's back rank is weak, and the e-file is open.",t:["Qxf1+! A queen sacrifice to clear the way.","The king takes.","Re1#. Back-rank mate."],src:"cVo2S"},
  {h:"Sicilian checklist",l:["Open Sicilian: ...a6 (Najdorf) and ...e5 or ...e6.","Use the c-file: ...Rc8 and pressure on c3 and c2.","Against anti-Sicilians: know one simple answer to each."]}],
 "op-english":[{p:"The English Opening (1.c4) and the Réti (1.Nf3) control the centre from the side instead of occupying it. White often fianchettoes with g3 and Bg2. They're flexible and can transpose into many other openings."},
  {s:"c4 e5 Nc3 Nf6 g3 d5 cxd5 Nxd5 Bg2",a:[["g2","b7","blue"]],c:"1.c4 e5 is a reversed Sicilian: White has an extra move, and the bishop on g2 rules the long diagonal."},
  {p:"As Black, simple classical set-ups work well: ...e5 with ...Nf6, ...Nc6 and ...Bb4 against 1.c4, or ...d5, ...Nf6, ...e6 and ...c5 against 1.Nf3. As White, the usual plan is g3, Bg2, Nf3, castle, d3, then a3 and b4 to expand on the queenside."},
  {s:"Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 d3 O-O Nbd2 c5",a:[["c5","d4","green"],["d5","e4","green"]],c:"Against 1.Nf3, Black takes the centre with ...d5, ...e6 and ...c5."},
  {w:"r3r1k1/p1q2ppp/1ppb1n2/4pb2/2P1N3/P3P1B1/1PQ1BPPP/R3K2R w KQ - 5 16",m:["e4f6","g7f6","c2f5"],c:"White to move. Black's bishop on f5 is defended only by the knight on f6.",t:["Nxf6+ removes the defender with check.","Black takes back.","Qxf5 wins the bishop."],src:"uJbdG"},
  {h:"English and Réti checklist",l:["White: g3, Bg2, Nf3, castle, then the queenside with a3 and b4.","Black: take the centre with pawns while White fianchettoes.","Watch the long diagonal: the g2 bishop."]}],
 // endgame lessons: the idea, a diagram, a worked example to step through (ms: SAN moves, converted to UCI by the build), a checklist
 "mates-q":[{p:"King and queen against a lone king is a win, always. The queen does the squeezing, the king does the finishing: no checkmate is possible without it."},
  {d:"8/8/8/4k3/8/8/8/3QK3 w - - 0 1",a:[["d1","d7","green"]],c:"Qd7: the queen takes the seventh rank and the d-file. The black king's box shrinks."},
  {p:"Squeeze the king with the queen, staying a knight's jump away so it can't attack her. When it's on the edge, stop: bring your king next to it, then mate. The danger is stalemate: before every queen move near the edge, check the king still has a square."},
  {w:"7k/8/5K2/8/8/8/8/Q7 w - - 0 1",m:["a1a7","h8g8","a7g7"],c:"White to move. The king is on the edge and White's king is close.",t:["Qa7 takes the seventh rank. The king has g8 left, so it's not stalemate.","The king goes to g8.","Qg7#, protected by the king."]},
  {h:"Queen mate checklist",l:["Squeeze with the queen, a knight's jump away from the king.","King on the edge? Bring your own king.","Before each queen move: does the black king still have a move?"]}],
 "mates-r":[{p:"King and rook against king is the mate you'll need most. It takes longer than the queen mate, but the method is simple: the rook builds a wall, and the kings face each other for the mate."},
  {d:"3k4/8/3K4/8/8/8/8/7R w - - 0 1",a:[["h1","h8","green"]],c:"Kings face each other, so Rh8 is mate: the white king covers c7, d7 and e7."},
  {p:"Cut the king off with the rook along a rank or file. Walk your king towards it. When the kings stand opposite each other, check along the edge. If the black king steps aside, make a waiting move with the rook so it has to come back opposite."},
  {w:"3k4/8/4K3/8/8/8/8/7R w - - 0 1",m:["h1c1","d8e8","c1c8"],c:"White to move. No mate yet: the kings aren't opposite.",t:["Rc1 takes away the c-file, so the king can only go to e8.","Now the kings face each other.","Rc8#."]},
  {h:"Rook mate checklist",l:["The rook builds a wall; never let the king near it.","Walk your king up opposite the black king.","Check along the edge when the kings face each other."]}],
 "mates-rr":[{p:"With two rooks, you don't even need your king. The rooks climb a ladder: one guards a rank, the other gives check on the next one, then they swap."},
  {d:"8/8/8/8/7k/R7/1R6/K7 w - - 0 1",a:[["b2","b4","green"],["a3","h3","blue"]],c:"The rook on a3 guards the third rank; Rb4+ pushes the king up."},
  {p:"If the king walks towards a rook, move that rook to the far side of the board, staying on its rank. Then carry on climbing until the king is on the edge."},
  {w:"8/8/8/8/7k/R7/1R6/K7 w - - 0 1",m:["b2b4","h4g5","a3a5","g5f6","b4b6","f6e7","a5a7","e7d8","b6b8"],c:"White to move.",t:["Rb4+: the a3 rook keeps the third rank.","The king steps up.","Ra5+: the rooks swap jobs.","Up again.","Rb6+.","Ke7.","Ra7+: now the king is on the back rank.","Kd8.","Rb8#. The ladder reaches the top."]},
  {h:"Ladder checklist",l:["One rook guards, the other checks one rank further.","King attacking a rook? Move it far away on the same rank.","Keep climbing until the king is on the edge."]}],
 "kp-sq":[{p:"Can the king catch the pawn? Don't count, look. Draw a square from the pawn to its queening rank. If the defending king can step into the square, it catches the pawn; if not, the pawn queens."},
  {d:"8/8/8/8/k4P2/8/8/6K1 w - - 0 1",a:[["f4","f8","green"],["f4","b4","blue"]],c:"The square of the f4 pawn runs from f4 to b8. Black's king on a4 is outside it, and it's White's move."},
  {p:"Whose move it is matters: if the side with the pawn moves first, the square shrinks by a rank. And a pawn on its starting square counts as if it were already a rank further, because it can jump two."},
  {w:"8/8/8/8/k4P2/8/8/6K1 w - - 0 1",m:["f4f5","a4b5","f5f6","b5c6","f6f7","c6d7","f7f8q"],c:"White to move. Black's king is outside the square.",t:["f5: the square shrinks.","The king runs.","f6.","Still one step behind.","f7.","Too late.","f8=Q. Black's king was never inside the square."]},
  {h:"Square checklist",l:["Draw the square from the pawn to the last rank.","Whose move is it? The pawn moving first shrinks the square.","Pawn on its first square? Count it a rank further."]}],
 "kp-opp":[{p:"The opposition: the two kings face each other with one square between them, and the side that has to move must give way. In king and pawn endings it decides almost everything."},
  {d:"8/8/4k3/8/8/4K3/4P3/8 b - - 0 1",a:[["e6","e5","green"]],c:"Black to move takes the opposition with Ke5 and draws."},
  {p:"As the defender, keep the opposition and stay in front of the pawn. As the attacker, walk your king in front of the pawn first and use the opposition to push the black king aside. The pawn moves only when the king has prepared the way."},
  {w:"8/8/4k3/8/8/4K3/4P3/8 b - - 0 1",m:["e6e5","e3f3","e5f5","e2e3","f5e5","e3e4","e5f6","f3f4","f6e6","e4e5","e6f7"],c:"Black to move and draw.",t:["Ke5: the opposition.","White steps aside.","Keep facing the white king.","A pawn move.","Back in front.","The pawn advances again.","Step back, but stay in front.","White's king comes up.","Ke6: still in front of the pawn.","e5.","Kf7, and Black heads for e8 or f8: a draw."]},
  {h:"Opposition checklist",l:["Kings facing, one square between: whoever must move gives way.","Defending: stay in front of the pawn.","Attacking: king first, pawn later."]}],
 "kp-key":[{p:"Every pawn has key squares: get your king onto one and the pawn queens, wherever the other king is. For a pawn that hasn't crossed the middle of the board, they are the three squares two ranks in front of it."},
  {d:"8/8/8/3k4/8/4K3/4P3/8 w - - 0 1",a:[["e3","f4","green"],["e2","e4","blue"]],c:"The key squares of the e2 pawn are d4, e4 and f4. Kf4 reaches one."},
  {p:"Key squares save you calculating. Instead of counting every move, ask: can my king reach a key square? Can the defender stop it? Once you're on one, the rest is technique."},
  {w:"8/8/8/3k4/8/4K3/4P3/8 w - - 0 1",m:["e3f4","d5e6","f4e4","e6d6","e4f5","d6c6","e2e4","c6d7","f5f6"],c:"White to move.",t:["Kf4: a key square.","Black tries to stay in front...","...but White just stays on the key squares.","Black waits.","Kf5: new key squares for the next step.","Black can't approach.","Now the pawn moves.","Black tries to block.","Kf6: the king leads, the pawn follows. This wins."]},
  {h:"Key squares checklist",l:["Find the pawn's key squares: two ranks in front of it.","Can my king get there first?","On a key square: push only when the king has cleared the way."]}],
 "kp-out":[{p:"An outside passed pawn is a passed pawn far from the other pawns. Its strength is that the enemy king must go and stop it, and while it does, your king eats the pawns it left behind."},
  {d:"8/6pp/5k2/8/P7/8/6PP/6K1 w - - 0 1",a:[["a4","a8","green"]],c:"White's a-pawn is far from the kingside pawns. Black's king can't guard both."},
  {p:"Push the outside pawn as a decoy, and bring your king to the other side. Even giving the pawn up is fine if your king wins the race on the other wing."},
  {w:"8/6pp/5k2/8/P7/8/6PP/6K1 w - - 0 1",m:["a4a5","g7g5","a5a6","g5g4","a6a7","g4g3","h2g3","h7h5","a7a8q"],c:"White to move.",t:["a5: run.","Black tries a counterattack.","a6.","g4.","a7.","g3, hoping for a passed pawn.","hxg3: no.","h5.","a8=Q. The outside pawn was too fast."]},
  {h:"Outside passer checklist",l:["A passed pawn far from the action is a decoy.","Push it, and bring your king to the other wing.","Count the race before you go."]}],
 "kp-brk":[{p:"A breakthrough sacrifices pawns to create a passed pawn that nobody can stop. It works when the enemy king is far away and your pawns are closer to queening."},
  {d:"7k/ppp5/8/PPP5/8/8/8/K7 w - - 0 1",a:[["b5","b6","green"]],c:"b6! Whatever Black takes, a white pawn gets through."},
  {p:"The classic pattern: three pawns against three. Push the middle pawn; after any capture, the pawn next to it breaks through. Before you go, check the enemy king can't catch the new passed pawn."},
  {w:"7k/ppp5/8/PPP5/8/8/8/K7 w - - 0 1",m:["b5b6","a7b6","c5c6","b7c6","a5a6","b6b5","a6a7"],c:"White to move.",t:["b6!","Black takes with the a-pawn.","c6! Again a pawn offer.","Black takes.","a6: this pawn is free.","Black's pawns are too slow.","a7, and a8=Q next."]},
  {h:"Breakthrough checklist",l:["Are the enemy king and pawns far from my pawns?","Look for a sacrifice that leaves one of my pawns unstoppable.","Count: does my new queen come first?"]}],
 "rook-behind":[{p:"Rooks belong behind passed pawns, yours and your opponent's. Behind your own pawn, the rook gets more active with every push. Behind the enemy pawn, it holds the pawn back without being tied up."},
  {d:"1r4k1/5ppp/8/P7/8/8/5PPP/4R1K1 w - - 0 1",a:[["e1","a1","green"]],c:"Ra1 puts the rook behind the a-pawn."},
  {p:"The worst place is in front of a passed pawn: the rook becomes a blocker with no moves. If your rook is in front, see whether your king can take over the blocking job."},
  {w:"1r4k1/5ppp/8/P7/8/8/5PPP/R5K1 b - - 1 1",m:["b8a8","a5a6","a8a7","g2g4","g8f8","g1g2","f8e7","g2f3","e7d6"],c:"Black to move, with White's rook behind the pawn.",t:["Black's rook goes in front of the pawn.","The pawn pushes, and White's rook stays strong.","The black rook is now a passive blocker.","White can improve calmly.","Black's king has to come over to help.","White's king walks up as well.","Ke7.","Kf3.","Black's king blocks the pawn at last, but now White's king is free to attack on the kingside."]},
  {h:"Rook placement checklist",l:["My passed pawn? Rook behind it.","Their passed pawn? Rook behind it.","Rook in front of a pawn? Get the king to take over."]}],
 "rook-cut":[{p:"In rook endings, the rook is a fence. Put it on a rank or file between the enemy king and your pawn and the king is cut off: it can only watch while your king and pawn march."},
  {d:"r7/8/2k5/4K3/4P3/8/8/7R w - - 0 1",a:[["h1","h6","green"]],c:"Rh6+ cuts the black king off along the sixth rank."},
  {p:"The further the king is cut off, the better: two files away usually wins. Then walk your king in front of the pawn and use the rook to block checks."},
  {w:"1r6/8/2k5/4K3/4P3/8/8/7R w - - 0 1",m:["e5f6","c6d7","h1h7","d7c6","e4e5","b8f8","f6e7"],c:"White to move.",t:["Kf6: king in front of the pawn.","Black's king tries to come back.","Rh7+ pushes it away again.","Kc6.","Now the pawn moves.","A check from behind.","Ke7: the king shelters in front of the pawn. White is winning."]},
  {h:"Cut-off checklist",l:["Put the rook between the enemy king and the pawn.","Keep the cut: don't let the king cross back.","King in front of the pawn, rook ready to block checks."]}],
 "rook-act":[{p:"An active rook is often worth a pawn. A rook that checks, attacks pawns and cuts off the king does far more than one that just defends."},
  {d:"R7/P5k1/8/8/8/6K1/r7/8 b - - 0 1",a:[["a2","a8","red"]],c:"White's rook is stuck in front of its pawn; Black's rook behind it is active. This is a draw."},
  {p:"With the pawn on a7, White's rook can't move without losing the pawn, and White's king can't hide from checks. Black keeps the rook on the a-file behind the pawn and the king on g7 or h7."},
  {w:"R7/P5k1/8/8/8/6K1/r7/8 b - - 0 1",m:["a2a4","g3f2","a4a1","f2e3","a1a3","e3d4","a3a1"],c:"Black to move.",t:["Ra4: stay behind the pawn.","White's king walks over.","Ra1, still behind the pawn.","Ke3.","Check: the king has no shelter.","Kd4.","Ra1: nothing has changed. Draw."]},
  {h:"Active rook checklist",l:["Is my rook doing something, or just guarding?","Rook behind the passed pawn, checks when the king comes.","Don't trade activity for a pawn unless you've counted."]}],
 "rook-luc":[{p:"The Lucena position is the most important winning position in rook endings: your pawn on the seventh, your king in front of it, the enemy king cut off. The method is called building a bridge."},
  {d:"1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1",a:[["c1","d1","green"],["d1","d4","blue"]],c:"The Lucena: first Rd1+, then the rook goes to d4 to build the bridge."},
  {p:"Step 1: drive the defending king away with a check. Step 2: rook to the fourth rank. Step 3: bring your king out; the checks start. Step 4: when the king reaches the fifth rank, block the check with your rook. The pawn then queens."},
  {w:"1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1",m:["c1d1","d8e7","d1d4","a2a1","b8c7","a1c1","c7b6","c1b1","b6c6","b1c1","c6b5","c1b1","d4b4"],c:"White to move: the Lucena method, move by move.",t:["Rd1+: check the king away from the pawn.","The king steps to e7.","Rd4! The bridge: the rook goes to the fourth rank.","Black waits.","Kc7: the king comes out.","Check.","Kb6, walking towards the rook.","Check again.","Kc6.","Check.","Kb5: the king reaches the fifth rank.","Check...","...Rb4! The bridge blocks the check. b8=Q follows."]},
  {h:"Lucena checklist",l:["Check the defending king away from the pawn.","Rook to the fourth rank: the bridge.","King out, then block the checks with the rook."]}],
 "rook-phil":[{p:"The Philidor position is the defender's best friend: a rook and pawn against a rook, and the defending king in front of the pawn. Defend it right and it's a simple draw."},
  {d:"4k3/8/r7/4PK2/8/8/8/1R6 b - - 0 1",a:[["a6","h6","blue"]],c:"Black's rook on the sixth rank keeps White's king out."},
  {p:"Step 1: keep your rook on the sixth rank (the third rank, counted from your side), so the attacking king can't come forward. Step 2: when the pawn steps onto that rank, the king loses its shelter: drop your rook far back and give check from behind, forever."},
  {w:"4k3/8/r7/4PK2/8/8/8/1R6 b - - 0 1",m:["a6c6","e5e6","c6c3","f5f6","c3f3","f6e5","f3e3","e5d6","e3d3"],c:"Black to move: the Philidor method, move by move.",t:["Rc6: the rook waits on the sixth rank.","White pushes the pawn to break the barrier.","Rc3: now the rook drops back, ready to check from behind.","The king comes forward.","Check.","The king has nowhere to hide from behind.","Check again.","Kd6.","And again. The checks never stop: a draw."]},
  {h:"Philidor checklist",l:["Defending king in front of the pawn.","Rook on the sixth rank until the pawn arrives.","Pawn on the sixth: rook far back, checks from behind."]}],
 "minor-wrong":[{p:"A rook's pawn with a bishop that can't control the queening square is a famous draw: if the defending king reaches the corner, nothing can drive it out."},
  {d:"7k/8/7P/6K1/8/8/2B5/8 b - - 0 1",a:[["c2","h7","blue"]],c:"The light bishop can never control h8, a dark square. The black king stays in the corner."},
  {p:"As the defender, head for the corner and shuffle there. As the attacker, check the colour of the queening square before you trade into this ending: an extra bishop and pawn might be only a draw."},
  {w:"7k/8/7P/6K1/8/8/2B5/8 b - - 0 1",m:["h8g8","g5f4","g8h8","f4f3","h8g8","f3e3","g8h8"],c:"Black to move.",t:["Kg8.","White tries a different approach.","Back to the corner.","White keeps trying.","Kg8.","White's king wanders.","Kh8: nothing can ever change. Draw."]},
  {h:"Wrong-bishop checklist",l:["Rook's pawn plus bishop: what colour is the queening square?","Defender: get the king into the corner.","Attacker: don't trade into this if your bishop is the wrong colour."]}],
 "minor-n":[{p:"A knight hates rook's pawns and loves squares in front of a pawn. Against a single passed pawn, a knight can often hold on its own if it gets in front of it, especially with its king nearby."},
  {d:"8/8/8/8/8/1p6/k7/3K1N2 w - - 0 1",a:[["f1","d2","green"]],c:"Nd2 covers b1 and b3: the pawn can't queen."},
  {p:"Put the knight on a square that covers the queening square, and bring the king. Watch out for knight forks against your king, and for the pawn reaching a square the knight can't cover in time."},
  {w:"8/8/8/8/8/1p6/k7/3K1N2 w - - 0 1",m:["f1d2","b3b2","d1c2","a2a1","d2b1","a1a2","b1c3","a2a1"],c:"White to move.",t:["Nd2: covers b1.","b2.","Kc2 joins in.","The king hides in the corner.","Nb1! Now the pawn can never move.","Ka2.","Nc3+.","Ka1. Black is stuck; it's a draw (or White wins the pawn)."]},
  {h:"Knight-against-pawn checklist",l:["Get the knight in front of the pawn.","Bring your king.","Beware of rook's pawns and knight forks."]}],
 "minor-gb":[{p:"A bad bishop is one whose own pawns stand on its colour: they block it and can't be defended by it. A good bishop works on the other colour, and attacks the pawns the bad bishop can't protect."},
  {d:"8/2k5/1p1b4/pPpPp3/P1P1P3/3K4/5B2/8 w - - 0 1",a:[["f2","g3","green"],["g3","e5","red"]],c:"Black's pawns are on dark squares with a dark bishop: bad. White's bishop attacks them."},
  {p:"Put your pawns on the opposite colour to your bishop. When the opponent has the bad bishop, attack the fixed pawns and look for zugzwang: positions where every move makes things worse."},
  {w:"8/2k5/1p1b4/pPpPp3/P1P1P3/3K4/5B2/8 w - - 0 1",m:["f2g3","c7d7","d3e3","d6c7","e3f3","d7e7","f3g4","e7f6","g3h4"],c:"White to move.",t:["Bg3: aim at e5.","Black waits.","The king heads for the kingside.","Black's bishop has to guard e5.","Kf3.","Ke7.","Kg4: the king walks in.","Kf6.","Bh4+: the king is pushed back. White's king will penetrate."]},
  {h:"Bishop checklist",l:["Which bishop is bad: whose pawns are on its colour?","With the good bishop, attack the fixed pawns.","Look for zugzwang."]}],
 "minor-bn":[{p:"Bishop or knight? With pawns on both wings and an open board, the long-range bishop is usually better. The knight is strongest in closed positions, and weakest on the edge, where it controls few squares."},
  {d:"8/8/8/3B4/8/7k/P7/n2K4 w - - 0 1",a:[["d5","b3","red"],["d1","c2","red"]],c:"The knight on a1 has two squares, b3 and c2, and both are covered: it's trapped."},
  {p:"A bishop can trap a knight on the rim. Before you go for it, check that the ending after winning the knight is really won: here the bishop controls a8, so the a-pawn queens."},
  {w:"8/8/8/3B4/8/7k/P7/n2K4 w - - 0 1",m:["d1d2","h3g3","d2c3","g3f4","c3b2","f4e3","b2a1"],c:"White to move.",t:["Kd2: walk towards the knight.","Black's king comes to help.","Kc3, still covering the knight's squares.","Kf4.","Kb2.","Too late.","Kxa1. Now the a-pawn queens with the bishop's help."]},
  {h:"Bishop-against-knight checklist",l:["Open board, pawns on both wings? The bishop is happy.","Knight on the edge? Look for a trap.","Check the queening square's colour before you win the knight."]}],
 "tech-conv":[{p:"Being a piece up isn't a win until it's converted. The simplest way: trade pieces, not pawns. Every trade makes your extra piece count for more, and it takes away your opponent's tricks."},
  {d:"3r2k1/5pp1/7p/8/8/8/5PPP/3RR1K1 w - - 0 1",a:[["d1","d8","green"]],c:"Rxd8+: trade, and the extra rook wins easily."},
  {p:"Keep your king safe, keep your pawns, and push a passed pawn when the opponent's pieces are gone. Use the extra piece to cut off the enemy king."},
  {w:"8/8/8/4k3/8/8/4P3/3RK3 w - - 0 1",m:["d1d8","e5e6","e1f2","e6e7","d8d3","e7f6","f2e3","f6e5"],c:"White to move.",t:["Rd8: the rook gets out of the king's way and stays active.","Ke6.","Bring the king.","Ke7.","Rd3, back to cut the king off.","Kf6.","Ke3.","Ke5: White's king and pawn now march, the rook keeps the black king out."]},
  {h:"Conversion checklist",l:["Ahead in material? Trade pieces, not pawns.","Keep your king safe from tricks.","Cut off the enemy king, then push the pawn."]}],
 "tech-trade":[{p:"Trading down into a pawn ending is final: there's no going back. When it wins, it's the cleanest win of all; when it doesn't, you've thrown the game away. So calculate the pawn ending before you trade."},
  {d:"8/8/4k3/3r4/3R4/4K3/4P3/8 w - - 0 1",a:[["d4","d5","green"]],c:"Rxd5 Kxd5 leaves a pawn ending where White's king gets in front of the pawn."},
  {p:"Ask three questions: after the trade, can my king get in front of my pawn or reach a key square? Do I have the opposition? Do I have spare pawn moves to win a zugzwang?"},
  {w:"8/8/4k3/3r4/3R4/4K3/4P3/8 w - - 0 1",m:["d4d5","e6d5","e3f4","d5e6","f4e4","e6f6","e4d5"],c:"White to move.",t:["Rxd5: trade.","Kxd5.","Kf4: a key square of the e2 pawn.","Ke6.","Ke4, taking the opposition.","Kf6.","Kd5: White's king leads and the pawn will follow."]},
  {h:"Trading-down checklist",l:["Before trading into a pawn ending, calculate it.","Can my king reach a key square?","Opposition and spare tempo moves decide."]}],
 "tech-draw":[{p:"When you're losing, look for stalemate. A king with no legal moves and a piece the opponent must take (or a pawn the opponent can't take) can save hopeless positions."},
  {d:"7k/5Q2/7K/8/8/8/8/6r1 b - - 0 1",a:[["g1","g6","green"]],c:"Rg6+! If Kxg6, Black has no move: stalemate."},
  {p:"Two classics: the desperado rook that keeps checking and can't be taken without stalemate, and the king in the corner next to a rook's or bishop's pawn on the seventh, where Qxpawn would be stalemate. Fortresses work the same way: a position the opponent can't break, whatever the material."},
  {w:"7k/5Q2/7K/8/8/8/8/6r1 b - - 0 1",m:["g1g6","h6h5","g6g5","h5h4","g5g4","h4h3","g4g3"],c:"Black to move, a queen down.",t:["Rg6+: taking is stalemate.","The king steps away.","Rg5+, and again.","Kh4.","Rg4+.","Kh3.","Rg3+: the checks go on. A draw."]},
  {h:"Drawing-tricks checklist",l:["Losing? Can my king run out of moves?","Look for a desperado piece that must be taken.","Look for a fortress the opponent can't break."]}]};
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
const pzRg=ch=>ch.rg||PZB[ch.band],pzMidC=ch=>(pzRg(ch)[0]+pzRg(ch)[1])/2,pzPool=ch=>ch.all?PZD[ch.pz.id].flat():PZD[ch.pz.id][ch.band];
function pzRate(L,st,res){const c=L.x.ch.pz,k=pzKey(c),R=pzSkill(c)||pzMidC(L.x.ch),E=1/(1+Math.pow(10,(st.r-R)/400)),o=LSP[k]||(LSP[k]={});
 o.v=String(Math.max(400,Math.min(2200,Math.round(R+60*(res-E)))));saveLSP(k)}
/* next puzzle: in Practice and Challenge one missed earlier comes back first; otherwise the unseen puzzle closest to skill + the lesson's offset */
function pzPick(L){const l=L.x.l,ch=L.x.ch,pool=pzPool(ch),B=pzRg(ch),t=Math.max(B[0],Math.min(B[1],(pzSkill(ch.pz)||pzMidC(ch))+l.off)),free=pool.filter(p=>!L.used.has(p[0]));
 const miss=l.off>=0&&!L.back&&free.find(p=>PZS[p[0]]===2);if(miss){L.back=1;return miss}
 const fresh=free.filter(p=>!PZS[p[0]]),c=fresh.length?fresh:free;return c.reduce((a,p)=>Math.abs(p[3]-t)<Math.abs(a[3]-t)?p:a)}
const pzStep=p=>({f:p[1],m:p[2].split(" "),pz:p[0],r:p[3]}),lsN=L=>L.len||L.steps.length,pzPlay=(c,u)=>{const m=c.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]||"q"});return m&&{from:m.from,to:m.to}};
const PNM={p:"pawn",n:"knight",b:"bishop",r:"rook",q:"queen",k:"king"};

/* ---------- LESSONS TAB: priority list, profile, tracks; lesson player; teaching pages ---------- */
const LB=new Board($("#lboard"),{onMove:(f,t)=>lsMove(f,t),label:"Lesson board"}),LW=new Why($("#lWhy"),LB,new EvalBar($("#lEv")));let PGB=[],LTK=0;
function lsView(v){$("#lsHome").hidden=v!=="home";$("#lsCourse").hidden=v!=="course";$("#lsPlay").hidden=v!=="play";$("#lsPage").hidden=v!=="page";if(v!=="play")LW.clear();window.scrollTo(0,0)}
/* a priority target: a lesson id, or a puzzle course, which resolves to its next lesson in the chapter from pzRec */
function lsTarget(x,W){if(!x)return null;if(LIDX[x])return LIDX[x];const C=COIDX[x];if(!C||!(C.co.pz||C.co.op||C.co.eg))return null;const ch=C.co.pz?pzRec(C.co,W):C.co.op?opRec(C.co):egRec(C.co);return ch?{...CIDX[ch.id],l:nextLesson(ch)}:null}
/* endgame courses: the course for an ending type, and the chapter to start at: the first unfinished lesson chapter whose range
   reaches above my rating, else the puzzle chapter for my skill or rating band, else the first unfinished chapter */
const egCourseFor=k=>{const C=TRACKS[2].courses.find(co=>co.eg.et.includes(k));return C?C.id:null};
function egRec(co){const r=pzR0(),lc=co.chapters.filter(ch=>!ch.pz&&!chDone(ch)),hit=lc.find(ch=>ch.r[0]<=r&&ch.r[1]>r);if(hit)return hit;
 const pc=co.chapters.filter(ch=>ch.pz);if(pc.length){const sk=pzSkill(pc[0].pz)||r;let i=EGB.findIndex(b=>sk<b[1]);if(i<0)i=pc.length-1;const p=pc.slice(i).find(ch=>!chDone(ch));if(p)return p}
 return lc.find(ch=>ch.r[1]>r)||co.chapters.find(ch=>!chDone(ch))||null}
/* opening courses: how often I play the opening with each colour the course teaches (famOf names matched by the course's re) */
function opPlays(co){const o={w:0,b:0};if(co.op.re)GAMES.forEach(g=>{if(co.chapters.some(ch=>ch.side===g.color)&&co.op.re.test(famOf(g.eco)))o[g.color]++});return o}
const opCourseFor=(col,fam)=>{const C=TRACKS[1].courses.find(co=>co.op.re&&co.op.re.test(fam)&&co.chapters.some(ch=>ch.side===col));return C?C.id:null};
/* the chapter to work on: line chapters for the colour I play it with (most games), the first unfinished one whose range reaches
   above my rating, else the first unfinished; placement checks skip ahead from there */
function opRec(co){const pl=opPlays(co),col=pl.w+pl.b>=3?(pl.w>=pl.b?"w":"b"):(co.op.side||null),r=pzR0(),lc=co.chapters.filter(ch=>!ch.tac&&!chDone(ch)),mine=lc.filter(ch=>!col||ch.side===col),pool=mine.length?mine:lc;
 return pool.find(ch=>ch.r[1]>r)||pool[0]||co.chapters.find(ch=>!chDone(ch))||null}
function prioBtn(x,i,W){const T=lsTarget(x.to,W),cl=i===0?"pri":"";
 if(T&&(T.co.pz||T.co.op||T.co.eg))return `<button class="${cl}" type="button" data-ch="${T.ch.id}">${T.ch.lessons.some(l=>(LSP["l:"+l.id]||{}).s)?"Continue":"Start"}: ${esc(T.co.name)}${T.co.pz?" ":" · "}${esc(T.ch.short)}</button>`+(x.to.startsWith("op-")&&x.op?` <button class="link small" type="button" data-op="${esc(x.op)}">Opening trainer</button>`:"");
 if(T){const p=LSP["l:"+x.to]||{};return `<button class="${cl}" type="button" data-ls="${x.to}">${p.d?"Practise again":p.s?"Continue":"Start lesson"}</button>`}
 if(x.to==="openings")return `<button type="button" data-op="${esc(x.op||"")}">${ic("book-open","sm")}Opening trainer</button>`;
 return x.k==="clock"?'<a class="small" href="#progress">See your clock use</a>':'<a class="small" href="#review">Review your games</a>'}
/* Lessons home: track switch (Tactics / Endgames; opening courses open from Openings), level chips, the top 3 priorities,
   a grid of course cards (progress ring, "For you"), the weakness profile behind a disclosure; a course opens its own page (LCO). */
let LCO=null;
const coRec=(co,W)=>co.pz?pzRec(co,W):co.op?opRec(co):co.eg?egRec(co):co.chapters.find(ch=>!chDone(ch))||null;
const ring=(p,lbl)=>{const r=20,c=2*Math.PI*r;return `<svg class="pring" viewBox="0 0 48 48" role="img" aria-label="${esc(lbl)}"><circle cx="24" cy="24" r="${r}" fill="none" stroke="var(--sunken)" stroke-width="6"/>${p>0?"":"<!--"}<circle cx="24" cy="24" r="${r}" fill="none" stroke="${p>=1?"var(--gold)":"var(--primary)"}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(c*p).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 24 24)"/>${p>0?"":"-->"}<text x="24" y="28.5" text-anchor="middle">${Math.round(p*100)}%</text></svg>`};
function coCard(co,W,fy){const nd=co.chapters.filter(chDone).length,n=co.chapters.length,rec=coRec(co,W),f=fy.has(co.id);
 return `<button type="button" class="lcard${f?" fy":""}" data-co="${co.id}">${ring(nd/n,T("ls.ringL",{d:nd,n}))}<span class="lcard-t"><span class="lcard-h"><b>${esc(co.name)}</b>${f?`<span class="chip xp">${esc(T("ls.forYou"))}</span>`:""}</span><span class="lcard-d">${esc(co.desc)}</span><span class="lcard-m">${rec?esc(T(nd?"ls.next":"ls.startAt",{ch:rec.short||rec.name})):`${ic("award","sm")}${esc(T("ls.done"))}`}</span></span></button>`}
function renderCourse(id,W){const C=COIDX[id];if(!C){LCO=null;return renderLessons()}const co=C.co,L=lvl(),nd=co.chapters.filter(chDone).length,n=co.chapters.length,rec=coRec(co,W);
 const fy=new Set([co.id]);lsView("course");
 $("#coHead").innerHTML=`${ring(nd/n,T("ls.ringL",{d:nd,n}))}<div><p class="small">${esc(C.t.name)}</p><h2 class="co-name">${esc(co.name)}</h2><p class="co-desc">${esc(co.desc)}</p><div class="op-act">${rec?`<button class="pri lg" type="button" data-ch="${rec.id}">${ic("play")}${esc(T(rec.lessons.some(l=>(LSP["l:"+l.id]||{}).s)?"ls.cont":"ls.start",{ch:rec.short||rec.name}))}</button>`:`<span class="chip gold">${ic("award","sm")}${esc(T("ls.done"))}</span>`}${PAGES[co.id]?`<button class="lg" type="button" data-pg="${co.id}">${ic("book-open")}${esc(T("ls.idea"))}</button>`:""}</div></div>`;
 $("#lsCoBody").innerHTML=courseHTML(co,L,W,fy).replace(/^<details /,"<details open ")}
function renderLessons(){LP=null;const W=wkProfile();if(LCO)return renderCourse(LCO,W);lsView("home");const L=lvl(),auto=lvlAuto(),s=stats(),B=baseSecs(),tr=LS.get("lsTrack","tactics");
 document.querySelectorAll('input[name="lsTrack"]').forEach(r=>r.checked=r.value===tr);
 $("#lsLevel").innerHTML=LVLS.map(([id,n])=>`<button type="button" class="lvl-chip" role="radio" aria-checked="${id===L}" data-lv="${id}">${esc(n)}${id===auto?`<span class="sr-only"> (${esc(T("ls.suggested"))})</span><i aria-hidden="true">•</i>`:""}</button>`).join("");
 $("#lsLevelNote").textContent=(GAMES.length?T("ls.lvlNote",{lv:lvlName(auto)})+(s.rating?" "+T("ls.lvlRating",{r:s.rating}):""):T("ls.lvlNone"))+" "+T("ls.lvlChange");
 const an=GAMES.filter(g=>g.an),pend=an.slice(-MT_GAMES).filter(g=>!(g.mt&&g.mt.v===MT_V)).length,pr=lsPriority().slice(0,5);
 // work on these first; beginners get First steps at the top until it's done
 const fsOpen=["new","beg"].includes(L)&&TRACKS[0].courses[0].chapters.some(ch=>!chDone(ch)),fsL=fsOpen?TRACKS[0].courses[0].chapters.map(nextLesson).find(l=>!lsDone(l.id)):null;
 const items=(fsL?[{k:"fs",name:"First steps",to:fsL.id,reason:"The basics every game is built on: moves, checkmate and keeping pieces safe."}]:[]).concat(pr).slice(0,3);
 $("#lsPrio").innerHTML=items.length?items.map((x,i)=>`<li class="prio-item${i===0?" top":""}"><span class="prio-n">${i+1}</span><div class="prio-txt"><b>${esc(x.name)}</b><span class="small">${esc(x.reason)}</span></div>${prioBtn(x,i,W)}</li>`).join("")
  :`<li class="empty">${esc(T(an.length?pend?"ls.prioWait":"ls.prioClean":"ls.prioNone"))}</li>`;
 // profile by theme (longer bar = more points lost a game) and strengths
 const rows=Object.entries(W.T).map(([k,x])=>({k,n:motN(k),c:x.d/W.n,cnt:x.n})).sort((a,b)=>b.c-a.c),mx=Math.max(.1,...rows.map(r=>r.c)),bar=(n,c,cnt,col,m)=>`<li><span class="bar-l">${esc(n)}</span><span class="bar-t"><b style="width:${Math.max(3,c/(m||mx)*100)}%;background:${col}"></b></span><span class="bar-v num" title="${cnt} mistakes">${c.toFixed(1)}</span></li>`;
 const good=[];if(W.n>=8){[["hang","No hanging pieces"],["fork_missed","No missed forks"],["mate_missed","No missed mates"],["fork_allowed","No forks allowed"]].forEach(([k,t])=>{if(!W.T[k])good.push(`${t} in your last ${W.n} games`)});
  const ph=Object.entries(W.PH).filter(([,x])=>x.n).sort((a,b)=>a[1].d-b[1].d)[0];if(ph)good.push(`Your strongest phase: the ${ph[0]}`)}
 if(s.time!=null&&s.time>=B*.5)good.push("You use your clock well");
 $("#lsProfile").innerHTML=W.n?`<p class="small">From ${W.n} analysed game${W.n>1?"s":""}${pend?` (${pend} more being checked)`:""}. Points lost a game per theme: longer is weaker.</p><ul class="bars">${rows.map(r=>bar(r.n,r.c,r.cnt,r.k==="positional"?"var(--border-strong)":"var(--q-blunder)")).join("")}</ul>`+(good.length?`<h3 class="h-small">Strengths</h3><ul class="good">${good.map(g=>`<li>${ic("circle-check","sm")}${esc(g)}</li>`).join("")}</ul>`:"")
  :`<div class="empty">${an.length?"Checking your mistakes with Stockfish…":"Your profile appears after a few analysed games."}</div>`;
 const pm=Math.max(.1,...Object.values(W.PH).map(x=>x.d/Math.max(1,W.n)));
 $("#lsPhase").innerHTML=W.n?`<ul class="bars">${Object.entries(W.PH).map(([k,x])=>bar(phN(k),x.d/W.n,x.n,"var(--q-mistake)",pm)).join("")}</ul>`+
  (Object.keys(W.ET).length?`<h3 class="h-small">Endings</h3><ul class="good">${Object.entries(W.ET).sort((a,b)=>b[1].d-a[1].d).map(([k,x])=>`<li>${ic("flag","sm")}${esc(endN(k))}: ${x.n} mistake${x.n>1?"s":""}</li>`).join("")}</ul>`:"")
  :'<div class="empty">Phases appear with your profile.</div>';
 // course cards of the chosen track; courses on the priority list (and endings I go wrong in) are marked "For you"
 const fy=new Set(pr.map(x=>x.to).filter(t=>COIDX[t]));if(fsOpen)fy.add(TRACKS[0].courses[0].id);
 const t=TRACKS.find(x=>x.id===tr)||TRACKS[0];
 $("#lsTracks").innerHTML=`<p class="small ls-tdesc">${esc(T(t.id==="endgames"?"ls.egDesc":"ls.tacDesc"))}</p>`+t.courses.map(co=>coCard(co,W,fy)).join("");
 if(pend)TG.run()}
/* placement checks may have one miss in four (none in shorter checks) */
const lsAllow=n=>n>=4?1:0;
function courseHTML(co,L,W,fy){if(co.pz)return pzCourseHTML(co,W,fy);if(co.op)return opCourseHTML(co,fy);if(co.eg)return egCourseHTML(co,fy);const rec=co.lv.includes(L);
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
/* an opening course: chapters by colour and level, the chapter to start at marked, then "tactics in this opening" */
function opCourseHTML(co,fy){const rec=opRec(co),pl=opPlays(co),f=fy.has(co.id),nd=co.chapters.filter(chDone).length,tac=co.chapters.find(ch=>ch.tac),sk=pzSkill(tac.pz),cn=s=>s==="w"?"White":"Black";
 const plays=pl.w+pl.b>=3?`You play this${pl.w>=3?` as White (${pl.w})`:""}${pl.w>=3&&pl.b>=3?" and":""}${pl.b>=3?` as Black (${pl.b})`:""}`:"";
 return `<details class="course pzc opc${f?" rec":""}"${f?" open":""}><summary><span class="course-h"><b>${esc(co.name)}</b><span class="chips">${plays?`<span class="chip xp">${esc(plays)}</span>`:""}${rec?`<span class="chip">Start: ${esc(rec.short)}</span>`:`<span class="chip gold">${ic("award","sm")}Completed</span>`}${ic("chevron-right","pz-chev")}</span></span>`+
  `<span class="small">${esc(co.desc)}</span><span class="bands" role="img" aria-label="${nd} of ${co.chapters.length} chapters done">${co.chapters.map(ch=>`<i class="${chDone(ch)?"done":ch===rec?"on":""}"></i>`).join("")}</span></summary>`+
  `<div class="pz-body"><div class="row">${PAGES[co.id]?`<button type="button" data-pg="${co.id}">${ic("book-open","sm")}Learn the ideas</button>`:""}</div>`+
  co.chapters.map(ch=>{const d=ch.lessons.filter(l=>lsDone(l.id)).length,c=LSP["c:"+ch.id]||{},started=ch.lessons.some(l=>(LSP["l:"+l.id]||{}).s),done=chDone(ch),me=ch===rec,n=ch.tac?PZ_N:2;
   return `<div class="chapter${me?" me":""}"><div class="ch-h"><span class="ch-name">${done?ic("circle-check","sm"):""}${esc(ch.short)}${me?' <span class="chip xp">Start here</span>':""}</span><span class="small">${ch.tac?(sk?`Your level here: about <b class="num">${sk}</b>`:"Puzzles from 400 to "+ch.rg[1]):`${cn(ch.side)} · ${ch.r[0]?ch.r[0]+"–"+ch.r[1]:"up to "+ch.r[1]}`}</span></div>`+
    `<div class="ls-row">${ch.lessons.map(l=>{const p=LSP["l:"+l.id]||{};return `<button class="link" type="button" data-ls="${l.id}">${p.d?ic("check","sm"):""}${esc(l.name)}<span class="small num">${p.s||0}/${n}</span></button>`}).join("")}</div>`+
    (done?"":`<div class="row"><button class="${me?"pri":""}" type="button" data-ch="${ch.id}">${started?"Continue":"Start"}</button>${!c.p&&!ch.tac&&ch.test.length&&rec&&co.chapters.indexOf(ch)>=co.chapters.indexOf(rec)?`<button type="button" data-test="${ch.id}">${ic("graduation-cap","sm")}Know it? ${ch.test.length}-move check</button>`:""}</div>`)+"</div>"}).join("")+"</div></details>"}
/* an endgame course: lesson chapters (each lesson has a teaching page), then a puzzle chapter per rating band */
function egCourseHTML(co,fy){const rec=egRec(co),f=fy.has(co.id),nd=co.chapters.filter(chDone).length,pc=co.chapters.filter(ch=>ch.pz),sk=pc.length?pzSkill(pc[0].pz):null;
 const chH=ch=>{const d=ch.lessons.filter(l=>lsDone(l.id)).length,c=LSP["c:"+ch.id]||{},started=ch.lessons.some(l=>(LSP["l:"+l.id]||{}).s),done=chDone(ch),me=ch===rec,n=l=>ch.pz?PZ_N:l.steps.length;
  return `<div class="chapter${me?" me":""}"><div class="ch-h"><span class="ch-name">${done?ic("circle-check","sm"):""}${esc(ch.short)}${me?' <span class="chip xp">Start here</span>':""}</span><span class="small">${ch.pz?"":(ch.r[0]?ch.r[0]+"–"+ch.r[1]:"up to "+ch.r[1])}</span></div>`+
   `<div class="ls-row">${ch.lessons.map(l=>{const p=LSP["l:"+l.id]||{};return `<button class="link" type="button" data-ls="${l.id}">${p.d?ic("check","sm"):""}${esc(l.name)}<span class="small num">${p.s||0}/${n(l)}</span></button>${PAGES[l.id]?`<button class="link small" type="button" data-pg="${l.id}">Learn</button>`:""}`}).join("")}</div>`+
   (done?"":`<div class="row"><button class="${me?"pri":""}" type="button" data-ch="${ch.id}">${started?"Continue":"Start"}</button>${!c.p&&ch.test&&ch.test.length>=2&&rec&&co.chapters.indexOf(ch)>=co.chapters.indexOf(rec)?`<button type="button" data-test="${ch.id}">${ic("graduation-cap","sm")}Skip ahead: ${ch.test.length}-position check</button>`:""}</div>`)+"</div>"};
 return `<details class="course pzc egc${f?" rec":""}"${f?" open":""}><summary><span class="course-h"><b>${esc(co.name)}</b><span class="chips">${f?'<span class="chip xp">For you</span>':""}${rec?`<span class="chip">Start: ${esc(rec.short)}</span>`:`<span class="chip gold">${ic("award","sm")}Completed</span>`}${ic("chevron-right","pz-chev")}</span></span>`+
  `<span class="small">${esc(co.desc)}</span><span class="bands" role="img" aria-label="${nd} of ${co.chapters.length} chapters done">${co.chapters.map(ch=>`<i class="${chDone(ch)?"done":ch===rec?"on":""}"></i>`).join("")}</span></summary>`+
  `<div class="pz-body">${co.chapters.filter(ch=>!ch.pz).map(chH).join("")}${pc.length?`<h3 class="h-small">Endgame puzzles from real games${sk?` <span class="small">· your level here: about <b class="num">${sk}</b></span>`:""}</h3>`+pc.map(chH).join(""):""}</div></details>`}
/* one handler for every lessons button */
$("#v-lessons").addEventListener("click",e=>{const b=e.target.closest("button[data-ls],button[data-pg],button[data-ch],button[data-test],button[data-op],button[data-co],button[data-lv]");if(!b)return;
 if(b.dataset.co){LCO=b.dataset.co;renderLessons()}else if(b.dataset.lv){LSP.lvl={v:b.dataset.lv};saveLSP("lvl");renderLessons()}else if(b.dataset.ls)openLesson(b.dataset.ls);else if(b.dataset.pg)openPage(b.dataset.pg);else if(b.dataset.ch)openLesson(nextLesson(CIDX[b.dataset.ch].ch).id);else if(b.dataset.test)openTest(b.dataset.test);
 else if(b.dataset.op!=null){if(b.dataset.op)opGo(b.dataset.op,true);else location.hash="train/openings"}});
$("#coBack").onclick=()=>{LCO=null;renderLessons()};
document.querySelectorAll('input[name="lsTrack"]').forEach(r=>r.onchange=()=>{LS.set("lsTrack",r.value);renderLessons()});
$("#lBack").onclick=$("#pgBack").onclick=()=>renderLessons();
/* player: a lesson (steps in order, progress saved) or a placement check (first try counts). Puzzle lessons pick each puzzle when
   it's reached (pzPick); puzzle steps have m (moves: the opponent's setup move, then the solution) and track miss/help. */
const lsCrumb=L=>`${L.x.t.name} › ${L.x.co.name} › ${L.x.ch.short||L.x.ch.name}`;
async function openLesson(id,i){const x=LIDX[id];if(!x)return;const p=LSP["l:"+id]||{};
 const L=LP={kind:"lesson",x,steps:x.l.pz?[]:x.l.steps.map(s=>({...s})),len:x.l.steps.length,i:i!=null?i:p.d?0:Math.min(p.s||0,x.l.steps.length-1),fails:0,used:new Set()};lsView("play");
 if(x.l.pz&&!(await lsLoad(L)))return;lsStep()}
async function openTest(id){const x=CIDX[id];if(!x||!x.ch.test)return;const L=LP={kind:"test",x,steps:x.ch.pz?[]:x.ch.test,len:x.ch.test.length,i:0,fails:0,used:new Set()};lsView("play");
 if(x.ch.pz){if(!(await lsLoad(L)))return;const pool=pzPool(x.ch);L.steps=[.55,.7,.82,.94].map(f=>pzStep(pool[Math.min(pool.length-1,Math.floor(f*pool.length))]))}lsStep()}
/* fetch a course's puzzles (from this site); false if that failed or the player left meanwhile */
async function lsLoad(L){$("#lCrumb").textContent=lsCrumb(L);$("#lTitle").textContent=L.kind==="test"?"Placement check":L.x.l.name;$("#lDots").innerHTML="";$("#lFeedback").innerHTML="";$("#lSrc").hidden=true;
 $("#lPrompt").className="verdict v-info";$("#lPrompt").innerHTML='<span class="skel" style="width:60%" aria-label="Loading puzzles"></span>';
 try{await pzLoad(L.x.ch.pz)}catch(e){if(LP===L){$("#lPrompt").className="verdict v-no";$("#lPrompt").innerHTML=`${ic("circle-x")}Couldn't load the puzzles. Check your connection and try again.`}return false}return LP===L}
const hintBtn=(L,st,t)=>{$("#lFeedback").innerHTML=`<div class="v-actions"><button class="ghost" type="button" id="lHint">${ic("lightbulb","sm")}${t||"Hint"}</button></div>`;$("#lHint").onclick=()=>pzHint(L,st)};
function lsStep(){const L=LP;if(L.x.l&&L.x.l.pz&&!L.steps[L.i]){const p=pzPick(L);L.used.add(p[0]);L.steps[L.i]=pzStep(p)}if(L.steps[L.i].ln)return lnStart(L,L.steps[L.i]);if(L.steps[L.i].play)return egStart(L,L.steps[L.i]);
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
async function lsMove(from,to){const L=LP;if(!L||!L.wait)return;const st=L.steps[L.i];if(st.m)return pzMove(L,st,from,to);if(st.ln)return lnMove(L,st,from,to);if(st.play)return egMove(L,st,from,to);const fen=st.f,c=new Chess(fen),mv=c.move({from,to,promotion:"q"});if(!mv)return;L.wait=false;
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
/* opening lines: the coach plays the other side; my move must be the line's (a move within OP_TOL is called fine, then the line
   move is asked for); guided runs show the note of each ply, the memory run shows none */
function lnStart(L,st){const l=st.ln,n=lsN(L);L.tk=++LTK;L.ms=l.m.split(" ");L.k=0;L.c=new Chess();L.wait=false;LW.clear();LB.flip=l.side==="b";LB.set(L.c.fen());
 $("#lCrumb").textContent=lsCrumb(L);$("#lTitle").textContent=L.x.l.name;
 $("#lDots").innerHTML=Array.from({length:n},(s,k)=>`<span class="sdot${k<L.i?" done":k===L.i?" on":""}"></span>`).join("")+`<span class="small">${st.mem?"From memory":"Guided"} · step ${L.i+1} of ${n}</span>`;
 $("#lPrompt").className="verdict v-move";$("#lPrompt").innerHTML=`${ic("target")}<b>You play ${l.side==="w"?"White":"Black"}.</b> ${st.mem?"Now play the whole line from memory. No notes this time.":"Play the line move by move; the coach plays the other side and explains the key moves."}`;
 $("#lFeedback").innerHTML="";$("#lSrc").hidden=true;$("#lPage").hidden=!PAGES[L.x.co.id];$("#lSkip").hidden=true;opNames().then(()=>{if(LP===L)lnName(L)});lnNext(L,st)}
const lnMine=(L,st)=>(L.k%2===0)===(st.ln.side==="w"),lnNote=(L,st,k)=>st.mem?"":st.ln.n[k]||"";
function lnName(L){const nm=opName(L.c.fen());if(nm){L.nm=nm}$("#lSrc").hidden=!L.nm;if(L.nm)$("#lSrc").textContent="Opening: "+L.nm}
function lnHintBtn(L,st){const v=$("#lFeedback .v-actions");const b=`<button class="ghost" type="button" id="lHint">${ic("lightbulb","sm")}${st.mem?"Hint":"Show me"}</button>`;if(v)v.insertAdjacentHTML("beforeend",b);else $("#lFeedback").insertAdjacentHTML("beforeend",`<div class="v-actions">${b}</div>`);
 $("#lHint").onclick=()=>{if(!L.wait)return;const t=new Chess(L.c.fen()),m=t.move(L.ms[L.k]);st.help=1;LB.set(L.c.fen(),{arrows:[{from:m.from,to:m.to,c:"green"}]});$("#lHint").remove()}}
function lnNext(L,st){const tk=L.tk;if(L.k>=L.ms.length)return lnDone(L,st);
 if(lnMine(L,st)){L.wait=true;lnHintBtn(L,st);return}
 setTimeout(()=>{if(LP!==L||L.tk!==tk)return;const m=L.c.move(L.ms[L.k]);L.k++;LB.set(L.c.fen(),{last:{from:m.from,to:m.to}});lnName(L);
  const nt=lnNote(L,st,L.k),bad=(st.ln.bad||[]).includes(L.k);$("#lFeedback").innerHTML=nt?`<div class="verdict ${bad?"v-no":"v-info"}">${ic(bad?"triangle-alert":"info")}<b>${esc(m.san)}.</b> ${esc(nt)}</div>`:"";lnNext(L,st)},L.k?650:450)}
async function lnMove(L,st,from,to){const pre=L.c.fen(),c=new Chess(pre),mv=c.move({from,to,promotion:"q"});if(!mv)return;L.wait=false;const want=L.ms[L.k],w=new Chess(pre).move(want);
 LB.set(c.fen(),{last:{from,to}});
 if(mv.san===want){L.c=c;L.k++;lnName(L);const nt=lnNote(L,st,L.k);$("#lFeedback").innerHTML=`<div class="verdict v-ok">${ic("circle-check")}<b>${esc(mv.san)}.</b> ${esc(nt||"Right.")}</div>`;return lnNext(L,st)}
 $("#lFeedback").innerHTML='<div class="skel-wrap" role="status"><span class="sr-only">Checking your move…</span><span class="skel" style="width:55%"></span></div>';let near=false;
 try{const sd=pre.split(" ")[1]==="w"?1:-1,t=new Chess(pre);t.move(want);const a=await wEval(t.fen()),b=await wEval(c.fen());near=wp(sd*a.cp)-wp(sd*b.cp)<OP_TOL}catch(e){}
 if(LP!==L||L.c.fen()!==pre)return;const back=()=>LB.set(pre,{arrows:[{from:w.from,to:w.to,c:"green"}]});
 if(near){Snd.play("move");back();L.wait=true;$("#lFeedback").innerHTML=`<div class="verdict v-info">${ic("info")}<b>${esc(mv.san)}</b> is a decent move too, but this line continues with <b>${esc(want)}</b>. Play it to carry on.</div>`;return}
 st.miss=true;Snd.play("wrong");
 $("#lFeedback").innerHTML=`<div class="verdict v-no">${ic("circle-x")}<b>${esc(mv.san)}</b> isn't good here. The line move is <b>${esc(want)}</b>.</div><div class="v-actions"><button type="button" id="lRetry">${ic("rotate-ccw","sm")}Try again</button></div>`;
 $("#lRetry").onclick=()=>{LW.clear();LB.set(pre);L.wait=true;$("#lFeedback").innerHTML="";lnHintBtn(L,st)};
 LW.show({fen:pre,played:mv.from+mv.to+(mv.promotion||""),best:w.from+w.to+(w.promotion||""),restore:()=>LB.set(c.fen(),{last:{from,to}})})}
function lnDone(L,st){Snd.play("correct");const h=L.c.history({verbose:true}),m=h[h.length-1];lsRight(L,m,false)}
/* "play it out" steps: I play the position against Stockfish (depth EG_D by level, or st.d). win: checkmate, or a promotion that keeps
   a clearly won position (+4); draw: a draw by the rules, or st.max moves survived. A move that drops a win below +1.5 (or a draw
   below -3), stalemate in a win, or running out of moves fails; I can take the move back and see a better one. */
const egDepth=st=>st.d||EG_D[lvl()]||10;
function egStat(L,st){$("#lSrc").hidden=false;$("#lSrc").textContent=`Goal: ${st.play==="win"?"win":"hold the draw"} · move ${L.mv} of ${st.max} · Stockfish plays at depth ${egDepth(st)}`}
function egHint(L,st){$("#lFeedback").innerHTML=`<div class="v-actions"><button class="ghost" type="button" id="lHint">${ic("lightbulb","sm")}Hint</button></div>`;
 $("#lHint").onclick=async()=>{if(!L.wait)return;const f=L.c.fen();st.help=1;$("#lHint").disabled=true;try{const b=(await wEval(f)).best;if(LP===L&&L.c.fen()===f&&b)LB.set(f,{arrows:[{from:b.slice(0,2),to:b.slice(2,4),c:"green"}]})}catch(e){}}}
function egStart(L,st){const c=new Chess(st.f),n=lsN(L);L.tk=++LTK;L.c=c;L.me=c.turn();L.mv=0;L.wait=true;LW.clear();LB.flip=L.me==="b";LB.set(st.f);
 $("#lCrumb").textContent=lsCrumb(L);$("#lTitle").textContent=L.x.l.name;
 $("#lDots").innerHTML=Array.from({length:n},(s,k)=>`<span class="sdot${k<L.i?" done":k===L.i?" on":""}"></span>`).join("")+`<span class="small">Play it out · step ${L.i+1} of ${n}</span>`;
 $("#lPrompt").className="verdict v-move";$("#lPrompt").innerHTML=`${ic("swords")}<b>You play ${L.me==="w"?"White":"Black"}.</b> ${esc(st.n)}`;
 egHint(L,st);egStat(L,st);$("#lPage").hidden=!PAGES[L.x.l.id];$("#lSkip").hidden=true}
async function egMove(L,st,from,to){const pre=L.c.fen(),c=new Chess(pre),mv=c.move({from,to,promotion:"q"});if(!mv)return;L.wait=false;L.c=c;L.mv++;LB.set(c.fen(),{last:{from,to}});LW.clear();
 const win=st.play==="win",sd=L.me==="w"?1:-1,ruleDraw=()=>c.in_draw()||c.in_stalemate()||c.in_threefold_repetition(),done=t=>{L.res=t;Snd.play("correct");lsRight(L,mv,false)},fail=t=>egFail(L,st,pre,t);
 if(c.in_checkmate())return done("Checkmate!");
 if(ruleDraw())return win?fail(c.in_stalemate()?"Stalemate! The king has no move and isn't in check, so it's a draw.":"That's a draw by the rules."):done("A draw by the rules.");
 $("#lFeedback").innerHTML='<div class="skel-wrap" role="status"><span class="sr-only">Stockfish is thinking…</span><span class="skel" style="width:45%"></span></div>';
 let r;try{r=await Engine.eval(c.fen(),egDepth(st),true)}catch(e){return}if(LP!==L||L.c!==c)return;const ev=sd*r.cp;
 if(win&&ev<150)return fail("That lets the win slip: the position isn't winning any more.");
 if(!win&&ev<-300)return fail("That loses: the position can't be held any more.");
 if(win&&mv.promotion&&ev>=400)return done("A new queen, and the position is clearly won.");
 const m=r.best&&c.move({from:r.best.slice(0,2),to:r.best.slice(2,4),promotion:r.best[4]||"q"});if(!m)return;LB.set(c.fen(),{last:{from:m.from,to:m.to}});
 if(c.in_checkmate())return fail("Checkmate: Stockfish got there first.");
 if(ruleDraw())return win?fail("That's a draw by the rules."):done("A draw by the rules.");
 if(L.mv>=st.max)return win?fail(`Out of moves: win within ${st.max} moves. Try a quicker plan.`):done(`You held for ${st.max} moves: that's a draw.`);
 L.wait=true;egStat(L,st);egHint(L,st)}
function egFail(L,st,pre,t){Snd.play("wrong");st.miss=true;
 $("#lFeedback").innerHTML=`<div class="verdict v-no">${ic("circle-x")}${esc(t)}</div><div class="v-actions"><button type="button" id="lBackMv">${ic("rotate-ccw","sm")}Take the move back</button><button class="ghost" type="button" id="lRetry">Start again</button></div>`;
 $("#lRetry").onclick=()=>lsStep();
 $("#lBackMv").onclick=async()=>{L.c=new Chess(pre);L.mv=Math.max(0,L.mv-1);LB.set(pre);L.wait=true;egStat(L,st);egHint(L,st);try{const b=(await wEval(pre)).best;if(LP===L&&L.c.fen()===pre&&b)LB.set(pre,{arrows:[{from:b.slice(0,2),to:b.slice(2,4),c:"green"}]})}catch(e){}}}
/* "Drill this line": pin my moves of the line as repertoire moves (OPS), then open the trainer on a matching opening */
function opDrill(l,co){const c=new Chess(),now=Date.now();let n=0;l.m.split(" ").forEach((s,i)=>{const k=posKey(c.fen()),m=c.move(s);if(!m)return;if((i%2===0)===(l.side==="w")&&!(l.bad||[]).includes(i+1)){const x=OPS[k]||(OPS[k]={s:0,ok:0,miss:0});x.pin=m.from+m.to+(m.promotion||"");x.at=now;saveOPS(k);n++}});
 const fams={};GAMES.filter(g=>g.color===l.side&&co.op.re&&co.op.re.test(famOf(g.eco))).forEach(g=>{const f=famOf(g.eco);fams[f]=(fams[f]||0)+1});
 const f=Object.keys(fams).filter(k=>fams[k]>=3).sort((a,b)=>fams[b]-fams[a])[0];LP=null;gToast(T("t.pinned",{n}));opGo(l.side+"|"+(f||co.name),true)}
function lsChapterDone(ch){const k="c:"+ch.id;if((LSP[k]||{}).d||!chDone(ch))return;const c=LSP[k]||(LSP[k]={});c.d=Date.now();saveLSP(k);gAdd({lc:1});gToast(T("t.chapter",{c:ch.name,xp:GX.lc}))}
/* after a puzzle lesson: suggest the next or previous chapter when the skill has left this band */
function pzShift(L){const ch=L.x.ch,co=L.x.co;if(ch.all)return null;const i=co.chapters.indexOf(ch),sk=pzSkill(ch.pz)||0,B=pzRg(ch);
 if(sk>=B[1]+40&&co.chapters[i+1]&&co.chapters[i+1].pz&&!chDone(co.chapters[i+1]))return {ch:co.chapters[i+1],t:"These are getting easy for you. Ready for the next chapter?"};
 if(sk&&sk<B[0]-60&&i>0&&co.chapters[i-1].pz&&!chDone(co.chapters[i-1]))return {ch:co.chapters[i-1],t:"These are tough ones. The previous chapter may suit you better for now."};return null}
function lsRight(L,mv,also){const st=L.steps[L.i],n=lsN(L),last=L.i===n-1;let nx="",tip="";
 if(L.kind==="lesson"){const k="l:"+L.x.l.id,p=LSP[k]||(LSP[k]={s:0}),fresh=L.i>=(p.s||0);if(fresh)p.s=L.i+1;if(last&&!p.d)p.d=Date.now();saveLSP(k);if(fresh)gAdd({ls:1});if(last)lsChapterDone(L.x.ch);
  const nl=L.x.ch.lessons[L.x.ch.lessons.indexOf(L.x.l)+1],nch=L.x.co.chapters[L.x.co.chapters.indexOf(L.x.ch)+1],mv2=last&&st.m?pzShift(L):null;
  const go=!last?["Next "+(st.m?"puzzle":"step"),()=>{L.i++;lsStep()}]:nl?["Next lesson: "+nl.name,()=>openLesson(nl.id,0)]:nch&&(L.x.co.pz||L.x.co.op)?["Next chapter: "+nch.short,()=>openLesson(nextLesson(nch).id)]:["Back to lessons",()=>renderLessons()];
  nx=`<button class="pri" type="button" id="lNext">${esc(go[0])}${ic("arrow-right","sm")}</button>`+(mv2?`<button type="button" id="lAlt">${esc(mv2.ch.short)}</button>`:"");if(mv2)tip=` ${mv2.t}`;
  const okTxt=st.m?(st.miss?"Solved.":st.help?"Solved with a hint.":"Solved first try!"):st.ln?(st.mem?(st.miss||st.help?"Line complete. Run it again later to make it stick.":"Line complete from memory!"):"Line complete. "+(st.ln.end||"")):st.play?`${L.res} ${st.ok||""}`:st.ok||"Correct.";
  $("#lFeedback").innerHTML=`<div class="verdict v-ok">${ic("circle-check")}${st.ln||st.play?"":`<b>${esc(mv.san)}.</b> `}${also?"That works just as well. ":""}${esc(okTxt)}${last?` <b>Lesson complete.</b>`:""}${esc(tip)}</div><div class="v-actions">${nx}${st.ln?`<button type="button" id="lDrill">${ic("repeat","sm")}Drill this line in the opening trainer</button>`:st.play?"":'<button class="link" type="button" id="lWhyBtn">Why?</button>'}</div>`;
  $("#lNext").onclick=go[1];if(st.ln)$("#lDrill").onclick=()=>opDrill(st.ln,L.x.co);if(mv2)$("#lAlt").onclick=()=>openLesson(nextLesson(mv2.ch).id)}
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
  if(ch.pz&&!ch.rg){const sk=LSP[pzKey(ch.pz)]||(LSP[pzKey(ch.pz)]={});if((+sk.v||0)<PZB[ch.band][1]){sk.v=String(PZB[ch.band][1]);saveLSP(pzKey(ch.pz))}}
  const nch=ch.pz||ch.op?co.chapters[co.chapters.indexOf(ch)+1]:null;
  $("#lFeedback").innerHTML=html+` <b>You passed the check</b> (${n-L.fails} of ${n}): this chapter is marked complete, so you can skip ahead.</div><div class="v-actions"><button class="pri" type="button" id="lNext">${nch?`Next chapter: ${esc(nch.short)}`:"Back to lessons"}${ic("arrow-right","sm")}</button></div>`;
  $("#lNext").onclick=()=>nch?openLesson(nextLesson(nch).id):renderLessons()}
 else{const c=LSP["c:"+ch.id]||(LSP["c:"+ch.id]={});c.t=Date.now();saveLSP("c:"+ch.id);
  $("#lFeedback").innerHTML=html+` You got ${n-L.fails} of ${n}. Work through the lessons first; they're short.</div><div class="v-actions"><button class="pri" type="button" id="lNext">Start the first lesson${ic("arrow-right","sm")}</button></div>`;$("#lNext").onclick=()=>openLesson(ch.lessons[0].id,0)}}
$("#lPage").onclick=()=>{if(LP&&LP.kind==="lesson")openPage(PAGES[LP.x.l.id]?LP.x.l.id:LP.x.co.id)};$("#lSkip").onclick=()=>{if(LP)openLesson(LP.x.ch.lessons[0].id,0)};$("#lRestart").onclick=()=>{if(LP&&LP.steps[LP.i])lsStep()};
/* teaching page: text, diagrams, a worked example to step through and a checklist, then practice */
function openPage(id){const x=LIDX[id]||COIDX[id],pg=PAGES[id];if(!x||!pg)return;LP=null;lsView("page");$("#pgCrumb").textContent=x.ch?`${x.t.name} › ${x.co.name} › ${x.ch.name}`:`${x.t.name}${x.co.pz?" › Puzzle courses":""}`;$("#pgTitle").textContent=x.l?x.l.name:x.co.name;
 PGB.forEach(b=>{const i=BOARDS.indexOf(b);if(i>=0)BOARDS.splice(i,1)});PGB=[];
 $("#pgBody").innerHTML=pg.map((b,k)=>b.p?`<p>${esc(b.p)}</p>`:b.l?`<h2 class="h-small">${esc(b.h)}</h2><ul class="pg-list">${b.l.map(t=>`<li>${ic("check","sm")}${esc(t)}</li>`).join("")}</ul>`
  :b.w?`<figure class="pg-fig pg-ex"><div class="boardwrap" id="pgb${k}"></div><figcaption><p class="pg-cap" id="pgc${k}" aria-live="polite"></p><div class="row"><button class="icon-btn" type="button" id="pgp${k}" aria-label="Previous move">${ic("chevron-left")}</button><span class="small num" id="pgn${k}"></span><button class="pri" type="button" id="pgx${k}">Next move${ic("chevron-right","sm")}</button></div>${b.src?`<span class="small">From a real game: Lichess puzzle ${esc(b.src)}</span>`:""}</figcaption></figure>`
  :`<figure class="pg-fig"><div class="boardwrap" id="pgb${k}"></div><figcaption class="small">${esc(b.c||"")}</figcaption></figure>`).join("");
 pg.forEach((b,k)=>{if(b.s){const c=new Chess();b.s.split(" ").forEach(m=>c.move(m));b.d=c.fen();const h=c.history({verbose:true}).pop();if(h&&!b.a)b.last={from:h.from,to:h.to}}if(!b.d&&!b.w)return;const B=new Board($("#pgb"+k),{label:b.c||"Diagram"});PGB.push(B);
  if(b.d){B.flip=b.o?b.o==="b":b.d.split(" ")[1]==="b";B.set(b.d,{last:b.last,arrows:(b.a||[]).map(([f,t,c])=>({from:f,to:t,c}))});return}
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
 const lN=n=>TX("lvl."+n,n);if(i<LEVELS.length-1)return {name:lN(LEVELS[i][0]),next:lN(LEVELS[i+1][0]),from:LEVELS[i][1],to:LEVELS[i+1][1]};
 const k=xp<20000?-1:Math.floor((xp-20000)/8000),nm=j=>j<0?lN("King"):lN("King")+" "+(ROMAN[j]||j+1),from=k<0?12000:20000+k*8000;return {name:nm(k),next:nm(k+1),from,to:k<0?20000:from+8000}}
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
function gCheck(xp0){if(!P||!GS)return;const xp=gXP(),l0=gLevel(xp0==null?xp:xp0).name,l1=gLevel(xp).name;if(l1!==l0)gToast(T("t.level",{l:l1}));
 const c=gCtx();let ch=false;for(const [id,nm] of BADGES.map(x=>[x[0],x[1],x[3]]).filter(x=>x[2](c))){if(!GS.badges[id]){GS.badges[id]=Date.now();ch=true;gToast(T("t.badge",{b:TX("b."+id,nm)}))}}
 const R=GS.rec,bw=Math.max(0,...gWeeks().filter(w=>w<wkOf(dkey())).map(w=>wkSum(w).xp),wkSum(wkOf(dkey())).xp),s=stats();
 const beat=(k,v,better,txt)=>{if(v==null)return;if(R[k]==null){R[k]=v;ch=true}else if(better(v,R[k])){R[k]=v;ch=true;gToast(txt)}};
 beat("bw",bw||null,(a,b)=>a>b,T("t.recWeek",{xp:bw}));beat("ls",c.best||null,(a,b)=>a>b,T("t.recStreak",{n:c.best}));
 if(s.nAn>=20&&s.errs!=null)beat("bb",+s.errs.toFixed(2),(a,b)=>a<b-.04,T("t.recBl",{n:fmtN(+s.errs.toFixed(1))}));
 if(ch)gSave()}
/* record training: o = {pz: 1, p1: 1, ...} */
function gAdd(o){if(!P||!GS)return;const xp0=gXP(),t=dkey(),d=GS.days[t]||(GS.days[t]={}),h=new Date().getHours();for(const k in o)d[k]=(d[k]||0)+o[k];
 if(h>=23||h<4)d.n=1;else if(h<7)d.e=1;if(!d.g&&dayU(d)>=gGoal()){d.g=1;gToast(T("t.goal",{xp:GX.g}));Snd.play("goal")}
 const w=wkSum(wkOf(t));if(w.done&&!(GS.wkt===wkOf(t))){GS.wkt=wkOf(t);gToast(T("t.week",{c:TX("ch."+w.ch.k,w.ch.t),xp:WK_BONUS}))}
 gSave();gCheck(xp0);if(route.sec==="home")renderHome()}
/* merge two states (sync): day counts max, badges earliest, records best, settings newest, reviewed union */
function gMerge(a,b){const o=gNew();o.days=JSON.parse(JSON.stringify(a.days||{}));for(const k in b.days||{}){const d=o.days[k]||(o.days[k]={});for(const f in b.days[k])d[f]=Math.max(d[f]||0,b.days[k][f]||0)}
 o.badges={...(a.badges||{})};for(const k in b.badges||{})o.badges[k]=Math.min(o.badges[k]||Infinity,b.badges[k]);
 const ra=a.rec||{},rb=b.rec||{},mx=(x,y)=>x==null?y:y==null?x:Math.max(x,y),mn=(x,y)=>x==null?y:y==null?x:Math.min(x,y);o.rec={bw:mx(ra.bw,rb.bw),ls:mx(ra.ls,rb.ls),bb:mn(ra.bb,rb.bb)};
 o.set=((b.set||{}).at||0)>((a.set||{}).at||0)?{...o.set,...b.set}:{...o.set,...(a.set||{})};o.rev={...(a.rev||{}),...(b.rev||{})};o.wkt=a.wkt||b.wkt;o.at=Math.max(a.at||0,b.at||0);return o}
const gRow=()=>({weekly_xp:GS?wkSum(wkOf(dkey())).xp:0,xp_week:wkOf(dkey()),streak:GS?gStreak().cur:0});
/* "You passed X this week!": friends ahead of me last time I looked, behind me now */
function lbPassed(rows){const wk=wkOf(dkey()),xp=r=>r.xp_week===wk?r.weekly_xp||0:0,me=rows.find(r=>r.is_me);if(!me)return [];const mine=xp(me),ahead=rows.filter(r=>!r.is_me&&xp(r)>mine).map(r=>r.display_name||"?");
 const prev=LS.get(uk("lbseen"),null),out=prev&&prev.wk===wk?prev.ahead.filter(n=>!ahead.includes(n)&&rows.some(r=>(r.display_name||"?")===n)):[];LS.set(uk("lbseen"),{wk,ahead});return out}

/* ---------- GAME CARDS (Home's latest game, the Review list) ----------
   A card shows when, the result and how, colours, opponent and ratings, opening and time control, a small board of the
   decisive position and one sentence that sums the game up, built from fixed rules over the analysis (gameStory). */
/* a static board picture (no input): FEN, orientation, {last: {from,to}, arrow: {from,to,c}} */
function miniBoard(fen,flip,o){o=o||{};const B=new Chess(fen).board(),F="abcdefgh",xy=sq=>{let f=F.indexOf(sq[0]),r=8-+sq[1];return flip?[7-f,7-r]:[f,r]};let s="";
 for(let r=0;r<8;r++)for(let f=0;f<8;f++){const [x,y]=flip?[7-f,7-r]:[f,r];s+=`<rect x="${x}" y="${y}" width="1" height="1" style="fill:var(${(r+f)%2?"--sq-d":"--sq-l"})"/>`}
 if(o.last)for(const sq of [o.last.from,o.last.to]){const [x,y]=xy(sq);s+=`<rect x="${x}" y="${y}" width="1" height="1" style="fill:var(--hl-last)"/>`}
 const src=p=>`vendor/pieces/${UI.pieces==="bold"?"bold":"cburnett"}/${p.color}${p.type.toUpperCase()}.svg`;
 for(let r=0;r<8;r++)for(let f=0;f<8;f++){const p=B[r][f];if(!p)continue;const [x,y]=flip?[7-f,7-r]:[f,r];s+=`<image href="${src(p)}" x="${x}" y="${y}" width="1" height="1"/>`}
 if(o.arrow){const [x1,y1]=xy(o.arrow.from),[x2,y2]=xy(o.arrow.to),dx=x2-x1,dy=y2-y1,L=Math.hypot(dx,dy)||1,ux=dx/L,uy=dy/L,ex=x2+.5-ux*.32,ey=y2+.5-uy*.32,c=`var(--ar-${o.arrow.c||"red"})`;
  s+=`<line x1="${x1+.5}" y1="${y1+.5}" x2="${ex}" y2="${ey}" stroke="${c}" stroke-width=".17" stroke-linecap="round" opacity=".9"/><path d="M${x2+.5} ${y2+.5} L${ex-uy*.26} ${ey+ux*.26} L${ex+uy*.26} ${ey-ux*.26}Z" fill="${c}" opacity=".9"/>`}
 return `<svg class="mini" viewBox="0 0 8 8"${o.label?` role="img" aria-label="${esc(o.label)}"`:' aria-hidden="true"'}>${s}</svg>`}
const mvTxt=(g,i)=>mvLabel(i)+g.moves[i];
/* the result in words: "Won by checkmate", "Lost, you left the game", "Draw by repetition" */
function resultLine(g){const h=g.how,r=g.result;if(r==="draw")return T("res.draw."+({agreed:"agreed",repetition:"rep",stalemate:"stale",insufficient:"ins","50move":"fifty",timevsinsufficient:"timeIns"}[h]||"x"));
 const k={checkmated:"mate",resigned:"resign",timeout:"time",abandoned:"left"}[h]||"x";return T(`res.${r}.${k}`)}
/* one sentence that sums the game up, and the ply of the position worth showing */
function gameStory(g){if(!g.an)return {t:T("story.none"),p:null};replay(g);const sd=g.color==="w"?1:-1,n=g.an.ev.length-1,ev=p=>sd*(g.an.ev[p]==null?0:g.an.ev[p]),er=errorsOf(g);
 const mine=er.filter(e=>e.mine&&e.kind!=="inacc"),theirs=er.filter(e=>!e.mine&&e.kind!=="inacc"),end=ev(n),evs=g.an.ev.map((_,p)=>ev(p)),mx=Math.max(...evs),mn=Math.min(...evs);
 const S=(k,v,p)=>({t:T("story."+k,v),p:p==null?null:p});
 if(g.result==="loss"&&g.how==="timeout")return S(end>=150?"timeBetter":end<=-150?"timeWorse":"time",null,null);
 if(g.result==="loss"&&g.how==="abandoned")return S(end>=150?"leftBetter":end<=-150?"leftWorse":"left");
 if(g.result==="win"&&g.how==="timeout"&&end<=-150)return S("theirTime");
 const slip=mine.find(e=>e.before>=200&&e.after<120);
 if(slip&&g.result!=="win")return S("slip",{mv:mvTxt(g,slip.i)},slip.i);
 if(g.result==="win"){const gift=theirs.find(e=>-e.before<=80&&-e.after>=200);
  if(!mine.length)return S(g.how==="checkmated"?"cleanMate":"clean",null,gift?gift.i:null);
  if(mn<=-200&&mine.some(e=>e.after<=-200))return S("comeback",null,mine[mine.length-1].i);
  if(gift)return S("gift",{n:Math.floor(gift.i/2)+1},gift.i);
  return mine.length===1?S("winSlip",{mv:mvTxt(g,mine[0].i)},mine[0].i):S("winMessy",{n:mine.length},mine[0].i)}
 if(g.result==="loss"){const big=mine.filter(e=>e.kind==="blunder").sort((a,b)=>b.drop-a.drop)[0];
  if(big&&big.before>-150)return S("oneBlunder",{mv:mvTxt(g,big.i)},big.i);
  if(!mine.length)return S("noMistakes");
  return S("slips",{n:mine.length},mine[0].i)}
 if(mx>=200)return S("drawWin",null,slip?slip.i:null);if(mn<=-200)return S("drawSaved");return S("drawEven")}
/* the card itself; opts.compact for small lists */
function gameCard(g){const st=gameStory(g),flip=g.color==="b";replay(g);const p=st.p,fen=p==null?g._f[g.moves.length]:g._f[p],m=p==null?g._m[g.moves.length-1]:g._m[p];
 const board=miniBoard(fen,flip,p==null?{last:m?{from:m.from,to:m.to}:null}:{arrow:{from:m.from,to:m.to,c:"red"}}),col=T(g.color==="w"?"card.white":"card.black");
 return `<article class="gcard ${g.result}"><div class="gcard-board">${board}</div><div class="gcard-body">`+
  `<div class="gcard-top"><b class="gcard-res"><span class="dot" aria-hidden="true"></span>${esc(resultLine(g))}</b><span class="small num">${esc(fmtWhen(g.ts))}</span></div>`+
  `<p class="gcard-who">${T("card.vs",{col,opp:esc(g.opp),oppR:g.oppR||"?",myR:g.myR||"?"})}</p><p class="small gcard-op">${esc(famOf(g.eco))}, ${esc(tcName(g.tc))}</p>`+
  `<p class="story">${esc(st.t)}</p>`+
  `<a class="gcard-link" href="#review" data-g="${esc(g.id)}"><span class="sr-only">${esc(T("card.open",{res:resultLine(g),opp:g.opp}))}</span></a>`+
  (g.an?"":`<button class="gcard-an" type="button" data-an="${esc(g.id)}">${ic("cpu","sm")}${esc(T("card.analyse"))}</button>`)+`</div></article>`}
const tcName=tc=>{const {base,inc}=tcParts(tc);return T(inc?"card.tcInc":"card.tc",{min:Math.round(base/60),inc})};
/* one delegated handler for every game card on the page */
document.addEventListener("click",e=>{const a=e.target.closest(".gcard-link[data-g]"),an=e.target.closest(".gcard-an[data-an]");
 if(an){e.preventDefault();const g=GAMES.find(x=>x.id===an.dataset.an);if(g){queue([g],true);an.disabled=true;an.textContent=T("card.queued")}return}
 if(a){e.preventDefault();const g=GAMES.find(x=>x.id===a.dataset.g);if(g){const s=gameStory(g);openReview(g,s.p!=null?s.p:keyPly(g))}}});
/* where a game view should open: the first key moment, else the start */
const keyPly=g=>{const e=g.an?serious(replay(g))[0]:null;return e?e.i:0};

/* ---------- HOME ---------- */
let HOMEtok=0;
function planCards(){const C=[],st=id=>TS[id]||{},retry=PZ.filter(p=>st(p.id).fail&&!st(p.id).ok),fresh=PZ.filter(p=>!st(p.id).seen),un=GAMES.filter(g=>!g.an).length,now=Date.now();
 const due=Object.values(OPS).filter(x=>x.due&&x.due<=now).length,loss=GAMES.slice().reverse().find(g=>g.result==="loss"&&g.an);
 if(retry.length){const n=Math.min(retry.length,5);C.push({imp:30+retry.length*3,t:TP("plan.retry",n),p:T("plan.retryP"),xp:n*GX.pz,i:"rotate-ccw",cta:T("plan.retryGo"),act:()=>tStart("retry")})}
 if(due){const n=Math.min(due,10);C.push({imp:26+due*2,t:TP("plan.due",n),p:T("plan.dueP"),xp:n*GX.op,go:"#train/openings",i:"book-open",cta:T("plan.dueGo")})}
 if(loss&&!GS.rev[loss.id]){const s=gameStory(loss);C.push({imp:28,t:T("plan.loss",{opp:loss.opp}),p:s.t,xp:GX.rv,i:"scan-search",cta:T("plan.lossGo"),act:()=>openReview(loss,s.p!=null?s.p:keyPly(loss))})}
 if(fresh.length){const n=Math.min(fresh.length,5);C.push({imp:20,t:TP("plan.fresh",n),p:T("plan.freshP"),xp:n*GX.pz,i:"puzzle",cta:T("plan.freshGo"),act:()=>tStart("warm")})}
 if(un){const n=Math.min(un,20);C.push({imp:15+n,t:TP("plan.analyse",n),p:T("plan.analyseP"),xp:null,i:"cpu",cta:T("plan.analyseGo"),act:()=>{analyseRecent(20);renderHome()}})}
 const ost=LS.get(uk("opstart"),{}),m={};GAMES.filter(g=>g.ts>now-365*864e5).forEach(g=>{const k=g.color+"|"+famOf(g.eco);(m[k]=m[k]||[]).push(g)});
 const colN=k=>T(k[0]==="w"?"card.asWhite":"card.asBlack");
 const weak=Object.entries(m).filter(([k,a])=>a.length>=5&&!ost[k]&&score(a)<45).sort((a,b)=>score(a[1])-score(b[1]))[0];
 if(weak)C.push({imp:18,t:T("plan.weakOp",{op:weak[0].slice(2),col:colN(weak[0])}),p:T("plan.weakOpP",{s:Math.round(score(weak[1])),n:weak[1].length}),xp:5*GX.op,i:"book-open",cta:T("plan.weakOpGo"),act:()=>opGo(weak[0],true)});
 const W=wkProfile(),lp=lsPriority().find(x=>{const T=lsTarget(x.to,W);return T&&!lsDone(T.l.id)}),fs=["new","beg"].includes(lvl())?TRACKS[0].courses[0].chapters.map(nextLesson).find(l=>!lsDone(l.id)):null,lx=fs?{to:fs.id,name:"First steps",reason:T("plan.firstSteps")}:lp;
 if(lx){const Tg=lsTarget(lx.to,W),left=Tg.l.steps.length-((LSP["l:"+Tg.l.id]||{}).s||0);C.push({imp:fs?40:27+Math.min(12,lx.cost*2||0),t:T("plan.lesson",{name:Tg.co.pz||Tg.co.op||Tg.co.eg?Tg.ch.name+(Tg.co.eg&&!Tg.ch.pz?": "+Tg.l.name:""):Tg.l.name}),p:lx.reason,xp:Math.max(1,left)*GX.ls,i:"graduation-cap",cta:T("plan.lessonGo"),act:()=>{location.hash="train/lessons";openLesson(Tg.l.id)}})}
 // fallbacks so there are always a few things to do
 const last=GAMES.slice().reverse().find(g=>g.an&&!GS.rev[g.id]&&g!==loss);if(C.length<3&&last)C.push({imp:8,t:T("plan.game",{opp:last.opp}),p:T("plan.gameP"),xp:GX.rv,i:"scan-search",cta:T("plan.lossGo"),act:()=>openReview(last,keyPly(last))});
 const top=Object.entries(m).filter(([,a])=>a.length>=3).sort((a,b)=>b[1].length-a[1].length)[0];
 if(C.length<3&&top&&!C.some(c=>c.i==="book-open"))C.push({imp:6,t:T("plan.drill",{op:top[0].slice(2),col:colN(top[0])}),p:TP("plan.drillP",top[1].length),xp:5*GX.op,i:"book-open",cta:T("plan.drillGo"),act:()=>opGo(top[0],true)});
 return C.sort((a,b)=>b.imp-a.imp).slice(0,5)}
function ringSVG(d,goal,small){const R=42,L=2*Math.PI*R;let off=0,s=`<svg viewBox="0 0 100 100" class="ring${small?" sm":""}" role="img" aria-label="${esc(T("tro.ringLabel",{n:Math.min(dayU(d),goal),goal}))}"><circle cx="50" cy="50" r="${R}" fill="none" stroke="var(--border)" stroke-width="10"/>`;
 for(const [k,col] of [["pz","var(--q-blunder)"],["op","var(--q-best)"],["rv","var(--info)"],["ls","var(--gold)"]]){const f=Math.min((d[k]||0)*GU[k],Math.max(0,goal-off))/goal;if(f<=0)continue;
  s+=`<circle cx="50" cy="50" r="${R}" fill="none" stroke="${col}" stroke-width="10" stroke-dasharray="${f*L} ${L}" stroke-dashoffset="${-off/goal*L}" transform="rotate(-90 50 50)"/>`;off+=f*goal}
 return s+(small?"":`<text x="50" y="47" text-anchor="middle" class="ring-n">${Math.min(dayU(d),goal)}/${goal}</text><text x="50" y="63" text-anchor="middle" class="ring-l">${esc(T(d.g?"tro.goalMet":"tro.today"))}</text>`)+"</svg>"}
/* today's focus: the single most useful insight, with the action that trains it */
function focusOf(){const ins=insights()[0];if(!ins)return null;return ins}
function renderHome(){if(!P||!GS)return;++HOMEtok;const hide=GS.set.hide,today=GS.days[dkey()]||{},goal=gGoal(),st=gStreak(),xp=gXP(),lv=gLevel(xp);
 const hr=new Date().getHours();$("#hHello").textContent=T(hr<5?"home.late":hr<12?"home.morning":hr<18?"home.afternoon":"home.evening",{name:P.user});
 // today's focus: one sentence, one action
 const f=focusOf();$("#hFocus").hidden=!f;if(f){$("#hFocus").innerHTML=`<h2 class="focus-k">${esc(T("home.focus"))}</h2><p class="focus-t">${esc(f.t)}</p><a class="btn-link" href="${f.go||"#train/puzzles"}">${esc(f.cta||T("home.focusGo"))}${ic("arrow-right","sm")}</a>`}
 // today's plan: the top three, the first one is the main action
 const C=planCards().slice(0,3);
 $("#hPlan").innerHTML=C.length?C.map((c,i)=>`<li class="plan-card${i===0?" top":""}"><span class="plan-ic" aria-hidden="true">${ic(c.i||"target")}</span><div class="plan-txt"><b>${esc(c.t)}</b><p>${esc(c.p)}</p></div><div class="plan-go">${!hide&&c.xp?`<span class="xp">+${fmtN(c.xp)} XP</span>`:""}<button class="${i===0?"pri":"ghost"}" type="button" data-plan="${i}">${esc(c.cta||T("plan.open"))}</button></div></li>`).join("")
  :`<li class="empty-line">${esc(T("plan.none"))}</li>`;
 $("#hPlan").querySelectorAll("[data-plan]").forEach(b=>b.onclick=()=>{const c=C[+b.dataset.plan];if(c.go)location.hash=c.go.slice(1);else c.act()});
 // streak, daily goal and level in one strip (details on Progress › Trophies)
 $("#hStrip").hidden=hide;if(!hide)$("#hStrip").innerHTML=(st.cur?`<span class="hs-item">${ic("flame")}<b class="num">${fmtN(st.cur)}</b> ${esc(TP("home.streakLbl",st.cur))}</span>`:`<span class="hs-item">${ic("flame")}${esc(T("home.streakStart"))}</span>`)+`<span class="hs-item">${ringSVG(today,goal,true)}<span>${esc(T("home.goal",{n:fmtN(Math.min(dayU(today),goal)),goal:fmtN(goal)}))}</span></span><span class="hs-item">${ic("shield-check")}<b>${esc(lv.name)}</b>${xp?` <span class="num">${fmtN(xp)} XP</span>`:""}</span><span class="hs-more">${esc(T("home.trophies"))}${ic("chevron-right","sm")}</span>`;
 // latest game, as in Review
 const g=GAMES[GAMES.length-1],nw=SEEN0?GAMES.filter(x=>x.ts>SEEN0).length:0;
 $("#hNew").textContent=nw>1?TP("home.newGames",nw):T("home.allGames");
 $("#hLatest").innerHTML=g?gameCard(g):`<p class="empty-line">${esc(T("home.noGames"))}</p>`}

/* ---------- TROPHIES (Progress › Trophies) ---------- */
function renderTrophies(){if(!P||!GS)return;const today=GS.days[dkey()]||{},goal=gGoal(),st=gStreak(),xp=gXP(),lv=gLevel(xp),w=wkSum(wkOf(dkey()));
 $("#tHiddenNote").hidden=!GS.set.hide;
 $("#trLevel").innerHTML=`<span class="tro-ic">${ic("shield-check","lg")}</span><div><b class="tro-big">${esc(lv.name)}</b><span class="small num">${esc(T("tro.xpTo",{xp:fmtN(xp),left:fmtN(lv.to-xp),next:lv.next}))}</span><div class="meter"><b style="width:${Math.round((xp-lv.from)/(lv.to-lv.from)*100)}%;background:var(--gold)"></b></div></div>`;
 $("#trStreak").innerHTML=`<span class="tro-ic${st.cur?" on":""}">${ic("flame","lg")}</span><div><b class="tro-big num">${esc(TP("home.streakDays",st.cur))}</b><span class="small">${esc(st.fz?TP("tro.freezes",st.fz):T("tro.freezeEvery"))}</span><span class="small">${esc(T("tro.best",{n:fmtN(Math.max(st.best,GS.rec.ls||0))}))}</span></div>`;
 $("#hRing").innerHTML=ringSVG(today,goal);
 $("#hRingTxt").innerHTML=`<b>${esc(T("tro.goalToday"))}</b><ul class="goal-key"><li><span class="k" style="background:var(--q-blunder)"></span>${esc(T("tro.kPz"))} <b>${today.pz||0}</b></li><li><span class="k" style="background:var(--q-best)"></span>${esc(T("tro.kOp"))} <b>${today.op||0}</b></li><li><span class="k" style="background:var(--info)"></span>${esc(T("tro.kRv"))} <b>${today.rv||0}</b></li><li><span class="k" style="background:var(--gold)"></span>${esc(T("tro.kLs"))} <b>${today.ls||0}</b></li></ul>`;
 document.querySelectorAll('[name="hInt"]').forEach(r=>r.checked=r.value===(GS.set.int||"normal"));
 $("#hChallenge").innerHTML=`<div class="lv-row"><span class="lv-name">${ic("trophy")}<b>${esc(TX("ch."+w.ch.k,w.ch.t))}</b></span><span class="small num">${fmtN(w.chv)} / ${fmtN(w.ch.n)}, +${WK_BONUS} XP</span></div><div class="meter"><b style="width:${Math.round(Math.min(1,w.chv/w.ch.n)*100)}%;background:var(--gold)"></b></div>`;
 const earned=BADGES.filter(([id])=>GS.badges[id]),locked=BADGES.filter(([id])=>!GS.badges[id]);
 const show=earned.concat(locked.slice(0,Math.max(4,8-earned.length))),bc=gCtx(),bp=f=>{const m=/c\.(\w+)>=(\d+)/.exec(String(f));return m&&bc[m[1]]!=null?{v:Math.min(+bc[m[1]]||0,+m[2]),n:+m[2]}:null};
 $("#hBadges").innerHTML=show.map(([id,nm,how,f])=>{const p=GS.badges[id]?null:bp(f);return `<li class="badge${GS.badges[id]?"":" locked"}"><span class="bdg" aria-hidden="true">${ic(BICON[id]||"award")}</span><b>${esc(TX("b."+id,nm))}</b><span class="small">${GS.badges[id]?esc(T("tro.earned",{d:fmtDay(GS.badges[id])})):esc(TX("b."+id+".h",how))}</span>${p&&p.n>1?`<span class="bdg-p"><span class="meter"><b style="width:${p.v/p.n*100}%;background:var(--gold)"></b></span><span class="small num">${fmtN(p.v)} / ${fmtN(p.n)}</span></span>`:""}</li>`}).join("")+(show.length<BADGES.length?`<li class="badge-more"><button class="ghost" type="button" id="badgeAll">${esc(T("tro.allBadges",{n:BADGES.length}))}</button></li>`:"");
 const ba=$("#badgeAll");if(ba)ba.onclick=()=>{$("#hBadges").innerHTML=earned.concat(locked).map(([id,nm,how])=>`<li class="badge${GS.badges[id]?"":" locked"}"><span class="bdg" aria-hidden="true">${ic(BICON[id]||"award")}</span><b>${esc(TX("b."+id,nm))}</b><span class="small">${GS.badges[id]?esc(T("tro.earned",{d:fmtDay(GS.badges[id])})):esc(TX("b."+id+".h",how))}</span></li>`).join("")};
 const R=GS.rec;$("#hRecords").innerHTML=`<li>${ic("zap")}<div><b class="num">${fmtN(R.bw||0)} XP</b><span class="small">${esc(T("tro.bestWeek"))}</span></div></li><li>${ic("flame")}<div><b class="num">${esc(TP("home.streakDays",Math.max(R.ls||0,st.best)))}</b><span class="small">${esc(T("tro.longest"))}</span></div></li><li>${ic("shield-check")}<div><b class="num">${R.bb==null?"—":fmtN(R.bb,{maximumFractionDigits:1,minimumFractionDigits:1})}</b><span class="small">${esc(T("tro.fewest"))}</span></div></li>`}
document.querySelectorAll('[name="hInt"]').forEach(r=>r.onchange=()=>{GS.set={...GS.set,int:r.value,at:Date.now()};const d=GS.days[dkey()];if(d&&!d.g&&dayU(d)>=gGoal())d.g=1;gSave();renderTrophies()});

/* ---------- PROGRESS + rule-based insights ---------- */
function stats(){const G=GAMES,recent=G.slice(-30),an=G.filter(g=>g.an),lastAn=an.slice(-20);
 const tu=recent.map(timeUsed).filter(x=>x!=null),errs=lastAn.map(g=>serious(g).length);
 return {rating:G.length?G[G.length-1].myR:null,time:median(tu),errs:errs.length?errs.reduce((a,b)=>a+b,0)/errs.length:null,score:score(recent),nAn:an.length}}
function maybeBaseline(){if(LS.get(uk("base."+P.tc),null))return;const s=stats();if(s.nAn>=10){LS.set(uk("base."+P.tc),{...s,date:new Date().toISOString().slice(0,10)});Sync.mark("base",acct()+"|"+P.tc)}}
/* insights: fixed rules, plain words; each has a short title t, a paragraph p, and where to train it (go, cta) */
function insights(){const G=GAMES,yr=G.filter(g=>g.ts>Date.now()-365*864e5),an=G.filter(g=>g.an).slice(-50),out=[];const B=baseSecs();
 if(!an.length&&!yr.length)return out;
 const errs=[];an.forEach(g=>{replay(g);const all=errorsOf(g);all.filter(e=>e.mine&&e.kind!=="inacc").forEach(e=>errs.push({g,e,prev:all.find(o=>o.i===e.i-1&&!o.mine&&o.kind!=="inacc")}))});
 const tu=G.slice(-30).map(timeUsed).filter(x=>x!=null),med=median(tu),colN=c=>T(c==="w"?"card.white":"card.black"),I=(w,c,k,v,go,cta)=>out.push({w,c,t:T("ins."+k+".t",v),p:T("ins."+k+".p",v),go,cta:T(cta)});
 const lastLoss=G.slice().reverse().find(g=>g.result==="loss");
 if(med!=null&&med<B*.5){const plenty=errs.filter(o=>o.g.clocks&&o.g.clocks[o.e.i]>B*.3).length;
  I(10,"hi","time",{used:mmss(med),min:Math.round(B/60),aim:mmss(B*.7),pct:errs.length?Math.round(plenty/errs.length*100):0},"#review","ins.goReview")}
 if(errs.length>=5){const win=errs.filter(o=>o.e.before>200).length;if(win/errs.length>=.35)I(9,"hi","slip",{n:win,all:errs.length,games:an.length},"#train/puzzles","ins.goPuzzles")}
 const unp=errs.filter(o=>o.prev).length;if(unp>=3)I(8,"hi","punish",{n:unp},"#train/puzzles","ins.goPuzzles");
 const mates=errs.filter(o=>o.e.after<=-9000||(o.e.before>=9000&&o.e.after<9000)).length;if(mates>=2)I(7,"hi","mates",{n:mates},"#train/lessons","ins.goLessons");
 if(errs.length>=8){const ph={opening:0,middlegame:0,endgame:0};errs.forEach(o=>{const m=o.e.i/2+1;ph[m<=12?"opening":m<=30?"middlegame":"endgame"]++});const top=Object.entries(ph).sort((a,b)=>b[1]-a[1])[0];
  if(top[1]/errs.length>=.45)I(5,"","ph_"+top[0],{n:top[1],all:errs.length},top[0]==="opening"?"#train/openings":top[0]==="endgame"?"#train/lessons":"#train/puzzles",top[0]==="opening"?"ins.goOpenings":top[0]==="endgame"?"ins.goLessons":"ins.goPuzzles")}
 const losses=yr.filter(g=>g.result==="loss");if(losses.length>=10){const to=losses.filter(g=>g.how==="timeout").length;if(to/losses.length>=.2)I(8,"hi","onTime",{n:to,all:losses.length},"#review","ins.goReview")}
 const op={};yr.forEach(g=>{const k=g.color+"|"+famOf(g.eco);(op[k]=op[k]||[]).push(g)});const ops=Object.entries(op).filter(([,a])=>a.length>=15).map(([k,a])=>({k,n:a.length,s:score(a)}));
 const worst=ops.slice().sort((a,b)=>a.s-b.s)[0],best=ops.slice().sort((a,b)=>b.s-a.s)[0];
 if(worst&&worst.s<44)I(6,"hi","worstOp",{op:worst.k.split("|")[1],col:colN(worst.k[0]),s:Math.round(worst.s),n:worst.n},"#train/openings","ins.goOpenings");
 if(best&&best.s>58)I(3,"ok","bestOp",{op:best.k.split("|")[1],col:colN(best.k[0]),s:Math.round(best.s),n:best.n},"#train/openings","ins.goOpenings");
 const long=yr.filter(g=>g.moves.length>=120);if(long.length>=10){const d=score(yr)-score(long);if(d>=10)I(5,"","long",{s:Math.round(score(long)),all:Math.round(score(yr))},"#train/lessons","ins.goLessons")}
 const w=yr.filter(g=>g.color==="w"),b=yr.filter(g=>g.color==="b");if(w.length>=30&&b.length>=30){const d=score(w)-score(b);if(Math.abs(d)>=8)I(4,"","colour",{col:colN(d>0?"b":"w"),w:Math.round(score(w)),b:Math.round(score(b))},"#train/openings","ins.goOpenings")}
 const ost=LS.get(uk("opstart"),{});for(const k in ost){const e=opEffect(k,ost[k]);if(e)I(6.5,e.a>=e.b?"ok":"",e.a>=e.b?"effUp":"effDown",{op:e.fam,a:Math.round(e.a),b:Math.round(e.b),col:colN(e.col),na:e.na,nb:e.nb,d:fmtDay(Date.parse(e.date))},"#train/openings","ins.goOpenings")}
 if(!out.length&&an.length>=10)I(1,"ok","none",{},"#train/puzzles","ins.goPuzzles");
 void lastLoss;return out.sort((a,b)=>b.w-a.w).slice(0,5)}
function chart(el,pts,o){const draw=()=>{const W=el.clientWidth||500,H=el.clientHeight||260,pad={l:44,r:10,t:10,b:24};if(pts.length<2){el.innerHTML='<div class="empty" style="height:100%;display:grid;place-items:center">Not enough games yet</div>';return}
 const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y).concat(o.goal!=null?[o.goal]:[]),x0=Math.min(...xs),x1=Math.max(...xs),y0=o.y0!=null?o.y0:Math.min(...ys),y1=Math.max(...ys)+(o.pad||0);
 const X=x=>pad.l+(x1===x0?.5:(x-x0)/(x1-x0))*(W-pad.l-pad.r),Y=y=>pad.t+(1-(y-y0)/((y1-y0)||1))*(H-pad.t-pad.b);
 let s=`<svg viewBox="0 0 ${W} ${H}">`+[0,.5,1].map(t=>y0+t*(y1-y0)).map(t=>`<line x1="${pad.l}" x2="${W-pad.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--border)"/><text x="${pad.l-6}" y="${Y(t)+4}" text-anchor="end" font-size="12" font-weight="700" style="fill:var(--muted)" font-family="Atkinson Hyperlegible Next,system-ui,sans-serif">${o.fmt?o.fmt(t):Math.round(t)}</text>`).join("");
 if(o.goal!=null)s+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${Y(o.goal)}" y2="${Y(o.goal)}" stroke="var(--q-mistake)" stroke-width="2" stroke-dasharray="6 4"/>`;
 if(o.line)s+=`<path d="${pts.map((p,i)=>(i?"L":"M")+X(p.x).toFixed(1)+","+Y(p.y).toFixed(1)).join("")}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linejoin="round"/>`;
 if(o.dots)s+=pts.map(p=>`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${W<520?2.5:3.5}" fill="${p.c||"var(--text)"}" opacity=".75"/>`).join("");
 if(o.avg){const av=pts.map((p,i)=>{const w=pts.slice(Math.max(0,i-9),i+1);return {x:p.x,y:w.reduce((s,q)=>s+q.y,0)/w.length}});s+=`<path d="${av.map((p,i)=>(i?"L":"M")+X(p.x).toFixed(1)+","+Y(p.y).toFixed(1)).join("")}" fill="none" stroke="var(--secondary)" stroke-width="2.5"/>`}
 if(o.xl){const l=o.xl(x0,x1);s+=l.filter((_,i,a)=>W>=520||i===0||i===a.length-1).map(q=>`<text x="${X(q.x)}" y="${H-6}" text-anchor="middle" font-size="12" font-weight="700" style="fill:var(--muted)" font-family="Atkinson Hyperlegible Next,system-ui,sans-serif">${q.t}</text>`).join("")}
 el.innerHTML=s+"</svg>"};el._draw=draw;draw();if(!el._ro){el._ro=new ResizeObserver(()=>el._draw());el._ro.observe(el)}}
function timeLabels(x0,x1){const span=x1-x0,out=[];if(span>540*864e5){for(let y=new Date(x0).getFullYear()+1;y<=new Date(x1).getFullYear();y++)out.push({x:Date.UTC(y,0,1),t:y})}else{const d=new Date(x0);d.setUTCDate(1);const step=span>180*864e5?3:span>60*864e5?1:0;if(!step)return out;for(d.setUTCMonth(d.getUTCMonth()+1);d.getTime()<=x1;d.setUTCMonth(d.getUTCMonth()+step))out.push({x:d.getTime(),t:d.toLocaleString("en",{month:"short",timeZone:"UTC"})})}return out}
function renderProgress(){const G=GAMES,s=stats(),base=LS.get(uk("base."+P.tc),null),B=baseSecs(),ins=insights();
 $("#pSub").textContent=T("pr.sub",{n:fmtN(G.length),a:fmtN(s.nAn)})+" "+(base?T("pr.base",{when:fmtDay(Date.parse(base.date))}):T("pr.noBase"));
 $("#insights").innerHTML=ins.length?ins.map(i=>`<div class="ins ${i.c}"><b>${esc(i.t)}</b><p>${esc(i.p)}</p>${i.go?`<a class="ins-go" href="${i.go}">${esc(i.cta)}${ic("arrow-right","sm")}</a>`:""}</div>`).join(""):`<div class="empty">${esc(T(AQ?"pr.insWait":"pr.insNone"))}</div>`;
 const dl=(v,b,f)=>b==null||v==null?"":`<s>${esc(T("pr.since",{d:(v-b>0?"+":v-b<0?"−":"±")+f(Math.abs(v-b))}))}</s>`;
 const k=(v,l,goal,extra)=>`<div class="kpi${goal?" goal":""}"><b class="num">${v}</b>${esc(l)}${extra||""}</div>`;
 $("#pKpis").innerHTML=k(s.rating??"—",T("pr.kRating"),0,base&&dl(s.rating,base.rating,Math.round))+k(s.score==null?"—":Math.round(s.score)+"%",T("pr.kScore"))+
  k(mmss(s.time),T("pr.kTime"),1,`<s>${esc(T("pr.kGoal",{g:mmss(B*.7)}))}</s>`+(base?dl(s.time,base.time,mmss):""))+k(s.errs==null?"—":s.errs.toFixed(1),T("pr.kErrs"),1,`<s>${esc(T("pr.kErrGoal"))}</s>`+(base&&base.errs!=null&&s.errs!=null?dl(s.errs,base.errs,x=>x.toFixed(1)):""))+
  k(fmtN(PZ.filter(p=>(TS[p.id]||{}).ok).length),T("pr.kPz"));
 const day={};G.forEach(g=>{day[g.date]=g});const rp=Object.values(day).map(g=>({x:g.ts,y:g.myR}));chart($("#ratingFig"),rp,{line:1,xl:timeLabels});
 $("#timeGoal").textContent=T("pr.timeGoal",{g:mmss(B*.7),m:Math.round(B/60)});
 const tp=G.map(g=>({g,t:timeUsed(g)})).filter(o=>o.t!=null).slice(-60).map((o,i)=>({x:i,y:o.t,c:o.g.result==="win"?"var(--q-best)":o.g.result==="loss"?"var(--q-blunder)":"var(--muted)"}));
 chart($("#timeFig"),tp,{dots:1,avg:1,goal:B*.7,y0:0,fmt:t=>mmss(t)});
 const an=G.filter(g=>g.an).slice(-60);chart($("#errFig"),an.map((g,i)=>({x:i,y:serious(g).length})),{dots:1,avg:1,goal:1,y0:0,pad:.5});
 $("#errNote").textContent=T("pr.errNote",{n:an.length});
 const yr=G.filter(g=>g.ts>Date.now()-365*864e5),kinds={checkmated:"mate",resigned:"resign",abandoned:"left",timeout:"time"};
 const tbl=(a,col,lab)=>{const c={};a.forEach(g=>{const k=kinds[g.how]||"other";c[k]=(c[k]||0)+1});const rows=Object.entries(c).sort((x,y)=>y[1]-x[1]);
  return `<table class="p-ends"><thead><tr><th>${esc(lab)} (${fmtN(a.length)})</th><th class="r">${esc(T("pr.thGames"))}</th><th></th></tr></thead><tbody>${rows.map(([k,n])=>`<tr><td>${esc(T("pr.end."+k))}</td><td class="r">${fmtN(n)}</td><td style="width:45%"><div class="meter"><b style="width:${n/a.length*100}%;background:${col}"></b></div></td></tr>`).join("")||`<tr><td colspan="3" class="small">${esc(T("pr.none"))}</td></tr>`}</tbody></table>`};
 $("#ends").innerHTML=tbl(yr.filter(g=>g.result==="loss"),"var(--q-blunder)",T("pr.losses"))+tbl(yr.filter(g=>g.result==="win"),"var(--q-best)",T("pr.wins"));
 renderOps();const un=G.filter(g=>!g.an).length;$("#anMore").disabled=!un;if(!$("#anNote").dataset.keep)$("#anNote").textContent=un?TP("pr.un",un):T("pr.allAn")}
const opColP=()=>{const r=document.querySelector('input[name="opCol"]:checked');return r?r.value:"w"};
function renderOps(){const col=opColP(),m={};GAMES.filter(g=>g.color===col&&g.ts>Date.now()-365*864e5).forEach(g=>{const f=famOf(g.eco);(m[f]=m[f]||[]).push(g)});
 const rows=Object.entries(m).filter(([,a])=>a.length>=5).sort((a,b)=>b[1].length-a[1].length).slice(0,15);
 $("#opBody").innerHTML=rows.length?rows.map(([f,a])=>{const w=a.filter(g=>g.result==="win").length,d=a.filter(g=>g.result==="draw").length,l=a.length-w-d,s=score(a);
  return `<tr><td data-l="${esc(T("pr.thOp"))}">${esc(f)}</td><td class="r" data-l="${esc(T("pr.thGames"))}">${fmtN(a.length)}</td><td class="r" data-l="${esc(T("pr.thScore"))}" style="color:${s<45?"var(--q-blunder)":s>55?"var(--q-best)":"inherit"};font-weight:700">${Math.round(s)}%</td><td data-l="${esc(T("pr.thWdl"))}"><span class="num">${esc(T("pr.wdl",{w,d,l}))}</span></td><td class="r" data-l=""><button class="link" type="button" data-op="${esc(col+"|"+f)}">${esc(T("pr.open"))}</button></td></tr>`}).join("")
  :`<tr><td colspan="5" class="small">${esc(T("pr.noOps"))}</td></tr>`;
 $("#opBody").querySelectorAll("[data-op]").forEach(b=>b.onclick=()=>opGo(b.dataset.op))}
document.querySelectorAll('input[name="opCol"]').forEach(r=>r.onchange=renderOps);
const pNote=t=>{const n=$("#anNote");n.textContent=t;n.dataset.keep=1;setTimeout(()=>{delete n.dataset.keep},8000)};
$("#anMore").onclick=()=>{analyseRecent(20);pNote(T("pr.queued"))};
$("#pMore").ontoggle=()=>{try{LS.set("pMore",$("#pMore").open?1:0)}catch(e){}};
try{$("#pMore").open=!!LS.get("pMore",0)}catch(e){}
$("#resetBase").onclick=()=>{if(!confirm(T("pr.resetQ")))return;const s=stats();LS.set(uk("base."+P.tc),{...s,date:new Date().toISOString().slice(0,10),manual:new Date().toISOString()});Sync.mark("base",acct()+"|"+P.tc);Fr.soon();renderProgress()};
$("#syncBtn").onclick=async()=>{$("#syncBtn").disabled=true;try{const n=await sync();pNote(n?TP("pr.found",n):T("pr.noNew"));if(n)analyseRecent(n)}catch(e){pNote(T("pr.noReach",{site:SRC[P.source].name}))}$("#syncBtn").disabled=false;renderProgress()};

/* ---------- onboarding ---------- */
const HB=new Board($("#heroBoard"),{label:"Example position"}),HW=new Why($("#heroWhy"),HB),DEMO_FEN="rn1qkbnr/pp2pppp/2p5/5b2/3PN3/8/PPP2PPP/R1BQKBNR w KQkq - 1 5";
const demoLine=(fen,sans)=>{const c=new Chess(fen),L=[];for(const s of sans){const m=c.move(s);if(!m)break;L.push({san:m.san,from:m.from,to:m.to,cap:!!m.captured,fen:c.fen()})}return {fen,L}};
let demoT=null,demoK=0,demoOff=false;
function demoStart(){if(!HW.lines||HW.lang!==LANG){HW.lang=LANG;const kn=TP("pc.n",1);HW.render(cap1(T("why.wrongRL",{mv:"Nd6+",side:T("card.black"),r:"Qxd6",y:T("why.l.lose.y",{a:kn})})+" "+T("why.betterE",{mv:"Ng3",ev:evWords(30)})),
 [{title:T("why.your"),c:"red",x:demoLine(DEMO_FEN,["Nd6+","Qxd6","Qf3","Qd7"]),lab:{t:T("why.l.lose.t",{a:kn})}},{title:T("why.better"),c:"green",x:demoLine(DEMO_FEN,["Ng3","Bg6","Nf3","e6","h4","h6","h5","Bh7"]),lab:null}]);
 HW.o={restore:()=>HB.set(DEMO_FEN)};HB.set(DEMO_FEN);$("#heroWhy").addEventListener("click",()=>{demoOff=true;demoStop()},{once:true})}   // any click there hands control to the visitor
 if(demoT||demoOff||matchMedia("(prefers-reduced-motion: reduce)").matches)return;
 demoT=setInterval(()=>{const seq=[[0,1],[0,2],[0,0],[1,1],[1,2],[1,3],[1,4],[1,5],[1,6],[1,0]],[i,k]=seq[demoK++%seq.length];if(k)HW.step(i,k);else HW.reset()},1600)}
function demoStop(){clearInterval(demoT);demoT=null}
function inviteBanner(on){$("#inviteBanner").hidden=!on}
$("#invSign").onclick=()=>acctOpen();
const srcPick=()=>(document.querySelector('input[name="uSrc"]:checked')||{}).value||"cc";
function srcLabel(){const s=srcPick();$("#uNameLbl").textContent=T("start.user",{site:SRC[s].name});$("#uName").placeholder=s==="li"?"thibault":"magnuscarlsen"}
/* the language switch on the start screen (also in Settings) */
function langSw(){$("#langSw").setAttribute("aria-label",T("start.lang"));$("#langSw").innerHTML=LANGS.filter(l=>I18N[l]).map(l=>`<button type="button" class="ghost" data-lang="${l}" lang="${l}"${l===LANG?' aria-pressed="true"':' aria-pressed="false"'} title="${esc(I18N[l]["lang.name"]||l)}">${l.toUpperCase()}</button>`).join("")}
$("#langSw").onclick=e=>{const b=e.target.closest("[data-lang]");if(b){setLang(b.dataset.lang);langSw();srcLabel()}};
document.querySelectorAll('input[name="uSrc"]').forEach(r=>r.onchange=()=>{srcLabel();LS.set("lastSrc",srcPick())});
$("#startForm").onsubmit=async e=>{e.preventDefault();const u=$("#uName").value.trim().toLowerCase(),tc=(document.querySelector('input[name="uTc"]:checked')||{}).value||"600",s=srcPick(),nm=SRC[s].name;if(!u)return;
 $("#startBtn").disabled=true;$("#startMsg").textContent=T("start.lookup",{site:nm});
 try{const p=s==="li"?await api(`${LI}/api/user/${encodeURIComponent(u)}`,liOpts()):await api(`https://api.chess.com/pub/player/${encodeURIComponent(u)}`);if(p&&p.disabled)throw new Error("notfound")}
 catch(x){$("#startMsg").textContent=x.message==="notfound"?T("start.notFound",{site:nm,u}):T("start.noReach",{site:nm});$("#startBtn").disabled=false;return}
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
  else if(!u&&this.me){this.me=null;Fr.prof=null;acctUI();if(route.sec==="friends")Fr.render()}},
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
  if(P){refreshGames();if(CUR&&CUR.an){renderMoves();renderKM();renderAnState();show()}if(route.sec==="progress")renderProgress();if(route.sec==="trainer")renderTStats();if(route.sec==="home")renderHome();Fr.soon()}
  else if(la.length){const r=la[la.length-1],i=r.account.indexOf(":");P={source:r.account.slice(0,i),user:r.account.slice(i+1),tc:r.tc};LS.set("profile",P);enter(false)}},
 async exportAll(){const out={exported:new Date().toISOString(),account:this.me.email};for(const t of ["linked_accounts","analyses","puzzle_progress","baselines","opening_progress","opening_practice","gamification","lesson_progress","profiles","leaderboard_stats"])out[t]=await this.rows(t,"*");
  const f=await this.sb.rpc("my_friends");if(f.error)throw f.error;out.friends=f.data;return out},
 async signOut(){try{await this.sb.auth.signOut({scope:"local"})}catch(e){}this.me=null;Fr.prof=null;LS.set("sb.out",{});acctUI();if(route.sec==="friends")Fr.render()},
 async deleteAccount(){const {error}=await this.sb.rpc("delete_my_account");if(error)throw error;const id=this.me.id;await this.signOut();try{localStorage.removeItem("rc.sb.init."+id);localStorage.removeItem("rc.sb.pull."+id)}catch(e){}}};

/* account panel */
let acctEmail="",acctDel=false;
function acctMsg(t){$("#acctMsg").textContent=t||""}
function acctOpen(){acctDel=false;acctUI();const d=$("#acct");if(!d.open)d.showModal()}
function acctUI(){if(!SB_ON)return;const me=Sync.me,step=me?"in":acctEmail?"code":"email";
 document.querySelectorAll("[data-acct]").forEach(e=>e.hidden=e.dataset.acct!==step);
 document.querySelectorAll(".acctBtn").forEach(b=>{const l=b.querySelector(".lbl"),t=T(me?"menu.account":"menu.signin");if(l){l.textContent=t;l.dataset.i18n=me?"menu.account":"menu.signin"}else b.textContent=t});
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
 async onSignIn(){try{await this.profile();const code=LS.get("invite",null);if(code){LS.set("invite",null);await this.accept(code)}this.soon(1000)}catch(e){}if(route.sec==="friends")this.render()},
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
   if(route.sec==="friends")await this.board()}catch(e){this.soon(120000)}},
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
 document.querySelectorAll('[name="sPieces"]').forEach(r=>r.checked=r.value===UI.pieces);$("#sLang").innerHTML=LANGS.filter(l=>I18N[l]).map(l=>`<option value="${l}"${l===LANG?" selected":""}>${esc(I18N[l]["lang.name"]||l)}</option>`).join("");$("#sSound").checked=!!UI.sound;$("#sHideRow").hidden=!GS;if(GS)$("#sHide").checked=!!GS.set.hide;if(!d.open)d.showModal()}
const setSave=()=>{LS.set("ui",UI);applyUI()};
document.querySelectorAll('[name="sTheme"]').forEach(r=>r.onchange=()=>{UI.theme=r.value;setSave()});
document.querySelectorAll('[name="sBoard"]').forEach(r=>r.onchange=()=>{UI.board=r.value;setSave()});
document.querySelectorAll('[name="sPieces"]').forEach(r=>r.onchange=()=>{UI.pieces=r.value;setSave()});
$("#sLang").onchange=()=>setLang($("#sLang").value);
/* language: remembered in rc.ui; re-renders the shell and the current screen */
function setLang(l){UI.lang=l;LS.set("ui",UI);LANG=langPick();applyI18n();if(P){$("#whoMeta").textContent=SRC[P.source].name+", "+T("tc."+P.tc);route()}}
$("#sSound").onchange=()=>{UI.sound=$("#sSound").checked;setSave();if(UI.sound)Snd.play("correct")};
$("#sHide").onchange=()=>{if(!GS)return;GS.set={...GS.set,hide:$("#sHide").checked,at:Date.now()};gSave();if(route.sec==="home")renderHome()};
$("#setBtn").onclick=()=>{profMenu(false);setOpen()};$("#setClose").onclick=()=>$("#settings").close();
/* profile menu: the player, switch player, account, settings (one place for all of them) */
function profMenu(open){const m=$("#profMenu"),b=$("#profBtn");m.hidden=!open;b.setAttribute("aria-expanded",open?"true":"false");if(open){const f=m.querySelector("button:not([hidden])");if(f)f.focus()}}
$("#profBtn").onclick=e=>{e.stopPropagation();profMenu($("#profMenu").hidden)};
document.addEventListener("click",e=>{if(!$("#profMenu").hidden&&!e.target.closest("#profMenu,#profBtn"))profMenu(false)});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("#profMenu").hidden){profMenu(false);$("#profBtn").focus()}});
$("#profMenu").addEventListener("click",e=>{if(e.target.closest("button"))setTimeout(()=>profMenu(false),0)});
applyI18n();
applyUI();

/* ---------- routing ---------- */
/* routes: the hash path -> the section it shows. Four tabs (home, review, train, progress); Train and Progress have sections.
   route.cur is the path ("train/puzzles"); route.sec the section ("trainer"). Links from before the redesign redirect. */
const ROUTES={home:"home",review:"review","train/puzzles":"trainer","train/openings":"openings","train/lessons":"lessons",progress:"progress","progress/trophies":"trophies","progress/friends":"friends"};
const OLDR={trainer:"train/puzzles",openings:"train/openings",lessons:"train/lessons",friends:"progress/friends","progress/overview":"progress"};
const SUBS={train:[["train/puzzles","train.puzzles"],["train/openings","train.openings"],["train/lessons","train.lessons"]],progress:[["progress","progress.overview"],["progress/trophies","progress.trophies"],["progress/friends","progress.friends","friends"]]};
function tabHead(top){const h=$("#tabHead"),sub=SUBS[top];h.hidden=!sub;if(!sub)return;$("#tabTitle").textContent=T(top+".title");
 $("#subnav").setAttribute("aria-label",T("nav.sections"));$("#subnav").innerHTML=sub.filter(x=>x[2]!=="friends"||SB_ON).map(([p,k,t])=>`<a href="#${p}"${t?` data-t="${t}"`:""}${route.cur===p?' aria-current="page"':""}>${esc(T(k))}</a>`).join("")}
function route(){if(!P){show1("start");return}const raw=location.hash.slice(1);let h=decodeURIComponent(raw),rid=null;if(h.startsWith("review/")){rid=h.slice(7);h="review"}
 if(raw.startsWith("train/openings/")){const p=raw.slice(15).split("/"),k=decodeURIComponent(p[0]);OVW=/^[wb]\|./.test(k)?{v:p[1]==="practise"?"drill":"page",k}:{v:"gal",k:null};h="train/openings"}else if(h==="train/openings"||h==="openings")OVW={v:"gal",k:null};
 if(h==="train")h=LS.get("trainSec","train/puzzles");if(OLDR[h]){h=OLDR[h];history.replaceState(null,"","#"+h)}
 if(h==="progress/friends"&&!SB_ON)h="progress";if(!ROUTES[h])h="home";const t=ROUTES[h],top=h.split("/")[0];route.cur=h;route.sec=t;if(top==="train")LS.set("trainSec",h);show1(t);tabHead(top);
 document.querySelectorAll("#hdr nav a").forEach(a=>{if(a.dataset.t===top)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current")});
 if(t==="progress")renderProgress();if(t==="trophies")renderTrophies();if(t==="trainer")tView();if(t==="review")reviewView(rid);if(t==="friends")Fr.render();if(t==="openings")renderOpenings();if(t==="home")renderHome();if(t==="lessons"&&!LP)renderLessons()}
function show1(t){document.querySelectorAll("main>section").forEach(s=>s.hidden=s.id!=="v-"+t);if(t==="start")$("#tabHead").hidden=true;$("#hdr").hidden=t==="start";document.body.classList.toggle("has-side",t!=="start");if(t==="start")demoStart();else demoStop()}
window.addEventListener("hashchange",route);

/* ---------- boot ---------- */
async function enter(fresh){GEN++;CUR=null;PI=null;TSN=null;LCO=null;TS=LS.get(uk("trainer"),{});OPS=LS.get(uk("openings"),{});OPSEL=LS.get(uk("opsel"),null);OT=null;OD=null;OTC.clear();LSP=LS.get(uk("lessons"),{});PZS=LS.get(uk("pzs"),{});LP=null;gLoad();SEEN0=LS.get(uk("seen"),null);LS.set(uk("seen"),Date.now());Sync.mark("la",acct()+"|"+P.tc);$("#whoName").textContent=P.user;$("#whoMeta").textContent=SRC[P.source].name+", "+T("tc."+P.tc);$("#profAv").textContent=P.user[0];refreshGames();gCheck();
 if(GAMES.length){openDefault();route()}
 const first=()=>{if(!CUR&&GAMES.length){openDefault();if(fresh)location.hash="review";route()}};
 try{const n=await sync(first);if(!GAMES.length){$("#startMsg").textContent=T("start.noGames",{tc:T("tc."+P.tc),u:P.user,site:SRC[P.source].name});$("#startBtn").disabled=false;LS.set("profile",null);P=null;route();return}
  first();analyseRecent(fresh?20:Math.max(n,0)?Math.min(n,20):0)}
 catch(e){if(fresh&&!GAMES.length){$("#startMsg").textContent=T("start.loadFail",{site:SRC[P.source].name});$("#startBtn").disabled=false;P=null;LS.set("profile",null);route()}else job("sync",null)}
 if(!fresh&&!AQ)analyseRecent(5);if(!AQ)TG.run()}
async function boot(){const ls=document.querySelector(`input[name="uSrc"][value="${LS.get("lastSrc","cc")}"]`);if(ls)ls.checked=true;srcLabel();langSw();$("#startBtn").disabled=false;$("#startMsg").textContent="";if(!P){route();$("#uName").focus();return}await enter(false)}
/* Read-only test hook, only with ?test=1 (used by tests/run.mjs; keep it working when refactoring). */
if(/[?&]test=1(&|$)/.test(location.search))window.rcTest={state:()=>({user:P&&P.user,source:P&&P.source,tc:P&&P.tc,games:GAMES.length,analysed:GAMES.filter(g=>g.an).length,puzzles:PZ.length,queue:!!AQ,cur:CUR&&CUR.id,ply:PLY,flip:RB.flip,route:P?route.cur:"start"}),
 puzzle:()=>PI&&{id:PI.id,fen:PI.g._f[PI.e.i],best:PI.e.best,flip:TB.flip},game:id=>{const g=GAMES.find(x=>x.id===id);return g&&{id:g.id,result:g.result,color:g.color,moves:g.moves.length,an:!!g.an}}};
(async()=>{await DB.open();ALL=await DB.all();(await DB.pend()).forEach(x=>PEND.set(x.id,x.an));await LiAuth.callback();Sync.start();boot()})();
}
