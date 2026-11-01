"""
東スポ競馬の記事から、重賞の出走馬ごとの「陣営（調教師・騎手）のコメント」を集める（2026-10-31）
--------------------------------------------------------------------------
・過去分：PCに取り込み済みの開催（data/past/day_*.json）の重賞（G1〜G3）について、出走馬ごとに東スポ競馬の「馬のニュース」一覧を見て、
  そのレースの名前が付いた発走前（前日まで・10日以内）の記事を読み、「」の中のコメントを保存する
・これからのレース：今日・明日の重賞（data/ の snapshot）も同じように集める（前日の夕方と当日の朝）
・サイトに負担をかけないよう、同時に1つずつ・取得の開始は2秒以上あける。断られたら（400/403/429）30分休んでやり直す。ページはディスクに保存しない
・保存先：data/tospo/race_<レースID>.json（{"馬ID": [{"id", "date", "title", "quotes", "score"}]}）、進み具合は data/tospo/progress.json
・コメントの「良い／普通／悪い」は言葉で判定（score：良い言葉の数−悪い言葉の数）。効くかどうかは、集まったあとに過去の成績で確かめる
"""
import datetime as dt, json, re, threading, time, unicodedata, traceback
from pathlib import Path

import keiba_collector as kc

BASE = "https://tospo-keiba.jp"
DIR = None; PAST = None
LOCK = threading.Lock()
ST = {"running": False, "stop": False, "cur": None, "log": [], "requests": 0, "done": 0, "total": 0, "startedAt": None}

GOOD = ["自信", "上積み", "仕上が", "仕上げ", "状態は(?:いい|良い|上々|最高|変わりな)", "状態が(?:いい|良い|上が)", "良くなって", "上向", "文句な", "申し分", "楽しみ", "期待",
        "勝ち負け", "力は上", "動きが(?:いい|良|抜群)", "動きは(?:いい|良)", "絶好", "万全", "前走以上", "一段階", "良化", "順調", "力を出せる", "具合は(?:いい|良)", "雰囲気(?:が|は)(?:いい|良)",
        "手応え", "素晴らしい", "充実", "成長", "パワーアップ", "引けを取らない", "チャンス", "好調", "いい状態", "良い状態", "息遣いも(?:いい|良)", "反応も(?:いい|良)"]
BAD = ["不安", "心配", "課題", "物足りな", "まだ(?:本調子|良くな|これから|完調)", "太め", "重め", "叩き台", "叩いて(?:から|良くなる)", "気になる", "難しい", "微妙", "厳しい", "半信半疑",
       "様子見", "万全ではな", "戻り切", "本来の", "もう一つ", "もうひとつ", "いまひとつ", "今ひとつ", "いま一つ", "今一つ", "どうか", "未知数", "苦しい", "ジリ", "久々", "テンションが高", "イレ込"]


def init(data_dir):
    global DIR, PAST
    DIR = Path(data_dir) / "tospo"; DIR.mkdir(parents=True, exist_ok=True); PAST = Path(data_dir) / "past"


def _log(msg):
    line = f"{dt.datetime.now().strftime('%m-%d %H:%M:%S')} {msg}"
    print("[東スポ] " + line, flush=True)
    with LOCK: ST["log"] = (ST["log"] + [line])[-60:]


def _prog():
    p = DIR / "progress.json"
    if p.exists():
        try: return json.loads(p.read_text(encoding="utf-8"))
        except Exception: pass
    return {"done": {}, "horse": {}}
def _save_prog(pr): (DIR / "progress.json").write_text(json.dumps(pr, ensure_ascii=False), encoding="utf-8")


def norm(s):
    s = unicodedata.normalize("NFKC", s or "")
    s = re.sub(r"\((?:G|J・G)?[123IⅠⅡⅢ]+\)|\(L\)|\(OP\)|GI{1,3}|G[123]|Ｇ.", "", s)
    return re.sub(r"[\s・()（）「」『』　]", "", s)


def race_key(name):
    """記事の見出しの【】と照らし合わせる短い名前（例：天皇賞(秋)(GI) → 天皇賞秋、日本ダービー(GI) → 日本ダービー）"""
    k = norm(name)
    k = re.sub(r"(ステークス)$", "S", k)
    return k


def _grade(name):
    n = name or ""
    if re.search(r"G1|GⅠ|\(GI\)", n): return 7
    if re.search(r"G2|GⅡ|\(GII\)", n): return 6
    if re.search(r"G3|GⅢ|\(GIII\)", n): return 5
    return 0


def score(quotes):
    t = " ".join(quotes)
    g = sum(len(re.findall(w, t)) for w in GOOD); b = sum(len(re.findall(w, t)) for w in BAD)
    return g - b, g, b


