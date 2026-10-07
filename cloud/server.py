#!/usr/bin/env python3
"""
競馬展開シミュレーター ローカルサーバー
--------------------------------------------------
PCで起動すると、ブラウザ（PC・スマホ）からシミュレーターが使えます。
・「この日の全レースを取得」ボタンで、その日のJRA全レースの出馬表・全出走馬の全成績・血統・調教・オッズを自動でDBに登録
・データはPCの data/ フォルダとSQLite（keiba.db）に保存され、PCとスマホで共有されます
・Claude を使わなくても、このフォルダだけで動きます

  python server.py                 # http://localhost:8765 を開く
  python server.py --port 8765 --no-browser
  python server.py --update 20261011   # 画面を使わず指定日の全レースを取得（タスクスケジューラ用）
  python server.py --update next       # 次の日曜日
"""
import argparse, datetime as dt, json, os, re, shutil, socket, subprocess, sqlite3, sys, threading, time, traceback, webbrowser
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import keiba_collector as kc   # noqa: E402
import backfill as bf          # noqa: E402

WEB = HERE / "web"
DATA = Path(os.environ.get("KEIBA_DATA") or (HERE / "data")); DATA.mkdir(parents=True, exist_ok=True)
bf.init(DATA)
DB_PATH = Path(os.environ.get("KEIBA_DB") or (HERE / "keiba.db"))
TWEAKS = DATA / "tweaks.json"
JOB = {"running": False, "date": None, "step": "", "done": 0, "total": 0, "log": [], "error": None, "finished_at": None, "kind": None}
LOCK = threading.Lock()

def log(msg):
    print(msg, flush=True)
    try:
        with open(DATA / "update_log.txt", "a", encoding="utf-8") as fp: fp.write(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")
    except Exception: pass
    with LOCK:
        JOB["log"] = (JOB["log"] + [f"{dt.datetime.now():%H:%M:%S} {msg}"])[-40:]

def next_sunday(today=None):
    d = today or dt.date.today()
    return d + dt.timedelta(days=(6 - d.weekday()) % 7)

def snapshot_path(ymd): return DATA / f"races_{ymd}.json"

CUSHION_FILE = DATA / "cushion.json"
def cushion_label(c):
    # JRAの区分：12以上 硬め／10〜12 やや硬め／8〜10 標準／7〜8 やや軟らかめ／7以下 軟らかめ
    return "硬め" if c >= 12 else "やや硬め" if c >= 10 else "標準" if c >= 8 else "やや軟らかめ" if c > 7 else "軟らかめ"

def fetch_cushion(f):
    """JRA馬場情報の芝クッション値（各競馬場・測定日ごと）を取得して cushion.json に蓄積する。
    当日の朝（7時ごろ）に発表される値を、その日のレースに使う。戻り値: 蓄積済みの {"obs": {"YYYY-MM-DD|競馬場": {...}}}"""
    store = json.loads(CUSHION_FILE.read_text(encoding="utf-8")) if CUSHION_FILE.exists() else {"obs": {}}
    try:
        html = f.get("https://www.jra.go.jp/keiba/baba/_data_cushion.html", ttl_hours=0.5, encoding="shift_jis")
        sp = kc.soup(html); today = dt.date.today()
        for blk in sp.select("div[id^=rc]"):
            venue = (blk.get("title") or "").strip()
            for u in blk.select("div.unit"):
                t = kc.clean(u.select_one(".time").get_text()) if u.select_one(".time") else ""
                v = kc.to_float(u.select_one(".cushion").get_text()) if u.select_one(".cushion") else None
                m = re.match(r"(\d{1,2})月(\d{1,2})日.*?(\d{1,2})時(\d{2})分", t)
                if not (venue and v and m): continue
                y = today.year - (1 if int(m.group(1)) > today.month + 1 else 0)   # 年をまたぐ表示（1月に12月の値）への対応
                d = dt.date(y, int(m.group(1)), int(m.group(2))).isoformat()
                store["obs"][f"{d}|{venue}"] = {"cushion": v, "time": f"{int(m.group(3))}:{m.group(4)}", "measured": t}
        CUSHION_FILE.write_text(json.dumps(store, ensure_ascii=False), encoding="utf-8")
    except Exception as ex:
        log(f"クッション値は取得できませんでした（平均値を使います）: {ex}")
    return store

def cushion_avg(store):
    """競馬場ごとの平均（その日の値が出ていない日のシミュレーションに使う）"""
    by = {}
    for k, o in (store.get("obs") or {}).items(): by.setdefault(k.split("|")[1], []).append(o["cushion"])
    allv = [v for vs in by.values() for v in vs]
    return {"venue": {k: round(sum(v) / len(v), 2) for k, v in by.items()}, "n": {k: len(v) for k, v in by.items()},
            "all": round(sum(allv) / len(allv), 2) if allv else None}

def fetch_track(f, ymd, venues):
    """その日に測定されたクッション値だけを track に入れる（推測の偏り値などは入れない）"""
    store = fetch_cushion(f); d = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}"; out = {}
    for v in venues:
        o = store["obs"].get(f"{d}|{v}")
        if o: out[f"{d}|{v}"] = {"cushion": o["cushion"], "cushionLabel": cushion_label(o["cushion"]), "note": f"JRA発表 {o['measured']}", "src": "JRA 馬場情報"}
    return out

