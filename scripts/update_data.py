#!/usr/bin/env python3
"""WebbRadar data updater (Python standard library only).

Builds the JSON files the web page reads:

  data/schedule.json  STScI weekly JWST observing schedules, parsed and merged
  data/programs.json  title / PI / cycle / category for every program referenced
  data/watch.json     visit status + plan windows for programs matching config/interests.json
  data/releases.json  MAST: JWST products going public soon, and recently public
  data/meta.json      timestamps, sources and any step errors

A failed step keeps the previous file, so the page always has something to show.

Usage:
  python3 scripts/update_data.py                  # normal run
  python3 scripts/update_data.py --refresh-catalog  # re-read the approved-program lists now
  python3 scripts/update_data.py --skip-visits --skip-mast
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import html
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "cache"
CONFIG_PATH = ROOT / "config" / "interests.json"

STSCI = "https://www.stsci.edu"
SCHEDULE_INDEX = STSCI + "/jwst/science-execution/observing-schedules"
APPROVED_INDEX = STSCI + "/jwst/science-execution/approved-programs"
PROGRAM_PAGE = STSCI + "/jwst-program-info/program/?program={pid}"
VISITS_XML = STSCI + "/jwst-program-info/visits/?program={pid}&download="
MAST_API = "https://mast.stsci.edu/api/v0/invoke"
USER_AGENT = "WebbRadar/1.0 (personal JWST schedule dashboard; python-urllib)"

UTC = dt.timezone.utc
NOW = dt.datetime.now(UTC).replace(microsecond=0)
MJD0 = dt.datetime(1858, 11, 17, tzinfo=UTC)

SCHEDULE_WEEKS = 4            # previous weeks + current + next
CATALOG_MAX_AGE = dt.timedelta(days=7)
PROGRAM_PAGE_MAX_AGE = dt.timedelta(days=30)
VISITS_MAX_AGE = dt.timedelta(hours=20)
VISITS_DONE_MAX_AGE = dt.timedelta(days=14)
RELEASE_PAST_DAYS = 45
RELEASE_FUTURE_DAYS = 200
RECENT_VISIT_DAYS = 21
MAX_PROGRAM_PAGES_PER_RUN = 80

FINISHED_STATUSES = {"archived", "withdrawn", "failed - archived", "failed", "completed"}

errors: list[str] = []


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def iso(t: dt.datetime | None) -> str | None:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


def parse_iso(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def mjd(t: dt.datetime) -> float:
    return (t - MJD0).total_seconds() / 86400.0


def from_mjd(x: float) -> dt.datetime:
    return MJD0 + dt.timedelta(days=x)


def http(url: str, data: bytes | None = None, timeout: int = 60, tries: int = 3) -> str:
    last: Exception | None = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            last = e
            if 400 <= e.code < 500 and e.code != 429:
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = e
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{url} -> {last}")


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, obj, compact: bool = True):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":") if compact else None,
                      indent=None if compact else 1, sort_keys=False)
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def clean(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", html.unescape(text)).replace("\xa0", " ").strip()


# --------------------------------------------------------------------------- interests

Z_PATTERNS = [
    re.compile(r"\bz\s*(?:[~≈>≳≥=]|&gt;)\s*(\d{1,2}(?:\.\d+)?)", re.I),
    re.compile(r"(\d{1,2}(?:\.\d+)?)\s*(?:<|≲|≤|&lt;)\s*z\b", re.I),
    re.compile(r"(?:^|[^a-z0-9])z[-_]?(\d{1,2}(?:\.\d+)?)(?![0-9])", re.I),
    re.compile(r"\bredshifts?\s+(?:of\s+)?(\d{1,2}(?:\.\d+)?)", re.I),
]


def max_redshift(text: str) -> float:
    best = -1.0
    for rx in Z_PATTERNS:
        for m in rx.finditer(text or ""):
            try:
                best = max(best, float(m.group(1)))
            except ValueError:
                pass
    return best


class Interests:
    """Same matching rules as assets/app.js (keep the two in sync)."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.z_threshold = float(cfg.get("z_threshold", 4))
        self.topics = []
        for t in cfg.get("topics", []):
            self.topics.append({
                "key": t["key"],
                "weight": float(t.get("weight", 1)),
                "rx": [re.compile(p, re.I) for p in t.get("patterns", [])],
                "cats": set(t.get("categories", [])),
                "excl": set(t.get("exclude_categories", [])),
            })
        self.fields = []
        for f in cfg.get("fields", []):
            toks = f.get("tokens") or []
            rx = re.compile(r"(?:^|[^a-z0-9])(?:" + "|".join(toks) + r")(?![a-z0-9])", re.I) if toks else None
            self.fields.append({**f, "rx": rx,
                                "cosd": math.cos(math.radians(f["dec"]))})
        self.watch = {int(p) for p in cfg.get("watch_programs", [])}
        track = cfg.get("track", {})
        self.min_score = float(track.get("min_score", 2))
        self.min_cycle = int(track.get("min_cycle", 3))

    def tags(self, text: str, category: str | None = None, fields=()) -> list[str]:
        out = []
        for t in self.topics:
            if category and category in t["cats"]:
                out.append(t["key"])
                continue
            if category and category in t["excl"]:
                continue
            if any(r.search(text) for r in t["rx"]):
                out.append(t["key"])
        hiz = next((t for t in self.topics if t["key"] == "hiz"), None)
        if hiz and "hiz" not in out and not (category and category in hiz["excl"]):
            if max_redshift(text) >= self.z_threshold:
                out.append("hiz")
        if fields and "field" not in out and any(t["key"] == "field" for t in self.topics):
            out.append("field")
        return out

    def score(self, tags) -> float:
        w = {t["key"]: t["weight"] for t in self.topics}
        return sum(w.get(k, 0) for k in tags)

    def fields_in_text(self, text: str) -> list[str]:
        return [f["name"] for f in self.fields if f["rx"] is not None and f["rx"].search(text or "")]

    def field_at(self, ra, dec) -> str | None:
        if ra is None or dec is None:
            return None
        best, best_d = None, 1e9
        for f in self.fields:
            dra = (ra - f["ra"] + 540.0) % 360.0 - 180.0
            d = math.hypot(dra * f["cosd"], dec - f["dec"])
            if d <= f["r"] and d < best_d:
                best, best_d = f["name"], d
        return best


