#!/usr/bin/env node
/* Build the popular-openings list for the Openings gallery (Train › Openings).

   Names come from lichess-org/chess-openings (CC0), https://github.com/lichess-org/chess-openings
     git clone --depth 1 https://github.com/lichess-org/chess-openings.git
     node tools/build-popular.cjs chess-openings

   LIST below holds, per colour, the openings in descending order of how often club players choose them online (ranked by
   hand), each with its defining moves (at most three per side) and the lesson course that teaches it, if any. The script
   plays every line with vendor/chess.js, takes the opening's name from chess-openings for the final position, or the last
   named position on the way (it fails when a line is illegal or nothing on it has a name), and writes vendor/openings-popular-<YYYY-MM>.json:
   {w: [{n, eco, m, c?}], b: [...]}. */
const fs=require("fs"),path=require("path"),vm=require("vm");
const root=path.join(__dirname,".."),cx={};vm.createContext(cx);
vm.runInContext(fs.readFileSync(path.join(root,"vendor/chess.js"),"utf8")+";this.Chess=Chess;",cx);
const C=cx.Chess,key=fen=>fen.split(" ").slice(0,3).join(" ");
// [moves, course id] — White: openings you choose as White; Black: defences you choose as Black
const LIST={
 w:[["e4 e5 Nf3 Nc6 Bc4","italian"],["e4 e5 Nf3 Nc6 Bb5","ruy"],["d4 d5 Bf4","london"],["e4 e5 Nf3 Nc6 d4","scotch"],["d4 d5 c4","qg"],
  ["e4 e5 Nc3"],["c4","english"],["e4 e5 f4"],["Nf3","english"],["e4 c5 d4 cxd4 c3"],["e4 e5 Bc4"],["e4 c5 c3"],["e4 e5 Nf3 Nc6 Nc3 Nf6"],
  ["e4 e5 Nc3 Nf6 f4"],["e4 e6 d4 d5 e5"],["e4 c6 d4 d5 e5"],["d4 Nf6 Bg5"],["d4 d5 Nc3 Nf6 Bf4"],
  ["e4 c5 Nc3"],["e4 e5 d4 exd4 c3"],["f4"],["e4 c5 Nc3 Nc6 f4"],["e4 e5 Nf3 Nc6 c3"],["d4 d5 e4"],["d4 Nf6 c4 e6 g3"],["e4 e5 d4 exd4 Qxd4"],
  ["e4 c6 d4 d5 f3"],["e4 e6 d4 d5 exd5"],["d4 d5 Nf3 Nf6 e3"],["Nf3 d5 g3"],["b3"],["d4 Nf6 Nf3 e6 Bg5"],["b4"],["g3"],["d4 d5 e3 Nf6 Bd3"]],
 b:[["e4 c5","sicilian"],["e4 e6","french"],["e4 c6","caro"],["e4 d5","scandinavian"],["e4 e5 Nf3 Nc6 Bc4 Nf6","italian"],["d4 d5 c4 e6","qgd"],
  ["d4 d5 c4 c6","qgd"],["d4 Nf6 c4 g6 Nc3 Bg7"],["e4 e5 Nf3 d6"],["e4 e5 Nf3 Nf6"],["e4 d6 d4 Nf6 Nc3 g6"],["e4 g6"],["d4 f5"],["e4 Nf6"],
  ["d4 d5 c4 dxc4"],["d4 Nf6 c4 e6 Nc3 Bb4"],["e4 e5 Nf3 Nf6 Nxe5 Nc6"],["d4 Nf6 c4 g6 Nc3 d5"],["d4 Nf6 c4 c5 d5 b5"],["d4 Nf6 c4 e5"],
  ["d4 e5"],["e4 e5 Nf3 d5"],["d4 Nf6 c4 e6 Nf3 b6"],["d4 d5 c4 e5"],["d4 d5 c4 Nc6"],["e4 Nc6"],["d4 Nf6 c4 e6 Nf3 Bb4"],["e4 b6"],
  ["e4 e5 Nf3 f5"],["d4 Nf6 c4 c5 d5 e6"],["c4 e5","english"],["e4 e5 Nf3 Nc6 Bb5 a6","ruy"],["e4 e5 Nf3 Nc6 d4 exd4","scotch"]]};
const names={};let rows=0;
for(const f of ["a","b","c","d","e"])for(const line of fs.readFileSync(path.join(process.argv[2],f+".tsv"),"utf8").split("\n").slice(1)){if(!line.trim())continue;rows++;
 const [eco,name,pgn]=line.split("\t"),c=new C();let ok=true;for(const t of pgn.split(/\s+/)){if(!t||/^\d+\./.test(t))continue;if(!c.move(t)){ok=false;break}}
 const k=key(c.fen());if(ok&&!names[k])names[k]={eco,name}}
const out={},bad=[];
for(const col of ["w","b"]){out[col]=[];const seen=new Set();
 for(const [m,co] of LIST[col]){const c=new C(),ms=m.split(" ");if(ms.length>6)bad.push(m+": more than three moves a side");
  let nm=null;for(const s of ms){if(!c.move(s)){bad.push(m+": illegal "+s);break}nm=names[key(c.fen())]||nm}
  // the name of the final position, or of the last named position on the way (the defining moves add no new name)
  if(!nm){bad.push(m+": no name in chess-openings");continue}
  if(seen.has(nm.name))bad.push(m+": duplicate "+nm.name);seen.add(nm.name);
  out[col].push(Object.assign({n:nm.name,eco:nm.eco,m},co?{c:co}:{}))}}
if(bad.length){console.error(bad.join("\n"));process.exit(1)}
const file=path.join(root,"vendor","openings-popular-"+(process.env.OPENINGS_STAMP||"2026-11")+".json");
fs.writeFileSync(file,JSON.stringify(out));
console.error(`read ${rows} openings; wrote ${out.w.length} White and ${out.b.length} Black openings to ${path.relative(root,file)}`);
