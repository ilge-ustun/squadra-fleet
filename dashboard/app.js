// app.js — the fleet dashboard's page: read-only views of what
// `fleet dashboard serve` answers (ts/src/dashboard/). No framework, no
// build, nothing from another host: the server's policy allows this file and
// the page's own requests only. Nothing here changes the fleet; a command
// shown on the page is text for a person to run.
//
//   api/catalog          every story and epic (catalog.ts)
//   api/moment[?at=]     the fleet now, or at a past moment (moment.ts)
//   api/story?repo&id    one story's life, as its event log (life.ts)
//   api/machine          the machine now: memory, swap, load, the disk and
//                        the units that hold the most memory (machine.ts)

// ── words, icons, tones ─────────────────────────────────────────────────────
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ms = (iso) => Date.parse(iso);
const hms = (iso) => (iso ? iso.slice(11, 19) : '—');
const hm = (iso) => (iso ? iso.slice(11, 16) : '—');
const dayOf = (iso) => `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]}`;
const sameDay = (a, b) => a && b && a.slice(0, 10) === b.slice(0, 10);
const when = (iso, ref, sec) => (!iso ? '—' : (sameDay(iso, ref) ? '' : `${dayOf(iso)} `) + (sec ? hms(iso) : hm(iso)));
function dur(s) {
  if (s == null || Number.isNaN(s)) return '—';
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
const between = (a, b) => (a && b ? (ms(b) - ms(a)) / 1000 : null);
const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const pct = (xs, p) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); if (!v.length) return null; return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
const p2 = (n) => String(n).padStart(2, '0');
/** A time computed here, in the viewer's clock, written as the fleet writes its own. */
function isoAt(t) {
  const d = new Date(t);
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${off >= 0 ? '+' : '-'}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
}

