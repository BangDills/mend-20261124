// unified.ts — SPEC section 6: unified-diff parser and hunk applier.
//
// Pure module: no filesystem access. main.ts (untouched by this step) will
// call unifiedEdits to parse, then apply the returned edits to its tree.
//
// Parsing (sections, headers, hunks, body classes):
//   - A section starts at a `diff --git a/<X> b/<Y>` line, or at a `--- `
//     line followed by a `+++ ` line that is not already part of the
//     current section's header (i.e. a pair before the first hunk renames
//     the current section; a pair after hunks starts a new section).
//   - In the header (before the first hunk) `---`/`+++` name the paths
//     (tab cut, space trim, one leading a-/b- strip), `rename from/to`
//     name them only when no pair does, `new file mode` / `deleted file
//     mode` force create/delete, and anything else is ignored. A `--- `
//     line without a `+++ ` after it, inside a header, is a parse error
//     at the line after it; a malformed `diff --git` line is a parse
//     error at its own line.
//   - A hunk starts at `@@ -A[,B] +C[,D] @@` plus optional text (B/C/D
//     unused); any other `@@` line, or a hunk before any section, is a
//     parse error. The body holds following lines starting with ` `, `-`,
//     `+`, `\`, or empty lines (empty = context with empty text); it ends
//     at the first other line, a `diff --git` line, a `--- `/`+++ ` pair,
//     or end of patch, minus trailing empty lines.
// Applying (O/N split, nearest match, empty-O insert, EOF rule, kinds):
//   - O is the hunk's context + `-` texts, N its context + `+` texts, in
//     body order (see hunkOldNew). Hunks apply in order with
//     d = sum(N-O) so far: non-empty O takes the match-tier occurrence
//     nearest to A-1+d (earlier on ties); empty O inserts N after the
//     first A+d lines. A `\` marker after the hunk's last context/`+`
//     line clears the trailing break when the hunk touches EOF (created
//     files key off the last `+` instead). Sections become create, delete,
//     move, or change edits as section 6 says.

export interface UnifiedBodyLine {
  /** ` ` context, `-` old, `+` new. `\` markers are not stored. */
  kind: ' ' | '-' | '+';
  text: string;
}

export interface UnifiedHunk {
  /** Old-file start A from the `@@ -A...` header (B/C/D are unused). */
  a: number;
  /** Body lines in order, minus `\` markers and trimmed trailing empties. */
  body: UnifiedBodyLine[];
  /** Old lines O: context and `-` texts in body order. */
  o: string[];
  /** New lines N: context and `+` texts in body order. */
  n: string[];
  /** A `\` line immediately follows the hunk's last context or `+` line. */
  noNewline: boolean;
  /** A `\` line immediately follows the hunk's last `+` line (for creates). */
  plusNoNewline: boolean;
}

export type UnifiedEdit =
  | { kind: 'create'; path: string; hunks: UnifiedHunk[] }
  | { kind: 'delete'; path: string; hunks: UnifiedHunk[] }
  | { kind: 'move'; oldPath: string; newPath: string; hunks: UnifiedHunk[] }
  | { kind: 'change'; path: string; hunks: UnifiedHunk[] };

export type UnifiedParse = { ok: true; edits: UnifiedEdit[] } | { ok: false; line: number };

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;
const DIFF_GIT_PREFIX = 'diff --git a/';

function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ') || line.startsWith('diff --git\t');
}

function diffGitPaths(line: string): [string, string] | null {
  if (!line.startsWith(DIFF_GIT_PREFIX)) return null;
  const rest = line.slice(DIFF_GIT_PREFIX.length);
  const sep = rest.indexOf(' b/');
  if (sep === -1) return null;
  return [rest.slice(0, sep), rest.slice(sep + 3)];
}

// `--- <path>` / `+++ <path>`: text after the four characters up to the
// first tab, surrounding spaces removed, one leading a/ or b/ removed.
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function isModeLine(line: string, tag: string): boolean {
  return line === tag || line.startsWith(tag + ' ') || line.startsWith(tag + '\t');
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  seenHunk: boolean;
  hunks: UnifiedHunk[];
}

