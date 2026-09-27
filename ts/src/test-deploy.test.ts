import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Die } from './lib/die.ts';
import { runSync } from './lib/proc.ts';
import { branchNameOk, branchTip, localMinute, readKnobs, readState, stateFile, treeDir } from './test-deploy.ts';

// Only the parts that touch no unit: status, stop and deploy call the real
// systemctl and systemd-run, so they are the suite's (case 149, with fakes
// that shadow both).

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fleet-td-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const PATH = { PATH: process.env['PATH'] ?? '' };

describe('readKnobs', () => {
  it('defaults, with no URL', () => {
    expect(readKnobs(PATH, tmp)).toEqual({ url: '', port: 4100, lockWaitSec: 3600, startWaitSec: 90 });
  });
  it('.env.fleet fills in; the environment wins; an empty value is unset', () => {
    writeFileSync(join(tmp, '.env.fleet'), 'TELEGRAM_BOT_TOKEN=x\nTEST_DEPLOY_URL=https://file.example\nTEST_DEPLOY_PORT=4200\n');
    expect(readKnobs(PATH, tmp)).toEqual({ url: 'https://file.example', port: 4200, lockWaitSec: 3600, startWaitSec: 90 });
    expect(readKnobs({ ...PATH, TEST_DEPLOY_URL: 'https://env.example', TEST_DEPLOY_START_WAIT: '5' }, tmp))
      .toEqual({ url: 'https://env.example', port: 4200, lockWaitSec: 3600, startWaitSec: 5 });
    expect(readKnobs({ ...PATH, TEST_DEPLOY_URL: '' }, tmp).url).toBe('https://file.example');
  });
  it('a number that is not one is a die', () => {
    expect(() => readKnobs({ ...PATH, TEST_DEPLOY_PORT: '41o0' }, tmp)).toThrow(Die);
  });
  it('a .env.fleet bash cannot source is a die', () => {
    writeFileSync(join(tmp, '.env.fleet'), 'if\n');
    expect(() => readKnobs(PATH, tmp)).toThrow(/could not read .*\.env\.fleet/);
  });
});

describe('branchNameOk', () => {
  it.each(['epic/ui-a11y', 'story/032', 'develop', 'feat/x.y', 'fix/cold-start_2'])('%s is a name', (n) => {
    expect(branchNameOk(n)).toBe(true);
  });
  it.each(['', '-x', '--upload-pack=x', 'a..b', 'a;b', 'a b', 'x.lock', 'x/', '/x', 'a@{1}', 'épic'])('%j is not', (n) => {
    expect(branchNameOk(n)).toBe(false);
  });
});

describe('branchTip', () => {
  const git = (...a: string[]): string => {
    const r = runSync('git', ['-C', tmp, ...a]);
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  beforeEach(() => {
    git('init', '-q', '-b', 'base');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'two');
  });
  it("origin's tip when origin has the branch, even with a local one of the same name", () => {
    git('update-ref', 'refs/remotes/origin/epic/x', 'HEAD~1');
    git('branch', 'epic/x', 'HEAD');
    expect(branchTip(tmp, 'epic/x')).toEqual({ ref: 'refs/remotes/origin/epic/x', sha: git('rev-parse', 'HEAD~1') });
  });
  it('the local branch when origin has none', () => {
    git('branch', 'story/900', 'HEAD~1');
    expect(branchTip(tmp, 'story/900')).toEqual({ ref: 'refs/heads/story/900', sha: git('rev-parse', 'HEAD~1') });
  });
  it('nothing when neither has it', () => {
    expect(branchTip(tmp, 'nosuch')).toBeUndefined();
  });
});

describe('the tree and the record', () => {
  it('the tree is a sibling of the target', () => {
    expect(treeDir('/w/khaita/khaita-app')).toBe('/w/khaita/test-deploy');
  });
  it('no record is nothing deployed; a record that is not JSON is a die', () => {
    expect(readState(tmp)).toBeUndefined();
    writeFileSync(stateFile(tmp), '{');
    expect(() => readState(tmp)).toThrow(/is not JSON/);
  });
  it('the time is local, to the minute', () => {
    expect(localMinute(new Date(2026, 8, 27, 9, 5, 59))).toBe('2026-09-27 09:05');
  });
});
