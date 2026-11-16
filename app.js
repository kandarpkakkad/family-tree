/*
 * Family tree viewer: draws the family as a tree you can drag, zoom and search.
 *
 * The published site has data.json, which is encrypted (see build/build.mjs). The code
 * after # in the link opens it; links look like  …/#code  or  …/#code/person-id.
 * A local preview (serve.ps1) has no data.json and reads family.json directly instead.
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
  const ICON_LINK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L10 5M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1"/></svg>';

  const $ = (id) => document.getElementById(id);
  const ui = {
    topbar: $('topbar'), title: $('title'), subtitle: $('subtitle'),
    line: $('line'), lineWrap: $('lineWrap'), search: $('search'), results: $('results'),
    notice: $('notice'), viewport: $('viewport'), world: $('world'), links: $('links'), cards: $('cards'),
    status: $('status'), panel: $('panel'), panelBody: $('panelBody'), panelClose: $('panelClose'),
    zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomFit: $('zoomFit'), layout: $('layout'),
  };

  const people = new Map();       // id -> person
  const placed = new Map();       // id -> {x, y} of the person's card in the current tree
  const state = { root: null, selected: null, collapsed: new Set(), across: true };
  const view = { x: 0, y: 0, k: 1 };
  const narrow = window.matchMedia('(max-width: 640px)');
  let lines = [];                 // family lines offered in the drop-down
  let tree = null;
  let bounds = { w: 0, h: 0 };
  let code = '';                  // the access code that opened the tree (kept in links)
  let dataKey = null;             // decrypts photos when the tree came encrypted
  const photos = new Map();       // encrypted photo path -> object URL, a pending promise, or null

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

  function avatar(p, size = '') {
    let src = p.photo;
    let wait = '';
    if (src && p.photoType) {            // encrypted photo: show initials until it's decrypted
      src = photos.get(p.photo);
      if (typeof src !== 'string') {
        src = '';
        if (photos.get(p.photo) !== null) { wait = ` data-photo="${esc(p.photo)}"`; loadPhoto(p); }
      }
    }
    const img = src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : '';
    return `<span class="avatar ${size} g-${p.gender}"${wait} aria-hidden="true"><span>${esc(initials(p))}</span>${img}</span>`;
  }

  function loadPhoto(p) {
    if (photos.has(p.photo)) return;
    photos.set(p.photo, (async () => {
      try {
        const res = await fetch(`${p.photo}?v=${encodeURIComponent(BUILD)}`);
        if (!res.ok) throw new Error(res.status);
        const plain = await openSealed(dataKey, new Uint8Array(await res.arrayBuffer()));
        const url = URL.createObjectURL(new Blob([plain], { type: p.photoType }));
        photos.set(p.photo, url);
        document.querySelectorAll(`.avatar[data-photo="${CSS.escape(p.photo)}"]`).forEach((el) => {
          el.removeAttribute('data-photo');
          el.insertAdjacentHTML('beforeend', `<img src="${url}" alt="">`);
        });
      } catch {
        photos.set(p.photo, null); // keep the initials
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

  // Local preview: no encrypted data.json, so read family.json from the repo.
  async function loadPreview() {
    let text;
    try {
      const res = await fetch('family.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      text = await res.text();
    } catch (err) {
      return fail('Could not load the family data', `Tried <code>family.json</code>, but ${esc(err.message)}.`);
    }
    let data;
    try {
      data = JSON.parse(text.replace(/^﻿/, ''));
    } catch (err) {
      return fail('family.json has a mistake in it',
        `${esc(err.message)}${esc(where(text, err.message))}.<br><br>Usual causes: a missing comma between two entries, a comma after the last entry in a list, or a missing quote mark.`);
    }
    start(data);
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

  // Turn "at position 1234" into a line and column when the browser didn't give one.
  function where(text, msg) {
    if (/line \d+/i.test(msg)) return '';
    const m = /position (\d+)/.exec(msg);
    if (!m) return '';
    const before = text.slice(0, +m[1]).split('\n');
    return ` (line ${before.length}, column ${before[before.length - 1].length + 1})`;
  }

  function fail(title, html) {
    ui.status.innerHTML = `<div class="box"><h2>${esc(title)}</h2><p>${html}</p></div>`;
    ui.status.hidden = false;
  }

  function start(data) {
    const list = Array.isArray(data) ? data : data && data.people;
    if (!Array.isArray(list)) return fail('No "people" list found', 'family.json should look like <code>{ "title": "…", "people": [ … ] }</code>.');
    const meta = Array.isArray(data) ? {} : data;
    const title = str(meta.title) || 'Family Tree';
    ui.title.textContent = title;
    document.title = title;

    const problems = buildIndex(list);
    if (!people.size) return fail('No one here yet', 'Add people to the <code>"people"</code> list in <code>data/family.json</code>.');

    ui.subtitle.textContent = [str(meta.subtitle), `${people.size} ${people.size === 1 ? 'person' : 'people'}`, plural(generations(), 'generation')]
      .filter(Boolean).join(' · ');
    lines = findLines();
    ui.line.innerHTML = lines.map((l) => `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join('');
    ui.lineWrap.hidden = lines.length < 2;
    showProblems(problems);
    ui.status.hidden = true;

    const preferred = str(meta.root);
    state.root = canonical(people.has(preferred) ? preferred : lines.length ? lines[0].id : people.keys().next().value);
    let saved = '';
    try { saved = localStorage.getItem(LAYOUT_KEY) || ''; } catch { /* fine */ }
    setLayout((saved || str(meta.layout).toLowerCase() || 'across') === 'across');
    render();
    fit(false, true);
    document.body.classList.add('ready');
    const wanted = hashId();
    if (wanted) focusPerson(wanted, false);
    else setHash('');
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
        deceased: Boolean(str(raw.died)) || raw.deceased === true,
        place: str(raw.place),
        photo: str(raw.photo),
        photoType: str(raw.photoType),
        bio: str(raw.bio),
        rawParents: toList(raw.parents),
        rawSpouses: toList(raw.spouses).concat(toList(raw.spouse)),
        parents: [], spouses: [], children: [],
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

  function render() {
    setGeometry();
    tree = buildTree(state.root);
    shape(tree);
    place(tree, -Math.min(...tree.outline.map(([lo]) => lo)), 0);
    placed.clear();
    const cards = [], extras = [], paths = [], rings = [];
    const { cb, cd, level } = geo;
    let w = 0, h = 0;

    const draw = (u, isRoot) => {
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
          paths.push(`<path class="marriage" d="M${pt(b1, mid)}L${pt(b2, mid)}"/>`);
          rings.push(`<circle class="ring" cx="${ring.x}" cy="${ring.y}" r="4"/>`);
        } else {
          paths.push(`<path class="marriage" d="M${pt(centre(a), u.d)}L${pt(centre(a), u.d - 18)}L${pt(centre(b), u.d - 18)}L${pt(centre(b), u.d)}"/>`);
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
        g.kids.forEach((k) => paths.push(`<path d="${elbow(ob, od, anchor(k), k.d, bar)}"/>`));
      });

      if (u.total && !u.ghost) {
        const [tb, td] = origin(u.members.length === 2 ? u.members[1 - pi].id : null);
        const tAt = u.d + cd + 17;
        const hidden = u.collapsed ? descendants(u.id) : 0;
        if (u.collapsed) paths.push(`<path d="M${pt(tb, td)}L${pt(tb, tAt)}"/>`);
        const at = xy(tb, tAt);
        const title = u.collapsed ? `Show ${plural(hidden, 'descendant')}` : `Hide ${firstName(person(u.id))}’s descendants`;
        extras.push(`<button class="toggle${u.collapsed ? ' collapsed' : ''}" type="button" data-toggle="${esc(u.id)}" style="left:${at.x}px;top:${at.y}px" aria-expanded="${!u.collapsed}" title="${esc(title)}" aria-label="${esc(title)}">${u.collapsed ? `+${hidden}` : '−'}</button>`);
      }
      kidsOf(u).forEach((k) => draw(k, false));
    };
    draw(tree, true);
    ui.world.classList.toggle('across', geo.across);

    ui.links.setAttribute('width', w);
    ui.links.setAttribute('height', h);
    ui.links.innerHTML = paths.join('') + rings.join('');
    ui.cards.innerHTML = cards.join('') + extras.join('');
    bounds = { w, h };
    syncLineSelect();
  }

  function cardHTML(p, x, y, ghost) {
    const yrs = ghost ? 'Also shown elsewhere' : years(p);
    const cls = ['card', `g-${p.gender}`];
    if (p.deceased) cls.push('deceased');
    if (ghost) cls.push('ghost');
    else if (p.id === state.selected) cls.push('selected');
    const label = p.name + (yrs ? `, ${yrs}` : '');
    return `<div class="${cls.join(' ')}" data-id="${esc(p.id)}"${ghost ? ' data-ghost' : ''} role="button" tabindex="0" style="left:${x}px;top:${y}px" aria-label="${esc(label)}">`
      + `${avatar(p)}<span class="meta"><span class="name">${esc(p.name)}</span>${yrs ? `<span class="years">${esc(yrs)}</span>` : ''}</span></div>`;
  }

  function syncLineSelect() {
    if (ui.lineWrap.hidden) return;
    let custom = ui.line.querySelector('option[data-custom]');
    if (lines.some((l) => l.id === state.root)) {
      if (custom) custom.remove();
      ui.line.value = state.root;
      return;
    }
    if (!custom) {
      custom = document.createElement('option');
      custom.dataset.custom = '';
      ui.line.append(custom);
    }
    custom.value = state.root;
    custom.textContent = `${person(state.root).name}’s branch`;
    ui.line.value = state.root;
  }

  function showProblems(list) {
    if (!list.length) return;
    console.warn(`family.json problems:\n- ${list.join('\n- ')}`);
    ui.notice.innerHTML = `<details><summary>${plural(list.length, 'problem')} found in family.json</summary><ul>${list.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>`
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
    actions.push(`<button class="btn" type="button" data-act="copy">${ICON_LINK}<span>Copy link</span></button>`);

    const life = years(p);
    return `<div class="p-head">${avatar(p, 'xl')}<h2 id="panelTitle">${esc(p.name)}</h2>`
      + (p.nickname ? `<p class="aka">“${esc(p.nickname)}”</p>` : '')
      + (life ? `<p class="life">${esc(life)}</p>` : '') + '</div>'
      + (facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '')
      + (p.bio ? `<div class="bio">${p.bio.split(/\n\s*\n/).map((t) => `<p>${esc(t)}</p>`).join('')}</div>` : '')
      + rel.map(([label, chips]) => `<section class="rel"><h3>${label}</h3><div class="chips">${chips.join('')}</div></section>`).join('')
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
    const act = e.target.closest('[data-act]');
    if (!act || !state.selected) return;
    if (act.dataset.act === 'line') showLine(state.selected);
    if (act.dataset.act === 'copy') copyLink(act);
  });

  ui.panelClose.addEventListener('click', closePanel);
  ui.zoomIn.addEventListener('click', () => zoomBy(1.3));
  ui.zoomOut.addEventListener('click', () => zoomBy(1 / 1.3));
  ui.zoomFit.addEventListener('click', () => fit(true));
  ui.layout.addEventListener('click', () => {
    setLayout(!state.across);
    render();
    if (state.selected && placed.has(state.selected)) centerOn(state.selected, false);
    else fit(false, true);
  });

  ui.line.addEventListener('change', () => {
    state.root = ui.line.value;
    render();
    if (state.selected && !placed.has(state.selected)) closePanel();
    fit(true, true);
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