def race_started(ymd, r, minutes=0):
    m = re.match(r"(\d{1,2}):(\d{2})", r.get("postTime") or "")
    if not m: return False
    t = dt.datetime(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:]), int(m.group(1)), int(m.group(2)))
    return dt.datetime.now() >= t + dt.timedelta(minutes=minutes)

def finalize_race(f, r):
    """発走後のレース：結果（着順・通過順・上がり・払戻）と確定オッズ（単複・馬連・ワイド・馬単・3連複）を取る。
    確定オッズは、発走後に予想し直したときの答え合わせ（組み合わせ馬券を含む）と学習に使う"""
    has = r.get("result") and r["result"].get("rows") and r["result"].get("pay", {}).get("三連複")
    if not has and not kc.race_result(f, r): return False
    # 結果表の馬体重（＝発走前に発表された馬体重）を出走馬に写す（発走後に予想し直すときに使う）
    bwr = {x.get("num"): kc.parse_bw(x.get("bw")) for x in r["result"].get("rows") or []}
    for e in r.get("entries") or []:
        if not e.get("bw") and bwr.get(e["num"]): e.update(bwr[e["num"]])
    if not r.get("oddsFinal"):
        try:
            n, _, _ = kc.odds(f, r, ttl_hours=0.02)
            if n: kc.combo_odds(f, r, ttl_hours=0.02); r["oddsFinal"] = True
        except Exception as ex:
            print(f"  確定オッズ取得スキップ ({r.get('id')}): {ex}")
    return True