# --------------------------------------------------------------------------- schedules

SCHED_LINK_RE = re.compile(r'href="([^"]*?/(\d{8})_report_(\d{8})\.txt)"')


def list_schedule_files() -> list[dict]:
    page = http(SCHEDULE_INDEX)
    weeks: dict[str, dict] = {}
    for href, week, reported in SCHED_LINK_RE.findall(page):
        info = {"name": href.rsplit("/", 1)[-1], "url": urllib.parse.urljoin(STSCI, href),
                "week": f"{week[:4]}-{week[4:6]}-{week[6:]}", "reported": f"{reported[:4]}-{reported[4:6]}-{reported[6:]}"}
        if week not in weeks or info["reported"] > weeks[week]["reported"]:
            weeks[week] = info
    if not weeks:
        raise RuntimeError("no schedule files found on the STScI page")
    return [weeks[w] for w in sorted(weeks)]


def parse_duration(s: str) -> int:
    m = re.match(r"\s*(\d+)/(\d+):(\d+):(\d+)", s or "")
    if not m:
        return 0
    d, h, mi, se = map(int, m.groups())
    return ((d * 24 + h) * 60 + mi) * 60 + se


def split_fixed(line: str, starts: list[int]) -> list[str]:
    """Cut a fixed-width row; if a value overflows into the next column, move that boundary."""
    bounds = list(starts)
    for k in range(1, len(bounds)):
        b = bounds[k]
        if 0 < b < len(line) and line[b - 1] != " " and line[b] != " ":
            nxt = line.find("  ", b)
            bounds[k] = nxt + 2 if nxt != -1 else len(line)
    out = []
    for k, a in enumerate(bounds):
        b = bounds[k + 1] if k + 1 < len(bounds) else None
        out.append((line[a:b] if b is not None else line[a:]).strip())
    return out


def parse_visit_id(vid: str):
    m = re.match(r"(\d+):(\d+):(\d+)$", vid.strip())
    return tuple(int(x) for x in m.groups()) if m else (None, None, None)


def parse_schedule(text: str, src: str) -> list[dict]:
    lines = text.splitlines()
    try:
        hi = next(i for i, ln in enumerate(lines) if ln.lstrip().startswith("VISIT ID"))
    except StopIteration:
        raise ValueError(f"{src}: header line not found")
    starts = [m.start() for m in re.finditer(r"-+", lines[hi + 1])]
    if len(starts) < 9:
        raise ValueError(f"{src}: expected 9 columns, found {len(starts)}")
    starts = starts[:9]
    keys = ["id", "pcs", "type", "start", "dur", "mode", "target", "cat", "kw"]
    visits: list[dict] = []
    last = None
    for ln in lines[hi + 2:]:
        if not ln.strip():
            continue
        row = dict(zip(keys, split_fixed(ln, starts)))
        kw = [k.strip() for k in row["kw"].split(",") if k.strip()]
        if not row["id"]:
            if last is not None and (row["type"] or row["mode"]):
                last["par"].append({"type": row["type"], "mode": row["mode"]})
            continue
        pid, obs, vis = parse_visit_id(row["id"])
        if "ATTACHED" in row["start"].upper():
            if last is not None:
                p = {"id": row["id"], "pid": pid, "type": row["type"], "mode": row["mode"]}
                if row["target"]:
                    p["target"] = row["target"]
                if row["cat"]:
                    p["cat"] = row["cat"]
                if kw:
                    p["kw"] = kw
                last["par"].append(p)
            continue
        t0 = parse_iso(row["start"])
        if t0 is None:
            continue
        v = {"id": row["id"], "pid": pid, "obs": obs, "visit": vis, "pcs": row["pcs"], "type": row["type"],
             "start": iso(t0), "dur": parse_duration(row["dur"]), "mode": row["mode"],
             "target": row["target"], "cat": row["cat"], "kw": kw, "par": [], "src": src}
        visits.append(v)
        last = v
    return visits


