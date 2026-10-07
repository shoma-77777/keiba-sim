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
  const RV = 5;   // 5: 位置取りの材料（過去の通過順・距離の増減・同型の頭数）と実際の1角・4角の位置を記録   // 4: 穴パターンの候補を追加   // 記録の作り方の版（3: その日より前の出走歴だけでモデル確率を計算）
  const AB_MIN = 1.0;   // a+b の下限：統合後の確率がオッズより「平ら」（＝大穴を過大評価）にならないように
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // ===== 位置取りの材料（モデルの計算は不要。過去の通過順と結果の通過順だけから作る） =====
  const r3 = x => x == null || !isFinite(x) ? null : +x.toFixed(3);
  // 実際の位置：最初に記録された角（ふつう1角。2角しかないコースは3角）と最後の角（4角）。過去の通過順と同じ定義
  function cornerPos(res, last){ const o = {}; const C = res?.corners; if (C?.length){ const c = C[last ? C.length - 1 : 0]; c.forEach((num, k) => o[num] = r3(k / Math.max(1, c.length - 1))); } return o; }
  // レース前に分かる位置取りの材料（runs：その馬のこのレースより前の出走。新しい順）
  function preOf(runsIn, distance){
    const runs = runsIn.filter(x => x.surface !== "障");
    const pr = runs.filter(x => x.passing?.length && x.field > 4);
    const eo = x => (x.passing[0] - 1) / Math.max(1, x.field - 1), lo = x => (x.passing[x.passing.length - 1] - 1) / Math.max(1, x.field - 1);
    const avg = a => a.length ? a.reduce((p, q) => p + q, 0) / a.length : null;
    return { pp: [r3(avg(pr.map(eo))), pr[0] ? r3(eo(pr[0])) : null, r3(avg(pr.slice(0, 3).map(eo))), pr[0] ? r3(lo(pr[0])) : null, pr.length],
      dd: runs[0]?.dist > 0 && distance > 0 ? distance - runs[0].dist : null };
  }
  // 能力の内訳（レース前に分かる過去の成績）。ENG：Engine（クラスの表を使う）
  let ENG = null;
  const AB_NAMES = ["前走の着順（率）", "近3走の着順（率）", "近5走のベスト着順（率）", "前走の着差（秒）", "前走の人気", "前走の人気−着順（＋は人気より好走）", "前走からの日数", "出走数", "クラスの上下（＋は昇級）"];
  function abOf(runsIn, race){
    const runs = runsIn.filter(x => x.surface !== "障" && x.pos > 0 && x.field > 0);
    if (!runs.length) return null;
    const rate = x => (x.pos - 1) / Math.max(1, x.field - 1), avg = a => a.reduce((p, q) => p + q, 0) / a.length;
    const L = runs[0], GB = ENG?.GRADE_BASE || {}, cur = ENG?.gradeOf ? ENG.gradeOf(race.name || "") : null;
    const days = L.date && race.date ? Math.round((new Date(race.date) - new Date(L.date)) / 864e5) : null;
    return [r3(rate(L)), r3(avg(runs.slice(0, 3).map(rate))), r3(Math.min(...runs.slice(0, 5).map(rate))), L.margin != null && isFinite(L.margin) ? r3(Math.min(5, Math.max(0, L.margin))) : null,
      L.pop ?? null, L.pop != null ? L.pop - L.pos : null, days, runs.length, cur && GB[cur] != null && GB[L.grade] != null ? GB[cur] - GB[L.grade] : null];
  }
  // 前走の内容（オッズを使わない・過去の通過順と上がりから）：[出遅れ量, 4角からの伸び, 上がりの普段との差]
  //  出遅れ量＝前走の1角の位置 − それ以前の普段の1角の位置（＋は普段より後ろ＝出遅れ・不利の可能性）
  //  4角からの伸び＝(前走の4角の順位 − 着順)÷頭数（＋は直線で伸びた、−は失速）
  //  上がりの差＝前走の上がり3F − それ以前の同じ芝ダの上がりの平均（−は普段より速い）
  const CT_NAMES = ["前走の出遅れ量", "前走の4角からの伸び", "前走の上がりの普段との差"];
  function ctOf(runsIn){
    const runs = runsIn.filter(x => x.surface !== "障" && x.pos > 0 && x.field > 4);
    const L = runs[0]; if (!L) return null;
    const eo = x => (x.passing[0] - 1) / Math.max(1, x.field - 1);
    const P = runs.slice(1, 6).filter(x => x.passing?.length);
    const late = L.passing?.length && P.length ? eo(L) - P.reduce((a, x) => a + eo(x), 0) / P.length : null;
    const gain = L.passing?.length ? (L.passing[L.passing.length - 1] - L.pos) / L.field : null;
    const S = runs.slice(1, 6).filter(x => x.surface === L.surface && x.last3f > 0 && x.last3f < 45);
    const l3 = L.last3f > 0 && L.last3f < 45 && S.length ? Math.max(-3, Math.min(3, L.last3f - S.reduce((a, x) => a + x.last3f, 0) / S.length)) : null;
    // 道中の位置変化＝(1角の順位 − 4角の順位)÷頭数（＋は道中で押し上げた）
    const mid = L.passing?.length >= 2 ? (L.passing[0] - L.passing[L.passing.length - 1]) / L.field : null;
    return [r3(late), r3(gain), r3(l3), r3(mid)];
  }
  // 複勝の実際の払戻（100円あたりの倍率・外れは0）と単勝（確定オッズ）：前走の内容が「お金になるか」を確かめる用
  const plpOf = (res, num) => { const v = res?.pay?.["複勝"]?.[String(num)]; return v ? +(v / 100).toFixed(2) : 0; };
  function frontCounts(pres){ const w = pres.filter(p => p.pp[4] > 0); return { nf: w.filter(p => p.pp[0] < 0.35).length, nn: w.filter(p => p.pp[0] < 0.12).length }; }
  // 前の版で作った記録に、位置取りの材料だけを付け足す（モデルの確率はそのまま）。race：出馬表と結果、horses：出走馬の成績
  function posFill(rec, race, horses, Engine){
    if (!race?.entries?.length || !race.result) return false;
    const byNum = {}; race.entries.forEach(e => byNum[e.num] = e);
    const runsOf = num => { const h = horses[byNum[num]?.horseId]; return (h?.runs || []).map(Engine.parseRun).filter(r => r.pos > 0 && r.field > 0 && (!race.date || !r.date || r.date < race.date)).sort((a, b) => b.date.localeCompare(a.date)); };
    ENG = Engine;
    const RU = rec.h.map(h => runsOf(h.num));
    const pres = RU.map(runs => preOf(runs, race.distance));
    rec.h.forEach((h, i) => { h.ab = abOf(RU[i], race); h.ct = ctOf(RU[i]); });
    const cF = cornerPos(race.result, false), cL = cornerPos(race.result, true);
    rec.h.forEach((h, i) => { h.hid = byNum[h.num]?.name || byNum[h.num]?.horseId || null; h.pp = pres[i].pp; h.dd = pres[i].dd; h.c1 = cF[h.num] ?? null; h.c4 = cL[h.num] ?? null; h.plp = plpOf(race.result, h.num); });
    Object.assign(rec, frontCounts(pres)); rec.posFill = true;
    return true;
  }

  // 1レース分の記録を作る（pm: モデルの1着確率、ctx: buildContext の結果、res: 結果）
  // wcur: 記録時に効いていた要素の重み、wbase: 学習前の基準の重み（要素の値を基準の単位に直して記録する）
  function record(race, ctx, pm, res, bets, wcur, wbase, upto){
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
    const cFirst = cornerPos(res, false), cLast = cornerPos(res, true);
    const pres = ctx.field.map(f => preOf(f.prof?.runs || [], race.distance));
    const abs = ctx.field.map(f => abOf(f.prof?.runs || [], race)), cts = ctx.field.map(f => ctOf(f.prof?.runs || []));
    const { nf, nn } = frontCounts(pres);
    return {
      rv: RV, upto: upto || null, id: race.id, date: race.date, name: race.name || null, no: race.no || null, post: race.postTime || null, kai: race.kai || null, venue: race.venue, surface: race.surface, dist: race.distance, going: res.going || race.going || null, n: N, sens: +sens.toFixed(4), nf, nn,
      order: order.slice(0, 5),
      h: ctx.field.map((f, i) => ({
        num: f.num, hid: f.name || f.horseId || null, pm: +Math.max(pm[i], 1e-4).toFixed(5), pk: +(inv[i] / s).toFixed(5), odds: odds[i], pop: fin[f.num]?.pop ?? f.pop ?? null,
        pos: fin[f.num] ? +fin[f.num].pos : null, time: fin[f.num]?.time || null, l3f: fin[f.num]?.l3f || null,
        l3rank: fin[f.num]?.l3f ? l3.indexOf(fin[f.num].l3f) + 1 : null, early: early[f.num] ?? null,
        gate: +(((f.num - 1) / Math.max(1, N - 1))).toFixed(3), style: f.style, ana: f.ana || [],
        c1: cFirst[f.num] ?? null, c4: cLast[f.num] ?? null, pp: pres[i].pp, dd: pres[i].dd, ab: abs[i], ct: cts[i], plp: plpOf(res, f.num),
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
  // 確定オッズから見た「3着以内に入る確率」（Harville。人気薄の2・3着を少なめに見積もるくせは、全穴馬の比で割って打ち消す）
  function top3FromMarket(pk){
    const n = pk.length, out = new Array(n).fill(0);
    for (let i = 0; i < n; i++){ out[i] += pk[i];
      for (let j = 0; j < n; j++){ if (j === i) continue; const pj = pk[j], d1 = 1 - pj; if (d1 <= 0) continue; out[i] += pj * pk[i] / d1;
        for (let k = 0; k < n; k++){ if (k === i || k === j) continue; const d2 = 1 - pj - pk[k]; if (d2 <= 0) continue; out[i] += pj * pk[k] / d1 * pk[i] / d2; } } }
    return out;
  }
  // 穴馬（6番人気以下・15倍以上）について、各要因があったときに「オッズから見た期待」より何倍3着以内に来たか。
  // 人気（オッズ）の差でできる見かけの差は取り除き、オッズが見落としていた分だけを測る（お金になるのはこの分だけ）
  function upsetStats(recs){
    const cnt = {}; let base = 0, baseHit = 0, baseExp = 0;
    recs.forEach(r => {
      const H = r.h.filter(h => h.pos && h.pk > 0); if (H.length < 5) return;
      const s = H.reduce((a, h) => a + h.pk, 0), t3 = top3FromMarket(H.map(h => h.pk / s));
      H.forEach((h, i) => { if (!isLong(h)) return;
        base++; const hit = h.pos <= 3; if (hit) baseHit++; baseExp += t3[i];
        const keys = [];
        if (h.early != null && h.early <= 0.25) keys.push("展開:前に行った");
        if (h.early != null && h.early >= 0.55) keys.push("展開:後方待機");
        if (h.gate <= 0.2) keys.push("枠:内枠"); if (h.gate >= 0.8) keys.push("枠:外枠");
        if (r.going && r.going !== "良") keys.push("馬場:道悪");
        if (h.pm >= h.pk * 1.3) keys.push("モデル:市場より高評価");
        (h.ana || []).forEach(a => keys.push("穴パターン:" + a));
        keys.forEach(k => { const c = (cnt[k] ||= { n: 0, hit: 0, exp: 0 }); c.n++; if (hit) c.hit++; c.exp += t3[i]; });
      });
    });
    const p0 = base ? baseHit / base : 0, r0 = baseExp ? baseHit / baseExp : 1;
    return { longshots: base, top3Rate: +p0.toFixed(4), marketRatio: +r0.toFixed(3), factors: Object.entries(cnt).map(([k, c]) => {
      const e = c.exp * r0;                                   // くせを打ち消した期待数
      const lift = (c.hit + 2) / (e + 2);                     // 件数が少ないときは1に寄せる
      const z = e > 0 ? (c.hit - e) / Math.sqrt(e) : 0;
      return { k, n: c.n, hit: c.hit, exp: +e.toFixed(1), rate: +(c.hit / c.n).toFixed(4), lift: +lift.toFixed(3), z: +z.toFixed(2) };
    }).sort((a, b) => b.lift - a.lift) };
  }
  // 穴パターンの加点を、穴馬の3着内率のリフトから更新（件数が少ないうちは初期値のまま）
  const ANA_PTS = { "前走度外視": 0.8, "G1からの格下げ": 0.6, "実績の割に人気薄": 0.7, "距離短縮": 0.4, "叩き2戦目": 0.5, "鞍上強化": 0.4, "内枠の先行馬": 0.4, "コース巧者": 0.5,
    // 追加の候補（初期値0。オッズ以上に来ると分かったものだけ加点が育つ）
    "前走で追い込み届かず": 0, "先行力あり": 0, "単騎逃げ見込み": 0, "斤量3kg以上減": 0, "減量騎手": 0, "芝ダ替わり": 0,
    "道悪巧者×道悪": 0, "調教高評価の人気薄": 0, "直前に買われた": 0, "持ち時計上位": 0, "昇級2戦目": 0, "鉄砲駆け実績": 0 };
  function anaWeights(stats){
    const out = {};
    Object.entries(ANA_PTS).forEach(([k, pts]) => {
      const f = stats.factors.find(x => x.k === "穴パターン:" + k); if (!f) return;
      const t = f.n / (f.n + 300);                       // 300頭分で半分の重み（偶然の偏りに振り回されないように）
      // オッズ比のリフトから加点を決める（リフト2倍 ≒ +1.7Pt）。偶然と区別できない（|z|<1.5）ときは加点0の方向へ寄せる
      const learned = Math.abs(f.z ?? 0) >= 1.5 ? clamp(Math.log(Math.max(f.lift, 0.2)) * 2.5, -0.5, 2.5) : 0;
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
  // 1レース分の特徴（log p_model, log p_market, 要素の値）と上位3着の位置を一度だけ作っておく（学習の繰り返しを速くするため。結果は同じ）
  const PRE = new WeakMap();
  function prep(r){
    let p = PRE.get(r); if (p) return p;
    const H = r.h, n = H.length, D = 2 + FEATS.length, X = new Float64Array(n * D);
    H.forEach((h, i) => { X[i * D] = Math.log(h.pm); X[i * D + 1] = Math.log(h.pk); for (let k = 0; k < FEATS.length; k++) X[i * D + 2 + k] = h.z[k]; });
    const idx = [], seen = new Set();
    for (const num of r.order.slice(0, 3)){ const wi = H.findIndex(h => h.num === num); if (wi < 0 || seen.has(wi)) break; idx.push(wi); seen.add(wi); }
    p = { n, D, X, idx }; PRE.set(r, p); return p;
  }
  function nll(recs, th, grad){
    const K = FEATS.length; let L = 0;
    if (grad) grad.fill(0);
    for (const r of recs){
      if (r.h.length < 2 || !r.order?.length) continue;
      const { n, D, X, idx } = prep(r);
      const u = new Float64Array(n);
      for (let i = 0; i < n; i++){ let s = 0; for (let j = 0; j < D; j++) s += th[j] * X[i * D + j]; u[i] = s; }
      const used = new Uint8Array(n), e = new Float64Array(n);
      for (let st = 0; st < idx.length; st++){
        const wi = idx[st], lam = LAM[st];
        let mx = -1e9; for (let i = 0; i < n; i++) if (!used[i]) mx = Math.max(mx, lam * u[i]);
        let Z = 0; for (let i = 0; i < n; i++){ e[i] = used[i] ? 0 : Math.exp(lam * u[i] - mx); Z += e[i]; }
        L -= lam * u[wi] - mx - Math.log(Z);
        if (grad){
          for (let j = 0; j < D; j++) grad[j] -= lam * X[wi * D + j];
          for (let i = 0; i < n; i++) if (!used[i]){ const p = lam * e[i] / Z; for (let j = 0; j < D; j++) grad[j] += p * X[i * D + j]; }
        }
        used[wi] = 1;
      }
    }
    // 事前分布（データが少ないうちは事前の値に寄せる）
    const pr = [[th[0] - PRIOR.a, PRIOR.sa], [th[1] - PRIOR.b, PRIOR.sb]];
    pr.forEach(([d, s], j) => { L += d * d / (2 * s * s); if (grad) grad[j] += d / (s * s); });
    for (let k = 0; k < K; k++){ const d = th[2 + k]; L += d * d / (2 * PRIOR.sc ** 2); if (grad) grad[2 + k] += d / PRIOR.sc ** 2; }
    return L;
  }

  // 統合の比率 a, b と要素の補正 c を、上位3着の尤度が最大になるように推定する。
  // 目的関数は凸（Plackett–Luce＋正規分布の事前分布）なので、ニュートン法で数回の反復で最適解に着く（前の方法より約10倍速い）。
  // 制約（0≦a,b≦1.5、a+b≧1）に当たったときだけ、前と同じ方法（制約つきの勾配法）で仕上げる。
  function nllHess(recs, th, g, Hm){
    const K = FEATS.length, D = 2 + K; let L = 0;
    g.fill(0); Hm.fill(0);
    const mu = new Float64Array(D);
    for (const r of recs){
      if (r.h.length < 2 || !r.order?.length) continue;
      const { n, X, idx } = prep(r);
      const u = new Float64Array(n);
      for (let i = 0; i < n; i++){ let s2 = 0; for (let j = 0; j < D; j++) s2 += th[j] * X[i * D + j]; u[i] = s2; }
      const used = new Uint8Array(n), e = new Float64Array(n);
      for (let st = 0; st < idx.length; st++){
        const wi = idx[st], lam = LAM[st];
        let mx = -1e9; for (let i = 0; i < n; i++) if (!used[i]) mx = Math.max(mx, lam * u[i]);
        let Z = 0; for (let i = 0; i < n; i++){ e[i] = used[i] ? 0 : Math.exp(lam * u[i] - mx); Z += e[i]; }
        L -= lam * u[wi] - mx - Math.log(Z);
        mu.fill(0);
        for (let i = 0; i < n; i++) if (e[i] > 0){ const p = e[i] / Z; for (let j = 0; j < D; j++) mu[j] += p * X[i * D + j]; }
        for (let j = 0; j < D; j++) g[j] += lam * (mu[j] - X[wi * D + j]);
        const l2 = lam * lam;
        for (let i = 0; i < n; i++) if (e[i] > 0){ const p = e[i] / Z;
          for (let j = 0; j < D; j++){ const dj = X[i * D + j] - mu[j]; if (dj === 0) continue; const pj = l2 * p * dj; for (let k = j; k < D; k++) Hm[j * D + k] += pj * (X[i * D + k] - mu[k]); } }
        used[wi] = 1;
      }
    }
    const pr = [[th[0] - PRIOR.a, PRIOR.sa], [th[1] - PRIOR.b, PRIOR.sb]];
    pr.forEach(([d, s2], j) => { L += d * d / (2 * s2 * s2); g[j] += d / (s2 * s2); Hm[j * D + j] += 1 / (s2 * s2); });
    for (let k = 0; k < K; k++){ const d = th[2 + k]; L += d * d / (2 * PRIOR.sc ** 2); g[2 + k] += d / PRIOR.sc ** 2; Hm[(2 + k) * D + 2 + k] += 1 / PRIOR.sc ** 2; }
    for (let j = 0; j < D; j++) for (let k = 0; k < j; k++) Hm[j * D + k] = Hm[k * D + j];
    return L;
  }
  const feasible = th => th[0] >= 0 && th[0] <= 1.5 && th[1] >= 0 && th[1] <= 1.5 && th[0] + th[1] >= AB_MIN - 1e-9;
  function fitAdam(recs, th, iters){
    const K = FEATS.length;
    const g = new Float64Array(2 + K), m = new Float64Array(2 + K), v = new Float64Array(2 + K);
    const lr = 0.02;
    for (let t = 1; t <= iters; t++){
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
  function fit(recs){
    const K = FEATS.length, D = 2 + K, th = new Float64Array(D); th[0] = PRIOR.a; th[1] = PRIOR.b;
    const g = new Float64Array(D), Hm = new Float64Array(D * D), tmp = new Float64Array(D);
    let L = nllHess(recs, th, g, Hm);
    for (let it = 0; it < 40; it++){
      const H2 = Array.from({ length: D }, (_, j) => Array.from(Hm.subarray(j * D, j * D + D)));
      const step = solve(H2, Array.from(g, x => -x));
      if (!step.every(isFinite)) break;
      let t = 1, ok = false;
      for (let ls = 0; ls < 20; ls++){
        for (let j = 0; j < D; j++) tmp[j] = th[j] + t * step[j];
        const L2 = nll(recs, tmp, null);
        if (L2 <= L + 1e-10){ ok = true; break; } t /= 2;
      }
      if (!ok) break;
      th.set(tmp);
      const mx = Math.max(...step.map(Math.abs)) * t;
      L = nllHess(recs, th, g, Hm);
      if (mx < 1e-7) break;
    }
    if (!feasible(th)){
      // 制約に当たるとき：制約の内側へ戻してから、前と同じ方法で仕上げる
      th[0] = clamp(th[0], 0, 1.5); th[1] = clamp(th[1], 0, 1.5);
      if (th[0] + th[1] < AB_MIN){ const d = (AB_MIN - th[0] - th[1]) / 2; th[0] += d; th[1] += d; }
      fitAdam(recs, th, 400);
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
  // light：過去データの日ごとのモデル用（予想に要る統合の比率・要素の重み・穴パターンの加点だけ作る）
  function build(recs, today, opt = {}){
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
    const us = upsetStats(recs);
    const base = { version: 2, updated: new Date().toISOString(), races: recs.length, upto: recs.reduce((m, r) => r.date > m ? r.date : m, "0000-00-00"),
      calib: { a: +a.toFixed(3), b: +b.toFixed(3) }, weights, featCoef: Object.fromEntries(FEATS.map((k, j) => [k, +th[2 + j].toFixed(4)])), sens: +sens.toFixed(3), anaWeights: anaWeights(us) };
    if (opt.light) return { ...base, light: true };
    const byDate = {};
    recs.forEach(r => (byDate[r.date] ||= []).push(r));
    const hist = Object.keys(byDate).sort().map(d => ({ date: d, races: byDate[d].length,
      model: +logloss(byDate[d], h => h.pm).toFixed(3), market: +logloss(byDate[d], h => h.pk).toFixed(3),
      blend: +logloss(byDate[d], h => Math.pow(h.pm, a) * Math.pow(h.pk, b)).toFixed(3) }));
    return { ...base,
      metrics: { model: logloss(recs, h => h.pm), market: logloss(recs, h => h.pk), blend: logloss(recs, h => Math.pow(h.pm, a) * Math.pow(h.pk, b)) },
      hist, bias: bias(recs, today || new Date().toISOString().slice(0, 10)),
      upsets: recs.slice(-400).flatMap(analyzeUpsets).slice(-60), upsetStats: { ...us, factors: us.factors.slice(0, 16) },
      paper: paperStats(recs), indep: (() => { try { return indBuild(recs); } catch (e) { return null; } })() };
  }

  function merge(oldRecs, newRecs){
    const m = new Map((oldRecs || []).map(r => [r.id, r])); (newRecs || []).forEach(r => { const o = m.get(r.id); m.set(r.id, o && !r.bets && o.bets ? { ...r, bets: o.bets } : r); });
    return [...m.values()].sort((x, y) => (x.date + x.id).localeCompare(y.date + y.id));
  }

  // 結果の出ているレースについて、モデルの1着確率を計算して記録を作る（ブラウザでもNodeでも同じ）
  async function recordsForRaces(Engine, races, horses, trackOf, runs = 2500, betsOf, baseW, upto){
    const out = []; ENG = Engine;
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
      out.push(record(race, ctx, pm, res, betsOf ? betsOf(r) : null, Engine.WEIGHTS, baseW || Engine.WEIGHTS, upto));
    }
    return out;
  }



  // ===== 検証レポート：今のAIが「どこまで穴馬を見抜けているか」を、未来の情報を使わずに測る =====
  // 時系列のウォークフォワード：最初の4割の期間を学習の土台にし、残りを5つの期間に分けて、
  // 各期間は「それより前の記録だけ」で統合の比率（a, b）を学習してから成績を測る（どの期間も未来の情報なし）。
  // 単勝は確定オッズ＝実際の払戻なので、単勝の回収率は正確。複勝は記録に払戻がないため率だけを見る。
  // 記録そのもの（モデルの確率）が「そのレースより前の記録だけで学習したモデル」で作られたか（clean）も確かめる。
  const clean = r => !!r.upto && r.upto < r.date;
  const BANDS = ["1〜3番人気", "4〜7番人気", "8〜12番人気", "13番人気以下"];
  const bandOf = p => p <= 3 ? BANDS[0] : p <= 7 ? BANDS[1] : p <= 12 ? BANDS[2] : BANDS[3];
  const EV_T = [0, 0.8, 0.9, 1.0, 1.05, 1.1, 1.2, 1.3];
  const CAL_B = [0, 0.02, 0.05, 0.1, 0.2, 0.35, 1.01], EV_B = [0, 0.6, 0.8, 1.0, 1.1, 1.3, 1.6, 99];
  const zc = () => ({ n: 0, win: 0, top3: 0, ret: 0 });
  function newAcc(){
    const T = {}; BANDS.forEach(k => T[k] = { all: zc(), rec: zc(), mark: zc() });
    const bins = B => B.slice(0, -1).map((lo, i) => ({ lo, hi: B[i + 1], n: 0, p: 0, pm: 0, pk: 0, win: 0, ret: 0 }));
    return { T, cal: bins(CAL_B), calM: bins(CAL_B), evs: bins(EV_B), thr: EV_T.map(t => ({ t, n: 0, win: 0, ret: 0, ret2: 0, odds: 0 })),
      cap: { 4: [], 10: [] }, ll: { n: 0, blend: 0, market: 0, model: 0, d: [] }, races: 0 };
  }
  function evalRace(r, a, b, A){
    const H = r.h.filter(h => h.pos != null && h.odds > 1); if (H.length < 5) return;
    A.races++;
    const sk = H.reduce((x, h) => x + h.pk, 0), sm = H.reduce((x, h) => x + Math.max(h.pm, 1e-5), 0);
    const PK = H.map(h => h.pk / sk), PM = H.map(h => Math.max(h.pm, 1e-5) / sm);
    const q = H.map((h, i) => Math.pow(PM[i], a) * Math.pow(PK[i], b)); const sq = q.reduce((x, y) => x + y, 0);
    const P = q.map(x => x / sq);
    const top = P.indexOf(Math.max(...P));     // 統合確率の1位＝本命
    const wi = H.findIndex(h => h.pos === 1);
    if (wi >= 0){ const lb = -Math.log(P[wi]), lk = -Math.log(PK[wi]); A.ll.n++; A.ll.blend += lb; A.ll.market += lk; A.ll.model += -Math.log(PM[wi]); A.ll.d.push(lk - lb); }
    const bin = (B, v) => B.find(x => v >= x.lo && v < x.hi);
    H.forEach((h, i) => {
      const B = A.T[bandOf(h.pop || 99)], hit3 = h.pos <= 3, w = h.pos === 1, ev = P[i] * h.odds;
      const add = o => { o.n++; if (w){ o.win++; o.ret += h.odds; } if (hit3) o.top3++; };
      add(B.all); if (ev >= 1.1 && P[i] >= 0.02) add(B.rec); if (i === top) add(B.mark);
      const c = bin(A.cal, P[i]); if (c){ c.n++; c.p += P[i]; c.pm += PM[i]; c.pk += PK[i]; if (w) c.win++; }
      const cm = bin(A.calM, PM[i]); if (cm){ cm.n++; cm.pm += PM[i]; cm.pk += PK[i]; if (w) cm.win++; }
      const e = bin(A.evs, ev); if (e){ e.n++; if (w){ e.win++; e.ret += h.odds; } }
      A.thr.forEach(t => { if (ev >= t.t){ t.n++; t.odds += h.odds; if (w){ t.win++; t.ret += h.odds; t.ret2 += h.odds * h.odds; } } });
    });
    // 穴ランキング：その人気以下の馬を「モデル÷オッズ」（市場より何倍高く評価しているか）で並べる
    [4, 10].forEach(minPop => {
      const G = H.map((h, i) => ({ h, s: PM[i] / Math.max(PK[i], 1e-6), m: PK[i] })).filter(x => (x.h.pop || 99) >= minPop);
      const L = G.slice().sort((x, y) => y.s - x.s), M = G.slice().sort((x, y) => y.m - x.m);   // AIの穴ランキング／オッズ順（人気順）
      L.forEach((x, k) => { if (x.h.pos <= 3) A.cap[minPop].push({ rank: k + 1, mrank: M.indexOf(x) + 1, of: L.length, pop: x.h.pop }); });
    });
  }
  // 偶然との区別：でたらめに並べたときの期待値と分散から z を出す（|z|≧2 でおおむね5%水準）。
  // 同じレースで2頭以上来たときの順位の重なりは無視しているので、z はやや控えめ（実際より小さめ）に出る。
  function capStat(arr){
    if (!arr.length) return null;
    const n = arr.length;
    const at = [3, 5, 10, 20].map(k => { const hit = arr.filter(x => x.rank <= k).length; let E = 0, V = 0;
      arr.forEach(x => { const p = Math.min(1, k / x.of); E += p; V += p * (1 - p); });
      // オッズ順（人気順）に並べた場合との比較：AIだけが上位k頭に入れていた穴馬（aw）と、オッズ順だけが入れていた穴馬（mw）の差（マクネマー検定）
      const mk = arr.filter(x => x.mrank <= k).length, aw = arr.filter(x => x.rank <= k && x.mrank > k).length, mw = arr.filter(x => x.rank > k && x.mrank <= k).length;
      return { k, hit, rate: +(hit / n).toFixed(3), random: +(E / n).toFixed(3), z: V > 1e-9 ? +((hit - E) / Math.sqrt(V)).toFixed(2) : null,
        market: +(mk / n).toFixed(3), aw, mw, zMk: aw + mw ? +((aw - mw) / Math.sqrt(aw + mw)).toFixed(2) : null }; });
    const S = arr.reduce((s, x) => s + x.rank, 0), ES = arr.reduce((s, x) => s + (x.of + 1) / 2, 0), VS = arr.reduce((s, x) => s + (x.of * x.of - 1) / 12, 0);
    return { n, meanRank: +(S / n).toFixed(2), meanRandom: +(ES / n).toFixed(2), meanMarket: +(arr.reduce((s, x) => s + x.mrank, 0) / n).toFixed(2), meanOf: +(arr.reduce((s, x) => s + x.of, 0) / n).toFixed(1),
      zRank: VS > 0 ? +((ES - S) / Math.sqrt(VS)).toFixed(2) : null, at };
  }
  function finAcc(A){
    const fin = o => ({ n: o.n, winRate: o.n ? +(o.win / o.n).toFixed(4) : null, top3Rate: o.n ? +(o.top3 / o.n).toFixed(4) : null, winROI: o.n ? +(o.ret / o.n).toFixed(3) : null });
    const d = A.ll.d, md = d.length ? d.reduce((x, y) => x + y, 0) / d.length : 0, sd = d.length > 1 ? Math.sqrt(d.reduce((x, y) => x + (y - md) ** 2, 0) / (d.length - 1)) : 0;
    return {
      races: A.races,
      ll: A.ll.n ? { n: A.ll.n, blend: +(A.ll.blend / A.ll.n).toFixed(4), market: +(A.ll.market / A.ll.n).toFixed(4), model: +(A.ll.model / A.ll.n).toFixed(4),
        gain: +md.toFixed(4), z: sd > 0 ? +(md / (sd / Math.sqrt(d.length))).toFixed(2) : null } : null,
      bands: BANDS.map(k => ({ band: k, all: fin(A.T[k].all), rec: fin(A.T[k].rec), mark: fin(A.T[k].mark) })),
      calibration: A.cal.filter(c => c.n).map(c => ({ range: `${Math.round(c.lo * 100)}〜${Math.round(Math.min(c.hi, 1) * 100)}%`, n: c.n, pred: +(c.p / c.n).toFixed(4), model: +(c.pm / c.n).toFixed(4), market: +(c.pk / c.n).toFixed(4), actual: +(c.win / c.n).toFixed(4) })),
      calibrationModel: A.calM.filter(c => c.n).map(c => ({ range: `${Math.round(c.lo * 100)}〜${Math.round(Math.min(c.hi, 1) * 100)}%`, n: c.n, pred: +(c.pm / c.n).toFixed(4), market: +(c.pk / c.n).toFixed(4), actual: +(c.win / c.n).toFixed(4) })),
      ev: A.evs.filter(e => e.n).map(e => ({ range: `${e.lo}〜${e.hi >= 99 ? "" : e.hi}`, n: e.n, winRate: +(e.win / e.n).toFixed(4), roi: +(e.ret / e.n).toFixed(3) })),
      // 期待値の閾値の感度：「期待値が t 以上の単勝を全部100円ずつ買った」場合（95%の範囲つき）
      thresholds: A.thr.map(t => { if (!t.n) return { t: t.t, n: 0 }; const m = t.ret / t.n, v = Math.max(0, t.ret2 / t.n - m * m), se = Math.sqrt(v / t.n);
        return { t: t.t, n: t.n, winRate: +(t.win / t.n).toFixed(4), avgOdds: +(t.odds / t.n).toFixed(1), roi: +m.toFixed(3), lo95: +Math.max(0, m - 1.96 * se).toFixed(3), hi95: +(m + 1.96 * se).toFixed(3) }; }),
      capture: { pop4: capStat(A.cap[4]), pop10: capStat(A.cap[10]) }
    };
  }
  // 穴馬（lo〜hi番人気）について、各要素が「プラス評価（そのレースの出走馬の平均より上）」だった割合を、来た馬と来なかった馬で比べる。
  // 人気の差でできる見かけの差を除くため、オッズから見た3着以内の期待数（Harville）に対して何倍来たか（倍率）と z も出す。
  // 50項目ほどを同時に調べるので、偶然でも |z|≧2 が2〜3個は出る。前半・後半の両方で同じ向きか、|z|≧3.3（多重比較の補正）を目安にする。
  function factorStats(R, lo, hi){
    const rows = [];
    R.forEach(r => {
      const H = r.h.filter(h => h.pos && h.pk > 0 && h.z); if (H.length < 5) return;
      const s = H.reduce((a, h) => a + h.pk, 0), sm = H.reduce((a, h) => a + Math.max(h.pm, 1e-5), 0), t3 = top3FromMarket(H.map(h => h.pk / s));
      const mean = FEATS.map((_, j) => H.reduce((a, h) => a + (h.z[j] || 0), 0) / H.length);
      H.forEach((h, i) => {
        const pop = h.pop || 99; if (pop < lo || pop > hi) return;
        const dev = FEATS.map((_, j) => (h.z[j] || 0) - mean[j]);
        const keys = [];
        FEATS.forEach((k, j) => { if (dev[j] > 0.001) keys.push("要素:" + k); });
        (h.ana || []).forEach(a => keys.push("穴パターン:" + a));
        if (h.style) keys.push("脚質（予想）:" + h.style);
        if (h.gate <= 0.2) keys.push("枠:内枠"); if (h.gate >= 0.8) keys.push("枠:外枠");
        if (Math.max(h.pm, 1e-5) / sm >= h.pk / s * 1.3) keys.push("モデル:市場の1.3倍以上の評価");
        if (r.going && r.going !== "良") keys.push("馬場:稍重〜不良");
        if (h.early != null && h.early <= 0.25) keys.push("結果:前に行った（レース前には使えない）");
        if (h.early != null && h.early >= 0.55) keys.push("結果:後方から（レース前には使えない）");
        // モデルの点数で一番足を引っ張った要素（＝AIが低く評価した主な理由）
        let worst = null, wv = 0; dev.forEach((v, j) => { if (v < wv){ wv = v; worst = FEATS[j]; } });
        rows.push({ date: r.date, hit: h.pos <= 3, e: t3[i], keys, worst, under: Math.max(h.pm, 1e-5) / sm < h.pk / s });
      });
    });
    if (rows.length < 50) return null;
    const dates = rows.map(x => x.date).sort(), mid = dates[Math.floor(dates.length / 2)];
    const hits = rows.filter(x => x.hit), non = rows.filter(x => !x.hit);
    const ratio = sub => { const h = sub.filter(x => x.hit).length, e = sub.reduce((a, x) => a + x.e, 0); return e > 0 ? h / e : 1; };
    const r0 = ratio(rows), r1 = ratio(rows.filter(x => x.date < mid)), r2 = ratio(rows.filter(x => x.date >= mid));
    const all = {}; rows.forEach(x => x.keys.forEach(k => (all[k] ||= []).push(x)));
    const items = Object.entries(all).map(([k, xs]) => {
      const hit = xs.filter(x => x.hit).length, exp = xs.reduce((a, x) => a + x.e, 0) * r0, v = xs.reduce((a, x) => a + x.e * r0 * (1 - Math.min(0.99, x.e * r0)), 0);
      const half = (sub, rr) => { const h = sub.filter(x => x.hit).length, e = sub.reduce((a, x) => a + x.e, 0) * rr; return e > 0 ? +(h / e).toFixed(2) : null; };
      const l1 = half(xs.filter(x => x.date < mid), r1), l2 = half(xs.filter(x => x.date >= mid), r2);
      const z = v > 0 ? (hit - exp) / Math.sqrt(v) : 0;
      const same = l1 != null && l2 != null && ((l1 > 1 && l2 > 1) || (l1 < 1 && l2 < 1));
      return { k, n: xs.length, hit, inHit: +(hit / Math.max(1, hits.length)).toFixed(3), inNon: +((xs.length - hit) / Math.max(1, non.length)).toFixed(3),
        lift: +((hit + 1) / (exp + 1)).toFixed(2), z: +z.toFixed(2), h1: l1, h2: l2,
        verdict: Math.abs(z) >= 3.3 && same ? "偶然でない可能性が高い" : Math.abs(z) >= 2 && same ? "候補（データを増やして要確認）" : "偶然と区別できない" };
    }).filter(x => x.n >= 20).sort((a, b) => b.z - a.z);
    const reasons = {}; rows.forEach(x => { if (!x.worst) return; const o = (reasons[x.worst] ||= { hit: 0, non: 0 }); x.hit ? o.hit++ : o.non++; });
    return { lo, hi, n: rows.length, hits: hits.length, top3Rate: +(hits.length / rows.length).toFixed(4), marketRatio: +r0.toFixed(3), mid,
      underHit: +(hits.filter(x => x.under).length / Math.max(1, hits.length)).toFixed(3), underNon: +(non.filter(x => x.under).length / Math.max(1, non.length)).toFixed(3),
      reasons: Object.entries(reasons).map(([k, o]) => ({ k, hit: o.hit, hitShare: +(o.hit / Math.max(1, hits.length)).toFixed(3), nonShare: +(o.non / Math.max(1, non.length)).toFixed(3) })).sort((a, b) => b.hit - a.hit),
      items };
  }
  // ===== 位置取り（脚質）の検証：「前に行く穴馬」をレース前に当てられるか、それはオッズ以上に来るか =====
  // 実際の位置は結果なので予想には使えない。使えるのは、レース前の材料から「前に行く」と予想できた分だけ。
  const STYLE4 = ["逃げ", "先行", "差し", "追込"];
  const posClass = x => x == null ? null : x <= 0.001 ? "逃げ" : x < 0.35 ? "先行" : x < 0.68 ? "差し" : "追込";
  function aucOf(sc, y){
    const idx = sc.map((s, i) => [s, y[i]]).sort((a, b) => a[0] - b[0]);
    let r = 0, k = 0, np = 0, nn = 0;
    while (k < idx.length){ let j = k; while (j < idx.length && idx[j][0] === idx[k][0]) j++; const avgRank = (k + j + 1) / 2;
      for (let t = k; t < j; t++){ if (idx[t][1]){ r += avgRank; np++; } else nn++; } k = j; }
    return np && nn ? (r - np * (np + 1) / 2) / (np * nn) : null;
  }
  // 人気薄の行（1頭ずつ）：3着内の実績と、オッズから見た3着内の期待（Harville）
  function posRows(R){
    const out = [];
    R.forEach(r => {
      const H = r.h.filter(h => h.pos && h.pk > 0); if (H.length < 5) return;
      const s = H.reduce((a, h) => a + h.pk, 0), t3 = top3FromMarket(H.map(h => h.pk / s)), smm = H.reduce((a, h) => a + Math.max(h.pm, 1e-5), 0);
      const eps = H.map(h => h.pp?.[4] > 0 ? h.pp[0] : null), withEp = eps.filter(x => x != null).sort((a, b) => a - b);
      H.forEach((h, i) => {
        const ep = eps[i];
        const rel = ep != null && withEp.length > 1 ? withEp.indexOf(ep) / (withEp.length - 1) : null;   // このメンバーの中で、普段どれだけ前に行く馬か（0＝一番前）
        out.push({ date: r.date, pop: h.pop || 99, hit: h.pos <= 3, e: t3[i], style: h.style, early: h.early, c1: h.c1, has: h.pp?.[4] > 0, pp: h.pp, dd: h.dd, gate: h.gate,
          nf: r.nf, nn: r.nn, N: H.length, wet: r.going && r.going !== "良" ? 1 : 0, rel, ab: h.ab || null, odds: h.odds, win: h.pos === 1,
          under: Math.max(h.pm, 1e-5) / smm < h.pk / s });
      });
    });
    return out;
  }
  const posX = x => [x.pp[0], x.pp[1] ?? x.pp[0], x.pp[2] ?? x.pp[0], x.pp[3] ?? x.pp[0], x.rel ?? 0.5, x.gate, Math.max(-2, Math.min(2, (x.dd || 0) / 400)), (x.nf || 0) / x.N, x.nn || 0, x.wet, Math.min(5, x.pp[4]) / 5];
  const POS_NAMES = ["普段の1角の位置（平均）", "前走の1角の位置", "近3走の1角の位置", "前走の4角の位置", "メンバー内で普段どれだけ前か", "枠（内0〜外1）", "距離の増減", "先行馬の割合", "逃げ馬の頭数", "道悪", "通過順のある出走数"];
  // オッズの期待に対する倍率（期間ごとのくせ r0 で割る）
  const liftOf = (sub, r0) => { const hit = sub.filter(x => x.hit).length, e = sub.reduce((a, x) => a + x.e, 0) * r0, v = sub.reduce((a, x) => a + x.e * r0 * (1 - Math.min(0.99, x.e * r0)), 0);
    return { n: sub.length, hit, exp: +e.toFixed(1), lift: +((hit + 1) / (e + 1)).toFixed(2), z: v > 0 ? +((hit - e) / Math.sqrt(v)).toFixed(2) : null }; };
  const r0Of = sub => { const h = sub.filter(x => x.hit).length, e = sub.reduce((a, x) => a + x.e, 0); return e > 0 ? h / e : 1; };
  function positionReport(R, ranges, lo = 10){
    const rows = posRows(R);
    const L = rows.filter(x => x.pop >= lo);
    const inR = (x, g) => x.date >= g.from && x.date <= g.to;
    const verdict = (all, per) => { const ls = per.filter(p => p && p.n >= 15).map(p => p.lift); const same = ls.length >= 3 && (ls.every(v => v > 1) || ls.every(v => v < 1));
      return all.z != null && Math.abs(all.z) >= 2 && same ? "全期間で同じ向き・偶然でない" : all.z != null && Math.abs(all.z) >= 2 ? "偶然でないが期間で向きがばらつく" : "偶然と区別できない"; };
    const byFold = (pred) => ranges.map(g => { const F = L.filter(x => inR(x, g)); const S = F.filter(pred); return S.length ? liftOf(S, r0Of(F)) : null; });
    const testL = L.filter(x => ranges.some(g => inR(x, g)));
    const r0T = r0Of(testL);
    const row = (label, pred, note) => { const S = testL.filter(pred), all = liftOf(S, r0T), per = byFold(pred); return { label, note: note || "", ...all, per: per.map(p => p ? p.lift : null), verdict: verdict(all, per) }; };
    // ① 予想した脚質と実際の位置（1角）の一致
    const conf = (sub) => { const m = {}; STYLE4.forEach(a => { m[a] = {}; STYLE4.forEach(b => m[a][b] = 0); });
      let n = 0, ok = 0; sub.forEach(x => { const a = x.style, b = posClass(x.c1 ?? x.early ?? null); if (!m[a] || !b) return; m[a][b]++; n++; if (a === b) ok++; });
      return n ? { n, agree: +(ok / n).toFixed(3), m } : null; };
    // 1角の位置がある記録（新しい版）はそれで、ない記録（前の版）は2角付近の位置で比べる。新しい版では出走歴のない馬（脚質の根拠なし）は除く
    const anyC1 = rows.some(x => x.c1 != null);
    const allWith = anyC1 ? rows.filter(x => x.has && x.c1 != null) : rows.filter(x => x.early != null);
    // ③ 予想した脚質ごとの人気薄の成績（全期間・期間別）。予想脚質は前の版の記録にもあるので今すぐ出せる
    const byStyle = STYLE4.map(st => row("予想脚質:" + st, x => x.style === st));
    // ⑥⑦ 実際に前に行った人気薄（結果。予想には使えない）の期間別
    const actualFront = [row("結果:前に行った（2角付近で前1/4）", x => x.early != null && x.early <= 0.25, "結果なので予想には使えない"),
      row("結果:1角で前1/4", x => x.c1 != null && x.c1 <= 0.25, "結果なので予想には使えない")];
    // ⑤ 単独の材料（区切りごと）。材料がそろった記録だけ
    const P = testL.filter(x => x.has);
    const single = P.length >= 300 ? [
      row("前走の1角：前1/4", x => x.pp[1] != null && x.pp[1] <= 0.25), row("前走の1角：後ろ半分", x => x.pp[1] != null && x.pp[1] >= 0.5),
      row("前走の4角：前1/4", x => x.pp[3] != null && x.pp[3] <= 0.25),
      row("メンバー内で一番前に行く馬", x => x.rel === 0), row("メンバー内で前1/4", x => x.rel != null && x.rel <= 0.25),
      row("距離短縮（200m以上）", x => x.dd != null && x.dd <= -200), row("距離延長（200m以上）", x => x.dd != null && x.dd >= 200),
      row("先行馬が少ない（2割未満）", x => x.has && x.nf / x.N < 0.2), row("先行馬が多い（4割以上）", x => x.has && x.nf / x.N >= 0.4),
      row("逃げ馬がいない", x => x.has && x.nn === 0),
      row("内枠（前2割）×普段前1/3", x => x.gate <= 0.2 && x.pp[0] < 0.35), row("前走後ろ半分→普段は前1/3（脚質が戻る）", x => x.pp[1] != null && x.pp[1] >= 0.5 && x.pp[0] < 0.35),
      row("道悪×普段前1/3", x => x.wet && x.pp[0] < 0.35)
    ].filter(x => x.n >= 20) : null;
    // ④⑤ 組み合わせ：「前に行くか」を材料から学習（ウォークフォワード）→ 前に行くと予想した人気薄はオッズ以上に来るか
    let model = null;
    const D = rows.filter(x => x.has && x.c1 != null);
    if (D.length >= 3000){
      const pred = new Map(); const aucs = [];
      ranges.forEach(g => {
        const tr = D.filter(x => x.date < g.from), te = D.filter(x => inR(x, g)); if (tr.length < 1500 || !te.length) return;
        const m = lsLogit(tr.map(posX), tr.map(() => 0), tr.map(x => x.c1 <= 0.25 ? 1 : 0), 10);
        const ps = te.map(x => lsPredRow(m, posX(x), 0)); te.forEach((x, i) => pred.set(x, ps[i]));
        aucs.push({ from: g.from, to: g.to, n: te.length, auc: +aucOf(ps, te.map(x => x.c1 <= 0.25 ? 1 : 0)).toFixed(3), base: +aucOf(te.map(x => -x.pp[0]), te.map(x => x.c1 <= 0.25 ? 1 : 0)).toFixed(3) });
      });
      if (aucs.length){
        const tested = D.filter(x => pred.has(x)), y = tested.map(x => x.c1 <= 0.25 ? 1 : 0);
        const lastM = lsLogit(D.map(posX), D.map(() => 0), D.map(x => x.c1 <= 0.25 ? 1 : 0), 10);
        const pf = x => pred.get(x);
        const has = x => pred.has(x);
        model = { n: tested.length, auc: +aucOf(tested.map(pf), y).toFixed(3), base: +aucOf(tested.map(x => -x.pp[0]), y).toFixed(3), folds: aucs,
          coef: POS_NAMES.map((k, j) => [k, +lastM.b[j + 1].toFixed(2)]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])),
          bins: [[0, 0.15], [0.15, 0.3], [0.3, 0.5], [0.5, 1.01]].map(([a, b]) => { const pr = x => has(x) && x.pop >= lo && pf(x) >= a && pf(x) < b; const S = D.filter(pr);
            return { ...row(`前に行く確率 ${Math.round(a * 100)}〜${Math.round(Math.min(b, 1) * 100)}%`, x => x.has && x.c1 != null && pr(x)), front: S.length ? +(S.filter(x => x.c1 <= 0.25).length / S.length).toFixed(3) : null }; }),
          advance: row("前走は後ろ半分だったが、今回は前に行く確率30%以上", x => x.has && x.c1 != null && has(x) && x.pop >= lo && x.pp[1] != null && x.pp[1] >= 0.5 && pf(x) >= 0.3) };
      }
    }
    return { lo, confBasis: anyC1 ? "1角" : "2角付近（前の版の記録）", nAll: L.length, nPP: P.length, recsPP: R.filter(r => r.h.some(h => h.pp)).length,
      confAll: conf(allWith), confHit: conf(allWith.filter(x => x.pop >= lo && x.hit)), confLong: conf(allWith.filter(x => x.pop >= lo)),
      byStyle, actualFront, single, model, periods: ranges.map(g => `${g.from}〜${g.to}`) };
  }

  // ===== モデルの鋭さ（仮想モデル・予想には使わない）：モデルの確率を p^T で平らにしたら、大穴の過小評価は直るか／オッズに追いつくか =====
  function temperReport(R, ranges){
    const prepT = r => { const H = r.h.filter(h => h.pos != null && h.odds > 1); if (H.length < 5) return null; const w = H.findIndex(h => h.pos === 1); if (w < 0) return null;
      const sk = H.reduce((a, h) => a + h.pk, 0), sm = H.reduce((a, h) => a + Math.max(h.pm, 1e-5), 0); return { date: r.date, LM: H.map(h => Math.log(Math.max(h.pm, 1e-5) / sm)), PK: H.map(h => h.pk / sk), w }; };
    const P = R.map(prepT).filter(Boolean);
    const llT = (xs, T) => { let L = 0; xs.forEach(x => { const q = x.LM.map(l => Math.exp(T * l)); const s = q.reduce((a, b) => a + b, 0); L -= Math.log(q[x.w] / s); }); return L / xs.length; };
    const fitT = xs => { let lo = 0.1, hi = 2; for (let k = 0; k < 40; k++){ const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (llT(xs, m1) < llT(xs, m2)) hi = m2; else lo = m1; } return (lo + hi) / 2; };
    const B = CAL_B.slice(0, -1).map((lo, i) => ({ lo, hi: CAL_B[i + 1], n: 0, p: 0, w: 0 }));
    const folds = []; let n = 0, lm = 0, lt = 0, lk = 0;
    ranges.forEach(g => {
      const tr = P.filter(x => x.date < g.from), te = P.filter(x => x.date >= g.from && x.date <= g.to); if (tr.length < 50 || !te.length) return;
      const T = fitT(tr), a = llT(te, 1), t = llT(te, T), k = te.reduce((s, x) => s - Math.log(x.PK[x.w]), 0) / te.length;
      folds.push({ from: g.from, T: +T.toFixed(2), model: +a.toFixed(4), tempered: +t.toFixed(4), market: +k.toFixed(4) });
      n += te.length; lm += a * te.length; lt += t * te.length; lk += k * te.length;
      te.forEach(x => { const q = x.LM.map(l => Math.exp(T * l)); const s = q.reduce((a2, b2) => a2 + b2, 0); q.forEach((v, i) => { const p = v / s, b = B.find(b => p >= b.lo && p < b.hi); if (b){ b.n++; b.p += p; if (i === x.w) b.w++; } }); });
    });
    if (!n) return null;
    return { folds, model: +(lm / n).toFixed(4), tempered: +(lt / n).toFixed(4), market: +(lk / n).toFixed(4),
      calib: B.filter(b => b.n).map(b => ({ range: `${Math.round(b.lo * 100)}〜${Math.round(Math.min(b.hi, 1) * 100)}%`, n: b.n, pred: +(b.p / b.n).toFixed(4), actual: +(b.w / b.n).toFixed(4) })) };
  }
  // ===== 能力の内訳：10番人気以下の馬（とくにAIが市場より低く評価した馬）で、過去の成績のどれがオッズ以上に効くか =====
  function abilityReport(R, ranges, lo = 10){
    const rows = [];
    R.forEach(r => {
      const H = r.h.filter(h => h.pos && h.pk > 0); if (H.length < 5) return;
      const s = H.reduce((a, h) => a + h.pk, 0), sm = H.reduce((a, h) => a + Math.max(h.pm, 1e-5), 0), t3 = top3FromMarket(H.map(h => h.pk / s));
      H.forEach((h, i) => { if ((h.pop || 99) < lo || !("ab" in h)) return;
        rows.push({ date: r.date, hit: h.pos <= 3, e: t3[i], ab: h.ab, under: Math.max(h.pm, 1e-5) / sm < h.pk / s }); });
    });
    const W = rows.filter(x => x.ab);
    if (W.length < 300) return { n: W.length, ready: false };
    const inR = (x, g) => x.date >= g.from && x.date <= g.to;
    const testW = W.filter(x => ranges.some(g => inR(x, g)));
    const mkRow = (sub, label, pred) => {
      const S = sub.filter(pred), all = liftOf(S, r0Of(sub));
      const per = ranges.map(g => { const F = sub.filter(x => inR(x, g)), SS = F.filter(pred); return SS.length >= 15 ? liftOf(SS, r0Of(F)).lift : null; });
      const ls = per.filter(v => v != null), same = ls.length >= 3 && (ls.every(v => v > 1) || ls.every(v => v < 1));
      return { label, ...all, per, verdict: all.z != null && Math.abs(all.z) >= 2 && same ? "全期間で同じ向き・偶然でない" : all.z != null && Math.abs(all.z) >= 2 ? "偶然でないが期間で向きがばらつく" : "偶然と区別できない" };
    };
    const a = x => x.ab;
    const DEF = [
      ["前走 上位1/4の着順", x => a(x)[0] != null && a(x)[0] <= 0.25], ["前走 下位半分の着順", x => a(x)[0] != null && a(x)[0] >= 0.5],
      ["近3走 平均が上位1/3", x => a(x)[1] != null && a(x)[1] <= 0.33], ["近5走に上位1割の好走あり", x => a(x)[2] != null && a(x)[2] <= 0.1],
      ["前走 着差0.5秒以内", x => a(x)[3] != null && a(x)[3] <= 0.5], ["前走 2秒以上の大敗", x => a(x)[3] != null && a(x)[3] >= 2],
      ["前走 人気より3つ以上好走", x => a(x)[5] != null && a(x)[5] >= 3], ["前走 人気より5つ以上凡走", x => a(x)[5] != null && a(x)[5] <= -5],
      ["前走は5番人気以内（人気急落）", x => a(x)[4] != null && a(x)[4] <= 5],
      ["休み明け（90日以上）", x => a(x)[6] != null && a(x)[6] >= 90], ["中2週以内", x => a(x)[6] != null && a(x)[6] <= 14],
      ["キャリア3戦以内", x => a(x)[7] <= 3], ["キャリア20戦以上", x => a(x)[7] >= 20],
      ["降級（前走より下のクラス）", x => a(x)[8] != null && a(x)[8] < 0], ["昇級（前走より上のクラス）", x => a(x)[8] != null && a(x)[8] > 0]
    ];
    const testU = testW.filter(x => x.under);
    const single = DEF.map(([label, pred]) => ({ all: mkRow(testW, label, pred), under: mkRow(testU, label, pred) })).filter(x => x.all.n >= 20);
    // 来た馬と来なかった馬の平均（AIが市場より低く評価した10番人気以下）
    const U = W.filter(x => x.under), mean = (xs, k) => { const v = xs.map(x => x.ab[k]).filter(v => v != null); return v.length ? +(v.reduce((p, q) => p + q, 0) / v.length).toFixed(2) : null; };
    const means = AB_NAMES.map((k, j) => ({ k, hit: mean(U.filter(x => x.hit), j), non: mean(U.filter(x => !x.hit), j) }));
    // 組み合わせ（ウォークフォワード）：オッズから見た3着内の見込みに、能力の内訳を足すと予測が良くなるか
    const fill = (xs, med) => xs.map(x => AB_NAMES.map((_, j) => x.ab[j] ?? med[j]));
    const logit = p => { const q = Math.min(0.999, Math.max(1e-5, p)); return Math.log(q / (1 - q)); };
    const difs = [], folds = [];
    ranges.forEach(g => {
      const tr = W.filter(x => x.date < g.from), te = W.filter(x => inR(x, g)); if (tr.length < 1500 || !te.length) return;
      const med = AB_NAMES.map((_, j) => { const v = tr.map(x => x.ab[j]).filter(v => v != null).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : 0; });
      const Xtr = fill(tr, med), Xte = fill(te, med), ytr = tr.map(x => x.hit ? 1 : 0);
      const m = lsLogit(Xtr, tr.map(x => logit(x.e)), ytr, 30), m0 = lsLogit(tr.map(() => []), tr.map(x => logit(x.e)), ytr, 30);
      const d = te.map((x, i) => { const p = lsPredRow(m, Xte[i], logit(x.e)), p0 = lsPredRow(m0, [], logit(x.e)); return x.hit ? Math.log(p / p0) : Math.log((1 - p) / (1 - p0)); });
      const md = d.reduce((p, q) => p + q, 0) / d.length; difs.push(...d); folds.push({ from: g.from, n: te.length, gain: +(md * 1000).toFixed(2) });
    });
    let wf = null;
    if (difs.length){ const md = difs.reduce((p, q) => p + q, 0) / difs.length, sd = Math.sqrt(difs.reduce((p, q) => p + (q - md) ** 2, 0) / Math.max(1, difs.length - 1));
      wf = { n: difs.length, gain: +(md * 1000).toFixed(2), z: sd > 0 ? +(md / (sd / Math.sqrt(difs.length))).toFixed(2) : null, folds }; }
    return { ready: true, n: W.length, nTest: testW.length, nUnder: testU.length, single, means, wf };
  }

  // ===== 条件の組み合わせ（2〜3項目）の探索：市場が見落としている穴馬の条件はあるか =====
  // 組み合わせは数千通りあるので、偶然でも |z|≧2 が大量に出る。そこで
  //  (1) 全部で何通り調べ、偶然なら何個くらい z≧2 が出るはずかを並べて示す
  //  (2) 多重比較の補正（ボンフェローニ）をした基準 zB を超えたものだけを「偶然でない」とする
  //  (3) 仮想モデル：各期間について「それより前のデータだけ」で良かった組み合わせを選び、次の期間で本当に来たかを確かめる（ウォークフォワード）
  const invNorm = p => { // 標準正規分布の上側確率 p に対応する z（Acklamの近似）
    const q = 1 - p, a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239],
      b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155211507], c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425; let x;
    if (q < pl){ const t = Math.sqrt(-2 * Math.log(q)); x = (((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) / ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1); }
    else if (q <= 1 - pl){ const t = q - 0.5, r = t * t; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * t / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
    else { const t = Math.sqrt(-2 * Math.log(1 - q)); x = -(((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) / ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1); }
    return x;
  };
  const COMBO_C = [
    ["前走 人気より3つ以上好走", x => x.ab[5] != null && x.ab[5] >= 3], ["前走 人気より5つ以上凡走", x => x.ab[5] != null && x.ab[5] <= -5],
    ["距離延長200m以上", x => x.dd != null && x.dd >= 200], ["距離短縮200m以上", x => x.dd != null && x.dd <= -200],
    ["先行馬が少ない（2割未満）", x => x.nf / x.N < 0.2], ["逃げ馬がいない", x => x.nn === 0],
    ["内枠×普段前1/3", x => x.gate <= 0.2 && x.pp[0] < 0.35], ["前走後ろ半分→普段は前1/3", x => x.pp[1] != null && x.pp[1] >= 0.5 && x.pp[0] < 0.35],
    ["普段前1/3", x => x.pp[0] < 0.35],
    ["前走 上位1/4の着順", x => x.ab[0] != null && x.ab[0] <= 0.25], ["前走 下位半分の着順", x => x.ab[0] != null && x.ab[0] >= 0.5],
    ["近3走 平均が上位1/3", x => x.ab[1] != null && x.ab[1] <= 0.33], ["近5走に上位1割の好走", x => x.ab[2] != null && x.ab[2] <= 0.1],
    ["前走 着差0.5秒以内", x => x.ab[3] != null && x.ab[3] <= 0.5], ["前走 2秒以上の大敗", x => x.ab[3] != null && x.ab[3] >= 2],
    ["前走は5番人気以内", x => x.ab[4] != null && x.ab[4] <= 5],
    ["休み明け90日以上", x => x.ab[6] != null && x.ab[6] >= 90], ["中2週以内", x => x.ab[6] != null && x.ab[6] <= 14],
    ["キャリア3戦以内", x => x.ab[7] <= 3], ["キャリア20戦以上", x => x.ab[7] >= 20],
    ["降級", x => x.ab[8] != null && x.ab[8] < 0], ["昇級", x => x.ab[8] != null && x.ab[8] > 0], ["道悪", x => x.wet === 1]
  ];
  function comboReport(R, ranges, lo = 10){
    const rows = posRows(R).filter(x => x.pop >= lo && x.ab && x.has);
    if (rows.length < 2000) return { ready: false, n: rows.length };
    const K = COMBO_C.length, M = COMBO_C.map(([, f]) => Uint8Array.from(rows, x => f(x) ? 1 : 0));
    const combos = []; for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++){ combos.push([i, j]); for (let k = j + 1; k < K; k++) combos.push([i, j, k]); }
    const label = c => c.map(i => COMBO_C[i][0]).join(" ＋ ");
    const inR = (x, g) => x.date >= g.from && x.date <= g.to;
    const foldOf = rows.map(x => ranges.findIndex(g => inR(x, g)));
    // 期間ごとのくせ（Harvilleの穴の過小評価）を除いた期待値：検証期間はその期間の比、学習側は学習データ全体の比で割る
    const er = new Float64Array(rows.length);
    ranges.forEach((g, f) => { const idx = rows.map((x, i) => foldOf[i] === f ? i : -1).filter(i => i >= 0); const h = idx.filter(i => rows[i].hit).length, e = idx.reduce((a, i) => a + rows[i].e, 0); const r0 = e > 0 ? h / e : 1; idx.forEach(i => er[i] = rows[i].e * r0); });
    const statOf = (c, idx, ex) => { let n = 0, hit = 0, E = 0, V = 0, w = 0, ret = 0;
      for (const i of idx){ let ok = 1; for (const k of c) if (!M[k][i]){ ok = 0; break; } if (!ok) continue; n++; if (rows[i].hit) hit++; const e = ex[i]; E += e; V += e * (1 - Math.min(0.99, e)); if (rows[i].win){ w++; ret += rows[i].odds; } }
      return { n, hit, exp: E, z: V > 0 ? (hit - E) / Math.sqrt(V) : 0, lift: (hit + 1) / (E + 1), win: w, ret }; };
    const scopes = {};
    const test = rows.map((x, i) => foldOf[i] >= 0 ? i : -1).filter(i => i >= 0);
    for (const [key, pick] of [["all", () => true], ["under", i => rows[i].under]]){
      const idx = test.filter(pick);
      // 当てはまる馬がまったく同じ組み合わせ（片方の条件がもう片方に含まれる等）は1つにまとめる（短い方を残す）
      const seen = new Map();
      combos.map(c => ({ c, ...statOf(c, idx, er) })).filter(x => x.n >= 50 && x.exp >= 5)
        .forEach(x => { const key = `${x.n}|${x.hit}|${x.exp.toFixed(4)}|${x.win}`; const o = seen.get(key); if (!o || x.c.length < o.c.length) seen.set(key, x); });
      const res = [...seen.values()];
      const nT = res.length, zB = nT ? invNorm(0.05 / (2 * nT)) : null;
      const top = res.sort((a, b) => b.z - a.z).slice(0, 12).map(x => {
        const per = ranges.map((g, f) => { const s2 = statOf(x.c, idx.filter(i => foldOf[i] === f), er); return s2.n >= 10 ? +s2.lift.toFixed(2) : null; });
        const ls = per.filter(v => v != null), same = ls.length >= 3 && (ls.every(v => v > 1) || ls.every(v => v < 1));
        return { label: label(x.c), n: x.n, hit: x.hit, exp: +x.exp.toFixed(1), lift: +x.lift.toFixed(2), z: +x.z.toFixed(2), per, same,
          winROI: x.n ? +(x.ret / x.n).toFixed(2) : null, verdict: x.z >= zB && same ? "偶然でない（多重比較の補正後も）" : x.z >= zB ? "補正後も強いが期間で向きがばらつく" : "偶然の範囲（多重比較を考えると）" };
      });
      scopes[key] = { n: idx.length, nTests: nT, nZ2: res.filter(x => x.z >= 2).length, expFP: +(nT * 0.0228).toFixed(0), zB: zB != null ? +zB.toFixed(2) : null, top };
    }
    // 仮想モデル（ウォークフォワード）：前の期間だけで z≧2 の組み合わせを上位10個選ぶ → 次の期間で、どれかに当てはまる馬が本当に来たか
    const wf = {};
    for (const [key, pick] of [["all", () => true], ["under", i => rows[i].under]]){
      let H = 0, E = 0, V = 0, n = 0, w = 0, ret = 0; const folds = [];
      ranges.forEach((g, f) => {
        const tr = rows.map((x, i) => x.date < g.from && pick(i) ? i : -1).filter(i => i >= 0); if (tr.length < 1500) return;
        const h0 = tr.filter(i => rows[i].hit).length, e0 = tr.reduce((a, i) => a + rows[i].e, 0), r0 = e0 > 0 ? h0 / e0 : 1;
        const ex = new Float64Array(rows.length); tr.forEach(i => ex[i] = rows[i].e * r0);
        const sel = combos.map(c => ({ c, ...statOf(c, tr, ex) })).filter(x => x.n >= 80 && x.exp >= 8 && x.z >= 2 && x.lift > 1).sort((a, b) => b.z - a.z).slice(0, 10);
        const te = rows.map((x, i) => foldOf[i] === f && pick(i) ? i : -1).filter(i => i >= 0);
        const hitSet = te.filter(i => sel.some(s2 => s2.c.every(k => M[k][i])));
        let h = 0, e = 0, v = 0, ww = 0, rr = 0; hitSet.forEach(i => { if (rows[i].hit) h++; e += er[i]; v += er[i] * (1 - Math.min(0.99, er[i])); if (rows[i].win){ ww++; rr += rows[i].odds; } });
        H += h; E += e; V += v; n += hitSet.length; w += ww; ret += rr;
        folds.push({ from: g.from, picked: sel.length, top: sel.slice(0, 3).map(s2 => label(s2.c)), n: hitSet.length, hit: h, exp: +e.toFixed(1), lift: +((h + 1) / (e + 1)).toFixed(2) });
      });
      wf[key] = { n, hit: H, exp: +E.toFixed(1), lift: +((H + 1) / (E + 1)).toFixed(2), z: V > 0 ? +((H - E) / Math.sqrt(V)).toFixed(2) : null, winROI: n ? +(ret / n).toFixed(2) : null, folds };
    }
    return { ready: true, n: rows.length, conditions: COMBO_C.length, combos: combos.length, scopes, wf };
  }

  // ===== 購入ルールの選び方そのものを確かめる（単勝・100円均等） =====
  // ルール＝人気帯×オッズ帯×期待値の下限（180通り）。各期間について「それより前の期間だけ」で一番良かったルール
  // （回収率の95%範囲の下限が最も高いもの・200点以上）を選び、その期間に実際に買ったらどうなったかを測る。
  // 選んだルールをそのまま未来に持っていった成績だけが、実戦で期待できる回収率に近い。
  function strategyReport(R, ranges, folds){
    if (!folds.length) return null;
    const POP = [[1, 3], [4, 7], [8, 12], [13, 99], [4, 99], [1, 99]], ODD = [[1, 5], [5, 10], [10, 20], [20, 50], [50, 9999], [1, 9999]], EVT = [0, 0.8, 0.9, 1.0, 1.1];
    const rules = []; POP.forEach(p => ODD.forEach(o => EVT.forEach(t => rules.push({ p, o, t }))));
    const rlabel = r => `${r.p[0] === 1 && r.p[1] === 99 ? "全人気" : r.p[1] === 99 ? `${r.p[0]}番人気以下` : `${r.p[0]}〜${r.p[1]}番人気`}・${r.o[0] === 1 && r.o[1] === 9999 ? "全オッズ" : r.o[1] === 9999 ? `${r.o[0]}倍以上` : `${r.o[0]}〜${r.o[1]}倍`}・期待値${r.t ? r.t + "以上" : "問わず"}`;
    // 1頭ずつ：期待値は、そのレースを検証した期間の統合比率（最初の土台期間は最初の期間の比率）で計算
    const abOf = d => { const f = folds.find(x => d >= x.from && d <= x.to); return f || folds[0]; };
    const bets = [];
    R.forEach(r => { const H = r.h.filter(h => h.pos != null && h.odds > 1); if (H.length < 5) return; const { a, b } = abOf(r.date);
      const sk = H.reduce((x, h) => x + h.pk, 0), sm = H.reduce((x, h) => x + Math.max(h.pm, 1e-5), 0);
      const q = H.map(h => Math.pow(Math.max(h.pm, 1e-5) / sm, a) * Math.pow(h.pk / sk, b)), sq = q.reduce((x, y) => x + y, 0);
      H.forEach((h, i) => bets.push({ date: r.date, id: r.id, pop: h.pop || 99, odds: h.odds, ev: q[i] / sq * h.odds, ret: h.pos === 1 ? h.odds : 0 })); });
    const match = (r, x) => x.pop >= r.p[0] && x.pop <= r.p[1] && x.odds >= r.o[0] && x.odds < r.o[1] && x.ev >= r.t;
    const stat = xs => { const n = xs.length; if (!n) return { n: 0 }; const m = xs.reduce((s, x) => s + x.ret, 0) / n, v = xs.reduce((s, x) => s + (x.ret - m) ** 2, 0) / Math.max(1, n - 1), se = Math.sqrt(v / n);
      let bal = 0, peak = 0, dd = 0; xs.forEach(x => { bal += (x.ret - 1) * 100; peak = Math.max(peak, bal); dd = Math.max(dd, peak - bal); });
      return { n, roi: +m.toFixed(3), lo95: +Math.max(0, m - 1.96 * se).toFixed(3), hi95: +(m + 1.96 * se).toFixed(3), profit: Math.round(bal), maxDD: Math.round(dd) }; };
    const out = [], picked = [];
    ranges.forEach(g => {
      const tr = bets.filter(x => x.date < g.from), te = bets.filter(x => x.date >= g.from && x.date <= g.to); if (!te.length) return;
      let best = null; rules.forEach(r => { const s = stat(tr.filter(x => match(r, x))); if (s.n >= 200 && (!best || s.lo95 > best.s.lo95)) best = { r, s }; });
      if (!best) return;
      const got = te.filter(x => match(best.r, x)); picked.push(...got);
      out.push({ from: g.from, to: g.to, rule: rlabel(best.r), trainROI: best.s.roi, trainN: best.s.n, ...stat(got) });
    });
    // 参考：検証期間全体で後から一番良かったルール（＝後知恵。実戦ではこれは選べない）
    const testAll = bets.filter(x => x.date >= ranges[0].from);
    let hind = null; rules.forEach(r => { const s = stat(testAll.filter(x => match(r, x))); if (s.n >= 200 && (!hind || s.roi > hind.s.roi)) hind = { r, s }; });
    const all = stat(picked.sort((x, y) => (x.date + x.id).localeCompare(y.date + y.id)));
    const lock = out[out.length - 1] || null;
    return { rules: rules.length, folds: out, total: all, allPositive: out.length > 0 && out.every(f => f.n && f.roi >= 1), lock,
      hindsight: hind ? { rule: rlabel(hind.r), ...hind.s } : null, base: stat(testAll) };
  }

  // ===== 券種ごとのずれ（クロスプール）：単勝オッズから計算した各券種の確率 × その券種の実際のオッズ =====
  // 単勝の売上はいちばん大きく情報が集まるので、単勝オッズから「複勝・ワイド・馬連・馬単・3連複が当たる確率」を計算し、
  // それぞれの券種のオッズと比べて、売れすぎ／売れなさすぎ（期待値が1を超える目）があるかを確かめる（Hausch–Ziembaの方法）。
  // 確率は p ∝ (単勝オッズの逆数)^β（1着・2着・3着で別のβ。ベンターの方法）。βは各期間それより前のレースだけで決める。
  const CT = ["単勝", "複勝", "ワイド", "馬連", "馬単", "三連複"];
  const pairIdx = (i, j, n) => i * n + j;                       // 順序あり（馬単）・なし（i<j）共通の番号
  const comb3 = (i, j, k) => k * (k - 1) * (k - 2) / 6 + j * (j - 1) / 2 + i;   // i<j<k の3頭の組の番号（メモリを使わない並べ方）
  function crossCompact(r){
    const res = r.result; if (!res?.pay || !r.comboOdds || !r.entries?.length) return null;
    const rows = (res.rows || []).filter(x => /^\d+$/.test(String(x.pos)));
    const E = r.entries.filter(e => e.odds > 1 && rows.some(x => x.num === e.num));
    if (E.length < 5) return null;
    const n = E.length, nums = E.map(e => e.num), at = {}; nums.forEach((m, i) => at[m] = i);
    const order = (res.order || rows.slice().sort((a, b) => a.pos - b.pos).map(x => x.num)).slice(0, 3).map(m => at[m]);
    if (order.length < 3 || order.some(i => i == null)) return null;
    const C = r.comboOdds, P2 = new Float32Array(n * n), W2 = new Float32Array(n * n), U2 = new Float32Array(n * n), T3 = new Float32Array(n * (n - 1) * (n - 2) / 6);
    const parse = k => k.split("-").map(m => at[+m]);
    Object.entries(C.馬連 || {}).forEach(([k, v]) => { const [i, j] = parse(k); if (i != null && j != null) P2[pairIdx(Math.min(i, j), Math.max(i, j), n)] = v; });
    Object.entries(C.ワイド || {}).forEach(([k, v]) => { const [i, j] = parse(k); if (i != null && j != null) W2[pairIdx(Math.min(i, j), Math.max(i, j), n)] = Array.isArray(v) ? v[0] : v; });
    Object.entries(C.馬単 || {}).forEach(([k, v]) => { const [i, j] = parse(k); if (i != null && j != null) U2[pairIdx(i, j, n)] = v; });
    Object.entries(C.三連複 || {}).forEach(([k, v]) => { const t = parse(k); if (t.every(x => x != null)){ t.sort((a, b) => a - b); T3[comb3(t[0], t[1], t[2])] = v; } });
    const pay = {}; CT.forEach(t => { pay[t] = {}; Object.entries(res.pay[t] || {}).forEach(([k, v]) => { const t2 = k.split("-").map(m => at[+m]); if (t2.every(x => x != null)) pay[t][(t === "馬単" ? t2 : t2.sort((a, b) => a - b)).join("-")] = v / 100; }); });
    return { date: r.date, id: r.id, n, odds: Float32Array.from(E, e => e.odds), plo: Float32Array.from(E, e => e.placeLo > 1 ? e.placeLo : 0), order, P2, W2, U2, T3, pay };
  }
  // 1着・2着・3着の選ばれ方の鋭さ β を、それぞれ尤度最大で決める（段ごとに独立に解ける）
  function crossFitBeta(rows){
    const ll = (st, b) => { let L = 0; rows.forEach(x => { const q = Array.from(x.odds, o => Math.pow(1 / o, b)); let Z = q.reduce((a, c) => a + c, 0); for (let s = 0; s < st; s++) Z -= q[x.order[s]]; L += Math.log(q[x.order[st]] / Z); }); return L; };
    return [0, 1, 2].map(st => { let lo = 0.2, hi = 2; for (let k = 0; k < 40; k++){ const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (ll(st, m1) > ll(st, m2)) hi = m2; else lo = m1; } return +((lo + hi) / 2).toFixed(3); });
  }
  // 1レースの各券種の確率（順序つきの1〜3着を全部たどる）と、買える目の期待値・払戻
  function crossTickets(x, beta, cb){
    const n = x.n, q = beta.map(b => Array.from(x.odds, o => Math.pow(1 / o, b))), Z = q.map(a => a.reduce((s, c) => s + c, 0));
    const p1 = q[0].map(v => v / Z[0]), top3 = new Float64Array(n), win2 = new Float64Array(n * n), in3 = new Float64Array(n * n), tri = new Float64Array(x.T3.length);
    for (let i = 0; i < n; i++){ const pi = p1[i];
      for (let j = 0; j < n; j++){ if (j === i) continue; const pj = q[1][j] / (Z[1] - q[1][i]), pij = pi * pj; win2[i * n + j] += pij;
        for (let k = 0; k < n; k++){ if (k === i || k === j) continue; const pk = q[2][k] / (Z[2] - q[2][i] - q[2][j]), p = pij * pk;
          top3[i] += p; top3[j] += p; top3[k] += p;
          const a = Math.min(i, j), b = Math.max(i, j); in3[a * n + b] += p; const c1 = Math.min(i, k), d1 = Math.max(i, k); in3[c1 * n + d1] += p; const c2 = Math.min(j, k), d2 = Math.max(j, k); in3[c2 * n + d2] += p;
          const s3 = [i, j, k].sort((u, v) => u - v); tri[comb3(s3[0], s3[1], s3[2])] += p; } } }
    const R = (t, key) => x.pay[t][key] || 0;
    for (let i = 0; i < n; i++){ cb(0, p1[i], x.odds[i], R("単勝", String(i))); if (x.plo[i] > 1) cb(1, top3[i], x.plo[i], R("複勝", String(i))); }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++){ const k = `${i}-${j}`;
      if (x.W2[i * n + j] > 1) cb(2, in3[i * n + j], x.W2[i * n + j], R("ワイド", k));
      if (x.P2[i * n + j] > 1) cb(3, win2[i * n + j] + win2[j * n + i], x.P2[i * n + j], R("馬連", k)); }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && x.U2[i * n + j] > 1) cb(4, win2[i * n + j], x.U2[i * n + j], R("馬単", `${i}-${j}`));
    for (let k = 2; k < n; k++) for (let j = 1; j < k; j++) for (let i = 0; i < j; i++){ const c = comb3(i, j, k), o = x.T3[c]; if (o > 1) cb(5, tri[c], o, R("三連複", `${i}-${j}-${k}`)); }
  }
  async function crossReport(rowsIn, opt = {}){
    const rows = rowsIn.filter(Boolean).sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
    if (rows.length < 300) return { ready: false, n: rows.length };
    const dates = [...new Set(rows.map(x => x.date))], testDates = dates.slice(Math.max(1, Math.floor(dates.length * 0.4))), per = Math.ceil(testDates.length / 5);
    const ranges = []; for (let f = 0; f < 5; f++){ const fd = testDates.slice(f * per, (f + 1) * per); if (fd.length) ranges.push({ from: fd[0], to: fd[fd.length - 1] }); }
    // 期間ごとのβ（それより前のレースだけで決める）。最初の土台期間のレースは1つ目の期間のβで計算
    ranges.forEach(g => { g.beta = crossFitBeta(rows.filter(x => x.date < g.from)); });
    const foldOf = d => ranges.findIndex(g => d >= g.from && d <= g.to);
    const EVB = [0, 0.8, 1.0, 1.1, 1.3, 1.6, 2, 1e9], THR = [1.0, 1.1, 1.2, 1.3, 1.5, 2.0];
    const bins = CT.map(() => EVB.slice(0, -1).map(() => ({ n: 0, hit: 0, ret: 0, ret2: 0, p: 0 })));
    // 期待値0.9以上の目だけ1点ずつ残す（買い方の選び方の確かめ用）
    const T = { fold: [], type: [], ev: [], ret: [], date: [] };
    for (let r = 0; r < rows.length; r++){
      const x = rows[r], f = foldOf(x.date), beta = (ranges[f] || ranges[0]).beta;
      crossTickets(x, beta, (t, p, o, ret) => { const ev = p * o;
        if (f >= 0){ const bi = EVB.findIndex((b, i) => ev >= b && ev < EVB[i + 1]); const B = bins[t][bi]; B.n++; B.p += p; if (ret > 0){ B.hit++; B.ret += ret; B.ret2 += ret * ret; } }
        if (ev >= 0.9){ T.fold.push(f); T.type.push(t); T.ev.push(ev); T.ret.push(ret); T.date.push(r); } });
      if (r % 200 === 199) await new Promise(res => setTimeout(res, 0));
    }
    const statOf = idx => { const n = idx.length; if (!n) return { n: 0 }; let s = 0, s2 = 0, hit = 0, bal = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0;
      idx.forEach(i => { const v = T.ret[i]; s += v; s2 += v * v; if (v > 0){ hit++; streak = 0; } else maxStreak = Math.max(maxStreak, ++streak); bal += (v - 1) * 100; peak = Math.max(peak, bal); dd = Math.max(dd, peak - bal); });
      const m = s / n, se = Math.sqrt(Math.max(0, s2 / n - m * m) / n);
      return { n, roi: +m.toFixed(3), lo95: +Math.max(0, m - 1.96 * se).toFixed(3), hi95: +(m + 1.96 * se).toFixed(3), hitRate: +(hit / n).toFixed(4), profit: Math.round(bal), maxDD: Math.round(dd), maxLose: maxStreak }; };
    const N = T.ev.length, all = Array.from({ length: N }, (_, i) => i);
    // 券種ごと：前の期間で一番良かった期待値の下限を選び、次の期間で買う（ウォークフォワード）
    const wfType = t => { const picked = [], folds = [];
      ranges.forEach((g, f) => {
        const tr = all.filter(i => T.type[i] === t && rows[T.date[i]].date < g.from);
        let best = null; THR.forEach(th => { const s = statOf(tr.filter(i => T.ev[i] >= th)); if (s.n >= 300 && s.roi > 1 && (!best || s.lo95 > best.s.lo95)) best = { th, s }; });
        if (!best){ folds.push({ from: g.from, th: null, n: 0 }); return; }      // 前の期間でプラスの下限がなければ「買わない」
        const te = all.filter(i => T.type[i] === t && T.fold[i] === f && T.ev[i] >= best.th); picked.push(...te);
        folds.push({ from: g.from, th: best.th, trainROI: best.s.roi, ...statOf(te) });
      });
      return { total: statOf(picked.sort((a, b) => T.date[a] - T.date[b])), folds }; };
    const types = CT.map((name, t) => ({ name, bins: bins[t].map((B, i) => ({ range: `${EVB[i]}〜${EVB[i + 1] >= 1e9 ? "" : EVB[i + 1]}`, n: B.n, pred: B.n ? +(B.p / B.n).toFixed(4) : null, hitRate: B.n ? +(B.hit / B.n).toFixed(4) : null,
      roi: B.n ? +(B.ret / B.n).toFixed(3) : null, lo95: B.n ? +Math.max(0, B.ret / B.n - 1.96 * Math.sqrt(Math.max(0, B.ret2 / B.n - (B.ret / B.n) ** 2) / B.n)).toFixed(3) : null })).filter(b => b.n), wf: wfType(t) }));
    // 全券種まとめて：各期間、前の期間で回収率の95%下限が一番高かった「券種×期待値の下限」を最大3つ選んで買う
    const picked = [], folds = [];
    ranges.forEach((g, f) => {
      const cands = [];
      CT.forEach((_, t) => THR.forEach(th => { const s = statOf(all.filter(i => T.type[i] === t && rows[T.date[i]].date < g.from && T.ev[i] >= th)); if (s.n >= 300) cands.push({ t, th, s }); }));
      const sel = cands.filter(c => c.s.roi > 1).sort((a, b) => b.s.lo95 - a.s.lo95).filter((c, i, A) => A.findIndex(d => d.t === c.t) === i).slice(0, 3);
      const te = all.filter(i => T.fold[i] === f && sel.some(c => c.t === T.type[i] && T.ev[i] >= c.th)); picked.push(...te);
      folds.push({ from: g.from, to: g.to, beta: g.beta, rules: sel.map(c => `${CT[c.t]}・期待値${c.th}以上（前の期間 ${Math.round(c.s.roi * 100)}%）`), ...statOf(te) });
    });
    const races = rows.filter(x => foldOf(x.date) >= 0).length;
    return { ready: true, n: rows.length, testRaces: races, from: ranges[0].from, ranges: ranges.map(g => ({ from: g.from, to: g.to, beta: g.beta })), types,
      combined: { total: statOf(picked.sort((a, b) => T.date[a] - T.date[b])), folds, perRace: races ? +(picked.length / races).toFixed(1) : null } };
  }

  // ===== 前走の分解（記録の中に前走のレースがあるときだけ）：着順という圧縮された情報を、上がり順位・ペース・位置取りに戻す =====
  // 前走のレース全体の記録（全馬の上がり・通過・タイム）を馬名（hid：予想時の出馬表と過去データで同じ書き方になるのは馬名のため）でつなぐ。前走は今回より前に終わったレースなので、レース前に分かる情報。
  // ペース＝勝ち馬の「前半（上がり3F以外）の600mあたりの時間 − 上がり3F」（＋はスロー）。芝ダ・距離（200m刻み）ごとに、そのレースより前の記録だけで平均・ばらつきを出して標準化する。
  const PREV_NAMES = ["前走の上がり順位（率）", "前走の上がり順位と着順の差（＋は上がりの割に負けた）", "前走のペース（＋はスロー）", "前走の展開不利（前でハイペース・後ろでスロー）", "前走の展開不利×下位半分", "前走の詳細なし"];
  const tsecOf = t => { if (t == null) return null; const m = String(t).match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); return m ? (+(m[1] || 0)) * 60 + +m[2] : null; };
  const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 864e5);
  function prevBuilder(R){
    const recs = (R || []).filter(r => r?.date && r.h?.length).slice().sort((a, b) => a.date.localeCompare(b.date));
    const paceRaw = r => { const w = r.h.find(h => h.pos === 1), T = tsecOf(w?.time), L = +w?.l3f; if (!T || !(L > 30 && L < 45) || !(r.dist >= 1000)) return null;
      const f = (T - L) / (r.dist - 600) * 600; return f > 25 && f < 60 ? f - L : null; };
    const key = r => r.surface + "|" + Math.round(r.dist / 200) * 200, st = {}, pz = new Map(), byH = new Map();
    for (let i = 0; i < recs.length;){ let j = i; while (j < recs.length && recs[j].date === recs[i].date) j++;
      const day = recs.slice(i, j);
      day.forEach(r => { const v = paceRaw(r), o = st[key(r)]; pz.set(r, v != null && o && o.n >= 30 ? (v - o.s / o.n) / (Math.sqrt(Math.max(1e-6, o.s2 / o.n - (o.s / o.n) ** 2))) : null); });
      day.forEach(r => { const v = paceRaw(r); if (v == null) return; const o = st[key(r)] || (st[key(r)] = { n: 0, s: 0, s2: 0 }); o.n++; o.s += v; o.s2 += v * v; });
      day.forEach(r => r.h.forEach(h => { if (h.hid && h.pos > 0){ if (!byH.has(h.hid)) byH.set(h.hid, []); byH.get(h.hid).push({ date: r.date, r, h }); } }));
      i = j; }
    // hid：馬、date：今回の日付、days：馬柱から分かる前走からの日数（記録の前走が本当の前走かの確認）
    return (hid, date, days) => {
      const A = hid && byH.get(hid); if (!A || days == null) return null;
      let k = A.length - 1; while (k >= 0 && A[k].date >= date) k--; if (k < 0) return null;
      const { r, h } = A[k]; if (Math.abs(dayDiff(date, r.date) - days) > 1) return null;
      const fin = r.h.filter(x => x.pos > 0), nL = fin.filter(x => x.l3rank > 0).length, n = fin.length; if (n < 5) return null;
      const l3r = h.l3rank > 0 && nL > 1 ? (h.l3rank - 1) / (nL - 1) : null, gap = h.l3rank > 0 ? (h.pos - h.l3rank) / n : null;
      const p = pz.get(r), c1 = h.c1 ?? (h.early ?? null), lost = (h.pos - 1) / Math.max(1, n - 1) >= 0.5;
      const ten = p != null && c1 != null ? (c1 - 0.5) * Math.max(-3, Math.min(3, p)) : null;
      return [l3r, gap, p != null ? Math.max(-3, Math.min(3, p)) : null, ten, ten != null ? ten * (lost ? 1 : 0) : null, h.l3rank > 0 ? h.l3rank : null, h.pos, c1];
    };
  }
  const prevVec = pv => { const v = (x, d = 0) => x == null || !isFinite(x) ? d : x; return pv ? [v(pv[0], .5), v(pv[1]), v(pv[2]), v(pv[3]), v(pv[4]), pv[0] == null || pv[2] == null ? 1 : 0] : [.5, 0, 0, 0, 0, 1]; };

  // ===== 市場乖離型：オッズを一切使わない「独自勝率」モデル → 最後にだけ市場と比べる =====
  // 材料（レース前に分かるもの・今回のオッズ／人気／人気から作る項目は使わない）を6つのモジュールに分け、
  // それぞれ単体と、全部をまとめたものを、上位3着の Plackett–Luce（2・3着は割り引き）で学習する（各期間それより前のレースだけ・リッジ正則化・ニュートン法）。
  const IND_Z = FEATS.map((k, j) => [k, j]).filter(([k]) => k !== "人気変動" && k !== "穴要素");
  const IND_NAMES = [...IND_Z.map(([k]) => "要素:" + k), ...AB_NAMES, "能力の内訳なし", "普段の1角の位置", "前走の1角の位置", "近3走の1角の位置", "前走の4角の位置", "メンバー内で普段どれだけ前か", "位置取りの記録なし", ...CT_NAMES, "前走の内容なし", "枠", "距離の増減", "先行馬の割合", "前走の道中の押し上げ（1角→4角）", ...PREV_NAMES];
  const IND_MODULES = [
    ["A 基礎能力", ["要素:能力", "要素:スピード", "要素:血統", "近5走のベスト着順（率）", "出走数", "能力の内訳なし"]],
    ["B 近走フォーム", ["要素:調子", "要素:ローテ", "前走の着順（率）", "近3走の着順（率）", "前走の着差（秒）", "前走の人気", "前走の人気−着順（＋は人気より好走）", "前走からの日数"]],
    ["C 前走内容", [...CT_NAMES, "前走の内容なし", "前走の4角の位置", "前走の道中の押し上げ（1角→4角）", ...PREV_NAMES]],
    ["D 今回条件", ["要素:距離", "要素:芝ダ", "要素:馬場", "要素:競馬場", "要素:回り", "要素:斤量", "要素:季節", "要素:当日馬場", "要素:レース傾向", "要素:年齢", "距離の増減", "クラスの上下（＋は昇級）"]],
    ["E 展開・枠", ["普段の1角の位置", "前走の1角の位置", "近3走の1角の位置", "メンバー内で普段どれだけ前か", "位置取りの記録なし", "枠", "要素:枠", "先行馬の割合"]],
    ["F 騎手・調教", ["要素:騎手", "要素:乗替", "要素:調教"]]
  ].map(([name, cols]) => [name, cols.map(c => IND_NAMES.indexOf(c)).filter(i => i >= 0)]);
  function indX(h, rel, nfRatio, pv){
    const ab = h.ab, pp = h.pp?.[4] > 0 ? h.pp : null, ct = h.ct;
    const v = (x, d = 0) => x == null || !isFinite(x) ? d : x;
    return [...IND_Z.map(([, j]) => v(h.z?.[j])),
      ...(ab ? [v(ab[0], .5), v(ab[1], .5), v(ab[2], .5), Math.min(5, v(ab[3], 1)), Math.min(18, v(ab[4], 9)), Math.max(-15, Math.min(15, v(ab[5]))), Math.min(365, v(ab[6], 40)) / 30, Math.min(40, v(ab[7], 5)), v(ab[8]) / 6] : [.5, .5, .5, 1, 9, 0, 40 / 30, 0, 0]), ab ? 0 : 1,
      ...(pp ? [pp[0], v(pp[1], pp[0]), v(pp[2], pp[0]), v(pp[3], pp[0]), v(rel, .5)] : [.5, .5, .5, .5, .5]), pp ? 0 : 1,
      ...(ct ? [v(ct[0]), v(ct[1]), v(ct[2])] : [0, 0, 0]), ct ? 0 : 1,
      h.gate, Math.max(-2, Math.min(2, v(h.dd) / 400)), nfRatio, ct ? v(ct[3]) : 0, ...prevVec(pv)];
  }
  const relOf = H => { const eps = H.map(h => h.pp?.[4] > 0 ? h.pp[0] : null), w = eps.filter(x => x != null).sort((a, b) => a - b); return eps.map(e => e != null && w.length > 1 ? w.indexOf(e) / (w.length - 1) : null); };
  function indRows(R, prevOf){
    prevOf = prevOf || prevBuilder(R);
    return R.map(r => {
      const H = r.h.filter(h => h.pos != null && h.odds > 1); if (H.length < 5 || !r.order?.length) return null;
      const rel = relOf(H), nfr = (r.nf || 0) / Math.max(1, H.length);
      const PV = H.map(h => prevOf(h.hid, r.date, h.ab?.[6]));
      const X = H.map((h, i) => indX(h, rel[i], nfr, PV[i]));
      const idx = []; for (const num of r.order.slice(0, 3)){ const k = H.findIndex(h => h.num === num); if (k < 0 || idx.includes(k)) break; idx.push(k); }
      const sk = H.reduce((a, h) => a + h.pk, 0), sm = H.reduce((a, h) => a + Math.max(h.pm, 1e-5), 0);
      return { date: r.date, id: r.id, X, idx, n: H.length, PK: H.map(h => h.pk / sk), PM: H.map(h => Math.max(h.pm, 1e-5) / sm), odds: H.map(h => h.odds), win: H.map(h => h.pos === 1), top3: H.map(h => h.pos <= 3),
        ct: H.map(h => h.ct || null), ab: H.map(h => h.ab || null), nums: H.map(h => h.num), ep: H.map(h => h.pp?.[4] > 0 ? h.pp[0] : null), pv: PV,
        miss: H.some(h => !h.ab || !h.ct || !(h.pp?.[4] > 0)), full: H.every(h => h.ab !== undefined && h.ct !== undefined) };
    }).filter(Boolean);
  }
  // cols：使う材料の番号（モジュール単体の確かめ用）。戻り値の H は最適解でのヘッセ行列（予測の不確かさの計算に使う）
  function indFit(rows, cols, lam = 2){
    cols = cols || IND_NAMES.map((_, j) => j); const D = cols.length;
    const mu = new Float64Array(D), sd = new Float64Array(D); let cnt = 0;
    rows.forEach(x => x.X.forEach(v => { cnt++; for (let j = 0; j < D; j++) mu[j] += v[cols[j]]; })); for (let j = 0; j < D; j++) mu[j] /= Math.max(1, cnt);
    rows.forEach(x => x.X.forEach(v => { for (let j = 0; j < D; j++) sd[j] += (v[cols[j]] - mu[j]) ** 2; })); for (let j = 0; j < D; j++) sd[j] = Math.sqrt(sd[j] / Math.max(1, cnt)) || 1;
    const Z = rows.map(x => { const z = new Float64Array(x.n * D); x.X.forEach((v, i) => { for (let j = 0; j < D; j++) z[i * D + j] = stdClip((v[cols[j]] - mu[j]) / sd[j]); }); return z; });
    const th = new Float64Array(D), m = new Float64Array(D);
    const evalLL = (t, g, Hm) => { let L = 0; if (g){ g.fill(0); Hm.fill(0); }
      for (let r = 0; r < rows.length; r++){ const x = rows[r], z = Z[r], n = x.n, u = new Float64Array(n), used = new Uint8Array(n), e = new Float64Array(n);
        for (let i = 0; i < n; i++){ let s2 = 0; for (let j = 0; j < D; j++) s2 += t[j] * z[i * D + j]; u[i] = s2; }
        for (let st = 0; st < x.idx.length; st++){ const w = x.idx[st], lmb = LAM[st]; let mx = -1e9; for (let i = 0; i < n; i++) if (!used[i]) mx = Math.max(mx, lmb * u[i]);
          let S = 0; for (let i = 0; i < n; i++){ e[i] = used[i] ? 0 : Math.exp(lmb * u[i] - mx); S += e[i]; }
          L -= lmb * u[w] - mx - Math.log(S);
          if (g){ m.fill(0); for (let i = 0; i < n; i++) if (e[i]){ const p = e[i] / S; for (let j = 0; j < D; j++) m[j] += p * z[i * D + j]; }
            for (let j = 0; j < D; j++) g[j] += lmb * (m[j] - z[w * D + j]);
            for (let i = 0; i < n; i++) if (e[i]){ const p = lmb * lmb * e[i] / S; for (let j = 0; j < D; j++){ const dj = z[i * D + j] - m[j]; if (!dj) continue; const pj = p * dj; for (let k = j; k < D; k++) Hm[j * D + k] += pj * (z[i * D + k] - m[k]); } } }
          used[w] = 1; } }
      for (let j = 0; j < D; j++){ L += lam * t[j] * t[j] / 2; if (g){ g[j] += lam * t[j]; Hm[j * D + j] += lam; } }
      if (g) for (let j = 0; j < D; j++) for (let k = 0; k < j; k++) Hm[j * D + k] = Hm[k * D + j];
      return L; };
    const g = new Float64Array(D), Hm = new Float64Array(D * D), tmp = new Float64Array(D);
    let L = evalLL(th, g, Hm);
    for (let it = 0; it < 30; it++){
      const step = solve(Array.from({ length: D }, (_, j) => Array.from(Hm.subarray(j * D, j * D + D))), Array.from(g, v => -v)); if (!step.every(isFinite)) break;
      let t = 1, ok = false; for (let ls = 0; ls < 20; ls++){ for (let j = 0; j < D; j++) tmp[j] = th[j] + t * step[j]; if (evalLL(tmp, null, null) <= L + 1e-10){ ok = true; break; } t /= 2; }
      if (!ok) break; th.set(tmp); L = evalLL(th, g, Hm); if (Math.max(...step.map(Math.abs)) * t < 1e-7) break;
    }
    return { cols: Array.from(cols), th: Array.from(th), mu: Array.from(mu), sd: Array.from(sd), H: Hm };
  }
  const stdClip = z => z > 4 ? 4 : z < -4 ? -4 : z;   // 学習のときにほとんど見なかった極端な値で、予測が暴れないように
  const indUtil = (m, X) => X.map(v => { let s2 = 0; for (let j = 0; j < m.cols.length; j++) s2 += m.th[j] * stdClip((v[m.cols[j]] - m.mu[j]) / m.sd[j]); return s2; });
  const softmax = u => { const mx = Math.max(...u), e = u.map(a => Math.exp(a - mx)), s = e.reduce((a, b) => a + b, 0); return e.map(a => a / s); };
  const indPredict = (m, x) => softmax(indUtil(m, x.X));
  // 予測の不確かさ用：係数の分布（ヘッセ行列の逆＝共分散）のコレスキー分解
  function cholCov(Hm, D){
    const inv = []; for (let k = 0; k < D; k++){ const e = new Array(D).fill(0); e[k] = 1; inv.push(solve(Array.from({ length: D }, (_, j) => Array.from(Hm.subarray(j * D, j * D + D))), e)); }
    const S = Array.from({ length: D }, (_, i) => Array.from({ length: D }, (_, j) => (inv[i][j] + inv[j][i]) / 2)), Lc = Array.from({ length: D }, () => new Array(D).fill(0));
    for (let i = 0; i < D; i++) for (let j = 0; j <= i; j++){ let s2 = S[i][j]; for (let k = 0; k < j; k++) s2 -= Lc[i][k] * Lc[j][k]; Lc[i][j] = i === j ? Math.sqrt(Math.max(s2, 1e-12)) : s2 / Lc[j][j]; }
    return Lc.map(r => r.map(v => +v.toFixed(6)));
  }
  // 予想のとき：記録と同じ作り方で、出走馬の材料を作る（ctx：buildContext の結果）
  function liveRows(ctx, race, Engine, prevOf){
    ENG = Engine;
    const W = Engine.WEIGHTS, wc = k => (k === "能力" ? 1 : (W[k] ?? 1)) || 1;
    const H = ctx.field.map(f => { const runs = f.prof?.runs || [], pre = preOf(runs, race.distance);
      const ab = abOf(runs, race);
      return { num: f.num, z: FEATS.map(k => (f.adj?.[k] || 0) / wc(k)), ab, ct: ctOf(runs), pp: pre.pp, dd: pre.dd, gate: (f.num - 1) / Math.max(1, ctx.N - 1), pv: prevOf ? prevOf(f.name || f.horseId, race.date, ab?.[6]) : null }; });
    const { nf } = frontCounts(H.map(h => ({ pp: h.pp })));
    const rel = relOf(H), nfr = nf / Math.max(1, H.length);
    return { H, X: H.map((h, i) => indX(h, rel[i], nfr, h.pv)) };
  }
  // 独自勝率と、その95%の範囲（係数の不確かさから200回くじ引き）
  function livePredict(model, ctx, race, Engine, draws = 200, prevOf){
    if (!model?.th) return null;
    const { H, X } = liveRows(ctx, race, Engine, prevOf);
    const p = softmax(indUtil(model, X));
    const D = model.th.length, samples = H.map(() => []);
    let seed = 12345; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    if (model.chol) for (let d = 0; d < draws; d++){
      const eps = Array.from({ length: D }, gauss), th = model.th.map((t, i) => { let s2 = t; for (let k = 0; k <= i; k++) s2 += model.chol[i][k] * eps[k]; return s2; });
      softmax(indUtil({ ...model, th }, X)).forEach((q, i) => samples[i].push(q));
    }
    return H.map((h, i) => { const s = samples[i].sort((a, b) => a - b);
      return { num: h.num, p: p[i], lo: s.length ? s[Math.floor(s.length * 0.025)] : null, hi: s.length ? s[Math.floor(s.length * 0.975)] : null, ct: h.ct, ab: h.ab, pv: h.pv }; });
  }
  // 全部の記録で学習した独自勝率モデル（予想の画面で使う）
  function indBuild(recs){
    const rows = indRows(recs).filter(x => x.full); if (rows.length < 800) return null;
    const m = indFit(rows);
    return { cols: m.cols, th: m.th.map(v => +v.toFixed(5)), mu: m.mu.map(v => +v.toFixed(5)), sd: m.sd.map(v => +v.toFixed(5)), chol: cholCov(m.H, m.cols.length), n: rows.length, upto: rows.reduce((a, x) => x.date > a ? x.date : a, "") };
  }
  // 欠損フラグ（記録なし）の係数が大きいときの確かめ：出走馬全員に材料がそろったレースだけで学習・評価した場合と比べる
  async function completeCase(fullRows, ranges){
    const cc = fullRows.filter(x => !x.miss); if (cc.length < 400) return { races: cc.length, ok: false };
    let n = 0, la = 0, lk = 0, ln = 0, lnk = 0, nn = 0;
    for (const g of ranges){
      const tr = cc.filter(x => x.date < g.from), te = cc.filter(x => x.date >= g.from && x.date <= g.to); if (tr.length < 250 || !te.length) continue;
      const m = indFit(tr);
      te.forEach(x => { const w = x.win.indexOf(true); if (w < 0) return; la -= Math.log(indPredict(m, x)[w]); lk -= Math.log(x.PK[w]); n++; });
      await new Promise(res => setTimeout(res, 0));
    }
    // 同じ期間の、欠損のあるレース（新馬・出走歴の少ない馬がいるレース）での成績
    for (const g of ranges){
      const tr = fullRows.filter(x => x.date < g.from), te = fullRows.filter(x => x.date >= g.from && x.date <= g.to && x.miss); if (tr.length < 500 || !te.length) continue;
      const m = indFit(tr);
      te.forEach(x => { const w = x.win.indexOf(true); if (w < 0) return; ln -= Math.log(indPredict(m, x)[w]); lnk -= Math.log(x.PK[w]); nn++; });
    }
    return { ok: n > 0, races: n, indep: n ? +(la / n).toFixed(4) : null, market: n ? +(lk / n).toFixed(4) : null, missRaces: nn, missIndep: nn ? +(ln / nn).toFixed(4) : null, missMarket: nn ? +(lnk / nn).toFixed(4) : null };
  }
  // 確率の補正（自信過剰の修正）：u に掛ける1つの数 T を、学習期間の新しい側（25%）で決める
  function fitTemp(U){ const ll = T => U.reduce((a, o) => { const p = softmax(o.u.map(v => v * T)); return a - Math.log(Math.max(p[o.w], 1e-12)); }, 0);
    let lo = 0.2, hi = 1.6; for (let k = 0; k < 40; k++){ const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (ll(m1) < ll(m2)) hi = m2; else lo = m1; } return (lo + hi) / 2; }
  function indFitCal(tr){
    const ds = [...new Set(tr.map(x => x.date))], cut = ds[Math.floor(ds.length * 0.75)];
    const A = tr.filter(x => x.date < cut), B = tr.filter(x => x.date >= cut);
    let T = 1;
    if (A.length >= 300 && B.length >= 100){ const mA = indFit(A); T = fitTemp(B.map(x => ({ u: indUtil(mA, x.X), w: x.win.indexOf(true) })).filter(o => o.w >= 0)); }
    return { m: indFit(tr), T };
  }
  // 14. 市場の誤りを直接見分ける：市場の確率（log）を前提の材料として入れ、それ以外の材料で「市場からのずれ」だけを学習する（各期間それより前のレースだけ）。
  // 上乗せ（市場だけのモデルとの差）が大きい馬ほど回収率が上がれば、市場が間違えるケースを見分けられている。
  async function marketEdgeReport(fullRows, ranges){
    const aug = x => ({ ...x, X: x.X.map((v, i) => [Math.log(Math.max(x.PK[i], 1e-6)), ...v]) });
    const rows = fullRows.map(aug);
    const EB = [0, 0.9, 1.0, 1.1, 1.25, 1e9], EBL = ["0.9倍未満", "0.9〜1.0倍", "1.0〜1.1倍", "1.1〜1.25倍", "1.25倍以上"];
    const B = EB.slice(0, -1).map(() => ({ n: 0, hit: 0, ret: 0, ret2: 0, per: ranges.map(() => ({ n: 0, ret: 0 })) })), B10 = EB.slice(0, -1).map(() => ({ n: 0, hit: 0, ret: 0, ret2: 0, per: ranges.map(() => ({ n: 0, ret: 0 })) }));
    const difs = [], folds = [];
    for (let f = 0; f < ranges.length; f++){
      const g = ranges[f], tr = rows.filter(x => x.date < g.from), te = rows.filter(x => x.date >= g.from && x.date <= g.to);
      if (tr.length < 500 || !te.length) continue;
      const m = indFit(tr), m0 = indFit(tr, [0]);
      let fd = 0, fn = 0;
      te.forEach(x => { const p = softmax(indUtil(m, x.X)), p0 = softmax(indUtil(m0, x.X)), w = x.win.indexOf(true);
        if (w >= 0){ const d = Math.log(p[w]) - Math.log(p0[w]); difs.push(d); fd += d; fn++; }
        p.forEach((q, i) => { const e = q / p0[i], bi = EB.findIndex((b, k) => e >= b && e < EB[k + 1]), ret = x.win[i] ? x.odds[i] : 0;
          for (const BB of (x.odds[i] >= 10 ? [B, B10] : [B])){ const o = BB[bi]; o.n++; if (ret){ o.hit++; o.ret += ret; o.ret2 += ret * ret; } o.per[f].n++; o.per[f].ret += ret; } }); });
      folds.push({ from: g.from, gain: fn ? +(fd / fn * 1000).toFixed(2) : null });
      await new Promise(res => setTimeout(res, 0));
    }
    if (!difs.length) return null;
    const md = difs.reduce((a, b) => a + b, 0) / difs.length, sd = Math.sqrt(difs.reduce((a, b) => a + (b - md) ** 2, 0) / Math.max(1, difs.length - 1));
    const fin = BB => BB.map((o, i) => { if (!o.n) return { band: EBL[i], n: 0 }; const m = o.ret / o.n, se = Math.sqrt(Math.max(0, o.ret2 / o.n - m * m) / o.n);
      return { band: EBL[i], n: o.n, hits: o.hit, roi: +m.toFixed(3), lo95: +Math.max(0, m - 1.96 * se).toFixed(3), hi95: +(m + 1.96 * se).toFixed(3), per: o.per.map(p => p.n >= 30 ? +(p.ret / p.n).toFixed(2) : null), perN: o.per.map(p => p.n) }; });
    const final = indFit(rows);
    return { races: difs.length, gain: +(md * 1000).toFixed(2), z: sd > 0 ? +(md / (sd / Math.sqrt(difs.length))).toFixed(2) : null, folds, bands: fin(B), bands10: fin(B10),
      coef: final.cols.slice(1).map((c, j) => [IND_NAMES[c - 1], +final.th[j + 1].toFixed(3)]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 10) };
  }
  async function indepReport(R, ranges){
    const rows = indRows(R), fullRows = rows.filter(x => x.full);
    if (fullRows.length < 800) return { ready: false, n: fullRows.length };
    const inR = (x, g) => x.date >= g.from && x.date <= g.to;
    const RB = [0, 1, 1.2, 1.5, 2, 3, 1e9], RBL = ["市場以下（1倍未満）", "1〜1.2倍", "1.2〜1.5倍", "1.5〜2倍", "2〜3倍", "3倍以上"];
    const mk = () => RB.slice(0, -1).map(() => ({ seq: [], top3: 0, odds: 0, per: ranges.map(() => ({ n: 0, ret: 0 })) }));
    const B = mk(), B10 = mk(), cal = CAL_B.slice(0, -1).map((lo, i) => ({ lo, hi: CAL_B[i + 1], n: 0, p: 0, w: 0 }));
    const mods = IND_MODULES.map(([name]) => ({ name, ll: 0, n: 0 }));
    let n = 0, llA = 0, llK = 0, llM = 0, llU = 0, llRaw = 0; const folds = [];
    for (let f = 0; f < ranges.length; f++){
      const g = ranges[f], tr = fullRows.filter(x => x.date < g.from), te = fullRows.filter(x => inR(x, g));
      if (tr.length < 500 || !te.length) continue;
      const { m, T } = indFitCal(tr), mm = IND_MODULES.map(([, cols]) => indFit(tr, cols));
      let fa = 0, fk = 0, fn = 0;
      te.forEach(x => { const U = indUtil(m, x.X), P = softmax(U.map(v => v * T)), P1 = softmax(U), w = x.win.indexOf(true);
        if (w >= 0){ const a = -Math.log(P[w]), k = -Math.log(x.PK[w]); llA += a; llRaw -= Math.log(P1[w]); llK += k; llM -= Math.log(x.PM[w]); llU += Math.log(x.n); fa += a; fk += k; n++; fn++;
          mm.forEach((md, q) => { mods[q].ll -= Math.log(indPredict(md, x)[w]); mods[q].n++; }); }
        P.forEach((p, i) => { const c = cal.find(b => p >= b.lo && p < b.hi); if (c){ c.n++; c.p += p; if (x.win[i]) c.w++; }
          const ratio = p / x.PK[i], bi = RB.findIndex((b, k2) => ratio >= b && ratio < RB[k2 + 1]); const ret = x.win[i] ? x.odds[i] : 0;
          for (const BB of (x.odds[i] >= 10 ? [B, B10] : [B])){ const o = BB[bi]; o.seq.push(ret); o.odds += x.odds[i]; if (x.top3[i]) o.top3++; o.per[f].n++; o.per[f].ret += ret; } }); });
      folds.push({ from: g.from, to: g.to, train: tr.length, test: te.length, T: +T.toFixed(2), gain: fn ? +((fk - fa) / fn).toFixed(4) : null });
      await new Promise(res => setTimeout(res, 0));
    }
    if (!n) return { ready: false, n: fullRows.length };
    const fin = BB => BB.map((o, i) => { const N = o.seq.length; if (!N) return { band: RBL[i], n: 0 };
      let s = 0, s2 = 0, hit = 0, bal = 0, peak = 0, dd = 0, st = 0, maxL = 0;
      o.seq.forEach(v => { s += v; s2 += v * v; if (v > 0){ hit++; st = 0; } else maxL = Math.max(maxL, ++st); bal += (v - 1) * 100; peak = Math.max(peak, bal); dd = Math.max(dd, peak - bal); });
      const m = s / N, se = Math.sqrt(Math.max(0, s2 / N - m * m) / N);
      return { band: RBL[i], n: N, hits: hit, perN: o.per.map(p => p.n), winRate: +(hit / N).toFixed(4), top3Rate: +(o.top3 / N).toFixed(4), avgOdds: +(o.odds / N).toFixed(1), roi: +m.toFixed(3), lo95: +Math.max(0, m - 1.96 * se).toFixed(3), hi95: +(m + 1.96 * se).toFixed(3),
        maxLose: maxL, maxDD: Math.round(dd), per: o.per.map(p => p.n >= 30 ? +(p.ret / p.n).toFixed(2) : null) }; });
    // 乖離が大きいほど回収率が上がるか（帯の順位と回収率の順位の相関・頭数100以上の帯だけ）
    const bands = fin(B), use = bands.filter(b => b.n >= 100);
    const mono = use.length >= 3 ? (() => { let c = 0, t = 0; for (let i = 0; i < use.length; i++) for (let j = i + 1; j < use.length; j++){ t++; if (use[j].roi > use[i].roi) c++; } return +(c / t).toFixed(2); })() : null;
    const final = indFit(fullRows);
    const hN = fullRows.reduce((a, x) => a + x.n, 0), pvN = fullRows.reduce((a, x) => a + x.pv.filter(v => v && v[0] != null && v[2] != null).length, 0);
    return { ready: true, n: fullRows.length, races: n, prevCover: { horses: hN, withPrev: pvN, rate: hN ? +(pvN / hN).toFixed(3) : 0 }, ll: { indep: +(llA / n).toFixed(4), raw: +(llRaw / n).toFixed(4), market: +(llK / n).toFixed(4), engine: +(llM / n).toFixed(4), uniform: +(llU / n).toFixed(4) }, folds, edge: await marketEdgeReport(fullRows, ranges),
      modules: mods.map(q => ({ name: q.name, ll: q.n ? +(q.ll / q.n).toFixed(4) : null })),
      calib: cal.filter(c => c.n).map(c => ({ range: `${Math.round(c.lo * 100)}〜${Math.round(Math.min(c.hi, 1) * 100)}%`, n: c.n, pred: +(c.p / c.n).toFixed(4), actual: +(c.w / c.n).toFixed(4) })),
      bands, bands10: fin(B10), mono,
      stage1: contentStage1(rows, ranges, R), complete: await completeCase(fullRows, ranges),
      coef: final.cols.map((c, j) => [IND_NAMES[c], +final.th[j].toFixed(3)]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12) };
  }
  // 前走の「見かけの着順」と「実際の走り」のずれが、次走で市場の期待以上に走るか（仕様のStage 1・既存データだけ）
  // 注意：「市場の期待」は単勝オッズから計算した3着以内の確率（Harville）で、差し・追込の馬の2・3着を低めに見積もるくせがある。
  // そのため比較用に「普段後方の馬すべて」などの行を並べ、さらに実際の複勝・単勝の払戻で回収率を確かめる（お金になるかの最終判定）。
  function contentStage1(rows, ranges, R){
    const plOf = {}; (R || []).forEach(r => r.h.forEach(h => { if ("plp" in h) plOf[r.id + "|" + h.num] = h.plp; }));
    const items = [];
    rows.forEach(x => { const t3 = top3FromMarket(x.PK);
      x.ct.forEach((ct, i) => { if (!ct) return; const ab = x.ab[i], num = x.nums?.[i];
        items.push({ date: x.date, ct, rate: ab?.[0], mg: ab?.[3], ep: x.ep?.[i], pv: x.pv?.[i] || null, hit: x.top3[i], win: x.win[i], e: t3[i], odds: x.odds[i], plp: num != null ? plOf[x.id + "|" + num] : undefined }); }); });
    if (items.length < 2000) return null;
    const inR = (x, g) => x.date >= g.from && x.date <= g.to;
    const ratioOf = S => { const h = S.filter(x => x.hit).length, e = S.reduce((a, x) => a + x.e, 0); return e > 0 ? h / e : 1; };
    const r0 = ratioOf(items);
    const lost = x => x.rate != null && x.rate >= 0.5, l3 = (x, t) => x.ct[2] != null && x.ct[2] <= t, mg = (x, t) => x.mg != null && x.mg <= t;
    const DEF = [
      ["（比較用）全馬", () => true],
      ["（比較用）普段後方の馬すべて（普段の1角が後ろ1/3）", x => x.ep != null && x.ep >= 0.67],
      ["（比較用）普段先行の馬すべて（普段の1角が前1/3）", x => x.ep != null && x.ep < 0.33],
      ["前走 下位半分 × 上がりが普段より0.3秒以上速い", x => lost(x) && l3(x, -0.3)],
      ["前走 下位半分 × 上がりが0.5秒以上速い", x => lost(x) && l3(x, -0.5)],
      ["前走 下位半分 × 上がりが0.8秒以上速い", x => lost(x) && l3(x, -0.8)],
      ["前走 下位半分 × 上がりが1.2秒以上速い", x => lost(x) && l3(x, -1.2)],
      ["前走 下位半分 × 着差1.0秒以内", x => lost(x) && mg(x, 1.0)],
      ["前走 下位半分 × 着差0.5秒以内", x => lost(x) && mg(x, 0.5)],
      ["前走 下位半分 × 上がり0.5秒以上速い × 着差1.0秒以内", x => lost(x) && l3(x, -0.5) && mg(x, 1.0)],
      ["前走 下位4割 × 上がり0.5秒以上速い", x => x.rate != null && x.rate >= 0.6 && l3(x, -0.5)],
      ["前走 下位半分 × 4角から頭数の15%以上伸びた（着順と4角の順位のずれ）", x => lost(x) && x.ct[1] != null && x.ct[1] >= 0.15],
      ["前走 道中で頭数の25%以上押し上げた（1角→4角）", x => x.ct[3] != null && x.ct[3] >= 0.25],
      ["前走 道中で頭数の25%以上下がった", x => x.ct[3] != null && x.ct[3] <= -0.25],
      ["前走 道中で押し上げた × 下位半分（積極策で負けた）", x => x.ct[3] != null && x.ct[3] >= 0.25 && lost(x)],
      ["普段後方の馬だけ：前走 下位半分 × 上がり0.5秒以上速い", x => x.ep != null && x.ep >= 0.67 && lost(x) && l3(x, -0.5)],
      ["前走 上がり3位以内 × 下位半分", x => x.pv?.[5] != null && x.pv[5] <= 3 && lost(x)],
      ["前走 上がり1位 × 6着以下", x => x.pv?.[5] === 1 && x.pv[6] >= 6],
      ["前走 上がり順位が着順より頭数の30%以上よい", x => x.pv?.[1] != null && x.pv[1] >= 0.3],
      ["前走 前に行って（1角前1/3）ハイペース × 下位半分", x => x.pv?.[7] != null && x.pv[2] != null && x.pv[7] < 0.33 && x.pv[2] <= -0.7 && lost(x)],
      ["前走 後方から（1角後ろ1/3）スロー × 下位半分", x => x.pv?.[7] != null && x.pv[2] != null && x.pv[7] >= 0.67 && x.pv[2] >= 0.7 && lost(x)],
      ["前走 展開不利の指数0.3以上 × 下位半分", x => x.pv?.[4] != null && x.pv[4] >= 0.3]
    ];
    const nTests = DEF.length - 3, zB = invNorm(0.05 / (2 * nTests));
    const money = S => { const P = S.filter(x => x.plp !== undefined); const roi = (arr, f) => { if (!arr.length) return null; const v = arr.map(f), m = v.reduce((a, b) => a + b, 0) / v.length, se = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1) / v.length); return { n: arr.length, roi: +m.toFixed(3), lo95: +Math.max(0, m - 1.96 * se).toFixed(3), hi95: +(m + 1.96 * se).toFixed(3) }; };
      return { place: roi(P, x => x.plp), win: roi(S, x => x.win ? x.odds : 0) }; };
    const base = money(items);
    const out = DEF.map(([label, pred], k) => { const S = items.filter(pred); if (S.length < 30) return null;
      const hit = S.filter(x => x.hit).length, E = S.reduce((a, x) => a + x.e, 0) * r0, V = S.reduce((a, x) => a + x.e * r0 * (1 - Math.min(0.99, x.e * r0)), 0);
      const per = ranges.map(g => { const F = S.filter(x => inR(x, g)); if (F.length < 30) return null; const all = items.filter(x => inR(x, g)), rr = ratioOf(all); const h = F.filter(x => x.hit).length, e = F.reduce((a, x) => a + x.e, 0) * rr; return +((h + 1) / (e + 1)).toFixed(2); });
      const perPl = ranges.map(g => { const F = S.filter(x => inR(x, g) && x.plp !== undefined); return F.length >= 30 ? +(F.reduce((a, x) => a + x.plp, 0) / F.length).toFixed(2) : null; });
      const ls = per.filter(v => v != null), same = ls.length >= 3 && (ls.every(v => v > 1) || ls.every(v => v < 1)), z = V > 0 ? (hit - E) / Math.sqrt(V) : 0, m = money(S);
      const isRef = k < 3;
      return { label, ref: isRef, n: S.length, hit, exp: +E.toFixed(1), lift: +((hit + 1) / (E + 1)).toFixed(2), z: +z.toFixed(2), per, perPl, place: m.place, win: m.win,
        verdict: isRef ? "比較用" : (Math.abs(z) >= zB && same ? "市場の期待とのずれは偶然でない" : Math.abs(z) >= 2 && same ? "候補（多重比較を考えると弱い）" : "偶然と区別できない")
          + (isRef ? "" : m.place && m.place.lo95 >= 1 ? "・複勝でお金になる" : m.place && m.place.roi >= 1 ? "・複勝の回収率は100%超だが偶然の範囲" : m.place && base.place && m.place.roi > base.place.roi + 0.05 ? "・複勝の回収率は全馬より上（ただし100%未満）" : "・複勝ではお金にならない") };
    }).filter(Boolean);
    // 前走内容スコア（ウォークフォワード）：市場の期待（Harville）と脚質（普段の位置）を前提に、前走の内容が上乗せになるか
    const feat = x => [x.ct[0] ?? 0, x.ct[1] ?? 0, x.ct[2] ?? 0, x.ct[3] ?? 0, x.rate ?? .5, Math.min(5, x.mg ?? 1), lost(x) && l3(x, -0.5) ? 1 : 0, ...prevVec(x.pv)];
    const ctrl = x => [x.ep ?? .5, x.ep == null ? 1 : 0];
    const logit = p => { const q = Math.min(0.999, Math.max(1e-5, p)); return Math.log(q / (1 - q)); };
    const qs = [0, 0.2, 0.4, 0.6, 0.8, 1.0001], Q = qs.slice(0, -1).map(() => ({ n: 0, hit: 0, e: 0, pl: 0, npl: 0 }));
    const difs = [], folds = [];
    ranges.forEach(g => {
      const tr = items.filter(x => x.date < g.from), te = items.filter(x => inR(x, g)); if (tr.length < 3000 || !te.length) return;
      const rr = ratioOf(tr), off = x => logit(Math.min(0.95, x.e * rr));
      const m = lsLogit(tr.map(x => [...feat(x), ...ctrl(x)]), tr.map(off), tr.map(x => x.hit ? 1 : 0), 30), m0 = lsLogit(tr.map(ctrl), tr.map(off), tr.map(x => x.hit ? 1 : 0), 30);
      const sc = te.map(x => { const p = lsPredRow(m, [...feat(x), ...ctrl(x)], off(x)), p0 = lsPredRow(m0, ctrl(x), off(x)); difs.push(x.hit ? Math.log(p / p0) : Math.log((1 - p) / (1 - p0))); return p / p0; });
      const sorted = sc.slice().sort((a, b) => a - b), cut = qs.map(q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
      const rte = ratioOf(te);
      te.forEach((x, i) => { let k = cut.findIndex((c, j) => j < 5 && sc[i] >= c && sc[i] < (j === 4 ? Infinity : cut[j + 1])); if (k < 0) k = 4; const o = Q[k]; o.n++; if (x.hit) o.hit++; o.e += x.e * rte; if (x.plp !== undefined){ o.pl += x.plp; o.npl++; } });
      folds.push({ from: g.from, n: te.length });
    });
    let score = null;
    if (difs.length){ const md = difs.reduce((a, b) => a + b, 0) / difs.length, sd = Math.sqrt(difs.reduce((a, b) => a + (b - md) ** 2, 0) / Math.max(1, difs.length - 1));
      score = { n: difs.length, gain: +(md * 1000).toFixed(2), z: sd > 0 ? +(md / (sd / Math.sqrt(difs.length))).toFixed(2) : null,
        quint: Q.map((o, k) => ({ q: ["下位20%", "20〜40%", "40〜60%", "60〜80%", "上位20%"][k], n: o.n, lift: o.e ? +(o.hit / o.e).toFixed(2) : null, placeROI: o.npl ? +(o.pl / o.npl).toFixed(3) : null })) }; }
    return { rows: out, zB: +zB.toFixed(2), base, score, plN: items.filter(x => x.plp !== undefined).length, n: items.length };
  }


  async function report(recs, opt = {}){
    const folds = opt.folds || 5, initFrac = opt.initFrac ?? 0.4;
    const R = recs.filter(r => r.h?.length >= 5 && r.order?.length).slice().sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
    if (R.length < 100) return { ok: false, n: R.length };
    const dates = [...new Set(R.map(r => r.date))];
    const testDates = dates.slice(Math.max(1, Math.floor(dates.length * initFrac)));
    const per = Math.ceil(testDates.length / folds);
    const testAll = R.filter(r => r.date >= testDates[0]), cleanTest = testAll.filter(clean).length;
    // 検証に使う記録：作り直し済み（未来の情報なしと確認できる）記録が200レース以上あれば、それだけで測る
    const strict = opt.strict ?? cleanTest >= 200;
    const A = newAcc(), foldRows = [], ranges = [];
    for (let f = 0; f < folds; f++){
      const fd = testDates.slice(f * per, (f + 1) * per); if (!fd.length) continue;
      const from = fd[0], to = fd[fd.length - 1];
      ranges.push({ from, to });
      const train = R.filter(r => r.date < from), test = R.filter(r => r.date >= from && r.date <= to && (!strict || clean(r)));
      if (!test.length) continue;
      const th = fit(train), a = th[0], b = th[1];
      const F = newAcc(); test.forEach(r => { evalRace(r, a, b, F); evalRace(r, a, b, A); });
      const fr = finAcc(F), t11 = fr.thresholds.find(t => t.t === 1.1);
      foldRows.push({ from, to, train: train.length, test: F.races, a: +a.toFixed(3), b: +b.toFixed(3), ll: fr.ll, bets11: t11.n, roi11: t11.roi ?? null,
        cap4: fr.capture.pop4?.at[0] || null, cap10: fr.capture.pop10?.at[0] || null });
      await new Promise(res => setTimeout(res, 0));     // 画面を固めない
    }
    return { ok: true, total: R.length, from: testDates[0], strict, cleanTest, testAll: testAll.length, cleanAll: R.filter(clean).length,
      ...finAcc(A), folds: foldRows, factors: { pop10: factorStats(R, 10, 99), pop4: factorStats(R, 4, 9) }, position: positionReport(R, ranges, 10), tempered: temperReport(R, ranges), ability: abilityReport(R, ranges, 10), combo: comboReport(R, ranges, 10), strategy: strategyReport(R, ranges, foldRows.map(f => ({ from: f.from, to: f.to, a: f.a, b: f.b }))), indep: await indepReport(R, ranges) };
  }

  // 正則化つきロジスティック回帰（オフセット＝オッズから見た確率のlogit。係数は x を標準化した単位）
  function lsLogit(X, off, y, lam){
    const n = X.length, K = X[0].length;
    const mu = new Array(K).fill(0), sd = new Array(K).fill(1);
    for (let k = 0; k < K; k++){ let s = 0; for (const x of X) s += x[k]; mu[k] = s / n; let v = 0; for (const x of X) v += (x[k] - mu[k]) ** 2; sd[k] = Math.sqrt(v / n) || 1; }
    const Z = X.map(x => [1, ...x.map((v, k) => (v - mu[k]) / sd[k])]);
    let b = new Array(K + 2).fill(0); b[K + 1] = 1;               // 最後がオフセットの係数（初期値1）
    for (let it = 0; it < 25; it++){
      const g = new Array(K + 2).fill(0), H = Array.from({ length: K + 2 }, () => new Array(K + 2).fill(0));
      for (let i = 0; i < n; i++){
        const z = [...Z[i], off[i]]; let e = 0; for (let k = 0; k < K + 2; k++) e += b[k] * z[k];
        const p = 1 / (1 + Math.exp(-e)), w = p * (1 - p);
        for (let k = 0; k < K + 2; k++){ g[k] += (y[i] - p) * z[k]; for (let l = 0; l < K + 2; l++) H[k][l] += w * z[k] * z[l]; }
      }
      for (let k = 1; k <= K; k++){ g[k] -= lam * b[k]; H[k][k] += lam; }      // 特徴の係数だけ0に引き寄せる
      H[0][0] += 1e-6; H[K + 1][K + 1] += 1e-6;
      const st = solve(H, g); b = b.map((v, k) => v + st[k]);
      if (Math.max(...st.map(Math.abs)) < 1e-7) break;
    }
    return { b, mu, sd };
  }
  function lsPredRow(m, x, off){ let e = m.b[0] + m.b[m.b.length - 1] * off; x.forEach((v, k) => e += m.b[k + 1] * (v - m.mu[k]) / m.sd[k]); return 1 / (1 + Math.exp(-e)); }


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

  return { RV, report, clean, posFill, livePredict, prevBuilder, indBuild, crossCompact, crossReport, crossTickets, crossFitBeta, top3FromMarket, isLong, bodyWeightEffects, bwFeatures, FEATS, record, fit, build, merge, bias, logloss, recordsForRaces, analyzeUpsets, upsetStats, paperStats };
})();
if (typeof module !== "undefined") module.exports = Learn;
