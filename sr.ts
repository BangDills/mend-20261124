// sr.ts — SPEC section 7: SEARCH/REPLACE-block parser and applier.
//
// Pure module: no filesystem access. A later step wires srEdits into
// main.ts the way unifiedEdits is wired today.
//
// Parsing (blocks, markers, paths):
//   - A block starts at a line whose text with trailing whitespace removed
//     is `<<<<<<< SEARCH`. Lines outside blocks are ignored (prose, fences).
//   - The path is the nearest line before the SEARCH line (after the
//     previous block's `>>>>>>> REPLACE` line, or the patch start) that is
//     neither blank nor, with its surrounding whitespace removed, starting
//     with three backticks; the path is that line with its surrounding
//     whitespace removed. With no such line the block reuses the previous
//     block's path; the first block with none is a parse error at its
//     SEARCH line.
//   - Old lines run from after SEARCH to the next `=======` line, new lines
//     from after it to the next `>>>>>>> REPLACE` line; markers match with
//     trailing whitespace removed, so a marker with leading whitespace is
//     content, not a marker. A SEARCH with no `=======` and then
//     `>>>>>>> REPLACE` after it is a parse error at the SEARCH line.
//   - A patch with no block at all is a parse error at line 1 (section 2).
// Applying (SPEC sections 5 and 7):
//   - Empty old lines create the file with the new lines (else `exists`);
//     created files use LF and end with a line break unless empty.
//   - Otherwise the file exists (else `missing`) and the old lines occur at
//     their tier exactly once: none is `no-match`, several `ambiguous`.
//     Tier-2 matches re-indent the new lines (SPEC section 5); other tiers
//     write them as they are. The file keeps its own line break and final
//     break.

export interface SREdit {
  /** `create` when the old lines are empty, else `change`. */
  kind: 'create' | 'change';
  /** Nearest non-blank non-fence line above SEARCH, trimmed. */
  path: string;
  /** Old lines O between SEARCH and `=======`. */
  o: string[];
  /** New lines N between `=======` and `>>>>>>> REPLACE`. */
  n: string[];
  /** Alias of `o`. */
  oldLines: string[];
  /** Alias of `n`. */
  newLines: string[];
}

export type SRParse = { ok: true; edits: SREdit[] } | { ok: false; line: number };

const SR_SEARCH = '<<<<<<< SEARCH';
const SR_SEP = '=======';
const SR_END = '>>>>>>> REPLACE';

/** Markers match with trailing whitespace removed (SPEC section 7). */
function markerOf(line: string): string {
  return line.replace(/\s+$/, '');
}

export function srEdits(lines: string[]): SRParse {
  const edits: SREdit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (markerOf(lines[i]) !== SR_SEARCH) {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // Nearest qualifying line after the previous block's REPLACE (or the
    // patch start); blank lines and fenced lines (trimmed, starting with
    // ```) are skipped. The path is the line trimmed.
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k--) {
      const t = lines[k].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) return { ok: false, line: searchLine };
      path = prevPath;
    }
    // Old lines end at the next `=======`; new lines at the next
    // `>>>>>>> REPLACE` after that. Either missing is a parse error at
    // the SEARCH line.
    let sep = -1;
    for (let k = i + 1; k < n; k++) {
      if (markerOf(lines[k]) === SR_SEP) {
        sep = k;
        break;
      }
    }
    if (sep === -1) return { ok: false, line: searchLine };
    let end = -1;
    for (let k = sep + 1; k < n; k++) {
      if (markerOf(lines[k]) === SR_END) {
        end = k;
        break;
      }
    }
    if (end === -1) return { ok: false, line: searchLine };
    const o = lines.slice(i + 1, sep);
    const nn = lines.slice(sep + 1, end);
    edits.push({ kind: o.length === 0 ? 'create' : 'change', path, o, n: nn, oldLines: o, newLines: nn });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) return { ok: false, line: 1 };
  return { ok: true, edits };
}

// --- Applying blocks (SPEC sections 5 and 7) ---

interface SRSplit {
  brk: string;
  lines: string[];
  endsWithBreak: boolean;
}

function splitSRFile(text: string): SRSplit {
  if (text === '') return { brk: '\n', lines: [], endsWithBreak: false };
  const idx = text.indexOf('\n');
  const brk = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(brk);
  const lines = text.split(brk);
  if (endsWithBreak) lines.pop();
  return { brk, lines, endsWithBreak };
}

function joinSRFile(f: SRSplit): string {
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

function matchSRTier(
  fileLines: string[],
  o: string[],
  strict: boolean,
): { tier: 0 | 1 | 2; occ: number[] } | null {
  const tiers: Array<0 | 1 | 2> = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrencesAtTier(fileLines, o, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

export function isSafeSRPath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const s of p.split('/')) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

export type SRApplyOk =
  | { kind: 'create'; path: string; text: string }
  | { kind: 'change'; path: string; text: string }
  | { kind: 'noop-change'; path: string };

export type SRApplyResult =
  | { ok: true; value: SRApplyOk }
  | { ok: false; code: 'unsafe' | 'missing' | 'exists' | 'no-match' | 'ambiguous'; path: string };

/**
 * Apply one parsed block. getFile returns the current text, or null when
 * absent. Empty old lines create the file (LF, trailing break unless the
 * new lines are empty); otherwise the old lines must occur at their tier
 * exactly once, or the block fails with `no-match` / `ambiguous`.
 */
export function applySREdit(
  edit: SREdit,
  getFile: (path: string) => string | null,
  strict: boolean,
): SRApplyResult {
  if (!isSafeSRPath(edit.path)) return { ok: false, code: 'unsafe', path: edit.path };
  if (edit.o.length === 0) {
    if (getFile(edit.path) !== null) return { ok: false, code: 'exists', path: edit.path };
    if (edit.n.length === 0) return { ok: true, value: { kind: 'create', path: edit.path, text: '' } };
    return { ok: true, value: { kind: 'create', path: edit.path, text: edit.n.join('\n') + '\n' } };
  }
  const cur = getFile(edit.path);
  if (cur === null) return { ok: false, code: 'missing', path: edit.path };
  const start = splitSRFile(cur);
  const before = joinSRFile(start);
  const found = matchSRTier(start.lines, edit.o, strict);
  if (found === null) return { ok: false, code: 'no-match', path: edit.path };
  if (found.occ.length > 1) return { ok: false, code: 'ambiguous', path: edit.path };
  const pos = found.occ[0];
  // At tier 2 the new lines are re-indented: leading P (old first line's
  // indent) becomes F (the file's first matched line's indent).
  let rep = [...edit.n];
  if (found.tier === 2) {
    const P = leadingST(edit.o[0]);
    const F = leadingST(start.lines[pos]);
    rep = rep.map((t) =>
      t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(P) ? F + t.slice(P.length) : t,
    );
  }
  const lines = [...start.lines];
  lines.splice(pos, edit.o.length, ...rep);
  const text = joinSRFile({ brk: start.brk, lines, endsWithBreak: start.endsWithBreak });
  if (text === before) return { ok: true, value: { kind: 'noop-change', path: edit.path } };
  return { ok: true, value: { kind: 'change', path: edit.path, text } };
}
