import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetEvent } from './events.ts';
import { journalEvents, mergeJournals, parseJournal, savedJournals } from './journal.ts';

// A drain of qr-desktop-scanner as the journal kept it (22 Oct), cut short.
const QR = `2026-10-22T00:19:18.034421+02:00 ov fleet-queue-qr[1147474]: \x1b[32m==> [queue] story 001 (1 of at most 5)\x1b[0m
2026-10-22T00:19:18.161007+02:00 ov fleet-queue-qr[1147606]: ==> base: epic/cards (from the story)
2026-10-22T00:19:18.161397+02:00 ov fleet-queue-qr[1147606]: ==> model: opus (from the story)
2026-10-22T00:19:18.161397+02:00 ov fleet-queue-qr[1147606]: ==> story 001
2026-10-22T00:19:21.166900+02:00 ov fleet-queue-qr[1147606]: ==> installing deps
2026-10-22T00:19:24.851514+02:00 ov fleet-queue-qr[1147606]: ==> base 7e940a7f
2026-10-22T00:19:24.853549+02:00 ov fleet-queue-qr[1147606]: ==> round 1 of 2
2026-10-22T00:19:24.857370+02:00 ov fleet-queue-qr[1147606]: ==> builder: opus
2026-10-22T00:31:38.100119+02:00 ov fleet-queue-qr[1147606]: ==> builder handed over TDD evidence
2026-10-22T00:31:38.111738+02:00 ov fleet-queue-qr[1147606]: ==> builder: 2 commit(s) this round, 2 total, head 5ce16082
2026-10-22T00:31:38.111913+02:00 ov fleet-queue-qr[1147606]: ==> reviewer worktree at 5ce16082
2026-10-22T00:33:36.641995+02:00 ov fleet-queue-qr[1147606]: ==> baseline: test GREEN | build GREEN | lint GREEN
2026-10-22T00:33:40.049649+02:00 ov fleet-queue-qr[1147606]: ==> tdd check 1: mutation AC1-tdd-unfold: RED
2026-10-22T00:33:42.167196+02:00 ov fleet-queue-qr[1147606]: ==> tdd check 1: mutation AC2-tdd-mecard: RED
2026-10-22T00:33:42.168000+02:00 ov fleet-queue-qr[1147606]: ==> tdd check 1: 2 RED
2026-10-22T00:33:46.820219+02:00 ov fleet-queue-qr[1147606]: ==> scope: CLEAN
2026-10-22T00:33:46.826817+02:00 ov fleet-queue-qr[1147606]: ==> reviewer: codex
2026-10-22T00:35:26.424189+02:00 ov fleet-queue-qr[1147606]: ==> mutation AC1-comma: RED
2026-10-22T00:35:26.424647+02:00 ov fleet-queue-qr[1147606]: ==> mutation AC1-tdd-unfold: RED (run by the tdd check at this head)
2026-10-22T00:35:27.512475+02:00 ov fleet-queue-qr[1147606]: ==> mutation AC2-end: RED
2026-10-22T00:35:38.725849+02:00 ov fleet-queue-qr[1147606]: ==> round 1: PASS
2026-10-22T00:35:40.671051+02:00 ov fleet-queue-qr[1147606]: ==> VERDICT: PASS after 1 round(s) → /x/.review/001.md
2026-10-22T00:35:41.052472+02:00 ov fleet-queue-qr[1147474]: ==> [queue] 001: done
2026-10-22T00:35:42.530615+02:00 ov fleet-queue-qr[1166328]: ==> merging story/001 into epic/cards (at 7e940a7f)
2026-10-22T00:35:42.570225+02:00 ov fleet-queue-qr[1166328]: ==> post-merge baseline: SKIPPED — the merged tree is the tree round 1 checked GREEN at 5ce16082, with the same commands
2026-10-22T00:35:44.327884+02:00 ov fleet-queue-qr[1166328]: ==> epic/cards is now bc6c95f4
2026-10-22T00:35:47.594945+02:00 ov fleet-queue-qr[1166328]: ==> 001 merged into epic/cards — revert with: fleet revert qr 001
`;

const rows = (ev: FleetEvent[]): string[] => ev.map((e) => [e.event, e.pass, e.name ?? '-', e.result ?? '-', e.story ?? '-'].join(' '));
const at = (ev: FleetEvent[], i: number): string => String(ev[i]?.ts).slice(11, 19);

describe('parseJournal', () => {
  it('reads short-iso-precise lines: time, identifier, pid and the message without colour', () => {
    const l = parseJournal(QR)[0]!;
    expect(l).toMatchObject({ ident: 'fleet-queue-qr', pid: 1147474, msg: '==> [queue] story 001 (1 of at most 5)' });
    expect(l.at.toISOString()).toBe('2026-10-21T22:19:18.034Z');
  });
});