class _F(kc.Fetcher):
    def __init__(self):
        super().__init__(delay=2.0, cache=False); self._t0 = 0.0
    def get(self, url, ttl_hours=None, encoding=None):
        for k in range(4):
            if ST["stop"]: raise RuntimeError("中止しました")
            w = 2.0 - (time.time() - self._t0)
            if w > 0: time.sleep(w)
            self._t0 = time.time(); self.last = 0.0
            with LOCK: ST["requests"] += 1
            try:
                return kc.Fetcher.get(self, url, ttl_hours=ttl_hours, encoding=encoding)
            except Exception as ex:
                code = getattr(getattr(ex, "response", None), "status_code", None)
                if code == 404: return ""
                if code in (400, 403, 429):
                    _log(f"サイトに断られました（{code}）。30分休んでやり直します");
                    for _ in range(180):
                        if ST["stop"]: raise
                        time.sleep(10)
                    continue
                time.sleep([5, 20, 60, 0][k])
        return ""


_HC = {}   # 馬ごとのニュース一覧の取得済み分（同じ馬が何度も重賞に出るので、取り直さない）
def horse_articles(f, hid, stop_id=None, pages=80):
    """馬のニュース一覧（記事ID・見出し）。新しい順。stop_id より古い記事が出てくるページまでさかのぼる
    （11/1：3ページで止めていたため、その後も活躍した有名な馬ほど昔のレース前の記事が取れていなかった＝偏りの原因）"""
    c = _HC.setdefault(hid, {"items": [], "next": 1, "min": 10 ** 9, "end": False})
    while not c["end"] and c["next"] <= pages and ((c["next"] <= 2) if stop_id is None else (c["min"] >= stop_id)):
        p = c["next"]
        html = f.get(f"{BASE}/horse/{hid}/news" + (f"?page={p}" if p > 1 else ""))
        c["next"] += 1
        if not html: c["end"] = True; break
        got = re.findall(r'href="(?:https://tospo-keiba\.jp)?/article/(\d+)"[^>]*>([\s\S]{0,400}?)</a>', html)
        items = []
        for aid, inner in got:
            t = re.sub(r"<[^>]+>", " ", inner); t = re.sub(r"\s+", " ", t).strip()
            if t: items.append((int(aid), t))
        if not items: c["end"] = True; break
        seen = {a for a, _ in c["items"]}
        c["items"] += [x for x in items if x[0] not in seen]
        c["min"] = min(c["min"], min(a for a, _ in items))
        if len(items) < 15: c["end"] = True
    return c["items"]


def article(f, aid):
    """記事1本：日付（postedAtDate）と、本文（ページ内データの content）の「」の中のコメント"""
    html = f.get(f"{BASE}/article/{aid}")     # 記事の種類（速報・追い切りなど）ごとのページへ自動で移る
    if not html: return None
    m = re.search(r'"postedAtDate"\s*:\s*"(20\d\d)\\?/(\d{2})\\?/(\d{2})"', html) or re.search(r"(20\d\d)[-/](\d{2})[-/](\d{2})", html)
    date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None
    body = ""
    k = html.find('"postedAtDate"')
    mc = re.search(r'"content"\s*:\s*"((?:\\.|[^"\\])*)"', html[k:] if k >= 0 else html)
    if mc:
        try: body = json.loads('"' + mc.group(1) + '"')
        except Exception: body = ""
    body = re.sub(r"<[^>]+>", " ", body); body = re.sub(r"&nbsp;|&quot;|&amp;", " ", body); body = re.sub(r"\s+", " ", body)
    qs = []; ctx = []
    for mq in re.finditer(r"「([^「」]{4,300})」", body):
        q = mq.group(1).strip()
        if q in qs: continue
        qs.append(q); ctx.append(body[max(0, mq.start() - 160):mq.start()])
    tm = re.search(r"<title>([\s\S]*?)</title>", html); title = re.sub(r"\s*\|.*$", "", tm.group(1)).strip() if tm else ""
    return {"id": aid, "date": date, "title": title, "quotes": qs[:30], "ctx": ctx[:30], "len": len(body)}


_ANCH = None
def stop_id_for(date_iso):
    """その日付ごろの記事IDの目安（これより古い記事までさかのぼれば十分）。集めた記事のIDと日付の対応から求める"""
    global _ANCH
    if _ANCH is None:
        pts = {}
        for p in DIR.glob("race_*.json"):
            try:
                for arts in json.loads(p.read_text(encoding="utf-8")).get("horses", {}).values():
                    for a in arts:
                        if a.get("id") and a.get("date"): pts[a["date"]] = max(pts.get(a["date"], 0), int(a["id"]))
            except Exception: pass
        base = {"2021-10-01": 3000, "2021-11-28": 6000, "2022-02-22": 10000, "2022-05-26": 14493, "2022-10-19": 21781}
        for k, v in base.items(): pts.setdefault(k, v)
        _ANCH = sorted(pts.items())
    ds = [d for d, _ in _ANCH]; ids = [i for _, i in _ANCH]
    import bisect
    k = bisect.bisect_left(ds, date_iso)
    if k == 0: return 0
    v = ids[k - 1] if k <= len(ids) else ids[-1]
    return max(0, int(v) - 600)      # 余裕を持って少し古めまで