const ICON = {
  pencil: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  run: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none"/>',
  question: '<circle cx="8" cy="8" r="6"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4"/><circle cx="8" cy="11.4" r=".5" fill="currentColor"/>',
  hand: '<path d="M8 2.2L14 13H2z"/><path d="M8 6.5v3"/><circle cx="8" cy="11.3" r=".5" fill="currentColor"/>',
  flag: '<path d="M3.5 14V2.5M3.5 3h8l-1.8 3 1.8 3h-8"/>',
  merge: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5v6M4.5 5c0 2.5 2.5 3 5.5 3"/>',
  check: '<circle cx="8" cy="8" r="6"/><path d="M5.3 8.2l1.8 1.8 3.6-3.8"/>',
  x: '<circle cx="8" cy="8" r="6"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
  slash: '<circle cx="8" cy="8" r="6"/><path d="M4 12L12 4"/>',
  doc: '<path d="M4 2h5.5L12 4.5V14H4z"/><path d="M6 7h4M6 9.5h4"/>',
  pause: '<circle cx="8" cy="8" r="6"/><path d="M6.6 5.5v5M9.4 5.5v5"/>',
  dead: '<path d="M5 2.5h6M8 2.5v3"/><circle cx="8" cy="9.5" r="4.5"/><path d="M6 8l4 4M10 8l-4 4"/>',
  hourglass: '<path d="M4 2h8M4 14h8M5 2c0 3 6 3 6 6s-6 3-6 6M11 2c0 3-6 3-6 6s6 3 6 6"/>',
  dot: '<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>',
  arrow: '<path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5"/>',
  minus: '<path d="M4 8h8"/>',
};
const inlineCode = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICON[n] || ''}</svg>`;
const chip = (ic, text, tone, cls = '') => `<span class="chip t-${tone} ${cls}">${icon(ic, ic === 'run' ? 'pulse' : '')}${esc(text)}</span>`;

const STATE = {
  draft: { ic: 'pencil', word: 'draft', tone: 'neutral', sw: '--st-draft' },
  ready: { ic: 'clock', word: 'ready · queued', tone: 'run', sw: '--st-ready' },
  in_progress: { ic: 'run', word: 'in progress', tone: 'run', sw: '--st-run' },
  blocked: { ic: 'question', word: 'blocked', tone: 'warn', sw: '--st-blocked' },
  needs_human: { ic: 'hand', word: 'needs human', tone: 'crit', sw: '--st-nh' },
  done: { ic: 'flag', word: 'done', tone: 'neutral', sw: '--st-done' },
  'awaiting merge': { ic: 'merge', word: 'awaiting merge', tone: 'warn', sw: '--st-blocked' },
  'on epic': { ic: 'merge', word: 'on epic', tone: 'good', sw: '--st-onepic' },
  landed: { ic: 'check', word: 'landed', tone: 'good', sw: '--st-landed' },
  declined: { ic: 'slash', word: 'declined', tone: 'neutral', sw: '--st-draft' },
};
const ORDER = ['landed', 'on epic', 'awaiting merge', 'done', 'in_progress', 'ready', 'draft', 'blocked', 'needs_human'];
const stateChip = (st) => { const m = STATE[st] || { ic: 'dot', word: st, tone: 'neutral' }; return chip(m.ic, m.word, m.tone); };
const VERDICT = { PASS: ['check', 'good'], FAIL: ['x', 'crit'], SPEC: ['doc', 'warn'], UNPARSEABLE: ['question', 'warn'], UNAVAILABLE: ['pause', 'warn'] };
const verdictChip = (v) => (v ? chip(...(VERDICT[v] ? [VERDICT[v][0], v, VERDICT[v][1]] : ['dot', v, 'neutral'])) : '<span class="muted">—</span>');
// The fleet's word, coloured by what it means for the story: a mutation that
// goes RED was caught (good); a baseline that goes RED is bad.
function resultChip(pass, r) {
  if (!r) return '';
  if (pass === 'mutation' || pass === 'tdd') return r === 'RED' ? chip('check', 'RED · caught', 'good') : /^\d+\/\d+ RED$/.test(r) ? chip('x', r, 'crit') : chip('x', `${r} · survived`, 'crit');
  if (pass === 'probe') return r === 'GREEN' ? chip('check', 'GREEN', 'good') : chip('x', `${r} · found a defect`, 'crit');
  if (pass === 'baseline') return r === 'GREEN' ? chip('check', 'GREEN', 'good') : r === 'SKIPPED' ? chip('minus', 'SKIPPED', 'neutral') : chip('x', r, 'crit');
  if (pass === 'scope') return r === 'CLEAN' ? chip('check', 'CLEAN', 'good') : chip('x', r, 'crit');
  if (pass === 'reviewer') return r === 'OK' ? chip('check', 'answered', 'good') : chip('x', r, 'crit');
  if (pass === 'verdict' || pass === 'round') return verdictChip(r);
  if (pass === 'builder') return r === 'OK' ? chip('check', 'committed', 'good') : r === 'BLOCKED' ? chip('question', 'asked a question', 'warn') : chip('x', r, 'crit');
  if (pass === 'install' || pass === 'writer' || pass === 'lint') return r === 'OK' || r === 'PASS' ? chip('check', r, 'good') : chip('x', r, 'crit');
  if (pass === 'merge' || pass === 'land' || pass === 'epic_merge') return r === 'MERGED' || r === 'ALREADY' ? chip('merge', r, 'good') : chip('x', r, 'crit');
  if (pass === 'test_deploy') return r === 'UP' ? chip('check', 'UP', 'good') : chip('x', r, 'crit');
  return chip('dot', r, 'neutral');
}
const SRC = { log: 'log', journal: 'journal', machine: 'Machine block', git: 'git', mtime: 'file time', systemd: 'systemd', file: 'fleet file', proc: '/proc', unknown: 'unknown' };
const SRCWHY = {
  log: 'events.jsonl — written by the fleet as it runs; exact',
  journal: "the queue units' journal, or a copy of it saved in .runs/ — exact to the second",
  machine: "the Machine block in .review/<id>.md — a round's end (reviewed:) or a pass's seconds",
  git: "a commit's time — exact for the commit, an approximation for the work",
  mtime: "a file's modification time in the checkout — the step's end",
  systemd: 'systemctl: the queue unit and its timer, read now',
  file: ".test-deploy.json, the fleet's own record of the test deploy",
  proc: "the kernel's own figures, /proc and the cgroups, read at each refresh; nothing records them",
  unknown: 'no source records this time',
};
const src = (s) => { const k = SRC[s] ? s : 'unknown'; return `<span class="src s-${k}" title="${esc(SRCWHY[k])}">${esc(SRC[k])}</span>`; };
const PHASE = { builder: '--c-builder', baseline: '--c-baseline', tdd: '--c-mutation', reviewer: '--c-reviewer', mutation: '--c-mutation', probe: '--c-mutation', install: '--c-other', merge: '--c-merge', land: '--c-merge', epic_merge: '--c-merge', writer: '--c-other', other: '--c-other' };
const col = (v) => `var(${v})`;

// ── state ───────────────────────────────────────────────────────────────────
const VIEWS = [['overview', 'Overview'], ['backlog', 'Backlog'], ['epics', 'Epics'], ['landed', 'Landed'], ['story', 'Story']];
const S = { view: 'overview', at: null, epic: null, story: null, period: 14, aggRepo: 'both', landedRepo: 'all', landedAll: false, machineAll: false };
try { const h = location.hash.slice(1); if (VIEWS.some(([v]) => v === h)) S.view = h; } catch (e) { /* no hash */ }
let themeChoice = 'system';
try { themeChoice = localStorage.getItem('fleet-theme') || 'system'; } catch (e) { /* storage refused */ }
/** The catalog, the moment shown, and the stories' lives read so far. */
let D = null;
let M = null;
/** The machine now (api/machine), or why it could not be read. */
let MACH = null;
let failed = null;
const LIFE = new Map();
const REPO = (n) => D.repos.find((r) => r.name === n);
const STORY = (r, id) => REPO(r)?.stories.find((s) => s.id === id);
/** The moment's state of a story, or its landing now. */
const stateOf = (repo, id) => M.repos[repo]?.states[id]?.state ?? STORY(repo, id)?.landing;

// Each project's identity: a monogram, a short name that prefixes every id,
// and an accent band. The colour is the third cue, never the only one.
const PROJ = { khaita: { mono: 'KH', tag: 'khaita', cls: 'p-khaita' }, 'qr-desktop-scanner': { mono: 'QR', tag: 'qr', cls: 'p-qr' } };
const P = (r) => PROJ[r] || { mono: r.slice(0, 2).toUpperCase(), tag: r, cls: '' };
const short = (r) => P(r).tag;
const pm = (r, lg) => `<span class="pm ${P(r).cls}${lg ? ' lg' : ''}" aria-hidden="true">${esc(P(r).mono)}</span>`;
const sid = (r, id) => `<span class="sid"><span class="pfx">${esc(P(r).tag)}/</span>${esc(id)}</span>`;
const ptag = (r, id) => `<span class="ptag ${P(r).cls}">${pm(r)}${sid(r, id)}</span>`;
let DK = 0;
/** A key for a <details>, so a refresh keeps it open. */
const dk = () => `d${DK++}`;

// ── overview ────────────────────────────────────────────────────────────────
function attention() {
  const items = [];
  const at = ms(M.at);
  for (const [name, R] of Object.entries(M.repos)) {
    if (!R.registered) continue;
    for (const [id, x] of Object.entries(R.states)) {
      const s = STORY(name, id);
      if (!s) continue;
      if (x.state === 'blocked') items.push({ tone: 'warn', ic: 'question', kind: 'blocked — a question', repo: name, id, title: s.question || s.title, since: x.since, why: R.stops[id], cmd: `/answer ${name} ${id} <your answer>` });
      else if (x.state === 'needs_human' && !(x.since && at - ms(x.since) > 7 * 86400e3)) items.push({ tone: 'crit', ic: 'hand', kind: 'needs human', repo: name, id, title: s.title, since: x.since, why: R.stops[id], cmd: `fleet status ${name} ${id}` });
    }
    for (const [id, r] of Object.entries(R.running)) {
      const title = STORY(name, id)?.title ?? '';
      if (r.dead) {
        items.push({ tone: 'crit', ic: 'dead', kind: 'launcher dead', repo: name, id, title, since: r.dead.ts || r.launchSince,
          why: { msg: `${r.dead.why}.${r.pass ? ` It was in: ${r.pass}${r.name ? ` (${r.name})` : ''}, from ${hms(r.since)}.` : ''} The story still reads in_progress; the next drain returns it to the queue.`, src: r.dead.src },
          cmd: `systemctl --user start --no-block fleet-queue@${name}.service` });
      } else if (r.since && (r.pass === 'builder' || r.pass === 'reviewer') && at - ms(r.since) > 3700e3) {
        items.push({ tone: 'warn', ic: 'hourglass', kind: 'stuck past its time limit', repo: name, id, title, since: r.since, why: { msg: `The ${r.pass} has run ${dur(between(r.since, M.at))}; AGENT_TIMEOUT for the queue is 3600 s.`, src: r.src }, cmd: `fleet status ${name} ${id}` });
      }
    }
  }
  return items;
}

// Every epic that existed at the moment: its stories' states then, when it
// was created and when it last landed.
function epicRows(name) {
  const R = REPO(name);
  const st = M.repos[name].states;
  const atT = ms(M.at);
  return R.epics.map((e) => {
    const created = e.created && ms(e.created.ts) <= atT ? e.created : null;
    const members = e.stories.filter((id) => st[id] && st[id].state !== 'declined');
    if (!members.length && !created) return null;
    const counts = {};
    for (const id of members) counts[st[id].state] = (counts[st[id].state] || 0) + 1;
    const lands = e.lands.filter((l) => ms(l.ts) <= atT);
    const landedAt = lands.length ? lands[lands.length - 1].ts : null;
    const open = !members.length || members.some((id) => st[id].state !== 'landed');
    const firstDraft = e.stories.map((id) => STORY(name, id)?.history[0]?.ts).filter((t) => t && ms(t) <= atT).sort((a, b) => ms(a) - ms(b))[0] || null;
    return { name: e.name, members, counts, open, landedAt, created, firstDraft, start: created ? created.ts : firstDraft };
  }).filter(Boolean);
}

function progress(counts, total) {
  const seg = ORDER.filter((k) => counts[k]).map((k) => `<span style="flex:${counts[k]};background:${col(STATE[k].sw)}" title="${counts[k]} ${STATE[k].word}"></span>`).join('');
  const words = ORDER.filter((k) => counts[k]).map((k) => `<span><i class="sw" style="background:${col(STATE[k].sw)}"></i>${counts[k]} ${STATE[k].word}</span>`).join('');
  return `<div class="prog" role="img" aria-label="${ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${STATE[k].word}`).join(', ')} of ${total}">${seg}</div><div class="prog-legend">${words}</div>`;
}

// What waits, by who it waits for. The queue takes the lowest id first.
function backlogOf(name) {
  const B = { person: [], draft: [], ready: [], running: [] };
  const R = M.repos[name];
  if (!R || !R.registered) return B;
  for (const [id, x] of Object.entries(R.states)) {
    const s = STORY(name, id);
    if (!s) continue;
    const it = { repo: name, id, x, s };
    if (x.state === 'blocked' || x.state === 'needs_human') B.person.push(it);
    else if (x.state === 'draft') B.draft.push(it);
    else if (x.state === 'ready') B.ready.push(it);
    else if (x.state === 'in_progress') B.running.push(it);
  }
  const bySince = (a, b) => ms(a.x.since || 0) - ms(b.x.since || 0);
  B.person.sort(bySince); B.draft.sort(bySince); B.ready.sort((a, b) => a.id.localeCompare(b.id));
  return B;
}

function projHead(name, extra = '') {
  return `<div class="proj-h">${pm(name, true)}<div class="proj-n"><h2>${esc(name)}</h2><span class="caption">ids <code>${esc(P(name).tag)}/…</code> · integration branch <code>${esc(REPO(name).baseBranch)}</code></span></div><span class="grow"></span>${extra}</div>`;
}
const unregistered = (name) => `<section class="panel proj ${P(name).cls}" aria-label="${esc(name)}">${projHead(name, chip('minus', 'no story yet', 'neutral'))}<div class="proj-b"><p class="caption" style="margin:0">The fleet had no story for this project at this moment.</p></div></section>`;

function testDeployAt(name) {
  const T = M.repos[name].testDeploy;
  if (T === null) return '<span class="muted">none</span>';
  if (!T.known) return '<span class="muted">unknown at this moment: the log has no test deploy before it</span>';
  return `<code>${esc(T.branch || '?')}</code> at <code>${esc(T.sha || '?')}</code>, up since ${T.since ? when(T.since, M.at) : '—'}${T.active === false ? ` ${chip('pause', 'stopped', 'warn')}` : ''} ${src(T.src === '.test-deploy.json' ? 'file' : T.src)}`;
}

function liveCards(name) {
  return Object.entries(M.repos[name].running).map(([id, r]) => {
    const title = esc(STORY(name, id)?.title ?? '');
    if (r.dead) {
      return `<div class="live dead"><div class="bar">${chip('dead', 'launcher dead', 'crit')}${sid(name, id)}<span class="caption">${r.dead.ts ? `since ${when(r.dead.ts, M.at, true)}` : 'when: not recorded'}</span></div><div class="caption">${title}</div><div class="caption">${esc(r.dead.why)}${r.pass ? ` · it was in ${esc(r.pass)}${r.name ? ` (${esc(r.name)})` : ''}, from ${when(r.since, M.at, true)}` : ''} ${src(r.dead.src)}</div></div>`;
    }
    const what = !r.pass ? 'between passes' : r.pass === 'install' ? 'tree + install' : r.pass;
    const agent = !r.pass || !r.agent ? 'harness' : `${r.agent}${r.model ? ` ${r.model}` : ''}`;
    const named = r.name && r.name !== 'all' && r.name !== 'build' ? ` (${esc(r.name)})` : '';
    return `<div class="live"><div class="bar">${chip('run', 'working', 'run')}${sid(name, id)}<span>round ${r.round ?? '—'} · ${esc(what)}${named} · ${esc(agent)}</span></div><div class="caption">${title}</div><div class="caption">${r.since ? `${esc(what)} for ${dur(between(r.since, M.at))} — since ${when(r.since, M.at, true)}` : `launched ${when(r.launchSince, M.at, true)}; the passes are not recorded`} ${src(r.src)}</div></div>`;
  }).join('');
}

const miniHTML = (it) => `<div class="mini"><div class="bar" style="gap:6px">${sid(it.repo, it.id)}${stateChip(it.x.state)}<span class="caption">${it.x.since ? dur(between(it.x.since, M.at)) : ''}</span></div><button class="linkbtn story-title" data-act="story" data-k="${esc(it.repo)}/${esc(it.id)}">${esc(it.s.title)}</button></div>`;

function emptyBacklog(name) {
  const last = REPO(name).stories.map((s) => ({ s, d: s.history[0] })).filter((x) => x.d && ms(x.d.ts) <= ms(M.at)).sort((a, b) => ms(b.d.ts) - ms(a.d.ts) || b.s.id.localeCompare(a.s.id))[0];
  return `<div class="empty">Nothing waits.${last ? ` The last story written: ${sid(name, last.s.id)}, ${when(last.d.ts, M.at)} ${src(last.d.src)}.` : ''}</div>`;
}

function projectSection(name) {
  const R = M.repos[name];
  if (!R || !R.registered) return unregistered(name);
  const u = R.unit;
  const unit = !u.known ? '<span class="muted">unknown at this moment</span>'
    : u.active ? `${chip('run', 'draining', 'run')} <span class="caption">since ${when(u.since, M.at)} ${src(u.src)}</span>`
      : `${chip('pause', 'idle', 'neutral')} <span class="caption">last drain ${u.since ? when(u.since, M.at) : '—'}${u.next ? ` · next ${when(u.next, M.at)}` : ''} ${src(u.src)}</span>`;
  const L = R.lock;
  const lock = !L.known ? '<span class="muted">unknown at this moment</span>'
    : L.held ? (L.pid ? `held by pid <code>${esc(L.pid)}</code> · ${esc(L.what)}` : `held by ${esc(L.what)}`)
      : L.pid ? `free — the last holder, pid <code>${esc(L.pid)}</code> (${esc(L.what)}), is gone` : 'free';
  const runs = Object.entries(R.running);
  const live = runs.filter(([, r]) => !r.dead);
  const B = backlogOf(name);
  const waiting = [...B.person, ...B.draft, ...B.ready];
  const counts = [[B.person.length, 'wait for a person', 'warn', 'question'], [B.draft.length, 'draft', 'neutral', 'pencil'], [B.ready.length, 'ready', 'run', 'clock']].filter(([n]) => n).map(([n, w, t, i]) => chip(i, `${n} ${w}`, t)).join(' ');
  const eps = epicRows(name);
  const open = eps.filter((e) => e.open);
  const landed = Object.entries(R.states).filter(([, x]) => x.state === 'landed').sort((a, b) => ms(b[1].since || 0) - ms(a[1].since || 0) || b[0].localeCompare(a[0]));
  const loose = Object.entries(R.states).filter(([id, x]) => STORY(name, id) && !STORY(name, id).epic && !['landed', 'done', 'declined'].includes(x.state));
  const state = runs.some(([, r]) => r.dead) ? chip('dead', 'launcher dead', 'crit') : live.length ? chip('run', `running ${P(name).tag}/${live[0][0]}`, 'run') : chip('pause', 'idle', 'neutral');
  return `<section class="panel proj ${P(name).cls}" aria-label="${esc(name)}">${projHead(name, state)}<div class="proj-b"><div class="proj-cols">
    <div class="col"><div class="col-h"><span class="eyebrow">Now</span></div><dl class="kv"><dt>queue</dt><dd>${unit}</dd><dt>lock</dt><dd>${lock}</dd><dt>test deploy</dt><dd>${testDeployAt(name)}</dd></dl>${liveCards(name)}</div>
    <div class="col"><div class="col-h"><span class="eyebrow">Backlog</span><button class="linkbtn" data-act="view" data-k="backlog">open the backlog</button></div>${waiting.length ? `<div class="bar" style="gap:6px">${counts}</div>${waiting.slice(0, 4).map(miniHTML).join('')}${waiting.length > 4 ? `<span class="caption">and ${waiting.length - 4} more</span>` : ''}` : emptyBacklog(name)}</div>
    <div class="col"><div class="col-h"><span class="eyebrow">Open epics</span><button class="linkbtn" data-act="epics" data-k="">all ${eps.length} epics</button></div>
      ${open.length ? open.map((e) => `<div class="mini"><button class="epic-name" data-act="epic" data-k="${esc(name)}|${esc(e.name)}">${esc(e.name)}</button>${e.members.length ? progress(e.counts, e.members.length) : '<span class="caption">created, no story yet</span>'}</div>`).join('') : '<p class="caption" style="margin:0">No open epic.</p>'}
      ${loose.length ? `<div class="mini"><b>on ${esc(REPO(name).baseBranch)}</b><div>${loose.map(([id, x]) => `${stateChip(x.state)} ${sid(name, id)}`).join(' ')}</div></div>` : ''}
      <div class="col-h" style="margin-top:8px"><span class="eyebrow">Last landed</span><button class="linkbtn" data-act="landed" data-k="${esc(name)}">all ${landed.length}</button></div>
      ${landed.slice(0, 3).map(([id, x]) => `<div class="mini"><div class="bar" style="gap:6px">${sid(name, id)}<span class="caption">${when(x.since, M.at)}</span></div><button class="linkbtn story-title" data-act="story" data-k="${esc(name)}/${esc(id)}">${esc(STORY(name, id).title)}</button></div>`).join('') || '<p class="caption" style="margin:0">None yet.</p>'}
    </div>
  </div></div></section>`;
}

function overviewHTML() {
  const items = attention();
  const attn = items.length
    ? `<div class="attn">${items.map((a) => `<article class="attn-card k-${a.tone}"><div class="bar">${chip(a.ic, a.kind, a.tone)}${ptag(a.repo, a.id)}<span class="caption">${a.since ? `${dur(between(a.since, M.at))} ago` : ''}</span></div><div class="what">${esc(a.title)}</div>${a.why ? `<div class="caption">${esc(a.why.msg)} ${src(a.why.src)}</div>` : ''}<div class="cmd">${esc(a.cmd)}</div><button class="linkbtn" data-act="story" data-k="${esc(a.repo)}/${esc(a.id)}">open the story</button></article>`).join('')}</div>`
    : `<div class="calm">${icon('check')}Nothing needs you.</div>`;
  const errors = D.errors.length ? `<div class="err">${D.errors.map((e) => `could not read ${esc(e)}`).join('<br>')}</div>` : '';
  return `${errors}<section aria-label="Needs you"><div class="bar" style="margin-bottom:8px"><h2>Needs you</h2><span class="caption">blocked · needs human · launcher dead · stuck past its time limit</span></div>${attn}</section>
  ${machineHTML()}
  <div class="projects">${D.repos.map((r) => projectSection(r.name)).join('')}</div>
  ${timeHTML()}`;
}

// ── the machine ─────────────────────────────────────────────────────────────
// What the server read from /proc at this refresh. Nothing records it, so a
// past moment shows none. A share past its line gets a word and an icon; the
// colour is never the only cue.
const bytes = (b) => (b == null ? '—' : b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} G` : `${Math.max(0, Math.round(b / 2 ** 20))} M`);
const level = (share, warn, crit) => (share >= crit ? 'crit' : share >= warn ? 'warn' : 'ok');
function mtile(v, label, share, tone, word, tip) {
  const w = Math.min(100, Math.max(0, 100 * share)).toFixed(1);
  return `<div class="tile"><span class="v num">${esc(v)}</span><span class="l">${esc(label)}</span><div class="meter" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}"><span class="m-${tone}" style="width:${w}%"></span></div>${tone === 'ok' ? '' : `<span>${chip('hand', word, tone)}</span>`}</div>`;
}
/** A scope's generated id, shortened: tmux-spawn-7b14fabe….scope. */
const shortUnit = (u) => u.replace(/^(.*-)([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.scope)$/, '$1$2…$3');
function machineHTML() {
  const panel = (extra, body = '') => `<section class="panel machine-panel" aria-label="Machine"><div class="bar"><h2>Machine</h2>${extra}</div>${body}</section>`;
  if (!M.now) return panel(`<span class="caption">shown at Now only: nothing records it, so a past moment has none</span>${src('unknown')}`);
  if (!MACH) return panel('<span class="caption">Reading the machine…</span>');
  if (MACH.error) return panel('', `<div class="err">The machine could not be read: ${esc(MACH.error)}</div>`);
  const m = MACH;
  const tiles = [];
  if (m.memory) {
    const used = m.memory.total - m.memory.available;
    const sh = used / m.memory.total;
    tiles.push(mtile(bytes(m.memory.available), `memory available, of ${bytes(m.memory.total)}`, sh, level(sh, 0.8, 0.9), 'memory low', `${bytes(used)} in use of ${bytes(m.memory.total)}`));
  }
  if (m.swap) {
    const used = m.swap.total - m.swap.free;
    const sh = m.swap.total ? used / m.swap.total : 0;
    tiles.push(m.swap.total ? mtile(bytes(used), `swap used, of ${bytes(m.swap.total)}`, sh, level(sh, 0.5, 0.8), 'swap high', `${bytes(used)} of ${bytes(m.swap.total)} swap in use`) : mtile('—', 'no swap', 0, 'ok', '', 'this machine has no swap'));
  }
  if (m.load) {
    const sh = m.load[0] / m.cpus;
    tiles.push(mtile(m.load[0].toFixed(2), `load, 1 min · ${m.cpus} CPUs · 5 min ${m.load[1].toFixed(2)} · 15 min ${m.load[2].toFixed(2)}`, sh, level(sh, 1, 2), 'busy', `load ${m.load[0].toFixed(2)} on ${m.cpus} CPUs; the bar is full at one task per CPU`));
  }
  if (m.disk) {
    const sh = 1 - m.disk.free / m.disk.total;
    tiles.push(mtile(bytes(m.disk.free), `disk free, of ${bytes(m.disk.total)} · ${Math.round(100 * sh)}% used`, sh, level(sh, 0.9, 0.95), 'disk nearly full', `${bytes(m.disk.total - m.disk.free)} used of ${bytes(m.disk.total)}, on the fleet's filesystem`));
  }
  const shown = S.machineAll ? m.units : m.units.slice(0, 3);
  const limit = (u) => (u.high == null && u.max == null ? '<span class="muted">none</span>' : [u.high != null ? `high ${bytes(u.high)}` : '', u.max != null ? `max ${bytes(u.max)}` : ''].filter(Boolean).join(' · '));
  const procs = (u) => {
    const named = u.procs.reduce((a, p) => a + p.count, 0);
    return u.procs.map((p) => `${esc(p.name)}${p.count > 1 ? ` ×${p.count}` : ''} ${bytes(p.rss)}`).join(' · ') + (u.pids > named ? ` · ${u.pids - named} more` : '');
  };
  const bar = (u) => (m.memory && u.inUse != null ? `<div class="dbar" title="in use, as a share of the machine's ${bytes(m.memory.total)}"><span style="width:${Math.min(100, (100 * u.inUse) / m.memory.total).toFixed(1)}%;background:var(--accent)"></span></div>` : '');
  const name = (u) => `<span class="mono unit" title="${esc(u.unit)}">${esc(shortUnit(u.unit))}</span>`;
  const table = `<div class="tbl table-wide"><table><thead><tr><th>unit</th><th>in use</th><th>cache</th><th>peak</th><th>limit</th><th>largest processes</th></tr></thead><tbody>${shown.map((u) => `<tr>
      <td>${name(u)}<div class="caption">${esc(u.owner)}</div></td>
      <td class="num" style="min-width:90px">${bytes(u.inUse)}${bar(u)}</td><td class="num">${bytes(u.cache)}</td><td class="num">${bytes(u.peak)}</td><td class="num">${limit(u)}</td>
      <td class="caption">${procs(u)}</td></tr>`).join('')}</tbody></table></div>`;
  const cards = `<div class="cards">${shown.map((u) => `<article class="scard"><div class="bar" style="gap:4px 10px">${name(u)}<span class="caption">${esc(u.owner)}</span></div>${bar(u)}<div class="facts"><span>in use <b>${bytes(u.inUse)}</b></span><span>cache <b>${bytes(u.cache)}</b></span><span>peak <b>${bytes(u.peak)}</b></span><span>limit <b>${limit(u)}</b></span></div><div class="caption">${procs(u)}</div></article>`).join('')}</div>`;
  const more = m.units.length > 3 ? `<button class="linkbtn" data-act="machineall" data-k="">${S.machineAll ? 'show the largest 3' : `show all ${m.units.length}`}</button>` : '';
  return panel(`<span class="caption">read ${hms(m.at)}, at each refresh ${src('proc')}</span>`, `<div class="tiles" style="margin-top:10px">${tiles.join('')}</div>
    <div style="display:grid;gap:6px;margin-top:14px"><div class="bar"><h3>Memory by unit</h3><span class="caption">the systemd units and scopes that hold the most, largest first</span><span class="grow"></span>${more}</div>
    ${m.units.length ? `${table}${cards}` : '<div class="empty">No unit could be read.</div>'}
    <p class="caption" style="margin:0">In use: memory the kernel cannot drop, only swap. Cache: file pages it drops when memory runs low. Peak: the most the unit held since it started, cache included. Limit: its MemoryHigh and MemoryMax. A process shows by its name only.</p></div>`);
}

// ── where the time goes ─────────────────────────────────────────────────────
function aggRows() {
  const since = ms(M.at) - S.period * 86400e3;
  const rows = [];
  for (const R of D.repos) {
    if (S.aggRepo !== 'both' && S.aggRepo !== R.name) continue;
    for (const s of R.stories) {
      if (!s.doneAt || ms(s.doneAt) > ms(M.at) || (S.period && ms(s.doneAt) < since)) continue;
      rows.push({ repo: R.name, s });
    }
  }
  return rows.sort((a, b) => ms(a.s.doneAt) - ms(b.s.doneAt));
}
function timeTiles(rows) {
  const r1 = rows.filter(({ s }) => s.rounds.some((r) => r.n === 1));
  const firstPass = r1.filter(({ s }) => s.rounds.find((r) => r.n === 1).computed === 'PASS').length;
  const rounds = rows.map(({ s }) => s.round).filter((x) => x != null);
  const totals = rows.flatMap(({ s }) => s.rounds.filter((r) => r.timing).map((r) => r.timing.total));
  const waits = rows.map(({ s }) => s.queueWaitS);
  const tiles = [
    [String(rows.length), 'stories done', 'git'],
    [r1.length ? `${Math.round((100 * firstPass) / r1.length)}%` : '—', `first-round PASS · ${firstPass} of ${r1.length}`, 'machine'],
    [median(rounds) == null ? '—' : String(median(rounds)), `rounds per story (median) · max ${Math.max(0, ...rounds)}`, 'machine'],
    [dur(median(totals)), `round time (median) · p90 ${dur(pct(totals, 0.9))}`, 'machine'],
    [dur(median(waits)), `queue wait (median) · max ${dur(Math.max(0, ...waits.filter((w) => w != null)))}`, 'git'],
  ];
  return `<div class="tiles">${tiles.map(([v, l, s]) => `<div class="tile"><span class="v num">${esc(v)}</span><span class="l">${esc(l)}</span><span>${src(s)}</span></div>`).join('')}</div>`;
}
function timeHTML() {
  const rows = aggRows();
  const bars = rows.flatMap(({ repo, s }) => s.rounds.filter((r) => r.timing).map((r) => ({ repo, id: s.id, n: r.n, t: r.timing, v: r.computed }))).slice(-40);
  const parts = [['builder', '--c-builder'], ['baseline', '--c-baseline'], ['reviewer', '--c-reviewer'], ['mutations', '--c-mutation'], ['other', '--c-other']];
  const W = 900; const H = 240; const L = 44; const B = 34; const top = 10;
  const max = Math.max(60, ...bars.map((b) => b.t.total));
  const stepM = max > 3000 ? 15 : max > 1200 ? 10 : 5;
  const ticks = []; for (let m = 0; m * 60 <= max + stepM * 60; m += stepM) ticks.push(m);
  const y = (sec) => top + (H - top - B) * (1 - sec / (ticks[ticks.length - 1] * 60 || 1));
  const bw = Math.max(6, Math.min(22, (W - L - 10) / Math.max(1, bars.length) - 4));
  const gapX = (W - L - 10) / Math.max(1, bars.length);
  let svg = ticks.map((m) => `<line x1="${L}" x2="${W}" y1="${y(m * 60)}" y2="${y(m * 60)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y(m * 60) + 3.5}" text-anchor="end">${m}m</text>`).join('');
  bars.forEach((b, i) => {
    const x = L + 6 + i * gapX;
    let acc = 0;
    const other = Math.max(0, b.t.total - b.t.builder - b.t.baseline - b.t.reviewer - b.t.mutations);
    const vals = [b.t.builder, b.t.baseline, b.t.reviewer, b.t.mutations, other];
    const tip = `${short(b.repo)} ${b.id} · round ${b.n} · ${b.v}\n${parts.map(([p], k) => `${p} ${dur(vals[k])}`).join(' · ')}\ntotal ${dur(b.t.total)}`;
    vals.forEach((v, k) => {
      if (v <= 0) return;
      const y0 = y(acc); const y1 = y(acc + v);
      svg += `<rect x="${x}" y="${y1}" width="${bw}" height="${Math.max(0.5, y0 - y1 - 1.5)}" rx="${vals.slice(k + 1).every((q) => q <= 0) ? 2 : 0}" fill="${col(parts[k][1])}"/>`;
      acc += v;
    });
    svg += `<rect x="${x - 2}" y="${top}" width="${bw + 4}" height="${H - top - B}" fill="transparent" data-tip="${esc(tip)}"/>`;
    if (bars.length <= 24 || i % 2 === 0) svg += `<text x="${x + bw / 2}" y="${H - B + 14}" text-anchor="middle">${esc(b.id)}</text><text x="${x + bw / 2}" y="${H - B + 26}" text-anchor="middle">${esc(P(b.repo).mono)}·r${b.n}</text>`;
  });
  const models = {};
  for (const { s } of rows) for (const r of s.rounds) {
    if (!r.timing) continue;
    const b = r.builderUsed || r.builderModel || '?'; const rv = r.reviewerUsed || r.reviewerModel || '?';
    (models[`builder|claude ${b}`] ||= []).push({ secs: r.timing.builder, cost: r.costUsd ?? null });
    (models[`reviewer|${r.reviewerCli || 'codex'} ${rv}`] ||= []).push({ secs: r.timing.reviewer, cost: null });
  }
  const modelRows = Object.entries(models).sort().map(([k, v]) => {
    const [role, who] = k.split('|');
    const costs = v.map((x) => x.cost).filter((c) => c != null);
    return `<tr><td>${role}</td><td class="mono">${esc(who)}</td><td class="num">${v.length}</td><td class="num">${dur(median(v.map((x) => x.secs)))}</td><td class="num">${dur(pct(v.map((x) => x.secs), 0.9))}</td><td class="num">${costs.length ? `$${costs.reduce((a, c) => a + c, 0).toFixed(2)}` : '<span class="muted">not recorded</span>'}</td></tr>`;
  }).join('');
  const roundsHist = {}; for (const { s } of rows) { if (s.round == null) continue; const k = s.round >= 4 ? '4+' : String(s.round); roundsHist[k] = (roundsHist[k] || 0) + 1; }
  return `<section class="panel" aria-label="Where the time goes" style="display:grid;gap:14px">
    <div class="bar"><h2>Where the time goes</h2><span class="grow"></span>
      <div class="seg" role="group" aria-label="Repo">${['both', ...D.repos.map((r) => r.name)].map((r) => `<button data-act="aggrepo" data-k="${esc(r)}" aria-pressed="${S.aggRepo === r}">${r === 'both' ? 'all repos' : esc(r)}</button>`).join('')}</div>
      <div class="seg" role="group" aria-label="Period">${[[7, '7 days'], [14, '14 days'], [0, 'all']].map(([p, l]) => `<button data-act="period" data-k="${p}" aria-pressed="${S.period === p}">${l}</button>`).join('')}</div>
    </div>
    ${timeTiles(rows)}
    <div><div class="bar"><h3>Round time, by pass</h3><span class="caption">the last ${bars.length} rounds, oldest left · seconds from each round's Machine block ${src('machine')}</span></div>
      <div class="legend" style="margin:6px 0">${parts.map(([p, c]) => `<span><i class="sw" style="background:${col(c)}"></i>${p}${p === 'other' ? ' (trees, installs, scope — total less the four)' : ''}</span>`).join('')}</div>
      ${bars.length ? `<div class="chart-box chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stacked bars: seconds per pass for the last ${bars.length} rounds">${svg}</svg></div>` : '<div class="empty">No round in this period.</div>'}
      <details style="margin-top:6px" data-k="${dk()}"><summary class="caption" style="cursor:pointer">Table view</summary><div class="tbl"><table><thead><tr><th>story</th><th>round</th><th>verdict</th>${parts.map(([p]) => `<th>${p}</th>`).join('')}<th>total</th></tr></thead><tbody>${bars.map((b) => `<tr><td class="mono">${esc(short(b.repo))} ${esc(b.id)}</td><td>${b.n}</td><td>${esc(b.v)}</td><td class="num">${dur(b.t.builder)}</td><td class="num">${dur(b.t.baseline)}</td><td class="num">${dur(b.t.reviewer)}</td><td class="num">${dur(b.t.mutations)}</td><td class="num">${dur(Math.max(0, b.t.total - b.t.builder - b.t.baseline - b.t.reviewer - b.t.mutations))}</td><td class="num">${dur(b.t.total)}</td></tr>`).join('')}</tbody></table></div></details>
    </div>
    <div class="repos" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div class="tbl"><h3 style="margin-bottom:6px">Per agent and model</h3><table><thead><tr><th>role</th><th>model</th><th>rounds</th><th>median</th><th>p90</th><th>builder cost</th></tr></thead><tbody>${modelRows}</tbody></table><p class="caption">Seconds from the Machine block; cost from <code>builder*.json</code> (Claude only; codex reports none). ${src('machine')}</p></div>
      <div><h3 style="margin-bottom:6px">Rounds per story</h3>${['1', '2', '3', '4+'].map((k) => `<div class="bar" style="gap:8px;margin:3px 0"><span class="mono" style="width:22px">${k}</span><div style="flex:1;height:14px;background:var(--surface-2);border-radius:3px;overflow:hidden"><div style="height:100%;width:${(100 * (roundsHist[k] || 0)) / Math.max(1, rows.length)}%;background:var(--c-builder);border-radius:0 3px 3px 0"></div></div><span class="num" style="width:28px;text-align:right">${roundsHist[k] || 0}</span></div>`).join('')}<p class="caption">From each story's <code>round:</code> ${src('machine')}.</p></div>
    </div>
  </section>`;
}

// ── backlog ─────────────────────────────────────────────────────────────────
const SINCE = { draft: 'drafted', ready: 'ready since', blocked: 'asked', needs_human: 'stopped' };
function intentHTML(s) {
  if (s.intent) return `<div class="intent"><div class="bar" style="gap:6px"><span class="eyebrow">Intent</span>${src(s.intent.src)}</div><p class="clamp">${esc(s.intent.text)}</p></div>`;
  return `<div class="intent"><div class="bar" style="gap:6px"><span class="eyebrow">Intent</span>${src('unknown')}<span class="caption">not recorded · the Symptom stands in</span></div><p class="clamp">${inlineCode(s.symptom || '—')}</p></div>`;
}
function bcard(it, extra = '') {
  const { repo, id, x, s } = it;
  return `<article class="bcard ${P(repo).cls}">
    <div class="bar" style="gap:6px 8px">${ptag(repo, id)}${stateChip(x.state)}<code class="caption">${esc(s.epic || REPO(repo).baseBranch)}</code></div>
    <button class="linkbtn story-title" data-act="story" data-k="${esc(repo)}/${esc(id)}">${esc(s.title)}</button>
    ${intentHTML(s)}
    <div class="caption">${SINCE[x.state] || esc(x.state)} ${when(x.since, M.at)} · ${x.since ? dur(between(x.since, M.at)) : '—'} ago ${src('git')}</div>
    ${extra}
  </article>`;
}
function backlogHTML() {
  let noIntent = 0;
  const sections = D.repos.map(({ name }) => {
    const R = M.repos[name];
    if (!R || !R.registered) return unregistered(name);
    const B = backlogOf(name);
    for (const it of [...B.person, ...B.draft, ...B.ready]) if (!it.s.intent) noIntent += 1;
    const person = B.person.map((it) => bcard(it, it.x.state === 'blocked'
      ? `${it.s.question ? `<div class="caption">.blocked/${esc(it.id)}.md: “${esc(it.s.question)}”</div>` : ''}<div class="cmd">/answer ${esc(name)} ${esc(it.id)} &lt;your answer&gt;</div>`
      : `${R.stops[it.id] ? `<div class="caption">${esc(R.stops[it.id].msg)} ${src(R.stops[it.id].src)}</div>` : ''}<div class="cmd">fleet status ${esc(name)} ${esc(it.id)}</div>`)).join('');
    const drafts = B.draft.map((it) => bcard(it, `<div class="cmd">fleet lint-story ${esc(name)} ${esc(it.id)} · fleet promote ${esc(name)} ${esc(it.id)}</div>`)).join('');
    const ready = B.ready.map((it, k) => bcard(it, `<div class="bar" style="gap:6px">${chip('clock', k === 0 ? 'next to run' : `#${k + 1} in the queue`, 'run')}${B.running.length ? `<span class="caption">after ${sid(name, B.running[0].id)}, which runs now</span>` : ''}</div>`)).join('');
    const lane = (title, sub, body) => `<div class="lane"><div class="col-h"><span class="eyebrow">${title}</span><span class="caption">${sub}</span></div>${body || '<div class="empty">none</div>'}</div>`;
    const total = B.person.length + B.draft.length + B.ready.length;
    const run = B.running.length ? chip('run', `running ${P(name).tag}/${B.running[0].id}`, 'run') : chip('pause', 'nothing runs', 'neutral');
    return `<section class="panel proj ${P(name).cls}" aria-label="${esc(name)} backlog">${projHead(name, `<span class="caption">${total} waiting</span>${run}`)}<div class="proj-b">${total
      ? `<div class="lanes">${lane('Waits for a person', 'blocked · needs human', person)}${lane('Draft', 'written, not promoted', drafts)}${lane('Ready', 'the queue takes the lowest id first', ready)}</div>`
      : emptyBacklog(name)}</div></section>`;
  });
  const note = noIntent ? `<div class="note">${icon('doc')}<span>${noIntent === 1 ? 'One story here has' : `${noIntent} stories here have`} no recorded intent: written before the event log. Its card shows the story's Symptom in its place. <code>fleet write-story</code> keeps the intent on the writer's start event from now on.</span></div>` : '';
  return `${note}<div class="projects">${sections.join('')}</div>`;
}

// ── epics ───────────────────────────────────────────────────────────────────
function epicsListHTML() {
  return `<div class="projects">${D.repos.map(({ name }) => {
    if (!M.repos[name]?.registered) return unregistered(name);
    const eps = epicRows(name);
    const open = eps.filter((e) => e.open).sort((a, b) => ms(b.start || 0) - ms(a.start || 0));
    const landed = eps.filter((e) => !e.open).sort((a, b) => ms(b.landedAt || 0) - ms(a.landedAt || 0));
    const k = (e) => `${esc(name)}|${esc(e.name)}`;
    const state = (e) => (e.open ? chip('merge', 'open', 'run') : chip('check', 'landed', 'good'));
    const span = (e) => (e.landedAt && e.start ? dur(between(e.start, e.landedAt)) : e.start ? `${dur(between(e.start, M.at))} so far` : '—');
    const row = (e) => `<tr><td><button class="epic-name" data-act="epic" data-k="${k(e)}">${esc(e.name)}</button></td><td>${state(e)}</td><td class="num">${e.members.length}</td><td style="min-width:220px">${e.members.length ? progress(e.counts, e.members.length) : '<span class="caption">no story yet</span>'}</td><td class="num">${e.start ? when(e.start, M.at) : '—'}</td><td class="num">${e.landedAt ? when(e.landedAt, M.at) : '—'}</td><td class="num">${span(e)}</td></tr>`;
    const card = (e) => `<article class="scard"><div class="bar"><button class="epic-name" data-act="epic" data-k="${k(e)}">${esc(e.name)}</button>${state(e)}</div>${e.members.length ? progress(e.counts, e.members.length) : ''}<div class="facts"><span>stories <b>${e.members.length}</b></span><span>created <b>${e.start ? when(e.start, M.at) : '—'}</b></span><span>landed <b>${e.landedAt ? when(e.landedAt, M.at) : '—'}</b></span><span>took <b>${span(e)}</b></span></div></article>`;
    const all = [...open, ...landed];
    return `<section class="panel proj ${P(name).cls}" aria-label="${esc(name)} epics">${projHead(name, `<span class="caption">${open.length} open · ${landed.length} landed</span>`)}<div class="proj-b">
      <div class="tbl table-wide"><table><thead><tr><th>epic</th><th>state</th><th>stories</th><th>progress</th><th>created</th><th>landed</th><th>created → landed</th></tr></thead><tbody>${all.map(row).join('')}</tbody></table></div>
      <div class="cards">${all.map(card).join('')}</div>
      <p class="caption" style="margin:0">Created: when <code>fleet new-epic</code> made the branch, from the log or this checkout's reflog ${src('git')}. Landed: the epic's merge into the integration branch ${src('git')}. Select an epic for its stories in time order.</p>
    </div></section>`;
  }).join('')}</div>`;
}

// A story's life on the epic, from its status commits: one segment per state.
const SEGWORD = { draft: 'draft', ready: 'ready · queued', in_progress: 'in progress', blocked: 'blocked · waits for an answer', needs_human: 'needs human', done: 'done · not merged yet', 'on epic': 'on the epic · waits for the land', declined: 'declined' };
function storySegs(s, landTs, atT) {
  const segs = [];
  let cur = null;
  for (const h of s.history) {
    const t = ms(h.ts);
    if (t > atT) break;
    if (h.kind === 'reverted') continue;
    const st = h.kind === 'merged' ? 'on epic' : ['promoted', 'answered'].includes(h.kind) ? 'ready' : h.kind;
    if (cur && cur.st === st) continue;
    if (cur) { cur.to = t; segs.push(cur); }
    cur = { st, from: t };
  }
  if (!cur) return segs;
  if (cur.st === 'on epic') {
    const l = landTs.find((x) => x >= cur.from);
    cur.open = !(l != null && l <= atT);
    cur.to = cur.open ? atT : l;
  } else if (cur.st === 'declined') cur.to = cur.from;
  else { cur.to = atT; cur.open = true; }
  segs.push(cur);
  return segs;
}

function chronoHTML(name, E) {
  const atT = ms(M.at);
  const label = M.now ? 'now' : when(M.at, isoAt(Date.now()));
  const landTs = E.lands.map((l) => ms(l.ts)).sort((a, b) => a - b);
  const land = landTs.filter((t) => t <= atT).pop() ?? null;
  const rows = E.stories.map((id) => ({ id, s: STORY(name, id) })).filter((r) => r.s).map((r) => ({ ...r, segs: storySegs(r.s, landTs, atT) })).filter((r) => r.segs.length)
    .sort((a, b) => a.segs[0].from - b.segs[0].from || a.id.localeCompare(b.id));
  if (!rows.length) return '<div class="empty">No story on this epic yet at this moment.</div>';
  const created = E.created && ms(E.created.ts) <= atT ? ms(E.created.ts) : null;
  const t0 = Math.min(created ?? Infinity, ...rows.map((r) => r.segs[0].from));
  const t1 = Math.max(land ?? 0, t0 + 60e3, ...rows.flatMap((r) => r.segs.map((g) => g.to)));
  const pad = (t1 - t0) * 0.015;
  const T0 = t0 - pad; const T1 = t1 + pad;
  const x = (t) => (100 * (t - T0)) / (T1 - T0);
  const STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map((m) => m * 60e3);
  const step = STEPS.find((st) => (T1 - T0) / st <= 7) || 20160 * 60e3;
  const offMs = -new Date(T0).getTimezoneOffset() * 60e3;
  const ticks = [];
  for (let L = Math.ceil((T0 + offMs) / step) * step; L <= T1 + offMs; L += step) ticks.push(L - offMs);
  let prevDay = null;
  const tickLab = ticks.map((t) => {
    const iso = isoAt(t); const day = iso.slice(0, 10);
    const lab = step >= 1440 * 60e3 ? dayOf(iso) : day !== prevDay ? `${dayOf(iso)} ${hm(iso)}` : hm(iso);
    prevDay = day;
    return x(t) > 90 ? '' : `<span style="left:${x(t)}%">${lab}</span>`;
  }).join('');
  const marks = [];
  if (created != null) marks.push({ t: created, cls: 'created', c: 'var(--muted)', lab: `created ${when(isoAt(created), M.at)}` });
  if (land != null) marks.push({ t: land, cls: 'landed', c: 'var(--good)', lab: `landed in ${REPO(name).baseBranch} ${when(isoAt(land), M.at)}` });
  if (rows.some((r) => r.segs[r.segs.length - 1].open)) marks.push({ t: atT, cls: 'moment', c: 'var(--accent)', lab: `moment: ${label}` });
  const markLab = marks.map((m) => `<span class="${x(m.t) > 60 ? 'r' : ''}" style="left:${x(m.t)}%;color:${m.c}">${esc(m.lab)}</span>`).join('');
  const grid = `<div class="ch-grid">${ticks.map((t) => `<span class="tk" style="left:${x(t)}%"></span>`).join('')}${marks.map((m) => `<span class="mk ${m.cls}" style="left:${x(m.t)}%"></span>`).join('')}</div>`;
  const rowsHTML = rows.map((r) => {
    const segs = r.segs.map((g) => {
      const a = x(g.from); const w = Math.max(0, x(g.to) - a);
      const tip = `${P(name).tag}/${r.id} · ${SEGWORD[g.st] || g.st}\n${when(isoAt(g.from), M.at, true)} → ${g.open ? `${label}, still` : when(isoAt(g.to), M.at, true)} · ${dur((g.to - g.from) / 1000)}`;
      if (g.st === 'on epic') return `<span class="ch-line" style="left:${a}%;width:${w}%"></span><span class="ch-hit" style="left:${a}%;width:max(6px, ${w}%)" data-tip="${esc(tip)}"></span>`;
      if (g.st === 'declined') return `<span class="ch-seg" style="left:${a}%;width:3px;background-color:var(--neutral)" data-tip="${esc(tip)}"></span>`;
      return `<span class="ch-seg ${['draft', 'ready'].includes(g.st) ? 'hatch' : ''}" style="left:${a}%;width:${w}%;background-color:${col((STATE[g.st] || {}).sw || '--c-other')}" data-tip="${esc(tip)}"></span>`;
    }).join('');
    const said = r.segs.map((g) => `${SEGWORD[g.st] || g.st} from ${when(isoAt(g.from), M.at)}`).join(', ');
    return `<div class="ch-row"><div class="ch-lab">${sid(name, r.id)}<button class="linkbtn" data-act="story" data-k="${esc(name)}/${esc(r.id)}" title="${esc(r.s.title)}">${esc(r.s.title)}</button></div><div class="ch-track" role="img" aria-label="${esc(`${P(name).tag}/${r.id}: ${said}`)}">${segs}</div></div>`;
  }).join('');
  const present = ['draft', 'ready', 'in_progress', 'blocked', 'needs_human', 'done'].filter((st) => rows.some((r) => r.segs.some((g) => g.st === st)));
  const legend = `<div class="legend">${present.map((st) => `<span><i class="sw ${['draft', 'ready'].includes(st) ? 'hatch' : ''}" style="background-color:${col(STATE[st].sw)}"></i>${SEGWORD[st]}</span>`).join('')}<span><i class="sw" style="height:2px;width:16px;vertical-align:3px;background:var(--good)"></i>on the epic</span><span><i class="sw" style="width:0;height:12px;border-left:2px dashed var(--muted);border-radius:0"></i>epic created</span><span><i class="sw" style="width:0;height:12px;border-left:2px solid var(--good);border-radius:0"></i>epic landed</span></div>`;
  const first = (s, kinds, last) => { const hs = s.history.filter((h) => kinds.includes(h.kind) && ms(h.ts) <= atT); const h = last ? hs[hs.length - 1] : hs[0]; return h ? h.ts : null; };
  const table = `<details data-k="${dk()}"><summary class="caption" style="cursor:pointer">Table view</summary><div class="tbl"><table><thead><tr><th>story</th><th>drafted</th><th>ready</th><th>picked up</th><th>done</th><th>merged on the epic</th><th>then waited for the land</th></tr></thead><tbody>${rows.map((r) => {
    const m = first(r.s, ['merged']); const l = m ? landTs.find((t) => t >= ms(m) && t <= atT) : null;
    return `<tr><td>${sid(name, r.id)}</td><td class="num">${when(first(r.s, ['draft']), M.at)}</td><td class="num">${when(first(r.s, ['ready', 'promoted']), M.at)}</td><td class="num">${when(first(r.s, ['in_progress']), M.at)}</td><td class="num">${when(first(r.s, ['done'], true), M.at)}</td><td class="num">${when(m, M.at)}</td><td class="num">${l != null ? dur((l - ms(m)) / 1000) : '—'}</td></tr>`;
  }).join('')}</tbody></table></div></details>`;
  return `${legend}<div class="chrono"><div class="ch-head"><div class="ch-lab"></div><div><div class="ch-marks">${markLab}</div><div class="ch-axis">${tickLab}</div></div></div><div class="ch-body">${grid}${rowsHTML}</div></div>
    <p class="caption" style="margin:0">Each bar runs from the story's first status commit to its merge on the epic. Hatched: it waits (a draft, or ready in the queue). Solid: it is worked on, or it waits for a person. The thin line: on the epic, until the epic lands. All times: status commits ${src('git')}.</p>${table}`;
}

function epicDetailHTML(key) {
  const [name, epic] = key.split('|');
  const R = REPO(name);
  const SR = M.repos[name];
  const E = R?.epics.find((e) => e.name === epic);
  const back = '<div class="bar"><button class="linkbtn" data-act="epics" data-k="">← all epics</button></div>';
  const row = E && SR?.registered ? epicRows(name).find((e) => e.name === epic) : null;
  if (!row) return `${back}<section class="panel proj ${P(name).cls}">${R ? projHead(name) : ''}<div class="proj-b"><p style="margin:0"><code>${esc(epic)}</code> did not exist at this moment. Pick a later one.</p></div></section>`;
  const atT = ms(M.at);
  const ids = E.stories.filter((id) => SR.states[id]);
  const counts = {}; for (const id of ids) counts[SR.states[id].state] = (counts[SR.states[id].state] || 0) + 1;
  const rows = ids.map((id) => {
    const s = STORY(name, id); const x = SR.states[id]; const run = SR.running[id];
    const roundsAt = s.rounds.filter((r) => r.reviewed && ms(r.reviewed) <= atT);
    const last = roundsAt[roundsAt.length - 1];
    const roundTime = roundsAt.reduce((a, r) => a + (r.timing ? r.timing.total : 0), 0);
    const who = run ? (run.dead ? `${chip('dead', 'dead', 'crit')}${run.dead.ts ? ` <span class="caption">since ${when(run.dead.ts, M.at)}</span>` : ''}` : `${chip('run', run.pass ? `${run.agent || 'harness'}${run.model ? ` ${run.model}` : ''}` : 'harness', 'run')}<div class="caption">${esc(run.pass || 'between passes')}${run.since ? ` · ${dur(between(run.since, M.at))}` : ''}</div>`) : '<span class="muted">—</span>';
    const wait = s.queueWaitS != null && s.pickedAt && ms(s.pickedAt) <= atT ? dur(s.queueWaitS) : '—';
    const merged = s.mergedAt && ms(s.mergedAt) <= atT ? when(s.mergedAt, M.at) : '—';
    return { id, s, x, last, roundTime, who, wait, merged, roundsAt, run };
  });
  const r1 = rows.filter((r) => r.roundsAt.some((q) => q.n === 1));
  const pass1 = r1.filter((r) => r.roundsAt.find((q) => q.n === 1).computed === 'PASS').length;
  const launches = ids.reduce((a, id) => a + STORY(name, id).history.filter((h) => h.kind === 'in_progress' && ms(h.ts) <= atT).length, 0);
  const facts = [
    ['created', row.created ? when(row.created.ts, M.at) : 'unknown'], ['first story', row.firstDraft ? when(row.firstDraft, M.at) : '—'],
    ['landed', row.landedAt ? when(row.landedAt, M.at) : 'not yet'], ['created → landed', row.landedAt && row.start ? dur(between(row.start, row.landedAt)) : row.start ? `${dur(between(row.start, M.at))} so far` : '—'],
    ['stories', String(ids.length)], ['launches', String(launches)], ['round-1 PASS', r1.length ? `${pass1} of ${r1.length}` : '—'],
  ];
  const table = `<div class="tbl table-wide"><table><thead><tr><th>story</th><th>title</th><th>status</th><th>round</th><th>verdict</th><th>working now</th><th class="hide-narrow">queue wait</th><th class="hide-narrow">round time</th><th>merged on the epic</th></tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${sid(name, r.id)}</td>
      <td style="max-width:320px"><button class="linkbtn story-title" data-act="story" data-k="${esc(name)}/${esc(r.id)}">${esc(r.s.title)}</button></td>
      <td>${stateChip(r.x.state)}<div class="caption">${when(r.x.since, M.at)} ${src('git')}</div></td>
      <td class="num">${r.run?.round ?? (r.roundsAt.length ? r.last.n : '—')}</td>
      <td>${r.last ? verdictChip(r.last.computed) : '<span class="muted">—</span>'}${r.last && r.last.reasons.length ? `<div class="caption">${esc(r.last.reasons.join('; '))}</div>` : ''}</td>
      <td>${r.who}</td>
      <td class="num hide-narrow">${r.wait}</td>
      <td class="num hide-narrow">${r.roundTime ? dur(r.roundTime) : '—'}</td>
      <td class="num">${r.merged}</td></tr>`).join('')}</tbody></table></div>`;
  const cards = `<div class="cards">${rows.map((r) => `<article class="scard"><div class="bar">${sid(name, r.id)}${stateChip(r.x.state)}${r.last ? verdictChip(r.last.computed) : ''}</div><button class="linkbtn story-title" data-act="story" data-k="${esc(name)}/${esc(r.id)}">${esc(r.s.title)}</button><div class="facts"><span>round <b>${r.last ? r.last.n : '—'}</b></span><span>round time <b>${r.roundTime ? dur(r.roundTime) : '—'}</b></span><span>merged <b>${r.merged}</b></span></div>${r.run ? `<div>${r.who}</div>` : ''}${r.last && r.last.reasons.length ? `<div class="caption">${esc(r.last.reasons.join('; '))}</div>` : ''}</article>`).join('')}</div>`;
  const state = row.open ? chip('merge', `open · lands by /merge ${name} ${epic}`, 'run') : chip('check', `landed in ${R.baseBranch}`, 'good');
  return `${back}<section class="panel proj ${P(name).cls}" aria-label="${esc(name)} ${esc(epic)}">${projHead(name)}<div class="proj-b">
    <div class="bar"><h2 style="font-family:var(--font-mono);font-stretch:100%">${esc(epic)}</h2>${state}</div>
    <div class="facts">${facts.map(([k, v]) => `<span>${k} <b>${esc(v)}</b></span>`).join('')}</div>
    <div style="display:grid;gap:8px"><h3>In time order</h3>${chronoHTML(name, E)}</div>
    <div style="display:grid;gap:8px"><h3>The stories</h3>${progress(counts, ids.length)}${table}${cards}</div>
    <p class="caption" style="margin:0">Status times: status commits ${src('git')}. Verdicts, rounds and round time: the Machine blocks ${src('machine')}. Working now: the event log ${src('log')}, or the journal ${src('journal')}.</p>
  </div></section>`;
}

// ── landed ──────────────────────────────────────────────────────────────────
function roundsPath(s) {
  if (!s.rounds.length) return `<span class="caption">${s.round ?? '—'} ${s.round === 1 ? 'round' : 'rounds'} · no Machine block</span>`;
  if (s.round === 1 && s.rounds[0].computed === 'PASS') return chip('check', 'PASS in round 1', 'good');
  return `<span class="caption">${s.round ?? s.rounds.length} rounds: ${s.rounds.map((r) => `r${r.n} ${esc(r.computed || '?')}`).join(' → ')}</span>`;
}
function landedHTML() {
  const all = [];
  for (const [name, R] of Object.entries(M.repos)) {
    if (!R.registered) continue;
    for (const [id, x] of Object.entries(R.states)) if (x.state === 'landed' && STORY(name, id)) all.push({ repo: name, id, s: STORY(name, id), at: x.since });
  }
  const rows = all.filter((r) => S.landedRepo === 'all' || S.landedRepo === r.repo).sort((a, b) => ms(b.at || 0) - ms(a.at || 0) || b.id.localeCompare(a.id));
  const shown = S.landedAll ? rows : rows.slice(0, 40);
  const leads = rows.map((r) => (r.s.readyAt && r.at && ms(r.s.readyAt) <= ms(r.at) ? between(r.s.readyAt, r.at) : null));
  const names = Object.keys(M.repos).filter((n) => M.repos[n].registered);
  const tiles = [[String(rows.length), S.landedRepo === 'all' ? 'landed, all projects' : `landed, ${short(S.landedRepo)}`, 'git'], [String(rows.filter((r) => r.at && ms(M.at) - ms(r.at) <= 7 * 86400e3).length), 'in the 7 days before the moment', 'git'], [dur(median(leads)), 'ready → landed (median)', 'git'], [dur(pct(leads, 0.9)), 'ready → landed (p90)', 'git']];
  const filt = `<div class="seg" role="group" aria-label="Project">${['all', ...names].map((n) => `<button data-act="landedrepo" data-k="${esc(n)}" aria-pressed="${S.landedRepo === n}">${n === 'all' ? 'all projects' : `${esc(P(n).mono)} · ${esc(short(n))}`}</button>`).join('')}</div>`;
  let day = null;
  const out = [];
  for (const r of shown) {
    const d = r.at ? r.at.slice(0, 10) : '';
    if (d !== day) { day = d; out.push(`<div class="ll-day"><b>${r.at ? dayOf(r.at) : 'time unknown'}</b><span class="caption">${rows.filter((q) => (q.at ? q.at.slice(0, 10) : '') === d).length} landed</span></div>`); }
    const how = r.s.epic ? `with <code>${esc(r.s.epic)}</code>` : r.s.landedHow === 'built on the branch' ? `built on <code>${esc(REPO(r.repo).baseBranch)}</code>, before merge commits` : `merged into <code>${esc(REPO(r.repo).baseBranch)}</code>`;
    out.push(`<div class="ll-row ${P(r.repo).cls}"><span class="t">${hm(r.at)}</span><span class="who">${ptag(r.repo, r.id)}</span><span class="ttl"><button class="linkbtn story-title" data-act="story" data-k="${esc(r.repo)}/${esc(r.id)}">${esc(r.s.title)}</button><span class="caption">${how}</span></span><span class="rp">${roundsPath(r.s)}</span><span class="lead num" title="ready → landed">${r.s.readyAt && r.at && ms(r.s.readyAt) <= ms(r.at) ? dur(between(r.s.readyAt, r.at)) : '—'}</span></div>`);
  }
  return `<section class="panel" style="display:grid;gap:12px">
    <div class="bar"><h2>Landed stories</h2><span class="caption">newest first · on the integration branch at this moment</span><span class="grow"></span>${filt}</div>
    <div class="tiles">${tiles.map(([v, l, s]) => `<div class="tile"><span class="v num">${esc(v)}</span><span class="l">${esc(l)}</span><span>${src(s)}</span></div>`).join('')}</div>
    <div class="ll"><div class="ll-row hd"><span class="t">time</span><span class="who">story</span><span class="ttl">title · how it landed</span><span class="rp">rounds</span><span class="lead">ready → landed</span></div>${out.join('') || '<div class="empty">Nothing landed yet at this moment.</div>'}</div>
    ${rows.length > shown.length ? `<button class="linkbtn" data-act="landedall" data-k="">show all ${rows.length}</button>` : ''}
    <p class="caption" style="margin:0">Landed: the epic's merge into the integration branch, or the story's own merge ${src('git')}. Rounds: the Machine blocks ${src('machine')}.</p>
  </section>`;
}

// ── story: its life as an event log ─────────────────────────────────────────
function rowHTML(o, ref) {
  const st = o.start ? o.start.ts : null; const en = o.end ? o.end.ts : null;
  const running = o.open && M.now;
  const secs = st && en ? between(st, en) : st && running ? between(st, M.at) : null;
  const endCell = en ? `${when(en, ref, true)} ${src(o.end.src)}` : o.open ? '<span class="muted">no end yet</span>' : '<span class="muted">unknown</span>';
  const tcell = `<div class="t"><span class="day">${st ? when(st, ref, true) : '<span class="muted">unknown</span>'}</span> ${st ? src(o.start.src) : ''}<br><span class="muted">→</span> ${endCell}</div>`;
  const barW = secs != null ? Math.min(100, Math.max(2, (100 * Math.sqrt(secs)) / Math.sqrt(1800))) : 0;
  const color = col(PHASE[o.pass] || '--c-other');
  const who = o.agent ? `<span class="caption">${esc(o.agent)}${o.model ? ` · ${esc(o.model)}` : ''}${o.modelUsed ? ` → ${esc(o.modelUsed)}` : ''}</span>` : '';
  const approx = o.approx ? '<span class="caption" title="placed by a reader from the Machine block\'s seconds; the order of phases is assumed">≈ approximate</span>' : '';
  return `<div class="lrow">${tcell}<div class="d num">${secs != null ? `${dur(secs)}${running ? '…' : ''}` : '—'}</div><div class="w"><div class="h"><b>${esc(o.title)}</b>${who}${resultChip(o.pass, o.result)}${o.open ? (running ? chip('run', 'running', 'run') : chip('dead', 'no end', 'crit')) : ''}${approx}</div>${secs != null ? `<div class="dbar" title="duration on a square-root scale, 30 min = full"><span style="width:${barW}%;background:${color}"></span></div>` : ''}${o.reason ? `<div class="why">${esc(o.reason)}</div>` : ''}${o.evidence ? `<div class="ev">${esc(o.evidence)}</div>` : ''}</div></div>`;
}
const markHTML = (m, ref) => `<div class="lrow"><div class="t"><span class="day">${when(m.ts, ref, true)}</span> ${src(m.src)}</div><div class="d"></div><div class="w"><div class="h">${chip(m.ic || 'dot', m.title, m.tone || 'neutral')}</div>${m.why ? `<div class="why">${esc(m.why)}</div>` : ''}</div></div>`;
function passHTML(p, ref) {
  if (!p.children || !p.children.length) return rowHTML(p, ref);
  const bad = p.children.some((c) => (c.pass === 'mutation' || c.pass === 'tdd') ? c.result && c.result !== 'RED' : c.pass === 'probe' ? c.result && c.result !== 'GREEN' : c.result && /RED|FAIL/.test(c.result));
  return `<details class="sub" data-k="${dk()}"${bad ? ' open' : ''}><summary>${rowHTML({ ...p, title: `▸ ${p.title}` }, ref)}</summary><div class="inner">${p.children.map((c) => rowHTML(c, ref)).join('')}</div></details>`;
}
const rowsHTML = (rows, ref) => rows.map((r) => (r.kind === 'mark' ? markHTML(r.m, ref) : passHTML(r.p, ref))).join('');
function roundHTML(r, ref, open) {
  const secs = r.start && r.end ? between(r.start.ts, r.end.ts) : null;
  const head = r.result ? verdictChip(r.result) : open ? (M.now ? chip('run', 'running', 'run') : chip('run', 'open', 'run')) : chip('dead', 'no end', 'crit');
  const machine = r.machine ? `<details class="machine" data-k="${dk()}"><summary>Machine block — round ${r.n}</summary><pre>${esc(r.machine)}</pre></details>` : '';
  return `<div class="lgroup"><div class="gh"><h3>Round ${r.n}</h3>${head}<span class="caption num">${secs != null ? dur(secs) : ''}</span>${r.reasons ? `<span class="caption">${esc(r.reasons)}</span>` : ''}</div><div class="inner">${rowsHTML(r.rows, ref)}${machine}</div></div>`;
}
function launchHTML(l, ref) {
  const endTs = l.end ? l.end.ts : l.dead && l.dead.ts ? l.dead.ts : null;
  const secs = endTs ? between(l.start.ts, endTs) : l.state === 'running' && M.now ? between(l.start.ts, M.at) : null;
  const state = l.state === 'dead' ? chip('dead', 'launcher died', 'crit') : l.state === 'running' ? chip('run', 'running', 'run') : l.result ? `<span class="caption">→ ${esc(l.result)}${l.reason && l.reason !== l.result ? ` · ${esc(l.reason)}` : ''}</span>` : '';
  const when0 = `<span class="caption">${when(l.start.ts, ref, true)} ${src(l.start.src)}${l.end ? ` → ${when(l.end.ts, ref, true)} ${src(l.end.src)}` : ''}</span>`;
  const dead = l.dead ? `<div class="gap dead">${icon('dead')}<span>${l.dead.ts ? `${when(l.dead.ts, ref, true)} ${src(l.dead.src)} — ` : ''}${esc(l.dead.why)}. A launch start with no end and its pid gone is a launcher that died; the next drain returns the story to the queue.</span></div>` : '';
  const lastOpen = l.state !== 'ended';
  return `<div class="lgroup"><div class="gh"><h3>Launch ${l.k}</h3><span class="caption mono">${l.pid ? `pid ${esc(l.pid)}` : 'pid not recorded'}</span><span class="caption num">${secs != null ? dur(secs) : ''}</span>${state}${when0}</div><div class="inner">
    ${l.pre.map((p) => passHTML(p, ref)).join('')}
    ${l.rounds.map((r, i) => roundHTML(r, ref, lastOpen && i === l.rounds.length - 1)).join('')}
    ${!l.rounds.length && !l.pre.length ? '<p class="caption" style="margin:6px 0">No pass of this launch is recorded: it ran before the event log, and the journal no longer has it.</p>' : ''}
    ${dead}
    ${l.after.map((p) => passHTML(p, ref)).join('')}
  </div></div>`;
}
function logHTML(life) {
  const first = life.entries.find((e) => (e.kind === 'mark' && e.m.ts) || (e.kind === 'launch') || (e.kind === 'row' && (e.p.start || e.p.end)));
  const ref = first ? (first.kind === 'mark' ? first.m.ts : first.kind === 'launch' ? first.l.start.ts : (first.p.start || first.p.end).ts) : M.at;
  const html = life.entries.map((e) => {
    if (e.kind === 'row') return passHTML(e.p, ref);
    if (e.kind === 'mark') return markHTML(e.m, ref);
    if (e.kind === 'note') return `<p class="caption" style="padding:8px 0">${esc(e.text)}</p>`;
    if (e.kind === 'gap') return `<div class="gap">${icon('hourglass')}<span class="num">${dur(e.secs)}</span><span>${esc(e.why)}</span></div>`;
    if (e.kind === 'launch') return launchHTML(e.l, ref);
    if (e.kind === 'group') {
      const secs = e.start && e.end ? between(e.start.ts, e.end.ts) : null;
      return `<div class="lgroup"><div class="gh"><h3>${esc(e.title)}</h3>${e.result ? resultChip('epic_merge', e.result) : ''}<span class="caption">${secs ? dur(secs) : ''}</span></div><div class="inner">${rowsHTML(e.rows, ref)}</div></div>`;
    }
    return '';
  }).join('');
  return `<div class="log">${html}</div>`;
}

/** The stories worth a click: what runs, then the last ones to change. */
function recentStories() {
  const out = [];
  for (const R of D.repos) for (const s of R.stories) {
    const last = s.history[s.history.length - 1];
    const run = M.repos[R.name]?.running[s.id];
    out.push({ k: `${R.name}/${s.id}`, repo: R.name, s, t: run ? Infinity : last ? ms(last.ts) : 0 });
  }
  return out.sort((a, b) => b.t - a.t);
}

function storyHTML() {
  const recent = recentStories();
  if (!S.story || !STORY(...S.story.split('/'))) S.story = recent[0]?.k ?? null;
  if (!S.story) return '<div class="empty">No story yet.</div>';
  const [repo, id] = S.story.split('/');
  const s = STORY(repo, id);
  const picker = `<div class="pickers"><div class="picker" role="group" aria-label="Recent stories">${recent.slice(0, 6).map((r) => `<button class="pick" data-act="story" data-k="${esc(r.k)}" aria-pressed="${S.story === r.k}">${ptag(r.repo, r.s.id)}<small>${esc(STATE[stateOf(r.repo, r.s.id)]?.word ?? stateOf(r.repo, r.s.id) ?? '')}</small></button>`).join('')}</div>
    <label class="caption">any story <select class="storysel" id="storysel">${D.repos.map((R) => `<optgroup label="${esc(R.name)}">${[...R.stories].reverse().map((x) => `<option value="${esc(R.name)}/${esc(x.id)}"${S.story === `${R.name}/${x.id}` ? ' selected' : ''}>${esc(short(R.name))}/${esc(x.id)} — ${esc(x.title.slice(0, 60))}</option>`).join('')}</optgroup>`).join('')}</select></label></div>`;
  const got = LIFE.get(S.story);
  const lastR = s.rounds[s.rounds.length - 1];
  const facts = [
    ['builder model', lastR && lastR.builderModel ? `${lastR.builderModel}${lastR.builderUsed ? ` → ${lastR.builderUsed}` : ''}` : s.model || 'not recorded'],
    ['rounds', s.round == null ? '—' : String(s.round)],
    s.epic ? ['ready → merged on the epic', s.readyAt && s.mergedAt ? dur(between(s.readyAt, s.mergedAt)) : '—'] : ['ready → done', s.readyAt && s.doneAt ? dur(between(s.readyAt, s.doneAt)) : '—'],
    ['queue wait', s.queueWaitS != null ? dur(s.queueWaitS) : '—'],
    ['landed', s.landedAt ? when(s.landedAt, s.readyAt || s.landedAt) : '—'],
  ];
  const byAc = {}; if (lastR) for (const m of lastR.mutations) { (byAc[m.ac] ||= { red: 0, n: 0 }); byAc[m.ac].n += 1; if (m.cls === 'RED') byAc[m.ac].red += 1; }
  const aside = `<aside class="aside">
    <section class="panel" style="display:grid;gap:6px"><div class="bar" style="gap:6px"><span class="eyebrow">Intent</span>${src(s.intent ? s.intent.src : 'unknown')}</div>${s.intent ? `<p style="margin:0">${esc(s.intent.text)}</p><span class="caption">given to the writer ${when(s.intent.ts, s.intent.ts)}${s.intent.model ? ` · ${esc(s.intent.model)}` : ''}</span>` : '<p style="margin:0" class="muted">Not recorded: the story was written before the event log.</p>'}<div class="eyebrow" style="margin-top:6px">Symptom, from the story</div><p style="margin:0;font-size:13.5px">${inlineCode(s.symptom || '—')}</p></section>
    <section class="panel"><div class="eyebrow" style="margin-bottom:4px">Acceptance criteria · last round's mutations</div>${s.acs.map((a) => `<div class="ac"><b>${esc(a.id)}</b><span>${esc(a.claim.length > 220 ? `${a.claim.slice(0, 220)}…` : a.claim)}${byAc[a.id] ? `<br>${byAc[a.id].red === byAc[a.id].n ? chip('check', `${byAc[a.id].n} RED · caught`, 'good') : chip('x', `${byAc[a.id].red}/${byAc[a.id].n} RED`, 'crit')}` : ''}</span></div>`).join('') || '<p class="caption">No criteria found.</p>'}</section>
  </aside>`;
  const sources = got && !got.error ? `Times from: ${got.life.sources.map((x) => src(x)).join(' ')}. Hover a source for what it is.` : '';
  const body = !got ? '<p class="caption">Reading the story…</p>' : got.error ? `<div class="err">${esc(got.error)}</div>` : logHTML(got.life);
  return `${picker}
  <section class="panel proj ${P(repo).cls}">${projHead(repo)}<div class="proj-b" style="gap:10px">
    <div class="bar">${ptag(repo, id)}${stateChip(stateOf(repo, id))}${verdictChip(s.verdict)}${s.epic ? `<button class="epic-name" data-act="epic" data-k="${esc(repo)}|${esc(s.epic)}">${esc(s.epic)}</button>` : `<code class="caption">${esc(s.base)}</code>`}</div>
    <h1>${esc(s.title)}</h1>
    <div class="facts">${facts.map(([k, v]) => `<span>${k} <b>${esc(v)}</b></span>`).join('')}</div>
    <p class="caption" style="margin:0">${sources}</p>
  </div></section>
  <div class="story-grid"><div style="display:grid;gap:12px;min-width:0"><section class="panel">${body}</section></div>${aside}</div>`;
}

// ── shell ───────────────────────────────────────────────────────────────────
function momentBar() {
  const live = M.now;
  const local = isoAt(ms(M.at)).slice(0, 16);
  return `<div class="moment"><span class="eyebrow">Moment</span>
    <div class="seg" role="group" aria-label="Moment">
      <button data-act="now" aria-pressed="${live}">${live ? '<span class="live-dot" aria-hidden="true"></span> ' : ''}Now</button>
      <button data-act="step" data-k="-86400">−1 day</button><button data-act="step" data-k="-3600">−1 h</button>
      <button data-act="step" data-k="3600"${live ? ' disabled' : ''}>+1 h</button><button data-act="step" data-k="86400"${live ? ' disabled' : ''}>+1 day</button>
    </div>
    <label class="caption">at <input type="datetime-local" id="at" value="${local}" step="60" max="${isoAt(Date.now()).slice(0, 16)}"></label>
    <span class="caption">${live ? `Live: read ${hms(D.generatedAt)}, refreshed every 30 s.` : 'Replayed from git, the journal and the event log. What none of them records reads unknown.'}</span></div>`;
}

function render() {
  DK = 0;
  const app = document.getElementById('app');
  const openKeys = new Set([...app.querySelectorAll('details[open][data-k]')].map((d) => d.dataset.k));
  document.getElementById('tabs').innerHTML = VIEWS.map(([v, l]) => `<button class="tab" data-act="view" data-k="${v}" ${S.view === v ? 'aria-current="page"' : ''}>${l}</button>`).join('');
  document.getElementById('theme').innerHTML = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button data-act="theme" data-k="${k}" aria-pressed="${themeChoice === k}">${l}</button>`).join('');
  if (!D || !M) {
    app.innerHTML = failed ? `<div class="err">The fleet could not be read: ${esc(failed)}. The page tries again every 30 s.</div>` : '<p class="caption">Reading the fleet…</p>';
    return;
  }
  document.getElementById('ribbon').innerHTML = `<span>${D.repos.map((r) => `${pm(r.name)} ${esc(r.name)}`).join(' · ')} · read ${esc(D.generatedAt.slice(0, 16).replace('T', ' '))}. Read-only: nothing on this page changes the fleet.</span>${failed ? `<span class="err" style="padding:2px 8px">the last refresh failed: ${esc(failed)}</span>` : ''}`;
  document.getElementById('foot').innerHTML = Object.keys(SRC).map((k) => `<span>${src(k)} ${esc(SRCWHY[k])}</span>`).join('');
  let html = '';
  if (S.view === 'overview') html = momentBar() + overviewHTML();
  else if (S.view === 'backlog') html = momentBar() + backlogHTML();
  else if (S.view === 'epics') html = momentBar() + (S.epic ? epicDetailHTML(S.epic) : epicsListHTML());
  else if (S.view === 'landed') html = momentBar() + landedHTML();
  else html = momentBar() + storyHTML();
  app.innerHTML = html;
  for (const d of app.querySelectorAll('details[data-k]')) if (openKeys.has(d.dataset.k)) d.open = true;
  if (S.view === 'story' && S.story && !LIFE.has(S.story)) loadStory(S.story);
}

