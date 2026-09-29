/**
 * The client: routing, state, and the event wiring between them.
 *
 * Routing is hash-based so the server never needs a catch-all. A catch-all
 * would answer a mistyped asset path with an HTML page and a 200, which turns a
 * broken link into a confusing blank screen; here a missing file is a real 404.
 *
 * A live run is patched in place from its event stream rather than re-fetched.
 * The server sends the blocks that changed and their indices, so a token
 * arriving mid-run replaces one paragraph instead of re-rendering the page.
 */

import { api, subscribeToRun } from './api.js';
import {
  el,
  clear,
  renderBlocks,
  renderBlock,
  renderRunList,
  renderPageHeader,
  renderHealth,
  renderBudget,
  renderComposer,
  renderProjectPage,
  renderProjectDialog,
  renderRenameRunDialog,
  renderMoveRunDialog,
  relativeTime
} from './render.js';

const state = {
  route: { name: 'runs', id: null },
  runList: [],
  hasMore: false,
  liveCount: 0,
  limit: 40,
  query: '',
  selectedId: null,
  page: null,
  projectPage: null,
  projects: [],
  projectsCorrupted: false,
  config: null,
  health: null,
  status: null,
  error: null,
  composerOpen: false,
  defaults: {}
};

/** One open stream per run, closed when the run ends or the view moves on. */
let unsubscribeStream = null;

const dom = {
  nav: document.getElementById('nav'),
  /** The scroll container. Never cleared, because the topbar lives inside it. */
  main: document.querySelector('.main'),
  /** The routed content region, replaced on every render. */
  view: document.getElementById('view'),
  topbar: document.getElementById('topbar'),
  search: document.getElementById('search'),
  footer: document.getElementById('footer')
};

/* ------------------------------------------------------------------ routing */

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [head, id, tail] = raw.split('/');
  if (head === 'runs' && id) return { name: 'run', id: decodeURIComponent(id) };
  if (head === 'projects' && id) return { name: 'project', id: decodeURIComponent(id) };
  if (head === 'health') return { name: 'health' };
  if (head === 'budget') return { name: 'budget' };
  return { name: 'runs', id: null };
}

function go(hash) {
  if (window.location.hash === hash) {
    render();
    return;
  }
  window.location.hash = hash;
}

function openRun(id) {
  state.selectedId = id;
  go(`#/runs/${encodeURIComponent(id)}`);
}

/* -------------------------------------------------------------------- data */

async function loadConfig() {
  if (state.config) return state.config;
  state.config = await api.config();
  return state.config;
}

async function loadHealth() {
  state.health = await api.health();
  return state.health;
}

async function loadStatus() {
  try {
    state.status = await api.status();
  } catch (err) {
    state.status = { connected: false, error: err.message };
  }
  return state.status;
}

async function loadRuns() {
  const doc = await api.runs(state.limit);
  state.runList = doc.runs || [];
  state.hasMore = !!doc.hasMore;
  state.liveCount = doc.liveCount || 0;
  if (!state.selectedId && state.runList[0]) state.selectedId = state.runList[0].id;
  return doc;
}

async function loadProjects() {
  const doc = await api.projects();
  state.projects = doc.projects || [];
  state.projectsCorrupted = !!doc.corrupted;
  return doc;
}

async function loadProjectPage(id) {
  const doc = await api.project(id);
  state.projectPage = { ...doc.project, runs: doc.runs || [], hasMore: !!doc.hasMore };
  return doc;
}

function filteredRuns() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.runList;
  return state.runList.filter((run) =>
    [run.title, run.playbook, run.model, run.badge, run.workspace]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(q))
  );
}

/* ------------------------------------------------------------------ streams */

/**
 * Follow a run's events and patch the page as they arrive.
 *
 * The stream is opened only for runs this process is still running. An archived
 * run needs no stream: every event it will ever produce is already in history.
 */
