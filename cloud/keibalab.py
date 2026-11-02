"""
競馬ラボ（keibalab.jp）のニュース記事から、騎手・調教師のコメントを集める（2026-11-03）
--------------------------------------------------------------------------
・重賞の結果記事「【レース名】…」には、1着〜数着の馬の騎手の「レース後のコメント」が並ぶ（例：「2着 アンパドゥ(岩田望来騎手)」の後に「…」）。
  これは次のレースの前に読める情報（前走の騎手の感想）なので、次走の予想に使えるかを確かめる
・レース前の記事（【今週の○○厩舎】・騎手の談話など）も、本文の「」と話し手（騎手・調教師など）を保存する
・記事番号を新しい順にさかのぼる（2019年1月ごろ＝37400まで）。同時に1つずつ・2秒以上あける。ページはディスクに保存しない
・保存先：data/keibalab/topics_<千番台>.json（{記事番号: {date, title, results:[{pos, horse, who, name, text}], quotes:[{who, text}]}}）
"""
import datetime as dt, json, re, threading, time, traceback, unicodedata
from pathlib import Path

import keiba_collector as kc

BASE = "https://keibalab.jp"
DIR = None
LOCK = threading.Lock()
ST = {"running": False, "stop": False, "cur": None, "log": [], "requests": 0, "done": 0, "total": 0, "startedAt": None, "minId": None, "maxId": None}
LOW_ID = 37400


def init(data_dir):
    global DIR
    DIR = Path(data_dir) / "keibalab"; DIR.mkdir(parents=True, exist_ok=True)


def _log(msg):
    line = f"{dt.datetime.now().strftime('%m-%d %H:%M:%S')} {msg}"
    print("[競馬ラボ] " + line, flush=True)
    with LOCK: ST["log"] = (ST["log"] + [line])[-60:]


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
                    _log(f"サイトに断られました（{code}）。30分休んでやり直します")
                    for _ in range(180):
                        if ST["stop"]: raise
                        time.sleep(10)
                    continue
                time.sleep([5, 20, 60, 0][k])
        return ""


WHO_RE = re.compile(r"(調教師|騎手|ジョッキー|助手|厩務員|師)")
def _who(ctx):
    c = (ctx or "")[-80:]; ms = list(WHO_RE.finditer(c))
    if not ms: return "不明"
    w = ms[-1].group(1); return {"師": "調教師", "ジョッキー": "騎手", "厩務員": "助手"}.get(w, w)


def _txt(h):
    h = re.sub(r"<br\s*/?>", "\n", h); h = re.sub(r"<[^>]+>", "", h)
    return unicodedata.normalize("NFKC", re.sub(r"&nbsp;|&quot;|&amp;", " ", h)).strip()


def parse(html):
    """記事1本：日付・見出し・コメント（馬ID・馬名・話し手・本文・結果記事なら着順）"""
    if not html: return None
    tm = re.search(r"<title>([\s\S]*?)</title>", html); title = unicodedata.normalize("NFKC", re.sub(r"\s*\|.*$", "", tm.group(1)).strip()) if tm else ""
    k = html.find("<!-- 本文 -->"); head = html[max(0, k - 6000):k] if k > 0 else html[:20000]
    dm = re.findall(r"(20\d\d)/(\d{1,2})/(\d{1,2})", head); dm = dm[-1] if dm else None
    date = f"{dm[0]}-{int(dm[1]):02d}-{int(dm[2]):02d}" if dm else None
    if k < 0: return {"date": date, "title": title, "items": []}
    e = html.find("</section>", k); body = html[k:e if e > 0 else k + 60000]
    items = []
    # ① 結果記事：「N着 <馬> (○○騎手)」の後の「」
    for m in re.finditer(r"(\d{1,2})着\s*<a href=\"/db/horse/(\d+)/\"[^>]*>([\s\S]*?)</a>\s*[(（]([^)）<]{1,15}?)(騎手|調教師|助手)[)）]\s*(?:<br\s*/?>\s*)*「([\s\S]*?)」", body):
        items.append({"hid": m.group(2), "horse": _txt(m.group(3)), "pos": int(m.group(1)), "who": m.group(5), "name": m.group(4).strip(), "text": _txt(m.group(6))[:800], "type": "レース後"})
    if items: return {"date": date, "title": title, "items": items}
    # ② それ以外：段落ごとに、その段落にリンクのある馬と「」を結びつける
    stable = "調教師" if re.search(r"厩舎】|厩舎|調教師", title) else None
    for para in re.split(r"</p>", body):
        hs = re.findall(r"<a href=\"/db/horse/(\d+)/\"[^>]*>([\s\S]*?)</a>", para)
        if not hs: continue
        hs = [(h, _txt(n)) for h, n in hs]; seen = set(); hs = [x for x in hs if not (x[0] in seen or seen.add(x[0]))]
        pt = _txt(para)
        for qm in re.finditer(r"「([^「」]{6,600})」", pt):
            q = qm.group(1); ctx = pt[max(0, qm.start() - 120):qm.start()]
            who = _who(ctx) if _who(ctx) != "不明" else (stable or "不明")
            tgt = [x for x in hs if x[1] and x[1] in q] or hs
            for h, n in tgt: items.append({"hid": h, "horse": n, "who": who, "text": q[:600], "type": "記事"})
            if len(items) >= 60: break
    return {"date": date, "title": title, "items": items}


