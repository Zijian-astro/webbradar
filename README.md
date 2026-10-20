# WebbRadar

**English** · [简体中文](README.zh-CN.md)

**What JWST is observing right now, and which upcoming observations and data releases matter for your science.**
Out of the box it follows high-redshift galaxies, AGN / black holes and Little Red Dots (LRDs).

A lightweight static page (plain HTML/CSS/JS, no framework, no build step) plus a dependency-free Python fetcher. It is deployed on GitHub Pages and refreshes itself every 6 hours.

Live site: <https://jwst.zijianz.space/>

## Features

- **Observing now**: the visit JWST is executing according to the STScI weekly schedule, with program, PI, instrument/mode, target, parallels, a live progress bar and countdown, and the visits that follow. It also points out the next observation that matches your interests.
- **For you**
  - visits in this week's schedule that match your interests
  - plan windows in the next 30 / 90 / 180 days (Flight Ready / Implementation, from STScI visit status), merged per program
  - programs observed in the last three weeks, with the expected public date from their exclusive access period (EAP)
  - MAST data going public soon or released recently, merged per program
  - ★ watched programs pinned to the top
- **Schedule**: a four-week timeline (coloured by instrument, with matches marked above the blocks) and a searchable table with instrument, interest and calibration filters
- **Releases**: public release dates of all JWST level-3 products (only your interests by default)
- **Programs**: about 230 tracked programs (Cycle ≥ 3, matching LRD / AGN / high-z) with execution progress, next window and next release
- Click any program to see its details (PI/Co-PIs, EAP, visit status, windows, MAST release batches) and links to the STScI program page, visit status, proposal PDF and MAST
- Edit keywords (regular expressions) and weights in the browser, switch between UTC and local time, light and dark themes, and export a calendar (`.ics`)

## Data sources

| Content | Source | Refresh |
|---|---|---|
| Weekly observing schedule | [STScI observing schedules](https://www.stsci.edu/jwst/science-execution/observing-schedules) (text tables) | every run (STScI usually posts the next week on Friday) |
| Program title / PI / cycle / category / EAP | [approved programs](https://www.stsci.edu/jwst/science-execution/approved-programs) lists (GO by cycle, GTO, DDT, joint programs, calibration) and program information pages | lists every 7 days, single pages every 30 days |
| Visit status and plan windows | `jwst-program-info/visits` XML | about every 20 hours per program |
| Public release dates | [MAST API](https://mast.stsci.edu/api/v0/) (`t_obs_release`, calib_level 3, science) | every run |

Caveats:

- The schedule is a plan; ToOs and anomalies can change it.
- Plan windows are planning windows, not scheduled times.
- MAST release dates are the end of the EAP and can change.
- Not affiliated with STScI or NASA.

## Run locally

```bash
python3 scripts/update_data.py
```

The first run takes about 3 minutes; later runs use the cache and take about a minute. Then start a local server from the project folder (`--bind 127.0.0.1` keeps it visible to your computer only):

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open <http://localhost:8000>. Notes:

- Run it inside the project folder. Started from your home folder (`~`), it would share your whole home directory.
- Opening `index.html` directly does not work: browsers block reading JSON from `file://`.

## Deploy your own copy (GitHub Pages)

1. Fork this repository, or push this folder to a new public repository.
2. In the repository, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Push to `main`, or run **Actions → Update data & deploy → Run workflow** once. After that it runs every 6 hours.
4. Visit `https://<user>.github.io/<repository>/`.

The workflow commits fresh data back to `data/`. This also keeps GitHub from disabling the scheduled workflow after 60 days without repository activity.

## Customize your interests

Edit `config/interests.json`; the page and the fetcher share this one file:

- `topics`: case-insensitive regular expressions and a weight for each topic, plus STScI science categories that count directly (`categories`) or are excluded (`exclude_categories`)
- `z_threshold`: when a title mentions "z > N", "z~N", "6 < z < 9", "GN-z11" and so on, N must reach this value to count as high-z (default 4)
- `watch_programs`: extra program IDs whose visit windows the fetcher follows
- `track.min_cycle` / `track.min_score`: which programs get their visit status fetched
- `fields`: deep-field positions (RA/Dec/radius) and target-name keywords, used to tag programs and data with GOODS-S, COSMOS, UDS, Abell 2744 and so on

Relevance score: LRD 3, AGN/BH 2, high-z 2, deep field 1, ★ watched +5. A total of 2 or more counts as "my interests".

The settings button at the top right adjusts keywords and weights in your browser. It only changes highlighting and filters, and is stored locally.

## Files

```
index.html               the page
assets/app.js            rendering, relevance scoring (same rules as the Python), calendar export
assets/style.css         styles (light / dark)
config/interests.json    interests, shared by the page and the fetcher
scripts/update_data.py   fetches STScI / MAST into data/*.json (standard library only)
data/*.json              generated data; data/cache/ holds fetch caches (not published)
.github/workflows/       fetches every 6 hours and deploys to GitHub Pages
```
