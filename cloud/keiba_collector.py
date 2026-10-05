#!/usr/bin/env python3
"""
競馬データ収集スクリプト（netkeiba）
--------------------------------------------------
今後の日曜 JRA 全レースの番組・出馬表・各馬の全成績・血統・追い切り評価を集め、
SQLite（keiba.db）に保存し、シミュレーターアプリ用の JSON を書き出します。

  pip install requests beautifulsoup4 lxml
  python keiba_collector.py                 # 次の日曜1日分
  python keiba_collector.py --sundays 3     # 今後3週の日曜
  python keiba_collector.py --date 20261011 # 指定日（土曜なども可）
  python keiba_collector.py --no-history    # 馬柱(直近5走)のみで高速に

注意:
- サイトの利用規約・robots.txt を守り、個人利用の範囲で使ってください。
- 既定でリクエスト間隔 1.5 秒、取得HTMLは ./cache に保存し再実行時は再取得しません。
- サイト側のHTML構造が変わると取得できなくなることがあります。その場合はセレクタを調整してください。
"""
import argparse, datetime as dt, json, os, re, sqlite3, sys, time, hashlib
from pathlib import Path

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("requests と beautifulsoup4 が必要です: pip install requests beautifulsoup4 lxml")

BASE_RACE = "https://race.netkeiba.com"
BASE_DB = "https://db.netkeiba.com"
HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
VENUES = {"01":"札幌","02":"函館","03":"福島","04":"新潟","05":"東京","06":"中山","07":"中京","08":"京都","09":"阪神","10":"小倉"}
TRAIN_SCORE = {"A": 75, "B": 60, "C": 45, "D": 35}

class Fetcher:
    def __init__(self, delay=1.5, refresh=False, cache=True):
        self.s = requests.Session(); self.s.headers.update({"User-Agent": UA, "Referer": "https://race.netkeiba.com/", "Accept-Language": "ja,en;q=0.8"})
        self.delay, self.refresh, self.last, self.cache = delay, refresh, 0.0, cache   # cache=False：ページを保存しない（大量取得でディスクを使い切らないように）
        CACHE.mkdir(exist_ok=True)

    def get(self, url, ttl_hours=None, encoding=None):
        key = CACHE / (hashlib.md5(url.encode()).hexdigest() + ".html")
        if self.cache and key.exists() and not self.refresh:
            age = (time.time() - key.stat().st_mtime) / 3600
            if ttl_hours is None or age < ttl_hours:
                return key.read_text(encoding="utf-8")
        wait = self.delay - (time.time() - self.last)
        if wait > 0: time.sleep(wait)
        r = self.s.get(url, timeout=20); self.last = time.time()
        r.raise_for_status()
        # ページ自身が宣言している文字コードを最優先（サイト側の変更に強くする）
        m = re.search(rb'charset=["\']?([\w-]+)', r.content[:3000], re.I)
        if m and m.group(1).decode().lower() in ("utf-8", "euc-jp", "shift_jis", "sjis", "x-sjis"):
            r.encoding = m.group(1).decode()
        elif encoding: r.encoding = encoding
        elif not r.encoding or r.encoding.lower() in ("iso-8859-1",):
            r.encoding = r.apparent_encoding
        txt = r.text
        if self.cache: key.write_text(txt, encoding="utf-8")
        return txt

def soup(html): return BeautifulSoup(html, "lxml")
def clean(s): return re.sub(r"\s+", " ", s or "").strip()
def to_int(s):
    m = re.search(r"-?\d+", s or ""); return int(m.group()) if m else None
def to_float(s):
    m = re.search(r"-?\d+(\.\d+)?", (s or "").replace(",", "")); return float(m.group()) if m else None   # 1,255.8 のようなカンマ付きも正しく

# ---------- 開催日・番組 ----------
def upcoming_sundays(n):
    today = dt.date.today()
    first = today + dt.timedelta(days=(6 - today.weekday()) % 7)
    return [first + dt.timedelta(weeks=k) for k in range(n)]