function watchRun(id) {
  closeStream();
  const run = state.runList.find((r) => r.id === id);
  const isLive = state.page?.live || run?.live;
  if (!isLive) return;

  unsubscribeStream = subscribeToRun(id, {
    blocks: ({ items }) => {
      const page = state.page;
      if (!page || !Array.isArray(page.blocks)) return;
      for (const { index, block } of items) page.blocks[index] = block;
      patchBlocks(items);
      if (items.length > 0) scrollToBottomIfPinned();
    },
    status: (doc) => {
      if (!state.page) return;
      state.page.status = doc.status;
      state.page.tone = doc.tone;
      if (doc.counts) state.page.counts = doc.counts;
      patchStatus();
    },
    open: (doc) => {
      // The server's opening page is authoritative about what already happened,
      // which matters after a reconnect: it is the state the deltas apply to.
      // But it is not authoritative about the title or the project link. That
      // page was projected when the run started, while the reader may have
      // renamed or moved the run since. The GET response above already carries
      // the amended page, so the stream's copy is kept for its blocks and its
      // own fields are left alone.
      if (doc.page && state.page && doc.page.id === state.page.id) {
        const keep = {
          title: state.page.title,
          projectId: state.page.projectId,
          projectName: state.page.projectName
        };
        state.page = { ...doc.page, ...keep };
        if (keep.projectName === undefined) delete state.page.projectName;
        render();
      } else if (doc.page) {
        state.page = doc.page;
        render();
      }
    },
    end: () => {
      closeStream();
      // Re-read the list so the card moves out of Running and the archived
      // record replaces the live one.
      loadRuns().then(render).catch(() => {});
    },
    shutdown: () => closeStream(),
    error: () => closeStream()
  });
}

function closeStream() {
  if (unsubscribeStream) {
    unsubscribeStream();
    unsubscribeStream = null;
  }
}

let pinnedToBottom = true;

function scrollToBottomIfPinned() {
  if (!pinnedToBottom) return;
  dom.main.scrollTop = dom.main.scrollHeight;
}

/** Replace one block in place, keeping scroll position and selection. */
function patchBlocks(items) {
  const host = dom.view.querySelector('.blocks');
  if (!host) {
    render();
    return;
  }
  for (const { index, block } of items) {
    const rendered = renderBlock(block);
    const existing = host.children[index];
    if (existing) host.replaceChild(rendered, existing);
    else host.append(rendered);
  }
}

function patchStatus() {
  const holder = dom.view.querySelector('.page__badge');
  if (!holder || !state.page) {
    render();
    return;
  }
  clear(holder);
  holder.append(el('span', { class: `chip chip--${state.page.tone || 'neutral'}`, text: state.page.status }));
  holder.append(el('span', { text: state.page.badge }));
  // The project chip belongs to the badge row the patch just rebuilt; without
  // this a live run that resolves its project mid-stream loses the link.
  if (state.page.projectName && state.page.projectId) {
    holder.append(el('button', {
      class: 'chip chip--project',
      type: 'button',
      text: state.page.projectName,
      onClick: () => go(`#/projects/${encodeURIComponent(state.page.projectId)}`)
    }));
  }
  // The stop button belongs to a run that is still going.
  const stop = dom.view.querySelector('[data-stop-run]');
  if (stop && state.page.status !== 'running' && state.page.status !== 'starting') stop.remove();
}

/* ------------------------------------------------------------------- views */

