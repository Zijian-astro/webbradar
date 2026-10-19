/* WebbRadar — renders the JSON written by scripts/update_data.py. No dependencies, no build step. */
(() => {
  'use strict';

  const DAY = 864e5, HOUR = 36e5, MIN = 6e4;
  const MIN_SCORE = 2;            // "my interests" = at least one of LRD / AGN / High-z (or a watched program)
  const RELOAD_EVERY = 30 * MIN;
  const LINKS = {
    program: pid => `https://www.stsci.edu/jwst-program-info/program/?program=${pid}`,
    visits: pid => `https://www.stsci.edu/jwst-program-info/visits/?program=${pid}`,
    pdf: pid => `https://www.stsci.edu/jwst-program-info/download/jwst/pdf/${pid}/`,
    mast: pid => `https://mast.stsci.edu/search/ui/#/jwst/results?program_id=${pid}`,
  };
  const STATUS = [
    ['Archived', 'var(--accent)'], ['Scheduled', 'var(--field)'], ['Flight Ready', 'var(--hiz)'],
    ['Implementation', 'var(--border-strong)'], ['Skipped', 'var(--danger)'], ['On Hold', 'var(--warn)'],
    ['Pending Submission', 'var(--muted)'], ['Withdrawn', 'var(--eng)'], ['Failed', 'var(--danger)'],
  ];
  const FINISHED = new Set(['archived', 'withdrawn', 'failed - archived', 'failed', 'completed']);
  const INST_LABEL = { nirspec: 'NIRSpec', nircam: 'NIRCam', miri: 'MIRI', niriss: 'NIRISS', fgs: 'FGS / other', eng: 'Engineering' };

  // ------------------------------------------------------------------ small helpers
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uniq = a => [...new Set(a)];
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
  const ext = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const S = {
    cfg: null, meta: null, sched: null, progs: {}, watch: null, rel: null,
    visits: [], flat: [], idx: null, I: null, loadErrors: [],
    prefs: lsGet('webbradar:prefs', {}),
    curId: null,
  };
  S.ui = Object.assign({ tab: 'foryou', obsH: 90, relH: 90, schedQ: '', schedInst: 'all', schedRel: false, schedCal: false,
    schedAll: false, relQ: '', relWhen: 'upcoming', relRel: true, progQ: '', progTopic: 'all', progSort: 'next' }, S.prefs.ui || {});
  const savePrefs = () => { S.prefs.ui = { tab: S.ui.tab, obsH: S.ui.obsH, relH: S.ui.relH, schedRel: S.ui.schedRel, schedCal: S.ui.schedCal, relRel: S.ui.relRel, progSort: S.ui.progSort }; lsSet('webbradar:prefs', S.prefs); };

  // ------------------------------------------------------------------ time
  const useUTC = () => S.prefs.tz !== 'local';
  const fmt = (d, o) => new Intl.DateTimeFormat('en-GB', { ...o, timeZone: useUTC() ? 'UTC' : undefined }).format(d);
  const fmtHM = d => fmt(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const fmtDay = d => fmt(d, { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtDate = d => fmt(d, { day: 'numeric', month: 'short' });
  const fmtDateY = d => fmt(d, { day: 'numeric', month: 'short', year: 'numeric' });
  const dayKey = d => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: useUTC() ? 'UTC' : undefined }).format(d);
  const tzName = () => {
    if (useUTC()) return 'UTC';
    try { return new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName').value; } catch (e) { return 'local'; }
  };
  const span = ms => {
    const m = Math.round(Math.abs(ms) / MIN);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  };
  const rel = (t, now = Date.now()) => {
    const ms = t - now;
    if (Math.abs(ms) < MIN) return 'now';
    return ms > 0 ? `in ${span(ms)}` : `${span(ms)} ago`;
  };
  const utcDay = s => Date.parse(`${s}T00:00:00Z`);
  const todayUTC = () => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); };
  const relDays = s => {
    const d = Math.round((utcDay(s) - todayUTC()) / DAY);
    if (d === 0) return 'today';
    if (d === 1) return 'tomorrow';
    if (d === -1) return 'yesterday';
    return d > 0 ? `in ${d} d` : `${-d} d ago`;
  };
  const fmtDayStr = s => new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', timeZone: 'UTC', ...(s.slice(0, 4) !== String(new Date().getUTCFullYear()) ? { year: 'numeric' } : {}),
  }).format(utcDay(s));
  const fmtWin = w => w ? (w[0] === w[1] ? fmtDayStr(w[0]) : `${fmtDayStr(w[0])} – ${fmtDayStr(w[1])}`) : '';
  const winRel = w => {
    const a = Math.round((utcDay(w[0]) - todayUTC()) / DAY), b = Math.round((utcDay(w[1]) - todayUTC()) / DAY);
    if (a > 0) return a === 1 ? 'opens tomorrow' : `opens in ${a} d`;
    return b <= 0 ? 'closes today' : `open · closes in ${b} d`;
  };
  // Midnight boundaries in the display time zone (UTC or local).
  const nextMidnight = t => {
    const d = new Date(t);
    return useUTC() ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  };
  const addMonths = (t, m) => { const d = new Date(t); d.setUTCMonth(d.getUTCMonth() + m); return d; };

  // ------------------------------------------------------------------ instruments & modes
  const instOf = mode => {
    const m = (mode || '').toUpperCase();
    if (!m) return 'eng';
    if (m.includes('WFSC')) return 'fgs';
    if (m.includes('NIRSPEC')) return 'nirspec';
    if (m.includes('NIRCAM')) return 'nircam';
    if (m.includes('MIRI')) return 'miri';
    if (m.includes('NIRISS')) return 'niriss';
    return 'fgs';
  };
  const MODE_SHORT = [
    [/MultiObject Spectroscopy/i, 'MOS'], [/Medium Resolution Spectroscopy/i, 'MRS'], [/Low Resolution Spectroscopy/i, 'LRS'],
    [/Wide Field Slitless Spectroscopy/i, 'WFSS'], [/Single-Object Slitless Spectroscopy/i, 'SOSS'], [/Fixed Slit Spectroscopy/i, 'FS'],
    [/IFU Spectroscopy/i, 'IFU'], [/Bright Object Time Series/i, 'BOTS'], [/Aperture Masking Interferometry/i, 'AMI'],
    [/Coronagraphic Imaging/i, 'Coron'], [/Grism Time Series/i, 'Grism TSO'], [/Time Series Observation/i, 'TSO'],
  ];
  const short = mode => MODE_SHORT.reduce((s, [rx, r]) => s.replace(rx, r), mode || '');
  const modeHTML = (mode, extra = '') => `<span class="mode inst ${instOf(mode)}"><span class="dot"></span>${esc(short(mode) || '—')}${extra}</span>`;
  // MAST instrument_name values, e.g. "NIRSPEC/MSA" -> "NIRSpec MOS"
  const MAST_INST = { NIRSPEC: 'NIRSpec', NIRCAM: 'NIRCam', MIRI: 'MIRI', NIRISS: 'NIRISS', FGS: 'FGS' };
  const MAST_MODE = { MSA: 'MOS', IFU: 'IFU', SLIT: 'FS', IMAGE: 'Imaging', GRISM: 'WFSS', WFSS: 'WFSS', CORON: 'Coron', SOSS: 'SOSS', AMI: 'AMI', SLITLESS: 'LRS slitless', BOTS: 'BOTS', TARGACQ: 'TA' };
  const mastInst = s => {
    const [i, m] = String(s || '').toUpperCase().split('/');
    const mode = i === 'MIRI' && m === 'IFU' ? 'MRS' : i === 'MIRI' && m === 'SLIT' ? 'LRS' : (MAST_MODE[m] || (m || '').toLowerCase());
    return `${MAST_INST[i] || i} ${mode}`.trim();
  };

  // ------------------------------------------------------------------ interests (mirrors scripts/update_data.py)
  const Z_RX = [
    /\bz\s*(?:[~\u2248>\u2273\u2265=]|&gt;)\s*(\d{1,2}(?:\.\d+)?)/gi,
    /(\d{1,2}(?:\.\d+)?)\s*(?:<|\u2272|\u2264|&lt;)\s*z\b/gi,
    /(?:^|[^a-z0-9])z[-_]?(\d{1,2}(?:\.\d+)?)(?![0-9])/gi,
    /\bredshifts?\s+(?:of\s+)?(\d{1,2}(?:\.\d+)?)/gi,
  ];
  const maxZ = text => {
    let best = -1;
    for (const rx of Z_RX) { rx.lastIndex = 0; let m; while ((m = rx.exec(text || ''))) best = Math.max(best, parseFloat(m[1])); }
    return best;
  };
  const toRx = p => { try { return new RegExp(p, 'i'); } catch (e) { return null; } };

  function compileInterests() {
    const cfg = S.cfg || { topics: [] };
    const over = S.prefs.topics || {};
    const topics = cfg.topics.map(t => {
      const o = over[t.key] || {};
      const patterns = Array.isArray(o.patterns) ? o.patterns : t.patterns;
      return {
        key: t.key, label: t.label, weight: Number.isFinite(o.weight) ? o.weight : (t.weight ?? 1), enabled: o.enabled !== false,
        patterns, rx: patterns.map(toRx).filter(Boolean), cats: new Set(t.categories || []), excl: new Set(t.exclude_categories || []),
      };
    });
    const fields = (cfg.fields || []).map(f => ({
      name: f.name, rx: (f.tokens || []).length ? toRx(`(?:^|[^a-z0-9])(?:${f.tokens.join('|')})(?![a-z0-9])`) : null,
    }));
    S.I = {
      topics, fields, byKey: Object.fromEntries(topics.map(t => [t.key, t])),
      zth: Number.isFinite(S.prefs.z) ? S.prefs.z : (cfg.z_threshold ?? 4),
      watch: new Set([...(cfg.watch_programs || []), ...(S.prefs.watch || [])].map(Number)),
    };
    S.memo = new Map();
  }

  function tagsFor(text, cat, fields) {
    const out = [];
    for (const t of S.I.topics) {
      if (!t.enabled) continue;
      if (cat && t.cats.has(cat)) { out.push(t.key); continue; }
      if (cat && t.excl.has(cat)) continue;
      if (t.rx.some(r => r.test(text))) out.push(t.key);
    }
    const hiz = S.I.byKey.hiz;
    if (hiz && hiz.enabled && !out.includes('hiz') && !(cat && hiz.excl.has(cat)) && maxZ(text) >= S.I.zth) out.push('hiz');
    const fld = S.I.byKey.field;
    if (fields && fields.length && fld && fld.enabled && !out.includes('field')) out.push('field');
    return out;
  }
  const fieldsInText = text => S.I.fields.filter(f => f.rx && f.rx.test(text || '')).map(f => f.name);
  const score = tags => tags.reduce((s, k) => s + (k === 'watch' ? 5 : (S.I.byKey[k]?.weight || 0)), 0);
  const isWatched = pid => S.I.watch.has(Number(pid));

  function progTags(pid) {
    const key = `p${pid}`;
    if (S.memo.has(key)) return S.memo.get(key);
    const p = S.progs[pid] || {};
    const targets = [...(S.idx.targets.get(Number(pid)) || [])].sort().slice(0, 30);
    let tags = tagsFor([p.t || '', ...targets].join(' '), p.cat, p.fields);
    if (isWatched(pid)) tags = ['watch', ...tags];
    S.memo.set(key, tags);
    return tags;
  }
  function visitTags(v) {
    const base = v.pid ? progTags(v.pid) : [];
    const own = tagsFor([v.target, v.cat, (v.kw || []).join(', ')].filter(Boolean).join(' '), null, fieldsInText(v.target));
    return uniq([...base, ...own]);
  }
  const relevant = tags => score(tags) >= MIN_SCORE;
  const tagHTML = tags => {
    if (!tags.length) return '';
    const order = ['watch', 'lrd', 'agn', 'hiz', 'field'];
    const sorted = [...tags].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return `<span class="tags">${sorted.map(k => `<span class="tag ${esc(k)}">${k === 'watch' ? '★ watched' : esc(S.I.byKey[k]?.label || k)}</span>`).join('')}</span>`;
  };
  const fieldTags = names => names && names.length ? `<span class="tags">${names.map(n => `<span class="tag field">${esc(n)}</span>`).join('')}</span>` : '';
  const starBtn = pid => `<button class="star${isWatched(pid) ? ' on' : ''}" data-star="${esc(pid)}" title="${isWatched(pid) ? 'Remove from' : 'Add to'} watch list" aria-label="Watch program ${esc(pid)}">${isWatched(pid) ? '★' : '☆'}</button>`;

  // ------------------------------------------------------------------ program helpers
  const P = pid => S.progs[pid] || {};
  const title = pid => P(pid).t || `Program ${pid}`;
  const piShort = pid => {
    const pi = (P(pid).pi || '').trim();
    return pi.includes(',') ? pi.split(',')[0].trim() : (pi.split(/\s+/).slice(-1)[0] || '');
  };
  const progKind = pid => {
    const ty = (P(pid).ty || '').toUpperCase();
    if (ty.startsWith('CAL')) return 'CAL';
    if (ty.startsWith('DD')) return 'DDT';
    if (ty.startsWith('GTO')) return 'GTO';
    return (ty.split(',')[0] || '').trim();
  };
  const pidLabel = pid => `${progKind(pid)} ${pid}`.trim();
  const eapText = pid => { const e = P(pid).eap; return e === 0 ? 'no EAP (public immediately)' : (e ? `${e}-mo EAP` : ''); };

  // ------------------------------------------------------------------ data loading
  async function getJSON(path) {
    const bust = Math.floor(Date.now() / (10 * MIN));
    const res = await fetch(`${path}?v=${bust}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  async function load() {
    const names = ['config/interests.json', 'data/meta.json', 'data/schedule.json', 'data/programs.json', 'data/watch.json', 'data/releases.json'];
    const res = await Promise.allSettled(names.map(getJSON));
    S.loadErrors = res.map((r, i) => r.status === 'rejected' ? `${names[i]} (${r.reason && r.reason.message || r.reason})` : null).filter(Boolean);
    const val = i => res[i].status === 'fulfilled' ? res[i].value : null;
    S.cfg = val(0) || S.cfg || { topics: [] };
    S.meta = val(1) || S.meta;
    S.sched = val(2) || S.sched;
    S.progs = (val(3) || {}).programs || S.progs || {};
    S.watch = val(4) || S.watch;
    S.rel = val(5) || S.rel;
    prepare();
  }

  function prepare() {
    compileInterests();
    const visits = [];
    const flat = [];
    for (const v of (S.sched?.visits || [])) {
      const t0 = Date.parse(v.start), t1 = t0 + (v.dur || 0) * 1000;
      const kind = /MOMENTUM/i.test(v.type) || !v.mode ? 'eng'
        : (/WFSC|UNTARGETED/i.test(v.type) || v.cat === 'Calibration' || progKind(v.pid) === 'CAL') ? 'cal' : 'sci';
      const vv = { ...v, t0, t1, inst: kind === 'eng' ? 'eng' : instOf(v.mode), kind };
      visits.push(vv);
      flat.push(vv);
      for (const p of v.par || []) {
        if (p.pid && /PURE/i.test(p.type)) flat.push({ ...p, t0, t1, inst: instOf(p.mode), kind: 'sci', parallel: true, prime: v.id });
      }
    }
    S.visits = visits;
    S.flat = flat;
    const idx = { targets: new Map(), sched: new Map(), wv: new Map(), rel: new Map() };
    const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    const addT = (pid, t) => { if (!pid || !t) return; if (!idx.targets.has(pid)) idx.targets.set(pid, new Set()); idx.targets.get(pid).add(t); };
    for (const v of flat) { if (v.pid) { add(idx.sched, v.pid, v); addT(v.pid, v.target); } }
    for (const v of (S.watch?.visits || [])) { add(idx.wv, v.pid, v); (v.targets || []).forEach(t => addT(v.pid, t)); }
    for (const g of (S.rel?.groups || [])) { add(idx.rel, g.pid, g); (g.targets || []).forEach(t => addT(g.pid, t)); }
    S.idx = idx;
    for (const v of flat) { v.tags = visitTags(v); v.score = score(v.tags); }
  }

  // ------------------------------------------------------------------ now card
  function nowState(now = Date.now()) {
    const vs = S.visits;
    let cur = null, prev = null;
    const next = [];
    for (const v of vs) {
      if (v.t0 <= now && now < v.t1) cur = v;
      else if (v.t1 <= now) prev = v;
      else if (v.t0 > now) next.push(v);
    }
    return { cur, prev, next };
  }

  function groupRuns(list, max) {
    const out = [];
    for (const v of list) {
      const last = out[out.length - 1];
      if (last && last.pid === v.pid && last.mode === v.mode && last.kind !== 'sci' && v.kind !== 'sci') { last.n++; last.t1 = v.t1; continue; }
      if (out.length >= max) break;
      out.push({ ...v, n: 1 });
    }
    return out;
  }

  function renderNow() {
    const main = $('#nowMain'), side = $('#nowSide');
    if (!S.visits.length) {
      main.innerHTML = `<div class="live idle"><span class="pulse"></span>No schedule data</div><p class="muted">Run <code>python3 scripts/update_data.py</code> to fetch the STScI schedules.</p>`;
      side.innerHTML = '';
      return;
    }
    const now = Date.now();
    const { cur, prev, next } = nowState(now);
    S.curId = cur ? cur.id : null;
    const lastEnd = S.visits[S.visits.length - 1].t1;
    let html = '';
    if (cur) {
      const pid = cur.pid;
      const tags = cur.tags;
      const kindLabel = cur.kind === 'cal' ? ' · calibration' : cur.kind === 'eng' ? ' · engineering' : '';
      const coord = (cur.par || []).filter(p => !p.id);
      const pure = (cur.par || []).filter(p => p.id && /PURE/i.test(p.type));
      const calPar = (cur.par || []).filter(p => p.id && !/PURE/i.test(p.type));
      const fields = uniq([...(P(pid).fields || []), ...fieldsInText(cur.target)]);
      html += `<div class="now-head"><span class="live"><span class="pulse"></span>Observing now${esc(kindLabel)}</span><span class="now-visit">visit ${esc(cur.id)} · ${esc(cur.type.toLowerCase())}</span></div>
        <h1 class="now-title"><span class="pid">${esc(pidLabel(pid))}</span><a href="#" data-pid="${esc(pid)}">${esc(title(pid))}</a></h1>
        <div class="tags-row">${tagHTML(tags)}</div>
        <div class="now-meta">${P(pid).pi ? `<span>PI <b>${esc(P(pid).pi)}</b></span>` : ''}${P(pid).cy ? `<span>Cycle ${esc(P(pid).cy)}</span>` : ''}${eapText(pid) ? `<span>${esc(eapText(pid))}</span>` : ''}${P(pid).cat ? `<span>${esc(P(pid).cat)}</span>` : ''}</div>
        <dl class="kv">
          <dt>Instrument</dt><dd>${modeHTML(cur.mode)}${coord.map(p => ` <span class="muted">+</span> ${modeHTML(p.mode, ' <span class="muted">(coord. parallel)</span>')}`).join('')}</dd>
          <dt>Target</dt><dd><span class="mono">${esc(cur.target || '—')}</span> ${fieldTags(fields)}</dd>
          ${cur.cat || (cur.kw || []).length ? `<dt>Keywords</dt><dd>${esc([cur.cat, ...(cur.kw || [])].filter(Boolean).join(' · '))}</dd>` : ''}
          ${pure.length ? `<dt>Pure parallel</dt><dd>${pure.map(p => `<a href="#" data-pid="${esc(p.pid)}" class="pid">${esc(p.pid)}</a> ${esc(title(p.pid))} · ${modeHTML(p.mode)} ${tagHTML(progTags(p.pid))}`).join('<br>')}</dd>` : ''}
          ${calPar.length ? `<dt>Calibration</dt><dd class="muted small">${esc(uniq(calPar.map(p => short(p.mode))).join(', '))} (attached parallels)</dd>` : ''}
        </dl>
        <div class="progress"><i data-prog style="width:${Math.min(100, (now - cur.t0) / (cur.t1 - cur.t0) * 100).toFixed(2)}%"></i></div>
        <div class="progress-legend"><span>started <b>${esc(fmtHM(cur.t0))}</b> · <span data-rel="${cur.t0}">${esc(rel(cur.t0, now))}</span></span><span>${esc(span(cur.t1 - cur.t0))}</span><span>ends <b>${esc(fmtHM(cur.t1))}</b> · <span data-rel="${cur.t1}">${esc(rel(cur.t1, now))}</span></span></div>
        <div class="links">${pid ? `<a href="${LINKS.program(pid)}" target="_blank" rel="noopener">Program ${ext}</a><a href="${LINKS.visits(pid)}" target="_blank" rel="noopener">Visit status ${ext}</a><a href="${LINKS.pdf(pid)}" target="_blank" rel="noopener">Proposal PDF ${ext}</a><a href="${LINKS.mast(pid)}" target="_blank" rel="noopener">MAST ${ext}</a><button data-star="${esc(pid)}">${isWatched(pid) ? '★ Watching' : '☆ Watch'}</button>` : ''}</div>`;
    } else if (now >= lastEnd) {
      html += `<div class="live idle"><span class="pulse"></span>Schedule data has run out</div>
        <h1 class="now-title">The loaded schedule ended ${esc(rel(lastEnd, now))}</h1>
        <p class="muted">The weekly STScI schedule is usually posted on Fridays. Refresh the data (<code>python3 scripts/update_data.py</code>, or wait for the next automatic update).</p>`;
    } else {
      const nx = next[0];
      html += `<div class="live idle"><span class="pulse"></span>Between visits · slewing / overheads</div>
        <h1 class="now-title">Next: <a href="#" data-pid="${esc(nx.pid)}">${esc(title(nx.pid))}</a></h1>
        <div class="now-meta"><span>${modeHTML(nx.mode)}</span><span class="mono">${esc(nx.target || '')}</span><span>starts <b>${esc(fmtHM(nx.t0))}</b> · <span data-rel="${nx.t0}">${esc(rel(nx.t0, now))}</span></span></div>
        ${prev ? `<p class="muted small">Previous: ${esc(prev.id)} ${esc(short(prev.mode))} ended ${esc(rel(prev.t1, now))}.</p>` : ''}`;
    }
    main.innerHTML = html;

    // Up next
    const items = groupRuns(next, 7);
    const nextRel = S.flat.filter(v => v.pid && v.kind === 'sci' && v.t0 > now && relevant(v.tags)).sort((a, b) => a.t0 - b.t0)[0];
    side.innerHTML = `<div class="side-title">Up next · ${esc(tzName())}</div>
      <ul class="next-list">${items.map(v => `<li data-pid="${esc(v.pid)}" title="${esc(v.id)} · ${esc(v.target || '')}">
        <span class="when">${esc(dayKey(v.t0) === dayKey(now) ? fmtHM(v.t0) : `${fmtDate(v.t0)} ${fmtHM(v.t0)}`)}</span>
        <span class="t">${v.kind === 'sci' ? `${relevant(v.tags) ? '<span class="dot" style="--c:var(--accent);margin-right:6px"></span>' : ''}<span class="pid">${esc(v.pid)}</span> ${esc(title(v.pid))}` : `<span class="muted">${esc(short(v.mode) || v.type.toLowerCase())}${v.n > 1 ? ` ×${v.n}` : ''}</span>`}</span>
        <span class="d">${esc(short(v.mode))}</span></li>`).join('')}</ul>
      ${nextRel ? `<div class="callout" data-pid="${esc(nextRel.pid)}"><b>Next on your radar</b> · <span data-rel="${nextRel.t0}">${esc(rel(nextRel.t0, now))}</span><br>${esc(nextRel.pid)} · ${esc(title(nextRel.pid))}<br><span class="muted">${esc(short(nextRel.mode))}${nextRel.parallel ? ' (pure parallel)' : ''} · ${esc(fmtDay(nextRel.t0))} ${esc(fmtHM(nextRel.t0))}</span></div>` : ''}`;
    document.title = cur && cur.pid ? `● ${cur.pid} ${short(cur.mode)} · WebbRadar` : 'WebbRadar · What JWST is observing now';
  }

  function tick() {
    const now = Date.now();
    $('#clock').textContent = `${fmt(now, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })} ${tzName()}`;
    const { cur } = nowState(now);
    if ((cur ? cur.id : null) !== S.curId) { renderNow(); return; }
    $$('[data-rel]').forEach(el => { el.textContent = rel(Number(el.dataset.rel), now); });
    const bar = $('[data-prog]');
    if (bar && cur) bar.style.width = `${Math.min(100, (now - cur.t0) / (cur.t1 - cur.t0) * 100).toFixed(2)}%`;
  }

  // ------------------------------------------------------------------ for you
  function itemHTML({ pid, whenHTML, line2, tags, extraTitle = '' }) {
    return `<div class="item" data-pid="${esc(pid)}">
      <div class="when">${whenHTML}</div>
      <div><div class="line1">${starBtn(pid)}<span class="pid">${esc(pid)}</span><span class="title">${esc(title(pid))}${extraTitle}</span></div>
      <div class="line2">${tagHTML(tags)}${line2.filter(Boolean).map((x, i) => `<span${i || tags.length ? ' class="sep"' : ''}>${x}</span>`).join('')}</div></div>
    </div>`;
  }

  function renderForYou() {
    const now = Date.now();
    const H = S.ui.obsH;
    // A. scheduled this week (relevant)
    const sched = S.flat.filter(v => v.pid && v.kind === 'sci' && v.t1 > now - 6 * HOUR && relevant(v.tags));
    const runs = [];
    for (const v of sched.sort((a, b) => a.t0 - b.t0)) {
      const last = runs.find(r => r.pid === v.pid && r.obs === v.obs && r.mode === v.mode && v.t0 - r.t1 < 2 * DAY);
      if (last) { last.n++; last.t1 = Math.max(last.t1, v.t1); last.hours += (v.t1 - v.t0) / HOUR; last.cur = last.cur || (v.t0 <= now && now < v.t1); last.targets.add(v.target); continue; }
      runs.push({ ...v, n: 1, hours: (v.t1 - v.t0) / HOUR, cur: v.t0 <= now && now < v.t1, targets: new Set([v.target]) });
    }
    const schedKeys = new Set(S.flat.filter(v => v.pid).map(v => `${v.pid}:${v.obs}:${v.visit}`));
    // B. plan windows, one row per program (its earliest window in the horizon)
    const t0 = todayUTC(), tH = t0 + H * DAY;
    const wins = new Map();
    for (const v of (S.watch?.visits || [])) {
      const st = (v.status || '').toLowerCase();
      if (FINISHED.has(st) || st === 'scheduled' || schedKeys.has(`${v.pid}:${v.obs}:${v.visit}`)) continue;
      const tags = progTags(v.pid);
      if (!relevant(tags)) continue;
      const w = (v.windows || []).find(x => utcDay(x[1]) >= t0 && utcDay(x[0]) <= tH);
      if (!w) continue;
      const g = wins.get(v.pid) || { pid: v.pid, ws: new Map(), n: 0, hours: 0, modes: new Set(), targets: new Set(), status: new Set(), tags };
      g.ws.set(w.join('|'), w); g.n++; g.hours += v.hours || 0;
      (v.modes || []).forEach(m => g.modes.add(m)); (v.targets || []).forEach(t => g.targets.add(t)); g.status.add(v.status);
      wins.set(v.pid, g);
    }
    const winList = [...wins.values()].map(g => {
      const ws = [...g.ws.values()].sort((a, b) => a[0].localeCompare(b[0]));
      return { ...g, w: ws[0], more: ws.length - 1, lastEnd: ws.reduce((m, x) => (x[1] > m ? x[1] : m), ws[0][1]) };
    }).sort((a, b) => a.w[0].localeCompare(b.w[0]) || score(b.tags) - score(a.tags));
    // C. just observed
    const past = new Map();
    const addPast = (pid, t, mode, target) => {
      const g = past.get(pid) || { pid, t: 0, n: 0, modes: new Set(), targets: new Set() };
      g.t = Math.max(g.t, t); g.n++; if (mode) g.modes.add(mode); if (target) g.targets.add(target);
      past.set(pid, g);
    };
    for (const v of S.flat) if (v.pid && v.kind === 'sci' && v.t1 <= now && v.t1 > now - 21 * DAY && relevant(v.tags)) addPast(v.pid, v.t1, v.mode, v.target);
    for (const v of (S.watch?.visits || [])) {
      if (!(v.status || '').toLowerCase().startsWith('archived')) continue;
      const t = Date.parse(v.end || v.start);
      if (!(t > now - 21 * DAY) || !relevant(progTags(v.pid)) || schedKeys.has(`${v.pid}:${v.obs}:${v.visit}`)) continue;
      addPast(v.pid, t, (v.modes || [])[0], (v.targets || [])[0]);
    }
    const pastList = [...past.values()].sort((a, b) => b.t - a.t);

    let html = '';
    if (S.I.watch.size) {
      const watched = [...S.I.watch].map(pid => ({ pid, ...progSummary(pid) })).sort((a, b) => a.next - b.next);
      html += `<div class="group-h">★ Watched <span class="count">${watched.length}</span></div>`;
      html += watched.map(r => {
        const w = r.w;
        let when = '<span class="muted">—</span>', what = '';
        if (r.sched) { when = `${esc(fmtDay(r.sched.t0))}<br>${esc(fmtHM(r.sched.t0))}<span class="rel" data-rel="${r.sched.t0}">${esc(rel(r.sched.t0, now))}</span>`; what = `scheduled · ${modeHTML(r.sched.mode)}`; }
        else if (w?.next_window) { when = `${esc(fmtWin(w.next_window))}<span class="rel">${esc(winRel(w.next_window))}</span>`; what = 'next plan window'; }
        else if (w?.done) what = 'all visits executed';
        else if (!w) what = 'visit windows not tracked on the server (add the ID to config/interests.json)';
        return itemHTML({ pid: r.pid, whenHTML: when, tags: progTags(r.pid),
          line2: [what, r.rel ? `data public ${esc(fmtDayStr(r.rel.date))} (${esc(relDays(r.rel.date))})` : ''] });
      }).join('');
    }
    html += `<div class="group-h">Scheduled · this week <span class="count">${runs.length}</span></div>`;
    html += runs.length ? runs.map(r => itemHTML({
      pid: r.pid,
      whenHTML: `<span class="${r.cur ? 'now' : ''}">${esc(fmtDay(r.t0))}<br>${esc(fmtHM(r.t0))}${dayKey(r.t1) !== dayKey(r.t0) ? ` → ${esc(fmtDate(r.t1))}` : ''}</span><span class="rel">${r.cur ? '● observing now' : `<span data-rel="${r.t0}">${esc(rel(r.t0, now))}</span>`}</span>`,
      tags: r.tags,
      line2: [modeHTML(r.mode), `<span class="mono">${esc([...r.targets].filter(Boolean).slice(0, 2).join(', ') || '—')}</span>`,
        `${r.n} visit${r.n > 1 ? 's' : ''} · ${r.hours.toFixed(1)} h`, r.parallel ? 'pure parallel' : '', esc(piShort(r.pid))],
    })).join('') : `<div class="empty">Nothing matching your interests in the current weekly schedule.</div>`;

    html += `<div class="group-h">Plan windows · next ${H} days <span class="count">${winList.length} programs</span></div>`;
    const showW = S.ui.obsAllW ? winList : winList.slice(0, 20);
    html += winList.length ? showW.map(g => itemHTML({
      pid: g.pid,
      whenHTML: `${esc(fmtWin(g.w))}<span class="rel">${esc(winRel(g.w))}</span>`,
      tags: g.tags,
      line2: [[...g.modes].slice(0, 2).map(m => modeHTML(m)).join(' '), `<span class="mono">${esc([...g.targets].slice(0, 2).join(', '))}${g.targets.size > 2 ? ` +${g.targets.size - 2}` : ''}</span>`,
        `${g.n} visit${g.n > 1 ? 's' : ''} · ${g.hours.toFixed(1)} h`, g.more ? `+${g.more} more window${g.more > 1 ? 's' : ''} to ${esc(fmtDayStr(g.lastEnd))}` : '', statusTags([...g.status])],
    })).join('') : `<div class="empty">No plan windows in the next ${H} days for tracked programs.</div>`;
    if (winList.length > showW.length) html += `<button class="more-btn" data-act="obsAllW">Show all ${winList.length} programs</button>`;

    html += `<div class="group-h">Just observed · last 3 weeks <span class="count">${pastList.length}</span></div>`;
    html += pastList.length ? pastList.slice(0, 12).map(g => {
      const eap = P(g.pid).eap;
      const pub = eap != null ? addMonths(g.t, eap) : null;
      return itemHTML({
        pid: g.pid,
        whenHTML: `${esc(fmtDate(g.t))}<span class="rel">${esc(rel(g.t, now))}</span>`,
        tags: progTags(g.pid),
        line2: [[...g.modes].slice(0, 2).map(m => modeHTML(m)).join(' '), `<span class="mono">${esc([...g.targets].slice(0, 2).join(', '))}</span>`,
          `${g.n} visit${g.n > 1 ? 's' : ''}`, pub ? (eap === 0 ? 'public now' : `public ≈ ${esc(fmtDateY(pub))}`) : ''],
      });
    }).join('') : `<div class="empty">Nothing relevant observed in the last three weeks.</div>`;
    $('#obsBody').innerHTML = html;

    // Releases
    const R = S.ui.relH;
    const groups = (S.rel?.groups || []).filter(g => relevant(progTags(g.pid)));
    const upcoming = byProgram(groups.filter(g => utcDay(g.date) >= t0 && utcDay(g.date) <= t0 + R * DAY));
    const recent = byProgram(groups.filter(g => utcDay(g.date) < t0).reverse());
    let rh = `<div class="group-h">Going public · next ${R >= 200 ? 'months' : `${R} days`} <span class="count">${upcoming.length} programs</span></div>`;
    const showU = S.ui.relAllU ? upcoming : upcoming.slice(0, 20);
    rh += upcoming.length ? showU.map(g => relItem(g)).join('') : `<div class="empty">No releases from matching programs in this window.</div>`;
    if (upcoming.length > showU.length) rh += `<button class="more-btn" data-act="relAllU">Show all ${upcoming.length} programs</button>`;
    rh += `<div class="group-h">Recently public <span class="count">${recent.length} programs</span></div>`;
    const showR = S.ui.relAllR ? recent : recent.slice(0, 8);
    rh += recent.length ? showR.map(g => relItem(g)).join('') : `<div class="empty">Nothing in the last ${S.rel ? 45 : 0} days.</div>`;
    if (recent.length > showR.length) rh += `<button class="more-btn" data-act="relAllR">Show all ${recent.length} programs</button>`;
    $('#relBody').innerHTML = rh;
  }

  function statusTags(list) {
    return list.map(s => {
      const cls = /flight ready/i.test(s) ? 'status-fr' : /sched/i.test(s) ? 'status-sched' : /skip|hold|fail/i.test(s) ? 'status-warn' : 'plain';
      return `<span class="tag ${cls}">${esc(s)}</span>`;
    }).join(' ');
  }

  // Observation dates always carry the year: a release on 19 Oct is usually data from the previous October.
  const fmtDayY = s => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(utcDay(s));
  const obsRange = o => !o || !o[0] ? '' : (o[0] === o[1] ? fmtDayY(o[0])
    : `${o[0].slice(0, 4) === o[1].slice(0, 4) ? fmtDayStr(o[0]).replace(/ \d{4}$/, '') : fmtDayY(o[0])} – ${fmtDayY(o[1])}`);

  // Merge a program's release groups (input already in display order) into one row; the first date leads.
  function byProgram(list) {
    const m = new Map();
    for (const g of list) {
      const e = m.get(g.pid);
      if (!e) { m.set(g.pid, { ...g, dates: [g.date], inst: [...g.inst], fields: [...g.fields], targets: [...g.targets], obs: [...(g.obs || [])] }); continue; }
      e.dates.push(g.date);
      e.n += g.n;
      e.inst = uniq([...e.inst, ...g.inst]);
      e.fields = uniq([...e.fields, ...g.fields]);
      e.targets = uniq([...e.targets, ...g.targets]);
      e.ntargets = Math.max(e.ntargets + g.ntargets, e.targets.length);
      if (g.obs && g.obs[0]) e.obs = [e.obs[0] && e.obs[0] < g.obs[0] ? e.obs[0] : g.obs[0], e.obs[1] && e.obs[1] > g.obs[1] ? e.obs[1] : g.obs[1]];
    }
    return [...m.values()];
  }

  function relItem(g) {
    const obs = obsRange(g.obs);
    const more = (g.dates || []).length - 1;
    const sorted = (g.dates || []).slice().sort();
    const past = more > 0 && g.dates[0] > g.dates[1];   // "recently public" lists newest first
    const edge = past ? sorted[0] : sorted[sorted.length - 1];
    return itemHTML({
      pid: g.pid,
      whenHTML: `${esc(fmtDayStr(g.date))}<span class="rel">${esc(relDays(g.date))}</span>`,
      tags: progTags(g.pid),
      line2: [g.inst.slice(0, 2).map(i => modeHTML(mastInst(i))).join(' '), `${g.n} product${g.n > 1 ? 's' : ''}`,
        g.fields.length ? fieldTags(g.fields) : `<span class="mono">${esc(g.targets.slice(0, 2).join(', '))}${g.ntargets > 2 ? ` +${g.ntargets - 2}` : ''}</span>`,
        more > 0 ? `+${more} more date${more > 1 ? 's' : ''} ${past ? 'back to' : 'to'} ${esc(fmtDayStr(edge))}` : '',
        obs ? `observed ${esc(obs)}` : '', esc(piShort(g.pid))],
    });
  }

  // ------------------------------------------------------------------ schedule tab
  function schedFilter(v) {
    if (!S.ui.schedCal && v.kind !== 'sci') return false;
    if (S.ui.schedInst !== 'all' && v.inst !== S.ui.schedInst && !(v.par || []).some(p => instOf(p.mode) === S.ui.schedInst)) return false;
    if (S.ui.schedRel && !relevant(v.tags) && !(v.par || []).some(p => p.pid && relevant(progTags(p.pid)))) return false;
    const q = S.ui.schedQ.trim().toLowerCase();
    if (q) {
      const hay = [v.id, v.pid, title(v.pid), P(v.pid).pi, v.target, v.mode, v.cat, (v.kw || []).join(' '),
        ...(v.par || []).map(p => `${p.pid || ''} ${p.mode} ${p.pid ? title(p.pid) : ''}`)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function renderSchedule() {
    const now = Date.now();
    const vs = S.visits;
    if (!vs.length) { $('#schedBody').innerHTML = `<div class="empty" style="padding:18px">No schedule loaded.</div>`; $('#timeline').innerHTML = ''; return; }
    const files = S.sched.files || [];
    $('#schedSub').innerHTML = `STScI weekly schedules ${files.map(f => `<a href="${esc(f.url)}" target="_blank" rel="noopener" class="mono">${esc(f.week)}</a>`).join(' · ')} · times in ${esc(tzName())}`;
    // timeline
    const start = Math.min(...vs.map(v => v.t0)), end = Math.max(...vs.map(v => v.t1));
    const W = end - start;
    const x = t => ((t - start) / W * 100).toFixed(3);
    const shown = vs.filter(schedFilter);
    const shownIds = new Set(shown.map(v => v.id));
    let tl = '';
    let firstDay = true;
    for (let t = nextMidnight(start); t < end; t = nextMidnight(t)) {
      const monday = fmt(t, { weekday: 'short' }) === 'Mon';
      const day = fmt(t, { day: 'numeric' });
      const month = firstDay || day === '1' ? `<em>${esc(fmt(t, { month: 'short' }))}</em>` : '';
      firstDay = false;
      tl += `<div class="tl-day${monday ? ' weekstart' : ''}" style="left:${x(t)}%">${month}<span>${esc(day)}</span></div>`;
    }
    tl += `<div class="tl-lane" style="top:32px;height:30px">${vs.map(v => {
      const hit = relevant(v.tags) && v.kind === 'sci';
      const topTag = ['lrd', 'agn', 'hiz'].find(k => v.tags.includes(k));
      return `<div class="tl-block inst ${v.inst}${shownIds.has(v.id) ? '' : ' dim'}" data-vid="${esc(v.id)}" style="left:${x(v.t0)}%;width:${(Math.max(v.t1 - v.t0, 1) / W * 100).toFixed(3)}%;--c:var(--${v.inst === 'eng' ? 'eng' : v.inst})">${hit && topTag ? `<span class="tl-mark" style="left:0;right:0;background:var(--${topTag})"></span>` : ''}</div>`;
    }).join('')}</div>`;
    tl += `<div class="tl-lane" style="top:68px;height:12px">${vs.filter(v => (v.par || []).some(p => /PURE|COORDINATED/i.test(p.type))).map(v => {
      const p = v.par.find(q => /PURE/i.test(q.type)) || v.par.find(q => /COORDINATED/i.test(q.type));
      const inst = instOf(p.mode);
      return `<div class="tl-block inst ${inst}${shownIds.has(v.id) ? '' : ' dim'}" data-vid="${esc(v.id)}" style="left:${x(v.t0)}%;width:${(Math.max(v.t1 - v.t0, 1) / W * 100).toFixed(3)}%;--c:var(--${inst})"></div>`;
    }).join('')}</div>`;
    if (now >= start && now <= end) tl += `<div class="tl-now" style="left:${x(now)}%"></div>`;
    $('#timeline').innerHTML = tl;
    $('#legend').innerHTML = ['nirspec', 'nircam', 'miri', 'niriss', 'fgs', 'eng'].map(k => `<span><span class="dot" style="--c:var(--${k})"></span>${INST_LABEL[k]}</span>`).join('')
      + `<span><span class="dot" style="--c:var(--hiz)"></span>bar above = matches your interests</span><span class="muted">lower row = parallels</span>`;

    // table
    const cutoff = S.ui.schedAll ? -Infinity : now - 2 * DAY;
    const rows = shown.filter(v => v.t1 >= cutoff);
    const hiddenEarlier = shown.length - rows.length;
    let h = `<table class="rows"><thead><tr><th>Time</th><th class="hide-sm">Dur.</th><th>Program</th><th>Instrument</th><th class="hide-sm">Target</th><th class="hide-sm">Tags</th></tr></thead><tbody>`;
    if (hiddenEarlier > 0) h += `<tr><td colspan="6"><button class="more-btn" data-act="schedAll">Show ${hiddenEarlier} earlier visits</button></td></tr>`;
    let lastDay = '';
    for (const v of rows) {
      const dk = dayKey(v.t0);
      if (dk !== lastDay) { lastDay = dk; h += `<tr class="day"><td colspan="6">${esc(fmtDay(v.t0))}${dk === dayKey(now) ? ' · today' : ''}</td></tr>`; }
      const cur = v.t0 <= now && now < v.t1;
      const pars = (v.par || []).filter(p => /PURE|COORDINATED/i.test(p.type));
      h += `<tr class="v${cur ? ' current' : ''}${v.t1 < now ? ' past' : ''}" data-pid="${esc(v.pid)}" data-vid="${esc(v.id)}">
        <td class="time">${esc(fmtHM(v.t0))}<br><span class="muted">${esc(fmtHM(v.t1))}</span></td>
        <td class="time hide-sm">${esc(span(v.t1 - v.t0))}</td>
        <td class="title-cell"><span class="t"><span class="pid">${esc(v.pid ?? '')}</span> ${esc(v.kind === 'eng' ? (v.type || '').toLowerCase() : title(v.pid))}</span><span class="s mono">${esc(v.id)}${P(v.pid).pi ? ` · ${esc(P(v.pid).pi)}` : ''}</span></td>
        <td class="inst-cell">${modeHTML(v.mode)}${pars.map(p => `<div class="par-line"><span class="muted">+</span> ${modeHTML(p.mode, p.pid ? ` <span class="muted">(${esc(p.pid)})</span>` : '')}</div>`).join('')}</td>
        <td class="hide-sm mono small">${esc(v.target || '')}${fieldsInText(v.target).length ? `<br>${fieldTags(fieldsInText(v.target))}` : ''}</td>
        <td class="hide-sm">${tagHTML(v.tags)}</td></tr>`;
    }
    if (!rows.length) h += `<tr><td colspan="6" class="empty" style="padding:18px">No visits match the filters.</td></tr>`;
    h += '</tbody></table>';
    $('#schedBody').innerHTML = h;
  }

  // ------------------------------------------------------------------ releases tab
  function renderReleases() {
    const t0 = todayUTC();
    const q = S.ui.relQ.trim().toLowerCase();
    let groups = (S.rel?.groups || []).slice();
    groups = S.ui.relWhen === 'upcoming' ? groups.filter(g => utcDay(g.date) >= t0) : groups.filter(g => utcDay(g.date) < t0).reverse();
    if (S.ui.relRel) groups = groups.filter(g => relevant(progTags(g.pid)));
    if (q) groups = groups.filter(g => [g.pid, title(g.pid), P(g.pid).pi, ...g.targets, ...g.inst, ...g.fields].join(' ').toLowerCase().includes(q));
    const w = S.rel?.window || [];
    $('#relSub').textContent = `JWST level-3 science products in MAST by public release date (${w[0] || '?'} → ${w[1] || '?'}); ${groups.length} shown`;
    let h = `<table class="rows"><thead><tr><th>Public</th><th>Program</th><th>Instrument</th><th class="num hide-sm">Products</th><th class="hide-sm">Field / targets</th><th class="hide-sm">Observed</th><th class="hide-xs"></th></tr></thead><tbody>`;
    let lastM = '';
    for (const g of groups) {
      const m = g.date.slice(0, 7);
      if (m !== lastM) { lastM = m; h += `<tr class="day"><td colspan="7">${esc(new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utcDay(g.date)))}</td></tr>`; }
      h += `<tr class="v" data-pid="${esc(g.pid)}">
        <td class="time">${esc(fmtDayStr(g.date))}<br><span class="muted">${esc(relDays(g.date))}</span></td>
        <td class="title-cell"><span class="t">${starBtn(g.pid)}<span class="pid">${esc(g.pid)}</span> ${esc(title(g.pid))}</span><span class="s">${esc(P(g.pid).pi || '')}${eapText(g.pid) ? ` · ${esc(eapText(g.pid))}` : ''}</span><span class="s">${tagHTML(progTags(g.pid))}</span></td>
        <td>${g.inst.map(i => modeHTML(mastInst(i))).join('<br>')}</td>
        <td class="num hide-sm">${g.n}</td>
        <td class="hide-sm small">${fieldTags(g.fields)}<span class="mono muted">${esc(g.targets.slice(0, 3).join(', '))}${g.ntargets > 3 ? ` +${g.ntargets - 3}` : ''}</span></td>
        <td class="time hide-sm muted">${esc(obsRange(g.obs))}</td>
        <td class="hide-xs"><a href="${LINKS.mast(g.pid)}" target="_blank" rel="noopener" class="small" data-stop>MAST ${ext}</a></td></tr>`;
    }
    if (!groups.length) h += `<tr><td colspan="7" class="empty" style="padding:18px">No releases match.</td></tr>`;
    $('#relAll').innerHTML = h + '</tbody></table>';
  }

  // ------------------------------------------------------------------ programs tab
  function progSummary(pid) {
    const now = Date.now(), t0 = todayUTC();
    const w = S.watch?.programs?.[pid] || null;
    const sched = (S.idx.sched.get(Number(pid)) || []).filter(v => v.t1 > now).sort((a, b) => a.t0 - b.t0)[0] || null;
    const rel = (S.idx.rel.get(Number(pid)) || []).filter(g => utcDay(g.date) >= t0)[0] || null;
    const cands = [];
    if (sched) cands.push(sched.t0);
    if (w?.next_window) cands.push(Math.max(utcDay(w.next_window[0]), now));
    if (rel) cands.push(utcDay(rel.date));
    return { w, sched, rel, next: cands.length ? Math.min(...cands) : Infinity };
  }

  function renderPrograms() {
    const topics = [['all', 'All'], ['watch', '★ Watched'], ...S.I.topics.filter(t => t.enabled).map(t => [t.key, t.label])];
    $('#progTopic').innerHTML = topics.map(([k, l]) => `<button data-v="${esc(k)}" class="${S.ui.progTopic === k ? 'on' : ''}">${esc(l)}</button>`).join('');
    const tracked = uniq([...(S.watch?.tracked || []), ...S.I.watch].map(Number));
    const q = S.ui.progQ.trim().toLowerCase();
    let list = tracked.map(pid => ({ pid, tags: progTags(pid), ...progSummary(pid) }));
    if (S.ui.progTopic !== 'all') list = list.filter(r => r.tags.includes(S.ui.progTopic));
    if (q) list = list.filter(r => [r.pid, title(r.pid), P(r.pid).pi, P(r.pid).co, (P(r.pid).fields || []).join(' ')].join(' ').toLowerCase().includes(q));
    const sorters = {
      next: (a, b) => a.next - b.next || score(b.tags) - score(a.tags),
      score: (a, b) => score(b.tags) - score(a.tags) || a.next - b.next,
      id: (a, b) => b.pid - a.pid,
    };
    list.sort(sorters[S.ui.progSort] || sorters.next);
    $('#progSub').textContent = `${list.length} of ${tracked.length} programs whose visit status is followed (cycle ≥ ${S.cfg?.track?.min_cycle ?? 3}, matching your interests, plus watched)`;
    let h = `<table class="rows"><thead><tr><th>Program</th><th class="hide-sm">Visits</th><th>Next</th><th class="hide-sm">Data public</th></tr></thead><tbody>`;
    for (const r of list) {
      const p = P(r.pid), w = r.w;
      const counts = w?.counts || {};
      const total = w?.n || 0;
      const bar = total ? STATUS.map(([s, c]) => {
        const n = Object.entries(counts).filter(([k]) => k.toLowerCase().startsWith(s.toLowerCase())).reduce((a, [, v]) => a + v, 0);
        return n ? `<i style="width:${(n / total * 100).toFixed(1)}%;background:${c}" title="${esc(s)}: ${n}"></i>` : '';
      }).join('') : '';
      const done = Object.entries(counts).filter(([k]) => k.toLowerCase().startsWith('archived')).reduce((a, [, v]) => a + v, 0);
      let next = '<span class="muted">—</span>';
      if (r.sched) next = `<span class="tag status-sched">scheduled</span> ${esc(fmtDay(r.sched.t0))} ${esc(fmtHM(r.sched.t0))}<br><span class="muted small">${esc(rel(r.sched.t0))}</span>`;
      else if (w?.next_window) next = `window ${esc(fmtWin(w.next_window))}<br><span class="muted small">${esc(winRel(w.next_window))}</span>`;
      else if (w?.done) next = `<span class="muted">completed</span>`;
      else if (!w) next = `<span class="muted small">not fetched yet</span>`;
      h += `<tr class="v" data-pid="${esc(r.pid)}">
        <td class="title-cell"><span class="t">${starBtn(r.pid)}<span class="pid">${esc(r.pid)}</span> ${esc(title(r.pid))}</span>
          <span class="s">${esc([p.pi, p.cy ? `Cycle ${p.cy}` : '', progKind(r.pid), eapText(r.pid)].filter(Boolean).join(' · '))}</span>
          <span class="s">${tagHTML(r.tags)} ${fieldTags(p.fields || [])}</span></td>
        <td class="hide-sm"><div class="bar">${bar}</div><span class="small muted mono">${total ? `${done}/${total} archived` : '—'}</span></td>
        <td class="small">${next}</td>
        <td class="small hide-sm">${r.rel ? `${esc(fmtDayStr(r.rel.date))}<br><span class="muted">${esc(relDays(r.rel.date))}</span>` : '<span class="muted">—</span>'}</td></tr>`;
    }
    if (!list.length) h += `<tr><td colspan="4" class="empty" style="padding:18px">No programs match.</td></tr>`;
    $('#progBody').innerHTML = h + '</tbody></table>';
  }

  // ------------------------------------------------------------------ program drawer
  function openProgram(pid) {
    pid = Number(pid);
    if (!pid) return;
    const p = P(pid), now = Date.now();
    const tags = progTags(pid);
    const sched = (S.idx.sched.get(pid) || []).slice().sort((a, b) => a.t0 - b.t0);
    const wv = (S.idx.wv.get(pid) || []).slice();
    const rels = (S.idx.rel.get(pid) || []).slice();
    const w = S.watch?.programs?.[pid];
    const tracked = (S.watch?.tracked || []).includes(pid);
    let h = `<div class="mono small muted">${esc(pidLabel(pid))}${p.cy ? ` · Cycle ${esc(p.cy)}` : ''}${p.cat ? ` · ${esc(p.cat)}` : ''}</div>
      <h3 id="drawerTitle">${esc(title(pid))}</h3>
      <div>${tagHTML(tags)} ${fieldTags(p.fields || [])}</div>
      <dl class="kv" style="margin-top:14px">
        ${p.pi ? `<dt>PI</dt><dd>${esc(p.pi)}${p.co ? `<br><span class="muted small">Co-PIs: ${esc(p.co)}</span>` : ''}</dd>` : ''}
        ${p.eap != null ? `<dt>Access</dt><dd>${esc(eapText(pid))}</dd>` : ''}
        ${p.hrs ? `<dt>Time</dt><dd class="mono small">${esc(p.hrs)} h (prime/parallel)</dd>` : ''}
        ${(p.inst || []).length ? `<dt>Modes</dt><dd>${p.inst.map(i => modeHTML(i.replace('/', ' '))).join(' ')}</dd>` : ''}
        ${(p.fields || []).length ? `<dt>Fields</dt><dd>${esc(p.fields.join(', '))}</dd>` : ''}
        ${p.status ? `<dt>Status</dt><dd>${esc(p.status)}</dd>` : ''}
      </dl>
      <div class="links"><a href="${LINKS.program(pid)}" target="_blank" rel="noopener">Program info ${ext}</a><a href="${LINKS.visits(pid)}" target="_blank" rel="noopener">Visit status ${ext}</a><a href="${LINKS.pdf(pid)}" target="_blank" rel="noopener">Proposal PDF ${ext}</a><a href="${LINKS.mast(pid)}" target="_blank" rel="noopener">MAST ${ext}</a><button data-star="${pid}">${isWatched(pid) ? '★ Watching' : '☆ Watch'}</button></div>`;
    if (sched.length) {
      h += `<h4>In the weekly schedule (${sched.length})</h4><table class="mini">${sched.map(v => `<tr><td class="time">${esc(fmtDay(v.t0))} ${esc(fmtHM(v.t0))}<br><span class="muted">${esc(rel(v.t0, now))}</span></td><td>${modeHTML(v.mode)}${v.parallel ? ' <span class="muted small">pure parallel</span>' : ''}<br><span class="mono small muted">${esc(v.id)} · ${esc(v.target || '')}</span></td><td class="time">${esc(span(v.t1 - v.t0))}</td></tr>`).join('')}</table>`;
    }
    if (w) {
      const counts = Object.entries(w.counts || {}).sort((a, b) => b[1] - a[1]);
      h += `<h4>Visit status · ${esc(w.n)} visits${w.hours ? ` · ${esc(w.hours)} h` : ''}</h4><div class="counts">${counts.map(([s, n]) => `<span class="tag ${/flight/i.test(s) ? 'status-fr' : /sched/i.test(s) ? 'status-sched' : /skip|hold|fail/i.test(s) ? 'status-warn' : 'plain'}">${esc(s)} ${n}</span>`).join('')}</div>`;
      const upcoming = wv.filter(v => !FINISHED.has((v.status || '').toLowerCase()))
        .sort((a, b) => ((a.windows || [])[0]?.[0] || a.start || '9').localeCompare((b.windows || [])[0]?.[0] || b.start || '9'));
      const recent = wv.filter(v => (v.status || '').toLowerCase().startsWith('archived'));
      if (upcoming.length) {
        h += `<table class="mini" style="margin-top:8px">${upcoming.slice(0, 40).map(v => `<tr><td class="time">${v.windows ? esc(fmtWin(v.windows[0])) : v.start ? esc(fmtDateY(Date.parse(v.start))) : '—'}</td><td>${modeHTML((v.modes || [])[0] || '')}<br><span class="mono small muted">obs ${esc(v.obs)} visit ${esc(v.visit)} · ${esc((v.targets || []).join(', '))}</span></td><td>${statusTags([v.status])}</td></tr>`).join('')}</table>`;
        if (upcoming.length > 40) h += `<p class="small muted">… ${upcoming.length - 40} more on the STScI visit status page.</p>`;
      }
      if (recent.length) h += `<p class="small muted" style="margin-top:8px">Recently archived: ${recent.map(v => `obs ${esc(v.obs)}.${esc(v.visit)} (${esc(fmtDate(Date.parse(v.end || v.start)))})`).join(', ')}</p>`;
      h += `<p class="small muted">Visit status fetched ${esc(rel(Date.parse(w.fetched)))}. Plan windows are STScI planning windows, not scheduled times.</p>`;
    } else {
      h += `<h4>Visit status</h4><p class="small muted">${tracked ? 'Not fetched yet.' : 'This program is not tracked by the server. Add its ID to <code>watch_programs</code> in <code>config/interests.json</code> to follow its plan windows, or open the STScI visit status page.'}</p>`;
    }
    if (rels.length) {
      h += `<h4>Public data releases in MAST</h4><table class="mini">${rels.map(g => `<tr><td class="time">${esc(fmtDayStr(g.date))} ${esc(g.date.slice(0, 4))}<br><span class="muted">${esc(relDays(g.date))}</span></td><td>${g.inst.map(i => modeHTML(mastInst(i))).join(' ')}<br><span class="mono small muted">${esc(g.targets.slice(0, 4).join(', '))}${g.ntargets > 4 ? ` +${g.ntargets - 4}` : ''}</span></td><td class="time">${g.n} products</td></tr>`).join('')}</table>`;
    }
    $('#drawerBody').innerHTML = h;
    $('#drawer').hidden = false;
    $('.drawer-close').focus();
  }
  const closeDrawer = () => { $('#drawer').hidden = true; };

  // ------------------------------------------------------------------ calendar export
  function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
  function icsFold(line) {
    const out = [];
    let cur = line;
    while (new TextEncoder().encode(cur).length > 74) {
      let i = 74;
      while (new TextEncoder().encode(cur.slice(0, i)).length > 74) i--;
      out.push(cur.slice(0, i));
      cur = ' ' + cur.slice(i);
    }
    out.push(cur);
    return out.join('\r\n');
  }
  function exportICS() {
    const now = Date.now(), t0 = todayUTC();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const dt = t => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const d8 = s => s.replace(/-/g, '');
    const d8next = s => new Date(utcDay(s) + DAY).toISOString().slice(0, 10).replace(/-/g, '');
    const ev = [];
    const push = (uid, fields) => ev.push(['BEGIN:VEVENT', `UID:${uid}@webbradar`, `DTSTAMP:${stamp}`, ...fields, 'END:VEVENT']);
    for (const v of S.flat) {
      if (!v.pid || v.kind !== 'sci' || v.t1 < now || !relevant(v.tags)) continue;
      push(`visit-${v.id.replace(/:/g, '-')}${v.parallel ? '-par' : ''}`, [`DTSTART:${dt(v.t0)}`, `DTEND:${dt(v.t1)}`,
        `SUMMARY:${icsEscape(`JWST ${v.pid} · ${short(v.mode)} · ${v.target || ''}`)}`,
        `DESCRIPTION:${icsEscape(`${title(v.pid)}\nPI ${P(v.pid).pi || '?'}\nVisit ${v.id}${v.parallel ? ' (pure parallel)' : ''}\nPlanned in the STScI weekly schedule.`)}`,
        `URL:${LINKS.program(v.pid)}`]);
    }
    // Plan windows are uncertain, so only watched programs get them.
    const seen = new Set();
    for (const v of (S.watch?.visits || [])) {
      const st = (v.status || '').toLowerCase();
      if (FINISHED.has(st) || !isWatched(v.pid)) continue;
      for (const w of v.windows || []) {
        if (utcDay(w[1]) < t0 || utcDay(w[0]) > t0 + S.ui.obsH * DAY) continue;
        const k = `${v.pid}-${w[0]}-${w[1]}`;
        if (seen.has(k)) continue;
        seen.add(k);
        push(`window-${k}`, [`DTSTART;VALUE=DATE:${d8(w[0])}`, `DTEND;VALUE=DATE:${d8next(w[1])}`, 'TRANSP:TRANSPARENT',
          `SUMMARY:${icsEscape(`JWST ${v.pid} plan window · ${short((v.modes || [])[0] || '')}`)}`,
          `DESCRIPTION:${icsEscape(`${title(v.pid)}\nStatus: ${v.status}\nTargets: ${(v.targets || []).join(', ')}\nA planning window, not a scheduled time.`)}`,
          `URL:${LINKS.visits(v.pid)}`]);
      }
    }
    for (const g of (S.rel?.groups || [])) {
      if (utcDay(g.date) < t0 || utcDay(g.date) > t0 + S.ui.relH * DAY || !relevant(progTags(g.pid))) continue;
      push(`release-${g.pid}-${g.date}`, [`DTSTART;VALUE=DATE:${d8(g.date)}`, `DTEND;VALUE=DATE:${d8next(g.date)}`, 'TRANSP:TRANSPARENT',
        `SUMMARY:${icsEscape(`JWST data public: ${g.pid} ${title(g.pid).slice(0, 60)}`)}`,
        `DESCRIPTION:${icsEscape(`${title(g.pid)}\nPI ${P(g.pid).pi || '?'}\n${g.n} level-3 products (${g.inst.join(', ')})\nTargets: ${g.targets.join(', ')}`)}`,
        `URL:${LINKS.mast(g.pid)}`]);
    }
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WebbRadar//JWST radar//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:WebbRadar (JWST)', ...ev.flat(), 'END:VCALENDAR'];
    const blob = new Blob([lines.map(icsFold).join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `webbradar-${new Date().toISOString().slice(0, 10)}.ics`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ------------------------------------------------------------------ settings
  function openSettings() {
    $('#settingsTopics').innerHTML = S.I.topics.map(t => `<div class="topic-box" data-topic="${esc(t.key)}">
      <header><label><input type="checkbox" ${t.enabled ? 'checked' : ''} data-f="enabled"> <span class="tag ${esc(t.key)}">${esc(t.label)}</span></label>
      <span class="small muted" style="margin-left:auto">weight</span><input type="number" min="0" max="10" step="1" value="${esc(t.weight)}" data-f="weight"></header>
      <textarea data-f="patterns" spellcheck="false">${esc(t.patterns.join('\n'))}</textarea></div>`).join('');
    $('#setZ').value = S.I.zth;
    $('#setWatch').value = [...new Set(S.prefs.watch || [])].join(', ');
    $('#settings').showModal();
  }
  function saveSettings() {
    const topics = {};
    $$('.topic-box').forEach(box => {
      const key = box.dataset.topic;
      const patterns = $('[data-f="patterns"]', box).value.split('\n').map(s => s.trim()).filter(Boolean);
      const bad = patterns.filter(p => !toRx(p));
      if (bad.length) alert(`Ignoring invalid pattern(s) in ${key}: ${bad.join(', ')}`);
      topics[key] = { enabled: $('[data-f="enabled"]', box).checked, weight: Number($('[data-f="weight"]', box).value), patterns: patterns.filter(p => toRx(p)) };
    });
    S.prefs.topics = topics;
    const z = parseFloat($('#setZ').value);
    S.prefs.z = Number.isFinite(z) ? z : undefined;
    S.prefs.watch = uniq(($('#setWatch').value.match(/\d+/g) || []).map(Number));
    savePrefs();
    rerender();
  }
  function toggleWatch(pid) {
    pid = Number(pid);
    const set = new Set(S.prefs.watch || []);
    set.has(pid) ? set.delete(pid) : set.add(pid);
    S.prefs.watch = [...set];
    savePrefs();
    const drawerOpen = !$('#drawer').hidden;
    rerender();
    if (drawerOpen) openProgram(pid);
  }

  // ------------------------------------------------------------------ chrome
  function setTab(tab) {
    S.ui.tab = tab;
    $$('.tabs [role="tab"]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('.tab-panel').forEach(p => { p.hidden = p.id !== `tab-${tab}`; });
    renderTab();
    savePrefs();
    if (tab === 'schedule') {
      const cur = $('#schedBody tr.current') || $('#schedBody tr.v:not(.past)');
      if (cur) setTimeout(() => cur.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
    }
  }
  function renderTab() {
    if (S.ui.tab === 'foryou') renderForYou();
    else if (S.ui.tab === 'schedule') renderSchedule();
    else if (S.ui.tab === 'releases') renderReleases();
    else if (S.ui.tab === 'programs') renderPrograms();
  }
  function rerender() {
    compileInterests();
    for (const v of S.flat) { v.tags = visitTags(v); v.score = score(v.tags); }
    renderNow();
    renderTab();
    renderStatus();
  }
  function renderStatus() {
    const m = S.meta;
    const parts = [];
    if (m?.generated) parts.push(`Data updated ${rel(Date.parse(m.generated))} (${fmtDateY(Date.parse(m.generated))} ${fmtHM(Date.parse(m.generated))} ${tzName()})`);
    if (S.watch?.tracked) parts.push(`${S.watch.tracked.length} programs tracked`);
    if (S.sched?.files?.length) parts.push(`schedule ${S.sched.files[0].week} → ${S.sched.files[S.sched.files.length - 1].week}`);
    const errs = (m?.errors || []).length;
    $('#footStatus').innerHTML = esc(parts.join(' · ')) + (errs ? ` · <span class="warn" title="${esc(m.errors.join('\n'))}">${errs} fetch warning${errs > 1 ? 's' : ''}</span>` : '');
    const b = $('#banner');
    const msgs = [];
    if (S.loadErrors.length) {
      msgs.push(`Could not load ${esc(S.loadErrors.join(', '))}. ${location.protocol === 'file:'
        ? 'Browsers block reading local files: serve this folder instead, e.g. <code>python3 -m http.server</code> and open <code>http://localhost:8000</code>.'
        : 'Run <code>python3 scripts/update_data.py</code> to create the data files.'}`);
    }
    const age = m?.generated ? Date.now() - Date.parse(m.generated) : 0;
    if (age > 2 * DAY) msgs.push(`The data is ${esc(span(age))} old; the automatic update may have stopped.`);
    b.innerHTML = msgs.join('<br>');
    b.hidden = !msgs.length;
  }
  function applyTheme() {
    let t = null;
    try { t = localStorage.getItem('webbradar:theme'); } catch (e) { /* ignore */ }
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    $('#themeBtn').title = `Theme: ${t || 'auto'} (click to change)`;
  }
  function cycleTheme() {
    let t = null;
    try { t = localStorage.getItem('webbradar:theme'); } catch (e) { /* ignore */ }
    const next = t === 'dark' ? 'light' : t === 'light' ? null : 'dark';
    try { next ? localStorage.setItem('webbradar:theme', next) : localStorage.removeItem('webbradar:theme'); } catch (e) { /* ignore */ }
    applyTheme();
  }
  function setSeg(id, value) { $$(`#${id} button`).forEach(b => b.classList.toggle('on', b.dataset.v === String(value))); }

  function bind() {
    $$('.tabs [role="tab"]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('#tzBtn').addEventListener('click', () => { S.prefs.tz = useUTC() ? 'local' : 'utc'; savePrefs(); $('#tzBtn').textContent = useUTC() ? 'UTC' : 'Local'; rerender(); tick(); });
    $('#themeBtn').addEventListener('click', cycleTheme);
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#settingsForm').addEventListener('submit', e => { if (e.submitter && e.submitter.value === 'save') saveSettings(); });
    $('#setReset').addEventListener('click', () => { delete S.prefs.topics; delete S.prefs.z; savePrefs(); rerender(); openSettingsRefresh(); });
    $('#icsBtn').addEventListener('click', exportICS);
    const seg = (id, key, fn) => $(`#${id}`).addEventListener('click', e => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      S.ui[key] = /^\d+$/.test(b.dataset.v) ? Number(b.dataset.v) : b.dataset.v; setSeg(id, S.ui[key]); savePrefs(); fn();
    });
    seg('obsHorizon', 'obsH', renderForYou);
    seg('relHorizon', 'relH', renderForYou);
    seg('schedInst', 'schedInst', renderSchedule);
    seg('relWhen', 'relWhen', renderReleases);
    seg('progTopic', 'progTopic', renderPrograms);
    seg('progSort', 'progSort', renderPrograms);
    const input = (id, key, fn) => { let t; $(`#${id}`).addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { S.ui[key] = e.target.value; fn(); }, 120); }); };
    input('schedSearch', 'schedQ', renderSchedule);
    input('relSearch', 'relQ', renderReleases);
    input('progSearch', 'progQ', renderPrograms);
    const check = (id, key, fn) => { const el = $(`#${id}`); el.checked = !!S.ui[key]; el.addEventListener('change', () => { S.ui[key] = el.checked; savePrefs(); fn(); }); };
    check('schedRelevant', 'schedRel', renderSchedule);
    check('schedCal', 'schedCal', renderSchedule);
    check('relRelevant', 'relRel', renderReleases);

    document.addEventListener('click', e => {
      const star = e.target.closest('[data-star]');
      if (star) { e.preventDefault(); e.stopPropagation(); toggleWatch(star.dataset.star); return; }
      if (e.target.closest('[data-close]')) { closeDrawer(); return; }
      const act = e.target.closest('[data-act]');
      if (act) { S.ui[act.dataset.act] = true; renderTab(); return; }
      if (e.target.closest('a[href]:not([href="#"])') || e.target.closest('[data-stop]')) return;
      const row = e.target.closest('[data-pid]');
      if (row && row.dataset.pid) { e.preventDefault(); openProgram(row.dataset.pid); }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });

    const tip = $('#tooltip');
    $('#timeline').addEventListener('mousemove', e => {
      const b = e.target.closest('.tl-block');
      if (!b) { tip.hidden = true; return; }
      const v = S.visits.find(x => x.id === b.dataset.vid);
      if (!v) return;
      const pars = (v.par || []).filter(p => /PURE|COORDINATED/i.test(p.type));
      tip.innerHTML = `<div class="m">${esc(v.id)} · ${esc(fmtDay(v.t0))} ${esc(fmtHM(v.t0))}–${esc(fmtHM(v.t1))} ${esc(tzName())}</div>
        <b>${esc(v.kind === 'eng' ? v.type.toLowerCase() : title(v.pid))}</b><br>${esc(short(v.mode))}${v.target ? ` · ${esc(v.target)}` : ''}
        ${pars.length ? `<div class="m">+ ${pars.map(p => esc(short(p.mode) + (p.pid ? ` (${p.pid})` : ''))).join(', ')}</div>` : ''}
        ${v.tags.length ? `<div style="margin-top:4px">${tagHTML(v.tags)}</div>` : ''}`;
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      tip.style.left = `${Math.min(e.clientX + 14, innerWidth - r.width - 8)}px`;
      tip.style.top = `${Math.max(8, e.clientY - r.height - 12)}px`;
    });
    $('#timeline').addEventListener('mouseleave', () => { tip.hidden = true; });
    $('#timeline').addEventListener('click', e => { const b = e.target.closest('.tl-block'); const v = b && S.visits.find(x => x.id === b.dataset.vid); if (v && v.pid) openProgram(v.pid); });
  }
  function openSettingsRefresh() { $('#settings').close(); openSettings(); }

  async function start() {
    applyTheme();
    $('#tzBtn').textContent = useUTC() ? 'UTC' : 'Local';
    setSeg('obsHorizon', S.ui.obsH); setSeg('relHorizon', S.ui.relH); setSeg('progSort', S.ui.progSort);
    bind();
    await load();
    renderNow();
    setTab(S.ui.tab || 'foryou');
    renderStatus();
    tick();
    setInterval(tick, 1000);
    setInterval(() => { if (S.ui.tab === 'foryou') renderForYou(); renderStatus(); }, 60 * 1000);
    setInterval(async () => { await load(); rerender(); }, RELOAD_EVERY);
  }

  start();
})();