def race_list(f, date):
    ymd = date.strftime("%Y%m%d")
    html = f.get(f"{BASE_RACE}/top/race_list_sub.html?kaisai_date={ymd}", ttl_hours=3)
    sp = soup(html); races = []
    for dl in sp.select("dl.RaceList_DataList"):
        title = clean(dl.select_one(".RaceList_DataTitle").get_text()) if dl.select_one(".RaceList_DataTitle") else ""
        for li in dl.select("li.RaceList_DataItem"):
            a = li.find("a", href=re.compile(r"race_id=\d{12}"))
            if not a: continue
            rid = re.search(r"race_id=(\d{12})", a["href"]).group(1)
            name = clean(li.select_one(".ItemTitle").get_text()) if li.select_one(".ItemTitle") else ""
            tm = li.select_one(".RaceList_Itemtime"); cond = li.select_one(".RaceList_ItemLong")
            num = li.select_one(".RaceList_Itemnumber, .Race_Num")
            races.append({
                "id": rid, "date": date.isoformat(), "venue": VENUES.get(rid[4:6], rid[4:6]),
                "no": int(rid[10:12]), "name": name, "kai": title,
                "postTime": clean(tm.get_text()) if tm else "",
                "condText": clean(cond.get_text()) if cond else "",
            })
    return races

def parse_racedata(text):
    """'15:45発走 / 芝1800m (左) / 天候:晴 / 馬場:良' を分解"""
    out = {}
    m = re.search(r"(芝|ダ|障)\s*(\d{3,4})m", text)
    if m: out["surface"], out["distance"] = m.group(1), int(m.group(2))
    m = re.search(r"\((右|左|直)", text);  out["direction"] = m.group(1) if m else None
    m = re.search(r"天候:(\S+)", text);   out["weather"] = m.group(1) if m else None
    m = re.search(r"馬場:(\S+)", text);   out["going"] = m.group(1)[0] if m else None
    m = re.search(r"(\d{1,2}:\d{2})発走", text); out["postTime"] = m.group(1) if m else None
    return out

def parse_bw(t):
    """馬体重「480(+2)」→ {"bodyWeight": "480(+2)", "bw": 480, "bwDiff": 2}（前走計不・初出走は増減なし）"""
    m = re.search(r"(\d{3})\s*\(\s*([+-]?\d+|前計不|計不|---)?\s*\)", clean(t or ""))
    if not m: return None
    d = m.group(2)
    return {"bodyWeight": f"{m.group(1)}({d})" if d else m.group(1), "bw": int(m.group(1)), "bwDiff": int(d) if d and re.fullmatch(r"[+-]?\d+", d) else None}

def body_weights(f, race, ttl_hours=0.1):
    """当日の出馬表から、最新の馬場状態・天候と、馬体重（発走の約70分前に発表）を取る。戻り値: 馬体重が取れた頭数"""
    html = f.get(f"{BASE_RACE}/race/shutuba.html?race_id={race['id']}", ttl_hours=ttl_hours, encoding="EUC-JP")
    sp = soup(html)
    rd = sp.select_one(".RaceData01")
    if rd:
        info = parse_racedata(clean(rd.get_text()))
        if info.get("going") and info["going"] != race.get("going"):
            race["goingPrev"] = race.get("going")
        if info.get("going"): race["going"] = info["going"]; race["goingAt"] = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
        if info.get("weather"): race["weather"] = info["weather"]
    got = {}
    for tr in sp.select("tr.HorseList"):
        uma = tr.select_one("td[class^=Umaban]"); bwt = tr.select_one("td.Weight")
        if not (uma and bwt): continue
        bw = parse_bw(bwt.get_text())
        if bw: got[to_int(uma.get_text())] = bw
    for e in race.get("entries") or []:
        if e["num"] in got: e.update(got[e["num"]])
    return len(got)