function renderSidebar() {
  const nav = clear(dom.nav);
  const runs = state.runList;
  const counts = {
    all: runs.length,
    agent: runs.filter((r) => r.badge === 'agent').length,
    task: runs.filter((r) => r.badge === 'task').length,
    panel: runs.filter((r) => r.badge === 'panel').length
  };
  const item = (label, count, active, onClick) =>
    el('button', {
      class: `nav__item${active ? ' nav__item--active' : ''}`,
      type: 'button',
      onClick
    }, [
      el('span', { text: label }),
      count === null ? null : el('span', { class: 'nav__count', text: String(count) })
    ]);

  nav.append(el('div', { class: 'nav__label', text: 'Runs' }));
  nav.append(item('All runs', counts.all, state.route.name === 'runs' && !state.query, () => {
    state.query = '';
    dom.search.value = '';
    go('#/');
  }));
  nav.append(item('Agent runs', counts.agent, false, () => {
    state.query = 'agent';
    dom.search.value = 'agent';
    go('#/');
  }));
  nav.append(item('Completed', null, false, () => {
    state.query = '';
    dom.search.value = '';
    state.selectedId = null;
    go('#/');
  }));

  nav.append(el('div', { class: 'nav__label', text: 'Projects' }));
  for (const project of state.projects) {
    nav.append(item(
      project.name,
      null,
      state.route.name === 'project' && state.route.id === project.id,
      () => go(`#/projects/${encodeURIComponent(project.id)}`)
    ));
  }
  nav.append(el('button', {
    class: 'nav__item nav__item--muted',
    type: 'button',
    // Wrapped: passing openProjectDialog bare would hand it the click event as
    // the "existing project" and open the dialog in edit mode.
    onClick: () => openProjectDialog()
  }, [el('span', { text: state.projects.length === 0 ? 'New project' : '+ New project' })]));

  nav.append(el('div', { class: 'nav__label', text: 'System' }));
  nav.append(item('Health', null, state.route.name === 'health', () => go('#/health')));
  nav.append(item('Model routing', null, state.route.name === 'budget', () => go('#/budget')));

  const bridge = state.health?.bridge;
  const foot = clear(dom.footer);
  foot.append(el('span', { class: `dot ${bridge ? (bridge.ok ? 'dot--ok' : 'dot--error') : ''}` }));
  foot.append(el('span', {
    text: bridge ? (bridge.ok ? `${bridge.mode || 'connected'}` : 'bridge unreachable') : 'checking bridge...'
  }));
}

function renderTopbar() {
  const bar = clear(dom.topbar);
  if (state.route.name === 'run' && state.page) {
    bar.append(el('div', { class: 'crumbs' }, [
      el('button', { class: 'btn', type: 'button', text: 'All runs', onClick: () => go('#/') }),
      el('span', { text: '/' }),
      el('strong', { text: state.page.title })
    ]));
  } else if (state.route.name === 'project' && state.projectPage) {
    bar.append(el('div', { class: 'crumbs' }, [
      el('button', { class: 'btn', type: 'button', text: 'All runs', onClick: () => go('#/') }),
      el('span', { text: '/' }),
      el('strong', { text: state.projectPage.name })
    ]));
  } else {
    bar.append(el('div', { class: 'crumbs' }, [
      el('strong', { text: state.route.name === 'health' ? 'Health' : state.route.name === 'budget' ? 'Model routing' : 'All runs' })
    ]));
  }
  bar.append(el('div', { class: 'spacer' }));
  bar.append(el('span', { class: 'hint' }, [
    el('span', { class: 'kbd', text: 'c' }),
    ' new run'
  ]));
  bar.append(el('button', {
    class: 'btn btn--primary',
    type: 'button',
    text: 'New run',
    onClick: openComposer
  }));
}

function renderMain() {
  const main = clear(dom.view);
  if (state.error) {
    main.append(el('div', { class: 'error-banner', text: state.error }));
  }
  if (state.route.name === 'health') {
    main.append(el('div', { class: 'page page--wide' }, [renderHealth(state.health, state.status)]));
    return;
  }
  if (state.route.name === 'budget') {
    main.append(el('div', { class: 'page page--wide' }, [
      renderBudget(state.config, state.status, {
        onApply: async (payload) => {
          await api.setBudget(payload);
          await Promise.all([loadConfig(), loadStatus()]);
          render();
        }
      })
    ]));
    return;
  }
  if (state.route.name === 'run' && state.page) {
    const page = el('div', { class: 'page' });
    const [head, props] = renderPageHeader(state.page, {
      onCancel: () => stopRun(state.page.id),
      onOpenProject: (id) => go(`#/projects/${encodeURIComponent(id)}`),
      onRename: () => openRenameRunDialog(state.page),
      onMove: () => openMoveRunDialog(state.page),
      onDelete: () => deleteRunFlow(state.page)
    });
    head.querySelector('button')?.setAttribute('data-stop-run', '');
    page.append(head, props);
    page.append(renderBlocks(state.page.blocks || []));
    main.append(page);
    return;
  }
  if (state.route.name === 'run') {
    main.append(el('div', { class: 'loading', text: 'Opening run...' }));
    return;
  }
  if (state.route.name === 'project' && state.projectPage) {
    main.append(renderProjectPage(state.projectPage, {
      selectedId: state.selectedId,
      onOpen: openRun,
      onNewRun: (project) => openComposer({ project }),
      onEdit: () => openProjectDialog(state.projectPage),
      onDelete: () => deleteProjectFlow(state.projectPage)
    }));
    return;
  }
  if (state.route.name === 'project') {
    main.append(el('div', { class: 'loading', text: 'Opening project...' }));
    return;
  }
  main.append(el('div', { class: 'page page--wide' }, [
    renderRunList({
      runs: filteredRuns(),
      hasMore: state.hasMore,
      liveCount: state.liveCount,
      selectedId: state.selectedId,
      query: state.query,
      onOpen: openRun,
      onLoadMore: async () => {
        state.limit += 40;
        await loadRuns();
        render();
      }
    })
  ]));
}