def _file(aid): return DIR / f"topics_{aid // 1000}.json"
def _load(aid):
    p = _file(aid)
    if p.exists():
        try: return json.loads(p.read_text(encoding="utf-8"))
        except Exception: pass
    return {}


def _latest_id(f):
    html = f.get(f"{BASE}/topics/") or ""
    ids = [int(x) for x in re.findall(r"/topics/(\d+)/", html)]
    return max(ids) if ids else None


def _loop(low, high):
    f = _F()
    try:
        high = high or _latest_id(f) or 46700
        with LOCK: ST.update(maxId=high, minId=low, total=high - low + 1, done=0)
        _log(f"記事 {low}〜{high} を読みます（新しい順）")
        cur_k = None; book = {}
        for aid in range(high, low - 1, -1):
            if ST["stop"]: break
            k = aid // 1000
            if k != cur_k:
                if cur_k is not None: _file(cur_k * 1000).write_text(json.dumps(book, ensure_ascii=False), encoding="utf-8")
                cur_k = k; book = _load(aid)
            if str(aid) in book: 
                with LOCK: ST["done"] += 1
                continue
            try:
                a = parse(f.get(f"{BASE}/topics/{aid}/"))
                book[str(aid)] = a or {}
            except Exception as ex:
                if ST["stop"]: break
                _log(f"{aid} で警告: {ex}"); time.sleep(5); continue
            with LOCK:
                ST["done"] += 1; ST["cur"] = f"{aid} {(a or {}).get('date')} {(a or {}).get('title', '')[:30]}"
            if ST["done"] % 50 == 0: _file(aid).write_text(json.dumps(book, ensure_ascii=False), encoding="utf-8")
        if cur_k is not None: _file(cur_k * 1000).write_text(json.dumps(book, ensure_ascii=False), encoding="utf-8")
        _log("記事を読み終えました" if not ST["stop"] else "止めました")
    except Exception as ex:
        _log(f"止まりました: {ex}"); traceback.print_exc()
    finally:
        with LOCK: ST["running"] = False


def start(low=LOW_ID, high=None):
    with LOCK:
        if ST["running"]: return False
        ST.update(running=True, stop=False, startedAt=dt.datetime.now().isoformat(timespec="seconds"))
    threading.Thread(target=_loop, args=(int(low), int(high) if high else None), daemon=True).start(); return True


def stop():
    with LOCK: ST["stop"] = True


def status():
    with LOCK: s = dict(ST)
    s["files"] = len(list(DIR.glob("topics_*.json"))) if DIR else 0
    return s


def export():
    """集めた結果記事のコメントを1つにまとめる（検証用）"""
    out = {}
    for p in sorted(DIR.glob("topics_*.json")):
        try: j = json.loads(p.read_text(encoding="utf-8"))
        except Exception: continue
        for aid, a in j.items():
            if not a: continue
            if a.get("items"): out[aid] = {"date": a.get("date"), "title": a.get("title"), "items": a["items"]}
    return out
