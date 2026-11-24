// v4a.ts — SPEC section 8: V4A-patch parser and applier.
//
// Pure module: no filesystem access. A later step wires v4aEdits into
// main.ts the way unifiedEdits / srEdits are wired today.
//
// Parsing (Begin/End, sections, Move to, chunks):
//   - The first non-blank line is `*** Begin Patch`, else a parse error at
//     its line (1 when there is none); the last non-blank line is
//     `*** End Patch`, else a parse error at the patch length plus 1. Both
//     compare with surrounding whitespace removed.
//   - Between them, sections start at `*** Add File: `, `*** Delete File: `
//     and `*** Update File: ` lines (the path is the rest of the line, its
//     surrounding spaces removed). Blank lines between sections are ignored;
//     trailing blank raw lines of a section are not part of it. Any other
//     line is a parse error at its line.
//   - An Add File section's lines start with `+` (the rest is a file line)
//     or are empty (an empty file line); a Delete File section has no lines.
//     An Update File section may have `*** Move to: <path>` as its first
//     line, then chunks. A chunk starts at an `@@` line (the text after
//     `@@`, its surrounding spaces removed, is the anchor; an empty text is
//     no anchor) or, for the first chunk, at a body line. Body lines start
//     with ` `, `-` or `+`, or are empty (an empty context line). A
//     `*** End of File` line ends a chunk and anchors it to the end of the
//     file. An Update File section with no chunk and no `*** Move to:` is a
//     parse error at its header line. A patch with no section at all is a
//     parse error at line 1 (section 2).
// Applying (SPEC sections 5 and 8):
//   - Add File creates (LF, ended by a line break unless empty); Delete File
//     deletes; Update File runs its chunks in order with a cursor that
//     starts at line 0. A chunk with an anchor first finds the first line at
//     or after the cursor equal to the anchor at the first tier with one,
//     else `no-match`, and moves the cursor past it. O (context and `-`
//     lines) takes the first occurrence at or after the cursor at the first
//     tier with one; an end-of-file chunk takes only an occurrence ending at
//     the file's last line (later tiers are still tried). An empty O inserts
//     N at the cursor, or at the end of the file for an end-of-file chunk.
//     Context lines of N are written as the file's own matched lines; at
//     tier 2 every other line of N is re-indented. The cursor then moves to
//     just after the lines written. The file keeps its own line break and
//     final break.

export interface V4ABodyLine {
  /** ` ` context, `-` old, `+` new. */
  kind: ' ' | '-' | '+';
  text: string;
}

export interface V4AChunk {
  /** Anchor text, or null when the chunk has none. */
  anchor: string | null;
  /** Body lines in order. */
  body: V4ABodyLine[];
  /** Old lines O: context and `-` texts in body order. */
  o: string[];
  /** New lines N: context and `+` texts in body order. */
  n: string[];
  /** Closed by `*** End of File`: O must end at the file's last line. */
  eof: boolean;
}

export type V4AEdit =
  | { kind: 'create'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4AChunk[] };

export type V4AParse = { ok: true; edits: V4AEdit[] } | { ok: false; line: number };

const V4A_BEGIN = '*** Begin Patch';
const V4A_END = '*** End Patch';
const V4A_EOF = '*** End of File';
const ADD_PREFIX = '*** Add File:';
const DEL_PREFIX = '*** Delete File:';
const UPD_PREFIX = '*** Update File:';
const MOVE_PREFIX = '*** Move to:';

function isBlank(s: string): boolean {
  return s.trim() === '';
}

/** Surrounding spaces removed (SPEC section 8 paths and anchors). */
function stripSpaces(s: string): string {
  return s.replace(/^ +| +$/g, '');
}

function sectionKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith(ADD_PREFIX)) return 'add';
  if (line.startsWith(DEL_PREFIX)) return 'delete';
  if (line.startsWith(UPD_PREFIX)) return 'update';
  return null;
}

function sectionPrefix(kind: 'add' | 'delete' | 'update'): string {
  return kind === 'add' ? ADD_PREFIX : kind === 'delete' ? DEL_PREFIX : UPD_PREFIX;
}

