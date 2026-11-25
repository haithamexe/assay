/* What the page knows, and where it is. The address holds the slice being looked at (page, commits, finding, tab), so it can be
   bookmarked and the back button works. pushState rather than location.hash: some previews block fragment navigation. */

export const S = {
  repo: null,
  offline: false,
  newCommits: false,
  // timeline
  timeline: null, branch: null, cases: null, limit: 30,
  sel: { mode: 'branch', from: null, to: null, pick: null },
  // case file
  caseId: null, view: null, item: null, tab: null, lens: 'all', showAll: false,
  cmp: { mode: 'slider', pos: 50, shot: -1 },
  job: null, jobCase: null, jobResult: null, needsOk: null, replay: {},
  // reviewers
  rv: { data: null, request: '', error: null, tab: 'panel', cal: null, calError: null, calRunning: null },
  // memory
  mem: { data: null, tab: 'mistakes', kind: 'all', q: '', sel: null, confirm: null, mining: null, error: null },
  // settings
  settings: null, theme: 'auto',
  // loading and errors
  loading: {}, error: null
};

export const ACT = {};

let renderer = () => {};
export const setRenderer = fn => { renderer = fn; };
export const render = () => renderer();

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = raw.split('?');
  return { page: p || 'timeline', params: Object.fromEntries(new URLSearchParams(q)) };
}

export function restore() {
  const { page, params: p } = parseHash();
  if (page === 'timeline') {
    if (['single', 'range', 'branch'].includes(p.mode)) S.sel.mode = p.mode;
    if (p.from) S.sel.from = p.from;
    if (p.to) S.sel.to = p.to;
  }
  if (page === 'case') {
    if (p.id && p.id !== S.caseId) { S.caseId = p.id; S.view = null; S.item = null; S.jobResult = null; S.replay = {}; }
    if (p.item) S.item = p.item;
    S.tab = p.tab || null;
    S.lens = p.lens || 'all';
  }
  if (page === 'reviewers') {
    if (p.id && p.id !== S.caseId) { S.caseId = p.id; S.view = null; S.item = null; S.jobResult = null; S.replay = {}; S.rv.data = null; S.rv.request = ''; }
    S.rv.tab = p.tab === 'score' ? 'score' : 'panel';
  }
  if (page === 'memory') {
    S.mem.tab = p.tab === 'standards' || p.tab === 'mine' ? p.tab : 'mistakes';
    if (p.id) S.mem.sel = p.id;
  }
}

export function sync() {
  const { page } = parseHash();
  let p = {};
  if (page === 'timeline') p = { mode: S.sel.mode, from: S.sel.mode === 'branch' ? '' : S.sel.from, to: S.sel.mode === 'branch' ? '' : S.sel.to };
  else if (page === 'case') p = { id: S.caseId, item: S.item, tab: S.tab, lens: S.lens === 'all' ? '' : S.lens };
  else if (page === 'reviewers') p = { id: S.caseId, tab: S.rv.tab === 'score' ? 'score' : '' };
  else if (page === 'memory') p = { tab: S.mem.tab === 'mistakes' ? '' : S.mem.tab, id: S.mem.tab === 'mistakes' ? S.mem.sel : '' };
  const q = new URLSearchParams(Object.fromEntries(Object.entries(p).filter(([, v]) => v))).toString();
  const next = `#/${page}${q ? `?${q}` : ''}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

let routeFn = () => {};
export const setRouter = fn => { routeFn = fn; };

export function navTo(h) {
  if (location.hash !== h) {
    try { history.pushState(null, '', h); } catch { location.hash = h; return; }
  }
  routeFn();
}
export function go(page, extra) {
  const q = extra ? new URLSearchParams(Object.fromEntries(Object.entries(extra).filter(([, v]) => v))).toString() : '';
  navTo(`#/${page}${q ? `?${q}` : ''}`);
}