def build_schedule(prev: dict | None) -> dict:
    files = list_schedule_files()[-SCHEDULE_WEEKS:]
    merged: list[dict] = []
    used = []
    for info in files:
        try:
            text = http(info["url"])
            visits = parse_schedule(text, info["name"])
        except Exception as e:  # noqa: BLE001 - keep going with the other weeks
            errors.append(f"schedule {info['name']}: {e}")
            log("  !", errors[-1])
            continue
        if not visits:
            continue
        pkg = re.search(r"OP Package\s+(\S+)", text)
        t_first = min(parse_iso(v["start"]) for v in visits)
        t_last = max(parse_iso(v["start"]) + dt.timedelta(seconds=v["dur"]) for v in visits)
        # A newer file supersedes older ones from its first visit onwards.
        merged = [v for v in merged if parse_iso(v["start"]) < t_first]
        merged.extend(visits)
        used.append({**info, "package": pkg.group(1) if pkg else None,
                     "first": iso(t_first), "last": iso(t_last), "n": len(visits)})
        log(f"  {info['name']}: {len(visits)} visits")
    if not merged:
        raise RuntimeError("no schedule visits parsed")
    merged.sort(key=lambda v: v["start"])
    return {"generated": iso(NOW), "source": SCHEDULE_INDEX, "files": used, "visits": merged}


# --------------------------------------------------------------------------- program catalog

HEADING_OR_TABLE = re.compile(r"<h([1-6])[^>]*>(.*?)</h\1>|<table\b.*?</table>", re.S | re.I)
ROW_RE = re.compile(r"<tr\b.*?</tr>", re.S | re.I)
CELL_RE = re.compile(r"<t([hd])\b[^>]*>(.*?)</t\1>", re.S | re.I)
SKIP_HEADINGS = {"main navigation", "jwst menu", "breadcrumbs navigation", "jwst prefooter", "footer",
                 "secondary navigation", "social media", "utility navigation"}


def column_key(header: str) -> str | None:
    h = header.lower()
    if h in ("id", "pid"):
        return "id"
    if "title" in h:
        return "t"
    if "exclusive" in h:
        return "eap"
    if h.startswith("pi") or "principal" in h:
        return "pi"
    if "hours" in h or "time" in h:
        return "hrs"
    if "instrument" in h:
        return "inst"
    if h == "type":
        return "ty"
    if h.startswith("coordinated"):
        return "with"
    return None


def cell_parts(inner: str) -> list[str]:
    parts = re.split(r"<br\s*/?>|\n", inner)
    return [c for c in (clean(p) for p in parts) if c]


def parse_pi(parts: list[str]) -> tuple[str, str]:
    text = " | ".join(parts)
    m = re.search(r"\bPIs?\s*:\s*(.*?)(?:\s*\|\s*|\s+)Co-?PIs?\s*:\s*(.*)$", text, re.I)
    if m:
        return m.group(1).strip(" |"), m.group(2).replace(" | ", ", ").strip(" |")
    m = re.search(r"\bPIs?\s*:\s*(.*)$", text, re.I)
    if m:
        return m.group(1).replace(" | ", ", ").strip(" |"), ""
    return text.replace(" | ", ", "), ""