/** O/N split of one chunk body: O is context + `-`, N is context + `+`. */
export function v4aChunkOldNew(body: V4ABodyLine[]): { o: string[]; n: string[] } {
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

export function v4aEdits(lines: string[]): V4AParse {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return { ok: false, line: 1 };
  if (lines[first].trim() !== V4A_BEGIN) return { ok: false, line: first + 1 };
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== V4A_END) return { ok: false, line: n + 1 };

  const edits: V4AEdit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i])) {
      i++;
      continue;
    }
    const kind = sectionKind(lines[i]);
    if (kind === null) return { ok: false, line: i + 1 };
    const headerLine = i + 1;
    const path = stripSpaces(lines[i].slice(sectionPrefix(kind).length));
    // Section content runs to the next section header or `*** End Patch`.
    // Any other `***` line (a middle End Patch, Begin Patch, Move to outside
    // an Update section) stays inside the content and fails validation.
    let j = i + 1;
    while (j < last && sectionKind(lines[j]) === null) j++;
    // Blank lines at the end of a section are not part of it.
    let end = j;
    while (end > i + 1 && isBlank(lines[end - 1])) end--;
    const content = lines.slice(i + 1, end);

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < content.length; k++) {
        const l = content[k];
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else return { ok: false, line: i + 2 + k };
      }
      edits.push({ kind: 'create', path, lines: fileLines });
    } else if (kind === 'delete') {
      for (let k = 0; k < content.length; k++) {
        if (!isBlank(content[k])) return { ok: false, line: i + 2 + k };
      }
      edits.push({ kind: 'delete', path });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (k < content.length && content[k].startsWith(MOVE_PREFIX)) {
        moveTo = stripSpaces(content[k].slice(MOVE_PREFIX.length));
        k++;
      }
      const chunks: V4AChunk[] = [];
      let cur: { anchor: string | null; body: V4ABodyLine[]; eof: boolean } | null = null;
      const pushCur = (): void => {
        if (cur !== null) {
          const { o, n: nn } = v4aChunkOldNew(cur.body);
          chunks.push({ anchor: cur.anchor, body: cur.body, o, n: nn, eof: cur.eof });
          cur = null;
        }
      };
      let bad = -1;
      for (; k < content.length; k++) {
        const l = content[k];
        const lineNo = i + 2 + k;
        if (l.startsWith('@@')) {
          pushCur();
          const anchor = stripSpaces(l.slice(2));
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
        } else if (l === V4A_EOF) {
          if (cur === null) {
            bad = lineNo;
            break;
          }
          cur.eof = true;
          pushCur();
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            // Only the first chunk may start at a body line.
            if (chunks.length > 0) {
              bad = lineNo;
              break;
            }
            cur = { anchor: null, body: [], eof: false };
          }
          const bk: ' ' | '-' | '+' = l === '' ? ' ' : (l.charAt(0) as ' ' | '-' | '+');
          cur.body.push({ kind: bk, text: l === '' ? '' : l.slice(1) });
        } else {
          bad = lineNo;
          break;
        }
      }
      if (bad !== -1) return { ok: false, line: bad };
      pushCur();
      if (chunks.length === 0 && moveTo === null) return { ok: false, line: headerLine };
      edits.push({ kind: 'update', path, moveTo, chunks });
    }
    i = j;
  }
  if (edits.length === 0) return { ok: false, line: 1 };
  return { ok: true, edits };
}

// --- Applying chunks (SPEC sections 5 and 8) ---

export interface V4ASplit {
  brk: string;
  lines: string[];
  endsWithBreak: boolean;
}

export function splitV4AFile(text: string): V4ASplit {
  if (text === '') return { brk: '\n', lines: [], endsWithBreak: false };
  const idx = text.indexOf('\n');
  const brk = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(brk);
  const parts = text.split(brk);
  if (endsWithBreak) parts.pop();
  return { brk, lines: parts, endsWithBreak };
}

