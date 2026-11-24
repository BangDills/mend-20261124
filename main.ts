import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { unifiedEdits, applyUnifiedEdit, type UnifiedEdit } from './unified.ts';
import { srEdits, applySREdit, type SREdit } from './sr.ts';
import { v4aEdits, applyV4AEdit, type V4AEdit } from './v4a.ts';

async function maybeRunTrial(): Promise<boolean> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl !== undefined && envUrl !== '') {
    const { runTrial } = await import('./runner.ts');
    await runTrial(envUrl);
    return true;
  }
  return false;
}

function out(line: string): void {
  process.stdout.write(line + '\n');
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && text.endsWith('\n')) {
    parts.pop();
  }
  for (let i = 0; i < parts.length; i++) {
    const l = parts[i];
    if (l.endsWith('\r')) parts[i] = l.slice(0, -1);
  }
  return parts;
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

type Edit =
  | { kind: 'create'; path: string; file_text: string }
  | { kind: 'str_replace'; path: string; old_str: string; new_str: string }
  | { kind: 'insert'; path: string; insert_line: number; new_str: string };

function validateEditObject(o: unknown): Edit | null {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const obj = o as Record<string, unknown>;
  if (typeof obj['command'] !== 'string') return null;
  if (typeof obj['path'] !== 'string') return null;
  const command = obj['command'] as string;
  const path = obj['path'] as string;
  if (command === 'create') {
    if (typeof obj['file_text'] !== 'string') return null;
    return { kind: 'create', path, file_text: obj['file_text'] as string };
  }
  if (command === 'str_replace') {
    if (typeof obj['old_str'] !== 'string') return null;
    const old_str = obj['old_str'] as string;
    if (old_str === '') return null;
    let new_str: string;
    if (!('new_str' in obj) || obj['new_str'] === undefined) {
      new_str = '';
    } else {
      if (typeof obj['new_str'] !== 'string') return null;
      new_str = obj['new_str'] as string;
    }
    return { kind: 'str_replace', path, old_str, new_str };
  }
  if (command === 'insert') {
    if (typeof obj['insert_line'] !== 'number' || !Number.isInteger(obj['insert_line'] as number)) return null;
    if (typeof obj['new_str'] !== 'string') return null;
    return { kind: 'insert', path, insert_line: obj['insert_line'] as number, new_str: obj['new_str'] as string };
  }
  return null;
}