async function getJSON(path) {
  const r = await fetch(path, { cache: 'no-store' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
  return body;
}
async function loadStory(key) {
  const [repo, id] = key.split('/');
  try {
    LIFE.set(key, await getJSON(`api/story?repo=${encodeURIComponent(repo)}&id=${encodeURIComponent(id)}`));
  } catch (e) {
    LIFE.set(key, { error: String(e.message || e) });
  }
  if (S.story === key && S.view === 'story') render();
}
let loading = false;
async function load() {
  if (loading) return;
  loading = true;
  try {
    // The machine is read now only, and a failure of it is its own.
    const [d, m, h] = await Promise.all([getJSON('api/catalog'), getJSON(S.at ? `api/moment?at=${encodeURIComponent(S.at)}` : 'api/moment'),
      S.at ? null : getJSON('api/machine').catch((e) => ({ error: String(e.message || e) }))]);
    const fresh = !D || d.generatedAt !== D.generatedAt;
    D = d; M = m; MACH = h; failed = null;
    if (fresh) LIFE.clear();
  } catch (e) {
    failed = String(e.message || e);
  } finally {
    loading = false;
  }
  render();
}
function applyTheme() {
  const r = document.documentElement;
  if (themeChoice === 'system') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', themeChoice);
}
const go = (view) => { S.view = view; try { history.replaceState(null, '', `#${view}`); } catch (e) { /* no history */ } window.scrollTo(0, 0); };
function setMoment(t) {
  S.at = t == null || t >= Date.now() - 60e3 ? null : isoAt(t);
  load();
}
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const k = el.dataset.k;
  switch (el.dataset.act) {
    case 'view': if (k === 'epics') S.epic = null; go(k); break;
    case 'epic': S.epic = k; go('epics'); break;
    case 'epics': S.epic = null; go('epics'); break;
    case 'landed': S.landedRepo = k || 'all'; S.landedAll = false; go('landed'); break;
    case 'landedrepo': S.landedRepo = k; S.landedAll = false; break;
    case 'landedall': S.landedAll = true; break;
    case 'story': S.story = k; go('story'); break;
    case 'period': S.period = Number(k); break;
    case 'aggrepo': S.aggRepo = k; break;
    case 'machineall': S.machineAll = !S.machineAll; break;
    case 'now': setMoment(null); return;
    case 'step': setMoment(ms(M.at) + Number(k) * 1000); return;
    case 'theme': themeChoice = k; try { localStorage.setItem('fleet-theme', k); } catch (e) { /* storage refused */ } applyTheme(); break;
    default: return;
  }
  render();
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'at' && ev.target.value) setMoment(new Date(ev.target.value).getTime());
  if (ev.target.id === 'storysel') { S.story = ev.target.value; render(); }
});
const tip = document.getElementById('tip');
document.addEventListener('mousemove', (ev) => {
  const t = ev.target.closest && ev.target.closest('[data-tip]');
  if (!t) { tip.style.display = 'none'; return; }
  tip.textContent = t.getAttribute('data-tip'); tip.style.whiteSpace = 'pre-line'; tip.style.display = 'block';
  tip.style.left = `${Math.min(ev.clientX + 12, window.innerWidth - 290)}px`; tip.style.top = `${ev.clientY + 14}px`;
});
// Live: a new read every 30 s while the page is seen; a past moment stays put.
setInterval(() => { if (!document.hidden && (S.at === null || !D)) load(); }, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.at === null) load(); });
applyTheme();
render();
load();
