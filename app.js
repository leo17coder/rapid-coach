/* Rapid Coach — free chess coach for chess.com and Lichess games. GPL-3.0. */
{
/* ---------- utils ---------- */
const $=s=>document.querySelector(s);
const GLY={k:"♚",q:"♛",r:"♜",b:"♝",n:"♞",p:"♟"};
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
 put(gs){if(!this.db||!gs.length)return;try{const s=this.db.transaction("games","readwrite").objectStore("games");gs.forEach(g=>{const {_f,_m,...plain}=g;s.put(plain)})}catch(e){}},
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
  if(l.startsWith("info")&&l.includes(" score ")){const m=l.match(/score (cp|mate) (-?\d+)/);if(m){c.t=m[1];c.v=+m[2]}}
  if(l.startsWith("bestmove")){const b=l.split(" ")[1];this.cur=null;let cp=c.t==="mate"?(c.v>0?10000-c.v:-10000-c.v):(c.v||0);if(!c.white)cp=-cp;c.res({cp,best:b&&b!=="(none)"?b:null});this.next()}},
 eval(fen,depth){return this.init().then(()=>new Promise(res=>{this.q.push({fen,depth,res,white:fen.split(" ")[1]==="w"});if(!this.cur)this.next()}))},
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
function Board(el,opts){this.el=el;this.flip=false;this.sel=null;this.onMove=opts&&opts.onMove;this.fen=new Chess().fen();this.arrows=[];this.last=null;this.targets=[];
 el.addEventListener("click",e=>{if(!this.onMove)return;const r=el.getBoundingClientRect();let x=Math.floor((e.clientX-r.left)/r.width*8),y=Math.floor((e.clientY-r.top)/r.height*8);if(this.flip){x=7-x;y=7-y}this.click("abcdefgh"[x]+(8-y))})}
Board.prototype.sqXY=function(sq){let x="abcdefgh".indexOf(sq[0]),y=8-+sq[1];if(this.flip){x=7-x;y=7-y}return [x,y]};
Board.prototype.click=function(sq){const c=new Chess(this.fen);if(this.sel&&this.targets.includes(sq)){const from=this.sel;this.sel=null;this.targets=[];this.onMove(from,sq);return}
 const p=c.get(sq);if(p&&p.color===c.turn()){this.sel=sq;this.targets=c.moves({square:sq,verbose:true}).map(m=>m.to)}else{this.sel=null;this.targets=[]}this.draw()};
Board.prototype.set=function(fen,o){this.fen=fen;o=o||{};this.last=o.last||null;this.arrows=o.arrows||[];this.hl=o.hl||null;this.sel=null;this.targets=[];this.draw()};
Board.prototype.draw=function(){const c=new Chess(this.fen),B=c.board(),C=["#2d6cdf","#c7362b","#2f8a4e"];let s='<svg viewBox="0 0 8 8" role="img" aria-label="Chess board">';
 for(let r=0;r<8;r++)for(let f=0;f<8;f++){const sq="abcdefgh"[f]+(8-r),[x,y]=this.sqXY(sq);s+=`<rect x="${x}" y="${y}" width="1" height="1" fill="${(r+f)%2?"var(--dk)":"var(--lt)"}"/>`;
  if(this.last&&(this.last.from===sq||this.last.to===sq))s+=`<rect x="${x}" y="${y}" width="1" height="1" fill="#f2c94c" opacity=".45"/>`;
  if(this.sel===sq||this.hl===sq)s+=`<rect x="${x}" y="${y}" width="1" height="1" fill="#2d6cdf" opacity=".35"/>`}
 for(let i=0;i<8;i++){const fl=this.flip?"hgfedcba"[i]:"abcdefgh"[i],rk=this.flip?i+1:8-i,col=i%2?"var(--lt)":"var(--dk)";s+=`<text class="coord" x="${i+.05}" y="7.95" fill="${col}" style="filter:brightness(.8)">${fl}</text><text class="coord" x="7.82" y="${i+.2}" fill="${col}" style="filter:brightness(.8)">${rk}</text>`}
 for(let r=0;r<8;r++)for(let f=0;f<8;f++){const p=B[r][f];if(!p)continue;const [x,y]=this.sqXY("abcdefgh"[f]+(8-r));s+=`<text class="pc ${p.color}" x="${x+.5}" y="${y+.54}">${GLY[p.type]}︎</text>`}
 for(const t of this.targets){const [x,y]=this.sqXY(t);s+=c.get(t)?`<circle cx="${x+.5}" cy="${y+.5}" r=".44" fill="none" stroke="#1d1813" stroke-opacity=".35" stroke-width=".07"/>`:`<circle cx="${x+.5}" cy="${y+.5}" r=".15" fill="#1d1813" opacity=".3"/>`}
 s+="<defs>"+C.map((c,i)=>`<marker id="ah${this.el.id}${i}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="2.6" markerHeight="2.6" orient="auto"><path d="M0,0L10,5L0,10z" fill="${c}"/></marker>`).join("")+"</defs>";
 for(const a of this.arrows){const [x1,y1]=this.sqXY(a.from),[x2,y2]=this.sqXY(a.to),dx=x2-x1,dy=y2-y1,L=Math.hypot(dx,dy)||1,ci=a.c==="red"?1:a.c==="green"?2:0;
  s+=`<line x1="${x1+.5}" y1="${y1+.5}" x2="${x2+.5-dx/L*.32}" y2="${y2+.5-dy/L*.32}" stroke="${C[ci]}" stroke-width=".16" stroke-linecap="round" opacity=".85" marker-end="url(#ah${this.el.id}${ci})"/>`}
 this.el.innerHTML=s+"</svg>"};

