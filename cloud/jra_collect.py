"""
JRA公式の「競走中の出来事等」を集める（前走の不利の本番テスト用）
------------------------------------------------------------------
・JRAのページはアドレスに検証用の文字が入るため、ページに書かれたリンクをたどって進む：
    過去レース結果検索（pw01skl00999999/B3）→ 月（pw01skl10YYYYMM）→ 開催日・場（pw01srl…）→ レース結果（pw01sde…）
・サイトに負担をかけないよう、1回ごとに2秒あける。止めても続きから再開する（data/jra/progress.json）。
・集めた出来事は data/jra/incidents.json に「レースID（netkeibaと同じ12桁）→ 被害馬の馬番・名前の出た馬」で保存する。
  出来事の記載がないレースも空の記録として残す（取れたレースと、まだ取っていないレースを区別するため）。
"""
import datetime as dt, json, re, threading, time, traceback
from pathlib import Path
import requests

BASE = "https://www.jra.go.jp/JRADB/accessS.html"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
CN = re.compile(r"(pw01s[a-z]{2}\d{2}\w*?/[0-9A-Fa-f]{2})")
DELAY = 2.0
DIR = None
LOCK = threading.Lock()
ST = {"running": False, "stop": False, "cur": "", "requests": 0, "log": [], "error": None, "from": None, "to": None}


def init(data_dir):
    global DIR
    DIR = Path(data_dir) / "jra"; DIR.mkdir(parents=True, exist_ok=True)


def _load(name, default):
    p = DIR / name
    if p.exists():
        try: return json.loads(p.read_text(encoding="utf-8"))
        except Exception: pass
    return default


def _save(name, obj): (DIR / name).write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


def _log(msg):
    line = f"{dt.datetime.now().strftime('%m-%d %H:%M:%S')} {msg}"
    print("[JRA出来事] " + line, flush=True)
    with LOCK: ST["log"] = (ST["log"] + [line])[-80:]


Z2H = str.maketrans("０１２３４５６７８９", "0123456789")


def parse(html):
    """「競走中の出来事等」の文から、被害馬（馬番・名前）、制裁を受けた馬（加害）、そのほか名前の出た馬（出遅れ・つまずき・疾病など）を取り出す"""
    i = html.find("競走中の出来事")
    if i < 0: return None
    seg = re.sub(r"<[^>]+>", "\n", html[i:i + 8000])
    lines = []
    for x in [re.sub(r"\s+", " ", y).strip(" ・") for y in seg.split("\n")][1:]:
        if not x: continue
        if re.search(r"(払戻金|勝馬|ハロンタイム|コーナー通過|お問い合わせ|ページの先頭)", x) and lines: break
        if "号" in x: lines.append(x)
    v, vn, o, xs = set(), set(), set(), set()
    NAME = r"([ァ-ヶーｦ-ﾟA-Za-zＡ-Ｚａ-ｚ・]{2,})号"
    for line in lines:
        for s in [t for t in re.split(r"。", line) if t.strip()]:
            for m in re.finditer(r"被害馬[：:]\s*([０-９0-9、，,・\s番]+)", s):
                for d in re.findall(r"\d+", m.group(1).translate(Z2H)): v.add(int(d))
            pen = re.search(r"(過怠金|戒告|騎乗停止|制裁|注意)", s)
            ms = [(m.group(1), s[m.end():m.end() + 8]) for m in re.finditer(NAME, s)]
            hurt = any(re.match(r"(の進路|に接触|に触れ|と接触|と触れ|が不利|に不利|の走行)", a) for _, a in ms) or "被害馬" in s
            for nm, after in ms:
                if re.match(r"(の進路|に接触|に触れ|と接触|と触れ|が不利|に不利|の走行)", after): vn.add(nm)
                elif pen and after.startswith("の騎手"): o.add(nm)
                elif hurt and re.match(r"(は|の騎手)", after) and re.search(r"(斜行|寄れ|もたれ|切れ込)", s): o.add(nm)   # 他の馬の進路をふさいだ側（制裁なしでも）
                else: xs.add(nm)
    return {"v": sorted(v), "vn": sorted(vn), "o": sorted(o), "x": sorted(xs - o - vn), "t": lines[:8]}


def _rid(cname):
    """pw01sde10 VV YYYY KK DD RR YYYYMMDD → netkeibaと同じ12桁（YYYY VV KK DD RR）と日付"""
    m = re.match(r"pw01sde10(\d{2})(\d{4})(\d{2})(\d{2})(\d{2})(\d{8})", cname)
    if not m: return None, None
    vv, yy, kk, dd, rr, ymd = m.groups()
    return f"{yy}{vv}{kk}{dd}{rr}", f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}"


class Client:
    def __init__(self):
        self.s = requests.Session(); self.s.headers.update({"User-Agent": UA, "Accept-Language": "ja"})
        self.last = 0
    def post(self, cname):
        wait = DELAY - (time.time() - self.last)
        if wait > 0: time.sleep(wait)
        r = self.s.post(BASE, data={"cname": cname}, timeout=30); self.last = time.time()
        with LOCK: ST["requests"] += 1
        r.encoding = "shift_jis" if "shift_jis" in (r.headers.get("content-type", "").lower() + r.text[:600].lower()) else (r.apparent_encoding or "utf-8")
        if r.status_code != 200: raise RuntimeError(f"HTTP {r.status_code}（{cname}）")
        return r.text


def _months(frm, to):
    y, m = int(frm[:4]), int(frm[5:7]); out = []
    while f"{y:04d}{m:02d}" <= to[:4] + to[5:7]:
        out.append(f"{y:04d}{m:02d}"); m += 1
        if m > 12: y, m = y + 1, 1
    return out


