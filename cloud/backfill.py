"""
過去の開催をまとめて取得する（過去3年分など。放置しておけば終わる）
--------------------------------------------------------------------------
・指定した期間の毎日について、JRAの開催があれば全レースの 出馬表・調教・確定オッズ（単複・馬連・ワイド・馬単・3連複）・結果・払戻・馬体重 を取得
・出走馬の全成績と血統は1頭につき1回だけ取得して data/past/horses.sqlite に保存（どの日を予想するときも、その日より前の出走だけを渡す）
・取得は古い日から順に進み、途中で止めても、アプリを閉じても、続きから再開する
・取得した日は、アプリの画面（PC）が「その日より前のデータだけで学習したモデル」で予想 → 答え合わせ → 学習 を古い順に自動で進める
・サイトに負担をかけないよう、1回の取得ごとに1.5秒以上あける。ページはディスクに保存しない
"""
import datetime as dt, json, sqlite3, threading, time, traceback
from pathlib import Path

import keiba_collector as kc

PAST = None
LOCK = threading.Lock()
ST = {"running": False, "stop": False, "phase": "", "cur": None, "log": [], "requests": 0, "startedAt": None}


def init(data_dir):
    global PAST
    PAST = Path(data_dir) / "past"; PAST.mkdir(parents=True, exist_ok=True)


def _prog_path(): return PAST / "progress.json"
def load_prog():
    p = _prog_path()
    if p.exists():
        try: return json.loads(p.read_text(encoding="utf-8"))
        except Exception: pass
    return {"from": None, "to": None, "active": False, "fetched": {}, "processed": {}}
def save_prog(pr): _prog_path().write_text(json.dumps(pr, ensure_ascii=False), encoding="utf-8")


def _db():
    con = sqlite3.connect(PAST / "horses.sqlite")
    con.execute("CREATE TABLE IF NOT EXISTS horses (id TEXT PRIMARY KEY, json TEXT, fetched TEXT)")
    return con


def _log(msg):
    line = f"{dt.datetime.now().strftime('%m-%d %H:%M:%S')} {msg}"
    print("[過去データ] " + line, flush=True)
    with LOCK:
        ST["log"] = (ST["log"] + [line])[-60:]


def start(frm, to):
    pr = load_prog()
    pr.update({"from": frm, "to": to, "active": True})
    save_prog(pr)
    with LOCK:
        if ST["running"]: return False
        ST.update(running=True, stop=False, startedAt=dt.datetime.now().isoformat(timespec="seconds"))
    threading.Thread(target=_loop, daemon=True).start()
    return True


def stop():
    pr = load_prog(); pr["active"] = False; save_prog(pr)
    with LOCK: ST["stop"] = True


def resume_if_active():
    """アプリを起動し直したとき、途中だった取得を続きから再開する"""
    pr = load_prog()
    if pr.get("active") and pr.get("from") and pr.get("to"):
        with LOCK:
            if ST["running"]: return
            ST.update(running=True, stop=False, startedAt=dt.datetime.now().isoformat(timespec="seconds"))
        threading.Thread(target=_loop, daemon=True).start()


class _CountingFetcher(kc.Fetcher):
    def get(self, url, ttl_hours=None, encoding=None):
        with LOCK: ST["requests"] += 1
        return super().get(url, ttl_hours=ttl_hours, encoding=encoding)


def _stopped():
    with LOCK: return ST["stop"]