/* ---------- REVIEW ---------- */
const RB=new Board($("#board"));
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
function show(){const g=CUR;if(!g)return;const m=g._m[PLY-1],o={last:m?{from:m.from,to:m.to}:null,arrows:[]};
 if(g.an&&PLY<g.moves.length&&g.an.best[PLY]){const er=errorsOf(g).find(e=>e.i===PLY);if(er&&er.kind!=="inacc"){const nx=g._m[PLY],b=g.an.best[PLY];o.arrows.push({from:nx.from,to:nx.to,c:"red"},{from:b.slice(0,2),to:b.slice(2,4),c:"green"})}}
 RB.set(g._f[PLY],o);document.querySelectorAll("#moves button,#km button").forEach(b=>b.classList.toggle("on",+b.dataset.p===PLY));
 const on=document.querySelector("#moves button.on"),mv=$("#moves");if(on){const t=on.offsetTop;if(t<mv.scrollTop||t>mv.scrollTop+mv.clientHeight-30)mv.scrollTop=t-mv.clientHeight/2}
 $("#evNow").textContent=g.an&&g.an.ev[PLY]!=null?`Move ${PLY?mvLabel(PLY-1):"0"} · ${evTxt(g.an.ev[PLY])}`:"";drawEval()}
function renderMoves(){const g=CUR,er=errorsOf(g),tag={blunder:"??",mistake:"?",inacc:"?!"};let h="";
 for(let i=0;i<g.moves.length;i+=2){h+=`<span class="n">${i/2+1}.</span>`;for(const j of [i,i+1]){if(j>=g.moves.length){h+="<span></span>";continue}const e=er.find(x=>x.i===j);h+=`<span><button data-p="${j+1}">${esc(g.moves[j])}${e?`<span class="tag t-${e.kind}">${tag[e.kind]}</span>`:""}</button></span>`}}
 $("#moves").innerHTML=h}
function renderKM(){const g=CUR;if(!g.an){$("#km").innerHTML='<div class="small">Run the analysis to see where the game turned.</div>';return}
 const er=serious(g);if(!er.length){$("#km").innerHTML='<div class="verdict v-ok">No blunders or mistakes from you in this game.</div>';return}
 $("#km").innerHTML=er.map(e=>{const sp=spent(g,e.i),cl=g.clocks&&g.clocks[e.i],bs=uciSan(g._f[e.i],e.best),ctx=e.before>200?"You were winning. ":e.before<-200?"You were already worse. ":"";
  return `<button data-p="${e.i}"><span class="dot" style="background:${e.kind==="blunder"?"var(--red)":"var(--warn)"}"></span><span><b>${mvLabel(e.i)} ${esc(g.moves[e.i])}</b> ${e.kind} · better was <b>${esc(bs||"?")}</b><br><span class="small">${ctx}${evTxt(e.before)} → ${evTxt(e.after)}${sp!=null?` · thought ${sp}s, ${mmss(cl)} left`:""}</span></span><span class="small num">−${Math.round(e.drop)}%</span></button>`}).join("")}
function renderAnState(){const g=CUR;$("#anState").innerHTML=g.an?`<div class="small">Stockfish depth ${g.an.depth}. Green arrow: better move. Red arrow: what was played.</div>`:`<div class="row"><button class="pri" id="anOne">Analyse this game</button><span class="small">About 30 seconds, on your device.</span></div>`;
 const b=$("#anOne");if(b)b.onclick=()=>{queue([g],true);b.disabled=true;b.textContent="Queued…"}}
