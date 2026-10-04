#!/usr/bin/env python3
"""
クラウド（GitHub Actions）で動く自動取得
--------------------------------------------------
GitHub が決まった時間にこのスクリプトを動かし、日曜の全レース・オッズを取得して docs/data/ に保存します。
docs/ は GitHub Pages で公開されるので、スマホはいつでも最新データでシミュレーションできます。

  python cloud/cloud_update.py --kind auto      # 状況に応じて全レース取得 or オッズ更新
  python cloud/cloud_update.py --kind full --date 20261011
  python cloud/cloud_update.py --kind odds
"""
import argparse, datetime as dt, json, os, sys
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
    a = ap.parse_args()
    ymd = S.next_sunday().strftime("%Y%m%d") if a.date in ("", "next") else a.date.replace("-", "")
    kind = a.kind
    if kind == "auto":
        age = snapshot_age_hours(ymd)
        wd = dt.date.today().weekday()          # 4=金 5=土 6=日
        if age is None: kind = "full"
        elif wd in (4, 5) and age > 10: kind = "full"   # 金・土は出馬表の変更（取消など）も拾う
        else: kind = "odds"
    if kind == "auto" or kind == "odds":
        now = dt.datetime.now()
        if now.weekday() == 6 and now.hour * 60 + now.minute >= 16 * 60 + 40 and ymd == now.strftime("%Y%m%d"):
            kind = "results"            # 日曜の最終レース後は結果（答え合わせ用）
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
        S.update_date(ymd, odds_only=(kind == "odds"))
    if kind == "odds" and S.JOB.get("error") and not S.snapshot_path(ymd).exists():
        print("スナップショットがないため全レース取得に切り替えます", flush=True)
        S.update_date(ymd, odds_only=False)

    # 古いスナップショット（14日より前）を整理
    cutoff = (dt.date.today() - dt.timedelta(days=14)).strftime("%Y%m%d")
    for p in list(DATA.glob("races_*.json")) + list(DATA.glob("pre_*.json")):
        if p.stem.split("_")[1] < cutoff: p.unlink()
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
