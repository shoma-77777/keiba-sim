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
    pr = _load("progress.json", {"lists": {}, "months": {}})
    inc = _load("incidents.json", {})
    c = Client()
    try:
        want = _months(frm, to)
        # ① 過去レース結果検索のページから、月のページへのリンクを集める（年の切り替えページもたどる・最大30回）
        mon, seen, queue, tries = dict(pr.get("monthC") or {}), set(), ["pw01skl00999999/B3"], 0
        while queue and any(w not in mon for w in want if not pr["months"].get(w)) and tries < 30 and not ST["stop"]:
            cn = queue.pop(0)
            if cn in seen: continue
            seen.add(cn); tries += 1
            with LOCK: ST["cur"] = "月の一覧を探しています"
            html = c.post(cn)
            for x in dict.fromkeys(CN.findall(html)):
                m = re.match(r"pw01skl10(\d{6})/", x)
                if m: mon[m.group(1)] = x
                elif x.startswith("pw01skl") and x not in seen: queue.append(x)
        pr["monthC"] = mon; _save("progress.json", pr)
        miss = [w for w in want if w not in mon and not pr["months"].get(w)]
        if miss: _log(f"月のページが見つかりませんでした：{', '.join(miss)}（JRAのページの作りが想定と違う可能性。ログを送ってください）")
        # ② 月 → 開催日・場 → レース結果
        for ym in want:
            if ST["stop"]: break
            if pr["months"].get(ym) or ym not in mon: continue
            with LOCK: ST["cur"] = f"{ym[:4]}年{int(ym[4:])}月の開催一覧"
            lists = [x for x in dict.fromkeys(CN.findall(c.post(mon[ym]))) if x.startswith("pw01srl")]
            lists = [x for x in lists if (lambda d: d and frm.replace("-", "") <= d <= to.replace("-", ""))(re.search(r"(\d{8})/", x).group(1) if re.search(r"(\d{8})/", x) else None)]
            for li in lists:
                if ST["stop"]: break
                if pr["lists"].get(li): continue
                ymd = re.search(r"(\d{8})/", li).group(1)
                with LOCK: ST["cur"] = f"{ymd[:4]}/{ymd[4:6]}/{ymd[6:]} のレース一覧"
                races = [x for x in dict.fromkeys(CN.findall(c.post(li))) if x.startswith("pw01sde")]
                races = [x for x in races if (_rid(x)[1] or "") == f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}"]
                n = 0
                for rc in races:
                    if ST["stop"]: break
                    rid, date = _rid(rc)
                    if not rid or rid in inc: continue
                    with LOCK: ST["cur"] = f"{date} {rid[-2:]}R の結果"
                    p = parse(c.post(rc))
                    inc[rid] = {"d": date, **(p or {"v": [], "vn": [], "o": [], "x": [], "t": []})}; n += 1
                    if n % 6 == 0: _save("incidents.json", inc)
                _save("incidents.json", inc)
                if not ST["stop"]:
                    pr["lists"][li] = True; _save("progress.json", pr)
                    k = sum(1 for r in inc.values() if r.get("d") == f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}" and (r.get("v") or r.get("vn") or r.get("x")))
                    _log(f"{ymd[:4]}/{ymd[4:6]}/{ymd[6:]}：{len(races)}レース（出来事のあったレース {k}）")
            if not ST["stop"] and ym < dt.date.today().strftime("%Y%m"): pr["months"][ym] = True; _save("progress.json", pr)
        _log("止めました" if ST["stop"] else "集め終わりました")
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