function render() {
  renderSidebar();
  renderTopbar();
  renderMain();
}

/* ----------------------------------------------------------------- actions */

async function stopRun(id) {
  try {
    await api.cancel(id);
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function openComposer(preset = {}) {
  const [config] = await Promise.all([loadConfig(), loadProjects().catch(() => {})]);
  const overlay = renderComposer({
    config,
    health: state.health,
    projects: state.projects,
    presetProjectId: preset.project?.id || null,
    defaults: { workspaceDir: state.defaults.workspaceDir || '' },
    onClose: () => {
      state.composerOpen = false;
      overlay.remove();
    },
    onSubmit: async (payload) => {
      const doc = await api.start(payload);
      overlay.remove();
      state.composerOpen = false;
      state.page = doc.page;
      state.selectedId = doc.id;
      // Take the id from the response rather than waiting for the list to
      // refresh: the run is already going and its stream is waiting.
      window.location.hash = `#/runs/${encodeURIComponent(doc.id)}`;
      await loadRuns();
      render();
      watchRun(doc.id);
    }
  });
  state.composerOpen = true;
  document.body.append(overlay);
}

/** The project create/edit dialog. */
async function openProjectDialog(existing = null) {
  // The dialog needs the vocabularies to offer defaults, so both load before
  // it opens rather than popping in after.
  await Promise.all([loadConfig().catch(() => {}), loadHealth().catch(() => {})]);
  const overlay = renderProjectDialog({
    existing,
    playbooks: state.config?.playbooks || [],
    policies: state.health?.policies || [],
    onClose: () => overlay.remove(),
    onSubmit: async (payload) => {
      const doc = existing
        ? await api.updateProject(existing.id, payload)
        : await api.createProject(payload);
      overlay.remove();
      await loadProjects();
      // Stay where the reader is: after an edit this is the project page, and
      // after a create it navigates straight to the new project.
      if (!existing && doc.project) go(`#/projects/${encodeURIComponent(doc.project.id)}`);
      else {
        if (state.route.name === 'project') await loadProjectPage(state.route.id).catch(() => {});
        render();
      }
    }
  });
  document.body.append(overlay);
}

async function deleteProjectFlow(project) {
  const runs = state.projectPage?.runs?.length ?? 0;
  const confirmed = window.confirm(
    `Delete project "${project.name}"? Its ${runs} recorded run${runs === 1 ? '' : 's'} stay${runs === 1 ? 's' : ''} in history and keep${runs === 1 ? 's' : ''} working.`
  );
  if (!confirmed) return;
  try {
    await api.deleteProject(project.id);
    await loadProjects();
    go('#/');
  } catch (err) {
    state.error = err.message;
    render();
  }
}

/** Rename one run. The PATCH response carries the amended page, so the client
 * updates from it rather than fetching twice. */
function openRenameRunDialog(page) {
  const overlay = renderRenameRunDialog({
    page,
    onClose: () => overlay.remove(),
    onSubmit: async (payload) => {
      const doc = await api.patchRun(page.id, payload);
      overlay.remove();
      if (doc.page) state.page = doc.page;
      await loadRuns().catch(() => {});
      render();
    }
  });
  document.body.append(overlay);
}

/** Move one run to another project, or detach it. */
async function openMoveRunDialog(page) {
  await loadProjects().catch(() => {});
  const overlay = renderMoveRunDialog({
    page,
    projects: state.projects,
    onClose: () => overlay.remove(),
    onSubmit: async (payload) => {
      const doc = await api.patchRun(page.id, payload);
      overlay.remove();
      if (doc.page) state.page = doc.page;
      await Promise.all([loadRuns().catch(() => {}), loadProjects().catch(() => {})]);
      render();
    }
  });
  document.body.append(overlay);
}

/** Hide one run from every list. The record stays, so the page still
 * resolves after deletion — the reader lands on the run they just removed
 * rather than a 404 for their own action. */
async function deleteRunFlow(page) {
  const confirmed = window.confirm(
    `Delete run "${page.title}"? It leaves every list, but the record stays in history and this page keeps working.`
  );
  if (!confirmed) return;
  try {
    await api.deleteRun(page.id);
    await loadRuns().catch(() => {});
    render();
  } catch (err) {
    state.error = err.message;
    render();
  }
}
/** Run once the route changes, loading whatever that route needs. */
async function route() {
  state.route = parseHash();
  state.error = null;
  closeStream();
  try {
    if (state.route.name === 'run') {
      const doc = await api.run(state.route.id);
      state.page = doc.page;
      // A run page needs the list only so the sidebar and the live check work.
      if (state.runList.length === 0) await loadRuns().catch(() => {});
      if (state.projects.length === 0) await loadProjects().catch(() => {});
      render();
      watchRun(state.route.id);
      return;
    }
    state.page = null;
    if (state.route.name === 'project') {
      try {
        await Promise.all([
          loadProjectPage(state.route.id),
          state.runList.length === 0 ? loadRuns().catch(() => {}) : null,
          state.projects.length === 0 ? loadProjects().catch(() => {}) : null
        ]);
      } catch (err) {
        state.error = err.message;
        state.projectPage = null;
      }
      render();
      return;
    }
    state.projectPage = null;
    if (state.route.name === 'health') {
      await Promise.all([loadHealth(), loadStatus().catch(() => {})]);
      render();
      return;
    }
    if (state.route.name === 'budget') {
      await Promise.all([loadConfig(), loadStatus()]);
      render();
      return;
    }
    await loadRuns();
    await loadProjects().catch(() => {});
    render();
  } catch (err) {
    state.error = err.message;
    render();
  }
}

/* ---------------------------------------------------------------- keyboard */

function onKeydown(event) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (event.key === 'Escape') {
    if (state.composerOpen) {
      document.querySelector('.overlay')?.remove();
      state.composerOpen = false;
      return;
    }
    if (typing) {
      document.activeElement.blur();
      return;
    }
    if (state.route.name === 'run') go('#/');
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === '/') {
    event.preventDefault();
    dom.search.focus();
    dom.search.select();
    return;
  }
  if (event.key === 'c') {
    event.preventDefault();
    openComposer().catch((err) => {
      state.error = err.message;
      render();
    });
    return;
  }
  if (event.key === 'j' || event.key === 'k') {
    const runs = filteredRuns();
    if (runs.length === 0) return;
    event.preventDefault();
    const at = runs.findIndex((r) => r.id === state.selectedId);
    const next = event.key === 'j'
      ? Math.min(runs.length - 1, at < 0 ? 0 : at + 1)
      : Math.max(0, at <= 0 ? 0 : at - 1);
    state.selectedId = runs[next].id;
    if (state.route.name === 'runs') {
      render();
      dom.view.querySelector(`[data-id="${CSS.escape(state.selectedId)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  if (event.key === 'Enter' && state.route.name === 'runs' && state.selectedId) {
    event.preventDefault();
    openRun(state.selectedId);
  }
}

/* ------------------------------------------------------------------ boot */

function boot() {
  const search = dom.search;
  search.addEventListener('input', () => {
    state.query = search.value;
    if (state.route.name !== 'runs') {
      window.location.hash = '#/';
      return;
    }
    render();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && state.selectedId) openRun(state.selectedId);
  });

  dom.main.addEventListener('scroll', () => {
    const gap = dom.main.scrollHeight - dom.main.scrollTop - dom.main.clientHeight;
    pinnedToBottom = gap < 120;
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', onKeydown);

  // The bridge can come up or go down while the tab is open, so the status dot
  // is refreshed rather than read once at load.
  setInterval(() => {
    loadHealth().then(renderSidebar).catch(() => {});
  }, 30000);

  api.health()
    .then((h) => {
      state.health = h;
      renderSidebar();
    })
    .catch(() => {});

  route();
}

boot();