function drawEval(){const el=$("#evFig"),g=CUR;if(!g||!g.an){el.innerHTML='<div class="empty" style="height:100%;display:grid;place-items:center">No evaluation yet</div>';el.onclick=null;return}
 const W=el.clientWidth||400,H=el.clientHeight,n=g.an.ev.length-1||1,X=i=>i/n*W,Y=cp=>H-(wp(Math.max(-1500,Math.min(1500,cp==null?0:cp)))/100)*H;
 const p=`M0,${H} `+g.an.ev.map((c,i)=>`L${X(i).toFixed(1)},${Y(c).toFixed(1)}`).join(" ")+` L${W},${H}Z`;
 el.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><rect width="${W}" height="${H}" fill="#2a2420"/><path d="${p}" fill="#f4ede1"/><line x1="0" x2="${W}" y1="${H/2}" y2="${H/2}" stroke="#a8784c" stroke-dasharray="3 3"/>
 ${serious(g).map(e=>`<circle cx="${X(e.i+1)}" cy="${Y(g.an.ev[e.i+1])}" r="5" fill="${e.kind==="blunder"?"#c7362b":"#d9902b"}" stroke="#fff" stroke-width="1.5"/>`).join("")}
 <line x1="${X(PLY)}" x2="${X(PLY)}" y1="0" y2="${H}" stroke="#2d6cdf" stroke-width="2"/></svg>`;
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
  if(CUR===g){renderMoves();renderKM();renderAnState();show()}fillPicker();buildPuzzles();if(route.cur==="progress")renderProgress();if(route.cur==="trainer"&&!PI)loadPuzzle(pickPuzzle())}}
 catch(e){$("#anState").innerHTML='<div class="verdict v-no">The engine could not start in this browser.</div>'}
 AQ=null;job("an",null);if(P&&gen===GEN)maybeBaseline();if(route.cur==="progress")renderProgress();if(CUR&&!CUR.an)renderAnState()}
function analyseRecent(n){queue(GAMES.slice().reverse().filter(g=>!g.an).slice(0,n))}

/* ---------- TRAINER ---------- */
const TB=new Board($("#tboard"),{onMove:tryMove});let PZ=[],PI=null,HINT=0,DONE=false;
const TST=()=>{const t=LS.get(uk("trainer"),{});return t};let TS={};
function buildPuzzles(){PZ=[];for(const g of GAMES){if(!g.an)continue;replay(g);for(const e of serious(g))if(wp(e.before)>=30&&e.best)PZ.push({id:g.id+":"+e.i,g,e})}PZ.sort((a,b)=>b.g.ts-a.g.ts);if(route.cur==="trainer")renderTStats()}
function pickPuzzle(){const st=id=>TS[id]||{};const failed=PZ.filter(p=>st(p.id).fail&&!st(p.id).ok),fresh=PZ.filter(p=>!st(p.id).seen);const pool=failed.length?failed:fresh.length?fresh:PZ;return pool[0]||null}
function loadPuzzle(p){PI=p;HINT=0;DONE=false;$("#tFeedback").innerHTML="";$("#tMeta").innerHTML="";
 if(!p){$("#tPrompt").textContent=AQ?"Your games are being analysed — puzzles appear here as soon as the first one is done.":"No puzzles yet. Analyse a few games first (Progress → Analyse 20 more games).";TB.flip=false;TB.set(new Chess().fen());renderTStats();return}
 const g=p.g,e=p.e,c=new Chess(g._f[e.i]),m=g._m[e.i-1];TB.flip=c.turn()==="b";TB.set(g._f[e.i],{last:m?{from:m.from,to:m.to}:null});
 $("#tPrompt").textContent=`${c.turn()==="w"?"White":"Black"} to move. Find the best move.`;
 $("#tMeta").innerHTML=`<span>From your game on ${esc(g.date)} vs ${esc(g.opp)} · ${esc(famOf(g.eco))} · move ${Math.floor(e.i/2)+1}</span>`;renderTStats()}
const saveTS=()=>{LS.set(uk("trainer"),TS);if(PI)Sync.mark("pz",acct()+"|"+PI.id);Fr.soon()};
async function tryMove(from,to){if(!PI||DONE)return;const p=PI,fen=p.g._f[p.e.i],c=new Chess(fen),mv=c.move({from,to,promotion:"q"});if(!mv)return;const u=from+to;
 TB.set(c.fen(),{last:{from,to}});const st=TS[p.id]||(TS[p.id]={});st.seen=1;let ok=u===p.e.best.slice(0,4),note="";
 if(!ok){$("#tFeedback").innerHTML='<div class="small">Checking your move…</div>';try{const r=await Engine.eval(c.fen(),12),s=fen.split(" ")[1]==="w"?1:-1;ok=wp(s*p.g.an.ev[p.e.i])-wp(s*r.cp)<8;if(ok)note=" Not the engine's first choice, but just as good."}catch(x){}}
 if(PI!==p)return;
 if(ok){DONE=true;st.ok=1;saveTS();const bs=uciSan(fen,p.e.best);$("#tFeedback").innerHTML=`<div class="verdict v-ok">Correct — ${esc(mv.san)}.${note} In the game you played ${esc(p.g.moves[p.e.i])}${bs&&bs!==mv.san?`; the engine's move is ${esc(bs)}`:""}.</div>`}
 else{st.fail=(st.fail||0)+1;st.ok=0;saveTS();$("#tFeedback").innerHTML=`<div class="verdict v-no">${esc(mv.san)} isn't it. Look again at checks, captures and threats — for both sides.</div><button id="tRetry">Try again</button>`;$("#tRetry").onclick=()=>loadPuzzle(p)}
 renderTStats()}
$("#tHint").onclick=()=>{if(!PI||DONE)return;HINT++;const b=PI.e.best,c=new Chess(PI.g._f[PI.e.i]),m=c.move({from:b.slice(0,2),to:b.slice(2,4),promotion:"q"});
 const kind=m.san.includes("#")?"There's a checkmate.":m.captured?"There's material to win.":m.san.includes("+")?"Start with a check.":"Think about what your opponent is threatening.";
 if(HINT===1)$("#tFeedback").innerHTML=`<div class="verdict v-info">${kind}</div>`;else{TB.set(PI.g._f[PI.e.i],{hl:b.slice(0,2)});$("#tFeedback").innerHTML=`<div class="verdict v-info">${kind} Move the highlighted piece.</div>`}};
$("#tShow").onclick=()=>{if(!PI)return;const p=PI,b=p.e.best,st=TS[p.id]||(TS[p.id]={});if(!DONE){st.seen=1;st.fail=(st.fail||0)+1;st.ok=0;saveTS()}DONE=true;
 const fen=p.g._f[p.e.i],bs=uciSan(fen,b),pl=p.g._m[p.e.i];TB.set(fen,{arrows:[{from:pl.from,to:pl.to,c:"red"},{from:b.slice(0,2),to:b.slice(2,4),c:"green"}]});
 $("#tFeedback").innerHTML=`<div class="verdict v-info">The move was <b>${esc(bs)}</b> (green). You played ${esc(p.g.moves[p.e.i])} (red), which swung the game ${evTxt(p.e.before)} → ${evTxt(p.e.after)}.</div>`;renderTStats()};
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
const OB=new Board($("#oboard"),{onMove:(f,t)=>opMove(f,t)}),OEV=new Map();
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
 if(ok){if(!x.due||x.due<=now){x.s=(x.s||0)+1;x.due=now+OP_IV[Math.min(x.s,OP_IV.length-1)]*864e5}x.ok=(x.ok||0)+1}
 else{x.s=0;x.due=now+10*6e4;x.miss=(x.miss||0)+1}     // a miss comes back within the session
 x.at=now;saveOPS(k);const st=LS.get(uk("opstart"),{});if(!st[OT.key]){st[OT.key]=now;LS.set(uk("opstart"),st);Sync.mark("ops",acct()+"|"+OT.key)}}
