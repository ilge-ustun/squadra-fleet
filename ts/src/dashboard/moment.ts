// moment.ts — the fleet as it was at one moment: each story's state, what
// ran and in which pass, a launcher that died, why a stopped story stopped,
// and the queue unit, the launch lock and the test deploy. The present comes
// from `fleet status`, systemd and the fleet's own files (NowInfo, read when
// the bundle is built); a past moment only from the history and the events,
// and what they do not say is unknown, never guessed.
import type { FleetEvent } from '../lib/events.ts';
import type { CatalogRepo, CatalogStory } from './catalog.ts';

export interface StoryState {
  state: string;
  since: string | null;
}

export interface RunningView {
  pid?: number;
  round?: number;
  pass?: string;
  name?: string;
  agent?: string;
  model?: string;
  /** When the pass that runs started. */
  since?: string;
  launchSince: string;
  src: string;
  dead?: { ts: string | null; src: string; why: string };
}

export interface Stop {
  ts: string;
  msg: string;
  src: string;
}

export interface UnitView {
  known: boolean;
  active: boolean;
  since: string | null;
  next: string | null;
  src: string;
}

export interface LockView {
  known: boolean;
  held: boolean;
  pid: number | null;
  what: string;
}

export interface DeployView {
  known: boolean;
  branch?: string;
  sha?: string;
  since?: string;
  active?: boolean;
  src: string;
}

export interface RepoMoment {
  registered: boolean;
  states: Record<string, StoryState>;
  running: Record<string, RunningView>;
  stops: Record<string, Stop>;
  unit: UnitView;
  lock: LockView;
  testDeploy: DeployView | null;
}

export interface Moment {
  at: string;
  now: boolean;
  repos: Record<string, RepoMoment>;
}

/** What only the present says, read when the bundle was built. */
export interface NowInfo {
  units: Record<string, { state: string; lastStart: string | null; lastEnd: string | null; next: string | null } | null>;
  locks: Record<string, { pid: number | null; what: string; held: boolean } | null>;
  testDeploy: { repo: string; branch: string; sha: string; since: string; active: boolean } | null;
  /** The pids of open spans that still run. */
  alive: number[];
}

const ms = (iso: string): number => Date.parse(iso);
/** A moment this close to the bundle's is the present. */
const NOW_SLACK_MS = 90_000;
const STOP_DAYS_MS = 7 * 86_400_000;
const BAD = new Set(['TIMEOUT', 'ERROR', 'REFUSED', 'BUILDER_REFUSED', 'NO_COMMITS', 'BLOCKED', 'FAIL', 'SPEC', 'UNPARSEABLE', 'UNAVAILABLE', 'RED', 'DIED', 'KILLED']);

/** A story's state at `t` from its history: a merge on its epic is `on epic`
 *  until the epic's next land. Null before its first status. */