function detectFormat(lines: string[]): string | null {
  let firstNonBlank: string | null = null;
  for (const l of lines) {
    if (!isBlank(l)) {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank === null) return null;
  if (firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
  const trimmedStart = firstNonBlank.replace(/^\s+/, '');
  if (trimmedStart.startsWith('[') || trimmedStart.startsWith('{')) return 'json';
  for (const l of lines) {
    if (l.replace(/\s+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function fileBreakAndLines(text: string): { brk: string; lines: string[]; endsWithBreak: boolean } {
  if (text === '') return { brk: '\n', lines: [], endsWithBreak: false };
  const idx = text.indexOf('\n');
  let brk = '\n';
  if (idx !== -1) {
    brk = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  }
  const endsWithBreak = text.endsWith(brk);
  let parts = text.split(brk);
  if (endsWithBreak) parts.pop();
  return { brk, lines: parts, endsWithBreak };
}

function parseNewStrLines(s: string): string[] {
  if (s === '') return [];
  let parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  return parts;
}

function countOverlapping(text: string, sub: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = text.indexOf(sub, pos);
    if (idx === -1) break;
    count++;
    pos = idx + 1;
    if (pos > text.length) break;
  }
  return count;
}

async function main(): Promise<void> {
  if (await maybeRunTrial()) return;

  const args = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let positionals: string[] = [];
  let endOptions = false;
  let usage = false;

  for (const a of args) {
    if (endOptions) {
      positionals.push(a);
      continue;
    }
    if (a === '--') {
      endOptions = true;
      continue;
    }
    if (a === '-' || !a.startsWith('-')) {
      positionals.push(a);
      continue;
    }
    if (a === '--check') {
      if (seenCheck) usage = true;
      seenCheck = true;
      check = true;
      continue;
    }
    if (a === '--strict') {
      if (seenStrict) usage = true;
      seenStrict = true;
      strict = true;
      continue;
    }
    if (a.startsWith('--format=')) {
      if (seenFormat) usage = true;
      seenFormat = true;
      const v = a.slice('--format='.length);
      if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') {
        usage = true;
      } else {
        format = v;
      }
      continue;
    }
    usage = true;
  }
  if (positionals.length > 1) usage = true;
  if (format === null) format = 'auto';

  if (usage) {
    out('error: usage');
    process.exitCode = 2;
    return;
  }

  const patchArg = positionals.length === 1 ? positionals[0] : null;
  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      patchText = '';
    }
  } else {
    try {
      const st = statSync(patchArg);
      if (st.isDirectory()) throw new Error('isdir');
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      out('error: no-patch');
      process.exitCode = 2;
      return;
    }
  }

  const lines = patchLines(patchText);

  let effectiveFormat: string | null;
  if (format !== 'auto') {
    effectiveFormat = format;
  } else {
    effectiveFormat = detectFormat(lines);
    if (effectiveFormat === null) {
      out('error: format');
      process.exitCode = 2;
      return;
    }
  }

  if (effectiveFormat !== 'json' && effectiveFormat !== 'unified' && effectiveFormat !== 'search-replace' && effectiveFormat !== 'v4a') {
    out('error: parse 1');
    process.exitCode = 2;
    return;
  }

  // Parse JSON edits.
  let edits: Edit[] = [];
  let uedits: UnifiedEdit[] = [];
  let sredits: SREdit[] = [];
  let vedits: V4AEdit[] = [];
  if (effectiveFormat === 'json') {
  {
    let firstNbIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!isBlank(lines[i])) {
        firstNbIdx = i;
        break;
      }
    }
    if (firstNbIdx === -1) {
      out('error: parse 1');
      process.exitCode = 2;
      return;
    }
    const firstNb = lines[firstNbIdx];
    const firstChar = firstNb.replace(/^\s+/, '')[0];
    if (firstChar === '[') {
      const arrayStartLine = firstNbIdx + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(patchText);
      } catch {
        out(`error: parse ${arrayStartLine}`);
        process.exitCode = 2;
        return;
      }
      if (!Array.isArray(parsed)) {
        out(`error: parse ${arrayStartLine}`);
        process.exitCode = 2;
        return;
      }
      if (parsed.length === 0) {
        out('error: parse 1');
        process.exitCode = 2;
        return;
      }
      const tmp: Edit[] = [];
      let bad = false;
      for (const el of parsed) {
        const e = validateEditObject(el);
        if (e === null) {
          bad = true;
          break;
        }
        tmp.push(e);
      }
      if (bad) {
        out(`error: parse ${arrayStartLine}`);
        process.exitCode = 2;
        return;
      }
      edits = tmp;
    } else {
      const tmp: Edit[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (isBlank(lines[i])) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(lines[i]);
        } catch {
          out(`error: parse ${i + 1}`);
          process.exitCode = 2;
          return;
        }
        const e = validateEditObject(parsed);
        if (e === null) {
          out(`error: parse ${i + 1}`);
          process.exitCode = 2;
          return;
        }
        tmp.push(e);
      }
      if (tmp.length === 0) {
        out('error: parse 1');
        process.exitCode = 2;
        return;
      }
      edits = tmp;
    }
  }
  } else if (effectiveFormat === 'unified') {
    const parsed = unifiedEdits(lines);
    if (!parsed.ok) {
      out(`error: parse ${parsed.line}`);
      process.exitCode = 2;
      return;
    }
    if (parsed.edits.length === 0) {
      out('error: parse 1');
      process.exitCode = 2;
      return;
    }
    uedits = parsed.edits;
  } else if (effectiveFormat === 'search-replace') {
    const parsed = srEdits(lines);
    if (!parsed.ok) {
      out(`error: parse ${parsed.line}`);
      process.exitCode = 2;
      return;
    }
    if (parsed.edits.length === 0) {
      out('error: parse 1');
      process.exitCode = 2;
      return;
    }
    sredits = parsed.edits;
  } else {
    const parsed = v4aEdits(lines);
    if (!parsed.ok) {
      out(`error: parse ${parsed.line}`);
      process.exitCode = 2;
      return;
    }
    if (parsed.edits.length === 0) {
      out('error: parse 1');
      process.exitCode = 2;
      return;
    }
    vedits = parsed.edits;
  }

  // Run the unified path when the patch is a unified diff.
  if (effectiveFormat === 'unified') {
    // Shared in-memory tree: regular files plus directory markers so a
    // `create` (or move target) that collides with a directory fails.
    const initialCache = new Map<string, string | null>();
    const current = new Map<string, string | null>();
    const dirSet = new Set<string>();
    const readInitial = (p: string): string | null => {
      if (initialCache.has(p)) return initialCache.get(p)!;
      let v: string | null = null;
      try {
        if (existsSync(p)) {
          const st = statSync(p);
          if (st.isFile()) {
            v = readFileSync(p, 'utf8');
          } else {
            initialCache.set(p, null);
            current.set(p, null);
            dirSet.add(p);
            return null;
          }
        }
      } catch {
        v = null;
      }
      initialCache.set(p, v);
      current.set(p, v);
      return v;
    };
    const allPaths = new Set<string>();
    for (const e of uedits) {
      if (e.kind === 'move') {
        allPaths.add(e.oldPath);
        allPaths.add(e.newPath);
      } else {
        allPaths.add(e.path);
      }
    }
    for (const p of allPaths) readInitial(p);

    type Failure = { code: string; path: string };
    const failures: (Failure | null)[] = [];
    const getFile = (p: string): string | null => {
      if (current.has(p)) return current.get(p)!;
      return readInitial(p);
    };

    for (const e of uedits) {
      // Directories read back as null, but a create (or move target) that
      // collides with one fails with `exists`, not by writing through it.
      const target = e.kind === 'create' ? e.path : e.kind === 'move' ? e.newPath : null;
      if (target !== null && dirSet.has(target) && (current.get(target) ?? null) === null) {
        failures.push({ code: 'exists', path: target });
        continue;
      }
      const res = applyUnifiedEdit(e, getFile, strict);
      if (!res.ok) {
        failures.push({ code: res.code, path: res.path });
        continue;
      }
      const v = res.value;
      if (v.kind === 'create') {
        current.set(v.path, v.text);
        failures.push(null);
      } else if (v.kind === 'delete') {
        current.set(v.path, null);
        failures.push(null);
      } else if (v.kind === 'move') {
        current.set(v.oldPath, null);
        current.set(v.newPath, v.text);
        failures.push(null);
      } else if (v.kind === 'change') {
        current.set(v.path, v.text);
        failures.push(null);
      } else {
        // noop-change: no bytes changed.
        failures.push(null);
      }
    }

    const failedList: Failure[] = [];
    for (const f of failures) if (f !== null) failedList.push(f);
    if (failedList.length > 0) {
      for (const f of failedList) out(`error: ${f.code} ${f.path}`);
      out(`failed: ${failedList.length} of ${uedits.length} edits`);
      process.exitCode = 1;
      return;
    }

    // SPEC section 2: D+A pairs that are a successful move collapse to R.
    const movePairs: { old: string; new: string }[] = [];
    for (const e of uedits) {
      if (e.kind !== 'move') continue;
      const beforeOld = initialCache.get(e.oldPath) ?? null;
      const beforeNew = initialCache.get(e.newPath) ?? null;
      const afterOld = current.get(e.oldPath) ?? null;
      const afterNew = current.get(e.newPath) ?? null;
      if (beforeOld !== null && afterOld === null && beforeNew === null && afterNew !== null) {
        movePairs.push({ old: e.oldPath, new: e.newPath });
      }
    }
    const movedOld = new Set(movePairs.map((m) => m.old));
    const movedNew = new Set(movePairs.map((m) => m.new));

    const changed: { path: string; kind: 'A' | 'M' | 'D' }[] = [];
    const touched = new Set<string>();
    for (const e of uedits) {
      if (e.kind === 'move') {
        touched.add(e.oldPath);
        touched.add(e.newPath);
      } else {
        touched.add(e.path);
      }
    }
    for (const p of touched) {
      if (dirSet.has(p)) continue;
      const before = initialCache.get(p) ?? null;
      const after = current.get(p) ?? null;
      if (before === after) continue;
      if (movedOld.has(p) || movedNew.has(p)) continue;
      if (before === null && after !== null) changed.push({ path: p, kind: 'A' });
      else if (before !== null && after === null) changed.push({ path: p, kind: 'D' });
      else if (before !== null && after !== null && before !== after) changed.push({ path: p, kind: 'M' });
    }
    changed.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
    const renames = [...movePairs].sort((a, b) =>
      Buffer.compare(Buffer.from(a.new, 'utf8'), Buffer.from(b.new, 'utf8')),
    );

    type ChangeLine = { sortKey: string; line: string };
    const changeLines: ChangeLine[] = [
      ...changed.map((c): ChangeLine => ({ sortKey: c.path, line: `${c.kind} ${c.path}` })),
      ...renames.map((m): ChangeLine => ({ sortKey: m.new, line: `R ${m.old} -> ${m.new}` })),
    ];
    // SPEC section 2 lists every changed path in byte order; R lines sort
    // by <new> among the plain kinds.
    const allLines = changeLines.sort((a, b) =>
      Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')),
    );

    if (!check) {
      for (const m of movePairs) {
        try {
          rmSync(m.old, { force: true });
        } catch {}
      }
      for (const p of touched) {
        if (dirSet.has(p)) continue;
        const before = initialCache.get(p) ?? null;
        const after = current.get(p) ?? null;
        if (before === after) continue;
        if (after === null) {
          if (!movedOld.has(p)) {
            try {
              rmSync(p, { force: true });
            } catch {}
          }
        } else {
          const d = dirname(p);
          if (d !== '.' && d !== '') mkdirSync(d, { recursive: true });
          writeFileSync(p, after, 'utf8');
        }
      }
    }

    for (const l of allLines) out(l.line);
    const n = allLines.length;
    out(n === 1 ? 'ok: 1 file' : `ok: ${n} files`);
    process.exitCode = 0;
    return;
  }

  // Run the search-replace path when the patch holds SEARCH/REPLACE blocks.
  if (effectiveFormat === 'search-replace') {
    // Shared in-memory tree: regular files plus directory markers so a
    // `create` that collides with a directory fails with `exists`.
    const initialCache = new Map<string, string | null>();
    const current = new Map<string, string | null>();
    const dirSet = new Set<string>();
    const readInitial = (p: string): string | null => {
      if (initialCache.has(p)) return initialCache.get(p)!;
      let v: string | null = null;
      try {
        if (existsSync(p)) {
          const st = statSync(p);
          if (st.isFile()) {
            v = readFileSync(p, 'utf8');
          } else {
            initialCache.set(p, null);
            current.set(p, null);
            dirSet.add(p);
            return null;
          }
        }
      } catch {
        v = null;
      }
      initialCache.set(p, v);
      current.set(p, v);
      return v;
    };
    const allPaths = new Set<string>();
    for (const e of sredits) allPaths.add(e.path);
    for (const p of allPaths) readInitial(p);

    type Failure = { code: string; path: string };
    const failures: (Failure | null)[] = [];
    const getFile = (p: string): string | null => {
      if (current.has(p)) return current.get(p)!;
      return readInitial(p);
    };

    for (const e of sredits) {
      // Directories read back as null, but a create that collides with one
      // fails with `exists`, not by writing through it.
      if (e.kind === 'create' && dirSet.has(e.path) && (current.get(e.path) ?? null) === null) {
        failures.push({ code: 'exists', path: e.path });
        continue;
      }
      const res = applySREdit(e, getFile, strict);
      if (!res.ok) {
        failures.push({ code: res.code, path: res.path });
        continue;
      }
      const v = res.value;
      if (v.kind === 'create' || v.kind === 'change') {
        current.set(v.path, v.text);
      }
      // noop-change: no bytes changed.
      failures.push(null);
    }

    const failedList: Failure[] = [];
    for (const f of failures) if (f !== null) failedList.push(f);
    if (failedList.length > 0) {
      for (const f of failedList) out(`error: ${f.code} ${f.path}`);
      out(`failed: ${failedList.length} of ${sredits.length} edits`);
      process.exitCode = 1;
      return;
    }

    const changed: { path: string; kind: 'A' | 'M' }[] = [];
    const touched = new Set<string>();
    for (const e of sredits) touched.add(e.path);
    for (const p of touched) {
      if (dirSet.has(p)) continue;
      const before = initialCache.get(p) ?? null;
      const after = current.get(p) ?? null;
      if (before === after) continue;
      if (before === null && after !== null) changed.push({ path: p, kind: 'A' });
      else if (before !== null && after !== null && before !== after) changed.push({ path: p, kind: 'M' });
    }
    changed.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));

    if (!check) {
      for (const p of touched) {
        if (dirSet.has(p)) continue;
        const before = initialCache.get(p) ?? null;
        const after = current.get(p) ?? null;
        if (before === after) continue;
        if (after !== null) {
          const d = dirname(p);
          if (d !== '.' && d !== '') mkdirSync(d, { recursive: true });
          writeFileSync(p, after, 'utf8');
        }
      }
    }

    for (const c of changed) out(`${c.kind} ${c.path}`);
    out(changed.length === 1 ? 'ok: 1 file' : `ok: ${changed.length} files`);
    process.exitCode = 0;
    return;
  }

  // Run the v4a path when the patch holds V4A sections.
  if (effectiveFormat === 'v4a') {
    // Shared in-memory tree: regular files plus directory markers so a
    // `create` (or move target) that collides with a directory fails.
    const initialCache = new Map<string, string | null>();
    const current = new Map<string, string | null>();
    const dirSet = new Set<string>();
    const readInitial = (p: string): string | null => {
      if (initialCache.has(p)) return initialCache.get(p)!;
      let v: string | null = null;
      try {
        if (existsSync(p)) {
          const st = statSync(p);
          if (st.isFile()) {
            v = readFileSync(p, 'utf8');
          } else {
            initialCache.set(p, null);
            current.set(p, null);
            dirSet.add(p);
            return null;
          }
        }
      } catch {
        v = null;
      }
      initialCache.set(p, v);
      current.set(p, v);
      return v;
    };
    const allPaths = new Set<string>();
    for (const e of vedits) {
      if (e.kind === 'update' && e.moveTo !== null) {
        allPaths.add(e.path);
        allPaths.add(e.moveTo);
      } else {
        allPaths.add(e.path);
      }
    }
    for (const p of allPaths) readInitial(p);

    type Failure = { code: string; path: string };
    const failures: (Failure | null)[] = [];
    const getFile = (p: string): string | null => {
      if (current.has(p)) return current.get(p)!;
      return readInitial(p);
    };

    for (const e of vedits) {
      // Directories read back as null, but a create (or move target) that
      // collides with one fails with `exists`, not by writing through it.
      const target = e.kind === 'create' ? e.path : e.kind === 'update' && e.moveTo !== null ? e.moveTo : null;
      if (target !== null && dirSet.has(target) && (current.get(target) ?? null) === null) {
        failures.push({ code: 'exists', path: target });
        continue;
      }
      const res = applyV4AEdit(e, getFile, strict);
      if (!res.ok) {
        failures.push({ code: res.code, path: res.path });
        continue;
      }
      const v = res.value;
      if (v.kind === 'create') {
        current.set(v.path, v.text);
        failures.push(null);
      } else if (v.kind === 'delete') {
        current.set(v.path, null);
        failures.push(null);
      } else if (v.kind === 'move') {
        current.set(v.oldPath, null);
        current.set(v.newPath, v.text);
        failures.push(null);
      } else if (v.kind === 'change') {
        current.set(v.path, v.text);
        failures.push(null);
      } else {
        // noop-change: no bytes changed.
        failures.push(null);
      }
    }

    const failedList: Failure[] = [];
    for (const f of failures) if (f !== null) failedList.push(f);
    if (failedList.length > 0) {
      for (const f of failedList) out(`error: ${f.code} ${f.path}`);
      out(`failed: ${failedList.length} of ${vedits.length} edits`);
      process.exitCode = 1;
      return;
    }

    // SPEC section 2: D+A pairs that are a successful move collapse to R.
    const movePairs: { old: string; new: string }[] = [];
    for (const e of vedits) {
      if (e.kind !== 'update' || e.moveTo === null) continue;
      const beforeOld = initialCache.get(e.path) ?? null;
      const beforeNew = initialCache.get(e.moveTo) ?? null;
      const afterOld = current.get(e.path) ?? null;
      const afterNew = current.get(e.moveTo) ?? null;
      if (beforeOld !== null && afterOld === null && beforeNew === null && afterNew !== null) {
        movePairs.push({ old: e.path, new: e.moveTo });
      }
    }
    const movedOld = new Set(movePairs.map((m) => m.old));
    const movedNew = new Set(movePairs.map((m) => m.new));

    const changed: { path: string; kind: 'A' | 'M' | 'D' }[] = [];
    const touched = new Set<string>();
    for (const e of vedits) {
      if (e.kind === 'update' && e.moveTo !== null) {
        touched.add(e.path);
        touched.add(e.moveTo);
      } else {
        touched.add(e.path);
      }
    }
    for (const p of touched) {
      if (dirSet.has(p)) continue;
      const before = initialCache.get(p) ?? null;
      const after = current.get(p) ?? null;
      if (before === after) continue;
      if (movedOld.has(p) || movedNew.has(p)) continue;
      if (before === null && after !== null) changed.push({ path: p, kind: 'A' });
      else if (before !== null && after === null) changed.push({ path: p, kind: 'D' });
      else if (before !== null && after !== null && before !== after) changed.push({ path: p, kind: 'M' });
    }
    changed.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
    const renames = [...movePairs].sort((a, b) =>
      Buffer.compare(Buffer.from(a.new, 'utf8'), Buffer.from(b.new, 'utf8')),
    );

    type ChangeLine = { sortKey: string; line: string };
    const changeLines: ChangeLine[] = [
      ...changed.map((c): ChangeLine => ({ sortKey: c.path, line: `${c.kind} ${c.path}` })),
      ...renames.map((m): ChangeLine => ({ sortKey: m.new, line: `R ${m.old} -> ${m.new}` })),
    ];
    // SPEC section 2 lists every changed path in byte order; R lines sort
    // by <new> among the plain kinds.
    const allLines = changeLines.sort((a, b) =>
      Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')),
    );

    if (!check) {
      for (const m of movePairs) {
        try {
          rmSync(m.old, { force: true });
        } catch {}
      }
      for (const p of touched) {
        if (dirSet.has(p)) continue;
        const before = initialCache.get(p) ?? null;
        const after = current.get(p) ?? null;
        if (before === after) continue;
        if (after === null) {
          if (!movedOld.has(p)) {
            try {
              rmSync(p, { force: true });
            } catch {}
          }
        } else {
          const d = dirname(p);
          if (d !== '.' && d !== '') mkdirSync(d, { recursive: true });
          writeFileSync(p, after, 'utf8');
        }
      }
    }

    for (const l of allLines) out(l.line);
    const n = allLines.length;
    out(n === 1 ? 'ok: 1 file' : `ok: ${n} files`);
    process.exitCode = 0;
    return;
  }

  // Simulate edits with in-memory tree.
  const initialCache = new Map<string, string | null>();
  const current = new Map<string, string | null>();
  const readInitial = (p: string): string | null => {
    if (initialCache.has(p)) return initialCache.get(p)!;
    let v: string | null = null;
    try {
      if (existsSync(p)) {
        const st = statSync(p);
        if (st.isFile()) {
          v = readFileSync(p, 'utf8');
        } else {
          v = null;
          // Treat directories as existing for `exists` checks? Represent as special marker.
          // Use empty sentinel: store as non-null non-string? Simpler: treat dir as existing string?
          // For create, any existence should fail. For modify, read fails -> missing.
          // Mark initial as null but track dir existence separately.
          initialCache.set(p, null);
          current.set(p, null);
          // stash dir flag
          dirSet.add(p);
          return null;
        }
      }
    } catch {
      v = null;
    }
    initialCache.set(p, v);
    current.set(p, v);
    return v;
  };
  const dirSet = new Set<string>();
  // Prime cache for all edit paths (also records initial existence).
  for (const e of edits) readInitial(e.path);

  const cur = (p: string): string | null => {
    if (current.has(p)) return current.get(p)!;
    return readInitial(p);
  };
  const curExists = (p: string): boolean => {
    if (dirSet.has(p)) return true;
    return cur(p) !== null;
  };

  type Failure = { code: string; path: string };
  const failures: (Failure | null)[] = [];

  for (const e of edits) {
    if (!isSafePath(e.path)) {
      failures.push({ code: 'unsafe', path: e.path });
      continue;
    }
    if (e.kind === 'create') {
      if (curExists(e.path)) {
        failures.push({ code: 'exists', path: e.path });
      } else {
        current.set(e.path, e.file_text);
        dirSet.delete(e.path);
        failures.push(null);
      }
      continue;
    }
    if (e.kind === 'str_replace') {
      if (dirSet.has(e.path) || cur(e.path) === null) {
        failures.push({ code: 'missing', path: e.path });
        continue;
      }
      const fileText = cur(e.path) as string;
      const idx = fileText.indexOf('\n');
      let isCRLF = false;
      if (idx !== -1 && idx > 0 && fileText[idx - 1] === '\r') isCRLF = true;
      if (isCRLF) {
        const normFile = fileText.split('\r\n').join('\n');
        const normOld = e.old_str.split('\r\n').join('\n');
        const normNew = e.new_str.split('\r\n').join('\n');
        const c = countOverlapping(normFile, normOld);
        if (c === 0) {
          failures.push({ code: 'no-match', path: e.path });
        } else if (c > 1) {
          failures.push({ code: 'ambiguous', path: e.path });
        } else {
          const replaced = normFile.replace(normOld, normNew);
          const back = replaced.split('\n').join('\r\n');
          current.set(e.path, back);
          failures.push(null);
        }
      } else {
        const c = countOverlapping(fileText, e.old_str);
        if (c === 0) {
          failures.push({ code: 'no-match', path: e.path });
        } else if (c > 1) {
          failures.push({ code: 'ambiguous', path: e.path });
        } else {
          current.set(e.path, fileText.replace(e.old_str, e.new_str));
          failures.push(null);
        }
      }
      continue;
    }
    if (e.kind === 'insert') {
      if (dirSet.has(e.path) || cur(e.path) === null) {
        failures.push({ code: 'missing', path: e.path });
        continue;
      }
      const fileText = cur(e.path) as string;
      const info = fileBreakAndLines(fileText);
      const n = info.lines.length;
      if (e.insert_line < 0 || e.insert_line > n) {
        failures.push({ code: 'no-match', path: e.path });
        continue;
      }
      const ins = parseNewStrLines(e.new_str);
      const newLines = [...info.lines.slice(0, e.insert_line), ...ins, ...info.lines.slice(e.insert_line)];
      let outText: string;
      if (newLines.length === 0) {
        outText = '';
      } else {
        outText = newLines.join(info.brk);
        if (info.endsWithBreak) outText += info.brk;
      }
      current.set(e.path, outText);
      failures.push(null);
      continue;
    }
  }

  const failedList: Failure[] = [];
  for (const f of failures) if (f !== null) failedList.push(f);
  if (failedList.length > 0) {
    for (const f of failedList) out(`error: ${f.code} ${f.path}`);
    out(`failed: ${failedList.length} of ${edits.length} edits`);
    process.exitCode = 1;
    return;
  }

  // Compute changes vs initial (ignore dir markers).
  const changed: { path: string; kind: 'A' | 'M' | 'D' }[] = [];
  const touched = new Set<string>();
  for (const e of edits) touched.add(e.path);
  for (const p of touched) {
    if (dirSet.has(p)) continue;
    const before = initialCache.get(p) ?? null;
    const after = current.get(p) ?? null;
    if (before === after) continue;
    if (before === null && after !== null) changed.push({ path: p, kind: 'A' });
    else if (before !== null && after === null) changed.push({ path: p, kind: 'D' });
    else if (before !== null && after !== null && before !== after) changed.push({ path: p, kind: 'M' });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));

  if (!check) {
    for (const c of changed) {
      const after = current.get(c.path) as string;
      const d = dirname(c.path);
      if (d !== '.' && d !== '') mkdirSync(d, { recursive: true });
      if (c.kind === 'D') {
        try {
          rmSync(c.path, { force: true });
        } catch {}
      } else {
        writeFileSync(c.path, after, 'utf8');
      }
    }
  }

  for (const c of changed) out(`${c.kind} ${c.path}`);
  out(changed.length === 1 ? 'ok: 1 file' : `ok: ${changed.length} files`);
  process.exitCode = 0;
}

await main();
