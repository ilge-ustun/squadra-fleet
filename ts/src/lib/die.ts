/** lib.sh's `die`: the message goes to stderr as an XX line, the status is 1.
 *  A module throws it; only a bin/ entry point prints it and sets the code. */
export class Die extends Error {}