def parse_approved_page(page: str, kind: str, cycle: int | None) -> dict[int, dict]:
    out: dict[int, dict] = {}
    heading = None
    for m in HEADING_OR_TABLE.finditer(page):
        block = m.group(0)
        if not block.lower().startswith("<table"):
            text = clean(m.group(2))
            if text and text.lower() not in SKIP_HEADINGS:
                heading = text
            continue
        rows = ROW_RE.findall(block)
        if len(rows) < 2:
            continue
        header = [clean(c[1]) for c in CELL_RE.findall(rows[0])]
        keys = [column_key(h) for h in header]
        if "id" not in keys:
            continue
        cyc = cycle
        cat = heading if kind == "GO" else None
        if kind in ("GTO", "DDT", "JOINT") and heading:
            mc = re.search(r"Cycles?\s+(\d+)", heading)
            cyc = int(mc.group(1)) if mc else None
        if kind == "CAL":
            cat = f"Calibration ({heading})" if heading else "Calibration"
        for row in rows[1:]:
            cells = CELL_RE.findall(row)
            rec: dict = {}
            for key, (_, inner) in zip(keys, cells):
                if key is None:
                    continue
                parts = cell_parts(inner)
                if key == "id":
                    mm = re.search(r"\d+", " ".join(parts))
                    rec["id"] = int(mm.group(0)) if mm else None
                elif key == "pi":
                    rec["pi"], rec["co"] = parse_pi(parts)
                elif key == "inst":
                    rec["inst"] = parts
                elif key == "eap":
                    mm = re.search(r"\d+", " ".join(parts))
                    rec["eap"] = int(mm.group(0)) if mm else None
                else:
                    rec[key] = " ".join(parts)
            pid = rec.pop("id", None)
            if not pid:
                continue
            row_cycle = cyc
            title = rec.get("t", "")
            if kind == "CAL":
                mc = re.match(r"(CAL-[A-Z]+-(\d)\d\d)\s*(.*)", title)
                if mc:
                    title = f"{mc.group(1)}: {mc.group(3)}".rstrip(": ")
                    row_cycle = max(1, int(mc.group(2)))
            if kind == "GO":
                ty = rec.get("ty") or "GO"
            elif kind == "JOINT":
                ty = f"{rec.get('ty') or 'GO'}, joint with {rec['with']}" if rec.get("with") else (rec.get("ty") or "GO")
            else:
                ty = kind
            entry = {"t": title, "pi": rec.get("pi", ""), "co": rec.get("co", ""), "cy": row_cycle, "ty": ty,
                     "cat": cat, "eap": rec.get("eap"), "hrs": rec.get("hrs", ""), "inst": rec.get("inst", [])}
            if pid in out:
                for k, v in entry.items():
                    if v and not out[pid].get(k):
                        out[pid][k] = v
            else:
                out[pid] = entry
    return out


def build_catalog(force: bool) -> dict:
    path = CACHE / "catalog.json"
    cached = read_json(path, {})
    fetched = parse_iso(cached.get("fetched"))
    if cached.get("programs") and fetched and NOW - fetched < CATALOG_MAX_AGE and not force:
        return cached
    log("Approved-program lists")
    pages = []
    try:
        index = http(APPROVED_INDEX)
        cycles = sorted({int(c) for c in re.findall(r"general-observers/cycle-(\d+)-go", index)})
    except Exception as e:  # noqa: BLE001
        errors.append(f"approved index: {e}")
        cycles = []
    cycles = cycles or [1, 2, 3, 4, 5]
    pages += [(f"general-observers/cycle-{c}-go", "GO", c) for c in cycles]
    pages += [("guaranteed-time-observations", "GTO", None), ("directors-discretionary-time", "DDT", None),
              ("joint-observing-programs", "JOINT", None), ("calibration", "CAL", None)]
    programs: dict[int, dict] = {}
    ok = 0
    for slug, kind, cyc in pages:
        try:
            got = parse_approved_page(http(f"{APPROVED_INDEX}/{slug}", timeout=90), kind, cyc)
            ok += 1
            log(f"  {slug}: {len(got)} programs")
            for pid, rec in got.items():
                programs.setdefault(pid, rec)
        except Exception as e:  # noqa: BLE001
            errors.append(f"approved {slug}: {e}")
            log("  !", errors[-1])
        time.sleep(0.5)
    if ok == 0 and cached.get("programs"):
        return cached
    old = {int(k): v for k, v in cached.get("programs", {}).items()}
    for pid, rec in old.items():
        programs.setdefault(pid, rec)
    result = {"fetched": iso(NOW), "programs": {str(k): v for k, v in sorted(programs.items())}}
    write_json(path, result)
    return result


def fetch_program_page(pid: int) -> dict:
    text = clean(http(PROGRAM_PAGE.format(pid=pid)))
    rec: dict = {"src": "page"}
    m = re.search(r"\b(GO/DD|GO|GTO|DDT|DD|ERS|CAL|COM|ENG|SURVEY|AR)\s+%d\b" % pid, text)
    if m:
        rec["ty"] = m.group(1)
    m = re.search(r"Title:\s*(.*?)\s+Cycle:", text)
    if m:
        rec["t"] = m.group(1)
    m = re.search(r"Principal Investigator:\s*(.*?)\s+(?:PI Institution|Investigators|Title):", text)
    if m:
        rec["pi"] = m.group(1)
    m = re.search(r"Cycle:\s*(\d+)", text)
    if m:
        rec["cy"] = int(m.group(1))
    m = re.search(r"Exclusive Access Period:\s*(\d+)\s*month", text)
    if m:
        rec["eap"] = int(m.group(1))
    m = re.search(r"Program Status:\s*(.*?)\s+(?:Program Coordinator|Contact|Program Contents|Requests|$)", text)
    if m:
        rec["status"] = m.group(1)[:40]
    if "t" not in rec:
        raise RuntimeError(f"program {pid}: page without a title")
    return rec


