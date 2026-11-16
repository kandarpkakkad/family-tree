/*
 * Family tree viewer: draws the family as a tree you can drag, zoom and search.
 *
 * The published site has data.json, which is encrypted (see build/build.mjs). The code
 * after # in the link opens it; links look like  …/#code  or  …/#code/person-id.
 * A local preview (serve.ps1) has no data.json and reads family.yaml directly instead.
 */
(() => {
  'use strict';

  const BUILD = document.documentElement.dataset.build || '';
  const CODE_KEY = 'family-tree:code';
  const CW = 184;     // card width (keep in step with .card in style.css)
  const CH = 72;      // card height
  const LAYOUT_KEY = 'family-tree:layout';
  const MIN_K = 0.04;
  const MAX_K = 2.5;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ICON_UP = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2"/></svg>';
  const ICON_FOLD = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5l4 4 4-4M6 16.5l4-4 4 4"/></svg>';
  const ICON_UNFOLD = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 7.5l4-4 4 4M6 12.5l4 4 4-4"/></svg>';
  const ICON_LINK ='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L10 5M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1"/></svg>';

  const $ = (id) => document.getElementById(id);
  const ui = {
    topbar: $('topbar'), title: $('title'), subtitle: $('subtitle'),
    home: $('home'), search: $('search'), results: $('results'),
    notice: $('notice'), viewport: $('viewport'), world: $('world'), links: $('links'), cards: $('cards'),
    status: $('status'), panel: $('panel'), panelBody: $('panelBody'), panelClose: $('panelClose'),
    zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomFit: $('zoomFit'), layout: $('layout'), foldAll: $('foldAll'),
    editbar: $('editbar'), signOut: $('signOut'), toast: $('toast'),
  };

  const people = new Map();       // id -> person
  const placed = new Map();       // id -> {x, y} of the person's card in the current tree
  const state = { root: null, selected: null, collapsed: new Set(), across: true };
  const view = { x: 0, y: 0, k: 1 };
  const narrow = window.matchMedia('(max-width: 640px)');
  let lines = [];                 // top-of-tree couples: the family, plus any in-laws' families
  let tree = null;
  let bounds = { w: 0, h: 0 };
  let code = '';                  // the access code that opened the tree (kept in links)
  let dataKey = null;             // decrypts photos when the tree came encrypted
  const photos = new Map();       // photo key -> object URL, a pending promise, or null
  let meta = {};                  // the settings at the top of family.yaml
  const TOKEN_KEY = 'family-tree:editor-token';
  const NAME_KEY = 'family-tree:my-name';
  // The editor saves straight into family.yaml (see edit-store.mjs); everyone else sends suggestions.
  const editor = { on: false, repo: null, store: null, yaml: null, text: '' };
  let pendingSuggestion = null;

  /* ---------- Small helpers ---------- */

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const str = (v) => (v == null ? '' : String(v).trim());
  const toList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(str).filter(Boolean);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const person = (id) => people.get(id);
  const firstName = (p) => p.name.split(/\s+/)[0];
  const initials = (p) => p.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0]).join('').toUpperCase();

  function normGender(v) {
    const g = str(v).toLowerCase();
    if (g === 'm' || g === 'male') return 'male';
    if (g === 'f' || g === 'female') return 'female';
    return 'unknown';
  }

  function parseDate(s) {
    s = str(s);
    const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(s);
    if (m) {
      const month = m[2] ? +m[2] : null;
      if (month && (month < 1 || month > 12)) return { y: +m[1], approx: true };
      return { y: +m[1], m: month, d: m[3] ? +m[3] : null };
    }
    const y = /\d{4}/.exec(s);
    return y ? { y: +y[0], approx: true } : null;
  }

  function formatDate(s) {
    const d = parseDate(s);
    if (!d || d.approx) return str(s);
    if (d.m && d.d) return `${d.d} ${MONTHS[d.m - 1]} ${d.y}`;
    if (d.m) return `${MONTHS[d.m - 1]} ${d.y}`;
    return String(d.y);
  }

  const dateKey = (s) => { const d = parseDate(s); return d.y * 10000 + (d.m || 0) * 100 + (d.d || 0); };

  function age(p) {
    const b = parseDate(p.born);
    if (!b) return null;
    let e;
    if (p.died) e = parseDate(p.died);
    else if (p.deceased) return null;
    else { const t = new Date(); e = { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() }; }
    if (!e) return null;
    const exact = Boolean(b.m && b.d && e.m && e.d && !b.approx && !e.approx);
    let a = e.y - b.y;
    if (exact && (e.m < b.m || (e.m === b.m && e.d < b.d))) a--;
    return a < 0 || a > 130 ? null : { a, exact };
  }

  function years(p) {
    const b = parseDate(p.born), d = parseDate(p.died);
    if (b && d) return `${b.y} – ${d.y}`;
    if (b) return p.deceased ? `${b.y} – ?` : `b. ${b.y}`;
    if (d) return `d. ${d.y}`;
    return p.deceased ? 'Late' : '';
  }

  const imageType = (path) => ({ png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' }[path.split('.').pop().toLowerCase()] || 'image/jpeg');

  // Where a photo comes from: the published site's encrypted copy, the private repo (for the
  // editor, who sees family.yaml as it is now), or null for a plain address used as it is.
  function photoSource(p) {
    if (!p.photo) return null;
    if (p.photoType) {
      return {
        key: p.photo,
        type: p.photoType,
        fetch: async () => {
          const res = await fetch(`${p.photo}?v=${encodeURIComponent(BUILD)}`);
          if (!res.ok) throw new Error(res.status);
          return openSealed(dataKey, new Uint8Array(await res.arrayBuffer()));
        },
      };
    }
    if (editor.on && !/^https?:\/\//i.test(p.photo)) {
      return { key: `repo:${p.photo}`, type: imageType(p.photo), fetch: () => editor.repo.readFile(p.photo) };
    }
    return null;
  }

  function avatar(p, size = '') {
    let src = p.photo;
    let wait = '';
    const source = photoSource(p);
    if (source) {                        // show the initials until the photo arrives
      src = photos.get(source.key);
      if (typeof src !== 'string') {
        src = '';
        if (photos.get(source.key) !== null) { wait = ` data-photo="${esc(source.key)}"`; loadPhoto(source); }
      }
    }
    const img = src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : '';
    return `<span class="avatar ${size} g-${p.gender || 'unknown'}${cc(p.id)}"${wait} aria-hidden="true"><span>${esc(initials(p))}</span>${img}</span>`;
  }

  function loadPhoto(source) {
    if (photos.has(source.key)) return;
    photos.set(source.key, (async () => {
      try {
        const url = URL.createObjectURL(new Blob([await source.fetch()], { type: source.type }));
        photos.set(source.key, url);
        document.querySelectorAll(`.avatar[data-photo="${CSS.escape(source.key)}"]`).forEach((el) => {
          el.removeAttribute('data-photo');
          el.insertAdjacentHTML('beforeend', `<img src="${url}" alt="">`);
        });
      } catch {
        photos.set(source.key, null); // keep the initials
      }
    })());
  }

  /* ---------- Loading and unlocking ---------- */

  async function load() {
    let res;
    try {
      res = await fetch(`data.json?v=${encodeURIComponent(BUILD)}`, { cache: 'no-cache' });
    } catch {
      if (location.protocol === 'file:') {
        return fail('Open this page through a web server',
          'Browsers won’t read the family data from a page opened straight from disk. Run <code>serve.ps1</code> (see the README) to preview it.');
      }
      return fail('Could not open the family tree', 'Check the internet connection and try again.');
    }
    if (res.status === 404) return loadPreview();
    if (!res.ok) return fail('Could not open the family tree', `The server answered ${res.status}. Try again in a minute.`);
    let bundle;
    try { bundle = await res.json(); } catch { return fail('Could not open the family tree', 'The data didn’t download properly. Try again.'); }
    unlock(bundle);
  }

  // Local preview (serve.ps1): no encrypted data.json, so read family.yaml from the repo,
  // with the same YAML reader the build uses.
  async function loadPreview() {
    let text, yaml;
    try {
      const res = await fetch('family.yaml', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      text = await res.text();
      yaml = await import('./js-yaml.mjs');
    } catch (err) {
      return fail('Could not load the family data', `Tried <code>family.yaml</code>, but ${esc(err.message)}. Preview with <code>serve.ps1</code>.`);
    }
    let data;
    try {
      data = yaml.load(text.replace(/^﻿/, ''));
    } catch (err) {
      return fail('family.yaml has a mistake in it',
        `<pre class="err">${esc(err.message)}</pre>Usual causes: a tab instead of spaces, an entry indented differently from the ones around it, or a <code>: </code> inside a name (put that name in quotes).`);
    }
    start(data || {});
  }

  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const cleanCode = (s) => str(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const openSealed = (key, bytes) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));

  function remembered() {
    try { return localStorage.getItem(CODE_KEY) || ''; } catch { return ''; }
  }
  function remember(c) {
    try { localStorage.setItem(CODE_KEY, c); } catch { /* private browsing: links still work */ }
  }

  async function unlock(bundle) {
    if (!window.crypto || !crypto.subtle) {
      return fail('This browser can’t open the family tree', 'Please open the link in an up-to-date Chrome, Safari or Edge.');
    }
    const fromLink = cleanCode(readHash().code);
    for (const c of new Set([fromLink, cleanCode(remembered())])) {
      const data = c && (await decrypt(bundle, c));
      if (data) return opened(data, c);
    }
    showLock(bundle, Boolean(fromLink));
  }

  // Same recipe as build/build.mjs: PBKDF2 turns the code into a key plus a lookup name.
  async function decrypt(bundle, c) {
    if (c.length < 10) return null;
    try {
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(c), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(bundle.salt), iterations: bundle.iter }, material, 384);
      const wrapped = bundle.keys[toHex(bits.slice(32))];
      if (!wrapped) return null;
      const kek = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['decrypt']);
      const raw = await openSealed(kek, fromB64(wrapped));
      const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
      const data = JSON.parse(new TextDecoder().decode(await openSealed(key, fromB64(bundle.data))));
      dataKey = key;
      return data;
    } catch {
      return null;
    }
  }

  function opened(data, c) {
    code = c;
    remember(c);
    document.body.classList.remove('locked');
    ui.status.hidden = true;
    start(data);
  }

  function showLock(bundle, wrong) {
    const preview = document.querySelector('meta[property="og:title"]');
    if (preview && preview.content && !preview.content.startsWith('{{')) ui.title.textContent = preview.content;
    document.body.classList.add('locked');
    ui.status.innerHTML = `
      <form class="box lock" id="lock" autocomplete="off">
        <svg class="mark" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="11" class="mark-bg"/><path class="mark-line" d="M20 15v6M11 27v-6h18v6"/><circle class="mark-dot" cx="20" cy="11" r="4"/><circle class="mark-dot" cx="11" cy="29" r="4"/><circle class="mark-dot" cx="29" cy="29" r="4"/></svg>
        <h2>A private family tree</h2>
        <p>Open the link a family member sent you, or type the family code.</p>
        <div class="lock-row">
          <input id="code" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Family code" aria-label="Family code" required>
          <button class="btn primary" type="submit">Open</button>
        </div>
        <p class="lock-error" id="lockError" role="alert"${wrong ? '' : ' hidden'}>That code doesn’t open this tree. Check it and try again.</p>
      </form>`;
    ui.status.hidden = false;
    const form = $('lock'), input = $('code'), error = $('lockError'), button = form.querySelector('button');
    input.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const c = cleanCode(input.value);
      error.hidden = true;
      button.disabled = true;
      button.textContent = 'Opening…';
      const data = await decrypt(bundle, c);
      if (data) return opened(data, c);
      button.disabled = false;
      button.textContent = 'Open';
      error.hidden = false;
      input.select();
    });
  }

  function fail(title, html) {
    ui.status.innerHTML = `<div class="box"><h2>${esc(title)}</h2><div class="msg">${html}</div></div>`;
    ui.status.hidden = false;
  }

  // Reads the family into the index and header. Used on opening and after each save.
  function ingest(data) {
    const list = Array.isArray(data) ? data : data && data.people;
    if (!Array.isArray(list)) { fail('No people list found', '<code>family.yaml</code> needs a <code>people:</code> list.'); return false; }
    meta = Array.isArray(data) ? {} : data;
    const title = str(meta.title) || 'Family Tree';
    ui.title.textContent = title;
    document.title = title;

    people.clear();
    const problems = buildIndex(list);
    if (!people.size) { fail('No one here yet', 'Add people under <code>people:</code> in <code>family.yaml</code>.'); return false; }

    ui.subtitle.textContent = [str(meta.subtitle), `${people.size} ${people.size === 1 ? 'person' : 'people'}`, plural(generations(), 'generation')]
      .filter(Boolean).join(' · ');
    lines = findLines();
    showProblems(problems);
    return true;
  }

  function defaultRoot() {
    const preferred = str(meta.root);
    return canonical(people.has(preferred) ? preferred : lines.length ? lines[0].id : people.keys().next().value);
  }

  function start(data) {
    if (!ingest(data)) return;
    ui.status.hidden = true;
    state.root = defaultRoot();
    let saved = '';
    try { saved = localStorage.getItem(LAYOUT_KEY) || ''; } catch { /* fine */ }
    setLayout((saved || str(meta.layout).toLowerCase() || 'across') === 'across');
    render();
    fit(false, true);
    document.body.classList.add('ready');
    pendingSuggestion = readSuggestion();
    const wanted = hashId();
    if (wanted) focusPerson(wanted, false);
    else setHash('');
    afterStart();
  }

  // After a save (or when the editor's live copy arrives): same view, fresh family.
  function reload(data, focusId) {
    const keepRoot = state.root;
    if (!ingest(data)) return;
    state.root = people.has(keepRoot) ? canonical(keepRoot) : defaultRoot();
    render();
    if (focusId && people.has(focusId)) focusPerson(focusId);
    else if (state.selected && people.has(state.selected)) select(state.selected);
    else closePanel();
  }

  /* ---------- Building the family index ---------- */

  function buildIndex(list) {
    const problems = [];
    list.forEach((raw, i) => {
      const entry = `Entry ${i + 1}`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`${entry} is not a person.`); return; }
      const id = str(raw.id);
      const label = str(raw.name) ? `${entry} (${str(raw.name)})` : entry;
      if (!id) { problems.push(`${label} has no "id".`); return; }
      if (people.has(id)) { problems.push(`The id "${id}" is used twice, so ${label} was left out.`); return; }
      if (!str(raw.name)) problems.push(`"${id}" has no "name".`);
      people.set(id, {
        id,
        name: str(raw.name) || id,
        nickname: str(raw.nickname),
        gender: normGender(raw.gender),
        born: str(raw.born),
        died: str(raw.died),
        deceased: Boolean(str(raw.died)) || raw.deceased === true || /^(yes|y|true)$/i.test(str(raw.deceased)),
        place: str(raw.place),
        photo: str(raw.photo),
        photoType: str(raw.photoType),
        bio: str(raw.bio),
        rawParents: toList(raw.parents),
        rawSpouses: toList(raw.spouses).concat(toList(raw.spouse)),
        parents: [], spouses: [], children: [],
        raw,                             // as written, for the edit forms
      });
    });

    for (const p of people.values()) {
      for (const id of p.rawParents) {
        if (id === p.id) problems.push(`${p.name} is listed as their own parent.`);
        else if (!people.has(id)) problems.push(`${p.name}: parent "${id}" is not in the list.`);
        else if (!p.parents.includes(id)) p.parents.push(id);
      }
      if (p.parents.length > 2) {
        problems.push(`${p.name} has more than two parents; only the first two are used.`);
        p.parents.length = 2;
      }
      for (const id of p.rawSpouses) {
        if (id === p.id) continue;
        if (!people.has(id)) problems.push(`${p.name}: spouse "${id}" is not in the list.`);
        else pair(p.id, id);
      }
    }
    breakCycles(problems);
    for (const p of people.values()) {
      for (const id of p.parents) person(id).children.push(p.id);
      if (p.parents.length === 2) pair(p.parents[0], p.parents[1]); // a child's two parents are a couple
    }
    return problems;
  }

  function pair(a, b) {
    if (a === b) return;
    const A = person(a), B = person(b);
    if (!A.spouses.includes(b)) A.spouses.push(b);
    if (!B.spouses.includes(a)) B.spouses.push(a);
  }

  // A person can't be their own ancestor; drop the parent link that closes such a loop.
  function breakCycles(problems) {
    const mark = new Map();
    const visit = (id) => {
      mark.set(id, 1);
      const p = person(id);
      for (const pid of p.parents.slice()) {
        const m = mark.get(pid);
        if (m === 1) {
          p.parents = p.parents.filter((x) => x !== pid);
          problems.push(`${p.name} and ${person(pid).name} are listed as each other's ancestors; that parent link was ignored.`);
        } else if (!m) visit(pid);
      }
      mark.set(id, 2);
    };
    for (const id of people.keys()) if (!mark.has(id)) visit(id);
  }

  function generations() {
    const memo = new Map();
    const depth = (id) => {
      if (memo.has(id)) return memo.get(id);
      memo.set(id, 1);
      const d = 1 + Math.max(0, ...person(id).parents.map(depth));
      memo.set(id, d);
      return d;
    };
    let max = 0;
    for (const id of people.keys()) max = Math.max(max, depth(id));
    return max;
  }

  function descendants(...ids) {
    const seen = new Set();
    const stack = ids.slice();
    while (stack.length) {
      for (const c of person(stack.pop()).children) if (!seen.has(c)) { seen.add(c); stack.push(c); }
    }
    return seen.size;
  }

  // Top-of-tree couples: no parents of their own, and not married into a family that is already listed.
  function findLines() {
    const hasParents = (id) => person(id).parents.length > 0;
    const taken = new Set();
    const found = [];
    for (const p of people.values()) {
      if (p.parents.length || taken.has(p.id) || p.spouses.some(hasParents)) continue;
      taken.add(p.id);
      p.spouses.forEach((s) => taken.add(s));
      found.push({ id: p.id, label: lineLabel(p), size: descendants(p.id, ...p.spouses) });
    }
    const withKids = found.filter((l) => l.size > 0);
    return (withKids.length ? withKids : found).sort((a, b) => b.size - a.size);
  }

  function lineLabel(p) {
    const members = [p, ...p.spouses.map(person).filter((s) => !s.parents.length)];
    const lead = members.find((m) => m.gender === 'male') || p;
    const words = lead.name.split(/\s+/);
    const firsts = members.map(firstName).join(' & ');
    return words.length > 1 ? `${words[words.length - 1]} family · ${firsts}` : firsts;
  }

  // Which line a person belongs to: follow the first-listed parent upwards. Someone with no
  // parents of their own who married into the family follows their spouse instead.
  function topAncestor(id) {
    const seen = new Set();
    let cur = id;
    while (!seen.has(cur)) {
      seen.add(cur);
      const p = person(cur);
      if (p.parents.length) { cur = p.parents[0]; continue; }
      const via = p.spouses.find((s) => person(s).parents.length && !seen.has(s));
      if (via) { cur = via; continue; }
      break;
    }
    return cur;
  }

  function canonical(id) {
    const line = lines.find((l) => l.id === id || person(l.id).spouses.includes(id));
    return line ? line.id : id;
  }

  /* ---------- Turning people into a tree ---------- */

  // A unit is one person from the bloodline plus their spouse(s), with children grouped by
  // which spouse they belong to. Anyone already drawn shows up again as a dashed "ghost".
  function buildTree(rootId) {
    const seen = new Set();
    const make = (id) => {
      const p = person(id);
      if (seen.has(id)) return { id, members: [{ id, ghost: true }], groups: [], total: 0, ghost: true };
      seen.add(id);
      const fresh = p.spouses.filter((s) => !seen.has(s));
      p.spouses.forEach((s) => seen.add(s));
      const unit = {
        id,
        members: arrange(p).map((m) => ({ id: m, ghost: m !== id && !fresh.includes(m) })),
        groups: [],
        total: p.children.length,
        collapsed: p.children.length > 0 && state.collapsed.has(id),
      };
      if (unit.collapsed) return unit;
      const used = new Set();
      const groups = p.spouses.map((s) => ({ spouse: s, kids: p.children.filter((c) => person(c).parents.includes(s)) }));
      groups.forEach((g) => g.kids.forEach((c) => used.add(c)));
      const rest = p.children.filter((c) => !used.has(c));
      if (rest.length) groups.push({ spouse: null, kids: rest });
      for (const g of groups) {
        const repeat = g.spouse && !fresh.includes(g.spouse);
        const kids = sortKids(g.kids).filter((c) => !(repeat && seen.has(c)));
        if (kids.length) unit.groups.push({ spouse: g.spouse, kids: kids.map(make) });
      }
      return unit;
    };
    return make(rootId);
  }

  function arrange(p) {
    const s = p.spouses;
    if (!s.length) return [p.id];
    if (s.length === 1) return p.gender === 'female' && person(s[0]).gender === 'male' ? [s[0], p.id] : [p.id, s[0]];
    if (s.length === 2) return [s[0], p.id, s[1]];
    return [p.id, ...s];
  }

  // Oldest first when every child has a birth date; otherwise keep the order in the JSON.
  function sortKids(ids) {
    if (!ids.every((id) => parseDate(person(id).born))) return ids.slice();
    return ids.slice().sort((a, b) => dateKey(person(a).born) - dateKey(person(b).born));
  }

  /* ---------- Layout ---------- */

  // Positions are worked out along two axes: "breadth" runs across one generation and
  // "depth" goes from one generation to the next. Top-down, breadth is x; sideways it is y.
  const geo = {};
  function setGeometry() {
    const across = state.across;
    geo.across = across;
    geo.cb = across ? CH : CW;            // card size along breadth
    geo.cd = across ? CW : CH;            // card size along depth
    geo.cgap = across ? 16 : 34;          // between a person and their spouse
    geo.sgap = across ? 22 : 28;          // between branches
    geo.level = across ? CW + 84 : 156;   // from one generation to the next
  }
  const pt = (b, d) => (geo.across ? `${d},${b}` : `${b},${d}`);
  const xy = (b, d) => (geo.across ? { x: d, y: b } : { x: b, y: d });

  const slot = (u, i) => u.b + i * (geo.cb + geo.cgap);
  const indexOf = (u, id) => u.members.findIndex((m) => m.id === id);
  const anchorOffset = (u) => indexOf(u, u.id) * (geo.cb + geo.cgap) + geo.cb / 2;
  const anchor = (u) => u.b + anchorOffset(u);
  const kidsOf = (u) => u.groups.flatMap((g) => g.kids);
  const dropOffset = (u) => (u.members.length === 2 ? u.w / 2 : anchorOffset(u));

  // Tidy layout: every branch keeps an outline (how far it reaches at each generation below),
  // and the next brother's or sister's branch slides in as close as the two outlines allow.
  // Small branches tuck in beside big ones instead of each taking a full-width column.
  function shape(u) {
    const n = u.members.length;
    u.w = n * geo.cb + (n - 1) * geo.cgap;
    const kids = kidsOf(u);
    let outline = [];
    for (const k of kids) {
      shape(k);
      let off = 0;
      if (outline.length) {
        off = -Infinity;
        const common = Math.min(outline.length, k.outline.length);
        for (let i = 0; i < common; i++) off = Math.max(off, outline[i][1] + geo.sgap - k.outline[i][0]);
      }
      k.rel = off;
      k.outline.forEach(([lo, hi], i) => {
        if (i < outline.length) outline[i] = [Math.min(outline[i][0], lo + off), Math.max(outline[i][1], hi + off)];
        else outline.push([lo + off, hi + off]);
      });
    }
    // Centre the couple over their children, then measure the children from the couple.
    let start = 0;
    if (kids.length) {
      const first = kids[0], last = kids[kids.length - 1];
      start = (first.rel + anchorOffset(first) + last.rel + anchorOffset(last)) / 2 - dropOffset(u);
      kids.forEach((k) => { k.rel -= start; });
    }
    u.outline = [[0, u.w], ...outline.map(([lo, hi]) => [lo - start, hi - start])];
  }

  function place(u, b, depth) {
    u.b = b;
    u.d = depth * geo.level;
    kidsOf(u).forEach((k) => place(k, b + k.rel, depth + 1));
  }

  // Line from a parent (or a couple's ring) to a child, with rounded corners.
  function elbow(ob, od, kb, kd, bar) {
    if (Math.abs(kb - ob) < 1) return `M${pt(ob, od)}L${pt(kb, kd)}`;
    const r = Math.min(10, Math.abs(kb - ob) / 2);
    const s = kb > ob ? 1 : -1;
    return `M${pt(ob, od)}L${pt(ob, bar - r)}Q${pt(ob, bar)} ${pt(ob + s * r, bar)}`
      + `L${pt(kb - s * r, bar)}Q${pt(kb, bar)} ${pt(kb, bar + r)}L${pt(kb, kd)}`;
  }

  /* ---------- Drawing ---------- */

  // Each couple gets its own colour, shared by both cards, their ring and the lines to their
  // children. The colour comes from the couple's ids, so it stays put when others are added;
  // it only shifts if it would match the couple beside them or their parents.
  const PALETTE = 10;
  const coupleOf = new Map();       // person id -> palette slot of their couple
  const unitOf = new Map();         // person id -> the id their branch folds under
  const hashStr = (s) => { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const cc = (id) => (coupleOf.has(id) ? ` cc-${coupleOf.get(id)}` : '');
  let foldedNow = 0;

  function render() {
    setGeometry();
    tree = buildTree(state.root);
    shape(tree);
    place(tree, -Math.min(...tree.outline.map(([lo]) => lo)), 0);
    placed.clear();
    coupleOf.clear();
    unitOf.clear();
    foldedNow = 0;
    const lastColour = new Map();   // generation -> colour of the last couple drawn there
    const cards = [], extras = [], paths = [], rings = [];
    const { cb, cd, level } = geo;
    let w = 0, h = 0;

    const draw = (u, isRoot, parentColour) => {
      let colour = null;
      if (u.members.length > 1) {
        const gen = Math.round(u.d / level);
        colour = hashStr(u.members.map((m) => m.id).sort().join('|')) % PALETTE;
        for (let t = 0; t < PALETTE && (colour === lastColour.get(gen) || colour === parentColour); t++) colour = (colour + 1) % PALETTE;
        lastColour.set(gen, colour);
        u.members.forEach((m) => { if (!coupleOf.has(m.id)) coupleOf.set(m.id, colour); });
      }
      u.members.forEach((m) => { if (!m.ghost && !unitOf.has(m.id)) unitOf.set(m.id, u.id); });
      if (u.collapsed) foldedNow++;
      const tint = colour === null ? '' : ` cc-${colour}`;
      const pi = indexOf(u, u.id);
      const mid = u.d + cd / 2;                     // halfway through the cards, along depth
      const centre = (i) => slot(u, i) + cb / 2;
      u.members.forEach((m, i) => {
        const p = person(m.id);
        const { x, y } = xy(slot(u, i), u.d);
        cards.push(cardHTML(p, x, y, m.ghost));
        if (!m.ghost && !placed.has(p.id)) placed.set(p.id, { x, y });
        w = Math.max(w, x + CW);
        h = Math.max(h, y + CH);
        // Married-in spouses (and the person at the very top) get a button to climb to their own parents.
        if (!m.ghost && p.parents.length && (i !== pi || isRoot)) {
          const at = xy(centre(i), u.d);
          extras.push(`<button class="up" type="button" data-up="${esc(p.id)}" style="left:${at.x}px;top:${at.y}px" title="Show ${esc(firstName(p))}’s parents" aria-label="Show ${esc(p.name)}’s parents">${ICON_UP}</button>`);
        }
        if (i === pi) return;
        const a = Math.min(i, pi), b = Math.max(i, pi);
        if (b - a === 1) {
          const b1 = slot(u, a) + cb, b2 = slot(u, b);
          const ring = xy((b1 + b2) / 2, mid);
          paths.push(`<path class="marriage${tint}" d="M${pt(b1, mid)}L${pt(b2, mid)}"/>`);
          rings.push(`<circle class="ring${tint}" cx="${ring.x}" cy="${ring.y}" r="4.5"/>`);
        } else {
          paths.push(`<path class="marriage${tint}" d="M${pt(centre(a), u.d)}L${pt(centre(a), u.d - 18)}L${pt(centre(b), u.d - 18)}L${pt(centre(b), u.d)}"/>`);
        }
      });

      // Where the line to a couple's children starts: their ring, or the parent's card edge.
      const origin = (spouse) => {
        if (spouse) {
          const si = indexOf(u, spouse);
          if (Math.abs(si - pi) === 1) return [(centre(pi) + centre(si)) / 2, mid];
        }
        return [centre(pi), u.d + cd];
      };
      const n = u.groups.length;
      u.groups.forEach((g, gi) => {
        const [ob, od] = origin(g.spouse);
        const bar = u.d + cd + (level - cd) / 2 + (gi - (n - 1) / 2) * 10;
        g.kids.forEach((k) => paths.push(`<path class="kid${tint}" d="${elbow(ob, od, anchor(k), k.d, bar)}"/>`));
      });

      if (u.total && !u.ghost) {
        const [tb, td] = origin(u.members.length === 2 ? u.members[1 - pi].id : null);
        const tAt = u.d + cd + 17;
        const hidden = u.collapsed ? descendants(u.id) : 0;
        if (u.collapsed) paths.push(`<path class="kid${tint}" d="M${pt(tb, td)}L${pt(tb, tAt)}"/>`);
        const at = xy(tb, tAt);
        const title = u.collapsed ? `Show ${plural(hidden, 'descendant')}` : `Hide ${firstName(person(u.id))}’s descendants`;
        extras.push(`<button class="toggle${u.collapsed ? ' collapsed' : ''}" type="button" data-toggle="${esc(u.id)}" style="left:${at.x}px;top:${at.y}px" aria-expanded="${!u.collapsed}" title="${esc(title)}" aria-label="${esc(title)}">${u.collapsed ? `+${hidden}` : '−'}</button>`);
      }
      kidsOf(u).forEach((k) => draw(k, false, colour));
    };
    draw(tree, true, null);
    ui.world.classList.toggle('across', geo.across);
    ui.foldAll.classList.toggle('folded', foldedNow > 0);
    ui.foldAll.title = foldedNow ? 'Open every branch' : 'Fold every branch';
    ui.foldAll.setAttribute('aria-label', ui.foldAll.title);

    ui.links.setAttribute('width', w);
    ui.links.setAttribute('height', h);
    ui.links.innerHTML = paths.join('') + rings.join('');
    ui.cards.innerHTML = cards.join('') + extras.join('');
    bounds = { w, h };
    syncHome();
  }

  function cardHTML(p, x, y, ghost) {
    const yrs = ghost ? 'Also shown elsewhere' : years(p);
    const cls = ['card', `g-${p.gender}`];
    if (coupleOf.has(p.id)) cls.push(`cc-${coupleOf.get(p.id)}`);
    if (p.deceased) cls.push('deceased');
    if (ghost) cls.push('ghost');
    else if (p.id === state.selected) cls.push('selected');
    const label = p.name + (yrs ? `, ${yrs}` : '');
    return `<div class="${cls.join(' ')}" data-id="${esc(p.id)}"${ghost ? ' data-ghost' : ''} role="button" tabindex="0" style="left:${x}px;top:${y}px" aria-label="${esc(label)}">`
      + `${avatar(p)}<span class="meta"><span class="name">${esc(p.name)}</span>${yrs ? `<span class="years">${esc(yrs)}</span>` : ''}</span></div>`;
  }

  // The tree is one family. Following a married-in person's arrow shows their parents' side;
  // this button (named after the family) brings you back.
  function syncHome() {
    ui.home.hidden = state.root === defaultRoot();
    ui.home.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg><span>${esc(str(meta.title) || 'Family Tree')}</span>`;
  }

  function showProblems(list) {
    ui.notice.hidden = true;
    if (!list.length) return;
    console.warn(`family.yaml problems:\n- ${list.join('\n- ')}`);
    ui.notice.innerHTML = `<details><summary>${plural(list.length, 'problem')} found in family.yaml</summary><ul>${list.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>`
      + '<button type="button" class="notice-close" aria-label="Dismiss">×</button>';
    ui.notice.hidden = false;
    ui.notice.querySelector('.notice-close').addEventListener('click', () => { ui.notice.hidden = true; });
  }

  /* ---------- The details panel ---------- */

  function siblings(p) {
    const out = [];
    const seen = new Set([p.id]);
    for (const par of p.parents) {
      for (const c of person(par).children) {
        if (seen.has(c)) continue;
        seen.add(c);
        const q = person(c);
        const half = p.parents.length === 2 && !p.parents.every((x) => q.parents.includes(x));
        out.push({ id: c, half });
      }
    }
    return out;
  }

  function chip(id, note = '') {
    const q = person(id);
    return `<button class="chip" type="button" data-go="${esc(q.id)}">${avatar(q, 'xs')}<span>${esc(q.name)}${note ? ` <small>${esc(note)}</small>` : ''}</span></button>`;
  }

  function panelHTML(p) {
    const facts = [];
    const ag = age(p);
    const born = [p.born && formatDate(p.born), p.place].filter(Boolean).join(' · ');
    if (born) facts.push(['Born', born]);
    if (p.died) facts.push(['Died', formatDate(p.died) + (ag ? `, aged ${ag.exact ? '' : 'about '}${ag.a}` : '')]);
    else if (ag && !p.deceased) facts.push(['Age', `${ag.exact ? '' : 'About '}${ag.a}`]);

    const sibs = siblings(p);
    const rel = [
      ['Parents', p.parents.map((id) => chip(id))],
      [p.spouses.length > 1 ? 'Spouses' : 'Spouse', p.spouses.map((id) => chip(id))],
      [sibs.length === 1 ? 'Sibling' : 'Siblings', sibs.map((s) => chip(s.id, s.half ? 'half' : ''))],
      [p.children.length === 1 ? 'Child' : 'Children', sortKids(p.children).map((id) => chip(id))],
    ].filter(([, chips]) => chips.length);

    const actions = [];
    if (canonical(topAncestor(p.id)) !== state.root) {
      actions.push(`<button class="btn primary" type="button" data-act="line">Show ${esc(firstName(p))}’s family line</button>`);
    }
    // Fold or open this person's branch (for someone who married in, it's their couple's branch).
    const branch = unitOf.get(p.id);
    if (branch && person(branch).children.length) {
      const n = descendants(branch);
      const folded = state.collapsed.has(branch);
      actions.push(`<button class="btn" type="button" data-act="fold">${folded ? ICON_UNFOLD : ICON_FOLD}<span>${folded ? 'Show' : 'Hide'} ${plural(n, 'descendant')}</span></button>`);
    }
    actions.push(`<button class="btn" type="button" data-act="copy">${ICON_LINK}<span>Copy link</span></button>`);

    const life = years(p);
    return `<div class="p-head">${avatar(p, 'xl')}<h2 id="panelTitle">${esc(p.name)}</h2>`
      + (p.nickname ? `<p class="aka">“${esc(p.nickname)}”</p>` : '')
      + (life ? `<p class="life">${esc(life)}</p>` : '') + '</div>'
      + (facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '')
      + (p.bio ? `<div class="bio">${p.bio.split(/\n\s*\n/).map((t) => `<p>${esc(t)}</p>`).join('')}</div>` : '')
      + rel.map(([label, chips]) => `<section class="rel"><h3>${label}</h3><div class="chips">${chips.join('')}</div></section>`).join('')
      + editActionsHTML(p)
      + `<div class="actions">${actions.join('')}</div>`;
  }

  function select(id, { center = false, animate = true } = {}) {
    const p = person(id);
    if (!p) return;
    state.selected = id;
    ui.cards.querySelectorAll('.card.selected').forEach((el) => el.classList.remove('selected'));
    const el = ui.cards.querySelector(`.card[data-id="${CSS.escape(id)}"]:not([data-ghost])`);
    if (el) el.classList.add('selected');
    ui.panelBody.innerHTML = panelHTML(p);
    ui.panel.scrollTop = 0;
    ui.panel.classList.add('open');
    ui.panel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('panel-open');
    setHash(id);
    if (center) centerOn(id, animate);
    else reveal(id);
  }

  function closePanel() {
    if (!ui.panel.classList.contains('open')) return;
    state.selected = null;
    ui.panel.classList.remove('open');
    ui.panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('panel-open');
    ui.cards.querySelectorAll('.card.selected').forEach((el) => el.classList.remove('selected'));
    setHash('');
  }

  // Links are #code or #code/person-id, so a copied link opens for whoever gets it.
  // The local preview has no code, so there it's just #person-id.
  function readHash() {
    let raw = location.hash.slice(1);
    try { raw = decodeURIComponent(raw); } catch { /* keep it as it is */ }
    const slash = raw.indexOf('/');
    return slash === -1 ? { code: raw, person: '' } : { code: raw.slice(0, slash), person: raw.slice(slash + 1) };
  }

  function hashId() {
    const h = readHash();
    const id = h.person || (code ? '' : h.code);
    return people.has(id) ? id : '';
  }

  function setHash(id) {
    const person = id ? encodeURIComponent(id) : '';
    const hash = code ? `${code}${person ? `/${person}` : ''}` : person;
    history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
  }

  async function copyLink(btn) {
    const label = btn.querySelector('span');
    try {
      await navigator.clipboard.writeText(location.href);
      label.textContent = 'Link copied';
      setTimeout(() => { label.textContent = 'Copy link'; }, 1800);
    } catch {
      window.prompt('Copy this link:', location.href);
    }
  }

  /* ---------- Moving around the tree ---------- */

  // Ancestors of a person (and of their spouses), used to open any folded branch hiding them.
  function lineage(id) {
    const out = new Set();
    const stack = [id, ...person(id).spouses];
    while (stack.length) {
      for (const par of person(stack.pop()).parents) if (!out.has(par)) { out.add(par); stack.push(par); }
    }
    return out;
  }

  function focusPerson(id, animate = true) {
    if (!people.has(id)) return;
    if (!placed.has(id)) {
      let opened = false;
      for (const a of lineage(id)) if (state.collapsed.delete(a)) opened = true;
      if (opened) render();
    }
    if (!placed.has(id)) {
      state.root = canonical(topAncestor(id));
      render();
    }
    select(id, { center: true, animate });
  }

  function showLine(id) {
    state.root = canonical(topAncestor(id));
    render();
    select(id, { center: true });
  }

  function goUp(id) {
    const shown = person(id).parents.find((x) => placed.has(x));
    if (shown) return focusPerson(shown);
    showLine(id);
  }

  function toggleBranch(id) {
    const before = placed.get(id);
    if (!state.collapsed.delete(id)) state.collapsed.add(id);
    render();
    const after = placed.get(id);
    if (before && after) {
      view.x += (before.x - after.x) * view.k;
      view.y += (before.y - after.y) * view.k;
      apply();
    }
    if (state.selected && !placed.has(state.selected)) closePanel();
  }

  function visibleRect() {
    const vw = ui.viewport.clientWidth, vh = ui.viewport.clientHeight;
    let right = vw, bottom = vh;
    if (ui.panel.classList.contains('open')) {
      if (narrow.matches) bottom -= ui.panel.offsetHeight;
      else right -= ui.panel.offsetWidth + 24;
    }
    const top = ui.topbar.offsetHeight;
    return { left: 0, top, right, bottom, w: right, h: bottom - top, cx: right / 2, cy: (top + bottom) / 2 };
  }

  function apply() {
    ui.world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    const s = 24 * view.k;
    ui.viewport.style.backgroundSize = `${s}px ${s}px`;
    ui.viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  }

  let animTimer = 0;
  function setView(x, y, k, animate) {
    clearTimeout(animTimer);
    ui.world.classList.toggle('animate', animate);
    ui.viewport.classList.toggle('animate', animate);
    if (animate) {
      animTimer = setTimeout(() => {
        ui.world.classList.remove('animate');
        ui.viewport.classList.remove('animate');
      }, 520);
    }
    Object.assign(view, { x, y, k });
    apply();
  }

  function stopAnimation() {
    clearTimeout(animTimer);
    ui.world.classList.remove('animate');
    ui.viewport.classList.remove('animate');
  }

  // The Fit button shows the whole tree however small. The opening view (start = true) keeps
  // cards readable instead: if the whole family doesn't fit, it shows every generation and
  // starts at the top of the family, with the rest a scroll away.
  function fit(animate = true, start = false) {
    const r = visibleRect(), pad = 44;
    const fitW = (r.w - pad * 2) / bounds.w, fitH = (r.h - pad * 2) / bounds.h;
    let k = Math.min(fitW, fitH, 1);
    if (start && k < 0.45) k = clamp(Math.min(geo.across ? fitW : fitH, 1), 0.45, 1);
    k = clamp(k, MIN_K, MAX_K);
    const root = placed.get(tree.id) || { x: 0, y: 0 };
    const x = bounds.w * k <= r.w - pad * 2 ? r.cx - (bounds.w * k) / 2
      : geo.across ? r.left + pad : r.cx - (root.x + CW / 2) * k;
    const y = bounds.h * k <= r.h - pad * 2 ? r.cy - (bounds.h * k) / 2
      : geo.across ? r.cy - (root.y + CH / 2) * k : r.top + pad;
    setView(x, y, k, animate);
  }

  function setLayout(across) {
    state.across = across;
    try { localStorage.setItem(LAYOUT_KEY, across ? 'across' : 'down'); } catch { /* fine */ }
    ui.layout.title = across ? 'Show top-down' : 'Show sideways';
    ui.layout.setAttribute('aria-label', ui.layout.title);
    ui.layout.classList.toggle('across', across);
  }

  function centerOn(id, animate = true, keepZoom = false) {
    const pos = placed.get(id);
    if (!pos) return;
    const r = visibleRect();
    const k = keepZoom || view.k >= 0.7 ? view.k : 0.9;
    setView(r.cx - (pos.x + CW / 2) * k, r.cy - (pos.y + CH / 2) * k, k, animate);
  }

  // Scroll a card into view only if it is hidden behind the panel or off screen.
  function reveal(id) {
    const pos = placed.get(id);
    if (!pos) return;
    const r = visibleRect(), m = 20;
    const sx = view.x + pos.x * view.k, sy = view.y + pos.y * view.k;
    if (sx < r.left + m || sy < r.top + m || sx + CW * view.k > r.right - m || sy + CH * view.k > r.bottom - m) {
      centerOn(id, true, true);
    }
  }

  function zoomAt(cx, cy, k, animate = false) {
    k = clamp(k, MIN_K, MAX_K);
    setView(cx - ((cx - view.x) * k) / view.k, cy - ((cy - view.y) * k) / view.k, k, animate);
  }

  function zoomBy(factor) {
    const r = visibleRect();
    zoomAt(r.cx, r.cy, view.k * factor, true);
  }

  /* ---------- Dragging, pinching and wheel zoom ---------- */

  const pointers = new Map();
  let drag = null;
  let pinch = null;
  let suppressClick = false;

  ui.viewport.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, k: view.k, x: view.x, y: view.y };
      if (drag) drag.moved = true;
      stopAnimation();
    }
  });

  ui.viewport.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const k = clamp(pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), MIN_K, MAX_K);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      view.k = k;
      view.x = mx - ((pinch.mx - pinch.x) * k) / pinch.k;
      view.y = my - ((pinch.my - pinch.y) * k) / pinch.k;
      apply();
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 5) {
      drag.moved = true;
      stopAnimation();
      ui.viewport.setPointerCapture(e.pointerId);
      ui.viewport.classList.add('grabbing');
    }
    if (drag.moved) {
      view.x = drag.vx + dx;
      view.y = drag.vy + dy;
      apply();
    }
  });

  const endPointer = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) {
      // One finger lifted from a pinch: carry on dragging with the other one.
      const [[id, p]] = [...pointers.entries()];
      drag = { id, sx: p.x, sy: p.y, vx: view.x, vy: view.y, moved: true };
    } else if (pointers.size === 0) {
      if (drag && drag.moved) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
      }
      drag = null;
      ui.viewport.classList.remove('grabbing');
    }
  };
  ui.viewport.addEventListener('pointerup', endPointer);
  ui.viewport.addEventListener('pointercancel', endPointer);

  // The wheel scrolls, like a page; Ctrl+wheel (and a trackpad pinch, which arrives as one) zooms.
  ui.viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    stopAnimation();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, view.k * Math.exp(-e.deltaY * scale * 0.01));
      return;
    }
    let dx = e.deltaX * scale, dy = e.deltaY * scale;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    view.x -= dx;
    view.y -= dy;
    apply();
  }, { passive: false });

  // Safari trackpad pinch (touch pinches are handled by the pointer code above).
  let gestureK = 1;
  ui.viewport.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureK = view.k; });
  ui.viewport.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (!pointers.size) zoomAt(e.clientX, e.clientY, gestureK * e.scale);
  });

  /* ---------- Clicks and keys ---------- */

  function activate(target) {
    const up = target.closest('[data-up]');
    if (up) return goUp(up.dataset.up);
    const toggle = target.closest('[data-toggle]');
    if (toggle) return toggleBranch(toggle.dataset.toggle);
    const card = target.closest('.card');
    if (!card) return closePanel();
    if (card.hasAttribute('data-ghost')) return focusPerson(card.dataset.id);
    return select(card.dataset.id);
  }

  ui.viewport.addEventListener('click', (e) => {
    if (suppressClick) return;
    activate(e.target);
  });

  ui.cards.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('card')) {
      e.preventDefault();
      activate(e.target);
    }
  });

  ui.panel.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) return focusPerson(go.dataset.go);
    const edit = e.target.closest('[data-edit]');
    if (edit && state.selected) return openForm(edit.dataset.edit, state.selected);
    const back = e.target.closest('[data-back]');
    if (back) return people.has(back.dataset.back) ? select(back.dataset.back) : closePanel();
    const act = e.target.closest('[data-act]');
    if (!act || !state.selected) return;
    if (act.dataset.act === 'line') showLine(state.selected);
    if (act.dataset.act === 'copy') copyLink(act);
    if (act.dataset.act === 'fold' && unitOf.has(state.selected)) {
      toggleBranch(unitOf.get(state.selected));
      select(state.selected);
    }
  });

  ui.panelClose.addEventListener('click', closePanel);
  ui.zoomIn.addEventListener('click', () => zoomBy(1.3));
  ui.zoomOut.addEventListener('click', () => zoomBy(1 / 1.3));
  ui.zoomFit.addEventListener('click', () => fit(true));

  // Fold every branch down to the first generation (each with its "+N"), or open them all again.
  ui.foldAll.addEventListener('click', () => {
    if (foldedNow) {
      state.collapsed.clear();
    } else {
      const top = new Set([state.root, ...person(state.root).spouses]);
      for (const p of people.values()) if (p.children.length && !top.has(p.id)) state.collapsed.add(p.id);
    }
    render();
    if (state.selected && placed.has(state.selected)) select(state.selected);
    else closePanel();
    fit(true, true);
  });
  ui.layout.addEventListener('click', () => {
    setLayout(!state.across);
    render();
    if (state.selected && placed.has(state.selected)) centerOn(state.selected, false);
    else fit(false, true);
  });

  ui.home.addEventListener('click', () => {
    state.root = defaultRoot();
    render();
    if (state.selected && placed.has(state.selected)) centerOn(state.selected);
    else { closePanel(); fit(true, true); }
  });

  document.addEventListener('keydown', (e) => {
    const typing = e.target instanceof Element && e.target.closest('input, select, textarea');
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); ui.search.focus(); }
    else if (e.key === 'Escape') closePanel();
    else if (e.key === '+' || e.key === '=') zoomBy(1.3);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.3);
    else if (e.key === '0') fit(true);
  });

  window.addEventListener('hashchange', () => {
    const id = hashId();
    if (id && id !== state.selected) focusPerson(id);
  });

  // Missing photo: drop the <img> so the initials underneath show.
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t instanceof HTMLImageElement && t.parentElement && t.parentElement.classList.contains('avatar')) t.remove();
  }, true);

  const setHeaderHeight = () => document.documentElement.style.setProperty('--header-h', `${ui.topbar.offsetHeight}px`);
  new ResizeObserver(setHeaderHeight).observe(ui.topbar);
  setHeaderHeight();

  /* ---------- Changing the tree from the website ---------- */

  // Relatives fill in a form and send it to the tree's editor on WhatsApp. The editor, signed in
  // with a GitHub token on their own devices, uses the same forms to save into family.yaml.
  const FIELD_LABELS = { name: 'Name', nickname: 'Nickname', gender: 'Gender', born: 'Born', died: 'Died', deceased: 'Passed away', place: 'Place', bio: 'About' };
  const EDITABLE = Object.keys(FIELD_LABELS);
  const RELATION = { child: 'child', spouse: 'husband or wife', parent: 'parent' };
  const ICON_PEN = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.6 3.6l2.8 2.8L7 15.8 3.5 16.5l.7-3.5z"/></svg>';
  const ICON_CAMERA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  const keeperName = () => str(meta.keeper_name) || 'the tree’s editor';
  const siteBase = () => str(meta.site_url) || location.origin + location.pathname;
  const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function rememberedName() {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
  }

  function toast(message, ms = 6000) {
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { ui.toast.hidden = true; }, ms);
  }

  function editActionsHTML(p) {
    if (!code && !editor.on) return ''; // the local preview has nobody to send to
    const parent = p.parents.length < 2 ? '<button class="btn" type="button" data-edit="parent">+ Parent</button>' : '';
    return `<section class="edit-box"><h3>${editor.on ? 'Edit' : 'Something to add or correct?'}</h3><div class="edit-actions">`
      + `<button class="btn" type="button" data-edit="details">${ICON_PEN}<span>${editor.on ? 'Edit details' : 'Correct details'}</span></button>`
      + `<button class="btn" type="button" data-edit="child">+ Child</button><button class="btn" type="button" data-edit="spouse">+ Spouse</button>${parent}`
      + '</div></section>';
  }

  // A person's editable details as they are now.
  function currentFields(p) {
    const raw = p.raw || {};
    return {
      name: str(raw.name), nickname: str(raw.nickname), gender: p.gender === 'unknown' ? '' : p.gender,
      born: str(raw.born), died: str(raw.died), deceased: p.deceased, place: str(raw.place), bio: str(raw.bio),
    };
  }

  function formTitle(kind, p) {
    if (kind === 'details') return editor.on ? `Edit ${p.name}` : `Correct ${p.name}’s details`;
    if (kind === 'child') return `Add a child of ${p.name}`;
    if (kind === 'spouse') return `Add ${firstName(p)}’s husband or wife`;
    return `Add ${firstName(p)}’s father or mother`;
  }

  function openForm(kind, targetId, suggestion = null) {
    const p = person(targetId);
    if (!p) return;
    const v = kind === 'details' ? currentFields(p) : {};
    if (suggestion) for (const [k, x] of Object.entries(suggestion.fields || {})) v[k] = x == null ? '' : x;
    const field = (name, label, extra = '') => `<label class="field"><span>${label}</span><input name="${name}" value="${esc(v[name] || '')}" autocomplete="off" ${extra}></label>`;
    const others = kind === 'child' ? p.spouses.map(person) : [];
    const radio = (g, label) => `<label><input type="radio" name="gender" value="${g}"${v.gender === g ? ' checked' : ''}> ${label}</label>`;
    const photoNow = kind === 'details' && p.photo ? avatar(p, 'lg') : `<span class="avatar lg g-unknown">${ICON_CAMERA}</span>`;
    ui.panelBody.innerHTML = `
      <form class="edit-form" id="editForm" novalidate>
        <h2>${esc(formTitle(kind, p))}</h2>
        ${suggestion ? `<p class="from">Suggested by ${esc(suggestion.from || 'a relative')}. Check it, change anything you like, then save.${suggestion.photo ? ' They sent a photo too: save it from WhatsApp and choose it below.' : ''}</p>` : ''}
        ${field('name', 'Full name', 'required')}
        ${field('nickname', 'Nickname <small>(optional)</small>')}
        <div class="field"><span>Gender</span><div class="radios" role="radiogroup">${radio('male', 'Male')}${radio('female', 'Female')}</div></div>
        <div class="two">${field('born', 'Born', 'placeholder="1952-08-21 or 1952"')}${field('place', 'Place')}</div>
        <div class="two">${field('died', 'Died', 'placeholder="year or date"')}
          <label class="check"><input type="checkbox" name="deceased"${v.deceased ? ' checked' : ''}> Passed away</label></div>
        ${others.length ? `<label class="field"><span>Other parent</span><select name="other">${others.map((o) => `<option value="${esc(o.id)}"${suggestion && suggestion.other === o.id ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}<option value="">Not listed</option></select></label>` : ''}
        <label class="field"><span>About them <small>(optional)</small></span><textarea name="bio" rows="4">${esc(v.bio || '')}</textarea></label>
        <div class="photo-pick"><span class="photo-now">${photoNow}</span>
          <label class="btn"><input type="file" name="photo" accept="image/*"><span>${kind === 'details' && p.photo ? 'Change photo' : 'Choose a photo'}</span></label></div>
        ${editor.on ? '' : `<label class="field"><span>Your name</span><input name="from" value="${esc(rememberedName())}" autocomplete="name" required></label>`}
        <p class="form-error" role="alert" hidden></p>
        <div class="actions"><button class="btn primary" type="submit">${editor.on ? 'Save' : `Send to ${esc(keeperName())}`}</button>
          <button class="btn" type="button" data-back="${esc(targetId)}">Cancel</button></div>
        <p class="hint">${editor.on ? 'Saves into family.yaml. The site updates for everyone about a minute later.'
          : `Opens WhatsApp with your suggestion. ${esc(keeperName())} checks it before it goes on the tree.`}</p>
      </form>`;
    ui.panel.scrollTop = 0;
    const form = $('editForm');
    let picked = null;
    form.elements.photo.addEventListener('change', async () => {
      const file = form.elements.photo.files[0];
      if (!file) return;
      try {
        picked = await resizePhoto(file);
        form.querySelector('.photo-now').innerHTML = `<span class="avatar lg"><img src="${URL.createObjectURL(picked)}" alt=""></span>`;
      } catch {
        formError(form, 'That photo couldn’t be read. Try another one.');
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = readForm(form);
      const problem = checkForm(f);
      if (problem) return formError(form, problem);
      if (editor.on) saveEdit(kind, targetId, f, picked, form);
      else sendSuggestion(kind, targetId, f, picked, form);
    });
    if (!suggestion) form.elements.name.focus({ preventScroll: true });
  }

  function readForm(form) {
    const el = form.elements;
    const val = (n) => (el[n] ? str(el[n].value) : '');
    const gender = form.querySelector('input[name="gender"]:checked');
    return {
      name: val('name'), nickname: val('nickname'), gender: gender ? gender.value : '', born: val('born'), died: val('died'),
      deceased: Boolean(el.deceased && el.deceased.checked) || Boolean(val('died')), place: val('place'),
      bio: el.bio ? el.bio.value.trim() : '', other: val('other'), from: val('from'),
    };
  }

  function checkForm(f) {
    if (!f.name) return 'Please write their name.';
    for (const key of ['born', 'died']) {
      if (f[key] && !/\d{4}/.test(f[key])) return `${FIELD_LABELS[key]} needs a year, e.g. 1952 or 1952-08-21.`;
    }
    if (!editor.on && !f.from) return 'Please write your name, so they know who it’s from.';
    return '';
  }

  function formError(form, message) {
    const el = form.querySelector('.form-error');
    el.textContent = message;
    el.hidden = false;
    el.scrollIntoView({ block: 'nearest' });
  }

  // Square, about 400 × 400, cropped a little above the middle where faces usually are.
  async function resizePhoto(file) {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 400;
    canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) * 0.3, side, side, 0, 0, 400, 400);
    if (bitmap.close) bitmap.close();
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('photo'))), 'image/jpeg', 0.86));
  }

  // A form's details on top of what's already written; empty fields are taken out.
  function mergeFields(base, f, photoPath) {
    const out = { ...base };
    for (const key of EDITABLE) {
      const v = key === 'deceased' ? f.deceased && !f.died : f[key];
      if (v) out[key] = v; else delete out[key];
    }
    if (photoPath) out.photo = photoPath;
    return out;
  }

  function makeId(name, taken) {
    const words = fold(name).split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
    const tries = [words[0], words.slice(0, 2).join('-')].filter(Boolean);
    const free = (id) => !taken.has(id) && !people.has(id);
    const first = tries.find(free);
    if (first) return first;
    const base = tries[0] || 'person';
    let n = 2;
    while (!free(`${base}${n}`)) n++;
    return `${base}${n}`;
  }

  /* Suggestions: a WhatsApp message with a summary and a link that opens the filled-in form. */

  const toB64url = (s) => { let b = ''; new TextEncoder().encode(s).forEach((c) => { b += String.fromCharCode(c); }); return btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const fromB64url = (s) => new TextDecoder().decode(fromB64(s.replace(/-/g, '+').replace(/_/g, '/')));

  function readSuggestion() {
    const h = readHash();
    if (!h.person.startsWith('~')) return null;
    try {
      const s = JSON.parse(fromB64url(h.person.slice(1)));
      const ok = s && s.v === 1 && typeof s.target === 'string' && (s.kind === 'details' || RELATION[s.kind])
        && s.fields && typeof s.fields === 'object';
      if (!ok) return null;
      // It came in a link, so keep only the fields the form knows.
      s.fields = Object.fromEntries(Object.entries(s.fields).filter(([k, v]) => EDITABLE.includes(k) && (v == null || typeof v !== 'object')));
      s.from = clip(str(s.from), 60);
      return s;
    } catch {
      return null;
    }
  }

  function suggestionText(s) {
    const p = person(s.target);
    const show = (v) => (v === true ? 'yes' : v === false ? 'no' : v === 'male' ? 'Male' : v === 'female' ? 'Female' : v ? clip(String(v)) : '(empty)');
    if (s.kind === 'details') {
      const now = currentFields(p);
      const changes = Object.entries(s.fields).map(([k, v]) => `• ${FIELD_LABELS[k]}: ${show(now[k])} → ${show(v)}`);
      if (s.photo) changes.push('• A new photo (attached)');
      return `Family tree: a correction for ${p.name}, from ${s.from}:\n${changes.join('\n')}`;
    }
    const other = s.other && person(s.other);
    const who = s.kind === 'child' ? `a child of ${p.name}${other ? ` and ${other.name}` : ''}`
      : s.kind === 'spouse' ? `${p.name}’s husband or wife`
        : `${p.name}’s ${s.fields.gender === 'male' ? 'father' : s.fields.gender === 'female' ? 'mother' : 'parent'}`;
    const details = EDITABLE.filter((k) => s.fields[k]).map((k) => `• ${FIELD_LABELS[k]}: ${show(s.fields[k])}`);
    if (s.photo) details.push('• A photo (attached)');
    return `Family tree: ${s.from} suggests adding ${who}:\n${details.join('\n')}`;
  }

  function sendSuggestion(kind, targetId, f, photo, form) {
    const p = person(targetId);
    const fields = {};
    if (kind === 'details') {
      const now = currentFields(p);
      for (const key of EDITABLE) {
        const v = key === 'deceased' ? f.deceased : f[key];
        if (String(v || '') !== String(now[key] || '')) fields[key] = v === '' ? null : v;
      }
      if (!Object.keys(fields).length && !photo) return formError(form, 'Nothing has been changed yet.');
    } else {
      for (const key of EDITABLE) {
        const v = key === 'deceased' ? f.deceased && !f.died : f[key];
        if (v) fields[key] = v;
      }
    }
    try { localStorage.setItem(NAME_KEY, f.from); } catch { /* fine */ }
    const s = { v: 1, kind, target: targetId, fields, from: f.from };
    if (kind === 'child' && f.other) s.other = f.other;
    if (photo) s.photo = true;
    const text = `${suggestionText(s)}\n\nTo check it and add it to the tree: ${siteBase()}#${code}/~${toB64url(JSON.stringify(s))}`;
    const number = str(meta.keeper_whatsapp).replace(/\D/g, '');
    const file = photo && new File([photo], `${fold(f.name || p.name).replace(/[^a-z0-9]+/g, '-')}.jpg`, { type: 'image/jpeg' });
    let shared = false;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], text }).catch(() => {}); // pick the editor's chat in WhatsApp
      shared = true;
    } else {
      window.open(`https://wa.me/${number}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    }
    ui.panelBody.innerHTML = `<div class="sent"><h2>Thank you</h2>
      <p>Your suggestion is ready in WhatsApp${number || shared ? '' : ': choose ' + esc(keeperName()) + '’s chat'}. Press send there, and ${esc(keeperName())} will check it before it goes on the tree.</p>
      ${file && !shared ? '<p><strong>Please attach the photo in WhatsApp too.</strong></p>' : ''}
      <div class="actions"><button class="btn" type="button" data-back="${esc(targetId)}">Back to ${esc(p.name)}</button></div></div>`;
  }

  /* The editor: signs in once per device with a GitHub token and saves straight into family.yaml. */

  function storedToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
  }

  async function afterStart() {
    const token = storedToken();
    if (token && code) {
      try {
        await startEditor(token);
      } catch (err) {
        if (err.status === 401) { try { localStorage.removeItem(TOKEN_KEY); } catch { /* fine */ } }
        toast(`Couldn’t open family.yaml for editing: ${err.message}`, 9000);
      }
    } else if (code && new URLSearchParams(location.search).has('editor')) {
      return showSignIn();
    }
    handleSuggestion();
  }

  function handleSuggestion() {
    const s = pendingSuggestion;
    pendingSuggestion = null;
    if (!s) return;
    if (!editor.on) return toast(`This link is a suggested change for ${keeperName()} to check.`);
    if (!people.has(s.target)) return toast('That suggestion is about someone who isn’t in the tree any more.');
    focusPerson(s.target, false);
    openForm(s.kind, s.target, s);
  }

  async function startEditor(token) {
    const repoName = str(meta.data_repo);
    if (!repoName) throw new Error('add data_repo to family.yaml first.');
    const [store, yaml] = await Promise.all([import('./edit-store.mjs'), import('./js-yaml.mjs')]);
    const repo = new store.Repo(repoName, token);
    const text = await repo.read();
    let data;
    try {
      data = yaml.load(text);
    } catch (err) {
      throw new Error(`family.yaml on GitHub has a mistake in it (${err.message.split('\n')[0]}). Fix that first.`);
    }
    Object.assign(editor, { on: true, repo, store, yaml, text });
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* signed in for this visit only */ }
    ui.editbar.hidden = false;
    reload(data, state.selected); // the editor sees family.yaml as it is now, saved but not yet published
  }

  function showSignIn(message = '') {
    const repoName = str(meta.data_repo) || 'the family repo';
    const tokenUrl = `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams({
      name: 'Family tree editor', description: `Lets the family tree website save changes to family.yaml in ${repoName}`, expires_in: '366', contents: 'write',
    })}`;
    ui.status.innerHTML = `
      <form class="box lock signin" id="signin" autocomplete="off">
        <h2>Sign in to edit</h2>
        <p>On this device, changes will save straight into <code>family.yaml</code>. It takes a GitHub token that can change <code>${esc(repoName)}</code>:</p>
        <ol>
          <li><a href="${esc(tokenUrl)}" target="_blank" rel="noopener">Create the token on GitHub</a>. The name, expiry and permission are filled in.</li>
          <li>Under <b>Repository access</b>, choose <b>Only select repositories</b> and pick <b>${esc(repoName.split('/').pop())}</b>.</li>
          <li>Press <b>Generate token</b>, then copy it and paste it here.</li>
        </ol>
        <div class="lock-row"><input id="token" type="password" placeholder="github_pat_…" aria-label="GitHub token" autocomplete="off" required><button class="btn primary" type="submit">Sign in</button></div>
        <p class="lock-error" id="signinError" role="alert"${message ? '' : ' hidden'}>${esc(message)}</p>
        <button class="link" type="button" id="signinCancel">Not now</button>
      </form>`;
    ui.status.hidden = false;
    const form = $('signin'), button = form.querySelector('[type="submit"]');
    $('signinCancel').addEventListener('click', () => { ui.status.hidden = true; handleSuggestion(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      button.disabled = true;
      button.textContent = 'Checking…';
      try {
        await startEditor(str($('token').value));
        ui.status.hidden = true;
        toast('Signed in. Edits on this device now save straight into family.yaml.');
        handleSuggestion();
      } catch (err) {
        showSignIn(err.message);
      }
    });
  }

  async function saveEdit(kind, targetId, f, photo, form) {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const { store } = editor;
      const taken = new Set(store.findPeople(editor.text).blocks.map((b) => b.id));
      const id = kind === 'details' ? targetId : makeId(f.name, taken);
      const photoPath = photo ? `photos/${id}.jpg` : '';
      const files = photo ? { [photoPath]: new Uint8Array(await photo.arrayBuffer()) } : {};
      // Runs on the latest family.yaml from GitHub, so a change saved elsewhere meanwhile is kept.
      const update = (text) => {
        const doc = store.findPeople(text);
        const block = (x) => doc.blocks.find((b) => b.id === x);
        const rawOf = (x) => {
          if (!block(x)) throw new Error(`${person(x) ? person(x).name : x} isn’t in family.yaml any more.`);
          return { ...block(x).data };
        };
        const target = rawOf(targetId);
        if (kind === 'details') return store.applyChanges(text, [{ replace: targetId, person: mergeFields(target, f, photoPath) }]);
        if (block(id)) throw new Error('Someone just added a person with the same id. Press Save again.');
        const fresh = mergeFields({ id }, f, photoPath);
        if (kind === 'spouse') return store.applyChanges(text, [{ add: { ...fresh, spouses: [targetId] }, after: targetId }]);
        if (kind === 'child') {
          const other = f.other && block(f.other) ? rawOf(f.other) : null;
          const otherId = other ? str(other.id) : '';
          const parents = !other ? [targetId]
            : normGender(target.gender) !== 'male' && normGender(other.gender) === 'male' ? [otherId, targetId] : [targetId, otherId];
          const kids = doc.blocks.filter((b) => toList(b.data.parents).includes(targetId));
          return store.applyChanges(text, [{ add: { ...fresh, parents }, after: kids.length ? kids[kids.length - 1].id : targetId }]);
        }
        const parents = toList(target.parents);
        if (parents.length >= 2) throw new Error(`${str(target.name)} already has two parents listed.`);
        const next = f.gender === 'male' ? [id, ...parents] : [...parents, id]; // father first
        return store.applyChanges(text, [{ add: fresh, after: targetId }, { replace: targetId, person: { ...target, parents: next } }]);
      };
      const what = kind === 'details' ? `Update ${f.name}` : `Add ${f.name}, ${RELATION[kind]} of ${person(targetId).name}`;
      const result = await editor.repo.commit(`${what}\n\nSaved from the family tree website.`, update, files);
      editor.text = result.text;
      if (photo) photos.set(`repo:${photoPath}`, URL.createObjectURL(photo));
      reload(editor.yaml.load(result.text), id);
      toast('Saved. The site updates for everyone in about a minute.');
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Save';
      formError(form, err.message || 'Couldn’t save. Try again.');
    }
  }

  ui.signOut.addEventListener('click', () => {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* fine */ }
    location.reload();
  });

  /* ---------- Search ---------- */

  let hits = [];
  let active = 0;

  function runSearch() {
    const q = fold(ui.search.value.trim());
    if (!q) return hideResults();
    const scored = [];
    for (const p of people.values()) {
      const hay = fold(`${p.name} ${p.nickname}`);
      const at = hay.indexOf(q);
      if (at !== -1) scored.push([at === 0 || hay[at - 1] === ' ' ? 0 : 1, p]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
    hits = scored.slice(0, 8).map(([, p]) => p.id);
    active = 0;
    drawResults();
  }

  function drawResults() {
    ui.results.innerHTML = hits.length
      ? hits.map((id, i) => {
        const p = person(id), y = years(p);
        return `<li role="option" id="hit-${i}" data-id="${esc(id)}" class="${i === active ? 'active' : ''}" aria-selected="${i === active}">`
          + `${avatar(p, 'sm')}<span><b>${esc(p.name)}</b>${y ? `<small>${esc(y)}</small>` : ''}</span></li>`;
      }).join('')
      : '<li class="empty" role="option" aria-disabled="true">No one by that name</li>';
    ui.results.hidden = false;
    ui.search.setAttribute('aria-expanded', 'true');
    if (hits.length) ui.search.setAttribute('aria-activedescendant', `hit-${active}`);
    else ui.search.removeAttribute('aria-activedescendant');
  }

  function hideResults() {
    hits = [];
    ui.results.hidden = true;
    ui.search.setAttribute('aria-expanded', 'false');
    ui.search.removeAttribute('aria-activedescendant');
  }

  function pick(id) {
    ui.search.value = '';
    hideResults();
    ui.search.blur();
    focusPerson(id);
  }

  ui.search.addEventListener('input', runSearch);
  ui.search.addEventListener('focus', runSearch);
  ui.search.addEventListener('blur', hideResults);
  ui.search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!hits.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      drawResults();
    } else if (e.key === 'Enter') {
      if (hits[active]) { e.preventDefault(); pick(hits[active]); }
    } else if (e.key === 'Escape') {
      ui.search.value = '';
      hideResults();
      ui.search.blur();
    }
  });
  ui.results.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the box
  ui.results.addEventListener('click', (e) => {
    const li = e.target.closest('[data-id]');
    if (li) pick(li.dataset.id);
  });

  load();
})();