/* opponent move: weighted by how often my opponents played it, nudged towards lines with positions due for review;
   where my games are thin (< 3 games), add the Lichess explorer's moves at my rating (worth 2 games in total) */
async function opPickOpp(fen,n){const own=n?Object.values(n.mv):[],tot=own.reduce((a,x)=>a+x.n,0),W=new Map();
 own.forEach(x=>W.set(x.san,{san:x.san,w:x.n*(1+2*opNeed(x.ck,5)),src:"games"}));
 if(tot<3){const ex=await Explorer.moves(fen);if(ex&&ex.length){const et=ex.reduce((a,x)=>a+x.n,0);
  ex.filter(x=>x.n/et>=.05).forEach(x=>{const o=W.get(x.san)||{san:x.san,w:0,src:"lichess"};o.w+=2*x.n/et;W.set(x.san,o)})}}
 const L=[...W.values()];if(!L.length)return null;let r=Math.random()*L.reduce((a,x)=>a+x.w,0);for(const x of L)if((r-=x.w)<=0)return x;return L[L.length-1]}
function opStartLine(replay,at){if(!OT)return;const start=replay&&OD?OD.start:at||null;
 OD={gen:GEN,key:OT.key,c:new Chess(start?start.fen:undefined),ply:start?start.ply:0,opp:replay&&OD?OD.opp:[],start,miss:false,wait:false,viaEx:false};
 OB.flip=OT.col==="b";OB.set(OD.c.fen());$("#oFeedback").innerHTML="";opStep()}
async function opStep(){const d=OD;if(!d||d.gen!==GEN||d.key!==(OT&&OT.key))return;const c=d.c,fen=c.fen(),k=posKey(fen),n=OT.T.get(k),mine=(c.turn()==="w")===(OT.col==="w");
 if(d.ply>=OP_PLY||c.game_over())return opLineDone(d,"end");
 if(mine){if(!n&&!d.viaEx)return opLineDone(d,"data");d.wait=true;const x=OPS[k];
  $("#oPrompt").innerHTML=`<b>Your move.</b> ${n?`Seen in ${n.n} of your games.`:"From Lichess games at your rating."}${n&&n.weak?' <span class="tag">weak spot</span>':""}${x&&x.pin?' <span class="tag">repertoire</span>':""}`;return}
 let x=d.opp[d.ply];if(!x){$("#oPrompt").textContent="Your opponent is choosing a move…";x=await opPickOpp(fen,n);if(d!==OD)return;if(!x)return opLineDone(d,"data");d.opp[d.ply]=x}
 const m=c.move(x.san);if(!m)return opLineDone(d,"data");d.viaEx=x.src==="lichess";d.ply++;OB.set(c.fen(),{last:{from:m.from,to:m.to}});setTimeout(()=>{if(d===OD)opStep()},450)}
async function opMove(from,to){const d=OD;if(!d||!d.wait)return;const c=d.c,fen=c.fen(),t=new Chess(fen),mv=t.move({from,to,promotion:"q"});if(!mv)return;d.wait=false;
 const k=posKey(fen),n=OT.T.get(k),u=mv.from+mv.to+(mv.promotion||""),pin=(OPS[k]||{}).pin,s=c.turn()==="w"?1:-1;OB.set(t.fen(),{last:{from,to}});
 $("#oFeedback").innerHTML='<div class="small">Checking your move…</div>';let best=pin||(n&&n.best),bev=n?n.ev:null,aev=null;
 try{if(!best||bev==null){const r=await opEval(fen,14);best=best||r.best;if(bev==null)bev=r.cp}}catch(e){}
 if(d!==OD)return;let ok=!best||u===best,play=false;
 if(!ok){try{aev=(await opEval(t.fen(),12)).cp}catch(e){}if(d!==OD)return;const near=aev!=null&&bev!=null&&wp(s*bev)-wp(s*aev)<OP_TOL;if(pin&&near)play=true;else ok=near}
 const bs=best?uciSan(fen,best):null;
 if(play){d.wait=true;OB.set(fen,{last:c.history({verbose:true}).slice(-1).map(m=>({from:m.from,to:m.to}))[0]||null,arrows:[{from:pin.slice(0,2),to:pin.slice(2,4),c:"green"}]});
  $("#oFeedback").innerHTML=`<div class="verdict v-info">${esc(mv.san)} is playable, but your repertoire move here is <b>${esc(bs)}</b>. Play it.</div>`;return}
 opGrade(k,ok);
 if(ok){c.move(mv.san);d.ply++;d.last={k,u,san:mv.san};const pinned=pin===u;
  $("#oFeedback").innerHTML=`<div class="verdict v-ok">${esc(mv.san)} — correct.${!pinned&&bs&&bs!==mv.san?` The engine's first choice is ${esc(bs)}, but yours is just as good.`:""}</div>`+
   `<button class="link" id="oPin" type="button">${pinned?`Unpin ${esc(mv.san)}`:`Pin ${esc(mv.san)} as my move here`}</button>`;
  $("#oPin").onclick=()=>{const x=OPS[k]||(OPS[k]={s:0,ok:0,miss:0});x.pin=pinned?null:u;if(!x.pin)delete x.pin;x.at=Date.now();saveOPS(k);$("#oPin").outerHTML=`<span class="small">${x.pin?`Pinned ${esc(mv.san)} as your repertoire move.`:"Unpinned."}</span>`};
  setTimeout(()=>{if(d===OD)opStep()},350)}
 else{d.miss=true;const arrows=[{from:mv.from,to:mv.to,c:"red"}];if(best)arrows.push({from:best.slice(0,2),to:best.slice(2,4),c:"green"});OB.set(fen,{arrows});
  $("#oPrompt").innerHTML="<b>Not this time.</b>";
  $("#oFeedback").innerHTML=`<div class="verdict v-no">${esc(mv.san)} isn't it. ${pin?"Your repertoire move":"The move"} here is <b>${esc(bs||"?")}</b> (green)${bev!=null&&aev!=null?`: ${esc(mv.san)} swings it ${evTxt(bev)} → ${evTxt(aev)}`:""}.</div><button class="pri" id="oReplay" type="button">Replay the line</button>`;
  $("#oReplay").onclick=()=>opStartLine(true)}
 renderOpStats()}