def update_results(ymd):
    """レース結果（着順・払戻）を取得してスナップショットに追加（答え合わせ用）"""
    f = kc.Fetcher(delay=1.2)
    with LOCK:
        JOB.update(running=True, date=ymd, step="レース結果", done=0, total=0, error=None, kind="results", log=[])
    try:
        if not snapshot_path(ymd).exists(): raise RuntimeError("この日のデータがありません")
        snap = json.loads(snapshot_path(ymd).read_text(encoding="utf-8"))
        races = [r for r in snap["races"] if r.get("entries")]
        with LOCK: JOB["total"] = len(races)
        ok = 0
        for i, r in enumerate(races):
            if finalize_race(f, r): ok += 1
            with LOCK: JOB["done"] = i + 1
        if not ok: raise RuntimeError("結果をまだ取得できませんでした（確定前か、ネット接続の問題）")
        snap["updated"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        snapshot_path(ymd).write_text(json.dumps(snap, ensure_ascii=False), encoding="utf-8")
        log(f"レース結果を取得しました（{ok}/{len(races)}レース）")
        after_update(ymd)
    except Exception as ex:
        with LOCK: JOB["error"] = str(ex)
        log("エラー: " + str(ex))
    finally:
        with LOCK: JOB.update(running=False, finished_at=dt.datetime.now().astimezone().isoformat(timespec="seconds"))

def update_date(ymd, odds_only=False):
    """指定日の全レースを取得してDBとJSONに保存"""
    f = kc.Fetcher(delay=1.2)
    date = dt.date(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:]))
    with LOCK:
        JOB.update(running=True, date=ymd, step="レース一覧", done=0, total=0, error=None, kind="odds" if odds_only else "full", log=[])
    try:
        snap = json.loads(snapshot_path(ymd).read_text(encoding="utf-8")) if snapshot_path(ymd).exists() else None
        if odds_only:
            if not snap: raise RuntimeError("先に「この日の全レースを取得」を実行してください")
            races = snap["races"]
            with LOCK: JOB.update(step="オッズ更新", total=len(races))
            ok, errs = 0, []
            # 当日朝に発表されるクッション値を取り込む（発表前は平均値で計算）
            try:
                tr = fetch_track(f, ymd, sorted({r["venue"] for r in races if r.get("entries")}))
                if tr: snap.setdefault("track", {}); [snap["track"].setdefault(k, {}).update(v) for k, v in tr.items()]
            except Exception as ex: log(f"クッション値の取り込みをスキップ: {ex}")
            fin = 0
            for i, r in enumerate(races):
                if r.get("entries") and race_started(ymd, r, 15):
                    # 発走済み：結果と確定オッズを一度だけ取る（その日のあとのレースの「当日の馬場の偏り」に使う）
                    if r.get("oddsFinal") or finalize_race(f, r): fin += 1; ok += 1
                    with LOCK: JOB["done"] = i + 1
                    continue
                if r.get("entries"):
                    # 開催当日は出馬表を読み直して、最新の馬場状態（朝や雨で変わる）を1時間ごとに反映。
                    # 馬体重（発走の約70分前に発表）は、発表時刻が近づいたら毎回確認する
                    near = race_started(ymd, r, -80) and not all(e.get("bw") for e in r["entries"])
                    if near or ymd == dt.date.today().strftime("%Y%m%d"):
                        try: kc.body_weights(f, r, ttl_hours=0.1 if near else 1.0)
                        except Exception as ex: print(f"  出馬表（馬場・馬体重）取得スキップ ({r['id']}): {ex}")
                    n, src, err = kc.odds(f, r, ttl_hours=0.02)
                    if n: ok += 1; kc.combo_odds(f, r, ttl_hours=0.02)
                    else: errs.append(f"{r['venue']}{r['no']}R: {err}")
                with LOCK: JOB["done"] = i + 1
            for e in errs[:4]: log("オッズ取得できず " + e)
            if not ok: raise RuntimeError("オッズを1レースも取得できませんでした（発売開始前か、ネット接続の問題）。" + (errs[0] if errs else ""))
            snap["updated"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
            snapshot_path(ymd).write_text(json.dumps(snap, ensure_ascii=False), encoding="utf-8")
            srcs = sorted({r.get("oddsSrc") for r in races if r.get("oddsSrc")})
            log(f"オッズを更新しました（{ok}/{len(races)}レース・{'/'.join(srcs)}・{max((r.get('oddsAsOf') or '') for r in races)}時点）" + (f"・結果確定{fin}レース" if fin else ""))
            after_update(ymd)
            return
        races = kc.race_list(f, date)
        if not races: raise RuntimeError("この日のJRAの番組が見つかりません（出馬表は通常 木〜金曜に確定）")
        log(f"{len(races)}レース見つかりました")
        with LOCK: JOB.update(step="出馬表・調教・オッズ", total=len(races))
        for i, r in enumerate(races):
            try:
                kc.shutuba(f, r)
                prev = next((x for x in (snap or {}).get("races", []) if x.get("id") == r["id"]), None)
                if prev:   # 以前に取ったオッズ履歴を引き継ぐ（人気の変動を見るため）
                    ph = {e.get("num"): e.get("oddsHist") for e in prev.get("entries") or []}
                    for e in r.get("entries") or []:
                        if ph.get(e["num"]): e["oddsHist"] = ph[e["num"]]
                n, src, err = kc.odds(f, r); kc.training(f, r)
                if n: kc.combo_odds(f, r)
                log(f"{r['venue']}{r['no']}R {r.get('name','')} {len(r.get('entries') or [])}頭・" + (f"オッズ{src}" if n else f"オッズなし（{err}）"))
            except Exception as ex:
                log(f"{r['venue']}{r['no']}R 出馬表の取得失敗: {ex}"); r["entries"] = None
            with LOCK: JOB["done"] = i + 1
        hids = []
        for r in races:
            for e in r.get("entries") or []:
                if e["horseId"] not in hids: hids.append(e["horseId"])
        if not hids:
            raise RuntimeError("出馬表から馬を1頭も読み取れませんでした。出馬表が未確定（通常は木〜金曜に確定）か、サイトの画面構成が変わった可能性があります")
        horses = {}
        with LOCK: JOB.update(step="出走馬の全成績・血統", done=0, total=len(hids))
        for i, hid in enumerate(hids):
            name = next((e["name"] for r in races for e in (r.get("entries") or []) if e["horseId"] == hid), hid)
            try:
                runs = [x for x in kc.horse_history(f, hid) if x.get("date", "") < date.isoformat()]   # 当日以降の成績は使わない
                ped = kc.horse_pedigree(f, hid)
                horses[hid] = {"name": name, "runs": runs, **ped}
            except Exception as ex:
                log(f"{name} の成績取得に失敗: {ex}"); horses[hid] = {"name": name, "runs": []}
            with LOCK: JOB["done"] = i + 1
            if (i + 1) % 25 == 0: log(f"{i + 1}/{len(hids)}頭")
        # 新馬などで全成績が空の馬は馬柱(直近5走)で補完
        for r in races:
            if not r.get("entries"): continue
            if any(not horses.get(e["horseId"], {}).get("runs") for e in r["entries"]):
                try:
                    past = kc.shutuba_past_runs(f, r)
                    for e in r["entries"]:
                        h = horses.get(e["horseId"])
                        if h is not None and not h.get("runs") and past.get(e["horseId"]): h["runs"] = past[e["horseId"]]
                except Exception: pass
        with LOCK: JOB.update(step="馬場情報")
        track = fetch_track(f, ymd, sorted({r["venue"] for r in races}))
        snap = {"version": 1, "date": ymd, "updated": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                "source": f"netkeiba 自動取得 {dt.date.today()}", "races": races,
                "horses": {hid: {**h, "id": hid} for hid, h in horses.items()}, "track": track}
        snapshot_path(ymd).write_text(json.dumps(snap, ensure_ascii=False), encoding="utf-8")
        try:
            con = sqlite3.connect(DB_PATH); con.executescript((HERE / "schema.sql").read_text(encoding="utf-8"))
            kc.save_db(con, races, horses); con.close()
        except Exception as ex:
            log(f"SQLiteへの保存で警告: {ex}")
        n = sum(len(r.get("entries") or []) for r in races)
        nr = sum(1 for h in horses.values() if h.get("runs"))
        if hids and nr < len(hids) * 0.5:
            log(f"注意：過去成績を読み取れた馬が {nr}/{len(hids)} 頭と少なめです（新馬戦が多い日か、サイトの画面構成の変更）")
        log(f"完了：{len(races)}レース・{n}頭（重複除き{len(horses)}頭）を登録しました")
        after_update(ymd)
    except Exception as ex:
        msg = str(ex)
        if "ConnectionPool" in msg or "Connection" in type(ex).__name__ or "Timeout" in type(ex).__name__:
            msg = "netkeiba に接続できませんでした。PCのネット接続を確認して、少し時間をおいて再実行してください（" + type(ex).__name__ + "）"
        with LOCK: JOB["error"] = msg
        log("エラー: " + msg); traceback.print_exc()
    finally:
        with LOCK: JOB.update(running=False, finished_at=dt.datetime.now().astimezone().isoformat(timespec="seconds"))

AFTER_UPDATE = []          # 取得完了後に呼ぶ処理（クラウドへの送信など）
def after_update(ymd):
    for fn in AFTER_UPDATE:
        try: fn(ymd)
        except Exception as ex: log(f"クラウドへの送信で警告: {ex}")

def write_status(extra=None):
    """クラウド版の画面が読む status.json（/api/status と同じ中身）"""
    with LOCK: st = dict(JOB)
    st["nextSunday"] = next_sunday().strftime("%Y%m%d")
    st["dates"] = [d["date"] for d in collect_db()["dates"]]
    st["updated"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    st.update(extra or {})
    (DATA / "status.json").write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
    return st

def collect_db():
    """保存済みスナップショット（直近と今後）をまとめてアプリに渡す"""
    out = {"version": 1, "source": "ローカルDB", "races": [], "horses": {}, "track": {}, "dates": []}
    cutoff = (dt.date.today() - dt.timedelta(days=120)).strftime("%Y%m%d")   # 取得済みの開催日は約4か月分まで画面に出す（学習の記録はすべて残る）
    key = lambda x: (x.get("raceId") or "") + "|" + str(x.get("date")) + "|" + (x.get("race") or "")
    for p in sorted(DATA.glob("races_*.json")):
        ymd = p.stem.split("_")[1]
        if ymd < cutoff: continue
        try: j = json.loads(p.read_text(encoding="utf-8"))
        except Exception: continue
        out["races"] += j.get("races", []); out["track"].update(j.get("track", {}))
        for hid, h in (j.get("horses") or {}).items():   # 出走歴は上書きせず合わせる
            o = out["horses"].get(hid)
            if not o: out["horses"][hid] = h; continue
            m = {key(x): x for x in o.get("runs") or []}; m.update({key(x): x for x in h.get("runs") or []})
            out["horses"][hid] = {**o, **h, "runs": sorted(m.values(), key=lambda x: str(x.get("date")), reverse=True)}
        out["dates"].append({"date": ymd, "updated": j.get("updated"), "races": len(j.get("races", []))})
    try: out["cushion"] = cushion_avg(json.loads(CUSHION_FILE.read_text(encoding="utf-8")) if CUSHION_FILE.exists() else {})
    except Exception: pass
    return out

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=str(WEB), **k)
    def log_message(self, fmt, *args): pass
    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code); self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def end_headers(self):
        p = urlparse(self.path).path
        if p.endswith((".html", "/", "sw.js", ".webmanifest")): self.send_header("Cache-Control", "no-cache")
        super().end_headers()
    def guess_type(self, path):
        if str(path).endswith(".webmanifest"): return "application/manifest+json"
        if str(path).endswith(".js"): return "text/javascript; charset=utf-8"
        return super().guess_type(path)
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == "/api/status":
            with LOCK: s = dict(JOB)
            s["nextSunday"] = next_sunday().strftime("%Y%m%d"); s["dates"] = [d["date"] for d in collect_db()["dates"]]
            return self._json(s)
        if u.path == "/api/db": return self._json(collect_db())
        if u.path == "/api/backfill/status": return self._json(bf.status())
        if u.path == "/api/backfill/day":
            ymd = re.sub(r"\D", "", (q.get("date") or [""])[0])[:8]
            j = bf.day_data(ymd, races_only=bool(q.get("races"))) if len(ymd) == 8 else None
            return self._json(j or {"error": "no data"}, 200 if j else 404)
        if u.path == "/api/lock":
            fp = DATA / "lock.json"
            return self._json(json.loads(fp.read_text(encoding="utf-8")) if fp.exists() else {})
        if u.path == "/api/learn" and q.get("count"):
            fp = DATA / "learn.json"
            n = len(json.loads(fp.read_text(encoding="utf-8")).get("records", [])) if fp.exists() else 0
            return self._json({"records": n})
        if u.path == "/api/learn":
            fp = DATA / ("learn.json" if q.get("full") else "learn_model.json")
            return self._json(json.loads(fp.read_text(encoding="utf-8")) if fp.exists() else {})
        if u.path == "/api/cloud": return self._json(cloud_mod().public_conf() if cloud_mod() else {"available": False})
        if u.path == "/api/cloud/qr.svg":
            c = cloud_mod().load_conf() if cloud_mod() else {}
            try:
                import qrcode, qrcode.image.svg, io
                img = qrcode.make(c.get("url") or "", image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2)
                buf = io.BytesIO(); img.save(buf); b = buf.getvalue()
                self.send_response(200); self.send_header("Content-Type", "image/svg+xml"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
            except Exception:
                return self._json({"ok": False}, 404)
        if u.path == "/api/tweaks": return self._json(json.loads(TWEAKS.read_text(encoding="utf-8")) if TWEAKS.exists() else {})
        if u.path == "/api/pre":
            ymd = re.sub(r"\D", "", (q.get("date") or [""])[0])[:8]
            return self._json(get_pre(ymd) if len(ymd) == 8 else {})
        if u.path == "/api/summary":
            ymd = re.sub(r"\D", "", (q.get("date") or [""])[0])[:8]
            p = DATA / f"summary_{ymd}.json"
            return self._json(json.loads(p.read_text(encoding="utf-8")) if ymd and p.exists() else {})
        if u.path == "/": self.path = "/index.html"
        return super().do_GET()
    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path in ("/api/update", "/api/odds", "/api/results"):
            if JOB["running"]: return self._json({"ok": False, "message": "取得中です。終わるまでお待ちください"}, 409)
            ymd = re.sub(r"\D", "", (q.get("date") or [next_sunday().strftime("%Y%m%d")])[0])[:8]
            if len(ymd) != 8: return self._json({"ok": False, "message": "日付が正しくありません"}, 400)
            if u.path == "/api/results": threading.Thread(target=update_results, args=(ymd,), daemon=True).start()
            else: threading.Thread(target=update_date, args=(ymd, u.path == "/api/odds"), daemon=True).start()
            return self._json({"ok": True, "date": ymd})
        if u.path.startswith("/api/cloud/"):
            cm = cloud_mod()
            if not cm: return self._json({"ok": False, "message": "requests が必要です"}, 500)
            if cm.STATE.get("running"): return self._json({"ok": False, "message": "処理中です"}, 409)
            n = int(self.headers.get("Content-Length", 0)); body = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
            if u.path == "/api/cloud/setup":
                tok = (body.get("token") or "").strip()
                if not re.fullmatch(r"(ghp_|github_pat_)[A-Za-z0-9_]{20,}", tok):
                    return self._json({"ok": False, "message": "トークンの形式が違います（ghp_ で始まる文字列を貼り付けてください）"}, 400)
                threading.Thread(target=cm.setup, args=(tok, DATA, write_status), daemon=True).start()
                return self._json({"ok": True})
            if u.path in ("/api/cloud/push", "/api/cloud/republish"):
                def run():
                    with cm.LOCK: cm.STATE.update(running=True, error=None, step="送信")
                    try:
                        (cm.republish if u.path.endswith("republish") else cm.push_data)(DATA, write_status)
                        with cm.LOCK: cm.STATE["step"] = "完了"
                    except Exception as ex:
                        with cm.LOCK: cm.STATE["error"] = str(ex)
                    finally:
                        with cm.LOCK: cm.STATE["running"] = False
                threading.Thread(target=run, daemon=True).start()
                return self._json({"ok": True})
            if u.path == "/api/cloud/forget":
                try: cm.CONF.unlink()
                except Exception: pass
                return self._json({"ok": True})
            return self._json({"ok": False}, 404)
        if u.path == "/api/lock":
            n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(n).decode("utf-8") if n else "{}"
            try:
                j = json.loads(body or "{}"); fp = DATA / "lock.json"
                if j.get("action") == "lock" and isinstance(j.get("lock"), dict) and (j["lock"].get("model") or {}).get("calib"):
                    fp.write_text(json.dumps(j["lock"], ensure_ascii=False), encoding="utf-8"); log("実戦テスト：今の設定で固定しました")
                elif j.get("action") == "unlock" and fp.exists() and fp.read_text(encoding="utf-8").strip() not in ("", "{}"):
                    hp = DATA / "lock_history.json"
                    hist = json.loads(hp.read_text(encoding="utf-8")) if hp.exists() else []
                    hist.append({**json.loads(fp.read_text(encoding="utf-8")), "endedAt": dt.datetime.now().isoformat(timespec="seconds")})
                    hp.write_text(json.dumps(hist, ensure_ascii=False), encoding="utf-8"); fp.write_text("{}", encoding="utf-8"); log("実戦テスト：固定を解除しました")   # 空にする（クラウドの固定も解除されるように）
                else: return self._json({"ok": False, "message": "指定が正しくありません"}, 400)
                threading.Thread(target=lambda: _safe(lambda: _push_after(None)), daemon=True).start()   # スマホ・クラウドにも反映
                return self._json({"ok": True})
            except Exception as ex: return self._json({"ok": False, "message": str(ex)}, 400)
        if u.path == "/api/jra/probe":
            import jra_probe
            try: return self._json(jra_probe.run(DATA))
            except Exception as ex: return self._json({"ok": False, "log": [f"エラー: {ex}"]})
        if u.path == "/api/clientlog":
            n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(min(n, 20000)).decode("utf-8", "replace")
            try:
                lp = DATA / "client_log.txt"
                if lp.exists() and lp.stat().st_size > 300_000: lp.write_text(lp.read_text(encoding="utf-8")[-150_000:], encoding="utf-8")   # 大きくなりすぎないように
                with open(lp, "a", encoding="utf-8") as f: f.write(body.replace("\n", " ") + "\n")
            except Exception: pass
            return self._json({"ok": True})
        if u.path in ("/api/backfill/start", "/api/backfill/stop", "/api/backfill/done", "/api/backfill/reprocess", "/api/backfill/auto"):
            n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(n).decode("utf-8") if n else "{}"
            try: j = json.loads(body or "{}")
            except Exception: j = {}
            if u.path == "/api/backfill/start":
                frm, to = j.get("from"), j.get("to")
                try: dt.date.fromisoformat(frm); dt.date.fromisoformat(to)
                except Exception: return self._json({"ok": False, "message": "期間の指定が正しくありません"}, 400)
                return self._json({"ok": bf.start(frm, to)})
            if u.path == "/api/backfill/stop": bf.stop(); return self._json({"ok": True})
            if u.path == "/api/backfill/auto": bf.set_auto(j.get("on")); return self._json({"ok": True})
            if u.path == "/api/backfill/reprocess": return self._json({"ok": True, "n": bf.unmark_all() if j.get("all") else bf.unmark(j.get("dates") or [])})
            ymd = re.sub(r"\D", "", str(j.get("date") or ""))[:8]
            if len(ymd) != 8: return self._json({"ok": False}, 400)
            bf.mark_processed(ymd, j.get("result") or {}); return self._json({"ok": True})
        if u.path == "/api/learn":
            n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(n).decode("utf-8")
            try:
                j = json.loads(body)
                lp = DATA / "learn.json"
                if "records" in j: recs = j["records"]
                else:   # 追加分だけ送られてきたとき（過去データの一括学習など）：保存済みの記録に合わせる
                    old = json.loads(lp.read_text(encoding="utf-8")).get("records", []) if lp.exists() else []
                    m = {r["id"]: r for r in old}
                    for r in j.get("append") or []:
                        o = m.get(r["id"]); m[r["id"]] = {**r, "bets": r.get("bets") or (o or {}).get("bets")}
                    recs = sorted(m.values(), key=lambda r: (r.get("date", ""), r.get("id", "")))
                model = j.get("model")
                # 記録の一部だけで学習したモデル（空のモデルなど）で、保存済みの記録全体のモデルを上書きしない
                if not isinstance(model, dict) or (model.get("races") or 0) < len(recs) * 0.9:
                    old_m = json.loads(lp.read_text(encoding="utf-8")).get("model") if lp.exists() else None
                    log(f"学習モデルの保存を見送りました（{(model or {}).get('races')}レース分のモデル・記録は{len(recs)}レース）")
                    model = old_m if isinstance(old_m, dict) and (old_m.get("races") or 0) >= (model or {}).get("races", 0) else model
                    model_ok = False
                else: model_ok = True
                lp.write_text(json.dumps({"model": model, "records": recs}, ensure_ascii=False), encoding="utf-8")
                if model_ok: (DATA / "learn_model.json").write_text(json.dumps(model, ensure_ascii=False), encoding="utf-8")
                log(f"学習を更新しました（{len(recs)}レース分）")
                global LAST_LEARN_PUSH
                if time.time() - LAST_LEARN_PUSH > 1800 or not j.get("bulk"):   # 一括学習中はクラウドへの送信を30分に1回に抑える
                    LAST_LEARN_PUSH = time.time()
                    threading.Thread(target=lambda: _safe(lambda: _push_after(None)), daemon=True).start()
                return self._json({"ok": True, "records": len(recs), "modelSaved": model_ok})
            except Exception as ex:
                return self._json({"ok": False, "message": str(ex)}, 400)
        if u.path in ("/api/tweaks", "/api/summary"):
            n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(n).decode("utf-8")
            if u.path == "/api/tweaks": target = TWEAKS
            else:
                ymd = re.sub(r"\D", "", (q.get("date") or [""])[0])[:8]
                if len(ymd) != 8: return self._json({"ok": False, "message": "date"}, 400)
                target = DATA / f"summary_{ymd}.json"
            try:
                j = json.loads(body); target.write_text(body, encoding="utf-8")
                if u.path == "/api/summary": _safe(lambda: save_pre_from_summary(ymd, j))
                return self._json({"ok": True})
            except Exception as ex: return self._json({"ok": False, "message": str(ex)}, 400)
        return self._json({"ok": False}, 404)

# ===== 発走前の予想の記録（答え合わせを「発走前の買い目」で正しく行うため） =====
def _start_of(ymd, post):
    m = re.match(r"(\d{1,2}):(\d{2})", post or "")
    if not m: return None
    return dt.datetime(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:]), int(m.group(1)), int(m.group(2))).astimezone()

