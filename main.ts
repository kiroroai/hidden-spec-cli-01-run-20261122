// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// Sections 1-4, 9 and 10 (invocation, output/exit codes, safe paths, format detection, JSON edits, all-or-nothing
// write) follow the kit starter's structure; sections 5-8 below are my own implementation from SPEC.md:
// three-tier line matching, unified diffs, SEARCH/REPLACE blocks and V4A patches.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Section 3 helpers: a file as lines, its line break, its final break */
/* ------------------------------------------------------------------ */

interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/* --------------------------------------------------------------- */
/* Section 5: three-tier line matching and tier-2 re-indentation    */
/* --------------------------------------------------------------- */

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return stripWs(a) === stripWs(b);
}

function occurrencesAt(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineMatches(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  pos: number[];
}

function findTier(lines: string[], o: string[], strict: boolean, from = 0): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrencesAt(lines, o, tier, from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** One line of a replacement: a context line (its index in O) or a fresh line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

function reindent(line: string, f: string, p: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** Build the lines that replace O at position `pos`, honouring section 5. */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const f = tier === 2 ? leadWs(fileLines[pos] ?? '') : '';
  const p = tier === 2 ? leadWs(o[0] ?? '') : '';
  return n.map((entry) => {
    if (entry.ctx !== null) return fileLines[pos + entry.ctx]!;
    if (tier === 2) return reindent(entry.text, f, p);
    return entry.text;
  });
}

/** Split hunk/chunk body lines into O lines and N lines (with context mapping). */
function splitBody(body: string[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const bl of body) {
    if (bl === '') {
      // An empty body line is a context line whose text is empty (section 6/8).
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (bl.startsWith(' ')) {
      o.push(bl.slice(1));
      n.push({ text: bl.slice(1), ctx: o.length - 1 });
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      n.push({ text: bl.slice(1), ctx: null });
    }
    // a `\` line is handled by the caller (final-break rule); it is neither O nor N.
  }
  return { o, n };
}

/** True when a `\` line follows the body's last context or `+` line. */
function noNewlineAfterLast(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '' || body[i]!.startsWith(' ') || body[i]!.startsWith('+')) last = i;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.startsWith('\\');
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* --------------------------------------------------------------- */
/* Section 6: unified diffs                                         */
/* --------------------------------------------------------------- */

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  diffOld?: string;
  diffNew?: string;
  hdrOld?: string;
  hdrNew?: string;
  renFrom?: string;
  renTo?: string;
  newFile: boolean;
  delFile: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  return line.slice(4).split('\t')[0].trim();
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Apply one hunk to a file state; `d` is the cumulative line delta of earlier hunks. */
function applyHunk(st: FileState, hunk: Hunk, d: number, strict: boolean, path: string): { state: FileState; delta: number } {
  const { o, n } = splitBody(hunk.body);
  const noNl = noNewlineAfterLast(hunk.body);
  if (o.length === 0) {
    const at = Math.min(Math.max(hunk.a + d, 0), st.lines.length);
    const lines = [...st.lines];
    lines.splice(at, 0, ...n.map((e) => e.text));
    const fin = at === st.lines.length ? !noNl : st.final;
    return { state: { br: st.br, lines, final: fin }, delta: n.length };
  }
  const hit = findTier(st.lines, o, strict);
  if (hit === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = hit.pos[0]!;
  let best = Math.abs(pos - target);
  for (const p of hit.pos) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      best = dist;
      pos = p;
    }
  }
  const repl = buildReplacement(st.lines, pos, o, n, hit.tier);
  const lines = [...st.lines.slice(0, pos), ...repl, ...st.lines.slice(pos + o.length)];
  const fin = pos + o.length === st.lines.length ? !noNl : st.final;
  return { state: { br: st.br, lines, final: fin }, delta: n.length - o.length };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let i = 0;
  const startSection = (): UniSection => {
    const s: UniSection = { newFile: false, delFile: false, hasPair: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = stripAB(headerPath(line));
      const newP = stripAB(headerPath(lines[i + 1]!));
      if (cur !== null && !cur.hasPair && cur.hunks.length === 0) {
        cur.hdrOld = oldP;
        cur.hdrNew = newP;
        cur.hasPair = true;
      } else {
        const s = startSection();
        s.hdrOld = oldP;
        s.hdrNew = newP;
        s.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          hunk.body.push(bl);
          i += 1;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      // index, old/new mode, similarity/dissimilarity and any other header line: ignored.
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i += 1;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.hdrOld ?? s.renFrom ?? s.diffOld;
    const newP = s.hdrNew ?? s.renTo ?? s.diffNew;
    if (oldP === undefined || newP === undefined) throw new Exit2('error: parse 1');
    const isCreate = oldP === '/dev/null' || s.newFile;
    const isDelete = newP === '/dev/null' || s.delFile;
    if (isCreate) {
      edits.push((tree) => {
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let noNl = false;
        for (const h of s.hunks) {
          for (let j = 0; j < h.body.length; j += 1) {
            if (h.body[j]!.startsWith('+')) plus.push(h.body[j]!.slice(1));
          }
        }
        for (let h = s.hunks.length - 1; h >= 0; h -= 1) {
          const body = s.hunks[h]!.body;
          let last = -1;
          for (let j = 0; j < body.length; j += 1) if (body[j]!.startsWith('+')) last = j;
          if (last >= 0) {
            const next = body[last + 1];
            noNl = next !== undefined && next.startsWith('\\');
            break;
          }
        }
        tree.now.set(newP, plus.length === 0 ? '' : `${plus.join('\n')}${noNl ? '' : '\n'}`);
      });
      continue;
    }
    if (isDelete) {
      edits.push((tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
      });
      continue;
    }
    const isMove = oldP !== newP;
    edits.push((tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
      let st = splitFile(before);
      let d = 0;
      for (const h of s.hunks) {
        const r = applyHunk(st, h, d, strict, oldP);
        st = r.state;
        d += r.delta;
      }
      const text = joinFile(st.lines, st.br, st.final);
      if (isMove) {
        tree.now.set(oldP, null);
        tree.now.set(newP, text);
        tree.moves.push([oldP, newP]);
      } else {
        tree.now.set(oldP, text);
      }
    });
  }
  return edits;
}

/* --------------------------------------------------------------- */
/* Section 7: SEARCH/REPLACE blocks                                 */
/* --------------------------------------------------------------- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevReplace; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${sIdx + 1}`);
    }
    prevPath = path;
    prevReplace = rep;
    const p = path;
    const o = oldLines;
    const nw = newLines;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, nw.length === 0 ? '' : `${nw.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const st = splitFile(before);
      const hit = findTier(st.lines, o, strict);
      if (hit === null) throw new Fail('no-match', p);
      if (hit.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = hit.pos[0]!;
      const repl = buildReplacement(st.lines, pos, o, nw.map((t) => ({ text: t, ctx: null })), hit.tier);
      const out = [...st.lines.slice(0, pos), ...repl, ...st.lines.slice(pos + o.length)];
      tree.now.set(p, joinFile(out, st.br, st.final));
    });
    i = rep + 1;
  }
  return edits;
}

/* --------------------------------------------------------------- */
/* Section 8: V4A patches                                            */
/* --------------------------------------------------------------- */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

const ADD_PREFIX = '*** Add File:';
const DEL_PREFIX = '*** Delete File:';
const UPD_PREFIX = '*** Update File:';

function sectionHeaderKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith(ADD_PREFIX)) return 'add';
  if (line.startsWith(DEL_PREFIX)) return 'delete';
  if (line.startsWith(UPD_PREFIX)) return 'update';
  return null;
}

function sectionHeaderPath(line: string): string {
  const colon = line.indexOf(':');
  return line.slice(colon + 1).trim();
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = sectionHeaderKind(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const path = sectionHeaderPath(line);
    i += 1;
    if (kind === 'add') {
      const fileLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (sectionHeaderKind(l) !== null) break;
        if (l === '' || l.startsWith('+')) {
          fileLines.push(l.startsWith('+') ? l.slice(1) : '');
          i += 1;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      const p = path;
      const fl = fileLines;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : `${fl.join('\n')}\n`);
      });
      continue;
    }
    if (kind === 'delete') {
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    // Update File section.
    let moveTo: string | null = null;
    const chunks: V4aChunk[] = [];
    let curChunk: V4aChunk | null = null;
    while (i < last) {
      const l = lines[i]!;
      if (sectionHeaderKind(l) !== null) break;
      if (l.startsWith('*** Move to:')) {
        if (moveTo !== null || chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
        moveTo = l.slice('*** Move to:'.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        curChunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
        chunks.push(curChunk);
        i += 1;
        continue;
      }
      if (l.trim() === '*** End of File') {
        if (curChunk === null) {
          curChunk = { anchor: null, eof: true, body: [] };
          chunks.push(curChunk);
        } else curChunk.eof = true;
        i += 1;
        continue;
      }
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
        if (curChunk === null) {
          curChunk = { anchor: null, eof: false, body: [] };
          chunks.push(curChunk);
        }
        curChunk.body.push(l);
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // Blank lines at the end of a section are not part of it.
    if (chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1]!;
      while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
    const p = path;
    const mv = moveTo;
    const chs = chunks;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
      let st = splitFile(before);
      let cursor = 0;
      for (const chunk of chs) {
        if (chunk.anchor !== null && chunk.anchor !== '') {
          const hit = findTier(st.lines, [chunk.anchor], strict, cursor);
          if (hit === null) throw new Fail('no-match', p);
          cursor = hit.pos[0]! + 1;
        }
        const { o, n } = splitBody(chunk.body);
        if (o.length === 0) {
          const at = Math.min(chunk.eof ? st.lines.length : cursor, st.lines.length);
          const out = [...st.lines];
          out.splice(at, 0, ...n.map((e) => e.text));
          st = { br: st.br, lines: out, final: st.final };
          cursor = at + n.length;
          continue;
        }
        const hit = findTier(st.lines, o, strict, cursor);
        if (hit === null) throw new Fail('no-match', p);
        let pos: number | null = null;
        for (const cand of hit.pos) {
          if (chunk.eof && cand + o.length !== st.lines.length) continue;
          pos = cand;
          break;
        }
        if (pos === null) throw new Fail('no-match', p);
        const repl = buildReplacement(st.lines, pos, o, n, hit.tier);
        st = { br: st.br, lines: [...st.lines.slice(0, pos), ...repl, ...st.lines.slice(pos + o.length)], final: st.final };
        cursor = pos + repl.length;
      }
      const text = joinFile(st.lines, st.br, st.final);
      if (mv !== null) {
        tree.now.set(p, null);
        tree.now.set(mv, text);
        tree.moves.push([p, mv]);
      } else {
        tree.now.set(p, text);
      }
    });
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const consumed = new Set<string>();
  const rowsObj: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      consumed.add(oldP);
      consumed.add(newP);
      rowsObj.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rowsObj.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowsObj.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowsObj.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