function opLineDone(d,why){if(d!==OD)return;d.done=true;$("#oPrompt").innerHTML=(why==="end"?"<b>Line complete.</b> ":"<b>That's as far as your games go in this line.</b> ")+(d.miss?"You missed a move: replay it to lock it in.":"Next line?");renderOpStats()}
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
 let s=`<svg viewBox="0 0 ${W} ${H}">`+[0,.5,1].map(t=>y0+t*(y1-y0)).map(t=>`<line x1="${pad.l}" x2="${W-pad.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${pad.l-6}" y="${Y(t)+4}" text-anchor="end" font-size="12" fill="var(--mute)">${o.fmt?o.fmt(t):Math.round(t)}</text>`).join("");
 if(o.goal!=null)s+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${Y(o.goal)}" y2="${Y(o.goal)}" stroke="var(--red)" stroke-width="2" stroke-dasharray="6 4"/>`;
 if(o.line)s+=`<path d="${pts.map((p,i)=>(i?"L":"M")+X(p.x).toFixed(1)+","+Y(p.y).toFixed(1)).join("")}" fill="none" stroke="var(--ink)" stroke-width="2"/>`;
 if(o.dots)s+=pts.map(p=>`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${W<520?2.5:3.5}" fill="${p.c||"var(--ink)"}" opacity=".75"/>`).join("");
 if(o.avg){const av=pts.map((p,i)=>{const w=pts.slice(Math.max(0,i-9),i+1);return {x:p.x,y:w.reduce((s,q)=>s+q.y,0)/w.length}});s+=`<path d="${av.map((p,i)=>(i?"L":"M")+X(p.x).toFixed(1)+","+Y(p.y).toFixed(1)).join("")}" fill="none" stroke="var(--blue)" stroke-width="2.5"/>`}
 if(o.xl){const l=o.xl(x0,x1);s+=l.filter((_,i,a)=>W>=520||i===0||i===a.length-1).map(q=>`<text x="${X(q.x)}" y="${H-6}" text-anchor="middle" font-size="12" fill="var(--mute)">${q.t}</text>`).join("")}
 el.innerHTML=s+"</svg>"};el._draw=draw;draw();if(!el._ro){el._ro=new ResizeObserver(()=>el._draw());el._ro.observe(el)}}
