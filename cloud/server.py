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

WEB = HERE / "web"
DATA = Path(os.environ.get("KEIBA_DATA") or (HERE / "data")); DATA.mkdir(parents=True, exist_ok=True)
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

def fetch_track(f, ymd, venues):
    """JRA馬場情報ページからクッション値・含水率を拾う（取れない場合は空。アプリで手入力可）"""
    out = {}
    try:
        html = f.get("https://www.jra.go.jp/keiba/baba/", ttl_hours=3)
        txt = kc.clean(kc.soup(html).get_text(" "))
        for v in venues:
            i = txt.find(v)
            if i < 0: continue
            seg = txt[i:i + 1500]
            m = re.search(r"クッション値[^0-9]{0,20}(\d{1,2}\.\d)", seg)
            mo = re.search(r"含水率[^。]{0,120}", seg)
            if m:
                c = float(m.group(1))
                out[f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}|{v}"] = {"cushion": c, "cushionLabel": "硬め" if c >= 10.3 else "やや硬め" if c >= 9.8 else "標準" if c >= 9.0 else "やや軟らかめ" if c >= 8.5 else "軟らかめ",
                    "moisture": mo.group(0)[:80] if mo else "", "note": "JRA馬場情報より自動取得", "frontBias": 0.2 if c >= 9.8 else 0.1, "innerBias": 0.15, "src": "JRA 馬場情報"}
    except Exception as ex:
        log(f"馬場情報は取得できませんでした（アプリで手入力できます）: {ex}")
    return out

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
            for i, r in enumerate(races):
                if r.get("entries"):
                    n, src, err = kc.odds(f, r, ttl_hours=0.02)
                    if n: ok += 1; kc.combo_odds(f, r, ttl_hours=0.02)
                    else: errs.append(f"{r['venue']}{r['no']}R: {err}")
                with LOCK: JOB["done"] = i + 1
            for e in errs[:4]: log("オッズ取得できず " + e)
            if not ok: raise RuntimeError("オッズを1レースも取得できませんでした（発売開始前か、ネット接続の問題）。" + (errs[0] if errs else ""))
            snap["updated"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
            snapshot_path(ymd).write_text(json.dumps(snap, ensure_ascii=False), encoding="utf-8")
            srcs = sorted({r.get("oddsSrc") for r in races if r.get("oddsSrc")})
            log(f"オッズを更新しました（{ok}/{len(races)}レース・{'/'.join(srcs)}・{max((r.get('oddsAsOf') or '') for r in races)}時点）")
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
    cutoff = (dt.date.today() - dt.timedelta(days=8)).strftime("%Y%m%d")
    for p in sorted(DATA.glob("races_*.json")):
        ymd = p.stem.split("_")[1]
        if ymd < cutoff: continue
        try: j = json.loads(p.read_text(encoding="utf-8"))
        except Exception: continue
        out["races"] += j.get("races", []); out["horses"].update(j.get("horses", {})); out["track"].update(j.get("track", {}))
        out["dates"].append({"date": ymd, "updated": j.get("updated"), "races": len(j.get("races", []))})
    for fn, key in (("model_weights.json", "modelWeights"), ("upset_weights.json", "anaWeights")):
        p = HERE / fn
        if p.exists():
            try:
                j = json.loads(p.read_text(encoding="utf-8")); v = j.get(key, j)
                if isinstance(v, dict) and v: out[key] = v
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
        if u.path == "/api/summary":
            ymd = re.sub(r"\D", "", (q.get("date") or [""])[0])[:8]
            p = DATA / f"summary_{ymd}.json"
            return self._json(json.loads(p.read_text(encoding="utf-8")) if ymd and p.exists() else {})
        if u.path == "/": self.path = "/index.html"
        return super().do_GET()
    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path in ("/api/update", "/api/odds"):
            if JOB["running"]: return self._json({"ok": False, "message": "取得中です。終わるまでお待ちください"}, 409)
            ymd = re.sub(r"\D", "", (q.get("date") or [next_sunday().strftime("%Y%m%d")])[0])[:8]
            if len(ymd) != 8: return self._json({"ok": False, "message": "日付が正しくありません"}, 400)
            threading.Thread(target=update_date, args=(ymd, u.path == "/api/odds"), daemon=True).start()
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
        if u.path in ("/api/tweaks", "/api/summary"):
            n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(n).decode("utf-8")
            if u.path == "/api/tweaks": target = TWEAKS
            else:
                ymd = re.sub(r"\D", "", (q.get("date") or [""])[0])[:8]
                if len(ymd) != 8: return self._json({"ok": False, "message": "date"}, 400)
                target = DATA / f"summary_{ymd}.json"
            try: json.loads(body); target.write_text(body, encoding="utf-8"); return self._json({"ok": True})
            except Exception as ex: return self._json({"ok": False, "message": str(ex)}, 400)
        return self._json({"ok": False}, 404)

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
    a = ap.parse_args()
    if a.update or a.odds:
        v = a.update or a.odds
        ymd = next_sunday().strftime("%Y%m%d") if v == "next" else v
        update_date(ymd, odds_only=bool(a.odds)); return
    ensure_three()
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
