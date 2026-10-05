// ===== 競馬シミュレーションエンジン =====
const Engine = (() => {
  // --- コース諸元（周長・直線・回り）。内/外回りは距離で切替 ---
  const COURSE = {
    "東京": { dir:"左", 芝:{lap:2083,str:525.9}, ダ:{lap:1899,str:501.6} },
    "中山": { dir:"右", 芝:{lap:1840,str:310.0}, ダ:{lap:1493,str:308.0}, 芝外:{lap:1839,str:310.0} },
    "京都": { dir:"右", 芝:{lap:1894,str:403.7}, 芝内:{lap:1782,str:328.4}, ダ:{lap:1608,str:329.1} },
    "阪神": { dir:"右", 芝:{lap:2089,str:473.6}, 芝内:{lap:1689,str:356.5}, ダ:{lap:1517,str:352.7} },
    "中京": { dir:"左", 芝:{lap:1705,str:412.5}, ダ:{lap:1530,str:410.7} },
    "新潟": { dir:"左", 芝:{lap:2223,str:658.7}, 芝内:{lap:1623,str:358.7}, ダ:{lap:1472,str:353.9} },
    "札幌": { dir:"右", 芝:{lap:1641,str:266.1}, ダ:{lap:1487,str:264.3} },
    "函館": { dir:"右", 芝:{lap:1627,str:262.1}, ダ:{lap:1476,str:260.3} },
    "福島": { dir:"右", 芝:{lap:1600,str:292.0}, ダ:{lap:1445,str:295.7} },
    "小倉": { dir:"右", 芝:{lap:1615,str:293.0}, ダ:{lap:1445,str:291.3} }
  };
  function courseOf(venue, surface, dist){
    const c = COURSE[venue] || COURSE["東京"];
    let key = surface === "ダ" ? "ダ" : "芝";
    if (surface !== "ダ") {
      if (venue === "京都" && c["芝内"] && (dist === 1200 || dist === 2000)) key = "芝内";
      if (venue === "阪神" && c["芝内"] && [1200,2000,2200,3000].includes(dist)) key = "芝内";
      if (venue === "新潟" && c["芝内"] && [2000,2200,2400].includes(dist) ) key = "芝内";
    }
    const g = c[key];
    return { dir:c.dir, lap:g.lap, str:g.str, key };
  }

  // --- 騎手補正（目安値。リーディング・重賞実績から設定。1Pt≒0.1秒） ---
  const JOCKEY = {"ルメール":2.0,"川田":2.0,"モレイラ":1.8,"Ｍデム":1.5,"Mデム":1.5,"レーン":1.5,"ムーア":1.5,"坂井":1.4,"戸崎圭":1.2,"横山武":1.2,"武豊":1.1,"松山":1.0,"岩田望":1.0,"西村淳":0.9,"鮫島駿":0.8,"鮫島克":0.8,"コレット":0.8,"北村友":0.7,"横山典":0.6,"田辺":0.6,"横山和":0.6,"菅原明":0.6,"佐々木":0.6,"津村":0.5,"団野":0.5,"池添":0.4,"浜中":0.4,"岩田康":0.3,"吉田隼":0.3,"丹内":0.3,"ゴンサル":0.3,"松若":0.2,"荻野極":0.2,"藤岡佑":0.2,"三浦":0.2,"幸":0.0,"吉村":0.0,"高杉":0.0,"丸山":0.0,"大野":0.0,"中村将":0.0,"石橋":-0.1,"斎藤":-0.2,"吉田豊":-0.2,"松本":-0.2,"内田博":-0.2,"古川吉":-0.2,"古川奈":-0.2,"小沢":-0.2,"小崎":-0.2,"石川":-0.2,"原":-0.3,"菊沢":-0.3,"川又":-0.3,"田口":-0.3,"太宰":-0.3,"西村太":-0.4,"酒井":-0.4};
  const JKEYS = Object.keys(JOCKEY).sort((a, b) => b.length - a.length);
  // 出馬表の略称（坂井）とDBのフルネーム（坂井瑠星）を同じ騎手として扱う
  function jockeyKey(j){
    j = (j || "").trim().replace("鮫島克駿", "鮫島駿").replace("ミルコ", "Ｍデム");
    for (const k of JKEYS) if (j.startsWith(k)) return k;
    return j;
  }
  const jockeyPts = j => JOCKEY[jockeyKey(j)] ?? 0;

  // --- クラス判定 ---
  const GRADE_BASE = {G1:80,G2:74,G3:70,L:67,OP:66,"3勝":62,"2勝":56,"1勝":50,"未勝利":44,"新馬":42,"障害":40};
  const GRADE_RANK = {G1:7,G2:6,G3:5,L:4,OP:4,"3勝":3,"2勝":2,"1勝":1,"未勝利":0,"新馬":0,"障害":0};
  function gradeOf(name){
    const n = name || "";
    if (/障害/.test(n)) return /G|J・G/.test(n) ? "OP" : "障害";
    if (/GIII|JpnIII|G3/.test(n)) return "G3";
    if (/GII|JpnII|G2/.test(n)) return "G2";
    if (/GI|JpnI|G1/.test(n)) return "G1";
    if (/新馬/.test(n)) return "新馬";
    if (/未勝利/.test(n)) return "未勝利";
    if (/1勝|500万/.test(n)) return "1勝";
    if (/2勝|1000万/.test(n)) return "2勝";
    if (/3勝|1600万/.test(n)) return "3勝";
    if (/L$|\(L\)|リステッド/.test(n)) return "L";
    return "OP";
  }
  const JRA = new Set(["札幌","函館","福島","新潟","東京","中山","中京","京都","阪神","小倉"]);
  const DIR = { "東京":"左","中京":"左","新潟":"左","中山":"右","京都":"右","阪神":"右","札幌":"右","函館":"右","福島":"右","小倉":"右" };

  // --- 過去走パース（文字列・オブジェクト両対応） ---
  const num = v => (v === "" || v == null || v === "-") ? null : (isFinite(+v) ? +v : null);
  function parseRun(s){
    let r;
    if (typeof s !== "string") {
      r = { ...s };
      r.surface = r.surface || "芝"; r.dist = +r.dist;
      r.passing = Array.isArray(r.passing) ? r.passing : (r.passing ? String(r.passing).split("-").map(Number).filter(x => x > 0) : []);
    } else {
      const [date, venue, race, sd, going, pos, field, time, passing, last3f, margin, pop, gate, jockey, kg, note] = s.split("|");
      r = { date, venue, race, surface: sd[0], dist: parseInt(sd.slice(1), 10), going, pos, field, time, last3f, margin, pop, gate, jockey, weight: kg, note,
            passing: (passing && passing !== "-") ? passing.split("-").map(Number).filter(x => x > 0) : [] };
    }
    r.pos = +r.pos; r.field = +r.field; r.going = r.going || "-"; r.time = r.time || "-";
    r.last3f = num(r.last3f); r.margin = num(r.margin); r.pop = num(r.pop ?? r.popularity); r.gate = num(r.gate); r.weight = num(r.weight);
    r.grade = r.grade || gradeOf(r.race || ""); r.note = r.note || r.comment || "";
    r.overseas = !JRA.has(r.venue) && !/川崎|大井|船橋|浦和|園田|名古屋|盛岡|門別|佐賀|金沢|笠松|高知|水沢/.test(r.venue);
    return r;
  }
  // オッズが一部欠けている（取消・発売前の一部など）ときは、欠けた馬を最低人気の2倍とみなす
  function oddsReady(field){ const n = field.filter(f => f.odds > 1).length; return n >= 2 && n >= field.length * 0.75; }
  function filledOdds(field){ const mx = Math.max(...field.map(f => f.odds > 1 ? f.odds : 0)); return field.map(f => f.odds > 1 ? f.odds : Math.max(mx * 2, 100)); }
  const daysBetween = (a,b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const wet = g => g === "稍" || g === "重" || g === "不";
  const clamp = (x,a,b) => Math.max(a, Math.min(b, x));
  const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
  const median = a => { if (!a.length) return null; const s = a.slice().sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };

  // 1走の内容：着差があれば着差（勝ち馬からの秒差）、なければ着順で評価
  function runScore(r){ return r.field > 1 ? 1 - (r.pos - 1) / (r.field - 1) : 0.5; }
  function runRating(r){
    const base = GRADE_BASE[r.grade] ?? 64;
    if (r.margin != null && !r.overseas) return base + 4 - 9 * clamp(r.margin, -0.8, 3.0);
    return base + 16 * runScore(r) - 10;
  }

  // --- 不利・度外視の判定（コメントのキーワード＋データからの推定） ---
  const TROUBLE_WORDS = ["出遅","不利","挟ま","詰ま","前が壁","外を回","大外","ブレーキ","落鉄","躓","つまず","口向き","掛か","折り合","鼻出血","心房細動","斜行","接触","進路","窮屈","寄られ","立ち遅","スタートで","滑","外傷","跛行","向いてない","不向き","休み明け","距離"];
  function detectTrouble(r, prev, usualEarly, avgL3, mainSurf){
    const why = [];
    if (r.note && TROUBLE_WORDS.some(w => r.note.includes(w))) why.push(r.note);
    if (r.margin != null && r.margin >= 2.5) why.push(`大敗（${r.margin.toFixed(1)}秒差）＝故障・競走能力外の要因の可能性`);
    if (mainSurf && r.surface !== mainSurf && r.surface !== "障" && runScore(r) < 0.5) why.push(`${r.surface === "ダ" ? "ダート" : "芝"}替わり`);
    if ((r.going === "重" || r.going === "不") && r.margin != null && r.margin >= 1.5) why.push("道悪で失速");
    const rel = r.passing.length && r.field > 7 ? (r.passing[0] - 1) / (r.field - 1) : null;
    if (rel != null && usualEarly != null && rel - usualEarly >= 0.35) why.push("出遅れ・位置取り後方（通過順から推定）");
    if (rel != null && rel <= 0.15 && r.last3f && avgL3 && r.last3f - avgL3 >= 1.5 && (r.margin ?? 0) >= 1.0) why.push("先行して失速（ハイペース推定）");
    if (rel != null && rel >= 0.6 && r.last3f && avgL3 && avgL3 - r.last3f >= 0.5 && r.pos >= 4 && (r.margin ?? 9) <= 0.6) why.push("差し届かず（展開不向き推定）");
    if (prev && daysBetween(prev.date, r.date) >= 180) why.push(`長期休み明け（${Math.round(daysBetween(prev.date, r.date) / 30)}か月）`);
    if (r.overseas) why.push("海外遠征");
    return why;
  }

  // --- 穴馬好走パターン（既定値は一般的に言われる傾向の仮置き。analyze_upsets.py の結果で上書き可） ---
  const ANA_DEFAULT = {
    "前走度外視": { pts: 0.8, sig: 0.6, desc: "前走に不利・大敗などの度外視材料" },
    "G1からの格下げ": { pts: 0.6, sig: 0.4, desc: "前走G1で負けての格下げ戦" },
    "実績の割に人気薄": { pts: 0.7, sig: 0.6, desc: "重賞3着以内の実績がありながら6番人気以下" },
    "距離短縮": { pts: 0.4, sig: 0.3, desc: "前走より200m以上の距離短縮" },
    "叩き2戦目": { pts: 0.5, sig: 0.2, desc: "休み明けを一度使われての2戦目" },
    "鞍上強化": { pts: 0.4, sig: 0.2, desc: "前走より騎手評価が上がる乗り替わり" },
    "内枠の先行馬": { pts: 0.4, sig: 0.3, desc: "内枠×先行脚質でロスなく運べる" },
    "コース巧者": { pts: 0.5, sig: 0.3, desc: "同コースで好走歴" },
    // ここから下は追加の候補（初期の加点は0。答え合わせの蓄積で、オッズ以上に来ると分かったものだけ加点が育つ）
    "前走で追い込み届かず": { pts: 0, sig: 0.2, desc: "前走は最後の直線で4頭以上抜いたが4着以下" },
    "先行力あり": { pts: 0, sig: 0.1, desc: "過去の出走で最初のコーナーをほぼ前の方で回っている" },
    "単騎逃げ見込み": { pts: 0, sig: 0.2, desc: "逃げ馬がこの馬だけ" },
    "斤量3kg以上減": { pts: 0, sig: 0.1, desc: "前走より斤量が3kg以上軽い" },
    "減量騎手": { pts: 0, sig: 0.1, desc: "見習い騎手（▲△☆◇）の減量" },
    "芝ダ替わり": { pts: 0, sig: 0.3, desc: "前走と芝・ダートが替わる" },
    "道悪巧者×道悪": { pts: 0, sig: 0.2, desc: "道悪で成績が良い馬が稍重〜不良で走る" },
    "調教高評価の人気薄": { pts: 0, sig: 0.2, desc: "調教評価Aなのに6番人気以下" },
    "直前に買われた": { pts: 0, sig: 0.1, desc: "最初のオッズから直前までに単勝が3割以上下がった" },
    "持ち時計上位": { pts: 0, sig: 0.2, desc: "このメンバーで最高のスピード指数が上位3頭以内" },
    "昇級2戦目": { pts: 0, sig: 0.2, desc: "前走が昇級初戦で、今回も同じクラス" },
    "鉄砲駆け実績": { pts: 0, sig: 0.2, desc: "90日以上の休み明けで、過去にも休み明けで3着以内" }
  };
  let ANA = JSON.parse(JSON.stringify(ANA_DEFAULT));
  function setAnaWeights(w){ ANA = JSON.parse(JSON.stringify(ANA_DEFAULT)); Object.entries(w || {}).forEach(([k, v]) => { if (ANA[k]) Object.assign(ANA[k], v); }); }

  // 枠の有利不利（コース別の目安。正＝内枠有利の強さ）
  function courseGateBias(venue, surface, dist){
    if (surface === "ダ") return dist <= 1400 ? -0.4 : 0.2;          // 短距離ダートは外枠（砂を被らない）
    const key = venue + dist;
    const table = { "東京1800": 0.6, "東京1600": 0.2, "東京2000": 0.8, "京都2400": 0.7, "京都2000": 0.6, "中山2000": 0.6, "中山1600": 1.0, "阪神2000": 0.5, "京都1600": 0.4 };
    return table[key] ?? (dist <= 1400 ? 0.5 : 0.4);
  }

  // ===== 全馬の全走から作る「スピード指数」 =====
  // DBにある全ての走（出走予定馬の過去走すべて）から、コース・距離ごとの基準タイムと
  // 開催日ごとの馬場差（その日の時計の速さ）を推定し、各走を同じ物差し（G3勝ち馬水準＝100）で数値化する。
  const tsec = t => { const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
  const GOING_F = { 芝: { 良: 1, 稍: 1.006, 重: 1.013, 不: 1.022 }, ダ: { 良: 1, 稍: 0.995, 重: 0.99, 不: 0.988 } };
  const formulaTime = (surface, D) => D / (surface === "ダ" ? 17.5 - 0.7 * D / 1000 : 17.9 - 0.5 * D / 1000);
  let SPEED = null, SPEED_KEY = null;
  // before：この日付より前の出走だけで基準タイムを作る（過去の日を予想し直すときに未来のデータを使わない）
  function buildSpeedModel(horsesDB, before){
    const key = (before || "") + ":" + Object.keys(horsesDB).length + ":" + Object.values(horsesDB).reduce((a, h) => a + (h.runs?.length || 0), 0);
    if (SPEED && SPEED_KEY === key) return SPEED;
    const all = [];
    Object.values(horsesDB).forEach(h => (h.runs || []).forEach(s => {
      const r = parseRun(s); if (before && r.date && r.date >= before) return; const t = tsec(r.time);
      if (!t || r.overseas || r.surface === "障" || !JRA.has(r.venue) || !(r.dist > 0)) return;
      const win = t - Math.max(0, r.margin ?? 0);
      const gF = GOING_F[r.surface]?.[r.going] ?? 1;
      const classAdj = ((GRADE_BASE[r.grade] ?? 64) - 70) * 0.04 * r.dist / 1000;   // G3水準へ揃える
      all.push({ r, t, win, gF, classAdj, k: `${r.venue}|${r.surface}|${r.dist}`, day: `${r.date}|${r.venue}|${r.surface}`, race: `${r.date}|${r.venue}|${r.surface}${r.dist}|${r.grade}|${r.field}` });
    }));
    // レース単位に重複排除（同じレースに複数頭いる場合）
    const races = new Map(); all.forEach(x => { if (!races.has(x.race)) races.set(x.race, x); });
    const byKey = new Map();
    races.forEach(x => { const v = (x.win + x.classAdj) / x.gF; if (!byKey.has(x.k)) byKey.set(x.k, []); byKey.get(x.k).push(v); });
    const std = new Map(); byKey.forEach((v, k) => { const [, s, d] = k.split("|"); const f = formulaTime(s, +d); std.set(k, v.length >= 3 ? median(v) : (median(v) * v.length + f * 2) / (v.length + 2)); });
    // 開催日ごとの馬場差（2レース以上ある日のみ）
    const dayRes = new Map();
    races.forEach(x => { const e = std.get(x.k); const res = (x.win + x.classAdj) / x.gF - e; if (!dayRes.has(x.day)) dayRes.set(x.day, []); dayRes.get(x.day).push(res); });
    const variant = new Map(); dayRes.forEach((v, k) => { if (v.length >= 2) variant.set(k, mean(v) * v.length / (v.length + 1)); });
    SPEED = { std, variant, nRaces: races.size, nRuns: all.length, nKeys: std.size };
    SPEED_KEY = key;
    return SPEED;
  }
  function speedFigure(r, model){
    const t = tsec(r.time);
    if (!t || !model || r.overseas || r.surface === "障" || !JRA.has(r.venue)) return null;
    const k = `${r.venue}|${r.surface}|${r.dist}`;
    const e = model.std.get(k) ?? formulaTime(r.surface, r.dist);
    const gF = GOING_F[r.surface]?.[r.going] ?? 1;
    const v = model.variant.get(`${r.date}|${r.venue}|${r.surface}`) ?? 0;
    const tAdj = t - ((r.weight ?? 57) - 57) * 0.15;                 // 斤量1kg≒0.15秒
    const scale = 10 * Math.sqrt(1800 / r.dist);
    return Math.round((100 + ((e + v) * gF - tAdj) * scale) * 10) / 10;
  }

  // --- 馬プロファイル（DBに保持する派生指標） ---
  function profile(horse, race, entry, model){
    // そのレースより前の出走だけを使う（過去の開催日を予想し直すときに、未来の結果が混ざらないように）
    const runs = (horse.runs || []).map(parseRun).filter(r => r.pos > 0 && r.field > 0 && (!race.date || !r.date || r.date < race.date))
      .sort((a,b) => b.date.localeCompare(a.date));
    // 取り込んだレース後コメント・SNSの反応（馬ごとに 日付→テキスト）
    runs.forEach(r => { const c = horse.notes?.[r.date]; if (c) r.note = (r.note ? r.note + "／" : "") + c; });
    const D = race.distance, surf = race.surface === "障" ? "芝" : race.surface;
    const flat = runs.filter(r => r.surface !== "障");
    const out = { runs, n: runs.length };
    const surfCount = { 芝: flat.filter(r => r.surface === "芝").length, ダ: flat.filter(r => r.surface === "ダ").length };
    const mainSurf = surfCount.芝 >= surfCount.ダ ? "芝" : "ダ";

    // 脚質（1角通過/頭数）
    const earlyArr = flat.filter(r => r.passing.length && r.field > 4).map(r => (r.passing[0] - 1) / Math.max(1, r.field - 1));
    const usualEarly = median(earlyArr);
    out.earlyPos = earlyArr.length ? mean(earlyArr) : 0.5;
    out.style = out.earlyPos < 0.12 ? "逃げ" : out.earlyPos < 0.35 ? "先行" : out.earlyPos < 0.68 ? "差し" : "追込";
    const gains = flat.filter(r => r.passing.length).map(r => (r.passing[r.passing.length-1] - r.pos) / r.field);
    out.kick = gains.length ? mean(gains) : 0;
    const l3 = flat.map(r => r.last3f).filter(x => x && x < 40);
    out.avgLast3f = l3.length ? mean(l3) : null;

    // 1走ごとの評価と度外視判定
    runs.forEach((r, i) => { r.rating = runRating(r); r.trouble = detectTrouble(r, runs[i + 1], usualEarly, out.avgLast3f, mainSurf); });
    const baseLine = median(runs.map(r => r.rating)) ?? 60;
    runs.forEach(r => {
      r.adjRating = r.rating;
      if (r.trouble.length && r.rating < baseLine){ r.adjRating = baseLine + 0.5 * (r.rating - baseLine); r.discounted = true; }   // マイナス分を0.5倍
    });
    out.discounted = runs.filter(r => r.discounted).length;
    // スピード指数（全馬の全走から作った基準タイムで算出）
    runs.forEach(r => { r.fig = speedFigure(r, model); });
    const figRuns = runs.filter(r => r.fig != null && r.surface === surf && !r.discounted).slice(0, 8);
    if (figRuns.length){
      const w = figRuns.map((r, i) => Math.pow(0.88, i) * (0.5 + 0.5 * Math.exp(-Math.pow((r.dist - D) / 700, 2))));
      const top = figRuns.map((r, i) => ({ f: r.fig, w: w[i] })).sort((a, b) => b.f - a.f).slice(0, Math.max(2, Math.ceil(figRuns.length / 2)));
      out.speedFig = top.reduce((a, x) => a + x.f * x.w, 0) / top.reduce((a, x) => a + x.w, 0);
      out.bestFig = Math.max(...figRuns.map(r => r.fig));
    } else { out.speedFig = null; out.bestFig = null; }
    const l3t = runs.filter(r => r.surface === "芝" && r.last3f && r.last3f < 40).map(r => r.last3f);
    out.bestLast3f = l3t.length ? Math.min(...l3t) : null;

    // 能力（関連度×新しさで加重、度外視補正後）
    let sw = 0, sr = 0, best = -1e9;
    runs.forEach((r, i) => {
      const rec = Math.pow(0.85, i);
      const surfW = r.surface === surf ? 1 : (r.surface === "障" || race.surface === "障") ? 0.2 : 0.5;
      const distW = 0.5 + 0.5 * Math.exp(-Math.pow((r.dist - D) / 800, 2));
      const w = rec * surfW * distW * (r.overseas ? 0.6 : 1);
      sw += w; sr += w * r.adjRating; if (i < 5) best = Math.max(best, r.adjRating - (surfW < 1 ? 4 : 0));
    });
    const raceBase = GRADE_BASE[race.grade] ?? 64;
    out.ability = sw > 0 ? 0.65 * (sr / sw) + 0.35 * best : raceBase - 6;

    // 直近の調子：直近2走と3〜5走目の比較
    const a2 = mean(runs.slice(0, 2).map(r => r.adjRating)), b3 = mean(runs.slice(2, 5).map(r => r.adjRating));
    out.trend = (a2 != null && b3 != null) ? a2 - b3 : 0;

    // 距離適性（着差ベースの内容で重み付け）
    const same = runs.filter(r => r.surface === surf);
    const good = r => clamp((r.adjRating - baseLine + 10) / 20, 0.05, 1);
    let ws = 0, wd = 0;
    same.forEach(r => { const s = good(r); ws += s; wd += s * r.dist; });
    if (ws > 0) {
      const c = wd / ws;
      let v = 0; same.forEach(r => { v += good(r) * (r.dist - c) ** 2; });
      const sd = Math.max(250, Math.sqrt(v / ws));
      out.distCenter = Math.round(c); out.distSpread = Math.round(sd);
      let pts = -6 * Math.min(1, ((D - c) / (sd * 2.5)) ** 2);
      if (same.some(r => (r.pos <= 3 || (r.margin != null && r.margin <= 0.3)) && Math.abs(r.dist - D) <= 200)) pts += 0.8;
      out.distApt = pts * (same.length >= 3 ? 1 : 0.6);
    } else { out.distApt = 0; out.distCenter = null; }

    const rel = arr => { const m = mean(arr.map(r => r.adjRating)), all = mean(flat.map(r => r.adjRating)); return (m != null && all != null) ? m - all : null; };
    // 芝/ダート
    const sDiff = rel(flat.filter(r => r.surface === surf));
    out.surfApt = race.surface === "障" ? 0 : sDiff != null ? clamp(sDiff * 0.3, -3, 2) : (flat.length ? -3.5 : 0);
    // 馬場状態
    const wetR = flat.filter(r => wet(r.going)), dryR = flat.filter(r => r.going === "良");
    out.wetDiff = (wetR.length && dryR.length) ? mean(wetR.map(r => r.adjRating)) - mean(dryR.map(r => r.adjRating)) : null;
    out.wetN = wetR.length;
    out.goingApt = wet(race.going) && out.wetDiff != null ? clamp(out.wetDiff * 0.3, -3, 3) * (race.going === "稍" ? 0.5 : 1) * wetR.length / (wetR.length + 1) : 0;
    // 競馬場（同場・同馬場種別）
    const cr = flat.filter(r => r.venue === race.venue && r.surface === surf);
    const cDiff = rel(cr);
    out.courseRuns = cr.length;
    out.courseGood = cr.some(r => r.pos <= 3 && Math.abs(r.dist - D) <= 400);
    out.courseApt = cDiff != null ? clamp(cDiff * 0.25, -2, 2) * cr.length / (cr.length + 2) : 0;
    // 回り（右/左）
    const dir = DIR[race.venue];
    const dr = flat.filter(r => DIR[r.venue] === dir);
    const dDiff = rel(dr);
    out.dirApt = dDiff != null && dr.length < flat.length ? clamp(dDiff * 0.2, -1.5, 1.5) * dr.length / (dr.length + 2) : 0;
    // 枠（その馬の内外別成績＋コースの枠傾向）
    const N = race.entries?.length || 16;
    const gr = flat.filter(r => r.gate && r.field > 7);
    const inR = gr.filter(r => (r.gate - 1) / (r.field - 1) <= 0.4), outR = gr.filter(r => (r.gate - 1) / (r.field - 1) >= 0.6);
    out.gateHorse = (inR.length && outR.length) ? mean(inR.map(r => r.adjRating)) - mean(outR.map(r => r.adjRating)) : null;
    if (entry){
      const gRel = (entry.num - 1) / Math.max(1, N - 1);                // 0=最内 1=大外
      let g = courseGateBias(race.venue, race.surface, D) * (0.5 - gRel) * 2;
      if (out.gateHorse != null) g += clamp(out.gateHorse * 0.08, -0.6, 0.6) * (gRel <= 0.4 ? 1 : gRel >= 0.6 ? -1 : 0);
      out.gateApt = g;
    } else out.gateApt = 0;

    // 安定度 → 当日のばらつき（度外視補正後）
    const sc = runs.slice(0, 6).map(r => r.adjRating);
    const m = mean(sc); const sdv = sc.length > 1 ? Math.sqrt(sc.reduce((a,x)=>a+(x-m)**2,0)/sc.length) : 6;
    out.sigma = runs.length ? clamp(3.5 + 0.35 * sdv, 4, 9) + (runs.length < 3 ? 1 : 0) : 7;

    // 前走情報（ローテーション）
    const last = runs[0], prev = runs[1];
    out.daysOff = last ? daysBetween(last.date, race.date) : null;
    out.last = last || null;
    out.secondStart = !!(last && prev && daysBetween(prev.date, last.date) >= 90 && out.daysOff <= 70);
    out.distChange = last ? D - last.dist : 0;
    out.weightChange = (last && last.weight && entry?.weight) ? entry.weight - last.weight : 0;
    out.lastJockey = last?.jockey || null;
    out.gradeChange = last ? (GRADE_RANK[race.grade] ?? 4) - (GRADE_RANK[last.grade] ?? 4) : 0;
    out.bigRaceTop3 = runs.some(r => (r.grade === "G1" || r.grade === "G2") && r.pos <= 3);
    return out;
  }

  // ===== 血統（種牡馬の傾向。一般に言われる適性を数値化した目安。DB内の同じ父の産駒成績で補正） =====
  // line: 父系 / dist: 芝の得意距離帯 / wet: 道悪適性(-1〜+1) / grow: 成長力（晩成ほど+）
  const SIRES = {
    "ディープインパクト": { line: "ディープ系", dist: [1600, 2400], wet: -0.3, grow: 0 },
    "キズナ": { line: "ディープ系", dist: [1600, 2400], wet: 0.4, grow: 0.2 },
    "リアルスティール": { line: "ディープ系", dist: [1600, 2000], wet: 0, grow: 0 },
    "シルバーステート": { line: "ディープ系", dist: [1400, 2000], wet: 0.1, grow: 0 },
    "ディープブリランテ": { line: "ディープ系", dist: [1600, 2000], wet: 0.2, grow: 0 },
    "キタサンブラック": { line: "サンデー系", dist: [1800, 3000], wet: 0.2, grow: 0.3 },
    "ヴィクトワールピサ": { line: "サンデー系", dist: [1800, 2400], wet: 0.3, grow: 0 },
    "アドマイヤマーズ": { line: "サンデー系", dist: [1400, 2000], wet: 0, grow: 0 },
    "ゴールドシップ": { line: "ステイゴールド系", dist: [2000, 3200], wet: 0.5, grow: 0.3 },
    "ハーツクライ": { line: "ハーツクライ系", dist: [1800, 2500], wet: 0, grow: 0.4 },
    "スワーヴリチャード": { line: "ハーツクライ系", dist: [1800, 2400], wet: 0, grow: 0.2 },
    "ジャスタウェイ": { line: "ハーツクライ系", dist: [1600, 2400], wet: 0.1, grow: 0.3 },
    "ロードカナロア": { line: "キンカメ系", dist: [1200, 1800], wet: 0, grow: -0.1 },
    "サートゥルナーリア": { line: "キンカメ系", dist: [1600, 2400], wet: 0, grow: 0 },
    "ドゥラメンテ": { line: "キンカメ系", dist: [1800, 2400], wet: 0, grow: 0 },
    "ルーラーシップ": { line: "キンカメ系", dist: [2000, 3200], wet: 0.2, grow: 0.3 },
    "スクリーンヒーロー": { line: "ロベルト系", dist: [1600, 2500], wet: 0.3, grow: 0.3 },
    "モーリス": { line: "ロベルト系", dist: [1600, 2000], wet: 0.2, grow: 0.2 },
    "エピファネイア": { line: "ロベルト系", dist: [1600, 2400], wet: 0.2, grow: 0 },
    "ポエティックフレア": { line: "サドラーズウェルズ系", dist: [1600, 2000], wet: 0.3, grow: 0 },
    "シスキン": { line: "ミスプロ系", dist: [1200, 1800], wet: 0, grow: -0.1 },
    "ファインニードル": { line: "ミスプロ系", dist: [1200, 1600], wet: 0, grow: 0 },
    "アメリカンペイトリオット": { line: "ダンチヒ系", dist: [1400, 1800], wet: 0, grow: 0 },
    "マインドユアビスケッツ": { line: "ノーザンダンサー系", dist: [1400, 2000], wet: 0.2, grow: 0 }
  };
  // 母父の道悪・スタミナの目安
  const DAMSIRE_WET = { "ステイゴールド": 0.4, "Galileo": 0.4, "Frankel": 0.3, "High Chaparral": 0.4, "Lomitas": 0.3, "ジェネラス": 0.3, "Shamardal": 0.2, "ディープインパクト": -0.2, "マンハッタンカフェ": 0.1, "フレンチデピュティ": 0.1, "ルーラーシップ": 0.2, "ブライアンズタイム": 0.3, "ハーツクライ": 0.1, "ネオユニヴァース": 0.2 };
  function bloodProfile(horse, race, horsesDB){
    const s = SIRES[horse.sire];
    const out = { sire: horse.sire || null, line: s?.line || null, why: [] };
    if (!horse.sire) return { ...out, pts: 0 };
    let pts = 0;
    const D = race.distance;
    const runs = (horse.runs || []).map(parseRun).filter(r => !race.date || !r.date || r.date < race.date);
    const nNear = runs.filter(r => r.surface === race.surface && Math.abs(r.dist - D) <= 200).length;
    const rely = 1 / (1 + nNear / 3);                         // 実績が多い距離ほど血統の重みは小さく
    if (s && race.surface === "芝"){
      const [lo, hi] = s.dist;
      const off = D < lo ? lo - D : D > hi ? D - hi : 0;
      const v = (off === 0 ? 0.5 : -0.9 * Math.min(1, off / 400)) * rely;
      pts += v; if (Math.abs(v) > 0.15) out.why.push(off === 0 ? `父${horse.sire}の得意距離` : `父${horse.sire}には距離${D < lo ? "短い" : "長い"}`);
    }
    if (wet(race.going)){
      const wetN = runs.filter(r => wet(r.going)).length;
      const w = ((s?.wet || 0) * 0.9 + (DAMSIRE_WET[horse.damsire] || 0) * 0.5) * ({ 稍: 0.6, 重: 1, 不: 1.3 }[race.going] || 0) / (1 + wetN / 2);
      pts += w; if (Math.abs(w) > 0.15) out.why.push(w > 0 ? "道悪の血統" : "道悪割引の血統");
    }
    // DB内の同じ父の産駒（他の出走馬・過去走）の成績：この距離帯・馬場種別での着差評価
    const sibs = Object.values(horsesDB).filter(h => h !== horse && h.sire && h.sire === horse.sire);
    if (sibs.length){
      const rs = sibs.flatMap(h => (h.runs || []).map(parseRun)).filter(r => (!race.date || !r.date || r.date < race.date) && r.surface === race.surface && Math.abs(r.dist - D) <= 400 && r.margin != null && !r.overseas);
      if (rs.length >= 4){ const m = mean(rs.map(r => Math.min(2, r.margin))); const v = clamp((0.8 - m) * 0.6, -0.6, 0.6); pts += v; out.sibs = { n: rs.length, m }; if (Math.abs(v) > 0.15) out.why.push(`同じ父の産駒がこの条件で${v > 0 ? "好成績" : "苦戦"}`); }
    }
    out.pts = pts; return out;
  }
  // ===== 季節：その馬の季節別の成績（今回の開催月の季節と比較） =====
  const seasonOf = d => { const m = +d.slice(5, 7); return m >= 3 && m <= 5 ? "春" : m >= 6 && m <= 8 ? "夏" : m >= 9 && m <= 11 ? "秋" : "冬"; };
  function seasonProfile(runs, raceDate){
    const sNow = seasonOf(raceDate);
    // クラスの上下の影響を除くため「そのレースの中での走り（勝ち馬との着差）」で比較
    const perf = r => r.adjRating - (GRADE_BASE[r.grade] ?? 64);
    const rel = runs.filter(r => !r.overseas && r.adjRating != null && r.margin != null);
    const inS = rel.filter(r => seasonOf(r.date) === sNow), all = mean(rel.map(perf));
    const bySeason = {}; ["春","夏","秋","冬"].forEach(k => { const x = rel.filter(r => seasonOf(r.date) === k); bySeason[k] = x.length ? { n: x.length, top3: x.filter(r => r.pos <= 3).length } : { n: 0, top3: 0 }; });
    if (!inS.length || all == null) return { pts: 0, season: sNow, bySeason };
    const d = mean(inS.map(perf)) - all;
    return { pts: clamp(d * 0.18, -1.2, 1.2) * inS.length / (inS.length + 2), season: sNow, bySeason, diff: d };
  }

  // ===== 学習済みの重み（learn_model.py の出力で上書き。既定は全て1） =====
  let WEIGHTS = {};
  function setWeights(w){ WEIGHTS = { ...(w || {}) }; }

  // --- レース文脈の構築（各馬の総合ポイント内訳） ---
  function buildContext(race, horsesDB, opts = {}){
    const going = opts.going || race.going || "良";
    const R = { ...race, going, grade: race.grade || gradeOf(race.name) };
    const N = R.entries.length;
    const course = courseOf(R.venue, R.surface, R.distance);
    const meanKg = R.entries.reduce((a,e)=>a+e.weight,0) / N;
    const model = buildSpeedModel(horsesDB, R.date);
    const trend = opts.trend || null, track = opts.track || null;
    const field = R.entries.map(e => {
      const h = horsesDB[e.horseId] || horsesDB[e.name] || { runs: [] };
      const p = profile(h, R, e, model);
      const age = parseInt((e.sexAge||"").slice(1),10) || 4;
      const jNow = jockeyPts(e.jockey), jLast = p.lastJockey ? jockeyPts(p.lastJockey) : jNow;
      const adj = {
        能力: p.ability,
        調子: clamp(p.trend * 0.2, -2, 2),
        距離: p.distApt,
        芝ダ: p.surfApt,
        馬場: p.goingApt,
        競馬場: p.courseApt,
        回り: p.dirApt,
        枠: p.gateApt,
        斤量: -(e.weight - meanKg) * 0.9 - clamp(p.weightChange, -3, 3) * 0.3,
        騎手: jNow,
        乗替: p.lastJockey && jockeyKey(p.lastJockey) !== jockeyKey(e.jockey) ? clamp((jNow - jLast) * 0.4, -0.8, 0.8) : 0,
        調教: ((opts.training?.[e.num] ?? e.training?.score ?? h.training?.score ?? 50) - 50) / 10,
        ローテ: p.daysOff == null ? 0 : p.daysOff > 365 ? -3 : p.daysOff > 180 ? -1.5 : p.daysOff < 14 ? -0.5 : 0,
        年齢: (age === 3 && R.date >= R.date.slice(0,4) + "-09") ? 0.8 : age >= 7 ? -(age - 6) * 0.8 : 0,
        手動: opts.manual?.[e.num] ?? 0
      };
      const bp = bloodProfile(h, R, horsesDB), sp = seasonProfile(p.runs, R.date);
      adj.血統 = bp.pts; adj.季節 = sp.pts;
      p.blood = bp; p.seasonInfo = sp;
      // 穴好走パターン
      const pop = e.pop || null;
      const ana = [];
      const hit = k => ana.push(k);
      if (p.last?.discounted || (p.last?.trouble?.length && p.last.rating < p.ability)) hit("前走度外視");
      if (p.last?.grade === "G1" && (GRADE_RANK[R.grade] ?? 4) < 7 && p.last.pos >= 4) hit("G1からの格下げ");
      if (p.bigRaceTop3 && pop && pop >= 6) hit("実績の割に人気薄");
      if (p.distChange <= -200) hit("距離短縮");
      if (p.secondStart) hit("叩き2戦目");
      if (p.lastJockey && jNow - jLast >= 0.6) hit("鞍上強化");
      if ((e.num - 1) / Math.max(1, N - 1) <= 0.25 && p.earlyPos < 0.35 && p.n) hit("内枠の先行馬");
      if (p.courseGood) hit("コース巧者");
      // ---- 追加の候補 ----
      const L = p.last, pv = p.runs?.[1];
      if (L && L.pos >= 4 && L.passing?.length && L.passing[L.passing.length - 1] - L.pos >= 4) hit("前走で追い込み届かず");
      if (p.n >= 2 && p.earlyPos < 0.2) hit("先行力あり");
      if (p.weightChange <= -3) hit("斤量3kg以上減");
      if (/^[▲△☆◇★]/.test(e.jockey || "")) hit("減量騎手");
      if (L && L.surface !== "障" && R.surface !== "障" && L.surface !== R.surface) hit("芝ダ替わり");
      if (/稍|重|不/.test(going) && p.wetDiff != null && p.wetDiff >= 2) hit("道悪巧者×道悪");
      const tg = (opts.training?.[e.num] ?? e.training?.score ?? h.training?.score);
      if (tg != null && tg >= 75 && pop && pop >= 6) hit("調教高評価の人気薄");
      const oh = (e.oddsHist || []).filter(x => x.o > 1);
      if (oh.length >= 2 && e.odds > 1 && oh[0].o / e.odds >= 1.3) hit("直前に買われた");
      if (L && pv && (GRADE_RANK[L.grade] ?? 4) > (GRADE_RANK[pv.grade] ?? 4) && (GRADE_RANK[R.grade] ?? 4) === (GRADE_RANK[L.grade] ?? 4)) hit("昇級2戦目");
      if (p.daysOff != null && p.daysOff >= 90 && (p.runs || []).some((r, i) => r.pos <= 3 && p.runs[i + 1] && daysBetween(p.runs[i + 1].date, r.date) >= 90)) hit("鉄砲駆け実績");
      adj.穴要素 = ana.reduce((a, k) => a + (ANA[k]?.pts || 0), 0);
      const sigmaUp = ana.reduce((a, k) => a + (ANA[k]?.sig || 0), 0);
      Object.keys(adj).forEach(k => { if (k !== "能力" && k !== "手動" && WEIGHTS[k] != null) adj[k] *= WEIGHTS[k]; });
      let P = Object.values(adj).reduce((a,b)=>a+b,0);
      return { ...e, prof: p, adj, P, sigma: p.sigma + sigmaUp * 0.5, earlyPos: p.earlyPos, style: p.style, kick: p.kick, horse: h, ana };
    });
    // ---- スピード指数・レース傾向・当日の馬場（クッション値など） ----
    const figs = field.map(f => f.prof.speedFig).filter(x => x != null);
    const meanFig = figs.length ? mean(figs) : null;
    const bests = field.map(f => f.prof.bestFig).filter(x => x != null);
    const meanBest = bests.length ? mean(bests) : null;
    const wetNow = wet(going);
    // 穴パターン（メンバー全体を見て決まるもの）：単騎逃げ見込み・持ち時計上位
    {
      const nige = field.filter(f => f.prof.n && f.style === "逃げ");
      const bestRank = field.filter(f => f.prof.bestFig != null).sort((a, b) => b.prof.bestFig - a.prof.bestFig).slice(0, 3);
      field.forEach(f => {
        const add = [];
        if (nige.length === 1 && nige[0] === f) add.push("単騎逃げ見込み");
        if (bestRank.includes(f) && (f.pop || 99) >= 4) add.push("持ち時計上位");
        add.forEach(k => { f.ana.push(k); const v = (ANA[k]?.pts || 0) * (WEIGHTS.穴要素 ?? 1); f.adj.穴要素 += v; f.P += v; f.sigma += (ANA[k]?.sig || 0) * 0.5; });
      });
    }
    field.forEach(f => {
      const p = f.prof, gRel = (f.num - 1) / Math.max(1, N - 1);
      // スピード指数：場の平均との差（指数1＝約0.1秒、能力評価との二重計上を避け0.35倍）
      f.adj.スピード = (p.speedFig != null && meanFig != null) ? clamp((p.speedFig - meanFig) * 0.35, -4, 4) : (meanFig != null ? -1 : 0);
      // レース傾向（過去の同レースの集計にもとづく）
      let tr = 0; const why = [];
      if (trend){
        const sb = trend.styleBias?.[p.style]; if (sb && p.n){ tr += sb; why.push(`${p.style}${sb > 0 ? "有利" : "不利"}`); }
        const lr = p.last && (trend.lastRace || []).find(x => new RegExp(x.re).test(p.last.race)); if (lr){ tr += lr.pts; why.push(lr.label); }
        const lc = p.last && trend.lastClass?.[p.last.grade]; if (lc){ tr += lc; why.push(`前走${p.last.grade}組`); }
        if (trend.lastMargin && p.last?.margin != null && p.last.margin >= trend.lastMargin.over && !p.last.discounted){ tr += trend.lastMargin.pts; why.push(`前走${p.last.margin.toFixed(1)}秒負け`); }
        if (trend.gateNums && trend.gateNums.nums.includes(f.num)){ tr += trend.gateNums.pts; why.push(trend.gateNums.label); }
        const wk = trend.waku?.[f.waku]; if (wk){ tr += wk; why.push(`${f.waku}枠`); }
        const jk = trend.jockey?.[jockeyKey(f.jockey)]; if (jk){ tr += jk; why.push(`${jockeyKey(f.jockey)}騎手の好相性`); }
        const age = parseInt((f.sexAge || "").slice(1), 10);
        if (trend.oldRelief && age >= 7){ tr += Math.min(trend.oldRelief, (age - 6) * 0.8); why.push("高齢でも走れるレース"); }
        const sl = trend.sire?.[f.horse?.sire] ?? (p.blood?.line ? trend.sireLine?.[p.blood.line] : null);
        if (sl){ tr += sl; why.push(`${trend.sire?.[f.horse?.sire] != null ? "父" + f.horse.sire : p.blood.line}の好走傾向`); }
        if (trend.fastKick && p.bestLast3f != null && p.bestLast3f <= trend.fastKick.max){ tr += trend.fastKick.pts; why.push(`上がり${p.bestLast3f.toFixed(1)}秒の実績`); }
      }
      f.adj.レース傾向 = tr; f.trendWhy = why;
      // 当日の馬場：クッション値・含水率・開催週・天候
      let tk = 0; const tw = [];
      if (track && R.surface === "芝"){
        let firm = (track.cushion ?? 9.5) - 9.5;
        if (wetNow) firm = Math.min(firm, 0) - ({ 稍: 0.4, 重: 0.9, 不: 1.4 }[going] || 0);
        const fb = (track.frontBias || 0) * (wetNow ? 0.6 : 1);
        if (fb && p.n){ const v = fb * (0.35 - p.earlyPos) * 2.2; tk += v; if (Math.abs(v) > 0.2) tw.push(v > 0 ? "前が残りやすい馬場" : "前残り馬場で後方は不利"); }
        if (track.innerBias){ const v = track.innerBias * (0.5 - gRel) * 2; tk += v; if (Math.abs(v) > 0.2) tw.push(v > 0 ? "内枠有利の開幕週" : "外枠はロス"); }
        if (firm > 0.2 && p.bestFig != null && meanBest != null){ const v = clamp((p.bestFig - meanBest) * 0.08 * firm, -1.2, 1.2); tk += v; if (Math.abs(v) > 0.2) tw.push(v > 0 ? "高速馬場向きの持ち時計" : "時計勝負で見劣り"); }
        if (firm < -0.2 && p.wetDiff != null){ const v = clamp(p.wetDiff * 0.12 * -firm, -1.5, 1.5); tk += v; if (Math.abs(v) > 0.2) tw.push(v > 0 ? "時計のかかる馬場向き" : "渋った馬場は割引"); }
      }
      f.adj.当日馬場 = tk; f.trackWhy = tw;
      ["スピード","レース傾向","当日馬場"].forEach(k => { if (WEIGHTS[k] != null) f.adj[k] *= WEIGHTS[k]; });
      f.P += f.adj.スピード + f.adj.レース傾向 + f.adj.当日馬場;
    });
    // 能力差の過信を抑えるため場平均へ収縮
    const mA = field.reduce((a,f)=>a+f.adj.能力,0) / N;
    field.forEach(f => { const shr = (f.adj.能力 - mA) * -0.3; f.adj.能力 += shr; f.P += shr; });
    // オッズがあれば市場評価をブレンド
    // 人気の変動：前日（最初に取れたオッズ）→今のオッズで、大きく買われた馬を少し加点・売られた馬を減点
    field.forEach(f => {
      const h = (f.oddsHist || []).filter(x => x.o > 1);
      f.popMove = null; f.adj.人気変動 = 0;
      if (h.length >= 2 && f.odds > 1){
        const first = h[0], d = Math.log(first.o / f.odds);
        f.popMove = { fromOdds: first.o, fromPop: first.p, toOdds: f.odds, toPop: f.pop, at: first.t, ratio: first.o / f.odds };
        if (Math.abs(d) >= 0.12){ f.adj.人気変動 = clamp(d * 1.1, -1.0, 1.5) * (WEIGHTS.人気変動 ?? 1); f.P += f.adj.人気変動; }
      }
    });
    if (oddsReady(field)) {
      const meanP = field.reduce((a,f)=>a+f.P,0)/N;
      const fo = filledOdds(field);
      const inv = fo.map(o => 1 / o); const s = inv.reduce((a,b)=>a+b,0);
      field.forEach((f,i) => { const mkt = meanP + 5 * Math.log(inv[i]/s * N); f.adj.市場 = (trend?.marketWeight ?? 0.4) * (mkt - f.P); f.P += f.adj.市場; });
    }
    const refPts = field.reduce((a,f)=>a+f.P,0) / N;
    const frontCount = field.filter(f => f.earlyPos < 0.2).length;
    const D = R.distance;
    let v = R.surface === "ダ" ? 17.5 - 0.7 * D / 1000 : R.surface === "障" ? 14.6 : 17.9 - 0.5 * D / 1000;
    const goingF = R.surface === "ダ" ? {良:1,稍:0.995,重:0.99,不:0.988} : {良:1,稍:1.006,重:1.013,不:1.022};
    let baseTime = D / v * (goingF[going] || 1) + (70 - (GRADE_BASE[R.grade] ?? 64)) * 0.04 * D / 1000;
    return { race: R, field, N, course, refPts, frontCount, baseTime,
             straightBias: (course.str - 400) / 125 * 1.2 };
  }


  // --- 乱数 ---
  function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function gauss(rng){ let u = 0, v = 0; while(!u) u = rng(); while(!v) v = rng(); return Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v); }

  // --- 1レース分のシミュレーション ---
  // paceMode: null=自然発生 / "slow" / "mid" / "high"（ペースを固定したシナリオ）
  const PACE_FIX = { slow: 0.8, mid: 2.1, high: 3.4 };
  const paceLabelOf = pace => pace >= 2.9 ? "ハイペース" : pace <= 1.3 ? "スローペース" : "ミドルペース";
  // ペース予想：出走馬の脚質（前に行く馬の数）から、自然に起きるペースの確率を計算（シミュレーションと同じ式）
  const ncdf = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
  function paceForecast(ctx){
    const mu = 1.0 + 0.5 * ctx.frontCount, sd = 0.9;
    const slow = ncdf((1.3 - mu) / sd), high = 1 - ncdf((2.9 - mu) / sd), mid = Math.max(0, 1 - slow - high);
    const by = k => ctx.field.filter(f => f.prof.n && f.style === k);
    const fronts = ctx.field.filter(f => f.earlyPos < 0.2).sort((a, b) => a.earlyPos - b.earlyPos);
    const probs = { slow, mid, high };
    const best = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
    return { ...probs, best, frontCount: ctx.frontCount, fronts: fronts.map(f => ({ num: f.num, name: f.name, style: f.style })),
      styles: { 逃げ: by("逃げ").length, 先行: by("先行").length, 差し: by("差し").length, 追込: by("追込").length } };
  }
  function simulateOne(ctx, seed, trace, paceMode){
    const rng = mulberry32(seed);
    const { field, N } = ctx;
    const pace = paceMode ? PACE_FIX[paceMode] + gauss(rng) * 0.3
                          : 1.0 + 0.5 * ctx.frontCount + gauss(rng) * 0.9;   // 先行争いの激しさ
    const paceNeutral = 2.1;
    const res = new Array(N);
    for (let i = 0; i < N; i++){
      const f = field[i];
      let early = clamp(f.earlyPos + gauss(rng) * 0.09, 0, 1);
      let p = f.P + gauss(rng) * f.sigma;
      const ev = [];
      if (rng() < 0.03){ const l = 1 + 2 * rng(); p -= l; early = clamp(early + 0.18, 0, 1); ev.push("出遅れ"); }
      const paceAdj = (pace - paceNeutral) * (early - 0.5) * 3.5;
      const strAdj = ctx.straightBias * (early - 0.5) * 0.8;
      const inside = 1 - (f.num - 1) / Math.max(1, N - 1);
      if (early > 0.45 && rng() < 0.08 + 0.08 * inside){ const l = 1 + 3 * rng(); p -= l; ev.push("進路カット"); }
      const total = p + paceAdj + strAdj;
      res[i] = { i, total, early, ev };
    }
    const order = res.slice().sort((a,b) => b.total - a.total).map(r => r.i);
    if (!trace){ order.pace = pace; return order; }
    // スローは道中が遅く上がりが速い／ハイは逆。走破タイムに反映
    const paceTime = (pace - paceNeutral) * -0.35;
    const times = res.map(r => ctx.baseTime + paceTime - (r.total - ctx.refPts) * 0.1);
    const earlyOrder = res.slice().sort((a,b) => a.early - b.early).map(r => r.i);
    return { order, times, early: res.map(r=>r.early), earlyOrder, events: res.map(r=>r.ev), pace, paceLabel: paceLabelOf(pace) };
  }

  // --- モンテカルロ（chunk実行で進捗コールバック） ---
  async function monteCarlo(ctx, runs = 10000, seedBase = 20261004, onProgress, paceMode = null){
    const N = ctx.N;
    const win = new Float64Array(N), top2 = new Float64Array(N), top3 = new Float64Array(N), sumPos = new Float64Array(N);
    const posHist = Array.from({length:N}, () => new Uint32Array(N));
    const orders = new Uint8Array(runs * N);
    const paceDist = { "スローペース": 0, "ミドルペース": 0, "ハイペース": 0 };
    const chunk = 2000;
    for (let k = 0; k < runs; k += chunk){
      const end = Math.min(runs, k + chunk);
      for (let r = k; r < end; r++){
        const o = simulateOne(ctx, seedBase + r, false, paceMode);
        paceDist[paceLabelOf(o.pace)]++;
        for (let p = 0; p < N; p++){
          const h = o[p]; orders[r * N + p] = h;
          sumPos[h] += p + 1; posHist[h][p]++;
          if (p === 0) win[h]++; if (p < 2) top2[h]++; if (p < 3) top3[h]++;
        }
      }
      if (onProgress){ onProgress(end / runs); await new Promise(r => setTimeout(r, 0)); }
    }
    Object.keys(paceDist).forEach(k => paceDist[k] /= runs);
    const stats = ctx.field.map((f, i) => ({
      i, num: f.num, name: f.name,
      win: win[i] / runs, top2: top2[i] / runs, top3: top3[i] / runs, avgPos: sumPos[i] / runs,
      fairOdds: win[i] ? runs / win[i] : null, hist: Array.from(posHist[i]).map(c => c / runs)
    }));
    // 代表展開：平均着順との差が最小のレース
    let bestR = 0, bestD = Infinity;
    const avg = stats.map(s => s.avgPos);
    for (let r = 0; r < runs; r++){
      let d = 0; for (let p = 0; p < N; p++) d += Math.abs(p + 1 - avg[orders[r * N + p]]);
      if (d < bestD){ bestD = d; bestR = r; }
    }
    return { runs, seedBase, stats, orders, representative: bestR, paceDist, paceMode };
  }

  function findRunWhereWins(result, idx){
    const N = result.stats.length;
    const cand = [];
    for (let r = 0; r < result.runs; r++) if (result.orders[r * N] === idx) cand.push(r);
    return cand.length ? cand[Math.floor(Math.random() * cand.length)] : null;
  }

  // 枠番
  function wakuOf(num, N){
    if (N <= 8) return num;
    const cnt = new Array(8).fill(1); let rest = N - 8, k = 7;
    while (rest > 0){ cnt[k]++; rest--; k = k === 0 ? 7 : k - 1; }
    let acc = 0; for (let w = 0; w < 8; w++){ acc += cnt[w]; if (num <= acc) return w + 1; }
    return 8;
  }

  return { paceForecast, oddsReady, filledOdds, bloodProfile, seasonProfile, setWeights, get WEIGHTS(){ return WEIGHTS; }, SIRES, seasonOf, buildSpeedModel, speedFigure, setAnaWeights, get ANA(){ return ANA; }, ANA_DEFAULT, jockeyKey, paceLabelOf, COURSE, courseOf, gradeOf, parseRun, profile, buildContext, simulateOne, monteCarlo, findRunWhereWins, wakuOf, jockeyPts, GRADE_BASE };
})();
if (typeof module !== "undefined") module.exports = Engine;
