#!/usr/bin/env node
/* Check the translation files against i18n/en.js: same keys, same {placeholders}, the same HTML tags, and plural keys
   (.one/.other, plus any other category the language needs except "many", which TP() serves from .other). Run: node tools/check-i18n.cjs */
const fs=require("fs"),path=require("path"),vm=require("vm"),dir=path.join(__dirname,"..","i18n"),cx={window:{}};vm.createContext(cx);
for(const f of fs.readdirSync(dir).filter(f=>f.endsWith(".js")))vm.runInContext(fs.readFileSync(path.join(dir,f),"utf8"),cx);
const L=cx.window.KZ_I18N,en=L.en,ph=s=>(s.match(/\{\w+\}/g)||[]).sort().join(","),tags=s=>(s.match(/<\/?\w+/g)||[]).sort().join(",");let bad=0;
for(const [lang,t] of Object.entries(L)){if(lang==="en")continue;const cats=new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
 for(const k of Object.keys(en)){if(!(k in t)){console.log(lang,"missing",k);bad++;continue}
  if(ph(t[k])!==ph(en[k])&&!/\.(one|zero|two|few|many)$/.test(k)){console.log(lang,"placeholders differ",k,ph(en[k]),"→",ph(t[k]));bad++}
  if(tags(t[k])!==tags(en[k])){console.log(lang,"HTML differs",k);bad++}}
 for(const k of Object.keys(t))if(!(k in en)){console.log(lang,"extra key",k);bad++}
 const plur=[...new Set(Object.keys(en).filter(k=>k.endsWith(".other")&&k.slice(0,-6)+".one" in en).map(k=>k.slice(0,-6)))];
 for(const p of plur)for(const c of cats)if(c!=="many"&&!(p+"."+c in t)){console.log(lang,"plural missing",p+"."+c);bad++}
 console.log(lang+":",Object.keys(t).length,"keys")}
if(bad){console.log(bad,"problems");process.exit(1)}else console.log("all translations match en.js")