function timeLabels(x0,x1){const span=x1-x0,out=[];if(span>540*864e5){for(let y=new Date(x0).getFullYear()+1;y<=new Date(x1).getFullYear();y++)out.push({x:Date.UTC(y,0,1),t:y})}else{const d=new Date(x0);d.setUTCDate(1);const step=span>180*864e5?3:span>60*864e5?1:0;if(!step)return out;for(d.setUTCMonth(d.getUTCMonth()+1);d.getTime()<=x1;d.setUTCMonth(d.getUTCMonth()+step))out.push({x:d.getTime(),t:d.toLocaleString("en",{month:"short",timeZone:"UTC"})})}return out}
function renderProgress(){const G=GAMES,s=stats(),base=LS.get(uk("base."+P.tc),null),B=baseSecs(),ins=insights();
 $("#pTitle").textContent=ins.length&&ins[0].c==="hi"?ins[0].t:"Your progress";
 $("#pSub").textContent=`${G.length} ${TCL[P.tc]} games loaded, ${s.nAn} analysed. `+(base?`Baseline set ${base.date}: ${mmss(base.time)} used per game, ${base.errs==null?"—":base.errs.toFixed(1)} blunders + mistakes per game, rating ${base.rating}.`:"A baseline is set automatically once 10 games are analysed.");
 $("#insights").innerHTML=ins.length?ins.map(i=>`<div class="ins ${i.c}"><b>${esc(i.t)}</b><p>${esc(i.p)}</p></div>`).join(""):`<div class="empty">${AQ?"Analysing your games — insights appear as results come in.":"Analyse some games to get personalised advice."}</div>`;
 const dl=(v,b,f,good)=>b==null||v==null?"":`<s>${v-b>0?"+":v-b<0?"−":"±"}${f(Math.abs(v-b))} since baseline</s>`;
 const k=(v,l,goal,extra)=>`<div class="kpi${goal?" goal":""}"><b class="num">${v}</b>${l}${extra||""}</div>`;
 $("#pKpis").innerHTML=k(s.rating??"—","current rating",0,base&&dl(s.rating,base.rating,Math.round))+k(s.score==null?"—":Math.round(s.score)+"%","score, last 30 games")+
  k(mmss(s.time),`median time used · goal ${mmss(B*.7)}`,1,base&&dl(s.time,base.time,mmss))+k(s.errs==null?"—":s.errs.toFixed(1),"blunders + mistakes per game · goal under 1",1,base&&base.errs!=null&&s.errs!=null?dl(s.errs,base.errs,x=>x.toFixed(1)):"")+
  k(PZ.filter(p=>(TS[p.id]||{}).ok).length,"puzzles solved");
 const day={};G.forEach(g=>{day[g.date]=g});const rp=Object.values(day).map(g=>({x:g.ts,y:g.myR}));chart($("#ratingFig"),rp,{line:1,xl:timeLabels});
 $("#timeGoal").textContent=`(goal: ${mmss(B*.7)} of ${Math.round(B/60)}:00)`;
 const tp=G.map(g=>({g,t:timeUsed(g)})).filter(o=>o.t!=null).slice(-60).map((o,i)=>({x:i,y:o.t,c:o.g.result==="win"?"var(--good)":o.g.result==="loss"?"var(--red)":"var(--mute)"}));
 chart($("#timeFig"),tp,{dots:1,avg:1,goal:B*.7,y0:0,fmt:t=>mmss(t)});
 const an=G.filter(g=>g.an).slice(-60);chart($("#errFig"),an.map((g,i)=>({x:i,y:serious(g).length})),{dots:1,avg:1,goal:1,y0:0,pad:.5});
 $("#errNote").textContent=`Your last ${an.length} analysed games. Red dashed line: goal (under 1 per game).`;
 const yr=G.filter(g=>g.ts>Date.now()-365*864e5),kinds={checkmated:"checkmate",resigned:"resignation",abandoned:"abandoned (left the game)",timeout:"on time"};
 const tbl=(a,col,lab)=>{const c={};a.forEach(g=>{const k=kinds[g.how]||"other";c[k]=(c[k]||0)+1});const rows=Object.entries(c).sort((x,y)=>y[1]-x[1]);
  return `<table style="margin-bottom:14px"><thead><tr><th>${lab} (${a.length})</th><th class="r">n</th><th></th></tr></thead><tbody>${rows.map(([k,n])=>`<tr><td>${k}</td><td class="r">${n}</td><td style="width:45%"><div class="meter"><b style="width:${n/a.length*100}%;background:${col}"></b></div></td></tr>`).join("")||'<tr><td colspan="3" class="small">None</td></tr>'}</tbody></table>`};
 $("#ends").innerHTML=tbl(yr.filter(g=>g.result==="loss"),"var(--red)","Losses")+tbl(yr.filter(g=>g.result==="win"),"var(--good)","Wins");
 renderOps();const un=G.filter(g=>!g.an).length;$("#anMore").disabled=!un;$("#anNote").textContent=un?`${un} games not analysed yet.`:"Every game is analysed."}
function renderOps(){const col=$("#opColor").value,m={};GAMES.filter(g=>g.color===col&&g.ts>Date.now()-365*864e5).forEach(g=>{const f=famOf(g.eco);(m[f]=m[f]||[]).push(g)});
 const rows=Object.entries(m).filter(([,a])=>a.length>=5).sort((a,b)=>b[1].length-a[1].length).slice(0,15);
 $("#opBody").innerHTML=rows.length?rows.map(([f,a])=>{const w=a.filter(g=>g.result==="win").length,d=a.filter(g=>g.result==="draw").length,l=a.length-w-d,s=score(a);
  return `<tr><td data-l="Opening">${esc(f)}</td><td class="r" data-l="Games">${a.length}</td><td class="r" data-l="Score" style="color:${s<45?"var(--red)":s>55?"var(--good)":"inherit"};font-weight:700">${Math.round(s)}%</td><td data-l="W / D / L"><span class="num">${w} / ${d} / ${l}</span></td><td class="r" data-l=""><button class="link" type="button" data-op="${esc(col+"|"+f)}">Practise</button></td></tr>`}).join(""):'<tr><td colspan="5" class="small">No opening with 5+ games in the last year.</td></tr>';
 $("#opBody").querySelectorAll("[data-op]").forEach(b=>b.onclick=()=>{OPSEL=b.dataset.op;LS.set(uk("opsel"),OPSEL);OD=null;location.hash="openings"})}
$("#opColor").onchange=renderOps;
$("#anMore").onclick=()=>{analyseRecent(20);$("#anNote").textContent="Queued — see progress at the top."};
$("#resetBase").onclick=()=>{const s=stats();LS.set(uk("base."+P.tc),{...s,date:new Date().toISOString().slice(0,10),manual:new Date().toISOString()});Sync.mark("base",acct()+"|"+P.tc);Fr.soon();renderProgress()};
$("#syncBtn").onclick=async()=>{$("#syncBtn").disabled=true;try{const n=await sync();$("#anNote").textContent=n?`${n} new game${n>1?"s":""} found.`:"No new games.";if(n)analyseRecent(n)}catch(e){$("#anNote").textContent=`Couldn't reach ${SRC[P.source].name}. Try again in a minute.`}$("#syncBtn").disabled=false;renderProgress()};