def collect_race(f, race, pr):
    """1レース分：出走馬ごとに、そのレースの名前が付いた発走前の記事のコメントを集める"""
    key = race_key(race.get("name")); rd = race["date"]
    d0 = (dt.date.fromisoformat(rd) - dt.timedelta(days=10)).isoformat()
    out = {}
    for e in race.get("entries") or []:
        hid = e.get("horseId")
        if not hid: continue
        today = dt.date.today().isoformat()
        lst = horse_articles(f, hid, stop_id=None if d0 >= (dt.date.today() - dt.timedelta(days=12)).isoformat() else stop_id_for(d0))
        cand = [(a, t) for a, t in lst if key and (key in norm(t) or (len(key) >= 4 and key[:4] in norm(t)))]
        arts = []
        for aid, t in cand[:4]:
            a = article(f, aid)
            if not a or not a["date"] or not (d0 <= a["date"] < rd): continue   # 発走前（前日まで）の記事だけ
            # 何頭もまとめた記事では、その馬の名前のすぐ後ろ（160字以内で、ほかの出走馬の名前より後）にあるコメントだけを使う
            nm = unicodedata.normalize("NFKC", e.get("name") or ""); others = [unicodedata.normalize("NFKC", x.get("name") or "") for x in race.get("entries") or [] if x.get("name") and x is not e]
            keep = []
            for q, c in zip(a["quotes"], a.get("ctx") or [""] * len(a["quotes"])):
                c = unicodedata.normalize("NFKC", c)
                if nm and nm in c:
                    pos = c.rfind(nm)
                    if not any(o and c.rfind(o) > pos for o in others): keep.append(q)
            if not keep and nm and nm in unicodedata.normalize("NFKC", a["title"]) and not any(o and o in unicodedata.normalize("NFKC", a["title"]) for o in others):
                keep = a["quotes"][:8]     # 見出しがこの馬だけの記事は、本文のコメントを全部使う
            a["quotes"] = keep[:8]; a.pop("ctx", None)
            if not keep: continue
            s, g, b = score(a["quotes"]); a["score"] = s; a["good"] = g; a["bad"] = b
            arts.append(a)
        if arts: out[hid] = arts
        with LOCK: ST["cur"] = f"{rd} {race.get('venue')}{race.get('no')}R {race.get('name')} {e.get('name')}"
    (DIR / f"race_{race['id']}.json").write_text(json.dumps({"id": race["id"], "date": rd, "name": race.get("name"), "key": key, "horses": out}, ensure_ascii=False), encoding="utf-8")
    pr["done"][race["id"]] = sum(len(v) for v in out.values()); _save_prog(pr)
    return out


def graded_past(frm="2021-01-01"):
    L = []
    for fn in sorted(PAST.glob("day_*.json")):
        try: j = json.loads(fn.read_text(encoding="utf-8"))
        except Exception: continue
        if j.get("date", "") < frm: continue
        for r in j.get("races") or []:
            if r.get("surface") != "障" and _grade(r.get("name")) >= 5 and r.get("entries"): L.append(r)
    return L[::-1]      # 11/1：新しいレースから（馬ごとのニュース一覧を少しずつ深くさかのぼって使い回すため）


def _loop(races):
    pr = _prog(); f = _F()
    todo = [r for r in races if r["id"] not in pr["done"]]
    with LOCK: ST.update(total=len(races), done=len(races) - len(todo))
    _log(f"重賞 {len(races)}レース中、残り {len(todo)}レースのコメントを集めます")
    for r in todo:
        if ST["stop"]: break
        try:
            out = collect_race(f, r, pr)
            with LOCK: ST["done"] += 1
            _log(f"{r['date']} {r.get('name')}：{len(out)}頭分のコメント")
        except Exception as ex:
            if ST["stop"]: break
            _log(f"{r.get('name')} で警告: {ex}"); traceback.print_exc(); time.sleep(10)
    with LOCK: ST["running"] = False
    _log("コメント集めを終えました" if not ST["stop"] else "コメント集めを止めました")


def start(frm="2021-01-01", races=None):
    with LOCK:
        if ST["running"]: return False
        ST.update(running=True, stop=False, startedAt=dt.datetime.now().isoformat(timespec="seconds"))
    def go():
        try: _loop(races if races is not None else graded_past(frm))
        except Exception as ex:
            _log(f"止まりました: {ex}")
            with LOCK: ST["running"] = False
    threading.Thread(target=go, daemon=True).start(); return True


def stop():
    with LOCK: ST["stop"] = True


def status():
    with LOCK: s = dict(ST)
    s["races"] = len(list(DIR.glob("race_*.json"))) if DIR else 0
    return s


def for_race(rid):
    p = DIR / f"race_{rid}.json" if DIR else None
    if p and p.exists():
        try: return json.loads(p.read_text(encoding="utf-8"))
        except Exception: return None
    return None