export function stateAt(s: CatalogStory, lands: readonly { ts: string }[], t: number): StoryState | null {
  let state: string | null = null;
  let since: string | null = null;
  let merged: string | null = null;
  for (const h of s.history) {
    if (ms(h.ts) > t) break;
    if (h.kind === 'merged') {
      merged = h.ts;
      if (s.epic === null) { state = 'landed'; since = h.ts; }
      continue;
    }
    if (h.kind === 'reverted') { merged = null; state = 'done'; since = h.ts; continue; }
    state = h.kind === 'promoted' || h.kind === 'answered' ? 'ready' : h.kind;
    since = h.ts;
  }
  if (state === null) return null;
  if (state === 'done' && merged !== null && s.epic !== null) {
    const m = ms(merged);
    const land = lands.find((l) => ms(l.ts) >= m && ms(l.ts) <= t);
    return land === undefined ? { state: 'on epic', since: merged } : { state: 'landed', since: land.ts };
  }
  if (state === 'done' && merged === null && s.landedAt !== null && ms(s.landedAt) <= t) return { state: 'landed', since: s.landedAt };
  return { state, since };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The launches and the pass each was in at `t`, and those that died. */
function runningAt(o: { story: (id: string) => CatalogStory | undefined; state: (id: string) => StoryState | undefined; events: readonly FleetEvent[]; t: number; now: boolean; alive: ReadonlySet<number> }): Record<string, RunningView> {
  const latest = new Map<string, FleetEvent>();
  for (const e of o.events) {
    if (e.pass !== 'launch' || e.event !== 'start' || e.story === undefined || ms(e.ts) > o.t) continue;
    latest.set(e.story, e);
  }
  const out: Record<string, RunningView> = {};
  for (const [id, L] of latest) {
    const end = o.events.find((e) => e.run_id === L.run_id && e.pass === 'launch' && e.event === 'end');
    const inProgress = o.state(id)?.state === 'in_progress';
    const v: RunningView = { launchSince: L.ts, src: L.source };
    if (typeof L.pid === 'number') v.pid = L.pid;
    if (end !== undefined && ms(end.ts) <= o.t) {
      if (!inProgress || (end.result !== 'KILLED' && end.result !== 'DIED')) continue;
      v.dead = { ts: end.ts, src: end.source, why: end.reason ?? `the launch ended ${end.result}` };
    } else if (o.now && end === undefined) {
      if (v.pid !== undefined) {
        if (!o.alive.has(v.pid)) v.dead = { ts: null, src: L.source, why: `pid ${v.pid} is gone, and its launch wrote no end` };
      } else if (o.story(id)?.live !== true) {
        if (!inProgress) continue;
        v.dead = { ts: null, src: L.source, why: 'in_progress, and nothing runs in its trees' };
      }
    }
    // The innermost span open at t: the last one started and not yet ended.
    // A launch that died is shown in the pass it died in: what was open just
    // before its death, which ended every span with it.
    const tIn = v.dead?.ts != null ? ms(v.dead.ts) - 1 : o.t;
    const ended = new Set(o.events.filter((e) => e.run_id === L.run_id && e.event === 'end' && ms(e.ts) <= tIn).map((e) => e.span));
    const open = o.events.filter((e) => e.run_id === L.run_id && e.event === 'start' && e.pass !== 'launch' && ms(e.ts) <= tIn && !ended.has(e.span));
    const rounds = open.filter((e) => e.pass === 'round');
    const inner = open.filter((e) => e.pass !== 'round').at(-1) ?? rounds.at(-1);
    const round = rounds.at(-1)?.round ?? inner?.round;
    if (typeof round === 'number') v.round = round;
    if (inner !== undefined && inner.pass !== 'round') {
      v.pass = inner.pass;
      const name = str(inner.name);
      const agent = str(inner['agent']);
      const model = str(inner['model']);
      if (name !== undefined) v.name = name;
      if (agent !== undefined) v.agent = agent;
      if (model !== undefined) v.model = model;
      v.since = inner.ts;
    }
    out[id] = v;
  }
  return out;
}

/** Why a story stopped at `since`: the last thing that went wrong in its last launch. */
function stopOf(events: readonly FleetEvent[], id: string, since: string): Stop | undefined {
  const until = ms(since) + 60_000;
  const mine = events.filter((e) => e.story === id && ms(e.ts) <= until);
  const launch = mine.filter((e) => e.pass === 'launch' && e.event === 'start').at(-1);
  const from = launch === undefined ? -Infinity : ms(launch.ts);
  const bad = mine.filter((e) => ms(e.ts) >= from && e.event !== 'start' && (
    e.pass === 'blocked'
    || (e.pass === 'verdict' && e.result !== undefined && e.result !== 'PASS')
    || (e.pass !== 'launch' && e.pass !== 'round' && e.result !== undefined && BAD.has(e.result))
    || (e.pass === 'launch' && (e.result === 'DIED' || e.result === 'KILLED'))));
  const e = bad.at(-1);
  if (e === undefined) return undefined;
  const msg = e.pass === 'blocked' ? `the builder asked${e.reason !== undefined ? `: ${e.reason}` : ' a question'}`
    : e.pass === 'verdict' ? `computed ${e.result ?? '?'}${e.reason !== undefined ? ` — ${e.reason}` : ''}`
      : `${e.pass} ${e.result ?? ''}${e.reason !== undefined ? ` — ${e.reason}` : ''}`;
  return { ts: e.ts, msg, src: e.source };
}

export interface MomentInput {
  repos: readonly CatalogRepo[];
  events: Readonly<Record<string, readonly FleetEvent[]>>;
  now: NowInfo;
  /** When the bundle was built: the present. */
  generatedAt: string;
  /** The moment asked for; the present when absent. */
  at?: string | undefined;
}

export function momentAt(o: MomentInput): Moment {
  const isNow = o.at === undefined || Number.isNaN(ms(o.at)) || ms(o.at) >= ms(o.generatedAt) - NOW_SLACK_MS;
  const at = isNow || o.at === undefined ? o.generatedAt : o.at;
  const t = ms(at);
  const alive = new Set(o.now.alive);
  const repos: Record<string, RepoMoment> = {};
  for (const R of o.repos) {
    const events = o.events[R.name] ?? [];
    const lands = new Map(R.epics.map((e) => [e.name, e.lands]));
    const states: Record<string, StoryState> = {};
    for (const s of R.stories) {
      if (isNow) {
        if (s.landing === '—' || s.landing === '') continue;
        const last = s.history.filter((h) => ms(h.ts) <= t).at(-1);
        states[s.id] = { state: s.landing, since: s.landing === 'landed' && s.landedAt !== null ? s.landedAt : last?.ts ?? null };
      } else {
        const x = stateAt(s, lands.get(s.epic ?? '') ?? [], t);
        if (x !== null) states[s.id] = x;
      }
    }
    const byId = new Map(R.stories.map((s) => [s.id, s]));
    const running = runningAt({ story: (id) => byId.get(id), state: (id) => states[id], events, t, now: isNow, alive });
    const stops: Record<string, Stop> = {};
    for (const [id, x] of Object.entries(states)) {
      if ((x.state !== 'blocked' && x.state !== 'needs_human') || x.since === null || t - ms(x.since) > STOP_DAYS_MS) continue;
      const s = stopOf(events, id, x.since);
      if (s !== undefined) stops[id] = s;
    }

    let unit: UnitView = { known: false, active: false, since: null, next: null, src: 'unknown' };
    const u = isNow ? o.now.units[R.name] : undefined;
    if (u !== undefined && u !== null) {
      const active = ['active', 'activating', 'deactivating', 'reloading'].includes(u.state);
      unit = { known: true, active, since: u.lastStart, next: u.next, src: 'systemd' };
    } else if (!isNow) {
      const drains = events.filter((e) => e.pass === 'queue' && e.span === 'drain' && e.event === 'start' && ms(e.ts) <= t);
      const d = drains.at(-1);
      const ended = d === undefined ? undefined : events.find((e) => e.run_id === d.run_id && e.span === 'drain' && e.event === 'end');
      if (d !== undefined && (ended === undefined || ms(ended.ts) > t)) unit = { known: true, active: true, since: d.ts, next: null, src: d.source };
    }

    const holder = Object.entries(running).find(([, r]) => r.dead === undefined);
    let lock: LockView = { known: false, held: false, pid: null, what: '' };
    const l = isNow ? o.now.locks[R.name] : undefined;
    if (l !== undefined && l !== null) lock = { known: true, held: l.held, pid: l.pid, what: l.what };
    else if (!isNow && holder !== undefined) lock = { known: true, held: true, pid: holder[1].pid ?? null, what: `launch ${holder[0]}` };

    let testDeploy: DeployView | null = null;
    if (isNow) {
      const d = o.now.testDeploy;
      if (d !== null && d.repo === R.name) testDeploy = { known: true, branch: d.branch, sha: d.sha, since: d.since, active: d.active, src: '.test-deploy.json' };
    } else {
      const up = events.filter((e) => e.pass === 'test_deploy' && e.event === 'end' && e.result === 'UP' && ms(e.ts) <= t).at(-1);
      testDeploy = up === undefined ? { known: false, src: 'unknown' } : {
        known: true, src: up.source, since: up.ts, ...(str(up['branch']) !== undefined ? { branch: String(up['branch']) } : {}), ...(str(up['sha']) !== undefined ? { sha: String(up['sha']) } : {}),
      };
    }
    repos[R.name] = { registered: Object.keys(states).length > 0, states, running, stops, unit, lock, testDeploy };
  }
  return { at, now: isNow, repos };
}