/* ---------- onboarding ---------- */
const HB=new Board($("#heroBoard"));HB.set("r1bq1rk1/pp3ppp/2n1pn2/3p4/1bPP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0 8",{arrows:[{from:"c4",to:"d5",c:"green"},{from:"f1",to:"d3",c:"red"}]});
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
   if(!this.hasSession()){acctOpen();acctMsg("A friend invited you. Sign in to accept, then you can compare your games.")}}
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
 /* outbox: {an:{gameId:1}, pz:{"acct|puzzleId":1}, base:{"acct|tc":1}, la:{"acct|tc":1}, op:{"acct|posKey":1}, ops:{"acct|w|<family>":1}} */
 mark(kind,key){if(!SB_ON)return;const o=LS.get("sb.out",{});(o[kind]=o[kind]||{})[key]=1;LS.set("sb.out",o);if(this.me){clearTimeout(this._t);this._t=setTimeout(()=>this.flush(),2000)}},
 async run(){if(!this.me||this.busy)return;this.busy=true;this.err="";acctUI();
  try{await this.pull();const k="sb.init."+this.me.id;if(!LS.get(k,0)){this.markAll();LS.set(k,1)}this.busy=false;await this.flush()}
  catch(e){this.err="Sync failed. It will retry later; nothing is lost.";this.busy=false}acctUI()},
 markAll(){ALL.forEach(g=>{if(g.an)this.mark("an",g.id)});
  for(const k of Object.keys(localStorage)){let m=k.match(/^rc\.((?:cc|li):[^.]+)\.trainer$/);if(m)Object.keys(LS.get(m[1]+".trainer",{})).forEach(id=>this.mark("pz",m[1]+"|"+id));
   m=k.match(/^rc\.((?:cc|li):[^.]+)\.base\.(\w+)$/);if(m)this.mark("base",m[1]+"|"+m[2]);
   m=k.match(/^rc\.((?:cc|li):[^.]+)\.openings$/);if(m)Object.keys(LS.get(m[1]+".openings",{})).forEach(p=>this.mark("op",m[1]+"|"+p));
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
   opening_practice:keys("ops").map(sp).filter(([a])=>ok(a)).map(([a,o])=>({a,o,t:LS.get(a+".opstart",{})[o]})).filter(r=>r.t).map(({a,o,t})=>({user_id:uid,account:a,opening:o,started_at:new Date(t).toISOString()}))};
  const pk={analyses:"user_id,game_id",puzzle_progress:"user_id,account,puzzle_id",baselines:"user_id,account,tc",linked_accounts:"user_id,account,tc",opening_progress:"user_id,account,pos",opening_practice:"user_id,account,opening"};
  try{for(const t in rows)for(let i=0;i<rows[t].length;i+=200){const {error}=await this.sb.from(t).upsert(rows[t].slice(i,i+200),{onConflict:pk[t]});if(error)throw error}
   this.err=""}
  catch(e){const n=LS.get("sb.out",{});for(const k in o)n[k]={...o[k],...(n[k]||{})};LS.set("sb.out",n);this.err="Couldn't upload changes. Retrying in a minute.";clearTimeout(this._t);this._t=setTimeout(()=>this.flush(),60e3)}
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
  // linked accounts: on a device with no profile yet, open the most recently used one
  const la=await this.rows("linked_accounts","account,tc",w.la);hi(la,"la");LS.set(wk,w);this.pulled=Date.now();
  if(P){refreshGames();if(CUR&&CUR.an){renderMoves();renderKM();renderAnState();show()}if(route.cur==="progress")renderProgress();if(route.cur==="trainer")renderTStats();Fr.soon()}
  else if(la.length){const r=la[la.length-1],i=r.account.indexOf(":");P={source:r.account.slice(0,i),user:r.account.slice(i+1),tc:r.tc};LS.set("profile",P);enter(false)}},
 async exportAll(){const out={exported:new Date().toISOString(),account:this.me.email};for(const t of ["linked_accounts","analyses","puzzle_progress","baselines","opening_progress","opening_practice","profiles","leaderboard_stats"])out[t]=await this.rows(t,"*");
  const f=await this.sb.rpc("my_friends");if(f.error)throw f.error;out.friends=f.data;return out},
 async signOut(){try{await this.sb.auth.signOut({scope:"local"})}catch(e){}this.me=null;Fr.prof=null;LS.set("sb.out",{});acctUI();if(route.cur==="friends")Fr.render()},
 async deleteAccount(){const {error}=await this.sb.rpc("delete_my_account");if(error)throw error;const id=this.me.id;await this.signOut();try{localStorage.removeItem("rc.sb.init."+id);localStorage.removeItem("rc.sb.pull."+id)}catch(e){}}};