def _loop(frm, to):
    """月のページと、開催日（場）ごとのレース一覧のページに書かれたリンクを、期間内のものだけすべてたどる。
    一覧のページには同じ日のほかの場や前後の開催日へのリンクもあるので、それもたどる（月のページに全部の開催が載っていなくても集まる）。
    済んだ一覧は記録して2回目からは飛ばす。取っていないレースだけ結果のページを開く。"""
    pr = _load("progress.json", {})
    lists_done = pr.setdefault("lists", {}); scanned = pr.setdefault("scanned", {})
    inc = _load("incidents.json", {})
    c = Client()
    lo, hi = frm.replace("-", ""), to.replace("-", "")
    inrange = lambda x: (lambda m: bool(m) and lo <= m.group(1) <= hi)(re.search(r"(\d{8})/", x))
    try:
        want = set(_months(frm, to))
        mon = dict(pr.get("monthC") or {})
        lq, seenL = [], set()
        def harvest(html, src):
            new_m = []
            for x in dict.fromkeys(CN.findall(html)):
                m = re.match(r"pw01skl10(\d{6})/", x)
                if m:
                    if m.group(1) not in mon: new_m.append(m.group(1))
                    mon[m.group(1)] = x
                elif x.startswith("pw01srl") and inrange(x) and x not in seenL:
                    seenL.add(x); lq.append(x)
            return new_m
        # ① 月のページ：過去レース結果検索のページ → 見つかった月のページ（前後の月へのリンクもたどる）
        fetchedM, queue = set(), ["pw01skl00999999/B3"]
        while not ST["stop"]:
            todo = [ym for ym in sorted(want) if ym in mon and mon[ym] not in fetchedM]
            cn = queue.pop(0) if queue else (mon[todo[0]] if todo else None)
            if not cn: break
            if cn in fetchedM: continue
            fetchedM.add(cn)
            with LOCK: ST["cur"] = "月の一覧を見ています"
            before = len(lq); harvest(c.post(cn), cn)
            m = re.match(r"pw01skl10(\d{6})/", cn)
            if m: _log(f"{m.group(1)[:4]}年{int(m.group(1)[4:])}月：開催の一覧 {len(lq) - before}件")
            if len(fetchedM) > 40: break
        pr["monthC"] = mon; _save("progress.json", pr)
        miss = sorted(w for w in want if w not in mon)
        if miss: _log(f"月のページが見つかりませんでした：{', '.join(miss)}（このログを送ってください）")
        # 前の版で済ませた一覧も、ほかの場へのリンクを探すために1回だけ見直す
        for li in list(lists_done):
            if inrange(li) and li not in seenL and not scanned.get(li): seenL.add(li); lq.append(li)
        # ② 開催日・場ごとのレース一覧 → レース結果
        while lq and not ST["stop"]:
            lq.sort(key=lambda x: re.search(r"(\d{8})/", x).group(1))
            li = lq.pop(0)
            if lists_done.get(li) and scanned.get(li): continue
            ymd = re.search(r"(\d{8})/", li).group(1); day = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}"
            with LOCK: ST["cur"] = f"{ymd[:4]}/{ymd[4:6]}/{ymd[6:]} のレース一覧（残り{len(lq)}）"
            html = c.post(li); harvest(html, li)
            races = [x for x in dict.fromkeys(CN.findall(html)) if x.startswith("pw01sde") and (_rid(x)[1] or "") == day]
            n = 0
            for rc in races:
                if ST["stop"]: break
                rid, date = _rid(rc)
                if not rid or rid in inc: continue
                with LOCK: ST["cur"] = f"{date} {rid[-2:]}R の結果（一覧の残り{len(lq)}）"
                p = parse(c.post(rc))
                inc[rid] = {"d": date, **(p or {"v": [], "vn": [], "o": [], "x": [], "t": []})}; n += 1
                if n % 6 == 0: _save("incidents.json", inc)
            _save("incidents.json", inc)
            if not ST["stop"]:
                lists_done[li] = True; scanned[li] = True; _save("progress.json", pr)
                if n: _log(f"{ymd[:4]}/{ymd[4:6]}/{ymd[6:]}：新しく{n}レース（集めた合計 {len(inc)}）")
        _log("止めました" if ST["stop"] else f"集め終わりました（合計 {len(inc)}レース）")
    except Exception as ex:
        with LOCK: ST["error"] = str(ex)
        _log(f"エラーで止まりました：{ex}"); traceback.print_exc()
    finally:
        _save("incidents.json", inc)
        with LOCK: ST.update(running=False, cur="")


def start(frm, to):
    with LOCK:
        if ST["running"]: return False
        ST.update(running=True, stop=False, error=None, **{"from": frm, "to": to})
    threading.Thread(target=_loop, args=(frm, to), daemon=True).start()
    return True


def stop():
    with LOCK: ST["stop"] = True


def status():
    inc = _load("incidents.json", {})
    with LOCK: s = dict(ST); s["log"] = list(ST["log"])
    s["races"] = len(inc); s["withInc"] = sum(1 for r in inc.values() if r.get("v") or r.get("vn") or r.get("x") or r.get("o"))
    s["victims"] = sum(len(r.get("v") or []) + len(r.get("vn") or []) for r in inc.values())
    ds = sorted(r.get("d") for r in inc.values() if r.get("d")); s["range"] = [ds[0], ds[-1]] if ds else None
    return s


def incidents(): return _load("incidents.json", {})
