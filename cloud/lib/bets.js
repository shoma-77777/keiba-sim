// ===== 期待値ベースの馬券配分 =====
const Bets = (() => {
  const TAKE = { 単勝: 0.20, 複勝: 0.20, 馬連: 0.225, ワイド: 0.225, 馬単: 0.25, 三連複: 0.25 };
  const MIN_P = { 単勝: 0.02, 複勝: 0.08, 馬連: 0.01, ワイド: 0.03, 馬単: 0.006, 三連複: 0.006 };
  const EV_MIN = 1.10;   // モデル誤差を見込んだ購入ライン

  // シミュレーション結果から組合せ確率（モデル）を集計
  function modelProbs(res, N){
    N = N || res.stats.length; const R = res.runs, o = res.orders, W = res.w;
    const win = new Float64Array(N), place = new Float64Array(N);
    const pair = new Float64Array(N * N), wide = new Float64Array(N * N), trio = new Float64Array(N * N * N), exacta = new Float64Array(N * N);
    const placeK = N <= 7 ? 2 : 3;
    let tw = 0;
    for (let r = 0; r < R; r++){
      const a = o[r*N], b = o[r*N+1], c = o[r*N+2], q = W ? W[r] : 1; tw += q;
      win[a] += q;
      place[a] += q; place[b] += q; if (placeK === 3) place[c] += q;
      const [x, y] = a < b ? [a, b] : [b, a]; pair[x*N + y] += q; exacta[a*N + b] += q;
      const t = [a, b, c].sort((m, n) => m - n);
      wide[t[0]*N + t[1]] += q; wide[t[0]*N + t[2]] += q; wide[t[1]*N + t[2]] += q;
      trio[(t[0]*N + t[1])*N + t[2]] += q;
    }
    const d = arr => arr.map(v => v / tw);
    return { N, win: d(win), place: d(place), pair: d(pair), wide: d(wide), trio: d(trio), exacta: d(exacta), placeK };
  }

  // 単勝オッズ → 市場確率 → Harville で組合せの市場確率
  function marketProbs(odds){
    const inv = odds.map(x => 1 / x), s = inv.reduce((a, b) => a + b, 0), p = inv.map(x => x / s), N = p.length;
    // 2着・3着は人気薄にも確率を回す補正（Lo–Bacon-Shone 型：λ2=0.81, λ3=0.65）
    const pw = l => { const q = p.map(x => Math.pow(x, l)); const t = q.reduce((a, b) => a + b, 0); return q.map(x => x / t); };
    const p2 = pw(0.81), p3 = pw(0.65);
    const ord = (a, b, c) => p[a] * (p2[b] / (1 - p2[a])) * (p3[c] / (1 - p3[a] - p3[b]));
    const set3 = (a, b, c) => ord(a,b,c) + ord(a,c,b) + ord(b,a,c) + ord(b,c,a) + ord(c,a,b) + ord(c,b,a);
    const pair = new Float64Array(N * N), wide = new Float64Array(N * N), trio = new Float64Array(N * N * N), place = new Float64Array(N);
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++){
      pair[i*N + j] = p[i] * p2[j] / (1 - p2[i]) + p[j] * p2[i] / (1 - p2[j]);
      for (let k = j + 1; k < N; k++){
        const q = set3(i, j, k); trio[(i*N + j)*N + k] = q;
        wide[i*N + j] += q; wide[i*N + k] += q; wide[j*N + k] += q;
        place[i] += q; place[j] += q; place[k] += q;
      }
    }
    return { p, pair, wide, trio, place };
  }
  // 実際の複勝オッズがあれば、複勝の市場確率に合うようワイド・3連複の市場確率を補正
  function calibrateToPlace(K, field){
    const N = K.p.length;
    if (field.filter(f => f.placeLo > 0).length < N * 0.75) return;
    const mid = field.map((f, i) => f.placeLo > 0 ? (f.placeLo + (f.placeHi || f.placeLo)) / 2 : (1 - TAKE.複勝) / Math.max(1e-6, K.place[i]));
    const inv = mid.map(x => 1 / x), s = inv.reduce((a, b) => a + b, 0);
    const target = inv.map(x => x / s * (N <= 7 ? 2 : 3));
    const r = target.map((t, i) => K.place[i] > 0 ? t / K.place[i] : 1);
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++){
      K.wide[i*N + j] *= Math.sqrt(r[i] * r[j]); K.pair[i*N + j] *= Math.sqrt(r[i] * r[j]);
      for (let k = j + 1; k < N; k++) K.trio[(i*N + j)*N + k] *= Math.cbrt(r[i] * r[j] * r[k]);
    }
    K.place = target;
  }

  // ===== モデルと市場の統合（ベンター型） =====
  // 単勝・複勝それぞれ「モデル確率^(1-β) × 市場確率^β」に統合し、シミュレーションの各回に重みを付けて
  // 1着・3着内の確率がこの統合確率に合うように調整する（着順の組み合わせ構造はシミュレーションのまま）。
  // 市場確率は大穴が過大評価されやすい（本命・大穴バイアス）ので、オッズの逆数を1.1乗して補正。
  // 統合：目標確率 ∝ p_model^A × p_market^B（A, B は答え合わせの蓄積から学習。初期値は A=0.5, B=0.55）
  let CAL = { a: 0.5, b: 0.55, learned: false, races: 0 };
  let BETA = null;              // 手動で「市場を信じる割合」を選んだときだけ使う（null=学習値）
  function setMarketBeta(b){ BETA = (b == null || b === "auto") ? null : (b >= 0 && b <= 1 ? +b : BETA); }
  function setCalibration(c){ if (c && c.a >= 0 && c.b >= 0) CAL = { ...CAL, ...c, learned: true }; }
  const exps = () => BETA == null ? { a: CAL.a, b: CAL.b } : { a: 1 - BETA, b: BETA * 1.1 };
  function blendWeights(ctx, res, odds){
    const N = ctx.N, R = res.runs, o = res.orders, f = ctx.field, placeK = N <= 7 ? 2 : 3;
    const norm = (a, tot) => { const s = a.reduce((x, y) => x + y, 0) || 1; return a.map(x => x / s * tot); };
    const mWin = norm(odds.map(x => 1 / x), 1);
    const { a: EA, b: EB } = exps();
    const hasPlace = f.filter(x => x.placeLo > 0).length >= N * 0.75;
    const w = new Float64Array(R).fill(1);
    const marg = () => { const W1 = new Float64Array(N), P1 = new Float64Array(N); let t = 0;
      for (let r = 0; r < R; r++){ const q = w[r]; t += q; W1[o[r*N]] += q; for (let k = 0; k < placeK; k++) P1[o[r*N+k]] += q; }
      return { win: Array.from(W1, x => x / t), place: Array.from(P1, x => x / t) }; };
    const m0 = marg();
    const comb = (pm, pk) => pm.map((x, i) => Math.pow(Math.max(x, 1e-5), EA) * Math.pow(Math.max(pk[i], 1e-5), EB));
    const tWin = norm(comb(m0.win, mWin), 1);
    let tPlace = null;
    if (hasPlace){
      const mid = f.map((x, i) => x.placeLo > 0 ? (x.placeLo + (x.placeHi || x.placeLo)) / 2 : null);
      const mx = Math.max(...mid.filter(Boolean));
      const mPl = norm(mid.map(v => 1 / (v || mx * 2)), placeK);
      tPlace = norm(comb(m0.place, mPl), placeK).map(x => Math.min(0.97, x));
    }
    for (let it = 0; it < 6; it++){
      if (tPlace){
        const m = marg(), fac = tPlace.map((t, i) => m.place[i] > 1e-6 ? Math.pow(t / m.place[i], 0.7) : 1);
        for (let r = 0; r < R; r++){ let g = 1; for (let k = 0; k < placeK; k++) g *= fac[o[r*N+k]]; w[r] *= Math.pow(g, 1 / placeK); }
      }
      const m = marg(), fw = tWin.map((t, i) => m.win[i] > 1e-6 ? t / m.win[i] : 1);
      for (let r = 0; r < R; r++) w[r] *= fw[o[r*N]];
    }
    let s = 0; for (let r = 0; r < R; r++) s += w[r];
    for (let r = 0; r < R; r++) w[r] *= R / s;
    let s2 = 0; for (let r = 0; r < R; r++) s2 += w[r] * w[r];
    return { w, ess: R * R / s2, modelWin: m0.win, marketWin: mWin, finalWin: tWin };
  }

  // 候補の買い目を列挙（期待値 = 統合確率 × 払戻倍率）
  //  ・馬連/ワイド/3連複は実オッズ（race.comboOdds）があればそれを使い、なければ単勝オッズから控えめに推定
  //  ・モンテカルロの誤差を見込んだ「控えめな期待値」evL（確率を1標準誤差だけ下げて計算）も持つ
  function candidates(ctx, res){
    const N = ctx.N, f = ctx.field;
    const nOdds = f.filter(x => x.odds > 1).length;
    if (nOdds < 2 || nOdds < N * 0.75) return null;
    const mx = Math.max(...f.map(x => x.odds > 1 ? x.odds : 0));
    const odds = f.map(x => x.odds > 1 ? x.odds : Math.max(mx * 2, 100));
    const B = blendWeights(ctx, res, odds);
    const wres = { orders: res.orders, runs: res.runs, w: B.w, ess: B.ess };
    const M = modelProbs(wres, N), K = marketProbs(odds);
    calibrateToPlace(K, f);
    const R = B.ess, CO = ctx.race?.comboOdds || {};
    const real = { 馬連: !!CO.馬連, ワイド: !!CO.ワイド, 馬単: !!CO.馬単, 三連複: !!CO.三連複 };
    const out = [];
    const push = (type, idx, p, odds, est, hi) => {
      if (p < MIN_P[type] || !(odds > 1)) return;
      odds = Math.round(odds * 10) / 10;
      const se = Math.sqrt(p * (1 - p) / R);
      out.push({ type, idx, nums: idx.map(i => f[i].num), p, odds, oddsHi: hi || null, est, ev: p * odds, evL: Math.max(0, p - se) * odds, kelly: (p * odds - 1) / (odds - 1) });
    };
    for (let i = 0; i < N; i++){
      if (!(f[i].odds > 1)) continue;          // オッズ不明の馬の単複は買わない
      push("単勝", [i], M.win[i], f[i].odds, false);
      if (f[i].placeLo > 0) push("複勝", [i], M.place[i], f[i].placeLo, false, f[i].placeHi);
    }
    const est = (q, t) => Math.max(1.5, Math.round((1 - TAKE[t]) / q * 0.85 * 10) / 10);   // 推定配当は控えめに（×0.85）
    const key = idx => idx.map(i => f[i].num).sort((a, b) => a - b).join("-");
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++){
      const k2 = key([i, j]);
      // 組み合わせ馬券は実オッズがあるときだけ（推定配当は誤差が大きく、期待値を過大に見積もるため買わない）
      if (real.馬連){ const v = CO.馬連[k2]; if (v) push("馬連", [i, j], M.pair[i*N + j], v, false); }
      if (real.ワイド){ const v = CO.ワイド[k2]; if (v) push("ワイド", [i, j], M.wide[i*N + j], Array.isArray(v) ? v[0] : v, false, Array.isArray(v) ? v[1] : null); }
      if (real.馬単){
        const v1 = CO.馬単[`${f[i].num}-${f[j].num}`], v2 = CO.馬単[`${f[j].num}-${f[i].num}`];
        if (v1) push("馬単", [i, j], M.exacta[i*N + j], v1, false);
        if (v2) push("馬単", [j, i], M.exacta[j*N + i], v2, false);
      }
      if (real.三連複) for (let k = j + 1; k < N; k++){ const v = CO.三連複[key([i, j, k])]; if (v) push("三連複", [i, j, k], M.trio[(i*N + j)*N + k], v, false); }
    }
    return { list: out.sort((a, b) => b.ev - a.ev), M, K, real, wres, blend: B };
  }

  function hits(t, o, N, R, placeK, step){
    const h = [];
    const a0 = t.idx[0], a1 = t.idx[1], a2 = t.idx[2];
    for (let r = 0, m = 0; r < R; r += step, m++){
      const x = o[r*N], y = o[r*N+1], z = o[r*N+2];
      let ok = false;
      if (t.type === "単勝") ok = x === a0;
      else if (t.type === "複勝") ok = x === a0 || y === a0 || (placeK === 3 && z === a0);
      else if (t.type === "馬連") ok = (x === a0 && y === a1) || (x === a1 && y === a0);
      else if (t.type === "馬単") ok = x === a0 && y === a1;
      else if (t.type === "ワイド") ok = (x === a0 || y === a0 || z === a0) && (x === a1 || y === a1 || z === a1);
      else if (t.type === "三連複") ok = (x === a0 || y === a0 || z === a0) && (x === a1 || y === a1 || z === a1) && (x === a2 || y === a2 || z === a2);
      if (ok) h.push(m);
    }
    return Int32Array.from(h);
  }

  // 予算の配分：シミュレーションの着順（数千〜1万レース分）の上で、資金の対数の期待値（＝長期の資金成長率）を最大にする
  // ケリー基準を、券種どうしの相関（同じレースで同時に当たる・外れる）も含めて100円単位の貪欲法で厳密に解く。
  // 資金は予算の10倍（1レースに資金の1割を使う）と仮定。
  const BANK_MUL = 10;
  function plan(ctx, res, budget, cands){
    if (!cands) return { noOdds: true };
    res = cands.wres; const RW = res.w;
    const units = Math.floor(budget / 100), N = ctx.N, R = res.runs, placeK = N <= 7 ? 2 : 3;
    const maxBets = budget <= 1000 ? 5 : 10;
    const good = cands.list.filter(c => c.ev >= EV_MIN && c.evL >= 1.0);
    const evmax = planEVMax(cands, budget, cands.wres, N);
    if (!good.length){
      const ref = cands.list.slice().sort((a, b) => b.ev - a.ev).slice(0, 3);
      return { none: true, ref, evmax };
    }
    const pool = good.sort((a, b) => b.evL - a.evL).slice(0, 40);
    const step = Math.max(1, Math.floor(R / 6000)), Msz = Math.ceil(R / step);
    const H = pool.map(c => hits(c, res.orders, N, R, placeK, step));
    const W = new Float64Array(Msz).fill(budget * BANK_MUL);
    const QW = new Float64Array(Msz); let qs = 0; for (let m = 0; m < Msz; m++){ QW[m] = RW[m * step]; qs += QW[m]; }
    const stake = new Int32Array(pool.length);
    let used = 0;
    let tq = 0; for (let m = 0; m < Msz; m++) tq += QW[m];
    for (let u = 0; u < units; u++){
      // 100円追加したときの「資金の対数の期待値」の増分 = 全体の減少分(base) + 当たった回の増加分
      let base = 0; for (let m = 0; m < Msz; m++) base += QW[m] * Math.log((W[m] - 100) / W[m]); base /= tq;
      let best = -Infinity, bi = -1;
      for (let i = 0; i < pool.length; i++){
        if (!stake[i] && used >= maxBets) continue;
        const pay = 100 * pool[i].odds, h = H[i];
        let g = 0;
        for (let q = 0; q < h.length; q++){ const w = W[h[q]] - 100; g += QW[h[q]] * (Math.log(w + pay) - Math.log(w)); }
        g = g / tq + base;
        if (g > best){ best = g; bi = i; }
      }
      if (bi < 0 || best <= 0) break;          // 得にならないなら、予算が残っても買わない（賭けすぎは資金の伸びを下げる）
      if (!stake[bi]) used++;
      stake[bi]++;
      for (let m = 0; m < Msz; m++) W[m] -= 100;
      const pay = 100 * pool[bi].odds; H[bi].forEach(m => W[m] += pay);
    }
    const tickets = pool.map((c, i) => ({ ...c, stake: stake[i] * 100 })).filter(t => t.stake > 0)
      .sort((a, b) => b.stake - a.stake || b.ev - a.ev);
    if (!tickets.length){ const ref = cands.list.slice().sort((a, b) => b.ev - a.ev).slice(0, 3); return { none: true, ref, evmax }; }
    const growth = (() => { let s = 0; for (let m = 0; m < Msz; m++) s += QW[m] * Math.log(W[m] / (budget * BANK_MUL)); return s / qs; })();
    return { tickets, budget, growth, evmax, ...evaluate(res, tickets, N, budget) };
  }

  // 期待値（払戻の平均）だけを最大にする買い方＝期待値が最も高い1点に全額。
  // 確率が小さすぎる買い目は推定誤差が大きいので、誤差を見込んだ控えめな期待値 evL で選ぶ。
  function planEVMax(cands, budget, res, N){
    const c = cands.list.filter(x => x.evL >= 1.0).sort((a, b) => b.evL - a.evL)[0];
    if (!c) return null;
    const t = { ...c, stake: Math.floor(budget / 100) * 100 };
    return { tickets: [t], budget, ...evaluate(res, [t], N, budget) };
  }

  // シミュレーションの着順を使って配分全体の成績を評価
  function evaluate(res, tickets, N, budget){
    const R = res.runs, o = res.orders, placeK = N <= 7 ? 2 : 3, Wt = res.w;
    let sum = 0, hit = 0, profit = 0, hitSum = 0, maxPay = 0, tw = 0;
    for (let r = 0; r < R; r++){
      const top = [o[r*N], o[r*N+1], o[r*N+2]];
      let pay = 0;
      for (const t of tickets){
        const h = t.idx; let ok = false;
        if (t.type === "単勝") ok = top[0] === h[0];
        else if (t.type === "複勝") ok = top.slice(0, placeK).includes(h[0]);
        else if (t.type === "馬連") ok = (top[0] === h[0] && top[1] === h[1]) || (top[0] === h[1] && top[1] === h[0]);
        else if (t.type === "馬単") ok = top[0] === h[0] && top[1] === h[1];
        else if (t.type === "ワイド") ok = top.includes(h[0]) && top.includes(h[1]);
        else if (t.type === "三連複") ok = h.every(x => top.includes(x));
        if (ok) pay += t.stake * t.odds;
      }
      const q = Wt ? Wt[r] : 1; tw += q;
      sum += q * pay; if (pay > 0){ hit += q; hitSum += q * pay; } if (pay > budget) profit += q; if (pay > maxPay) maxPay = pay;
    }
    return { expReturn: sum / tw, hitRate: hit / tw, profitRate: profit / tw, avgHitPay: hit ? hitSum / hit : 0, maxPay };
  }

  return { candidates, plan, EV_MIN, setMarketBeta, setCalibration, get BETA(){ return BETA; }, get CAL(){ return CAL; } };
})();
if (typeof module !== "undefined") module.exports = Bets;
