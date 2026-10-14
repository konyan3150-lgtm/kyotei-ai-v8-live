"""Offline fixture tests for fetch_tomorrow.py (no network). Run: python scripts/test_fetch_tomorrow.py"""
import importlib.util, io, json, sys, tempfile
from contextlib import redirect_stdout
from pathlib import Path

spec = importlib.util.spec_from_file_location("ft", Path(__file__).with_name("fetch_tomorrow.py"))
ft = importlib.util.module_from_spec(spec); spec.loader.exec_module(ft)

def racer_row(i):
    return (f"<tr><td>{4000+i} / A1 選手{i} 福岡/福岡 30歳 / 52.0kg F0 L0 0.15 "
            f"6.50 45.00 60.00 6.20 40.00 55.00 {10+i} 35.00 50.00 {20+i} 33.00 48.00</td></tr>")
TIMES = "<table><tr>" + "".join(f"<td>{10+i//2:02d}:{(i%2)*30:02d}</td>" for i in range(12)) + "</tr></table>"
def page(racers=6, close=True):
    return f"<html><head><title>出走表</title></head><body><h3>予選 1800m</h3><table>{''.join(racer_row(i) for i in range(1, racers+1))}</table>{TIMES if close else ''}</body></html>"

def expect_error(html, needle):
    try:
        ft.parse_race(html, "20261015", 1, 1)
    except ValueError as e:
        assert needle in str(e), (needle, str(e)); return str(e)
    raise AssertionError("no error for " + needle)

# 1) empty / short pages, missing racers, no close time -> reasons; title and text appear in the reason
expect_error("", "racers 0/6")
msg = expect_error("<html><head><title>データがありません</title></head><body><p>本日のレースはありません</p></body></html>", "racers 0/6")
assert "データがありません" in msg and "本日のレースはありません" in msg, msg
expect_error(page(racers=5), "racers 5/6")
expect_error(page(close=False), "close time not found")
# 2) normal page parses
race = ft.parse_race(page(), "20261015", 1, 3)
assert len(race["racers"]) == 6 and race["closed_at"] == "2026-10-15 11:00:00", race

# 3) build: all 12 races failing -> reason counts and 3 samples; incomplete -> existing file unchanged byte for byte
ft.active_venues = lambda date: [1]
ft.time.sleep = lambda s: None
def run_main(html_for):
    ft.fetch_page = lambda session, date, venue, race: html_for(race)
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "tomorrow.json"; original = b'{"date":"20260917","keep":"me"}'
        out.write_bytes(original)
        argv = sys.argv; sys.argv = ["fetch_tomorrow.py", str(out)]; buf = io.StringIO()
        try:
            with redirect_stdout(buf): code = ft.main()
        finally:
            sys.argv = argv
        return code, buf.getvalue(), out.read_bytes(), original
code, log, after, original = run_main(lambda race: "<html><body>no tables</body></html>")
assert code == 0 and after == original, "incomplete program must not touch the file"
assert "races parsed 0/12" in log and "failures 12" in log and "{'racers 0/6': 12}" in log, log
assert log.count("failure sample:") == 3, log
assert "::warning::Next-day program not written" in log, log
# 4) complete 12 races -> written
code, log, after, original = run_main(lambda race: page())
data = json.loads(after)
assert code == 0 and after != original and sum(len(v["races"]) for v in data["programs"]["stadiums"].values()) == 12, log
assert "races parsed 12/12" in log and "Wrote" in log, log
print("fetch_tomorrow OK: reasons with page title/text, normal parse, 12 failures summarized with 3 samples, incomplete keeps the file byte for byte, complete program written")