def shutuba(f, race):
    html = f.get(f"{BASE_RACE}/race/shutuba.html?race_id={race['id']}", ttl_hours=6, encoding="EUC-JP")
    sp = soup(html)
    nm = sp.select_one(".RaceName")
    if nm:
        name = clean(nm.get_text())
        gi = nm.select_one("[class*=Icon_GradeType]")
        gm = re.search(r"Icon_GradeType(\d+)", " ".join(gi.get("class", []))) if gi else None
        grade = {"1": "GI", "2": "GII", "3": "GIII", "15": "L", "5": "OP"}.get(gm.group(1)) if gm else None
        rd2 = sp.select_one(".RaceData02"); cls_txt = clean(rd2.get_text(" ")) if rd2 else ""
        if not grade:
            for k in ("新馬", "未勝利", "1勝クラス", "2勝クラス", "3勝クラス", "オープン"):
                if k in cls_txt: grade = "OP" if k == "オープン" else k; break
        if grade and grade not in name: name = f"{name}({grade})"
        race["name"] = name
    rd = sp.select_one(".RaceData01")
    if rd: race.update({k: v for k, v in parse_racedata(clean(rd.get_text())).items() if v})
    ents = []
    for tr in sp.select("tr.HorseList"):
        if "Cancel" in (tr.get("class") or []): continue          # 出走取消・除外
        tds = tr.find_all("td")
        a = tr.select_one(".HorseName a")
        if not a: continue
        hid = re.search(r"horse/(\w+)", a.get("href", ""))
        jk = tr.select_one("td.Jockey"); trn = tr.select_one("td.Trainer")
        waku = tr.select_one("td[class^=Waku]"); uma = tr.select_one("td[class^=Umaban]")
        barei = tr.select_one("td.Barei")
        weight = None
        if barei and barei.find_next_sibling("td"): weight = to_float(barei.find_next_sibling("td").get_text())
        bwt = tr.select_one("td.Weight"); bw = parse_bw(bwt.get_text()) if bwt else None
        ents.append({
            "num": to_int(uma.get_text()) if uma else len(ents) + 1,
            "waku": to_int(waku.get_text()) if waku else None,
            "horseId": hid.group(1) if hid else clean(a.get_text()),
            "name": clean(a.get_text()),
            "sexAge": clean(barei.get_text()) if barei else "",
            "weight": weight or 57.0,
            "jockey": clean(jk.get_text()) if jk else "",
            "trainer": clean(trn.get_text()).replace(" ", "・", 1) if trn else "",
            **(bw or {}),
        })
    race["entries"] = ents; race["fieldSize"] = len(ents)
    return race

def _decode_odds_payload(txt):
    """netkeiba のオッズAPIの応答を dict に（通常JSON・JSONP・圧縮文字列のいずれにも対応）"""
    import base64, zlib
    t = (txt or "").strip()
    m = re.match(r"^[\w$.]+\((.*)\)\s*;?$", t, re.S)
    if m: t = m.group(1)
    j = json.loads(t)
    data = j.get("data") if isinstance(j, dict) else None
    if isinstance(data, str) and data.strip():
        try:
            data = json.loads(data)
        except ValueError:
            raw = base64.b64decode(data + "=" * (-len(data) % 4))
            for w in (zlib.MAX_WBITS, -zlib.MAX_WBITS, 16 + zlib.MAX_WBITS):
                try: data = json.loads(zlib.decompress(raw, w).decode("utf-8")); break
                except Exception: continue
    if not isinstance(data, dict):
        raise ValueError("想定外の応答: " + t[:160].replace("\n", " "))
    return data

def _odds_netkeiba(f, race, ttl_hours):
    url = (f"{BASE_RACE}/api/api_get_jra_odds.html?pid=api_get_jra_odds&input=UTF-8&output=json"
           f"&race_id={race['id']}&type=1&action=update&sort=odds&compress=0")
    data = _decode_odds_payload(f.get(url, ttl_hours=ttl_hours))
    od = (data.get("odds") or {})
    win, plc = od.get("1") or {}, od.get("2") or {}
    out = {}
    for e in race["entries"]:
        k = f"{e['num']:02d}"
        v = win.get(k) or win.get(str(e["num"])); p = plc.get(k) or plc.get(str(e["num"]))
        o = to_float(v[0]) if v else None
        if o and o > 1:
            out[e["num"]] = {"odds": o, "pop": to_int(v[2]) if len(v) > 2 else None,
                             "placeLo": to_float(p[0]) if p else None, "placeHi": to_float(p[1]) if p and len(p) > 1 else None}
    asof = data.get("official_datetime") or data.get("update_datetime")
    return out, asof