function freshSection(diffOld: string | null, diffNew: string | null): Section {
  return {
    diffOld,
    diffNew,
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    isCreate: false,
    isDelete: false,
    seenHunk: false,
    hunks: [],
  };
}

function toEdit(s: Section): UnifiedEdit {
  let oldP: string;
  let newP: string;
  if (s.oldPath !== null && s.newPath !== null) {
    oldP = s.oldPath;
    newP = s.newPath;
  } else {
    // rename from/to names the paths only when no ---/+++ pair does; each
    // side falls back to its diff --git path when the other rename names it.
    oldP = s.renameFrom ?? s.diffOld ?? '';
    newP = s.renameTo ?? s.diffNew ?? '';
  }
  if (oldP === '/dev/null' || s.isCreate) return { kind: 'create', path: newP, hunks: s.hunks };
  if (newP === '/dev/null' || s.isDelete) return { kind: 'delete', path: oldP, hunks: s.hunks };
  if (oldP !== newP) return { kind: 'move', oldPath: oldP, newPath: newP, hunks: s.hunks };
  return { kind: 'change', path: oldP, hunks: s.hunks };
}

/** O/N split of one hunk body: O is context + `-`, N is context + `+`. */
export function hunkOldNew(body: UnifiedBodyLine[]): { o: string[]; n: string[] } {
  const o: string[] = [];
  const n: string[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === '-') {
      o.push(b.text);
    } else {
      n.push(b.text);
    }
  }
  return { o, n };
}

function readHunk(a: number, rawBody: string[]): UnifiedHunk {
  const body: UnifiedBodyLine[] = [];
  // Kind per raw body line, parallel to rawBody: c context, d old, a new,
  // s `\` marker. Body indices shift when markers are dropped, so the
  // no-newline flags are computed on this parallel array.
  const kinds: Array<'c' | 'd' | 'a' | 's'> = [];
  for (const b of rawBody) {
    const c = b.charAt(0);
    if (c === '\\') {
      kinds.push('s');
      continue;
    }
    if (c === '+') {
      kinds.push('a');
      body.push({ kind: '+', text: b.slice(1) });
      continue;
    }
    if (c === '-') {
      kinds.push('d');
      body.push({ kind: '-', text: b.slice(1) });
      continue;
    }
    kinds.push('c');
    body.push({ kind: ' ', text: b === '' ? '' : b.slice(1) });
  }
  let last = -1;
  for (let k = kinds.length - 1; k >= 0; k--) {
    if (kinds[k] === 'c' || kinds[k] === 'a') {
      last = k;
      break;
    }
  }
  let lastPlus = -1;
  for (let k = kinds.length - 1; k >= 0; k--) {
    if (kinds[k] === 'a') {
      lastPlus = k;
      break;
    }
  }
  const noNewline = last !== -1 && last + 1 < kinds.length && kinds[last + 1] === 's';
  const plusNoNewline = lastPlus !== -1 && lastPlus + 1 < kinds.length && kinds[lastPlus + 1] === 's';
  const { o, n } = hunkOldNew(body);
  return { a, body, o, n, noNewline, plusNoNewline };
}

export function unifiedEdits(lines: string[]): UnifiedParse {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isDiffGitLine(line)) {
      const paths = diffGitPaths(line);
      if (paths === null) return { ok: false, line: i + 1 };
      cur = freshSection(paths[0], paths[1]);
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) return { ok: false, line: i + 1 };
      if (cur === null) return { ok: false, line: i + 1 };
      const a = parseInt(m[1], 10);
      let j = i + 1;
      const rawBody: string[] = [];
      while (j < n) {
        const b = lines[j];
        if (isDiffGitLine(b)) break;
        if (b.startsWith('--- ') && j + 1 < n && lines[j + 1].startsWith('+++ ')) break;
        if (b === '') {
          rawBody.push(b);
          j++;
          continue;
        }
        const c = b.charAt(0);
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          rawBody.push(b);
          j++;
          continue;
        }
        break;
      }
      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') rawBody.pop();
      cur.hunks.push(readHunk(a, rawBody));
      cur.seenHunk = true;
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (cur === null || cur.seenHunk) {
        cur = freshSection(null, null);
        sections.push(cur);
      }
      // A pair inside a section header (re)names its paths; a later pair
      // overwrites an earlier one.
      cur.oldPath = headerPath(line);
      cur.newPath = headerPath(lines[i + 1]);
      i += 2;
      continue;
    }
    if (cur !== null && !cur.seenHunk) {
      if (line.startsWith('--- ')) return { ok: false, line: i + 2 };
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line === 'rename from') cur.renameFrom = '';
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line === 'rename to') cur.renameTo = '';
      else if (isModeLine(line, 'new file mode')) cur.isCreate = true;
      else if (isModeLine(line, 'deleted file mode')) cur.isDelete = true;
      // index / old mode / new mode / similarity / dissimilarity / Index: /
      // lone `+++ ` / prose: ignored.
    }
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i++;
  }
  if (sections.length === 0) return { ok: false, line: 1 };
  return { ok: true, edits: sections.map(toEdit) };
}