def _at(x):
    try:
        t = dt.datetime.fromisoformat(str(x.get("at")).replace("Z", "+00:00"))
        return t if t.tzinfo else t.astimezone()
    except Exception: return None

def save_pre_from_summary(ymd, summ):
    """一括予想の保存のたびに、発走前に計算した行を pre_YYYYMMDD.json に残す（あとで計算し直しても消えない）"""
    p = DATA / f"pre_{ymd}.json"
    pre = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"date": summ.get("date"), "rows": {}}
    n = 0
    for x in summ.get("rows") or []:
        cand = [y for y in (x, x.get("preRace")) if y]
        for y in cand:
            st, at = _start_of(ymd, y.get("postTime")), _at(y)
            if not (st and at and at <= st): continue
            old = pre["rows"].get(y["id"])
            if not old or (_at(old) or at) < at:
                row = {k: v for k, v in y.items() if k != "preRace"}; pre["rows"][y["id"]] = row; n += 1
            break
    if n:
        pre["updated"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        p.write_text(json.dumps(pre, ensure_ascii=False), encoding="utf-8")

PRE_CACHE = {}
def get_pre(ymd):
    """PCの記録とクラウドの記録（クラウドが自動で計算した発走前の予想）を合わせて返す"""
    p = DATA / f"pre_{ymd}.json"
    pre = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"rows": {}}
    c = PRE_CACHE.get(ymd)
    if not c or time.time() - c[0] > 300:
        remote = None
        try:
            import cloud
            remote = cloud.fetch_remote_json(f"pre_{ymd}.json")
        except Exception: remote = None
        PRE_CACHE[ymd] = c = (time.time(), remote)
    remote = c[1]
    if remote and remote.get("rows"):
        for k, v in remote["rows"].items():
            o = pre["rows"].get(k)
            if not o or (_at(o) and _at(v) and _at(o) < _at(v)): pre["rows"][k] = v
    return pre

