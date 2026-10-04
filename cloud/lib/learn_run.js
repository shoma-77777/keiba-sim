// クラウド（GitHub Actions）で動く学習：結果の出たレースを記録に加え、統合の仕方・要素の効き・馬場の偏りを推定して docs/data/learn.json に保存
// 使い方: node cloud/lib/learn_run.js [データのフォルダ]
const fs = require("fs"), path = require("path");
const Engine = require("./engine.js"), Learn = require("./learn.js");
const DATA = process.argv[2] || path.join(__dirname, "..", "..", "docs", "data");
(async () => {
  const lp = path.join(DATA, "learn.json");
  const old = fs.existsSync(lp) ? JSON.parse(fs.readFileSync(lp, "utf8")) : { records: [] };
  const done = new Set((old.records || []).map(r => r.id));
  let recs = [];
  for (const f of fs.readdirSync(DATA).filter(f => /^races_\d{8}\.json$/.test(f)).sort()){
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
    const races = (snap.races || []).filter(r => r.result?.rows?.length && r.entries?.length && !done.has(r.id));
    if (!races.length) continue;
    const horses = {}; Object.entries(snap.horses || {}).forEach(([id, h]) => horses[id] = { ...h, id });
    const out = await Learn.recordsForRaces(Engine, races, horses, r => snap.track?.[r.date + "|" + r.venue] || null, 2500);
    console.log(`${f}: ${out.length}レースを記録`);
    recs = recs.concat(out);
  }
  if (!recs.length && old.model){ console.log("新しい結果なし"); return; }
  const all = Learn.merge(old.records, recs).slice(-3000);
  const model = Learn.build(all, new Date().toISOString().slice(0, 10));
  fs.writeFileSync(lp, JSON.stringify({ model, records: all }));
  fs.writeFileSync(path.join(DATA, "learn_model.json"), JSON.stringify(model));
  console.log(JSON.stringify({ races: model.races, calib: model.calib, metrics: model.metrics, weights: model.weights }));
})().catch(e => { console.error(e); process.exit(0); });