// --- Applying hunks (SPEC sections 5 and 6) ---

export interface SplitFile {
  brk: string;
  lines: string[];
  endsWithBreak: boolean;
}

export function splitFileText(text: string): SplitFile {
  if (text === '') return { brk: '\n', lines: [], endsWithBreak: false };
  const idx = text.indexOf('\n');
  const brk = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(brk);
  const parts = text.split(brk);
  if (endsWithBreak) parts.pop();
  return { brk, lines: parts, endsWithBreak };
}

export function joinFileText(f: SplitFile): string {
  if (f.lines.length === 0) return '';
  const t = f.lines.join(f.brk);
  return f.endsWithBreak ? t + f.brk : t;
}

function rstripST(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function leadingST(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function linesEqualAtTier(a: string, b: string, tier: 0 | 1 | 2): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripST(a) === rstripST(b);
  const sa = a.replace(/^[ \t]+|[ \t]+$/g, '');
  const sb = b.replace(/^[ \t]+|[ \t]+$/g, '');
  return sa === sb;
}

function occurrencesAtTier(fileLines: string[], o: string[], tier: 0 | 1 | 2): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > fileLines.length) return out;
  outer: for (let i = 0; i + o.length <= fileLines.length; i++) {
    for (let k = 0; k < o.length; k++) {
      if (!linesEqualAtTier(fileLines[i + k], o[k], tier)) continue outer;
    }
    out.push(i);
  }
  return out;
}

function matchTier(fileLines: string[], o: string[], strict: boolean): { tier: 0 | 1 | 2; occ: number[] } | null {
  const tiers: Array<0 | 1 | 2> = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrencesAtTier(fileLines, o, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

function nearestPos(occ: number[], target: number): number {
  let best = occ[0];
  let bestDist = Math.abs(occ[0] - target);
  for (let k = 1; k < occ.length; k++) {
    const d = Math.abs(occ[k] - target);
    if (d < bestDist) {
      bestDist = d;
      best = occ[k];
    }
  }
  return best;
}

/**
 * Apply hunks in order to an already-split file. Returns the new split
 * file, or null when a hunk's O has no match. Covers the nearest-to-A-1+d
 * choice, empty-O insertion, the `\` EOF rule, file-owned context lines,
 * and tier-2 re-indent.
 */
export function applyHunksToSplit(start: SplitFile, hunks: UnifiedHunk[], strict: boolean): SplitFile | null {
  const lines = [...start.lines];
  let endsWithBreak = start.endsWithBreak;
  const brk = start.brk;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      // Insert N after the first A+d lines (all of them when fewer).
      const oldLen = lines.length;
      const at = Math.min(Math.max(h.a + d, 0), oldLen);
      lines.splice(at, 0, ...h.n);
      d += h.n.length;
      if (at === oldLen) endsWithBreak = !h.noNewline;
      continue;
    }
    const found = matchTier(lines, h.o, strict);
    if (found === null) return null;
    const pos = nearestPos(found.occ, h.a - 1 + d);
    // Build replacement: context lines come from the file's own matched
    // lines; other N lines from the patch (re-indented at tier 2).
    const rep: string[] = [];
    let oi = 0;
    let P: string | null = null;
    let F = '';
    if (found.tier === 2) {
      P = leadingST(h.o[0]);
      F = leadingST(lines[pos]);
    }
    for (const b of h.body) {
      if (b.kind === ' ') {
        rep.push(lines[pos + oi]);
        oi++;
      } else if (b.kind === '-') {
        oi++;
      } else {
        let t = b.text;
        if (found.tier === 2 && P !== null && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(P)) {
          t = F + t.slice(P.length);
        }
        rep.push(t);
      }
    }
    const touchesEnd = pos + h.o.length === lines.length;
    lines.splice(pos, h.o.length, ...rep);
    d += h.n.length - h.o.length;
    if (touchesEnd) endsWithBreak = !h.noNewline;
  }
  return { brk, lines, endsWithBreak };
}

