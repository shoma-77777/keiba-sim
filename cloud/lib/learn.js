// ===== 結果から学習して精度を上げる仕組み =====
// 毎週の答え合わせで、各レースについて「モデルの確率・市場（確定オッズ）の確率・各要素の補正値・実際の着順・通過順・上がり」を記録し、
// 1) モデルと市場の統合の仕方（指数 a, b）  p ∝ p_model^a × p_market^b
// 2) 各要素（スピード・騎手・枠…）の効き具合の補正
// 3) 競馬場ごとの馬場の偏り（前残り・内枠有利）
// を、上位3着までの着順の尤度（Plackett–Luce）を最大にするように推定する。
// データが少ないうちは事前の値（a=0.3, b=0.85, 補正0）に強く引き寄せ、レースが増えるほどデータに従う。
const Learn = (() => {
  const FEATS = ["能力","スピード","レース傾向","当日馬場","血統","季節","調子","距離","芝ダ","馬場","競馬場","回り","枠","斤量","騎手","乗替","調教","ローテ","年齢","穴要素","人気変動"];
  const PRIOR = { a: 0.3, b: 0.85, sa: 0.2, sb: 0.2, sc: 0.025 };
  // 2着・3着の選ばれ方は1着より「まぎれ」が大きいので、段階ごとに確率の鋭さを割り引く（ベンターの方法）。
  // これをしないと、統合の指数 a+b が 1 より小さく推定され、大穴の確率を過大に見積もってしまう（10/4 で実際に発生）。
  const LAM = [1, 0.75, 0.6];
  const RV = 3;   // 記録の作り方の版（3: その日より前の出走歴だけでモデル確率を計算）
  const AB_MIN = 1.0;   // a+b の下限：統合後の確率がオッズより「平ら」（＝大穴を過大評価）にならないように
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // 1レース分の記録を作る（pm: モデルの1着確率、ctx: buildContext の結果、res: 結果）
  // wcur: 記録時に効いていた要素の重み、wbase: 学習前の基準の重み（要素の値を基準の単位に直して記録する）
  function record(race, ctx, pm, res, bets, wcur, wbase){
    wcur = wcur || {}; wbase = wbase || {};
    const wc = k => (k === "能力" ? 1 : (wcur[k] ?? 1)), wb = k => (k === "能力" ? 1 : (wbase[k] ?? 1));
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
      rv: RV, id: race.id, date: race.date, post: race.postTime || null, kai: race.kai || null, venue: race.venue, surface: race.surface, dist: race.distance, going: res.going || race.going || null, n: N, sens: +sens.toFixed(4),
      order: order.slice(0, 5),
      h: ctx.field.map((f, i) => ({
        num: f.num, pm: +Math.max(pm[i], 1e-4).toFixed(5), pk: +(inv[i] / s).toFixed(5), odds: odds[i], pop: fin[f.num]?.pop ?? f.pop ?? null,
        pos: fin[f.num] ? +fin[f.num].pos : null, time: fin[f.num]?.time || null, l3f: fin[f.num]?.l3f || null,
        l3rank: fin[f.num]?.l3f ? l3.indexOf(fin[f.num].l3f) + 1 : null, early: early[f.num] ?? null,
        gate: +(((f.num - 1) / Math.max(1, N - 1))).toFixed(3), style: f.style, ana: f.ana || [],
        z: FEATS.map(k => +((f.adj[k] || 0) / (Math.abs(wc(k)) > 1e-6 ? wc(k) : 1)).toFixed(3))
      })),
      wr: FEATS.map(k => +(wc(k) / (Math.abs(wb(k)) > 1e-6 ? wb(k) : 1)).toFixed(3)),
      bets: bets || null
    };
  }

  // ===== 穴決着の分析：なぜ人気薄が来たのかを、展開・枠・上がり・人気馬の凡走・モデル評価・穴パターンから説明 =====
  const isLong = h => (h.pop || 99) >= 6 || (h.odds || 0) >= 15;
  function analyzeUpsets(r){
    const H = r.h.filter(h => h.pos), n = H.length; if (n < 5) return [];
    const top3 = H.filter(h => h.pos <= 3);
    const e3 = top3.filter(h => h.early != null).map(h => h.early);
    const shape = e3.length ? (e3.reduce((a, b) => a + b, 0) / e3.length < 0.3 ? "前残り" : e3.reduce((a, b) => a + b, 0) / e3.length > 0.6 ? "差し・追込決着" : "平均的") : null;
    const favFlop = H.filter(h => (h.pop || 99) <= 3 && h.pos >= 6).map(h => `${h.pop}番人気${h.num}番が${h.pos}着`);
    const mean = FEATS.map((_, k) => H.reduce((a, h) => a + h.z[k], 0) / n);
    return top3.filter(h => (h.pos === 1 && (h.pop || 99) >= 6) || (h.pop || 99) >= 9 || (h.odds || 0) >= 30).map(h => {
      const why = [];
      if (h.early != null && h.early <= 0.25) why.push("展開:前に行って粘った");
      if (h.early != null && h.early >= 0.55 && h.l3rank && h.l3rank <= 3) why.push(`展開:後方から上がり${h.l3rank}位`);
      else if (h.l3rank && h.l3rank <= 2) why.push(`末脚:上がり${h.l3rank}位`);
      if (shape) why.push("決着:" + shape);
      if (h.gate <= 0.2) why.push("枠:内枠"); else if (h.gate >= 0.8) why.push("枠:外枠");
      if (favFlop.length) why.push("人気馬の凡走");
      if (r.going && r.going !== "良") why.push("馬場:" + r.going);
      if (h.pm >= h.pk * 1.3) why.push("モデル:市場より高評価"); else if (h.pm <= h.pk * 0.7) why.push("モデル:見落とし");
      (h.ana || []).forEach(a => why.push("穴パターン:" + a));
      const plus = FEATS.map((k, j) => [k, h.z[j] - mean[j]]).filter(([, d]) => d >= 0.6).sort((a, b) => b[1] - a[1]).slice(0, 3);
      plus.forEach(([k]) => why.push("強み:" + k));
      return { id: r.id, date: r.date, venue: r.venue, num: h.num, pop: h.pop, odds: h.odds, pos: h.pos, pm: h.pm, pk: h.pk, why, favFlop };
    });
  }
  // 穴馬（6番人気以下）の中で、各要因があったときの3着内率と、なかったときの比（リフト）
  function upsetStats(recs){
    const cnt = {}; let base = 0, baseHit = 0;
    recs.forEach(r => {
      const H = r.h.filter(h => h.pos); if (H.length < 5) return;
      const top3 = H.filter(h => h.pos <= 3), e3 = top3.filter(h => h.early != null).map(h => h.early);
      const sh = e3.length ? (e3.reduce((a, b) => a + b, 0) / e3.length < 0.3 ? "前残り" : e3.reduce((a, b) => a + b, 0) / e3.length > 0.6 ? "差し・追込決着" : "平均的") : null;
      H.filter(isLong).forEach(h => {
        base++; const hit = h.pos <= 3; if (hit) baseHit++;
        const keys = [];
        if (h.early != null && h.early <= 0.25) keys.push("展開:前に行った");
        if (h.early != null && h.early >= 0.55) keys.push("展開:後方待機");
        if (h.gate <= 0.2) keys.push("枠:内枠"); if (h.gate >= 0.8) keys.push("枠:外枠");
        if (r.going && r.going !== "良") keys.push("馬場:道悪");
        if (h.pm >= h.pk * 1.3) keys.push("モデル:市場より高評価");
        (h.ana || []).forEach(a => keys.push("穴パターン:" + a));
        keys.forEach(k => { const c = (cnt[k] ||= { n: 0, hit: 0 }); c.n++; if (hit) c.hit++; });
      });
    });
    const p0 = base ? baseHit / base : 0;
    return { longshots: base, top3Rate: +p0.toFixed(4), factors: Object.entries(cnt).map(([k, c]) => ({ k, n: c.n, hit: c.hit, rate: +(c.hit / c.n).toFixed(4),
      lift: +(((c.hit + 2 * p0) / (c.n + 2)) / Math.max(p0, 1e-4)).toFixed(3) })).sort((a, b) => b.lift - a.lift) };
  }
  // 穴パターンの加点を、穴馬の3着内率のリフトから更新（件数が少ないうちは初期値のまま）
  const ANA_PTS = { "前走度外視": 0.8, "G1からの格下げ": 0.6, "実績の割に人気薄": 0.7, "距離短縮": 0.4, "叩き2戦目": 0.5, "鞍上強化": 0.4, "内枠の先行馬": 0.4, "コース巧者": 0.5 };
  function anaWeights(stats){
    const out = {};
    Object.entries(ANA_PTS).forEach(([k, pts]) => {
      const f = stats.factors.find(x => x.k === "穴パターン:" + k); if (!f) return;
      const t = f.n / (f.n + 300);                       // 300頭分で半分の重み（偶然の偏りに振り回されないように）
      const learned = clamp(Math.log(Math.max(f.lift, 0.2)) * 2.5, -0.5, 2.5);  // リフト2倍 ≒ +1.7Pt
      out[k] = { pts: +(pts * (1 - t) + learned * t).toFixed(3) };
    });
    return out;
  }
  // 仮想収支：毎レース、発走前の推奨どおりに買っていたらどうなったか（長期でプラスかを統計的に判定）
  function paperStats(recs){
    const out = {};
    ["t1", "t5", "t1s", "te"].forEach(k => {
      const xs = recs.map(r => r.bets?.[k]).filter(Boolean).filter(b => b[0] > 0);
      const inv = xs.reduce((a, b) => a + b[0], 0), ret = xs.reduce((a, b) => a + b[1], 0);
      if (!xs.length){ out[k] = { races: 0 }; return; }
      // 1円あたりの回収の平均と標準誤差（レースごとの比を投資額で重み付け）
      const rr = xs.map(b => b[1] / b[0]), w = xs.map(b => b[0] / inv);
      const m = rr.reduce((a, x, i) => a + w[i] * x, 0);
      // 投資額で重み付けした平均の標準誤差（賭け額が不ぞろいでも正しい形）: se² = Σ w_i² (r_i − m)² × n/(n−1)
      const n = xs.length;
      const se = Math.sqrt(rr.reduce((a, x, i) => a + w[i] * w[i] * (x - m) ** 2, 0) * n / Math.max(1, n - 1));
      const v = se * se * n;   // 1レースあたりの分散（必要レース数の見積もり用）
      out[k] = { races: xs.length, invest: inv, ret: Math.round(ret), roi: +(ret / inv).toFixed(4), lo95: +Math.max(0, m - 1.96 * se).toFixed(4), hi95: +(m + 1.96 * se).toFixed(4),
        need: se > 0 ? Math.ceil((1.96 * Math.sqrt(v) / Math.max(0.02, Math.abs(m - 1))) ** 2) : null };
    });
    return out;
  }

  // 上位3着の Plackett–Luce 対数尤度（パラメータ θ = [a, b, c_1..c_K]）
  function nll(recs, th, grad){
    const K = FEATS.length; let L = 0;
    if (grad) grad.fill(0);
    for (const r of recs){
      const H = r.h, n = H.length; if (n < 2 || !r.order?.length) continue;
      const u = H.map(h => th[0] * Math.log(h.pm) + th[1] * Math.log(h.pk) + h.z.reduce((a, z, k) => a + th[2 + k] * z, 0));
      const used = new Array(n).fill(false);
      const top = r.order.slice(0, 3);
      for (let st = 0; st < top.length; st++){
        const num = top[st], lam = LAM[st];
        const wi = H.findIndex(h => h.num === num); if (wi < 0 || used[wi]) break;
        let mx = -1e9; for (let i = 0; i < n; i++) if (!used[i]) mx = Math.max(mx, lam * u[i]);
        let Z = 0; const e = new Array(n).fill(0); for (let i = 0; i < n; i++) if (!used[i]){ e[i] = Math.exp(lam * u[i] - mx); Z += e[i]; }
        L -= lam * u[wi] - mx - Math.log(Z);
        if (grad){
          const feat = i => [Math.log(H[i].pm), Math.log(H[i].pk), ...H[i].z];
          const fw = feat(wi); for (let j = 0; j < 2 + K; j++) grad[j] -= lam * fw[j];
          for (let i = 0; i < n; i++) if (!used[i]){ const p = e[i] / Z, fi = feat(i); for (let j = 0; j < 2 + K; j++) grad[j] += lam * p * fi[j]; }
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
      if (th[0] + th[1] < AB_MIN){ const d = (AB_MIN - th[0] - th[1]) / 2; th[0] += d; th[1] += d; }
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
    // 記録時に効いていた重み（基準に対する倍率）の平均に、残差の係数 c を上乗せする。
    // 要素の効きは、オッズとの混合（市場の重み0.4）で確率への効きが0.6倍になっている分を戻して換算
    FEATS.forEach((k, j) => {
      const c = th[2 + j];
      const rel = recs.length ? recs.reduce((a, r) => a + (r.wr ? r.wr[j] : 1), 0) / recs.length : 1;
      const mult = clamp(rel + c / (Math.max(0.3, th[0]) * sens * 0.6) * trust, 0.6, 1.5);
      if (Math.abs(mult - 1) >= 0.02) weights[k] = +mult.toFixed(3);
    });
    const a = th[0], b = th[1];
    const byDate = {};
    recs.forEach(r => (byDate[r.date] ||= []).push(r));
    const hist = Object.keys(byDate).sort().map(d => ({ date: d, races: byDate[d].length,
      model: +logloss(byDate[d], h => h.pm).toFixed(3), market: +logloss(byDate[d], h => h.pk).toFixed(3),
      blend: +logloss(byDate[d], h => Math.pow(h.pm, a) * Math.pow(h.pk, b)).toFixed(3) }));
    return {
      version: 2, updated: new Date().toISOString(), races: recs.length,
      calib: { a: +a.toFixed(3), b: +b.toFixed(3) },
      weights, featCoef: Object.fromEntries(FEATS.map((k, j) => [k, +th[2 + j].toFixed(4)])),
      metrics: { model: logloss(recs, h => h.pm), market: logloss(recs, h => h.pk), blend: logloss(recs, h => Math.pow(h.pm, a) * Math.pow(h.pk, b)) },
      hist, bias: bias(recs, today || new Date().toISOString().slice(0, 10)), sens: +sens.toFixed(3),
      upsets: recs.slice(-400).flatMap(analyzeUpsets).slice(-60), upsetStats: (() => { const us = upsetStats(recs); return { ...us, factors: us.factors.slice(0, 16) }; })(),
      anaWeights: anaWeights(upsetStats(recs)), paper: paperStats(recs)
    };
  }

  function merge(oldRecs, newRecs){
    const m = new Map((oldRecs || []).map(r => [r.id, r])); (newRecs || []).forEach(r => { const o = m.get(r.id); m.set(r.id, o && !r.bets && o.bets ? { ...r, bets: o.bets } : r); });
    return [...m.values()].sort((x, y) => (x.date + x.id).localeCompare(y.date + y.id));
  }

  // 結果の出ているレースについて、モデルの1着確率を計算して記録を作る（ブラウザでもNodeでも同じ）
  async function recordsForRaces(Engine, races, horses, trackOf, runs = 2500, betsOf, baseW){
    const out = [];
    for (const r of races){
      const res = r.result; if (!res || !r.entries?.length) continue;
      const fin = {}; (res.rows || []).forEach(x => fin[x.num] = x);
      const ents = r.entries.filter(e => !res.rows?.length || fin[e.num]).map(e => ({ ...e, odds: fin[e.num]?.odds > 1 ? fin[e.num].odds : e.odds, pop: fin[e.num]?.pop || e.pop }));
      if (ents.length < 2) continue;
      const race = { ...r, entries: ents, going: res.going || r.going || "良" };   // 発走時点で発表されていた馬場（結果の馬場）を使う
      const ctx = Engine.buildContext(race, horses, { going: race.going, track: trackOf ? trackOf(r) : null });
      const pf = Engine.paceForecast ? Engine.paceForecast(ctx) : { slow: 1 / 3, mid: 1 / 3, high: 1 / 3 };
      const win = new Float64Array(ctx.N); let tot = 0;
      for (const p of ["slow", "mid", "high"]){
        const w = pf[p]; if (w <= 0.001) continue;
        const m = await Engine.monteCarlo(ctx, runs, 7000 + out.length * 31, null, p);
        m.stats.forEach((s, i) => win[i] += w * s.win); tot += w;
      }
      const pm = Array.from(win, x => x / tot);
      out.push(record(race, ctx, pm, res, betsOf ? betsOf(r) : null, Engine.WEIGHTS, baseW || Engine.WEIGHTS));
    }
    return out;
  }

  // ===== 馬体重（増減）の効き：過去の全出走から推定 =====
  // オッズ（人気）で説明できる分を差し引いたうえで、馬体重の増減が「1着」「3着内」にどれだけ効くかをロジスティック回帰で推定。
  // 馬体重は発走前に発表されオッズにも織り込まれるので、ここで測るのは「オッズが見落としている分」だけ。
  // 偶然の偏りを反映しないよう、|z|<2 は0、それ以上も (1−(2/z)²) 倍に縮めて使う。
  // 増減の意味は「前走からの間隔」と「馬齢」で変わる（休み明けの増加は成長・仕上がり途上、若い馬の増加は成長など）ので、
  // その組み合わせも項目にする。「休み明け」「2〜3歳」単独は比較のための調整項目（予想への反映はしない）。
  const REST = 70;   // 休み明け＝前走から70日（10週）以上
  const BW_FEATS = [
    ["+10kg以上", (bw, d) => d != null && d >= 10], ["+4〜+9kg", (bw, d) => d != null && d >= 4 && d <= 9],
    ["−4〜−9kg", (bw, d) => d != null && d <= -4 && d >= -9], ["−10kg以下", (bw, d) => d != null && d <= -10],
    ["430kg未満", bw => bw < 430], ["520kg以上", bw => bw >= 520],
    ["増加×休み明け", (bw, d, rest) => d != null && d >= 4 && rest != null && rest >= REST], ["減少×休み明け", (bw, d, rest) => d != null && d <= -4 && rest != null && rest >= REST],
    ["増加×2〜3歳", (bw, d, rest, age) => d != null && d >= 4 && age != null && age <= 3], ["減少×2〜3歳", (bw, d, rest, age) => d != null && d <= -4 && age != null && age <= 3],
    ["休み明け（調整用）", (bw, d, rest) => rest != null && rest >= REST, true], ["2〜3歳（調整用）", (bw, d, rest, age) => age != null && age <= 3, true]];
  function bwFeatures(bw, d, rest, age){ return BW_FEATS.filter(([, fn]) => fn(bw, d, rest, age)).map(([k]) => k); }
  const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
  const birthYear = (h, hid) => { const m = /^(\d{4})\d{6}$/.exec(String(h.nkId || hid || "")); return m ? +m[1] : null; };
  function logit(F, y){
    const K = F[0].length; let b = new Array(K).fill(0), H = null;
    for (let it = 0; it < 30; it++){
      const g = new Array(K).fill(0); H = Array.from({ length: K }, () => new Array(K).fill(0));
      for (let n = 0; n < F.length; n++){
        const x = F[n]; let z = 0; for (let k = 0; k < K; k++) z += b[k] * x[k];
        const p = 1 / (1 + Math.exp(-z)), w = p * (1 - p);
        for (let k = 0; k < K; k++){ g[k] += (y[n] - p) * x[k]; for (let l = 0; l < K; l++) H[k][l] += w * x[k] * x[l]; }
      }
      for (let k = 0; k < K; k++) H[k][k] += 1e-6;
      const st = solve(H, g); b = b.map((v, k) => v + st[k]);
      if (Math.max(...st.map(Math.abs)) < 1e-8) break;
    }
    const inv = invert(H);
    return { b, se: inv.map((r, k) => Math.sqrt(Math.max(r[k], 0))) };
  }
  function solve(A, y){ const n = y.length, M = A.map((r, i) => [...r, y[i]]);
    for (let c = 0; c < n; c++){ let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) if (r !== c){ const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; } }
    return M.map((r, i) => r[n] / r[i]); }
  function invert(A){ const n = A.length; return A.map((_, j) => solve(A, A.map((__, i) => i === j ? 1 : 0))).map((col, j, cols) => cols.map(c => c[j])); }
  function bodyWeightEffects(horses){
    const seen = new Set(), F = [], yW = [], y3 = [];
    Object.entries(horses || {}).forEach(([hid, h]) => { const by = birthYear(h, hid);
      const runs = (h.runs || []).filter(r => r.date).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
      runs.forEach((r, i) => {
      const key = (h.name || hid) + "|" + (r.raceId || r.date + (r.race || "")); if (seen.has(key)) return; seen.add(key);   // 同じ馬が馬名とIDの両方で入っていても1回だけ数える
      const m = /(\d{3})\(([+-]?\d+)\)/.exec(r.bodyWeight || "");
      if (!m || !(r.odds > 1) || !(r.pos > 0)) return;
      const rest = i > 0 ? daysBetween(runs[i - 1].date, r.date) : null, age = by ? +String(r.date).slice(0, 4) - by : null;
      const fs = bwFeatures(+m[1], +m[2], rest, age);
      F.push([1, Math.log(r.odds), ...BW_FEATS.map(([k]) => fs.includes(k) ? 1 : 0)]); yW.push(r.pos === 1 ? 1 : 0); y3.push(r.pos <= 3 ? 1 : 0);
    }); });
    if (F.length < 300) return { n: F.length, win: {}, top3: {} };
    const out = { n: F.length, win: {}, top3: {} };
    [["win", yW], ["top3", y3]].forEach(([nm, y]) => {
      const { b, se } = logit(F, y);
      BW_FEATS.forEach(([k, , ctrl], j) => { const bb = b[2 + j], s = se[2 + j], z = s > 0 ? bb / s : 0, cnt = F.reduce((a, x) => a + x[2 + j], 0);
        // 件数30未満は推定が不安定なので反映しない。調整用の項目も反映しない
        out[nm][k] = { b: +bb.toFixed(3), se: +s.toFixed(3), z: +z.toFixed(2), n: cnt, control: !!ctrl, applied: +(!ctrl && cnt >= 30 && Math.abs(z) >= 2 ? bb * (1 - (2 / z) ** 2) : 0).toFixed(3) }; });
    });
    return out;
  }

  return { RV, bodyWeightEffects, bwFeatures, FEATS, record, fit, build, merge, bias, logloss, recordsForRaces, analyzeUpsets, upsetStats, paperStats };
})();
if (typeof module !== "undefined") module.exports = Learn;