# --------------------------------------------------------------------------- visit status

VS_TIME_FMT = "%b %d, %Y %H:%M:%S"
WINDOW_RE = re.compile(r"([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s*-\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})")


def parse_vs_time(s: str | None) -> str | None:
    if not s or not s.strip():
        return None
    try:
        return iso(dt.datetime.strptime(s.strip(), VS_TIME_FMT).replace(tzinfo=UTC))
    except ValueError:
        return None


def parse_windows(s: str | None) -> list[list[str]]:
    out = []
    for a, b in WINDOW_RE.findall(s or ""):
        try:
            d0 = dt.datetime.strptime(re.sub(r"\s+", " ", a), "%b %d, %Y").date().isoformat()
            d1 = dt.datetime.strptime(re.sub(r"\s+", " ", b), "%b %d, %Y").date().isoformat()
            out.append([d0, d1])
        except ValueError:
            continue
    return out


def fetch_visit_status(pid: int) -> list[dict]:
    root = ET.fromstring(http(VISITS_XML.format(pid=pid)))
    visits = []
    for v in root.findall("visit"):
        rec = {"obs": int(v.get("observation") or 0), "visit": int(v.get("visit") or 0),
               "status": (v.findtext("status") or "").strip(),
               "targets": sorted({(t.text or "").strip() for t in v.findall("target") if (t.text or "").strip()}),
               "modes": [(c.text or "").strip() for c in v.findall("configuration") if (c.text or "").strip()]}
        try:
            rec["hours"] = round(float(v.findtext("hours") or 0), 2)
        except ValueError:
            rec["hours"] = None
        start, end = parse_vs_time(v.findtext("startTime")), parse_vs_time(v.findtext("endTime"))
        if start:
            rec["start"] = start
        if end:
            rec["end"] = end
        windows = parse_windows(v.findtext("planWindow"))
        if windows:
            rec["windows"] = windows
        visits.append(rec)
    return visits


def is_done(visits: list[dict]) -> bool:
    return bool(visits) and all(v["status"].lower() in FINISHED_STATUSES for v in visits)


def build_watch(tracked: list[int], max_fetch: int) -> dict:
    path = CACHE / "visit_status.json"
    cache = read_json(path, {})
    todo = []
    for pid in tracked:
        ent = cache.get(str(pid))
        fetched = parse_iso(ent.get("fetched")) if ent else None
        age_limit = VISITS_DONE_MAX_AGE if ent and ent.get("done") else VISITS_MAX_AGE
        if not fetched or NOW - fetched > age_limit:
            todo.append(pid)
    # Oldest first, so a capped run still makes progress across runs.
    todo.sort(key=lambda p: (cache.get(str(p), {}).get("fetched") or ""))
    todo = todo[:max_fetch]
    log(f"Visit status: {len(tracked)} tracked, fetching {len(todo)}")
    failed = 0

    def work(pid):
        time.sleep(0.2)
        return pid, fetch_visit_status(pid)

    with cf.ThreadPoolExecutor(max_workers=4) as pool:
        futs = [pool.submit(work, p) for p in todo]
        for fut in cf.as_completed(futs):
            try:
                pid, visits = fut.result()
                cache[str(pid)] = {"fetched": iso(NOW), "done": is_done(visits), "visits": visits}
            except Exception as e:  # noqa: BLE001
                failed += 1
                if failed <= 5:
                    errors.append(f"visit status: {e}")
    if failed:
        log(f"  ! {failed} visit-status requests failed")
    write_json(path, cache)

    today = NOW.date()
    horizon_past = NOW - dt.timedelta(days=RECENT_VISIT_DAYS)
    programs, out_visits = {}, []
    for pid in tracked:
        ent = cache.get(str(pid))
        if not ent:
            continue
        visits = ent.get("visits", [])
        counts = Counter(v["status"] for v in visits)
        future_windows = sorted(w for v in visits if v["status"].lower() not in FINISHED_STATUSES
                                for w in v.get("windows", []) if w[1] >= today.isoformat())
        archived_ends = sorted(v.get("end") or v.get("start") for v in visits
                               if v["status"].lower().startswith("archived") and (v.get("end") or v.get("start")))
        sched_starts = sorted(v["start"] for v in visits
                              if v["status"].lower() == "scheduled" and v.get("start"))
        programs[str(pid)] = {"fetched": ent.get("fetched"), "n": len(visits), "counts": dict(counts),
                              "hours": round(sum(v.get("hours") or 0 for v in visits), 1),
                              "next_window": future_windows[0] if future_windows else None,
                              "next_scheduled": next((s for s in sched_starts if s >= iso(NOW - dt.timedelta(days=1))), None),
                              "last_archived": archived_ends[-1] if archived_ends else None,
                              "done": ent.get("done", False)}
        for v in visits:
            st = v["status"].lower()
            keep = False
            if st in FINISHED_STATUSES:
                t = parse_iso(v.get("end") or v.get("start"))
                keep = st.startswith("archived") and t is not None and t >= horizon_past
            else:
                ws = v.get("windows", [])
                t = parse_iso(v.get("end") or v.get("start"))
                keep = (any(w[1] >= today.isoformat() for w in ws)
                        or (t is not None and t >= NOW - dt.timedelta(days=2))
                        or (not ws and t is None))
            if keep:
                out_visits.append({"pid": pid, **v})
    return {"generated": iso(NOW), "tracked": tracked, "programs": programs, "visits": out_visits}