export function joinV4AFile(f: V4ASplit): string {
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

function tiersFor(strict: boolean): Array<0 | 1 | 2> {
  return strict ? [0] : [0, 1, 2];
}

/** First line at or after `from` equal to the anchor, else -1. */
function findAnchor(fileLines: string[], anchor: string, from: number, strict: boolean): number {
  for (const tier of tiersFor(strict)) {
    for (let j = from; j < fileLines.length; j++) {
      if (linesEqualAtTier(fileLines[j], anchor, tier)) return j;
    }
  }
  return -1;
}

/**
 * First occurrence of O at or after `from` at the first tier with one. An
 * end-of-file chunk takes only an occurrence ending at the file's last
 * line; later tiers are still tried when none does.
 */
function matchChunkFrom(
  fileLines: string[],
  o: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: 0 | 1 | 2; pos: number } | null {
  for (const tier of tiersFor(strict)) {
    const occ = occurrencesAtTier(fileLines, o, tier).filter(
      (p) => p >= from && (!eof || p + o.length === fileLines.length),
    );
    if (occ.length > 0) return { tier, pos: occ[0] };
  }
  return null;
}

/**
 * Apply chunks in order to an already-split file, tracking the cursor.
 * Returns the new split file, or null when an anchor or O has no match.
 */
export function applyChunksToSplit(start: V4ASplit, chunks: V4AChunk[], strict: boolean): V4ASplit | null {
  const lines = [...start.lines];
  const endsWithBreak = start.endsWithBreak;
  const brk = start.brk;
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const a = findAnchor(lines, c.anchor, cursor, strict);
      if (a === -1) return null;
      cursor = a + 1;
    }
    if (c.o.length === 0) {
      // Empty O inserts N at the cursor, or at the end of the file for an
      // end-of-file chunk.
      const at = c.eof ? lines.length : Math.min(cursor, lines.length);
      lines.splice(at, 0, ...c.n);
      cursor = at + c.n.length;
      continue;
    }
    const found = matchChunkFrom(lines, c.o, cursor, strict, c.eof);
    if (found === null) return null;
    // Build the replacement: context lines come from the file's own matched
    // lines; other N lines from the patch (re-indented at tier 2).
    const rep: string[] = [];
    let oi = 0;
    let P: string | null = null;
    let F = '';
    if (found.tier === 2) {
      P = leadingST(c.o[0]);
      F = leadingST(lines[found.pos]);
    }
    for (const b of c.body) {
      if (b.kind === ' ') {
        rep.push(lines[found.pos + oi]);
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
    lines.splice(found.pos, c.o.length, ...rep);
    cursor = found.pos + rep.length;
  }
  return { brk, lines, endsWithBreak };
}

export function isSafeV4APath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const s of p.split('/')) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

export type V4AApplyOk =
  | { kind: 'create'; path: string; text: string }
  | { kind: 'delete'; path: string }
  | { kind: 'move'; oldPath: string; newPath: string; text: string }
  | { kind: 'change'; path: string; text: string }
  | { kind: 'noop-change'; path: string };

export type V4AApplyResult =
  | { ok: true; value: V4AApplyOk }
  | { ok: false; code: 'unsafe' | 'missing' | 'exists' | 'no-match'; path: string };

/**
 * Apply one parsed section. getFile returns the current text, or null when
 * absent. Add creates (LF, trailing break unless empty); Delete removes;
 * Update runs its chunks with a cursor from line 0 (Move to writes the
 * result at the new path and deletes the old one). A chunk failure fails
 * the section with `no-match` and changes nothing.
 */
export function applyV4AEdit(
  edit: V4AEdit,
  getFile: (path: string) => string | null,
  strict: boolean,
): V4AApplyResult {
  const named = edit.kind === 'update' && edit.moveTo !== null ? [edit.path, edit.moveTo] : [edit.path];
  for (const p of named) {
    if (!isSafeV4APath(p)) return { ok: false, code: 'unsafe', path: p };
  }
  if (edit.kind === 'create') {
    if (getFile(edit.path) !== null) return { ok: false, code: 'exists', path: edit.path };
    if (edit.lines.length === 0) return { ok: true, value: { kind: 'create', path: edit.path, text: '' } };
    return { ok: true, value: { kind: 'create', path: edit.path, text: edit.lines.join('\n') + '\n' } };
  }
  if (edit.kind === 'delete') {
    if (getFile(edit.path) === null) return { ok: false, code: 'missing', path: edit.path };
    return { ok: true, value: { kind: 'delete', path: edit.path } };
  }
  const cur = getFile(edit.path);
  if (cur === null) return { ok: false, code: 'missing', path: edit.path };
  if (edit.moveTo !== null && getFile(edit.moveTo) !== null) {
    return { ok: false, code: 'exists', path: edit.moveTo };
  }
  const start = splitV4AFile(cur);
  const before = joinV4AFile(start);
  const next = applyChunksToSplit(start, edit.chunks, strict);
  if (next === null) return { ok: false, code: 'no-match', path: edit.path };
  const text = joinV4AFile(next);
  if (edit.moveTo !== null) {
    return { ok: true, value: { kind: 'move', oldPath: edit.path, newPath: edit.moveTo, text } };
  }
  if (text === before) return { ok: true, value: { kind: 'noop-change', path: edit.path } };
  return { ok: true, value: { kind: 'change', path: edit.path, text } };
}