LAST_LEARN_PUSH = 0.0
def _safe(fn):
    try: fn()
    except Exception as ex: print("クラウド更新で警告:", ex)

def open_app_window(url):
    """Edge / Chrome があればアドレスバーなしのアプリ風ウィンドウで開く。なければ通常のブラウザ"""
    cands = []
    if os.name == "nt":
        for base in (os.environ.get("ProgramFiles(x86)", ""), os.environ.get("ProgramFiles", ""), os.environ.get("LOCALAPPDATA", "")):
            cands += [Path(base) / "Microsoft/Edge/Application/msedge.exe", Path(base) / "Google/Chrome/Application/chrome.exe"]
    elif sys.platform == "darwin":
        cands += [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")]
    else:
        cands += [Path(p) for p in (shutil.which("google-chrome") or "", shutil.which("chromium") or "", shutil.which("microsoft-edge") or "") if p]
    for exe in cands:
        try:
            if exe and exe.is_file():
                subprocess.Popen([str(exe), f"--app={url}", "--window-size=1280,900"]); return
        except Exception: pass
    webbrowser.open(url)

def ensure_three():
    """3D表示用ライブラリ（three.js）を初回だけダウンロードして web/ に置く（以後はネット不要）"""
    dst = WEB / "three.min.js"
    if dst.exists() and dst.stat().st_size > 100000: return
    import requests
    for url in ("https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js", "https://unpkg.com/three@0.149.0/build/three.min.js"):
        try:
            r = requests.get(url, timeout=30)
            if r.ok and len(r.content) > 100000:
                dst.write_bytes(r.content); print("three.js を保存しました"); return
        except Exception: pass
    print("three.js をダウンロードできませんでした（3D表示はネット経由で読み込みます）")

_CLOUD = None
def cloud_mod():
    global _CLOUD
    if _CLOUD is None:
        try:
            import cloud as c; _CLOUD = c
        except Exception as ex:
            print("クラウド機能は使えません:", ex); _CLOUD = False
    return _CLOUD or None

def _push_after(ymd):
    cm = cloud_mod()
    if cm and cm.load_conf().get("token"): cm.push_data(DATA, write_status, ymd)
if not os.environ.get("KEIBA_CLOUD_RUN"):
    AFTER_UPDATE.append(_push_after)

def auto_odds_loop():
    """PCのアプリが起動している間、開催当日は15分おきにオッズを更新し、最終レース後に結果を取得する"""
    last = {}
    while True:
        time.sleep(60)
        try:
            ymd = dt.date.today().strftime("%Y%m%d"); p = snapshot_path(ymd)
            if JOB["running"] or not p.exists(): continue
            snap = json.loads(p.read_text(encoding="utf-8"))
            posts = []
            for r in snap.get("races", []):
                m = re.match(r"(\d{1,2}):(\d{2})", r.get("postTime") or "")
                if m and r.get("entries"): posts.append(dt.datetime.combine(dt.date.today(), dt.time(int(m.group(1)), int(m.group(2)))))
            if not posts: continue
            now = dt.datetime.now()
            if min(posts) - dt.timedelta(minutes=90) <= now <= max(posts) and time.time() - last.get("odds", 0) >= 15 * 60:
                last["odds"] = time.time(); log("自動オッズ更新（15分おき）"); update_date(ymd, odds_only=True)
            elif now >= max(posts) + dt.timedelta(minutes=25) and not last.get("results_" + ymd) and now <= max(posts) + dt.timedelta(hours=6):
                last["results_" + ymd] = True; log("最終レース後の結果取得（答え合わせ用）"); update_results(ymd)
        except Exception as ex:
            print("自動更新で警告:", ex)

def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("8.8.8.8", 80)); ip = s.getsockname()[0]; s.close(); return ip
    except Exception: return "127.0.0.1"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--update", help="YYYYMMDD または next（次の日曜）。指定すると取得だけして終了")
    ap.add_argument("--odds", help="YYYYMMDD または next。オッズだけ更新して終了")
    ap.add_argument("--results", help="YYYYMMDD または next。レース結果（答え合わせ用）を取得して終了")
    a = ap.parse_args()
    if a.results:
        update_results(next_sunday().strftime("%Y%m%d") if a.results == "next" else a.results); return
    if a.update or a.odds:
        v = a.update or a.odds
        ymd = next_sunday().strftime("%Y%m%d") if v == "next" else v
        update_date(ymd, odds_only=bool(a.odds)); return
    ensure_three()
    if not os.environ.get("KEIBA_NO_AUTO"):
        threading.Thread(target=auto_odds_loop, daemon=True).start()
        bf.resume_if_active()     # 途中だった過去データの取得を続きから再開
    cm = cloud_mod()
    if cm and cm.load_conf().get("token") and cm.load_conf().get("appVersion") != cm.app_version():
        threading.Thread(target=lambda: _safe(lambda: cm.republish(DATA, write_status)), daemon=True).start()   # アプリを新しくしたらクラウドも更新
    try:
        srv = ThreadingHTTPServer(("0.0.0.0", a.port), Handler)
    except OSError:
        print(f"ポート {a.port} は使用中です。すでに起動していないか確認してください（ブラウザで http://localhost:{a.port} を開く）")
        if not a.no_browser: open_app_window(f"http://localhost:{a.port}")
        return
    ip = lan_ip()
    print("=" * 60)
    print(" 競馬展開シミュレーター 起動しました")
    print(f"  PC      : http://localhost:{a.port}")
    print(f"  スマホ  : http://{ip}:{a.port}  （PCと同じWi-Fiにつないで開く）")
    print("  終了するにはこの画面で Ctrl + C")
    print("=" * 60)
    if not a.no_browser:
        threading.Timer(1.0, lambda: open_app_window(f"http://localhost:{a.port}")).start()
    try: srv.serve_forever()
    except KeyboardInterrupt: pass

if __name__ == "__main__":
    main()