# --------------------------------------------------------------------------- MAST

def mast_query(params: dict, pagesize: int = 20000, max_pages: int = 25) -> list[dict]:
    rows, page = [], 1
    while True:
        req = {"service": "Mast.Caom.Filtered", "format": "json", "pagesize": pagesize, "page": page,
               "params": params}
        body = urllib.parse.urlencode({"request": json.dumps(req)}).encode()
        res = json.loads(http(MAST_API, data=body, timeout=240))
        if res.get("status") not in ("COMPLETE", None):
            raise RuntimeError(f"MAST: {res.get('status')} {res.get('msg')}")
        rows.extend(res.get("data") or [])
        pages = (res.get("paging") or {}).get("pagesFiltered", 1) or 1
        if page >= pages or page >= max_pages:
            return rows
        page += 1


def build_releases(interests: Interests) -> tuple[dict, dict]:
    lo, hi = NOW - dt.timedelta(days=RELEASE_PAST_DAYS), NOW + dt.timedelta(days=RELEASE_FUTURE_DAYS)
    filters = [{"paramName": "obs_collection", "values": ["JWST"]},
               {"paramName": "intentType", "values": ["science"]},
               {"paramName": "calib_level", "values": [3]},
               {"paramName": "t_obs_release", "values": [{"min": mjd(lo), "max": mjd(hi)}]}]
    cols = "proposal_id,obs_title,proposal_pi,target_name,instrument_name,filters,t_obs_release,t_min,t_exptime,s_ra,s_dec"
    rows = mast_query({"columns": cols, "filters": filters})
    log(f"MAST releases: {len(rows)} level-3 products")
    groups: dict[tuple, dict] = {}
    titles: dict[int, dict] = {}
    for r in rows:
        try:
            pid = int(r["proposal_id"])
            rel = from_mjd(float(r["t_obs_release"]))
        except (TypeError, ValueError, KeyError):
            continue
        day = rel.date().isoformat()
        g = groups.setdefault((pid, day), {"pid": pid, "date": day, "time": iso(rel), "n": 0, "inst": Counter(),
                                           "filters": Counter(), "targets": Counter(), "fields": Counter(),
                                           "obs0": None, "obs1": None, "exp": 0.0})
        g["n"] += 1
        g["inst"][(r.get("instrument_name") or "").upper()] += 1
        for f in re.split(r"[;,]", r.get("filters") or ""):
            if f.strip():
                g["filters"][f.strip().upper()] += 1
        if r.get("target_name"):
            g["targets"][r["target_name"]] += 1
        fld = interests.field_at(r.get("s_ra"), r.get("s_dec"))
        if fld:
            g["fields"][fld] += 1
        if r.get("t_min"):
            t = from_mjd(float(r["t_min"])).date().isoformat()
            g["obs0"] = min(g["obs0"] or t, t)
            g["obs1"] = max(g["obs1"] or t, t)
        g["exp"] += float(r.get("t_exptime") or 0)
        titles.setdefault(pid, {"t": r.get("obs_title") or "", "pi": r.get("proposal_pi") or ""})
    out = []
    for g in groups.values():
        out.append({"pid": g["pid"], "date": g["date"], "time": g["time"], "n": g["n"],
                    "inst": [k for k, _ in g["inst"].most_common() if k],
                    "filters": [k for k, _ in g["filters"].most_common(12)],
                    "targets": [k for k, _ in g["targets"].most_common(8)],
                    "ntargets": len(g["targets"]),
                    "fields": [k for k, _ in g["fields"].most_common(3)],
                    "obs": [g["obs0"], g["obs1"]], "exp_h": round(g["exp"] / 3600.0, 1)})
    out.sort(key=lambda g: (g["date"], g["pid"]))
    return ({"generated": iso(NOW), "window": [lo.date().isoformat(), hi.date().isoformat()], "groups": out},
            titles)


