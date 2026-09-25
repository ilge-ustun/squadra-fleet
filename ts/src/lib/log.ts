// The same three lines lib.sh prints: `==> ` and `!! ` on stdout, `XX ` on
// stderr, ANSI colour always on, LOG_TAG as a prefix when a caller set it.
// Written with writeSync so nothing is lost when the process then sets an
// exit code and ends. Nothing here exits: a module throws, and only a bin/
// entry point turns that into a status.
import { writeSync } from 'node:fs';

const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YLW = '\x1b[33m';
const RST = '\x1b[0m';

export interface LogOptions {
  /** ANSI colour; on by default, as in lib.sh. */
  color?: boolean;
  /** lib.sh's LOG_TAG: prefixes every line as `[tag] `. */
  tag?: string;
}

function line(colour: string, mark: string, msg: string, o: LogOptions): string {
  const tag = o.tag ? `[${o.tag}] ` : '';
  return o.color === false ? `${mark} ${tag}${msg}\n` : `${colour}${mark} ${tag}${msg}${RST}\n`;
}

export function log(msg: string, o: LogOptions = {}): void {
  writeSync(1, line(GRN, '==>', msg, o));
}

export function warn(msg: string, o: LogOptions = {}): void {
  writeSync(1, line(YLW, '!!', msg, o));
}

/** The text `die` prints, to stderr. The caller sets process.exitCode = 1. */
export function dieMessage(msg: string, o: LogOptions = {}): void {
  writeSync(2, line(RED, 'XX', msg, o));
}

/** Plain stdout, no decoration. */
export function out(text: string): void {
  writeSync(1, text);
}
