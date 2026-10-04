// クラウド（GitHub Actions）で動く「発走前の予想の自動記録」
// アプリ本体（docs/index.html）を画面なしで動かし、まだ発走していないレースを一括シミュレーションして、
// 予想・買い目を docs/data/pre_YYYYMMDD.json に残す（答え合わせを、どの端末からでも「発走前の予想」で正しく行うため）。
// 使い方: node cloud/lib/predict_run.js [docsフォルダ] [YYYYMMDD]
const fs = require("fs"), path = require("path");
const DOCS = process.argv[2] || path.join(__dirname, "..", "..", "docs");
const DATA = path.join(DOCS, "data");

const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => !s.includes("document.write"));
// --- ブラウザの最小限の代用品 ---
const M = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : (k === "length" ? 0 : M), apply: () => M, construct: () => M, set: () => true });
const els = {};
function el(id){ if (!els[id]) els[id] = { id, innerHTML: "", textContent: "", hidden: false, style: {}, value: "", dataset: {}, classList: { add(){}, remove(){}, toggle(){} }, querySelectorAll: () => [], querySelector: () => null, setAttribute(){}, appendChild(){}, addEventListener(){}, focus(){}, clientWidth: 800, clientHeight: 500, closest: () => null }; return els[id]; }
Object.assign(globalThis, {
  THREE: M, __HEADLESS: true,
  document: { querySelector: s => el(String(s).replace("#", "")), querySelectorAll: () => [], getElementById: id => el(id), createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }), style: {}, setAttribute(){}, appendChild(){} }), addEventListener(){}, body: el("body"), activeElement: null, documentElement: el("html") },
  window: { devicePixelRatio: 1, isSecureContext: false, scrollTo(){}, addEventListener(){}, matchMedia: () => ({ matches: false, addEventListener(){} }) },
  ResizeObserver: class { observe(){} }, requestAnimationFrame: () => 1, cancelAnimationFrame(){},
  location: { reload(){}, href: "https://example/", search: "" }
});
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: () => Promise.resolve() }, userAgent: "node" }, configurable: true, writable: true });
const store = {};
globalThis.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
globalThis.fetch = async (url) => {
  const m = /data\/([\w.\-]+\.json)/.exec(String(url));
  const p = m ? path.join(DATA, m[1]) : null;
  if (!p || !fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  const txt = fs.readFileSync(p, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(txt), text: async () => txt };
};
const errs = []; const oerr = console.error; console.error = (...a) => errs.push(a.map(String).join(" "));

(async () => {
  // eslint-disable-next-line no-eval
  (0, eval)(scripts.join("\n;\n"));
  const A = globalThis.__APP;
  if (!A) throw new Error("アプリの読み込みに失敗");
  if (!A.SERVER.cloud) throw new Error("クラウド版の index.html ではありません");
  A.SERVER.status = await A.api("/api/status"); A.SERVER.on = true;
  await A.loadServerDB(); await A.loadLearn();
  const ymd = process.argv[3] || A.SERVER.status.nextSunday || A.SERVER.status.date;
  const d = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  A.ST.date = d;
  const now = process.env.PREDICT_NOW ? new Date(process.env.PREDICT_NOW) : new Date();   // PREDICT_NOW はテスト用
  const list = A.racesOfDay(d).filter(r => A.raceStart(r) > new Date(now.getTime() + 60000));
  if (!list.length){ console.log(`${ymd}: 発走前のレースなし`); process.exit(0); }
  const pp = path.join(DATA, `pre_${ymd}.json`);
  const pre = fs.existsSync(pp) ? JSON.parse(fs.readFileSync(pp, "utf8")) : { date: d, rows: {} };
  const t0 = Date.now(); let n = 0;
  for (const r of list){
    await A.runSim(true, { id: r.id, runs: A.BATCH_RUNS });
    const x = A.BATCH.rows[r.id];
    if (x && process.env.PREDICT_NOW) x.at = now.toISOString();
    if (x && new Date(x.at) <= A.raceStart(r)){ const { preRace, ...row } = x; row.src = "cloud"; pre.rows[r.id] = row; n++; }
  }
  pre.updated = new Date().toISOString();
  fs.writeFileSync(pp, JSON.stringify(pre));
  console.log(`${ymd}: 発走前の予想を${n}レース記録（${Math.round((Date.now() - t0) / 1000)}秒）`);
  if (errs.length) oerr("警告:", errs.slice(0, 3).join(" | "));
  process.exit(0);
})().catch(e => { oerr(e); process.exit(0); });
