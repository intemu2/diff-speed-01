// Fast drop-in for makefun-diff 1.0.0.
//
// Rule (from the bounty spec, also stated in the reference header):
// - A text is cut after every "\n" (only separator; "\r" is part of a line);
//   a last line with no "\n" is a line too. The empty text has no lines.
//   Two lines are equal only when they are the same code units, newline
//   or its absence included.
// - Edit script: longest common prefix kept, then longest common suffix
//   of what is left; between them Myers's greedy search from the first
//   lines. On each diagonal the path reaching furthest into the old text
//   wins, and on a tie the deletion wins (jsdiff takes the insertion).
//   No move past either text's end, no edge-diagonal pruning, every run
//   of equal lines followed as far as it goes; the first path to reach
//   both ends is the script.
// - Patch: "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I",
//   then per hunk "@ os ol ns nl" and one line per covered line
//   ("=" kept, "-" deleted, "+" inserted). Each change run lists its
//   deletions before its insertions, shows up to 3 kept lines before and
//   after it, and two runs at most 6 kept lines apart share a hunk.
//   A line that ends its text with no newline is written with one and
//   followed by a line "%". Identical texts are the first line alone.
//
// How this implementation stays identical while being faster:
// - Lines are interned to small integers (exact Map on the line's content
//   plus its newline flag, so equality is one integer compare and no two
//   different lines can ever share an id).
// - Myers is run as a trace: for each edit count d we keep only the
//   furthest x per diagonal in an Int32Array (no per-step path objects,
//   no linked lists). The predecessor choice at every (d, k) is
//   recomputed from the stored trace with exactly the reference's
//   candidate, bound and tie-break rules, then the script is walked
//   back from the end. No diagonal is pruned and no snake is shortened.
// - Nothing is cached from one case to the next: every map and table is
//   created fresh inside run().

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** Split a text into lines and intern them. Returns { parts, ids, n }. */
function intern(text, map) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  // Number of lines: every part except a trailing empty one.
  const n = parts[last] === '' ? last : parts.length;
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const content = parts[i];
    let base = map.get(content);
    if (base === undefined) {
      base = map.size;
      map.set(content, base);
    }
    // hasNL is true for every line except a bare last line.
    ids[i] = base * 2 + (i < last ? 1 : 0);
  }
  return { parts, ids, n };
}

/** The patch's line for one covered line: op, the line, a newline, and "%" when it had none. */
function written(op, parts, idx, lastPart) {
  // idx < lastPart  <=>  the line ends with "\n".
  return idx < lastPart ? `${op}${parts[idx]}\n` : `${op}${parts[idx]}\n%\n`;
}

