// ===== 結果から学習して精度を上げる仕組み =====
// 毎週の答え合わせで、各レースについて「モデルの確率・市場（確定オッズ）の確率・各要素の補正値・実際の着順・通過順・上がり」を記録し、
// 1) モデルと市場の統合の仕方（指数 a, b）  p ∝ p_model^a × p_market^b
// 2) 各要素（スピード・騎手・枠…）の効き具合の補正
// 3) 競馬場ごとの馬場の偏り（前残り・内枠有利）
// を、上位3着までの着順の尤度（Plackett–Luce）を最大にするように推定する。
// データが少ないうちは事前の値（a=0.5, b=0.55, 補正0）に強く引き寄せ、レースが増えるほどデータに従う。
const Learn = (() => {
  const FEATS = ["能力","スピード","レース傾向","当日馬場","血統","季節","調子","距離","芝ダ","馬場","競馬場","回り","枠","斤量","騎手","乗替","調教","ローテ","年齢","穴要素","人気変動"];
  const PRIOR = { a: 0.5, b: 0.55, sa: 0.35, sb: 0.35, sc: 0.025 };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // 1レース分の記録を作る（pm: モデルの1着確率、ctx: buildContext の結果、res: 結果）
  function record(race, ctx, pm, res){
    const rows = res.rows || [];
    const fin = {}; rows.forEach(x => { if (/^\d+$/.test(String(x.pos))) fin[x.num] = x; });
    const order = res.order || rows.filter(x => /^\d+$/.test(String(x.pos))).sort((a, b) => a.pos - b.pos).map(x => x.num);
    const N = ctx.N;
    const odds = ctx.field.map(f => (fin[f.num]?.odds > 1 ? fin[f.num].odds : f.odds) || null);
    const mx = Math.max(...odds.filter(Boolean)); const inv = odds.map(o => 1 / (o || mx * 2)); const s = inv.reduce((a, b) => a + b, 0);
    // モデルの感度：log p_model を総合Ptで回帰した傾き（要素補正を確率への効きに換算するため）
    const P = ctx.field.map(f => f.P), lp = pm.map(p => Math.log(Math.max(p, 1e-4)));
    const mP = P.reduce((a, b) => a + b, 0) / N, mL = lp.reduce((a, b) => a + b, 0) / N;
    let sxy = 0, sxx = 0; P.forEach((x, i) => { sxy += (x - mP) * (lp[i] - mL); sxx += (x - mP) ** 2; });
    const sens = sxx > 0 ? clamp(sxy / sxx, 0.05, 2) : 0.4;
    const early = {};
    if (res.corners?.length){ const c = res.corners[Math.min(1, res.corners.length - 1)]; c.forEach((num, k) => early[num] = k / Math.max(1, c.length - 1)); }
    const l3 = rows.filter(x => x.l3f > 0).map(x => x.l3f).sort((a, b) => a - b);
    return {
      id: race.id, date: race.date, venue: race.venue, surface: race.surface, dist: race.distance, going: res.going || race.going || null, n: N, sens: +sens.toFixed(4),
      order: order.slice(0, 5),
      h: ctx.field.map((f, i) => ({
        num: f.num, pm: +Math.max(pm[i], 1e-4).toFixed(5), pk: +(inv[i] / s).toFixed(5), odds: odds[i], pop: fin[f.num]?.pop ?? f.pop ?? null,
        pos: fin[f.num] ? +fin[f.num].pos : null, time: fin[f.num]?.time || null, l3f: fin[f.num]?.l3f || null,
        l3rank: fin[f.num]?.l3f ? l3.indexOf(fin[f.num].l3f) + 1 : null, early: early[f.num] ?? null,
        gate: +(((f.num - 1) / Math.max(1, N - 1))).toFixed(3), style: f.style,
        z: FEATS.map(k => +(f.adj[k] || 0).toFixed(3))
      }))
    };
  }

  // 上位3着の Plackett–Luce 対数尤度（パラメータ θ = [a, b, c_1..c_K]）
  function nll(recs, th, grad){
    const K = FEATS.length; let L = 0;
    if (grad) grad.fill(0);
    for (const r of recs){
      const H = r.h, n = H.length; if (n < 2 || !r.order?.length) continue;
      const u = H.map(h => th[0] * Math.log(h.pm) + th[1] * Math.log(h.pk) + h.z.reduce((a, z, k) => a + th[2 + k] * z, 0));
      const used = new Array(n).fill(false);
      for (const num of r.order.slice(0, 3)){
        const wi = H.findIndex(h => h.num === num); if (wi < 0 || used[wi]) break;
        let mx = -1e9; for (let i = 0; i < n; i++) if (!used[i]) mx = Math.max(mx, u[i]);
        let Z = 0; const e = new Array(n).fill(0); for (let i = 0; i < n; i++) if (!used[i]){ e[i] = Math.exp(u[i] - mx); Z += e[i]; }
        L -= u[wi] - mx - Math.log(Z);
        if (grad){
          const feat = i => [Math.log(H[i].pm), Math.log(H[i].pk), ...H[i].z];
          const fw = feat(wi); for (let j = 0; j < 2 + K; j++) grad[j] -= fw[j];
          for (let i = 0; i < n; i++) if (!used[i]){ const p = e[i] / Z, fi = feat(i); for (let j = 0; j < 2 + K; j++) grad[j] += p * fi[j]; }
        }
        used[wi] = true;
      }
    }
    // 事前分布（データが少ないうちは事前の値に寄せる）
    const pr = [[th[0] - PRIOR.a, PRIOR.sa], [th[1] - PRIOR.b, PRIOR.sb]];
    pr.forEach(([d, s], j) => { L += d * d / (2 * s * s); if (grad) grad[j] += d / (s * s); });
    for (let k = 0; k < K; k++){ const d = th[2 + k]; L += d * d / (2 * PRIOR.sc ** 2); if (grad) grad[2 + k] += d / PRIOR.sc ** 2; }
    return L;
  }

  function fit(recs){
    const K = FEATS.length, th = new Float64Array(2 + K); th[0] = PRIOR.a; th[1] = PRIOR.b;
    const g = new Float64Array(2 + K), m = new Float64Array(2 + K), v = new Float64Array(2 + K);
    const lr = 0.02;
    for (let t = 1; t <= 600; t++){
      nll(recs, th, g);
      for (let j = 0; j < th.length; j++){
        m[j] = 0.9 * m[j] + 0.1 * g[j]; v[j] = 0.999 * v[j] + 0.001 * g[j] * g[j];
        th[j] -= lr * (m[j] / (1 - 0.9 ** t)) / (Math.sqrt(v[j] / (1 - 0.999 ** t)) + 1e-8);
      }
      th[0] = clamp(th[0], 0, 1.5); th[1] = clamp(th[1], 0, 1.5);
    }
    return th;
  }

  // 1着の対数損失（小さいほど良い）
  function logloss(recs, fn){
    let L = 0, n = 0;
    for (const r of recs){ const w = r.h.find(h => h.num === r.order?.[0]); if (!w) continue; const q = r.h.map(fn); const s = q.reduce((a, b) => a + b, 0); L += -Math.log(fn(w) / s); n++; }
    return n ? L / n : null;
  }

  // 競馬場・芝ダごとの偏り（直近14日）：前に行った馬・内枠の馬が上位に来たか
  function bias(recs, today){
    const out = {}, lim = new Date(new Date(today + "T12:00:00") - 14 * 864e5).toISOString().slice(0, 10);
    const groups = {};
    recs.filter(r => r.date >= lim).forEach(r => { (groups[r.venue + "|" + r.surface] ||= []).push(r); });
    const corr = (xs, ys) => { const n = xs.length; if (n < 4) return null; const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
      let sxy = 0, sx = 0, sy = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sx += (x - mx) ** 2; sy += (ys[i] - my) ** 2; }); return sx && sy ? sxy / Math.sqrt(sx * sy) : null; };
    Object.entries(groups).forEach(([k, rs]) => {
      let fe = [], fg = [], n = 0;
      rs.forEach(r => { const hs = r.h.filter(h => h.pos); if (hs.length < 5) return; n++;
        const pr = h => (h.pos - 1) / (hs.length - 1);
        const ce = corr(hs.filter(h => h.early != null).map(h => h.early), hs.filter(h => h.early != null).map(pr)); if (ce != null) fe.push(ce);
        const cg = corr(hs.map(h => h.gate), hs.map(pr)); if (cg != null) fg.push(cg); });
      const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
      const e = avg(fe), gte = avg(fg);
      // 相関（前ほど小さい値 × 着順が良いほど小さい値）が正なら「前残り」。レース数が少ないほど控えめに
      const shrink = n / (n + 6);
      out[k] = { races: n, front: e != null ? +clamp(e * 0.9 * shrink, -0.5, 0.6).toFixed(3) : null, inner: gte != null ? +clamp(gte * 0.8 * shrink, -0.4, 0.4).toFixed(3) : null,
        corrEarly: e != null ? +e.toFixed(3) : null, corrGate: gte != null ? +gte.toFixed(3) : null };
    });
    return out;
  }

  // 学習結果をまとめる
  function build(recs, today){
    const th = fit(recs);
    const K = FEATS.length;
    const sens = recs.length ? recs.reduce((a, r) => a + (r.sens || 0.4), 0) / recs.length : 0.4;
    const weights = {};
    // 要素の補正はレースが十分たまるまで控えめに（200レースで半分、600レースで3/4の強さ）
    const trust = recs.length / (recs.length + 200);
    FEATS.forEach((k, j) => { const c = th[2 + j]; const mult = clamp(1 + c / (Math.max(0.3, th[0]) * sens) * trust, 0.6, 1.5); if (Math.abs(mult - 1) >= 0.02) weights[k] = +mult.toFixed(3); });
    const a = th[0], b = th[1];
    const byDate = {};
    recs.forEach(r => (byDate[r.date] ||= []).push(r));
    const hist = Object.keys(byDate).sort().map(d => ({ date: d, races: byDate[d].length,
      model: +logloss(byDate[d], h => h.pm).toFixed(3), market: +logloss(byDate[d], h => h.pk).toFixed(3),
      blend: +logloss(byDate[d], h => Math.pow(h.pm, a) * Math.pow(h.pk, b)).toFixed(3) }));
    return {
      version: 1, updated: new Date().toISOString(), races: recs.length,
      calib: { a: +a.toFixed(3), b: +b.toFixed(3) },
      weights, featCoef: Object.fromEntries(FEATS.map((k, j) => [k, +th[2 + j].toFixed(4)])),
      metrics: { model: logloss(recs, h => h.pm), market: logloss(recs, h => h.pk), blend: logloss(recs, h => Math.pow(h.pm, a) * Math.pow(h.pk, b)) },
      hist, bias: bias(recs, today || new Date().toISOString().slice(0, 10)), sens: +sens.toFixed(3)
    };
  }

  function merge(oldRecs, newRecs){
    const m = new Map((oldRecs || []).map(r => [r.id, r])); (newRecs || []).forEach(r => m.set(r.id, r));
    return [...m.values()].sort((x, y) => (x.date + x.id).localeCompare(y.date + y.id));
  }

  // 結果の出ているレースについて、モデルの1着確率を計算して記録を作る（ブラウザでもNodeでも同じ）
  async function recordsForRaces(Engine, races, horses, trackOf, runs = 2500){
    const out = [];
    for (const r of races){
      const res = r.result; if (!res || !r.entries?.length) continue;
      const fin = {}; (res.rows || []).forEach(x => fin[x.num] = x);
      const ents = r.entries.filter(e => !res.rows?.length || fin[e.num]).map(e => ({ ...e, odds: fin[e.num]?.odds > 1 ? fin[e.num].odds : e.odds, pop: fin[e.num]?.pop || e.pop }));
      if (ents.length < 2) continue;
      const race = { ...r, entries: ents, going: r.going || res.going || "良" };
      const ctx = Engine.buildContext(race, horses, { going: race.going, track: trackOf ? trackOf(r) : null });
      const pf = Engine.paceForecast ? Engine.paceForecast(ctx) : { slow: 1 / 3, mid: 1 / 3, high: 1 / 3 };
      const win = new Float64Array(ctx.N); let tot = 0;
      for (const p of ["slow", "mid", "high"]){
        const w = pf[p]; if (w <= 0.001) continue;
        const m = await Engine.monteCarlo(ctx, runs, 7000 + out.length * 31, null, p);
        m.stats.forEach((s, i) => win[i] += w * s.win); tot += w;
      }
      const pm = Array.from(win, x => x / tot);
      out.push(record(race, ctx, pm, res));
    }
    return out;
  }

  return { FEATS, record, fit, build, merge, bias, logloss, recordsForRaces };
})();
if (typeof module !== "undefined") module.exports = Learn;