def _odds_yahoo(f, race, ttl_hours):
    """予備：スポーツナビ（Yahoo!競馬）の単勝・複勝オッズ表"""
    html = f.get(f"https://sports.yahoo.co.jp/keiba/race/odds/tfw/{race['id'][2:]}", ttl_hours=ttl_hours)
    sp = soup(html); out = {}
    nums = {e["num"] for e in race["entries"]}
    for tr in sp.select("tr"):
        cells = [clean(td.get_text(" ")) for td in tr.find_all(["td", "th"])]
        if len(cells) < 4: continue
        ints, k = [], 0
        while k < len(cells) and re.fullmatch(r"\d{1,2}", cells[k]): ints.append(int(cells[k])); k += 1
        if not ints or ints[-1] not in nums: continue
        rest = cells[k:]
        w = next((to_float(c) for c in rest if re.fullmatch(r"\d+(?:\.\d)?", c)), None)
        rg = next((re.findall(r"\d+(?:\.\d)?", c) for c in rest if re.fullmatch(r"\d+(?:\.\d)?\s*[-－~～]\s*\d+(?:\.\d)?", c)), None)
        if w and w > 1:
            out[ints[-1]] = {"odds": w, "pop": None, "placeLo": float(rg[0]) if rg else None, "placeHi": float(rg[1]) if rg else None}
    if out:
        for i, (n, x) in enumerate(sorted(out.items(), key=lambda kv: kv[1]["odds"])): x["pop"] = i + 1
    return out, None

COMBO_TYPES = {"4": ("馬連", 2), "5": ("ワイド", 2), "6": ("馬単", 2), "7": ("三連複", 3)}   # 3連単は約5000通りでデータが大きすぎるため対象外
def combo_odds(f, race, ttl_hours=0.5):
    """馬連・ワイド・3連複の実オッズ（期待値を推定配当でなく実際の配当で計算するため）。戻り値: 取れた券種数"""
    out = {}
    for t, (label, k) in COMBO_TYPES.items():
        try:
            url = (f"{BASE_RACE}/api/api_get_jra_odds.html?pid=api_get_jra_odds&input=UTF-8&output=json"
                   f"&race_id={race['id']}&type={t}&action=update&sort=odds&compress=0")
            data = _decode_odds_payload(f.get(url, ttl_hours=ttl_hours))
            od = (data.get("odds") or {}).get(t) or {}
            m = {}
            for key, v in od.items():
                if not re.fullmatch(r"\d{%d}" % (2 * k), key) or not v: continue
                nums = [int(key[i:i + 2]) for i in range(0, 2 * k, 2)]
                lo = to_float(v[0])
                if not lo or lo <= 1: continue
                hi = to_float(v[1]) if len(v) > 1 and v[1] else None
                m["-".join(map(str, nums if label == "馬単" else sorted(nums)))] = [lo, hi] if label == "ワイド" else lo
            if m: out[label] = m
        except Exception as ex:
            print(f"  {label}オッズ取得スキップ ({race['id']}): {ex}")
    if out:
        race["comboOdds"] = out
        race["comboAsOf"] = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    return len(out)