def program_fields_from_mast(pids: list[int], interests: Interests) -> dict[int, list[str]]:
    if not pids:
        return {}
    rows = mast_query({"columns": "proposal_id,s_ra,s_dec", "filters": [
        {"paramName": "obs_collection", "values": ["JWST"]},
        {"paramName": "intentType", "values": ["science"]},
        {"paramName": "calib_level", "values": [3]},
        {"paramName": "proposal_id", "values": [str(p) for p in pids]}]}, pagesize=50000, max_pages=6)
    counts: dict[int, Counter] = defaultdict(Counter)
    for r in rows:
        f = interests.field_at(r.get("s_ra"), r.get("s_dec"))
        if f:
            try:
                counts[int(r["proposal_id"])][f] += 1
            except (TypeError, ValueError):
                pass
    return {pid: [f for f, _ in c.most_common(3)] for pid, c in counts.items()}


# --------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh-catalog", action="store_true", help="re-read STScI approved-program lists now")
    ap.add_argument("--skip-visits", action="store_true", help="do not fetch visit status")
    ap.add_argument("--skip-mast", action="store_true", help="do not query MAST")
    ap.add_argument("--max-visit-fetch", type=int, default=400, help="cap on visit-status requests per run")
    args = ap.parse_args()

    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    interests = Interests(cfg)
    meta = read_json(DATA / "meta.json", {})
    steps = meta.get("steps", {})

    def ok(step, **extra):
        steps[step] = {"ok": True, "at": iso(NOW), **extra}

    def fail(step, e):
        msg = f"{step}: {e}"
        errors.append(msg)
        log("  !", msg)
        prev = steps.get(step, {})
        steps[step] = {**prev, "ok": False, "error": str(e)[:300], "failed_at": iso(NOW)}

    # 1. schedule
    log("Weekly schedules")
    schedule = read_json(DATA / "schedule.json", None)
    try:
        schedule = build_schedule(schedule)
        write_json(DATA / "schedule.json", schedule)
        ok("schedule", n=len(schedule["visits"]), files=[f["name"] for f in schedule["files"]])
    except Exception as e:  # noqa: BLE001
        fail("schedule", e)

    # 2. catalog
    catalog = {}
    try:
        catalog = build_catalog(args.refresh_catalog)
        ok("catalog", n=len(catalog.get("programs", {})), fetched=catalog.get("fetched"))
    except Exception as e:  # noqa: BLE001
        fail("catalog", e)
        catalog = read_json(CACHE / "catalog.json", {})
    cat_programs = {int(k): v for k, v in catalog.get("programs", {}).items()}

    def tags_for(pid: int, rec: dict, extra_text: str = "", fields=()):
        text = " ".join([rec.get("t", ""), extra_text])
        return interests.tags(text, rec.get("cat"), fields)

    # Programs to track for visit windows.
    tracked = set(interests.watch)
    for pid, rec in cat_programs.items():
        ty = (rec.get("ty") or "").upper()
        if ty.startswith("CAL") or re.fullmatch(r"AR(,.*)?", ty.strip()):
            continue
        if (rec.get("cy") or 0) < interests.min_cycle:
            continue
        if interests.score(tags_for(pid, rec)) >= interests.min_score:
            tracked.add(pid)
    sched_visits = (schedule or {}).get("visits", [])
    for v in sched_visits:
        for item in [v] + [p for p in v.get("par", []) if p.get("pid")]:
            pid = item.get("pid")
            if not pid:
                continue
            rec = cat_programs.get(pid, {})
            text = " ".join([rec.get("t", ""), item.get("target", ""), item.get("cat", ""), ", ".join(item.get("kw", []))])
            if interests.score(interests.tags(text, rec.get("cat") or item.get("cat"))) >= interests.min_score:
                tracked.add(pid)
    tracked_list = sorted(tracked)

    # 3. MAST releases
    releases, mast_titles = read_json(DATA / "releases.json", None), {}
    if not args.skip_mast:
        try:
            releases, mast_titles = build_releases(interests)
            write_json(DATA / "releases.json", releases)
            ok("releases", n=len(releases["groups"]))
        except Exception as e:  # noqa: BLE001
            fail("releases", e)

    # 4. visit status
    watch = read_json(DATA / "watch.json", None)
    if not args.skip_visits:
        try:
            watch = build_watch(tracked_list, args.max_visit_fetch)
            write_json(DATA / "watch.json", watch)
            ok("watch", tracked=len(tracked_list), visits=len(watch["visits"]))
        except Exception as e:  # noqa: BLE001
            fail("watch", e)

    # 5. programs referenced anywhere
    referenced: set[int] = set(tracked_list)
    sched_targets: dict[int, set] = defaultdict(set)
    for v in sched_visits:
        if v.get("pid"):
            referenced.add(v["pid"])
            if v.get("target"):
                sched_targets[v["pid"]].add(v["target"])
        for p in v.get("par", []):
            if p.get("pid"):
                referenced.add(p["pid"])
                if p.get("target"):
                    sched_targets[p["pid"]].add(p["target"])
    for g in (releases or {}).get("groups", []):
        referenced.add(g["pid"])
    watch_targets: dict[int, set] = defaultdict(set)
    for v in (watch or {}).get("visits", []):
        for t in v.get("targets", []):
            watch_targets[v["pid"]].add(t)

    # Per-program pages fill gaps: programs missing from the lists, or listed without an EAP (GTO, DDT, joint).
    page_cache = read_json(CACHE / "program_pages.json", {})
    missing = [p for p in sorted(referenced)
               if (p not in cat_programs or cat_programs[p].get("eap") is None)
               and not (cat_programs.get(p, {}).get("ty") or "").upper().startswith("CAL")
               and (str(p) not in page_cache
                    or NOW - (parse_iso(page_cache[str(p)].get("fetched")) or MJD0) > PROGRAM_PAGE_MAX_AGE)]
    if missing:
        log(f"Program pages: {len(missing)} to fill (missing from the lists or without EAP)")
        for pid in missing[:MAX_PROGRAM_PAGES_PER_RUN]:
            try:
                page_cache[str(pid)] = {"fetched": iso(NOW), **fetch_program_page(pid)}
            except Exception as e:  # noqa: BLE001
                page_cache[str(pid)] = {"fetched": iso(NOW), "t": "", "error": str(e)[:120]}
            time.sleep(0.3)
        write_json(CACHE / "program_pages.json", page_cache)

    mast_fields: dict[int, list[str]] = {}
    if not args.skip_mast:
        wanted = set(tracked_list) | set(sched_targets)
        science = [p for p in sorted(wanted)
                   if not (cat_programs.get(p, {}).get("ty") or "").upper().startswith("CAL")]
        try:
            mast_fields = program_fields_from_mast(science, interests)
        except Exception as e:  # noqa: BLE001
            errors.append(f"program fields (MAST): {e}")
    rel_fields: dict[int, Counter] = defaultdict(Counter)
    rel_targets: dict[int, set] = defaultdict(set)
    for g in (releases or {}).get("groups", []):
        for f in g.get("fields", []):
            rel_fields[g["pid"]][f] += g["n"]
        rel_targets[g["pid"]].update(g.get("targets", []))

    programs_out = {}
    for pid in sorted(referenced):
        rec = dict(cat_programs.get(pid) or {})
        pg = page_cache.get(str(pid), {})
        if not rec.get("t"):
            mt = mast_titles.get(pid, {})
            rec = {"t": pg.get("t") or mt.get("t", ""), "pi": pg.get("pi") or mt.get("pi", ""),
                   "cy": pg.get("cy"), "ty": pg.get("ty", ""), "eap": pg.get("eap"), "cat": None}
        else:
            for k in ("eap", "cy", "pi"):
                if rec.get(k) in (None, "") and pg.get(k) not in (None, ""):
                    rec[k] = pg[k]
        if pg.get("status"):
            rec["status"] = pg["status"]
        targets = sched_targets.get(pid, set()) | watch_targets.get(pid, set()) | rel_targets.get(pid, set())
        fields = list(dict.fromkeys(mast_fields.get(pid, []) + [f for f, _ in rel_fields[pid].most_common(3)]
                                    + interests.fields_in_text(" ".join([rec.get("t", "")] + sorted(targets)))))
        rec["fields"] = fields[:4]
        rec["tags"] = interests.tags(" ".join([rec.get("t", "")] + sorted(targets)[:30]), rec.get("cat"), rec["fields"])
        programs_out[str(pid)] = {k: v for k, v in rec.items() if v not in (None, "", [])}
    write_json(DATA / "programs.json", {"generated": iso(NOW), "programs": programs_out})
    ok("programs", n=len(programs_out))

    meta = {"generated": iso(NOW), "steps": steps, "errors": errors[:20],
            "sources": {"schedule": SCHEDULE_INDEX, "approved": APPROVED_INDEX,
                        "program": PROGRAM_PAGE.replace("{pid}", ""), "mast": "https://mast.stsci.edu/"}}
    write_json(DATA / "meta.json", meta, compact=False)
    log(f"Done: {len(programs_out)} programs, {len(tracked_list)} tracked, {len(errors)} errors")
    return 0 if not any(not s.get("ok", True) for s in steps.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
