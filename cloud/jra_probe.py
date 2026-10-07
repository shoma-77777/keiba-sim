"""
JRA公式の「競走中の出来事等」（斜行の被害馬・他馬の影響・出遅れ等）を取れるかの確かめ（数回アクセスするだけ・まだ集めない）
------------------------------------------------------------------
・JRAのレース結果ページはアドレスに検証用の文字が入るため、ページに書かれたリンクをたどる方式でしか行けない。
・ここでは入口のページを開き、そこからリンクを1つたどって「競走中の出来事等」が読めるかだけを試し、結果を data/jra_probe.txt に残す。
・サイトに負担をかけないよう、1回ごとに2秒あける（合計3〜4回）。
"""
import datetime as dt, re, time
import requests

BASE = "https://www.jra.go.jp/JRADB/accessS.html"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
CN = re.compile(r"(pw01s[a-z]{2}\d{2}\w*?/[0-9A-F]{2})")


def _text(r):
    r.encoding = "shift_jis" if "shift_jis" in (r.headers.get("content-type", "").lower() + r.text[:600].lower()) else (r.apparent_encoding or "utf-8")
    return r.text


def incidents(html):
    """「競走中の出来事等」の見出しの後ろの文を取り出す"""
    i = html.find("競走中の出来事")
    if i < 0: return None
    seg = re.sub(r"<[^>]+>", "\n", html[i:i + 6000])
    lines = [re.sub(r"\s+", " ", x).strip(" ・") for x in seg.split("\n")]
    out = []
    for x in lines[1:]:
        if not x: continue
        if re.search(r"(払戻金|勝馬|ハロンタイム|コーナー通過|お問い合わせ|ページの先頭)", x) and out: break
        if "号" in x: out.append(x)
    return out


def run(data_dir):
    s = requests.Session(); s.headers.update({"User-Agent": UA, "Accept-Language": "ja"})
    log = [f"JRA取得テスト {dt.datetime.now().isoformat(timespec='seconds')}"]
    res = {"ok": False, "steps": []}
    def step(name, fn):
        try:
            r = fn(); txt = _text(r); cn = list(dict.fromkeys(CN.findall(txt)))
            info = {"step": name, "status": r.status_code, "bytes": len(r.content), "cnames": len(cn), "sample": cn[:6], "hasIncidents": "競走中の出来事" in txt}
            log.append(f"{name}: HTTP {r.status_code}・{len(r.content)}バイト・リンク{len(cn)}件 {cn[:6]}・出来事欄{'あり' if info['hasIncidents'] else 'なし'}")
            res["steps"].append(info); time.sleep(2); return txt, cn
        except Exception as ex:
            log.append(f"{name}: エラー {ex}"); res["steps"].append({"step": name, "error": str(ex)}); time.sleep(2); return "", []
    t1, c1 = step("入口（GET）", lambda: s.get(BASE, timeout=20))
    t2, c2 = step("レース結果の一覧（POST pw01sli00/AF）", lambda: s.post(BASE, data={"cname": "pw01sli00/AF"}, timeout=20))
    race = next((c for c in c2 + c1 if c.startswith("pw01sde")), None)
    if race:
        t3, _ = step(f"レース結果（{race}）", lambda: s.post(BASE, data={"cname": race}, timeout=20))
        inc = incidents(t3) if t3 else None
        if inc is not None:
            res["ok"] = True; res["incidents"] = inc
            log.append("競走中の出来事等: " + (" / ".join(inc) if inc else "（このレースは記載なし）"))
    log.append("判定: " + ("取得できます（リンクをたどる方式で集められます）" if res["ok"] else "取得できませんでした（このログを送ってください）"))
    try: (data_dir / "jra_probe.txt").write_text("\n".join(log), encoding="utf-8")
    except Exception: pass
    res["log"] = log
    return res
