#!/usr/bin/env node
/* Build the vendored opening names for the Openings track's lesson lines.

   Source: lichess-org/chess-openings (CC0), https://github.com/lichess-org/chess-openings
     git clone --depth 1 https://github.com/lichess-org/chess-openings.git
     node tools/build-openings.js chess-openings

   Reads the a-e.tsv files (eco, name, pgn), plays every line with vendor/chess.js, and keeps the names of the positions that
   occur in the lesson lines (OPC in app.js), keyed by the first three FEN fields (placement, side to move, castling).
   Writes vendor/chess-openings-<YYYY-MM>/names.json ({key: "ECO Name"}). Rerun after changing the lines. */
const fs=require("fs"),path=require("path"),vm=require("vm");
const root=path.join(__dirname,".."),src=fs.readFileSync(path.join(root,"app.js"),"utf8"),cx={};vm.createContext(cx);
const a=src.indexOf("const OPC=["),b=src.indexOf("];",src.indexOf('{id:"english",name'))+2;
vm.runInContext(fs.readFileSync(path.join(root,"vendor/chess.js"),"utf8")+";this.Chess=Chess;"+src.slice(a,b)+";this.OPC=OPC;",cx);
const C=cx.Chess,key=fen=>fen.split(" ").slice(0,3).join(" "),want=new Set();
for(const co of cx.OPC)for(const ch of co.chapters)for(const l of ch.lessons){const c=new C();for(const s of l.m.split(" ")){if(!c.move(s))break;want.add(key(c.fen()))}}
const names={};let rows=0;
for(const f of ["a","b","c","d","e"]){for(const line of fs.readFileSync(path.join(process.argv[2],f+".tsv"),"utf8").split("\n").slice(1)){if(!line.trim())continue;rows++;
 const [eco,name,pgn]=line.split("\t"),c=new C();let ok=true;for(const t of pgn.split(/\s+/)){if(!t||/^\d+\./.test(t))continue;if(!c.move(t)){ok=false;break}}
 const k=key(c.fen());if(ok&&want.has(k)&&!names[k])names[k]=eco+" "+name}}
const out=path.join(root,"vendor","chess-openings-"+(process.env.OPENINGS_STAMP||"2026-11"));fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,"names.json"),JSON.stringify(names));
console.error(`read ${rows} openings; ${Object.keys(names).length} names for ${want.size} lesson positions`);