/* account panel */
let acctEmail="",acctDel=false;
function acctMsg(t){$("#acctMsg").textContent=t||""}
function acctOpen(){acctDel=false;acctUI();const d=$("#acct");if(!d.open)d.showModal()}
function acctUI(){if(!SB_ON)return;const me=Sync.me,step=me?"in":acctEmail?"code":"email";
 document.querySelectorAll("[data-acct]").forEach(e=>e.hidden=e.dataset.acct!==step);
 document.querySelectorAll(".acctBtn").forEach(b=>b.textContent=me?"Account":"Sign in to sync");
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
  if($("#acct").open)$("#acct").close();if(P){if(location.hash!=="#friends")location.hash="friends";this.msg(t)}else $("#startMsg").textContent=t+" Enter your username to start."},
 soon(ms){if(!SB_ON)return;clearTimeout(this._t);this._t=setTimeout(()=>this.publish(),ms==null?20000:ms)},
 row(){const an=GAMES.filter(g=>g.an),last=an.slice(-20),n=last.length,r=x=>x==null?null:Math.round(x);let bl=0,mi=0;
  last.forEach(g=>errorsOf(g).forEach(e=>{if(e.mine){if(e.kind==="blunder")bl++;else if(e.kind==="mistake")mi++}}));
  const s=stats(),b=LS.get(uk("base."+P.tc),null);
  return {user_id:Sync.me.id,account:acct(),tc:P.tc,games_analysed:an.length,blunders_per_game:n?bl/n:null,mistakes_per_game:n?mi/n:null,median_time_used:r(s.time),
   puzzles_solved:PZ.filter(p=>(TS[p.id]||{}).ok).length,openings_learned:opLearned(),rating_now:r(s.rating),rating_base:b?r(b.rating):null,base_date:b?b.date:null}},
 async publish(){if(!Sync.me||!P||!GAMES.length||!ACCT_RE.test(acct()))return;
  try{const pr=await this.profile();if(!pr.share)return;const {error}=await Sync.sb.from("leaderboard_stats").upsert(this.row(),{onConflict:"user_id,account,tc"});if(error)throw error;
   if(route.cur==="friends")await this.board()}catch(e){this.soon(120000)}},
 async render(){const on=!!Sync.me;$("#fOut").hidden=on;$("#fIn").hidden=!on;if(!on)return;
  try{const pr=await this.profile();$("#fName").value=pr.display_name||"";$("#fShare").checked=pr.share;$("#fLink").value=location.origin+location.pathname+"?invite="+pr.invite_code;
   await this.board();await this.friends()}catch(e){this.msg(this.err(e))}},
 async board(){$("#fBoardTitle").textContent="Leaderboard · "+TCL[P.tc];const {data,error}=await Sync.sb.rpc("friends_leaderboard",{p_tc:P.tc});if(error)throw error;
  const few=r=>r.games_analysed<10,num=(v,d)=>v==null?"–":v.toFixed(d),bpg=r=>r.blunders_per_game==null?99:r.blunders_per_game;
  const rows=(data||[]).slice().sort((a,b)=>(few(a)-few(b))||(bpg(a)-bpg(b)));
  $("#fBody").innerHTML=rows.length?rows.map(r=>{const d=r.rating_now!=null&&r.rating_base!=null?r.rating_now-r.rating_base:null;
   return `<tr class="${r.is_me?"me":""}"><td>${esc(r.display_name||"(no name)")}${r.is_me?" (you)":""}<span class="src">${esc((SRC[r.source]||{}).name||"")}</span></td>`+
    `<td class="r">${few(r)?"–":num(r.blunders_per_game,2)}</td><td class="r">${few(r)?"–":num(r.mistakes_per_game,2)}</td><td class="r">${mmss(r.median_time_used)}</td>`+
    `<td class="r">${r.puzzles_solved}</td><td class="r">${d==null?"–":(d>0?"+":d<0?"−":"±")+Math.abs(d)}${r.base_date?` <span class="small">since ${esc(r.base_date)}</span>`:""}</td><td class="r">${r.openings_learned||0}</td><td class="r">${r.games_analysed}</td></tr>`}).join("")
   :`<tr><td colspan="8" class="small">No ${esc(TCL[P.tc])} stats shared yet. Switch on sharing below and send your invite link to friends.</td></tr>`},
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

/* ---------- routing ---------- */
function route(){if(!P){show1("start");return}const t=["review","trainer","progress","openings"].concat(SB_ON?["friends"]:[]).includes(location.hash.slice(1))?location.hash.slice(1):"review";route.cur=t;show1(t);
 document.querySelectorAll("nav a").forEach(a=>{if(a.dataset.t===t)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current")});
 if(t==="progress")renderProgress();if(t==="trainer"){renderTStats();if(!PI)loadPuzzle(pickPuzzle())}if(t==="review"&&CUR)show();if(t==="friends")Fr.render();if(t==="openings")renderOpenings()}
function show1(t){document.querySelectorAll("main>section").forEach(s=>s.hidden=s.id!=="v-"+t);$("#hdr").hidden=t==="start"}
window.addEventListener("hashchange",route);

/* ---------- boot ---------- */
async function enter(fresh){GEN++;CUR=null;PI=null;TS=LS.get(uk("trainer"),{});OPS=LS.get(uk("openings"),{});OPSEL=LS.get(uk("opsel"),null);OT=null;OD=null;Sync.mark("la",acct()+"|"+P.tc);$("#whoName").textContent=P.user+" · "+SRC[P.source].name+" · "+TCL[P.tc];refreshGames();
 if(GAMES.length){openDefault();route()}
 const first=()=>{if(!CUR&&GAMES.length){openDefault();if(fresh)location.hash="review";route()}};
 try{const n=await sync(first);if(!GAMES.length){$("#startMsg").textContent=`No ${TCL[P.tc]} games found for ${P.user} on ${SRC[P.source].name}. Try another time control.`;$("#startBtn").disabled=false;LS.set("profile",null);P=null;route();return}
  first();analyseRecent(fresh?20:Math.max(n,0)?Math.min(n,20):0)}
 catch(e){if(fresh&&!GAMES.length){$("#startMsg").textContent=`Couldn't load your games from ${SRC[P.source].name}. Try again in a minute.`;$("#startBtn").disabled=false;P=null;LS.set("profile",null);route()}else job("sync",null)}
 if(!fresh&&!AQ)analyseRecent(5)}
async function boot(){const ls=document.querySelector(`input[name="uSrc"][value="${LS.get("lastSrc","cc")}"]`);if(ls)ls.checked=true;srcLabel();$("#startBtn").disabled=false;$("#startMsg").textContent="";if(!P){route();$("#uName").focus();return}await enter(false)}
(async()=>{await DB.open();ALL=await DB.all();(await DB.pend()).forEach(x=>PEND.set(x.id,x.an));await LiAuth.callback();Sync.start();boot()})();
}