export function isSafeUnifiedPath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const s of p.split('/')) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

export type UnifiedApplyOk =
  | { kind: 'create'; path: string; text: string }
  | { kind: 'delete'; path: string }
  | { kind: 'move'; oldPath: string; newPath: string; text: string }
  | { kind: 'change'; path: string; text: string }
  | { kind: 'noop-change'; path: string };

export type UnifiedApplyResult =
  | { ok: true; value: UnifiedApplyOk }
  | { ok: false; code: 'unsafe' | 'missing' | 'exists' | 'no-match'; path: string };

/**
 * Apply one parsed edit. getFile returns the current text, or null when
 * absent. Creation writes the `+` lines of all hunks (LF); deletion
 * removes; move/change run applyHunksToSplit. A hunk failure fails the
 * section with no-match and changes nothing.
 */
export function applyUnifiedEdit(
  edit: UnifiedEdit,
  getFile: (path: string) => string | null,
  strict: boolean,
): UnifiedApplyResult {
  const paths = edit.kind === 'move' ? [edit.oldPath, edit.newPath] : [edit.path];
  for (const p of paths) {
    if (!isSafeUnifiedPath(p)) return { ok: false, code: 'unsafe', path: p };
  }
  if (edit.kind === 'create') {
    if (getFile(edit.path) !== null) return { ok: false, code: 'exists', path: edit.path };
    const added: string[] = [];
    for (const h of edit.hunks) {
      for (const b of h.body) if (b.kind === '+') added.push(b.text);
    }
    if (added.length === 0) return { ok: true, value: { kind: 'create', path: edit.path, text: '' } };
    let lastPlusNN = false;
    for (let k = edit.hunks.length - 1; k >= 0; k--) {
      const h = edit.hunks[k];
      if (h.body.some((b) => b.kind === '+')) {
        lastPlusNN = h.plusNoNewline;
        break;
      }
    }
    const text = added.join('\n') + (lastPlusNN ? '' : '\n');
    return { ok: true, value: { kind: 'create', path: edit.path, text } };
  }
  if (edit.kind === 'delete') {
    if (getFile(edit.path) === null) return { ok: false, code: 'missing', path: edit.path };
    return { ok: true, value: { kind: 'delete', path: edit.path } };
  }
  if (edit.kind === 'move') {
    const oldText = getFile(edit.oldPath);
    if (oldText === null) return { ok: false, code: 'missing', path: edit.oldPath };
    if (getFile(edit.newPath) !== null) return { ok: false, code: 'exists', path: edit.newPath };
    const start = splitFileText(oldText);
    const before = joinFileText(start);
    const next = applyHunksToSplit(start, edit.hunks, strict);
    if (next === null) return { ok: false, code: 'no-match', path: edit.oldPath };
    const text = joinFileText(next);
    return { ok: true, value: { kind: 'move', oldPath: edit.oldPath, newPath: edit.newPath, text } };
  }
  const cur = getFile(edit.path);
  if (cur === null) return { ok: false, code: 'missing', path: edit.path };
  const start = splitFileText(cur);
  const before = joinFileText(start);
  const next = applyHunksToSplit(start, edit.hunks, strict);
  if (next === null) return { ok: false, code: 'no-match', path: edit.path };
  const text = joinFileText(next);
  if (text === before) return { ok: true, value: { kind: 'noop-change', path: edit.path } };
  return { ok: true, value: { kind: 'change', path: edit.path, text } };
}