def odds(f, race, ttl_hours=0.5):
    """単勝・複勝オッズと人気。取得のたびに履歴（oddsHist）を残し、人気の変動を追えるようにする。
    戻り値: (取得できた頭数, 取得元, エラー内容)"""
    ents = race.get("entries") or []
    if not ents: return 0, None, "出馬表なし"
    got, src, errs = {}, None, []
    for name, fn in (("netkeiba", _odds_netkeiba), ("Yahoo!競馬", _odds_yahoo)):
        try:
            got, asof = fn(f, race, ttl_hours)
        except Exception as ex:
            errs.append(f"{name}: {ex}"); got = {}
            continue
        if len(got) >= max(2, len(ents) // 2):
            src = name; break
        errs.append(f"{name}: {len(got)}/{len(ents)}頭分しか読めず")
    if not src:
        return 0, None, " / ".join(errs) or "オッズなし（発売前）"
    stamp = asof or dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    for e in ents:
        x = got.get(e["num"])
        if not x: continue
        e.update({k: v for k, v in x.items() if v is not None})
        hist = e.get("oddsHist") or []
        if not hist or hist[-1].get("t") != stamp:
            hist.append({"t": stamp, "o": x["odds"], "p": x.get("pop")})
        e["oddsHist"] = hist[-12:]
    race["oddsAsOf"] = stamp; race["oddsSrc"] = src
    return len(got), src, None

PAY_LABELS = {"単勝": ("単勝", 1), "複勝": ("複勝", 1), "枠連": ("枠連", 2), "馬連": ("馬連", 2), "ワイド": ("ワイド", 2),
              "馬単": ("馬単", 2), "3連複": ("三連複", 3), "三連複": ("三連複", 3), "3連単": ("三連単", 3), "三連単": ("三連単", 3)}

def _parse_payouts(sp):
    """払戻表（単勝・複勝・馬連・ワイド・3連複…）を {券種: {"2-6": 払戻(100円あたり)}} に"""
    pay = {}
    for tr in sp.select("tr"):
        th = tr.find("th")
        if not th: continue
        label = clean(th.get_text()).replace(" ", "")
        if label not in PAY_LABELS: continue
        name, k = PAY_LABELS[label]
        tds = tr.find_all("td")
        if len(tds) < 2: continue
        nums = [int(x) for x in re.findall(r"\d+", tds[0].get_text(" "))]
        pays = [int(x.replace(",", "")) for x in re.findall(r"([\d,]+)\s*円", tds[1].get_text(" "))]
        if not pays:
            pays = [int(x.replace(",", "")) for x in re.findall(r"[\d,]{3,}", tds[1].get_text(" "))]
        if not pays or not nums: continue
        size = len(nums) // len(pays) if len(nums) % len(pays) == 0 else k
        out = pay.setdefault(name, {})
        for i, amt in enumerate(pays):
            combo = nums[i * size:(i + 1) * size]
            if len(combo) != k: continue
            key = "-".join(map(str, combo if name in ("馬単", "三連単") else sorted(combo)))
            out[key] = amt
    return pay

RES_HEAD = {"着順": "pos", "馬番": "num", "タイム": "time", "着差": "margin", "人気": "pop", "単勝オッズ": "odds", "単勝": "odds",
            "後3F": "l3f", "上り": "l3f", "コーナー通過順": "pass", "通過": "pass", "馬体重(増減)": "bw", "馬体重": "bw"}
def _parse_rows(sp):
    """着順表の全行：着順・馬番・タイム・着差・人気・確定単勝オッズ・上がり3F・通過順"""
    for tbl in sp.select("table"):
        heads = [clean(th.get_text()).replace(" ", "") for th in tbl.select("tr th")]
        if "着順" not in heads or "馬番" not in heads: continue
        idx = {RES_HEAD[h]: i for i, h in enumerate(heads) if h in RES_HEAD}
        rows = []
        for tr in tbl.select("tr"):
            td = tr.find_all("td")
            if len(td) <= max(idx["pos"], idx["num"]): continue
            g = lambda k: clean(td[idx[k]].get_text()) if k in idx and idx[k] < len(td) else ""
            pos, num = g("pos"), g("num")
            if not num.isdigit(): continue
            rows.append({"pos": int(pos) if pos.isdigit() else pos, "num": int(num), "time": g("time") or None, "margin": g("margin") or None,
                         "pop": to_int(g("pop")), "odds": to_float(g("odds")), "l3f": to_float(g("l3f")), "pass": g("pass") or None, "bw": g("bw") or None})
        if rows: return rows
    return []

def _parse_order(sp):
    """着順表から [(着順, 馬番), ...]"""
    return sorted((r["pos"], r["num"]) for r in _parse_rows(sp) if isinstance(r["pos"], int))

def _parse_corners(sp):
    """コーナー通過順の表 → [[1角の馬番順], [2角], ...]（同じ位置の馬は並び順のまま）"""
    out = []
    for tr in sp.select("table.Corner_Num tr, table.result_table_02 tr"):
        th = tr.find("th"); td = tr.find("td")
        if th and td and "コーナー" in th.get_text():
            nums = [int(x) for x in re.findall(r"\d+", td.get_text(" "))]
            if nums: out.append(nums)
    return out

def race_result(f, race):
    """レース結果（着順と払戻）。race["result"] = {"order": [1着馬番, 2着, ...], "pay": {...}}"""
    for url, enc in ((f"{BASE_RACE}/race/result.html?race_id={race['id']}", "EUC-JP"), (f"{BASE_DB}/race/{race['id']}/", "EUC-JP")):
        try:
            sp = soup(f.get(url, ttl_hours=1, encoding=enc))
        except Exception:
            continue
        rows = _parse_rows(sp); pay = _parse_payouts(sp)
        order = sorted((r["pos"], r["num"]) for r in rows if isinstance(r["pos"], int))
        if order and pay.get("単勝"):
            rd = sp.select_one(".RaceData01") or sp.select_one(".data_intro")
            gm = re.search(r"(?:馬場|芝|ダート)\s*:\s*(良|稍|重|不)", clean(rd.get_text(" ")) if rd else "")
            race["result"] = {"order": [u for _, u in order], "rows": rows, "corners": _parse_corners(sp), "pay": pay,
                              "going": gm.group(1) if gm else None, "at": dt.datetime.now().strftime("%Y-%m-%d %H:%M")}
            return True
    return False

def training(f, race):
    try:
        html = f.get(f"{BASE_RACE}/race/oikiri.html?race_id={race['id']}", ttl_hours=12, encoding="EUC-JP")
    except Exception as ex:
        print(f"  調教取得スキップ: {ex}"); return
    sp = soup(html)
    for tr in sp.select("tr.HorseList"):
        uma = tr.select_one("td[class^=Umaban]")
        if not uma: continue
        num = to_int(uma.get_text())
        rank = tr.select_one("td[class*=Rank]"); crit = tr.select_one("td.Training_Critic")
        g = clean(rank.get_text()) if rank else ""
        for e in race["entries"]:
            if e["num"] == num:
                e["training"] = {"grade": g or None, "comment": clean(crit.get_text()) if crit else "",
                                 "score": TRAIN_SCORE.get(g[:1], 50)}

# ---------- 競走馬 ----------
HEAD_MAP = {"日付":"date","開催":"kaisai","レース名":"race","頭数":"field","馬番":"gate","オッズ":"odds","人気":"pop",
            "着順":"pos","騎手":"jockey","斤量":"wt","距離":"cond","馬場":"going","タイム":"time","着差":"margin",
            "通過":"passing","ペース":"pace","上り":"last3f","馬体重":"bw"}

def parse_results_table(tbl):
    heads = [clean(th.get_text()) for th in tbl.select("thead th, tr th")]
    idx = {HEAD_MAP[h]: i for i, h in enumerate(heads) if h in HEAD_MAP}
    runs = []
    for tr in tbl.select("tbody tr"):
        td = [clean(x.get_text()) for x in tr.find_all("td")]
        if len(td) < len(idx): continue
        g = lambda k: td[idx[k]] if k in idx and idx[k] < len(td) else ""
        cond = g("cond"); m = re.match(r"(芝|ダ|障)(\d+)", cond)
        if not m: continue
        kaisai = re.sub(r"\d", "", g("kaisai")) or g("kaisai")
        d = g("date").replace("/", "-")
        a = tr.find("a", href=re.compile(r"/race/\d{12}"))
        runs.append({
            "date": d, "venue": kaisai, "race": g("race"),
            "raceId": re.search(r"\d{12}", a["href"]).group() if a else None,
            "surface": m.group(1), "dist": int(m.group(2)), "going": (g("going") or "-")[:1],
            "field": to_int(g("field")), "gate": to_int(g("gate")), "odds": to_float(g("odds")), "popularity": to_int(g("pop")),
            "pos": to_int(g("pos")), "jockey": g("jockey"), "weight": to_float(g("wt")),
            "time": g("time") or "-", "margin": g("margin"), "passing": g("passing"),
            "pace": g("pace"), "last3f": to_float(g("last3f")), "bodyWeight": g("bw"),
        })
    return [r for r in runs if r["pos"] and r["field"]]

def horse_history(f, hid):
    for url in (f"{BASE_DB}/horse/result/{hid}/", f"{BASE_DB}/horse/{hid}/"):
        try:
            sp = soup(f.get(url, ttl_hours=72, encoding="EUC-JP"))
        except Exception:
            continue
        tbl = sp.select_one("table.db_h_race_results")
        if tbl: return parse_results_table(tbl)
    # 新レイアウト（成績がAJAXで読み込まれる場合）
    try:
        txt = f.get(f"{BASE_DB}/horse/ajax_horse_results.html?input=UTF-8&id={hid}", ttl_hours=72)
        try: html = json.loads(txt).get("data", "")
        except ValueError: html = txt
        tbl = soup(html).select_one("table")
        if tbl: return parse_results_table(tbl)
    except Exception:
        pass
    return []

def horse_pedigree(f, hid):
    try:
        sp = soup(f.get(f"{BASE_DB}/horse/ped/{hid}/", ttl_hours=24 * 30, encoding="EUC-JP"))
    except Exception:
        return {}
    tbl = sp.select_one("table.blood_table")
    if not tbl: return {}
    big = tbl.select("td[rowspan='16']")
    out = {}
    if len(big) >= 2:
        out["sire"] = clean(big[0].get_text()).split(" ")[0]
        out["dam"] = clean(big[1].get_text()).split(" ")[0]
        nxt = big[1].find_next_sibling("td")
        if nxt: out["damsire"] = clean(nxt.get_text()).split(" ")[0]
    return out

def shutuba_past_runs(f, race):
    """全成績が取れない時の予備: 馬柱（直近5走）"""
    html = f.get(f"{BASE_RACE}/race/shutuba_past.html?race_id={race['id']}", ttl_hours=6, encoding="EUC-JP")
    sp = soup(html); res = {}
    for tr in sp.select("tr.HorseList"):
        a = tr.select_one(".Horse02 a, .HorseName a")
        if not a: continue
        hid = re.search(r"horse/(\w+)", a.get("href", ""))
        runs = []
        for td in tr.select("td.Past"):
            t = clean(td.get_text(" "))
            m_date = re.search(r"(\d{4})\.(\d{2})\.(\d{2})\s*(\S+?)\s", t)
            m_cond = re.search(r"(芝|ダ|障)(\d{3,4})", t)
            m_pos = td.select_one(".Num")
            m_field = re.search(r"(\d+)頭", t)
            if not (m_date and m_cond and m_pos and m_field): continue
            pas = re.search(r"(\d+(?:-\d+)+)", t)
            l3 = re.search(r"\((\d{2}\.\d)\)", t)
            nm = td.select_one(".Data02 a, .Data02")
            runs.append({"date": f"{m_date.group(1)}-{m_date.group(2)}-{m_date.group(3)}", "venue": re.sub(r"\d", "", m_date.group(4)),
                         "race": clean(nm.get_text()) if nm else "", "surface": m_cond.group(1), "dist": int(m_cond.group(2)),
                         "going": (re.search(r"(良|稍|重|不)", t) or [None, "-"])[1] if re.search(r"(良|稍|重|不)", t) else "-",
                         "pos": to_int(m_pos.get_text()), "field": int(m_field.group(1)), "time": "-",
                         "passing": pas.group(1) if pas else "", "last3f": float(l3.group(1)) if l3 else None})
        if hid: res[hid.group(1)] = runs
    return res

# ---------- 保存 ----------
def save_db(con, races, horses):
    now = dt.datetime.now().isoformat(timespec="seconds")
    for r in races:
        con.execute("""INSERT OR REPLACE INTO races VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (r["id"], r["date"], r["venue"], r["no"], r.get("name"), r.get("surface"), r.get("distance"), r.get("direction"),
             r.get("going"), r.get("weather"), r.get("postTime"), r.get("fieldSize"), now))
        for e in r.get("entries") or []:
            con.execute("INSERT OR REPLACE INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (r["id"], e["num"], e.get("waku"), e["horseId"], e["name"], e.get("sexAge"), e.get("weight"), e.get("jockey"),
                 e.get("trainer"), e.get("odds"), e.get("pop")))
            t = e.get("training")
            if t: con.execute("INSERT OR REPLACE INTO training VALUES (?,?,?,?,?,?)", (r["id"], e["num"], e["horseId"], t.get("grade"), t.get("comment"), t.get("score")))
    for hid, h in horses.items():
        con.execute("INSERT OR REPLACE INTO horses VALUES (?,?,?,?,?,?,?,?,?)",
            (hid, h["name"], h.get("sex"), h.get("birthYear"), h.get("sire"), h.get("dam"), h.get("damsire"), h.get("trainer"), now))
        for x in h.get("runs", []):
            con.execute("INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (hid, x["date"], x.get("venue"), x.get("race"), x.get("raceId"), x["surface"], x["dist"], x.get("going"), x["field"],
                 x.get("gate"), x.get("odds"), x.get("popularity"), x["pos"], x.get("jockey"), x.get("weight"), x.get("time"),
                 x.get("margin"), x.get("passing"), x.get("pace"), x.get("last3f"), x.get("bodyWeight")))
    con.commit()

def main():
    ap = argparse.ArgumentParser(description="netkeiba から日曜JRAの出馬表・競走馬データを収集")
    ap.add_argument("--sundays", type=int, default=1, help="今後何週分の日曜を取るか（既定1）")
    ap.add_argument("--date", action="append", help="YYYYMMDD 指定日（複数可）")
    ap.add_argument("--db", default=str(HERE / "keiba.db"))
    ap.add_argument("--out", default=str(HERE / "keiba_export.json"))
    ap.add_argument("--no-history", action="store_true", help="全成績を取らず馬柱(直近5走)のみ")
    ap.add_argument("--delay", type=float, default=1.5)
    ap.add_argument("--refresh", action="store_true", help="キャッシュを無視して再取得")
    a = ap.parse_args()

    f = Fetcher(delay=a.delay, refresh=a.refresh)
    dates = [dt.datetime.strptime(d, "%Y%m%d").date() for d in a.date] if a.date else upcoming_sundays(a.sundays)
    con = sqlite3.connect(a.db); con.executescript((HERE / "schema.sql").read_text(encoding="utf-8"))

    all_races, horses = [], {}
    for d in dates:
        rl = race_list(f, d)
        print(f"{d}: {len(rl)} レース")
        if not rl: print("  番組が未発表です（出馬表は通常 木〜金曜に確定）"); continue
        for r in rl:
            try:
                shutuba(f, r); odds(f, r); training(f, r)
            except Exception as ex:
                print(f"  {r['id']} 出馬表取得失敗: {ex}"); continue
            print(f"  {r['venue']}{r['no']:>2}R {r['name']} {r.get('surface','')}{r.get('distance','')} {len(r['entries'])}頭")
            past = None
            for e in r["entries"]:
                hid = e["horseId"]
                if hid in horses: continue
                h = {"name": e["name"], "sex": e["sexAge"][:1], "trainer": e.get("trainer")}
                if not a.no_history:
                    h["runs"] = horse_history(f, hid); h.update(horse_pedigree(f, hid))
                if not h.get("runs"):
                    if past is None: past = shutuba_past_runs(f, r)
                    h["runs"] = past.get(hid, [])
                horses[hid] = h
            all_races.append(r)
        save_db(con, [r for r in all_races if r["date"] == d.isoformat()], horses)

    # アプリ用JSON
    out = {"version": 1, "source": "netkeiba（収集スクリプト）", "generated": dt.date.today().isoformat(),
           "races": [{k: v for k, v in r.items() if k not in ("condText",)} for r in all_races],
           "horses": {hid: {**h, "id": hid} for hid, h in horses.items()}}
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"\n保存: {a.db}（レース {len(all_races)} / 馬 {len(horses)}）")
    print(f"アプリ用JSON: {a.out} → シミュレーターの「データ取込」で読み込んでください")

if __name__ == "__main__":
    main()
