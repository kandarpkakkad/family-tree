/*
 * Saving changes made on the website into family.yaml in the private repo.
 *
 * Only the tree's editor uses this, with their own GitHub token. Changes are made to the
 * text of family.yaml one person at a time: that person's lines are rewritten and
 * everything else (other people, comments, blank lines) is left exactly as it was. Every
 * change is read back and compared before anything is saved.
 */
import { load, dump } from './js-yaml.mjs';

const str = (v) => (v == null ? '' : String(v).trim());
const FIELD_ORDER = ['id', 'name', 'nickname', 'gender', 'born', 'died', 'deceased', 'place', 'parents', 'spouses', 'photo', 'bio'];
const DATE_RE = /^\d{4}(-\d{1,2}){0,2}$/;

/* ---------------------------------------------------------------- reading people */

// Finds each person's lines under "people:". A person starts at a "- " line; their lines
// run until the next "- " at the same indent (blank lines and notes in between belong
// to the gap, so a note above someone stays with them).
export function findPeople(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^people:\s*(#.*)?$/.test(l));
  if (start === -1) throw new Error('family.yaml has no "people:" line.');
  let indent = null;
  let end = lines.length;
  const blocks = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const ind = line.length - line.trimStart().length;
    const dash = /^\s*-(\s|$)/.test(line);
    if (indent === null) {
      if (!dash) { end = i; break; }
      indent = ind;
    }
    if (ind < indent || (ind === indent && !dash)) { end = i; break; }
    if (ind === indent) blocks.push({ start: i, end: i + 1 });
    else if (blocks.length) blocks[blocks.length - 1].end = i + 1;
  }
  for (const b of blocks) {
    const parsed = load(lines.slice(b.start, b.end).join('\n'));
    b.data = Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object' ? parsed[0] : {};
    b.id = str(b.data.id);
  }
  const last = blocks.length ? blocks[blocks.length - 1].end : start + 1;
  return { lines, eol, indent: indent ?? 2, blocks, start, end, last };
}

/* ---------------------------------------------------------------- writing a person */

const scalar = (v) => dump(v, { lineWidth: 100000, quoteStyle: 'double' }).replace(/\n+$/, '');

function valueText(key, v) {
  if ((key === 'born' || key === 'died') && DATE_RE.test(str(v))) return str(v);
  if (key === 'deceased') return 'yes';
  if (Array.isArray(v)) return `[${v.map((x) => scalar(typeof x === 'object' ? x : String(x))).join(', ')}]`;
  if (v && typeof v === 'object') return dump(v, { lineWidth: 100000, quoteStyle: 'double', flowLevel: 0 }).trim();
  return scalar(typeof v === 'number' || typeof v === 'boolean' ? v : String(v));
}

const isEmpty = (v) => v == null || v === '' || v === false || (Array.isArray(v) && !v.length);

// The same layout as the rest of the file: "- id:" first, then one field per line.
export function personLines(p, indent) {
  const pad = ' '.repeat(indent);
  const keys = [...FIELD_ORDER.filter((k) => k in p), ...Object.keys(p).filter((k) => !FIELD_ORDER.includes(k))];
  const out = [];
  for (const key of keys) {
    const v = p[key];
    if (isEmpty(v)) continue;
    const lead = out.length ? `${pad}  ` : `${pad}- `;
    const text = typeof v === 'string' ? v.trim() : v;
    if (key === 'bio' && typeof text === 'string' && text.includes('\n') && !/^\s/.test(text)) {
      out.push(`${lead}bio: |`);
      for (const l of text.split('\n')) out.push(l.trim() ? `${pad}    ${l.replace(/\s+$/, '')}` : '');
      continue;
    }
    out.push(`${lead}${key}: ${valueText(key, text)}`);
  }
  return out;
}

/* ---------------------------------------------------------------- changes */