describe('journalEvents — a drain, as passes', () => {
  const ev = journalEvents(parseJournal(QR), { repo: 'qr', machine: () => ({ reviewer: 90, reasons: '' }) });

  it('makes the queue pickup, the launch, the round, each pass and the merge, every span ended', () => {
    expect(rows(ev)).toEqual([
      'mark queue pickup - 001',
      'start launch - - 001',
      'start install builder - 001',
      'end install builder OK 001',
      'start round - - 001',
      'start builder build - 001',
      'end builder build OK 001',
      'start baseline all - 001',
      'end baseline all GREEN 001',
      'start tdd AC1-tdd-unfold - 001',
      'end tdd AC1-tdd-unfold RED 001',
      'start tdd AC2-tdd-mecard - 001',
      'end tdd AC2-tdd-mecard RED 001',
      'mark scope - CLEAN 001',
      'start reviewer - - 001',
      'end reviewer - - 001',
      'start mutation AC1-comma - 001',
      'end mutation AC1-comma RED 001',
      'start mutation AC1-tdd-unfold - 001',
      'end mutation AC1-tdd-unfold RED 001',
      'start mutation AC2-end - 001',
      'end mutation AC2-end RED 001',
      'mark verdict - PASS 001',
      'end round - PASS 001',
      'end launch - PASS 001',
      'start merge - - 001',
      'mark baseline merge SKIPPED 001',
      'end merge - MERGED 001',
    ]);
    expect(ev.every((e) => e.source === 'journal' || e.source === 'machine')).toBe(true);
  });

  it('names the epic and the model from the lines before the story, and the round on its passes', () => {
    const launch = ev.find((e) => e.pass === 'launch')!;
    expect(launch).toMatchObject({ repo: 'qr', epic: 'epic/cards', model: 'opus', pid: 1147606 });
    expect(launch.run_id).toBe('qr.001.20261022T001918.1147606');
    expect(ev.find((e) => e.pass === 'builder')).toMatchObject({ round: 1, model: 'opus' });
    expect(ev.find((e) => e.pass === 'builder' && e.event === 'end')).toMatchObject({ head: '5ce16082', commits: 2 });
  });

  it('times the reviewer from the Machine block when the journal does not say when it ended, and starts the first mutation there', () => {
    const i = ev.findIndex((e) => e.pass === 'reviewer' && e.event === 'end');
    expect(ev[i]).toMatchObject({ source: 'machine', dur_s: 90 });
    expect(at(ev, i)).toBe('00:35:16');
    expect(at(ev, i + 1)).toBe('00:35:16');
    expect(ev[i + 4]).toMatchObject({ reused: true });
  });

  it('pairs the merge with its story, the epic and the sha', () => {
    expect(ev.find((e) => e.pass === 'merge' && e.event === 'end')).toMatchObject({ story: '001', epic: 'epic/cards', into: 'epic/cards', sha: 'bc6c95f4' });
  });
});

describe('journalEvents — how a launch stops', () => {
  const line = (t: string, pid: number, msg: string, ident = 'fleet-queue-k'): string => `2026-10-20T${t}.000000+02:00 ov ${ident}[${pid}]: ${msg}`;
  const stop = (...tail: string[]): FleetEvent[] => journalEvents(parseJournal([
    line('01:00:00', 7, '==> story 125'),
    line('01:00:01', 7, '==> round 1 of 2'),
    line('01:00:02', 7, '==> builder: sonnet'),
    ...tail,
  ].join('\n')), { repo: 'k' });

  it('a die ends every open span DIED with its text', () => {
    const ev = stop(line('01:30:02', 7, 'XX round 1: the builder exceeded AGENT_TIMEOUT (1800s) and was killed'));
    expect(rows(ev).slice(-3)).toEqual(['end builder build TIMEOUT 125', 'end round - DIED 125', 'end launch - DIED 125']);
    expect(ev.at(-1)?.reason).toMatch(/exceeded AGENT_TIMEOUT/);
  });

  it('a question ends the launch BLOCKED', () => {
    const ev = stop(line('01:10:00', 7, '!! BLOCKED — agent asked a question:'));
    expect(rows(ev).slice(-4)).toEqual(['end builder build BLOCKED 125', 'mark blocked - - 125', 'end round - BLOCKED 125', 'end launch - BLOCKED 125']);
  });

  it('the unit killed ends what is open KILLED; a launch the journal just loses stays open', () => {
    const killed = stop(line('01:09:42', 1, 'fleet-queue@k.service: Main process exited, code=killed, status=15/TERM', 'systemd'));
    expect(rows(killed).slice(-1)).toEqual(['end launch - KILLED 125']);
    expect(rows(stop()).filter((r) => r.startsWith('end'))).toEqual([]);
  });

  it('keeps the old single unit\'s lines for the repo its [queue] repo: line named, and drops the others', () => {
    const lines = [
      line('02:00:00', 5, '==> [queue] repo: other', 'fleet-queue'),
      line('02:00:01', 6, '==> story 001', 'fleet-queue'),
      line('02:00:05', 5, '==> [queue] repo: k', 'fleet-queue'),
      line('02:00:06', 8, '==> story 002', 'fleet-queue'),
    ].join('\n');
    expect(journalEvents(parseJournal(lines), { repo: 'k' }).map((e) => e.story)).toEqual(['002']);
  });
});

describe('mergeJournals and savedJournals — the copies a human saved before journald rotated them', () => {
  it('keeps each line once, in time order, across a change of offset', () => {
    const a = ['2026-10-25T02:30:00.000001+02:00 h fleet-queue-k[1]: ==> story 001', '2026-10-25T02:10:00.000001+01:00 h fleet-queue-k[1]: ==> round 1 of 2'].join('\n');
    const b = ['2026-10-25T02:30:00.000001+02:00 h fleet-queue-k[1]: ==> story 001', '2026-10-25T02:40:00.000001+02:00 h fleet-queue-k[1]: ==> installing deps', ''].join('\n');
    expect(mergeJournals([a, b]).split('\n').map((l) => l.slice(l.indexOf(': ') + 2))).toEqual(['==> story 001', '==> installing deps', '==> round 1 of 2']);
  });

  it('reads every .runs/journal-*.log of a target, and nothing when there is none', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-journal-'));
    try {
      expect(savedJournals(root)).toEqual([]);
      mkdirSync(join(root, '.runs'));
      writeFileSync(join(root, '.runs', 'journal-2026-10.log'), 'x\n');
      writeFileSync(join(root, '.runs', 'journal-2026-09.log'), 'y\n');
      writeFileSync(join(root, '.runs', '900-install-builder.log'), 'z\n');
      expect(savedJournals(root)).toEqual(['y\n', 'x\n']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