def _loop():
    try:
        pr = load_prog()
        f = _CountingFetcher(delay=1.5, cache=False)
        d = dt.date.fromisoformat(pr["from"]); end = min(dt.date.fromisoformat(pr["to"]), dt.date.today() - dt.timedelta(days=1))
        con = _db()
        while d <= end and not _stopped():
            ymd = d.strftime("%Y%m%d")
            if ymd in pr["fetched"]:
                d += dt.timedelta(days=1); continue
            with LOCK: ST.update(cur=d.isoformat(), phase="レース一覧")
            try:
                races = kc.race_list(f, d)
            except Exception as ex:
                _log(f"{d} のレース一覧を取得できませんでした（30秒後に再試行）: {ex}"); time.sleep(30); continue
            if not races:
                pr["fetched"][ymd] = 0; save_prog(pr); d += dt.timedelta(days=1); continue
            _log(f"{d}：{len(races)}レースを取得します")
            for i, r in enumerate(races):
                if _stopped(): break
                with LOCK: ST.update(phase=f"出馬表・オッズ・結果 {i + 1}/{len(races)}")
                try:
                    kc.shutuba(f, r)
                    kc.race_result(f, r)
                    if r.get("result"):
                        bwr = {x.get("num"): kc.parse_bw(x.get("bw")) for x in r["result"].get("rows") or []}
                        for e in r.get("entries") or []:
                            if bwr.get(e["num"]): e.update(bwr[e["num"]])
                    n, _, _ = kc.odds(f, r, ttl_hours=0)
                    if n: kc.combo_odds(f, r, ttl_hours=0)
                    kc.training(f, r)
                    r["oddsFinal"] = True; r["oddsAsOf"] = "確定オッズ（過去データ）"; r["backfill"] = True
                except Exception as ex:
                    _log(f"{r.get('venue')}{r.get('no')}R の取得に失敗: {ex}"); r["entries"] = r.get("entries") or None
            if _stopped(): break
            # 出走馬の全成績・血統（まだ持っていない馬だけ）
            have = {row[0] for row in con.execute("SELECT id FROM horses")}
            hids = []
            for r in races:
                for e in r.get("entries") or []:
                    if e["horseId"] not in have and e["horseId"] not in hids: hids.append(e["horseId"])
            for k, hid in enumerate(hids):
                if _stopped(): break
                with LOCK: ST.update(phase=f"出走馬の成績・血統 {k + 1}/{len(hids)}")
                name = next((e["name"] for r in races for e in (r.get("entries") or []) if e["horseId"] == hid), hid)
                try:
                    runs = kc.horse_history(f, hid); ped = kc.horse_pedigree(f, hid)
                    con.execute("INSERT OR REPLACE INTO horses VALUES (?, ?, ?)", (hid, json.dumps({"name": name, "runs": runs, **ped}, ensure_ascii=False), dt.date.today().isoformat()))
                except Exception as ex:
                    _log(f"{name} の成績取得に失敗: {ex}")
                if (k + 1) % 20 == 0: con.commit()
            con.commit()
            if _stopped(): break
            ids = sorted({e["horseId"] for r in races for e in (r.get("entries") or [])})
            (PAST / f"day_{ymd}.json").write_text(json.dumps({"date": d.isoformat(), "races": races, "horseIds": ids}, ensure_ascii=False), encoding="utf-8")
            pr = load_prog(); pr["fetched"][ymd] = len(races); save_prog(pr)
            _log(f"{d}：{len(races)}レース・新しい馬{len(hids)}頭を保存")
            d += dt.timedelta(days=1)
        if not _stopped():
            pr = load_prog(); pr["active"] = False; pr["fetchDone"] = dt.datetime.now().isoformat(timespec="seconds"); save_prog(pr)
            _log("指定期間の取得が終わりました")
    except Exception as ex:
        _log("エラーで止まりました: " + str(ex)); traceback.print_exc()
    finally:
        with LOCK: ST.update(running=False, phase="", cur=None)


def day_data(ymd):
    """その日のレースと、その日より前の出走だけに絞った出走馬データ（予想・学習に使う）"""
    p = PAST / f"day_{ymd}.json"
    if not p.exists(): return None
    j = json.loads(p.read_text(encoding="utf-8")); date = j["date"]
    con = _db(); horses = {}
    ids = j.get("horseIds") or []
    for k in range(0, len(ids), 500):
        chunk = ids[k:k + 500]
        for hid, js in con.execute(f"SELECT id, json FROM horses WHERE id IN ({','.join('?' * len(chunk))})", chunk):
            h = json.loads(js); h["runs"] = [x for x in h.get("runs") or [] if str(x.get("date", "")) < date]
            horses[hid] = {**h, "id": hid}
    con.close()
    return {"date": date, "races": [r for r in j["races"] if r.get("entries")], "horses": horses}


def mark_processed(ymd, payload):
    pr = load_prog(); pr.setdefault("processed", {})[ymd] = payload; save_prog(pr)


def status():
    pr = load_prog()
    fetched = {k: v for k, v in pr.get("fetched", {}).items() if v}
    processed = pr.get("processed", {})
    try:
        con = _db(); nh = con.execute("SELECT COUNT(*) FROM horses").fetchone()[0]; con.close()
    except Exception: nh = 0
    days_total = None
    if pr.get("from") and pr.get("to"):
        days_total = (min(dt.date.fromisoformat(pr["to"]), dt.date.today() - dt.timedelta(days=1)) - dt.date.fromisoformat(pr["from"])).days + 1
    with LOCK: st = dict(ST); st["log"] = list(ST["log"][-15:])
    return {**st, "from": pr.get("from"), "to": pr.get("to"), "active": pr.get("active"), "fetchDone": pr.get("fetchDone"),
            "daysChecked": len(pr.get("fetched", {})), "daysTotal": days_total, "raceDays": len(fetched), "races": sum(fetched.values()),
            "horses": nh, "pending": sorted(k for k in fetched if k not in processed), "processed": processed}