// Two people match when every field reads back the same (1951 and "1951" count as equal).
function same(a, b) {
  const norm = (o) => {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      if (isEmpty(v)) continue;
      if (k === 'deceased') { out[k] = v === true || /^(yes|y|true)$/i.test(str(v)); continue; }
      out[k] = Array.isArray(v) ? v.map((x) => str(x)) : typeof v === 'object' ? JSON.stringify(v) : str(v).replace(/[ \t]+\n/g, '\n');
    }
    return JSON.stringify(Object.keys(out).sort().map((k) => [k, out[k]]));
  };
  return norm(a) === norm(b);
}

// changes: [{ replace: id, person }] or [{ add: person, after: id }], applied in order.
export function applyChanges(text, changes) {
  let current = text;
  for (const change of changes) {
    const doc = findPeople(current);
    if (change.replace) {
      const b = doc.blocks.find((x) => x.id === change.replace);
      if (!b) throw new Error(`"${change.replace}" isn't in family.yaml any more.`);
      doc.lines.splice(b.start, b.end - b.start, ...personLines(change.person, doc.indent));
    } else {
      const id = str(change.add.id);
      if (doc.blocks.some((x) => x.id === id)) throw new Error(`The id "${id}" is already taken.`);
      const after = doc.blocks.find((x) => x.id === change.after);
      const at = after ? after.end : doc.last;
      doc.lines.splice(at, 0, '', ...personLines(change.add, doc.indent));
    }
    current = doc.lines.join(doc.eol);
  }
  // Read the whole file back: it must still be valid, and each changed person must come out as intended.
  const parsed = load(current);
  const list = parsed && Array.isArray(parsed.people) ? parsed.people : null;
  if (!list) throw new Error('The change would break family.yaml, so it wasn\'t saved.');
  for (const change of changes) {
    const want = change.replace ? change.person : change.add;
    const got = list.find((p) => p && str(p.id) === str(want.id));
    if (!got || !same(got, want)) throw new Error(`The change to ${str(want.name) || str(want.id)} didn't read back correctly, so it wasn't saved.`);
  }
  return current;
}

/* ---------------------------------------------------------------- GitHub */

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

export class Repo {
  constructor(repo, token, branch = 'main', path = 'family.yaml') {
    Object.assign(this, { repo, token, branch, path });
  }

  async api(route, { method = 'GET', body, raw = false } = {}) {
    const res = await fetch(`https://api.github.com/repos/${this.repo}${route}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = new Error(res.status === 401 ? 'GitHub didn\'t accept the token (it may have expired).'
        : res.status === 403 || res.status === 404 ? 'The token can\'t reach the family repo. Check it allows Contents: Read and write on that repo.'
          : `GitHub answered ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    if (raw) return new Uint8Array(await res.arrayBuffer());
    return res.status === 204 ? null : res.json();
  }

  async read(ref = this.branch) {
    const file = await this.api(`/contents/${encodeURI(this.path)}?ref=${encodeURIComponent(ref)}`);
    return b64ToText(file.content);
  }

  readFile(path) {
    return this.api(`/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`, { raw: true });
  }

  // One commit with family.yaml plus any photos. update() gets the latest family.yaml text
  // and returns the new text; if someone else saved in the meantime it runs again on theirs.
  async commit(message, update, files = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = await this.api(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
      const head = ref.object.sha;
      const parent = await this.api(`/git/commits/${head}`);
      const text = update(await this.read(head));
      const tree = [];
      const all = { ...files, [this.path]: new TextEncoder().encode(text) };
      for (const [path, bytes] of Object.entries(all)) {
        const blob = await this.api('/git/blobs', { method: 'POST', body: { content: bytesToB64(bytes), encoding: 'base64' } });
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const newTree = await this.api('/git/trees', { method: 'POST', body: { base_tree: parent.tree.sha, tree } });
      const commit = await this.api('/git/commits', { method: 'POST', body: { message, tree: newTree.sha, parents: [head] } });
      try {
        await this.api(`/git/refs/heads/${encodeURIComponent(this.branch)}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
        return { text, commit: commit.sha };
      } catch (err) {
        if (err.status !== 422) throw err; // 422: someone else saved first, so start again from theirs
      }
    }
    throw new Error('family.yaml kept changing while saving. Try again in a moment.');
  }
}
