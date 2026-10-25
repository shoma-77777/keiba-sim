#!/usr/bin/env python3
"""
クラウド（GitHub Actions）で動く自動取得
--------------------------------------------------
GitHub が決まった時間にこのスクリプトを動かし、土曜・日曜の全レース・オッズを取得して docs/data/ に保存します（土曜は2026-10-25から）。
docs/ は GitHub Pages で公開されるので、スマホはいつでも最新データでシミュレーションできます。

  python cloud/cloud_update.py --kind auto      # 状況に応じて全レース取得 or オッズ更新
  python cloud/cloud_update.py --kind full --date 20261011
  python cloud/cloud_update.py --kind odds
"""
import argparse, datetime as dt, json, os, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = ROOT / "docs" / "data"
os.environ["KEIBA_DATA"] = str(DATA)
os.environ["KEIBA_DB"] = str(HERE / "keiba.db")   # SQLite はクラウドでは使い捨て
os.environ["KEIBA_CLOUD_RUN"] = "1"
sys.path.insert(0, str(HERE))
import server as S  # noqa: E402


def snapshot_age_hours(ymd):
    p = S.snapshot_path(ymd)
    if not p.exists(): return None
    try:
        j = json.loads(p.read_text(encoding="utf-8"))
        t = dt.datetime.fromisoformat(j.get("updated"))
        if t.tzinfo is None: t = t.astimezone()
        return (dt.datetime.now().astimezone() - t).total_seconds() / 3600
    except Exception:
        return 999


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", default="auto", choices=["auto", "full", "odds", "results", "learn"])
    ap.add_argument("--date", default="next")
    ap.add_argument("--races", default="")   # 2026-10-25：オッズ更新をこのレースだけにする（カンマ区切りのレースID）
    a = ap.parse_args()
    # 2026-10-25：土曜も自動で記録する。date=next のとき、金曜は土・日の両方、土曜は18時まで土曜・それ以降は日曜、日曜は日曜
    now = dt.datetime.now()
    if a.date in ("", "next"):
        sat = now.date() + dt.timedelta(days=(5 - now.weekday()) % 7)
        if now.weekday() == 4 and a.kind in ("auto", "full"): targets = [sat, S.next_sunday()]
        elif now.weekday() == 5 and now.hour < 18: targets = [now.date()]
        else: targets = [S.next_sunday()]
        targets = [t.strftime("%Y%m%d") for t in targets]
    else:
        targets = [a.date.replace("-", "")]
    # 発走前の予想を記録する日（ワークフローの次の手順 predict_run.js が読む）
    try: (Path(__file__).resolve().parent / "last_targets.txt").write_text(" ".join(targets), encoding="utf-8")
    except Exception: pass
    for ymd in targets: run_one(a, ymd, now)
    finish()


def run_one(a, ymd, now):
    kind = a.kind
    if kind == "auto":
        age = snapshot_age_hours(ymd)
        wd = dt.date.today().weekday()          # 4=金 5=土 6=日
        if age is None: kind = "full"
        elif wd in (4, 5) and age > 10 and ymd != now.strftime("%Y%m%d"): kind = "full"   # 前日までは出馬表の変更（取消など）も拾う
        else: kind = "odds"
    if kind == "auto" or kind == "odds":
        if now.weekday() in (5, 6) and now.hour * 60 + now.minute >= 16 * 60 + 40 and ymd == now.strftime("%Y%m%d"):
            kind = "results"            # 開催日（土・日）の最終レース後は結果（答え合わせ用）
    print(f"対象 {ymd} / {kind}", flush=True)
    if kind == "learn":
        # スマホの答え合わせ（発走前の推奨の仮想収支）を保存。学習は次のステップ（learn_run.js）で行う
        raw = os.environ.get("BETS_JSON") or ""
        if raw.strip():
            bp = DATA / f"bets_{ymd}.json"
            old = json.loads(bp.read_text(encoding="utf-8")) if bp.exists() else {}
            old.update(json.loads(raw)); bp.write_text(json.dumps(old, ensure_ascii=False), encoding="utf-8")
            print(f"仮想収支を保存: {len(old)}レース")
        S.write_status({"source": "GitHub Actions"})
        return
    if kind == "results":
        S.update_results(ymd)
    else:
        rid = [x for x in re.split(r"[,\s]+", a.races or "") if re.fullmatch(r"\d{12}", x)] if kind == "odds" else []
        S.update_date(ymd, odds_only=(kind == "odds"), race_ids=rid or None)
    if kind == "odds" and S.JOB.get("error") and not S.snapshot_path(ymd).exists():
        print("スナップショットがないため全レース取得に切り替えます", flush=True)
        S.update_date(ymd, odds_only=False)

    archive(ymd)


# 2026-10-25：保存庫（archive/YYYYMMDD.json.gz・公開されない場所）。docs/data の races_*.json・pre_*.json は14日で消すので、
#  その前に「発走前のオッズの推移・馬連などのオッズ（最後の1回分）・結果・発走前の予想」だけを圧縮して残す。後でオッズの動きを調べるため
ARCH = ROOT / "archive"
def archive(ymd):
    try:
        import gzip
        rp, pp = DATA / f"races_{ymd}.json", DATA / f"pre_{ymd}.json"
        if not rp.exists(): return
        j = json.loads(rp.read_text(encoding="utf-8"))
        keep_r = ("id", "date", "venue", "no", "name", "postTime", "surface", "distance", "going", "goingAt", "weather", "fieldSize", "oddsAsOf", "oddsSrc", "comboOdds", "comboAsOf", "oddsFinal", "result")
        keep_e = ("num", "waku", "name", "horseId", "sexAge", "weight", "jockey", "trainer", "odds", "pop", "placeLo", "placeHi", "oddsHist", "bodyWeight", "bwDiff", "scratched")
        races = [{**{k: r[k] for k in keep_r if k in r}, "entries": [{k: e[k] for k in keep_e if k in e} for e in r.get("entries") or []]} for r in j.get("races") or []]
        out = {"date": ymd, "archivedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"), "races": races,
               "pre": json.loads(pp.read_text(encoding="utf-8")) if pp.exists() else None}
        ARCH.mkdir(exist_ok=True)
        (ARCH / f"{ymd}.json.gz").write_bytes(gzip.compress(json.dumps(out, ensure_ascii=False).encode("utf-8"), 9))
    except Exception as ex:
        print(f"保存庫への保存に失敗: {ymd} {ex}", flush=True)


def finish():
    # 古いスナップショット（14日より前）を整理
    cutoff = (dt.date.today() - dt.timedelta(days=14)).strftime("%Y%m%d")
    for p in list(DATA.glob("races_*.json")) + list(DATA.glob("pre_*.json")):
        if p.stem.split("_")[1] < cutoff:
            archive(p.stem.split("_")[1])   # 消す前に保存庫へ（オッズの推移・発走前の予想・結果）
            p.unlink()
    for p in DATA.glob("summary_*.json"): p.unlink()
    # ログは直近300行だけ残す
    lp = DATA / "update_log.txt"
    if lp.exists():
        lines = lp.read_text(encoding="utf-8").splitlines()[-300:]
        lp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    st = S.write_status({"source": "GitHub Actions"})
    print(json.dumps({k: st[k] for k in ("date", "error", "updated", "dates")}, ensure_ascii=False))
    # 取得に失敗しても既存データは残すので、ワークフローは成功扱い（画面にエラーを表示する）


if __name__ == "__main__":
    main()
