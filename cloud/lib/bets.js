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
  // 統合：目標確率 ∝ p_model^A × p_market^B（A, B は答え合わせの蓄積から学習。初期値は A=0.3, B=0.85）
  // A+B が1未満だと確率が平らになり大穴を過大評価する（＝大穴の単勝ばかり買う）ので、A+B≧1 を必ず守る。
  let CAL = { a: 0.3, b: 0.85, learned: false, races: 0 };
  let BETA = null;              // 手動で「市場を信じる割合」を選んだときだけ使う（null=学習値）
  function setMarketBeta(b){ BETA = (b == null || b === "auto") ? null : (b >= 0 && b <= 1 ? +b : BETA); }
  function setCalibration(c){
    if (!(c && c.a >= 0 && c.b >= 0)) return;
    let { a, b } = c; if (a + b < 1){ const d = (1 - a - b) / 2; a += d; b += d; }
    CAL = { ...CAL, ...c, a: +a.toFixed(3), b: +b.toFixed(3), learned: true };
  }
  const exps = () => BETA == null ? { a: CAL.a, b: CAL.b } : { a: 1 - BETA, b: BETA * 1.1 };
  // 馬体重の効き（Learn.bodyWeightEffects の applied。オッズで説明できない分の対数オッズ）
  let BWE = null;
  function setBodyWeightEffects(e){ BWE = e && (e.win || e.top3) ? e : null; }
  // 項目の定義は Learn.bwFeatures と同じ（調整用の項目は applied=0 なので効かない）
  const BW_RULES = [["+10kg以上", (bw, d) => d != null && d >= 10], ["+4〜+9kg", (bw, d) => d != null && d >= 4 && d <= 9],
    ["−4〜−9kg", (bw, d) => d != null && d <= -4 && d >= -9], ["−10kg以下", (bw, d) => d != null && d <= -10], ["430kg未満", bw => bw < 430], ["520kg以上", bw => bw >= 520],
    ["増加×休み明け", (bw, d, rest) => d != null && d >= 4 && rest != null && rest >= 70], ["減少×休み明け", (bw, d, rest) => d != null && d <= -4 && rest != null && rest >= 70],
    ["増加×2〜3歳", (bw, d, rest, age) => d != null && d >= 4 && age != null && age <= 3], ["減少×2〜3歳", (bw, d, rest, age) => d != null && d <= -4 && age != null && age <= 3]];
  // 発表済みの馬体重（出走表、なければ結果表＝発走前に発表された値）
  function bwOf(race, num){
    const e = (race?.entries || []).find(x => x.num === num);
    if (e && e.bw) return { bw: e.bw, d: e.bwDiff ?? null };
    const x = (race?.result?.rows || []).find(x => x.num === num), m = x && /(\d{3})\(([+-]?\d+)\)/.exec(x.bw || "");
    return m ? { bw: +m[1], d: +m[2] } : null;
  }
  function bwShift(ctx){
    if (!BWE) return null;
    const sh = ctx.field.map(f => { const b = bwOf(ctx.race, f.num); if (!b) return { win: 0, top3: 0, keys: [] };
      const rest = f.prof?.daysOff ?? null, age = parseInt(String(f.sexAge || "").slice(1), 10) || null;
      const keys = BW_RULES.filter(([, fn]) => fn(b.bw, b.d, rest, age)).map(([k]) => k);
      return { win: keys.reduce((a, k) => a + (BWE.win?.[k]?.applied || 0), 0), top3: keys.reduce((a, k) => a + (BWE.top3?.[k]?.applied || 0), 0), keys }; });
    return sh.some(x => x.win || x.top3) ? sh : null;
  }
  const shiftLogit = (p, d) => { if (!d) return p; const q = Math.min(0.999, Math.max(1e-6, p)); const z = Math.log(q / (1 - q)) + d; return 1 / (1 + Math.exp(-z)); };
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
    // シミュレーションで一度も1着にならなかった馬は重み付けで確率を作れないので0のまま（他の馬に配り直されて歪むのを防ぐ）
    const BS = bwShift(ctx);
    const adjW = arr => BS ? arr.map((x, i) => shiftLogit(x, BS[i].win)) : arr;
    const adjP = arr => BS ? arr.map((x, i) => shiftLogit(x, BS[i].top3)) : arr;
    // 統合した確率に、馬体重の効き（オッズの見落とし分）を対数オッズで上乗せしてから正規化
    const tWin = norm(adjW(norm(comb(m0.win, mWin).map((x, i) => m0.win[i] > 1e-6 ? x : 0), 1)), 1);
    let tPlace = null, mPl = null;
    if (hasPlace){
      const mid = f.map((x, i) => x.placeLo > 0 ? (x.placeLo + (x.placeHi || x.placeLo)) / 2 : null);
      const mx = Math.max(...mid.filter(Boolean));
      mPl = norm(mid.map(v => 1 / (v || mx * 2)), placeK);
      tPlace = norm(adjP(norm(comb(m0.place, mPl).map((x, i) => m0.place[i] > 1e-6 ? x : 0), placeK)), placeK).map(x => Math.min(0.97, x));
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
    // 頑健性チェック用：モデルの信頼度（指数A）を半分にしたときの確率（A の推定誤差に対して買い目が崩れないかを見る）
    const ha = EA / 2, hb = EB + EA / 2;
    const combH = (pm, pk) => pm.map((x, i) => x > 1e-6 ? Math.pow(x, ha) * Math.pow(Math.max(pk[i], 1e-5), hb) : 0);
    const halfWin = norm(adjW(norm(combH(m0.win, mWin), 1)), 1);
    const halfPlace = mPl ? norm(adjP(norm(combH(m0.place, mPl), placeK)), placeK).map(x => Math.min(0.97, x)) : null;
    return { w, ess: R * R / s2, modelWin: m0.win, marketWin: mWin, finalWin: tWin, halfWin, halfPlace, bw: BS };
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
    const { a: EA, b: EB } = exps();
    // psim: 重み付けしたシミュレーション上の的中確率。組み合わせ馬券は確率をさらにオッズと統合するので、
    // 配分（ケリー）と期待払戻の計算では払戻を rho = p / psim 倍して、期待値を p × オッズ に合わせる
    const push = (type, idx, p, odds, est, hi, psim, ph) => {
      if (p < MIN_P[type] || !(odds > 1)) return;
      odds = Math.round(odds * 10) / 10;
      // シミュレーションの誤差は統合の指数 A 倍に縮んで確率に効く（p ∝ p_model^A）
      const se = Math.sqrt(p * (1 - p) / R) * Math.min(1, Math.max(EA, 0.1));
      const rho = psim > 1e-9 ? Math.max(0.2, Math.min(5, p / psim)) : 1;
      // 控えめな期待値 evL：①シミュレーションの誤差を1標準誤差見込む ②モデルの信頼度を半分にしても期待値が保てるか、の小さい方
      const evL = Math.min(Math.max(0, p - se) * odds, ph != null ? ph * odds : Infinity);
      out.push({ type, idx, nums: idx.map(i => f[i].num), p, odds, oddsHi: hi || null, est, ev: p * odds, evL, evHalf: ph != null ? ph * odds : null, kelly: (p * odds - 1) / (odds - 1), rho });
    };
    for (let i = 0; i < N; i++){
      if (!(f[i].odds > 1)) continue;          // オッズ不明の馬の単複は買わない
      push("単勝", [i], M.win[i], f[i].odds, false, null, M.win[i], B.halfWin[i]);
      if (f[i].placeLo > 0) push("複勝", [i], M.place[i], f[i].placeLo, false, f[i].placeHi, M.place[i], B.halfPlace ? B.halfPlace[i] : null);
    }
    const key = idx => idx.map(i => f[i].num).sort((a, b) => a - b).join("-");
    // 組み合わせ馬券は実オッズがあるときだけ（推定配当は誤差が大きく、期待値を過大に見積もるため買わない）。
    // シミュレーションの組み合わせ確率は、上位馬どうしの同時入着を強めに見積もりやすい（10/4の検証で、期待払戻175%に対し実際143%）。
    // そこで単勝と同じく「モデル^A × 市場^B」で、組み合わせごとのオッズが示す確率とも統合してから期待値を計算する。
    // モデル側は重み付け前のシミュレーションの確率を使う（重み付け後は既に市場が混ざっているので、二重に混ぜない）。
    const M0 = modelProbs({ orders: res.orders, runs: res.runs }, N);
    const items = { 馬連: [], ワイド: [], 馬単: [], 三連複: [] };
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++){
      const k2 = key([i, j]);
      if (real.馬連){ const v = CO.馬連[k2]; if (v) items.馬連.push({ idx: [i, j], p: M0.pair[i*N + j], ps: M.pair[i*N + j], odds: v, mk: v }); }
      if (real.ワイド){ const v = CO.ワイド[k2]; if (v){ const lo = Array.isArray(v) ? v[0] : v, hi = Array.isArray(v) ? v[1] : null; items.ワイド.push({ idx: [i, j], p: M0.wide[i*N + j], ps: M.wide[i*N + j], odds: lo, hi, mk: hi ? (lo + hi) / 2 : lo }); } }
      if (real.馬単){
        const v1 = CO.馬単[`${f[i].num}-${f[j].num}`], v2 = CO.馬単[`${f[j].num}-${f[i].num}`];
        if (v1) items.馬単.push({ idx: [i, j], p: M0.exacta[i*N + j], ps: M.exacta[i*N + j], odds: v1, mk: v1 });
        if (v2) items.馬単.push({ idx: [j, i], p: M0.exacta[j*N + i], ps: M.exacta[j*N + i], odds: v2, mk: v2 });
      }
      if (real.三連複) for (let k = j + 1; k < N; k++){ const v = CO.三連複[key([i, j, k])]; if (v) items.三連複.push({ idx: [i, j, k], p: M0.trio[(i*N + j)*N + k], ps: M.trio[(i*N + j)*N + k], odds: v, mk: v }); }
    }
    Object.entries(items).forEach(([type, xs]) => {
      if (!xs.length) return;
      // 統合後の確率の合計は、重み付け後のシミュレーションでこれらの組み合わせが占める確率に合わせる
      const q = xs.map(x => 1 / x.mk), qs = q.reduce((a, b) => a + b, 0);
      const pmS = xs.reduce((a, x) => a + x.ps, 0);
      const t = xs.map((x, n) => Math.pow(Math.max(x.p, 1e-6), EA) * Math.pow(q[n] / qs, EB));
      const ts = t.reduce((a, b) => a + b, 0) || 1;
      const th = xs.map((x, n) => Math.pow(Math.max(x.p, 1e-6), EA / 2) * Math.pow(q[n] / qs, EB + EA / 2));
      const ths = th.reduce((a, b) => a + b, 0) || 1;
      xs.forEach((x, n) => push(type, x.idx, Math.min(0.97, t[n] / ts * pmS), x.odds, false, x.hi || null, x.ps, Math.min(0.97, th[n] / ths * pmS)));
    });
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
  // ケリー基準を、券種どうしの相関（同じレースで同時に当たる・外れる）も含めて100円単位の貪欲法で（近似的に）解く。
  // 資金は予算の10倍（1レースに資金の1割を使う）と仮定。
  const BANK_MUL = 10;
  // 100円ずつ、資金の対数の期待値（＝長期の資金成長率）が最も上がる買い目に足していく。
  // force=false：得にならなくなったら止める（ケリー基準）。force=true：予算を必ず使い切る（見送り推奨のレースで、損の見込みが最も小さい買い方）
  function allocate(ctx, res, budget, pool, force){
    const RW = res.w, units = Math.floor(budget / 100), N = ctx.N, R = res.runs, placeK = N <= 7 ? 2 : 3;
    const maxBets = budget <= 1000 ? 5 : 10;
    const step = Math.max(1, Math.floor(R / 6000)), Msz = Math.ceil(R / step);
    const H = pool.map(c => hits(c, res.orders, N, R, placeK, step));
    const W = new Float64Array(Msz).fill(budget * BANK_MUL);
    const QW = new Float64Array(Msz); let qs = 0; for (let m = 0; m < Msz; m++){ QW[m] = RW[m * step]; qs += QW[m]; }
    const stake = new Int32Array(pool.length);
    let used = 0;
    const tq = qs;
    for (let u = 0; u < units; u++){
      // 100円追加したときの「資金の対数の期待値」の増分 = 全体の減少分(base) + 当たった回の増加分
      let base = 0; for (let m = 0; m < Msz; m++) base += QW[m] * Math.log((W[m] - 100) / W[m]); base /= tq;
      let best = -Infinity, bi = -1;
      for (let i = 0; i < pool.length; i++){
        if (!stake[i] && used >= maxBets) continue;
        const pay = 100 * pool[i].odds * (pool[i].rho || 1), h = H[i];
        let g = 0;
        for (let q = 0; q < h.length; q++){ const w = W[h[q]] - 100; g += QW[h[q]] * (Math.log(w + pay) - Math.log(w)); }
        g = g / tq + base;
        if (g > best){ best = g; bi = i; }
      }
      if (bi < 0 || (!force && best <= 0)) break;          // 得にならないなら、予算が残っても買わない（賭けすぎは資金の伸びを下げる）
      if (!stake[bi]) used++;
      stake[bi]++;
      for (let m = 0; m < Msz; m++) W[m] -= 100;
      const pay = 100 * pool[bi].odds * (pool[bi].rho || 1); H[bi].forEach(m => W[m] += pay);
    }
    const tickets = pool.map((c, i) => ({ ...c, stake: stake[i] * 100 })).filter(t => t.stake > 0)
      .sort((a, b) => b.stake - a.stake || b.ev - a.ev);
    if (!tickets.length) return null;
    const growth = (() => { let s = 0; for (let m = 0; m < Msz; m++) s += QW[m] * Math.log(W[m] / (budget * BANK_MUL)); return s / qs; })();
    return { tickets, budget, growth, ...evaluate(res, tickets, N, budget) };
  }
  function plan(ctx, res, budget, cands){
    if (!cands) return { noOdds: true };
    res = cands.wres;
    const good = cands.list.filter(c => c.ev >= EV_MIN && c.evL >= 1.0);
    const evmax = planEVMax(cands, budget, cands.wres, ctx.N);
    const kelly = good.length ? allocate(ctx, res, budget, good.sort((a, b) => b.evL - a.evL).slice(0, 40), false) : null;
    if (kelly) return { ...kelly, mode: "勝負", evmax };
    // 勝負できる買い目がないレースでも、1レース分の予算で「損の見込みが最も小さい買い方」を出す（見送り推奨）。
    // 的中率5%未満の大穴は除き（結果のぶれが大きすぎるため）、期待値の高い順の候補から選ぶ
    const pool = cands.list.filter(c => c.p >= 0.05).sort((a, b) => b.ev - a.ev).slice(0, 30);
    const skip = pool.length ? allocate(ctx, res, budget, pool, true) : null;
    const ref = cands.list.slice().sort((a, b) => b.ev - a.ev).slice(0, 3);
    return { none: true, ref, evmax, skip: skip ? { ...skip, mode: "見送り推奨" } : null };
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
    const staked = tickets.reduce((a, t) => a + t.stake, 0);   // 実際に使う額（予算を使い切らないことがある）
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
        if (ok) pay += t.stake * t.odds * (t.rho || 1);
      }
      const q = Wt ? Wt[r] : 1; tw += q;
      sum += q * pay; if (pay > 0){ hit += q; hitSum += q * pay; } if (pay > staked) profit += q; if (pay > maxPay) maxPay = pay;
    }
    return { expReturn: sum / tw, staked, hitRate: hit / tw, profitRate: profit / tw, avgHitPay: hit ? hitSum / hit : 0, maxPay };
  }

  return { candidates, plan, EV_MIN, setMarketBeta, setCalibration, get BETA(){ return BETA; }, get CAL(){ return CAL; }, get EXPS(){ return exps(); }, setBodyWeightEffects, get BWE(){ return BWE; }, bwOf };
})();
if (typeof module !== "undefined") module.exports = Bets;