export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }

  // Fresh interning per case: no state leaks between cases.
  const map = new Map();
  const a = intern(input.old, map);
  const b = intern(input.new, map);
  const aIds = a.ids;
  const bIds = b.ids;
  const n = a.n;
  const m = b.n;

  // Common prefix, then common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;

  const aMid = aIds.subarray(prefix, n - suffix);
  const bMid = bIds.subarray(prefix, m - suffix);
  const N = aMid.length;
  const M = bMid.length;

  // Middle edit runs, as [kind, count] in order.
  const midRuns = [];
  if (N === 0) {
    if (M > 0) midRuns.push([INSERT, M]);
  } else if (M === 0) {
    midRuns.push([DELETE, N]);
  } else {
    // ---- Myers trace ----
    // Vs[d] is an Int32Array of length d+1: Vs[d][j] is the x (old lines
    // consumed) after the snake on diagonal k = 2*j - d, or -1 when that
    // diagonal holds no path at d. j indexes k in steps of 2.
    const Vs = [];
    let x = 0;
    let y = 0;
    while (x < N && y < M && aMid[x] === bMid[y]) { x++; y++; }
    const v0 = new Int32Array(1);
    v0[0] = x;
    Vs.push(v0);
    let D = 0;
    let kFinal = 0;
    if (!(x === N && y === M)) {
      let found = false;
      for (let d = 1; d <= N + M && !found; d++) {
        const V = new Int32Array(d + 1);
        V.fill(-1);
        const Vp = Vs[d - 1];
        for (let j = 0; j <= d; j++) {
          const k = 2 * j - d;
          // Deletion predecessor: Vs[d-1][j-1] (diagonal k-1); valid when j > 0.
          // Insertion predecessor: Vs[d-1][j] (diagonal k+1); valid when j < d.
          const xDelPrev = j > 0 ? Vp[j - 1] : -1;
          const xInsPrev = j < d ? Vp[j] : -1;
          // Reference bounds: deletion needs xDelPrev < N (a line left to
          // delete); insertion needs yInsPrev < M, yInsPrev = xInsPrev-(k+1).
          const canDel = xDelPrev !== -1 && xDelPrev < N;
          const canIns = xInsPrev !== -1 && xInsPrev - (k + 1) < M;
          if (!canDel && !canIns) continue;
          // Reference tie-break, in x terms: deletion's resulting x is
          // xDelPrev+1, insertion's is xInsPrev; deletion wins on a tie,
          // i.e. xDelPrev >= xInsPrev-1.
          const byDel = canDel ? xDelPrev : -2;
          const byIns = canIns ? xInsPrev - 1 : -2;
          let xs;
          if (byDel >= byIns) xs = xDelPrev + 1;
          else xs = xInsPrev;
          let ys = xs - k;
          while (xs < N && ys < M && aMid[xs] === bMid[ys]) { xs++; ys++; }
          V[j] = xs;
          if (xs === N && ys === M) {
            D = d;
            kFinal = k;
            found = true;
            Vs.push(V);
            break;
          }
        }
        if (!found) Vs.push(V);
      }
      if (!found) throw new Error('makefun-diff: the search ended without reaching both ends');
    }

    // ---- Backtrack ----
    // Walk back from (N, M) at (D, kFinal). At each d, recompute the
    // predecessor with the same rule as the forward pass, undo the snake
    // (KEEP), record the one edit, and step to the predecessor.
    const rev = []; // single ops, reversed: [kind, 1] or [KEEP, count]
    let cx = N;
    let cy = M;
    let ck = kFinal;
    for (let d = D; d >= 1; d--) {
      const Vp = Vs[d - 1];
      const j = (ck + d) >> 1;
      const xDelPrev = j > 0 ? Vp[j - 1] : -1;
      const xInsPrev = j < d ? Vp[j] : -1;
      const canDel = xDelPrev !== -1 && xDelPrev < N;
      const canIns = xInsPrev !== -1 && xInsPrev - (ck + 1) < M;
      const byDel = canDel ? xDelPrev : -2;
      const byIns = canIns ? xInsPrev - 1 : -2;
      let xPrev;
      let yPrev;
      let kind;
      let xStart;
      if (byDel >= byIns) {
        kind = DELETE;
        xPrev = xDelPrev;
        yPrev = xPrev - (ck - 1);
        xStart = xPrev + 1;
      } else {
        kind = INSERT;
        xPrev = xInsPrev;
        yPrev = xPrev - (ck + 1);
        xStart = xPrev;
      }
      const keep = cx - xStart;
      if (keep > 0) rev.push([KEEP, keep]);
      rev.push([kind, 1]);
      cx = xPrev;
      cy = yPrev;
      ck = kind === DELETE ? ck - 1 : ck + 1;
    }
    // The d=0 snake: from (0,0) to (Vs[0][0], Vs[0][0]).
    if (cx > 0) rev.push([KEEP, cx]);
    // Reverse and merge consecutive runs of one kind.
    for (let i = rev.length - 1; i >= 0; i--) {
      const [kind, count] = rev[i];
      const last = midRuns[midRuns.length - 1];
      if (last !== undefined && last[0] === kind) last[1] += count;
      else midRuns.push([kind, count]);
    }
  }

  // Full runs: prefix keeps, middle runs, suffix keeps.
  const runs = [];
  if (prefix > 0) runs.push([KEEP, prefix]);
  for (const r of midRuns) runs.push(r);
  if (suffix > 0) runs.push([KEEP, suffix]);

  // Change runs: each a stretch of deletions/insertions between keeps.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const [kind, count] of runs) {
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DELETE) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // Hunks: change runs at most 2*CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const aLastPart = a.parts.length - 1;
  const bLastPart = b.parts.length - 1;
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a.parts, at, aLastPart));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a.parts, c.o + i, aLastPart));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b.parts, c.p + i, bLastPart));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a.parts, at, aLastPart));
  }
  return out.join('');
}
