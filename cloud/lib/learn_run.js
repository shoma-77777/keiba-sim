// クラウド（GitHub Actions）で動く学習：結果の出たレースを記録に加え、統合の仕方・要素の効き・馬場の偏りを推定して docs/data/learn.json に保存
// 使い方: node cloud/lib/learn_run.js [データのフォルダ]
const fs = require("fs"), path = require("path");
const Engine = require("./engine.js"), Learn = require("./learn.js");
const DATA = process.argv[2] || path.join(__dirname, "..", "..", "docs", "data");
(async () => {
  const lp = path.join(DATA, "learn.json");
  const old = fs.existsSync(lp) ? JSON.parse(fs.readFileSync(lp, "utf8")) : { records: [] };
  // 作り方が古い記録は、その日のデータが残っていれば作り直す
  const done = new Set((old.records || []).filter(r => (r.rv || 0) >= Learn.RV).map(r => r.id));
  // スマホ・PCの答え合わせで送られた仮想収支（発走前の推奨を買っていた場合の [投資, 払戻]）
  const bets = {};
  fs.readdirSync(DATA).filter(f => /^bets_\d{8}\.json$/.test(f)).forEach(f => Object.assign(bets, JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"))));
  // クラウドが記録した発走前の予想（pre_*.json）の買い目 × 確定払戻 → 仮想収支（どの端末で見ていたかに関係なく、正しい「発走前」の成績）
  const PAYK = { 単勝: 1, 複勝: 1, 馬連: 0, ワイド: 0, 馬単: 2, 三連複: 0 };
  const payOf = (t, pay) => { const tb = pay?.[t.type]; if (!tb) return 0; const k = PAYK[t.type] === 1 ? String(t.nums[0]) : PAYK[t.type] === 2 ? t.nums.join("-") : t.nums.slice().sort((a, b) => a - b).join("-"); return tb[k] ? t.stake / 100 * tb[k] : 0; };
  const resOf = {};
  fs.readdirSync(DATA).filter(f => /^races_\d{8}\.json$/.test(f)).forEach(f => { (JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")).races || []).forEach(r => { if (r.result?.pay) resOf[r.id] = r.result; }); });
  fs.readdirSync(DATA).filter(f => /^pre_\d{8}\.json$/.test(f)).forEach(f => {
    const pre = JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
    Object.entries(pre.rows || {}).forEach(([id, x]) => { const res = resOf[id]; if (!res) return;
      const pick = ts => ts?.length ? [ts.reduce((a, t) => a + t.stake, 0), Math.round(ts.reduce((a, t) => a + payOf(t, res.pay), 0))] : [0, 0];
      bets[id] = { t1: pick(x.t1), t5: pick(x.t5), te: pick(x.te), t1s: pick(x.t1s || x.t1), src: "pre" }; });
  });
  let attached = 0;
  (old.records || []).forEach(r => { if (bets[r.id] && JSON.stringify(r.bets) !== JSON.stringify(bets[r.id])){ r.bets = bets[r.id]; attached++; } });
  let recs = [];
  for (const f of fs.readdirSync(DATA).filter(f => /^races_\d{8}\.json$/.test(f)).sort()){
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
    const races = (snap.races || []).filter(r => r.result?.rows?.length && r.entries?.length && !done.has(r.id));
    if (!races.length) continue;
    const horses = {}; Object.entries(snap.horses || {}).forEach(([id, h]) => horses[id] = { ...h, id });
    const out = await Learn.recordsForRaces(Engine, races, horses, r => snap.track?.[r.date + "|" + r.venue] || null, 2500, r => bets[r.id] || null);
    console.log(`${f}: ${out.length}レースを記録`);
    recs = recs.concat(out);
  }
  if (!recs.length && !attached && (old.model?.version || 1) >= 2){ console.log("新しい結果なし"); return; }
  const all = Learn.merge(old.records, recs).slice(-6000);   // クラウドのファイルが大きくなりすぎないよう直近6000レースまで（PCは全件）
  const model = Learn.build(all, new Date().toISOString().slice(0, 10));
  fs.writeFileSync(lp, JSON.stringify({ model, records: all }));
  // PCで過去データを含めて学習した結果（こちらより多いレースで学習）があれば、それを優先して上書きしない
  const mp = path.join(DATA, "learn_model.json");
  const pcModel = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, "utf8")) : null;
  if (pcModel && (pcModel.races || 0) > model.races){ console.log(`PCの学習結果（${pcModel.races}レース）を使います`); return; }
  fs.writeFileSync(mp, JSON.stringify(model));
  console.log(JSON.stringify({ races: model.races, calib: model.calib, metrics: model.metrics, weights: model.weights }));
})().catch(e => { console.error(e); process.exit(0); });
