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

import { api, subscribeToRun, streamChatMessage } from './api.js';
import {
  renderChatList,
  renderChatPage,
  renderChatMessage,
  renderNewChatDialog,
  renderRenameChatDialog
} from './chat.js';
import {
  el,
  clear,
  renderBlocks,
  renderBlock,
  renderRunList,
  renderPageHeader,
  renderDashboard,
  renderHealth,
  renderBudget,
  renderComposer,
  renderProjectPage,
  renderProjectDialog,
  renderRenameRunDialog,
  renderMoveRunDialog,
  renderBadgeRow,
  renderGithubPage,
  renderGitWork,
  renderSchedulesPage,
  renderRoutineDialog,
  renderWorkfolkPage,
  renderWorkfolkDispatchDialog,
  renderIcon,
  turnBudgetLine,
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
  dashboard: null,
  projects: [],
  projectsCorrupted: false,
  config: null,
  health: null,
  status: null,
  error: null,
  composerOpen: false,
  defaults: {},
  chats: [],
  chat: null,
  chatModels: null,
  github: null,
  githubSyncing: false,
  schedules: [],
  workfolkStatus: null,
  workfolkWorkers: [],
  workfolkJobs: []
};

/** One open stream per run, closed when the run ends or the view moves on. */
let unsubscribeStream = null;

/** The in-flight chat request's abort handle, so Stop can cancel it. */
let chatAbort = null;

const THEME_KEY = 'zstack:theme';
let currentThemeSetting = 'light';
try {
  currentThemeSetting = localStorage.getItem(THEME_KEY) || 'light';
} catch {}

function applyTheme(setting) {
  currentThemeSetting = setting;
  try {
    localStorage.setItem(THEME_KEY, setting);
  } catch {}
  const isDark =
    setting === 'dark' ||
    (setting === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = isDark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-setting', setting);
  document.documentElement.style.colorScheme = resolved;
  const fav = document.getElementById('favicon');
  if (fav) fav.href = isDark ? '/assets/zLogo_White.png' : '/assets/zLogo1.png';
  renderSidebar();
  renderTopbar();
}

if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentThemeSetting === 'system') {
      applyTheme('system');
    }
  });
}

const SIDEBAR_KEY = 'zstack:sidebar-collapsed';
let sidebarCollapsed = false;
try {
  sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === 'true';
} catch {}

function setSidebarCollapsed(collapsed) {
  sidebarCollapsed = collapsed;
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? 'true' : 'false');
  } catch {}
  const app = document.querySelector('.app');
  if (app) {
    app.classList.toggle('app--sidebar-collapsed', sidebarCollapsed);
  }
  document.documentElement.classList.remove('sidebar-collapsed-init');
  renderTopbar();
}

const dom = {
  app: document.querySelector('.app'),
  nav: document.getElementById('nav'),
  /** The scroll container. Never cleared, because the topbar lives inside it. */
  main: document.querySelector('.main'),
  /** The routed content region, replaced on every render. */
  view: document.getElementById('view'),
  topbar: document.getElementById('topbar'),
  search: document.getElementById('search'),
  footer: document.getElementById('footer'),
  workspace: document.getElementById('workspace-header'),
  quickNewRun: document.getElementById('btn-quick-new-run'),
  collapseSidebarBtn: document.getElementById('btn-collapse-sidebar')
};

/* ------------------------------------------------------------------ routing */

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [head, id, tail] = raw.split('/');
  // The root is the dashboard; the full list lives one level down at #/runs.
  // Old links and muscle memory still point at #/, and they land somewhere
  // useful rather than breaking.
  if (head === '') return { name: 'dashboard', id: null };
  if (head === 'runs' && !id) return { name: 'runs', id: null };
  if (head === 'runs' && id) return { name: 'run', id: decodeURIComponent(id) };
  if (head === 'projects' && id) return { name: 'project', id: decodeURIComponent(id) };
  if (head === 'health') return { name: 'health' };
  if (head === 'budget') return { name: 'budget' };
  if (head === 'chats') return { name: 'chats' };
  if (head === 'github') return { name: 'github' };
  if (head === 'schedules' || head === 'routines') return { name: 'schedules', id: null };
  if (head === 'workfolk' || head === 'workers') return { name: 'workfolk', id: null };
  if (head === 'chat' && id) return { name: 'chat', id: decodeURIComponent(id) };
  // An old `#/chat` link has no conversation to open, so it lands on the list.
  if (head === 'chat') return { name: 'chats' };
  return { name: 'dashboard', id: null };
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

async function loadConfig(force = false) {
  if (state.config && !force) return state.config;
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

async function loadDashboard() {
  const doc = await api.dashboard();
  state.dashboard = doc;
  return doc;
}

/**
 * The synced repo catalogue. Reads the store, never the GitHub API, so the
 * page is instant and offline; the sync button is what touches the network.
 */
async function loadGithub() {
  try {
    state.github = await api.github();
  } catch (err) {
    state.github = { configured: false, repos: [] };
    state.error = err.message;
  }
  return state.github;
}

async function loadSchedules() {
  try {
    const doc = await api.schedules();
    state.schedules = doc.schedules || [];
  } catch {
    state.schedules = [];
  }
  return state.schedules;
}

async function loadWorkfolk() {
  try {
    const [statusDoc, rosterDoc] = await Promise.all([
      api.workfolkStatus().catch((err) => ({ ok: false, error: err.message })),
      api.workfolkWorkers().catch(() => ({ ok: false, workers: [] }))
    ]);
    state.workfolkStatus = statusDoc;
    state.workfolkWorkers = rosterDoc.workers || [];
  } catch (err) {
    state.workfolkStatus = { ok: false, error: err.message };
    state.workfolkWorkers = [];
  }
  return { status: state.workfolkStatus, workers: state.workfolkWorkers };
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
      // The budget grows while the run goes: a run that runs out of turns is
      // extended rather than stopped. Taking it from each status event is what
      // keeps the page from showing the budget the run started with, which
      // reads as a contradiction once the turn count passes it.
      if (doc.turnBudget) state.page.turnBudget = doc.turnBudget;
      patchStatus();
    },
    open: (doc) => {
      // The stream's opening page is a snapshot taken when the run started. It
      // is authoritative about the blocks the deltas will be indexed against,
      // and about nothing else: the GET that got us here happened later, so it
      // knows about renames, moves, extensions, and everything else that
      // changed since. Adopting the snapshot wholesale therefore walks the page
      // backwards, which is how a finished run showed "0 of 1" turns while the
      // server was reporting "2 of 26, extended 1×".
      //
      // So only the body is taken from it, and the delta indexes stay aligned.
      if (doc.page && state.page && doc.page.id === state.page.id) {
        state.page.blocks = doc.page.blocks || [];
        state.page.live = doc.page.live;
        render();
      } else if (doc.page) {
        // No page loaded yet: this is a run opened straight from a stream, so
        // the snapshot is all there is.
        state.page = doc.page;
        render();
      }
    },
    end: () => {
      // A resumed run's transcript carries the end of the leg it paused at, so
      // an `end` frame is not proof the run is over. Closing the stream on it
      // dropped every turn that followed. The stream is done when the run is
      // no longer live; the server closes the connection then anyway.
      if (state.page && state.page.live !== true) closeStream();
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

/** Labels for a property the stream adds that the page did not carry. */
const PROP_LABELS = {
  turns: 'Turns',
  turnBudget: 'Turn budget',
  toolCalls: 'Tool calls',
  failedTools: 'Failed calls',
  declinedTools: 'Declined calls'
};

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
  // The same builder the header uses, so a chip cannot exist in one and not the
  // other. The nulls are skipped here because `append(null)` writes the literal
  // text "null": `el` filters them, a bare loop does not.
  for (const node of renderBadgeRow(state.page, {
    onOpenProject: (id) => go(`#/projects/${encodeURIComponent(id)}`)
  })) {
    if (node) holder.append(node);
  }
  // The stop button belongs to a run that is still going.
  const stop = dom.view.querySelector('[data-stop-run]');
  if (stop && state.page.status !== 'running' && state.page.status !== 'starting') stop.remove();

  // The budget and turn count are patched too: the property list is projected
  // once when the page loads, so without this a run on turn 12 still reads
  // "0 of 25" and the number is actively misleading rather than merely stale.
  const turns = state.page.counts?.turns;
  // Writes through to `props` as well as the DOM. The DOM patch is what the
  // reader sees between events, but a full re-render rebuilds the property list
  // from `props`, so patching only the DOM reverts the row the next time
  // anything calls render() — which is exactly what happens when the run ends.
  const setProp = (key, value) => {
    if (value === null || value === undefined) return;
    const text = String(value);
    const row = dom.view.querySelector(`.props__row[data-key="${key}"] .props__val`);
    if (row) row.textContent = text;
    const entries = state.page.props;
    if (!Array.isArray(entries)) return;
    const entry = entries.find((p) => p.key === key);
    if (entry) entry.value = text;
    else entries.push({ key, label: PROP_LABELS[key] || key, value: text });
  };
  setProp('turns', turns);
  setProp('turnBudget', turnBudgetLine(state.page));
  setProp('toolCalls', state.page.counts?.toolCalls);
  setProp('failedTools', state.page.counts?.failedTools);
  setProp('declinedTools', state.page.counts?.declinedTools);
}

/* ------------------------------------------------------------------- views */

const COLLAPSED_KEY = 'zstack_sidebar_collapsed';

function getCollapsedSections() {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : { runs: false, projects: false, chats: false, system: false };
  } catch {
    return { runs: false, projects: false, chats: false, system: false };
  }
}

function setSectionCollapsed(key, collapsed) {
  const current = getCollapsedSections();
  current[key] = collapsed;
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(current));
  } catch {}
}

function renderSidebar() {
  const nav = clear(dom.nav);
  const runs = state.runList;
  const counts = {
    all: runs.length,
    agent: runs.filter((r) => r.badge === 'agent').length,
    task: runs.filter((r) => r.badge === 'task').length,
    panel: runs.filter((r) => r.badge === 'panel').length
  };
  const collapsed = getCollapsedSections();

  const navItem = ({ icon: iconName, label, count = null, active = false, muted = false, onClick, extra = null }) =>
    el('button', {
      class: `nav__item${active ? ' nav__item--active' : ''}${muted ? ' nav__item--muted' : ''}`,
      type: 'button',
      onClick
    }, [
      iconName ? renderIcon(iconName) : null,
      el('span', { class: 'nav__label-text', text: label }),
      extra,
      count === null || count === undefined ? null : el('span', { class: 'nav__count', text: String(count) })
    ]);

  const section = ({ key, title, count = null, onAction = null, actionTitle = '', children = [] }) => {
    const isCollapsed = !!collapsed[key];
    const header = el('div', { class: 'nav__section-header' }, [
      el('button', {
        class: 'nav__section-toggle',
        type: 'button',
        title: isCollapsed ? `Expand ${title}` : `Collapse ${title}`,
        onClick: (e) => {
          e.stopPropagation();
          setSectionCollapsed(key, !isCollapsed);
          renderSidebar();
        }
      }, [
        renderIcon('chevron', `nav__chevron${isCollapsed ? ' nav__chevron--collapsed' : ''}`),
        el('span', { class: 'nav__section-title-text', text: title }),
        isCollapsed && count !== null && count !== undefined
          ? el('span', { class: 'nav__section-count', text: `(${count})` })
          : null
      ]),
      onAction ? el('button', {
        class: 'nav__section-action',
        type: 'button',
        title: actionTitle,
        onClick: (e) => {
          e.stopPropagation();
          onAction();
        }
      }, [renderIcon('plus', 'nav__action-icon')]) : null
    ]);

    const itemsContainer = el('div', {
      class: `nav__section-items${isCollapsed ? ' nav__section-items--hidden' : ''}`
    }, children);

    return el('div', { class: 'nav__section', dataset: { section: key } }, [
      header,
      itemsContainer
    ]);
  };

  // 1. Top Primary Nav Links
  nav.append(navItem({
    icon: 'dashboard',
    label: 'Dashboard',
    active: state.route.name === 'dashboard',
    onClick: () => go('#/')
  }));

  nav.append(navItem({
    icon: 'runs',
    label: 'All runs',
    count: counts.all,
    active: state.route.name === 'runs' && !state.query,
    onClick: () => {
      state.query = '';
      dom.search.value = '';
      go('#/runs');
    }
  }));

  nav.append(navItem({
    icon: 'chat',
    label: 'Chats',
    count: state.chats.length || null,
    active: state.route.name === 'chats',
    onClick: () => go('#/chats')
  }));

  nav.append(navItem({
    icon: 'clock',
    label: 'Routines',
    count: state.schedules.filter((s) => s.enabled).length || null,
    active: state.route.name === 'schedules',
    onClick: () => go('#/schedules')
  }));

  nav.append(navItem({
    icon: 'workfolk',
    label: 'Workfolk',
    count: state.workfolkWorkers.length || null,
    active: state.route.name === 'workfolk',
    onClick: () => go('#/workfolk')
  }));

  // 2. Section: RUNS
  nav.append(section({
    key: 'runs',
    title: 'Runs',
    count: counts.all,
    children: [
      navItem({
        icon: 'agent',
        label: 'Agent runs',
        count: counts.agent,
        active: state.route.name === 'runs' && state.query === 'agent',
        onClick: () => {
          state.query = 'agent';
          dom.search.value = 'agent';
          go('#/runs');
        }
      }),
      navItem({
        icon: 'task',
        label: 'Task runs',
        count: counts.task,
        active: state.route.name === 'runs' && state.query === 'task',
        onClick: () => {
          state.query = 'task';
          dom.search.value = 'task';
          go('#/runs');
        }
      }),
      navItem({
        icon: 'check',
        label: 'Completed',
        active: false,
        onClick: () => {
          state.query = '';
          dom.search.value = '';
          state.selectedId = null;
          go('#/runs');
        }
      })
    ]
  }));

  // 3. Section: PROJECTS
  const projectItems = [];
  for (const project of state.projects) {
    projectItems.push(navItem({
      icon: 'folder',
      label: project.name,
      active: state.route.name === 'project' && state.route.id === project.id,
      onClick: () => go(`#/projects/${encodeURIComponent(project.id)}`)
    }));
  }
  if (state.projects.length === 0) {
    projectItems.push(el('div', { class: 'nav__empty', text: 'No projects yet' }));
  }
  projectItems.push(navItem({
    icon: 'plus',
    label: state.projects.length === 0 ? 'New project' : 'Add project',
    muted: true,
    onClick: () => openProjectDialog()
  }));

  nav.append(section({
    key: 'projects',
    title: 'Projects',
    count: state.projects.length,
    onAction: () => openProjectDialog(),
    actionTitle: 'New project',
    children: projectItems
  }));

  // 4. Section: CHATS
  const chatItems = [];
  const recentChats = state.chats.slice(0, 10);
  for (const chat of recentChats) {
    chatItems.push(navItem({
      icon: 'chat',
      label: chat.title || 'New chat',
      active: state.route.name === 'chat' && state.route.id === chat.id,
      onClick: () => go(`#/chat/${encodeURIComponent(chat.id)}`)
    }));
  }
  if (state.chats.length === 0) {
    chatItems.push(el('div', { class: 'nav__empty', text: 'No chats yet' }));
  }
  chatItems.push(navItem({
    icon: 'plus',
    label: state.chats.length === 0 ? 'New chat' : 'Add chat',
    muted: true,
    onClick: () => openNewChatDialog()
  }));

  nav.append(section({
    key: 'chats',
    title: 'Chats',
    count: state.chats.length,
    onAction: () => openNewChatDialog(),
    actionTitle: 'New chat',
    children: chatItems
  }));

  // 5. Section: SYSTEM
  const bridge = state.health?.bridge;
  const bridgeDot = el('span', {
    class: `dot ${bridge ? (bridge.ok ? 'dot--ok' : 'dot--error') : ''}`
  });

  nav.append(section({
    key: 'system',
    title: 'System',
    children: [
      navItem({
        icon: 'health',
        label: 'Health',
        extra: bridgeDot,
        active: state.route.name === 'health',
        onClick: () => go('#/health')
      }),
      navItem({
        icon: 'budget',
        label: 'Model routing',
        active: state.route.name === 'budget',
        onClick: () => go('#/budget')
      }),
      navItem({
        icon: 'github',
        label: 'GitHub repos',
        count: state.github?.repos?.length || null,
        active: state.route.name === 'github',
        onClick: () => go('#/github')
      })
    ]
  }));

  // Footer: Notion-style status, version, and 3-way theme toggle
  const foot = clear(dom.footer);
  const statusRow = el('div', { class: 'sidebar__status-row' }, [
    el('div', { class: 'sidebar__status' }, [
      el('span', { class: `dot ${bridge ? (bridge.ok ? 'dot--ok' : 'dot--error') : ''}` }),
      el('span', {
        class: 'sidebar__status-text',
        text: bridge ? (bridge.ok ? (bridge.mode ? `${bridge.mode}` : 'ModelHitch online') : 'bridge offline') : 'connecting...'
      })
    ]),
    el('span', { class: 'sidebar__version', text: 'v0.1.0' })
  ]);

  const themeToggle = el('div', { class: 'theme-toggle', role: 'radiogroup', ariaLabel: 'Color theme' }, [
    el('button', {
      class: `theme-toggle__btn${currentThemeSetting === 'light' ? ' theme-toggle__btn--active' : ''}`,
      type: 'button',
      title: 'Light theme (main)',
      onClick: () => applyTheme('light')
    }, [renderIcon('sun', 'theme-toggle__icon'), el('span', { class: 'theme-toggle__label', text: 'Light' })]),
    el('button', {
      class: `theme-toggle__btn${currentThemeSetting === 'dark' ? ' theme-toggle__btn--active' : ''}`,
      type: 'button',
      title: 'Dark theme (dark gray)',
      onClick: () => applyTheme('dark')
    }, [renderIcon('moon', 'theme-toggle__icon'), el('span', { class: 'theme-toggle__label', text: 'Dark' })]),
    el('button', {
      class: `theme-toggle__btn${currentThemeSetting === 'system' ? ' theme-toggle__btn--active' : ''}`,
      type: 'button',
      title: 'Match system preference',
      onClick: () => applyTheme('system')
    }, [renderIcon('monitor', 'theme-toggle__icon'), el('span', { class: 'theme-toggle__label', text: 'Auto' })])
  ]);

  foot.append(statusRow, themeToggle);
}

function crumbItem(label, icon, onClick) {
  if (onClick) {
    return el('button', { class: 'crumb crumb--link', type: 'button', onClick }, [
      icon ? renderIcon(icon, 'crumb__icon') : null,
      el('span', { class: 'crumb__label', text: label })
    ]);
  }
  return el('div', { class: 'crumb crumb--current' }, [
    icon ? renderIcon(icon, 'crumb__icon') : null,
    el('strong', { class: 'crumb__label', text: label })
  ]);
}

function crumbSep() {
  return el('span', { class: 'crumb__sep', text: '/' });
}

function renderTopbar() {
  const bar = clear(dom.topbar);

  // 1. Sidebar toggle button at far left
  const sidebarBtn = el('button', {
    class: 'topbar__icon-btn',
    type: 'button',
    title: sidebarCollapsed ? 'Expand sidebar (Ctrl+\\)' : 'Collapse sidebar (Ctrl+\\)',
    ariaLabel: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
    onClick: () => setSidebarCollapsed(!sidebarCollapsed)
  }, [renderIcon('sidebar', 'topbar__icon')]);
  bar.append(sidebarBtn);

  // 2. Breadcrumbs
  const crumbs = el('div', { class: 'crumbs' });

  if (state.route.name === 'run' && state.page) {
    crumbs.append(
      crumbItem('Dashboard', 'dashboard', () => go('#/')),
      crumbSep()
    );
    if (state.page.projectName && state.page.projectId) {
      crumbs.append(
        crumbItem(String(state.page.projectName), 'folder', () => go(`#/projects/${encodeURIComponent(state.page.projectId)}`)),
        crumbSep()
      );
    } else {
      crumbs.append(
        crumbItem('All runs', 'runs', () => go('#/runs')),
        crumbSep()
      );
    }
    crumbs.append(crumbItem(state.page.title, 'runs'));
  } else if (state.route.name === 'project' && state.projectPage) {
    crumbs.append(
      crumbItem('Dashboard', 'dashboard', () => go('#/')),
      crumbSep(),
      crumbItem(state.projectPage.name, 'folder')
    );
  } else if (state.route.name === 'runs') {
    crumbs.append(
      crumbItem('Dashboard', 'dashboard', () => go('#/')),
      crumbSep(),
      crumbItem('All runs', 'runs')
    );
  } else if (state.route.name === 'chats') {
    crumbs.append(
      crumbItem('Dashboard', 'dashboard', () => go('#/')),
      crumbSep(),
      crumbItem('Chats', 'chat')
    );
  } else if (state.route.name === 'chat' && state.chat) {
    crumbs.append(
      crumbItem('Chats', 'chat', () => go('#/chats')),
      crumbSep(),
      crumbItem(state.chat.title || 'Chat', 'chat')
    );
  } else if (state.route.name === 'health') {
    crumbs.append(
      crumbItem('Dashboard', 'dashboard', () => go('#/')),
      crumbSep(),
      crumbItem('Health', 'health')
    );
  } else if (state.route.name === 'budget') {
    crumbs.append(
      crumbItem('Dashboard', 'dashboard', () => go('#/')),
      crumbSep(),
      crumbItem('Model routing', 'budget')
    );
  } else if (state.route.name === 'github') {
    crumbs.append(
      crumbItem('Dashboard', 'dashboard', () => go('#/')),
      crumbSep(),
      crumbItem('GitHub repos', 'github')
    );
  } else {
    crumbs.append(crumbItem('Dashboard', 'dashboard'));
  }

  bar.append(crumbs);

  // 3. Right side controls
  bar.append(el('div', { class: 'spacer' }));

  const themeIcon = currentThemeSetting === 'dark' ? 'moon' : currentThemeSetting === 'system' ? 'monitor' : 'sun';
  const nextTheme = currentThemeSetting === 'light' ? 'dark' : currentThemeSetting === 'dark' ? 'system' : 'light';
  const themeLabel = currentThemeSetting === 'light' ? 'Light' : currentThemeSetting === 'dark' ? 'Dark' : 'System';
  const themeBtn = el('button', {
    class: 'topbar__icon-btn topbar__theme-btn',
    type: 'button',
    title: `Theme: ${themeLabel} (click to switch to ${nextTheme})`,
    ariaLabel: `Theme: ${themeLabel}`,
    onClick: () => applyTheme(nextTheme)
  }, [renderIcon(themeIcon, 'topbar__icon')]);
  bar.append(themeBtn);

  bar.append(el('span', { class: 'hint' }, [
    el('span', { class: 'kbd', text: 'c' }),
    ' new run'
  ]));
  bar.append(el('button', {
    class: 'btn btn--primary topbar__btn',
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
    main.append(el('div', { class: 'page page--wide' }, [
      el('header', { class: 'page__header' }, [
        el('div', { class: 'page__icon-box' }, [renderIcon('health', 'page__header-icon')]),
        el('div', { class: 'page__badge' }, [el('span', { class: 'chip chip--neutral', text: 'system' })]),
        el('h1', { class: 'page__title', text: 'Health' }),
        el('div', { class: 'page__meta', text: 'ModelHitch gateway connection, history file status, and role mappings.' })
      ]),
      renderHealth(state.health, state.status)
    ]));
    return;
  }
  if (state.route.name === 'budget') {
    main.append(el('div', { class: 'page page--wide' }, [
      el('header', { class: 'page__header' }, [
        el('div', { class: 'page__icon-box' }, [renderIcon('budget', 'page__header-icon')]),
        el('div', { class: 'page__badge' }, [el('span', { class: 'chip chip--neutral', text: 'system' })]),
        el('h1', { class: 'page__title', text: 'Model routing' }),
        el('div', { class: 'page__meta', text: 'Configure budget tiers, model source, and provider lanes.' })
      ]),
      renderBudget(state.config, state.status, {
        onApply: async (payload) => {
          const res = await api.setBudget(payload);
          if (res?.budget) {
            if (!state.config) state.config = {};
            state.config.budget = res.budget;
            try {
              localStorage.setItem('zstack:budget', JSON.stringify(res.budget));
            } catch {}
          }
          await Promise.all([loadConfig(true), loadStatus()]);
          render();
          return res;
        }
      })
    ]));
    return;
  }
  if (state.route.name === 'github') {
    if (!state.github) {
      main.append(el('div', { class: 'loading', text: 'Loading repos...' }));
      return;
    }
    main.append(renderGithubPage({
      github: state.github,
      syncing: state.githubSyncing,
      onSync: syncGithub,
      onSetPath: setRepoPath,
      onGitAction: (payload) => api.repoGit(payload)
    }));
    return;
  }
  if (state.route.name === 'chats') {
    main.append(renderChatList({
      chats: state.chats,
      onOpen: openChat,
      onNew: openNewChatDialog
    }));
    return;
  }
  if (state.route.name === 'chat') {
    if (!state.chat) {
      main.append(el('div', { class: 'loading', text: 'Opening chat...' }));
      return;
    }
    main.append(renderChatPage(state.chat, state.chatModels || {}, {
      onSend: sendChatMessage,
      onStop: stopChat,
      onPin: pinChatModel,
      onRename: () => renameChatFlow(state.chat),
      onDelete: () => deleteChatFlow(state.chat),
      onContinueAsRun: (message, chat) => continueChatAsRun(message, chat),
      onScheduleRoutine: (message, chat) => openRoutineDialog({
        prompt: message?.content || '',
        projectId: chat?.projectId || undefined
      }),
      onHandoffToWorkfolk: (message) => {
        const defaultWorker = state.workfolkWorkers[0] || { tag: 'coordinator', name: 'Coordinator' };
        openWorkfolkDispatch(defaultWorker, message?.content || '');
      }
    }));
    return;
  }
  if (state.route.name === 'schedules') {
    main.append(renderSchedulesPage({
      schedules: state.schedules,
      projects: state.projects,
      onNew: () => openRoutineDialog(),
      onToggle: async (id, enabled) => {
        try {
          await api.updateSchedule(id, { enabled });
          await loadSchedules();
          render();
        } catch (err) {
          state.error = err.message;
          render();
        }
      },
      onRun: async (id) => {
        try {
          await api.runSchedule(id);
          await loadSchedules();
          await loadRuns().catch(() => {});
          render();
        } catch (err) {
          state.error = err.message;
          render();
        }
      },
      onDelete: async (id) => {
        if (!window.confirm('Delete this routine?')) return;
        try {
          await api.deleteSchedule(id);
          await loadSchedules();
          render();
        } catch (err) {
          state.error = err.message;
          render();
        }
      }
    }));
    return;
  }
  if (state.route.name === 'workfolk') {
    main.append(renderWorkfolkPage({
      status: state.workfolkStatus || {},
      workers: state.workfolkWorkers || [],
      jobs: state.workfolkJobs || [],
      onDispatch: (worker) => openWorkfolkDispatch(worker),
      onRefresh: async () => {
        await loadWorkfolk();
        render();
      }
    }));
    return;
  }
  if (state.route.name === 'run' && state.page) {
    const page = el('div', { class: 'page' });
    const [head, props] = renderPageHeader(state.page, {
      onCancel: () => stopRun(state.page.id),
      onOpenProject: (id) => go(`#/projects/${encodeURIComponent(id)}`),
      onRename: () => openRenameRunDialog(state.page),
      onMove: () => openMoveRunDialog(state.page),
      onDelete: () => deleteRunFlow(state.page),
      onContinue: () => continueRunFlow(state.page),
      onPause: () => pauseRun(state.page.id),
      onResume: () => resumeRun(state.page.id)
    });
    head.querySelector('button')?.setAttribute('data-stop-run', '');
    page.append(head, props);
    if (state.page.workspace) {
      const runId = state.page.id;
      page.append(el('section', { class: 'panel' }, [
        el('div', { class: 'panel__title', text: 'Workspace Git' }),
        renderGitWork({ onAction: (payload) => api.runGit(runId, payload) })
      ]));
    }
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
  if (state.route.name === 'dashboard' && state.dashboard) {
    main.append(renderDashboard(state.dashboard, {
      bridge: state.health?.bridge || null,
      onOpenRun: openRun,
      onOpenProject: (id) => go(`#/projects/${encodeURIComponent(id)}`),
      onOpenRuns: () => go('#/runs'),
      onNewRun: () => openComposer(),
      onNewProject: () => openProjectDialog()
    }));
    return;
  }
  if (state.route.name === 'dashboard') {
    main.append(el('div', { class: 'loading', text: 'Loading dashboard...' }));
    return;
  }
  main.append(el('div', { class: 'page page--wide' }, [
    el('header', { class: 'page__header' }, [
      el('div', { class: 'page__icon-box' }, [renderIcon('runs', 'page__header-icon')]),
      el('div', { class: 'page__badge' }, [el('span', { class: 'chip chip--neutral', text: 'workspace' })]),
      el('h1', { class: 'page__title', text: state.query ? 'Search runs' : 'All runs' }),
      el('div', { class: 'page__meta', text: state.query ? `Showing runs matching "${state.query}"` : 'Every run recorded on this machine, running or finished.' })
    ]),
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

/** Ask a run to pause. The server accepts the request; the run honours it at
 * the end of the turn in flight, so the page says "pausing" until it does. */
async function pauseRun(id) {
  try {
    await api.pause(id);
    if (state.page && state.page.id === id) {
      state.page.pausing = true;
      state.page.status = 'pausing';
      patchStatus();
    }
    // The run honours the request at its next turn boundary, which may be after
    // the stream has already closed. Re-reading the page is what makes the
    // Paused state appear even then, rather than leaving the reader looking at
    // "pausing" forever.
    setTimeout(() => {
      if (!state.page || state.page.id !== id) return;
      api.run(id).then((doc) => {
        if (doc.page) {
          state.page = doc.page;
          render();
        }
      }).catch(() => {});
    }, 2500);
  } catch (err) {
    state.error = err.message;
    render();
  }
}

/** Continue a paused run. It is the same run, so the page stays where it is and
 * the stream picks up the turns that follow. */
async function resumeRun(id) {
  try {
    await api.resume(id);
    // The page is re-read rather than taken from the response, exactly as
    // navigation does it. The response carries the registry's own projection,
    // which has no idea what this client already knows — notably whether the
    // run can be resumed in place — so rendering from it showed a running run
    // as still paused, offering to continue a run that was already going.
    await api.run(id).then((doc) => {
      if (doc.page) state.page = doc.page;
    });
    render();
    // Re-subscribe: the paused run's stream had ended, and the deltas for the
    // turns that follow arrive on a new one.
    watchRun(id);
    await loadRuns().catch(() => {});
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function openComposer(preset = {}) {
  const [config] = await Promise.all([
    loadConfig(),
    loadProjects().catch(() => {}),
    loadGithub().catch(() => {})
  ]);
  const overlay = renderComposer({
    config,
    health: state.health,
    projects: state.projects,
    repos: state.github?.repos || [],
    presetProjectId: preset.projectId || preset.project?.id || null,
    defaults: {
      workspaceDir: preset.workspaceDir || state.defaults.workspaceDir || '',
      prompt: preset.prompt || '',
      lane: preset.lane || '',
      maxTurns: preset.maxTurns || null
    },
    autoOptimize: preset.autoOptimize === true,
    deletedProjectNote: preset.deletedProjectNote || null,
    truncatedNote: preset.truncatedNote || null,
    onOptimize: (payload) => api.optimizePrompt(payload),
    onClassify: (payload) => api.classifyPrompt ? api.classifyPrompt(payload) : null,
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

/** Open the run composer pre-filled with a chat message and pre-selected defaults. */
async function continueChatAsRun(message, chat) {
  if (!message || !message.content || !message.content.trim()) {
    state.error = 'No message content to continue as run.';
    render();
    return;
  }
  const rawText = message.content.trim();
  const maxPrompt = 8000;
  const isTruncated = rawText.length > maxPrompt;
  const promptText = isTruncated ? rawText.slice(0, maxPrompt) : rawText;

  await Promise.all([
    loadConfig().catch(() => {}),
    loadProjects().catch(() => {})
  ]);

  let selectedProjectId = null;
  let deletedProjectNote = null;
  if (chat?.projectId) {
    const projectExists = (state.projects || []).some((p) => p.id === chat.projectId);
    if (projectExists) {
      selectedProjectId = chat.projectId;
    } else {
      deletedProjectNote = 'The project this chat started with has been deleted; continuing with no project.';
    }
  }

  // A chat pins only a model, not a lane, so the lane is inferred from the
  // model's provider prefix. `huggingface/` ids carry a second slash; a prefix
  // test is unaffected by that.
  let inferredLane = '';
  if (chat?.lane) {
    inferredLane = chat.lane;
  } else if (chat?.model?.startsWith('opencode-go/')) {
    inferredLane = 'go';
  } else if (chat?.model?.startsWith('opencode/')) {
    inferredLane = 'zen';
  } else if (chat?.model?.startsWith('huggingface/')) {
    inferredLane = 'hf';
  }

  let targetTurns = null;
  if (selectedProjectId) {
    const chosenProj = (state.projects || []).find((p) => p.id === selectedProjectId);
    if (chosenProj?.defaultMaxTurns) targetTurns = chosenProj.defaultMaxTurns;
  }
  if (!targetTurns) {
    targetTurns = state.config?.defaultMaxTurns || 25;
  }

  await openComposer({
    prompt: promptText,
    projectId: selectedProjectId,
    lane: inferredLane,
    maxTurns: targetTurns,
    autoOptimize: true,
    deletedProjectNote,
    truncatedNote: isTruncated ? 'The message was truncated to 8,000 characters (composer limit).' : null
  });
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
    turnPresets: state.config?.turnPresets || [],
    defaultMaxTurns: state.config?.defaultMaxTurns || null,
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
/** Continue a run that ran out of turns, then follow the new one.
 *
 * The continuation is a new run, so the page navigates to it: the reader ends
 * up watching the work resume rather than staring at the run that stopped. */
async function continueRunFlow(page) {
  try {
    const doc = await api.continueRun(page.id, {});
    await loadRuns().catch(() => {});
    go(`#/runs/${encodeURIComponent(doc.id)}`);
  } catch (err) {
    state.error = err.message;
    render();
  }
}

/* ------------------------------------------------------------------- chat */

/** The conversation list, for the sidebar and the list page. */
async function loadChats() {
  try {
    const doc = await api.chats();
    state.chats = doc.chats || [];
  } catch {
    state.chats = [];
  }
  return state.chats;
}

/**
 * The catalogue for the pin picker.
 *
 * Re-read on every visit rather than cached: providers and free models come and
 * go, and a picker frozen at first load would hide a model that is now
 * available. One loopback call per navigation is the whole cost.
 */
async function loadChatModels() {
  try {
    state.chatModels = await api.models();
  } catch (err) {
    state.chatModels = { connected: false, error: err.message, models: [] };
  }
  return state.chatModels;
}

/** One conversation by id. A missing one clears the page rather than hanging. */
async function loadChat(id) {
  try {
    const doc = await api.getChat(id);
    state.chat = { ...doc.chat, pending: false };
  } catch (err) {
    state.chat = null;
    state.error = err.message;
  }
  return state.chat;
}

function openChat(id) {
  go(`#/chat/${encodeURIComponent(id)}`);
}

function scrollChatToBottom() {
  if (state.route.name !== 'chat') return;
  dom.main.scrollTop = dom.main.scrollHeight;
}

/** Replace one message in place, keeping scroll and the rest of the log. */
function patchChatMessage(index) {
  const host = dom.view.querySelector('.chat__log');
  const chat = state.chat;
  if (!host || !chat || !Array.isArray(chat.messages)) {
    render();
    return;
  }
  const node = renderChatMessage(chat.messages[index]);
  const existing = host.children[index];
  if (existing) host.replaceChild(node, existing);
  else host.append(node);
}

/** Start a conversation with a model the reader pins up front. */
async function openNewChatDialog() {
  await Promise.all([
    loadChatModels().catch(() => {}),
    loadProjects().catch(() => {})
  ]);
  const overlay = renderNewChatDialog({
    models: state.chatModels?.models || [],
    projects: state.projects || [],
    listing: state.chatModels || {},
    onClose: () => overlay.remove(),
    onSubmit: async (payload) => {
      const doc = await api.createChat(payload);
      overlay.remove();
      await loadChats();
      go(`#/chat/${encodeURIComponent(doc.id)}`);
    }
  });
  document.body.append(overlay);
}

/** Open dialog to schedule an unattended routine. */
async function openRoutineDialog(initial = {}) {
  await Promise.all([
    loadProjects().catch(() => {}),
    // The lane list comes from the server, so a new lane appears in this dialog
    // without a client edit. A failed load leaves it empty and the dialog falls
    // back to its own list rather than blocking the routine.
    loadConfig().catch(() => {})
  ]);
  const overlay = renderRoutineDialog({
    initial,
    projects: state.projects || [],
    lanes: state.config?.lanes || [],
    onClose: () => overlay.remove(),
    onInfer: async (text) => {
      try {
        return await api.inferSchedule({ prompt: text });
      } catch {
        return null;
      }
    },
    onSubmit: async (payload) => {
      await api.createSchedule(payload);
      overlay.remove();
      await loadSchedules();
      go('#/schedules');
    }
  });
  document.body.append(overlay);
}

function openWorkfolkDispatch(worker, initialTask = '') {
  const overlay = renderWorkfolkDispatchDialog({
    worker,
    initialTask,
    onClose: () => overlay.remove(),
    onSubmit: async ({ worker_tag, task, wait }) => {
      const result = await api.workfolkDispatch({ worker_tag, task, wait });
      state.workfolkJobs.unshift({
        job_id: result.job_id,
        worker_tag: worker_tag.replace(/^@/, ''),
        task,
        status: result.status,
        result: result.result || null
      });
      render();
    }
  });
  document.body.append(overlay);
}

/**
 * Send one turn and stream the reply.
 *
 * The user message and an empty assistant message enter the transcript
 * immediately, so the turn shows the moment it is sent. Deltas append to that
 * assistant message in place; the server's `done` carries the stored message,
 * which is the same content plus its token and duration. A generation counter
 * stops a reply for a stopped or replaced turn from landing in a transcript it
 * no longer belongs to.
 */
async function sendChatMessage(text) {
  const chat = state.chat;
  if (!chat || chat.pending || !chat.model) return;
  const generation = (chat.generation = (chat.generation || 0) + 1);

  const now = new Date().toISOString();
  chat.messages.push({ id: null, role: 'user', content: text, at: now });
  chat.messages.push({ id: null, role: 'assistant', content: '', at: now, streaming: true });
  const assistantIndex = chat.messages.length - 1;
  chat.pending = true;
  render();
  scrollChatToBottom();

  chatAbort = new AbortController();
  const live = () => chat.generation === generation;
  try {
    await streamChatMessage(chat.id, text, {
      signal: chatAbort.signal,
      onStart: (data) => {
        if (!live()) return;
        // The server assigned real ids and persisted the user message; adopt
        // them so a later reload and the live page describe the same turns.
        if (data?.userMessage) chat.messages[assistantIndex - 1] = data.userMessage;
        if (data?.assistant) chat.messages[assistantIndex] = { ...data.assistant, content: '', streaming: true };
        patchChatMessage(assistantIndex - 1);
        patchChatMessage(assistantIndex);
      },
      onDelta: (chunk) => {
        if (!live()) return;
        const message = chat.messages[assistantIndex];
        if (!message) return;
        message.content += chunk;
        patchChatMessage(assistantIndex);
        scrollChatToBottom();
      },
      onDone: (data) => {
        if (!live()) return;
        if (data?.message) chat.messages[assistantIndex] = data.message;
      },
      onError: (data) => {
        if (!live()) return;
        const message = chat.messages[assistantIndex];
        if (message) {
          message.streaming = false;
          message.error = data?.error || 'The turn failed.';
        }
      }
    });
  } catch (err) {
    if (live()) {
      const message = chat.messages[assistantIndex];
      if (message) {
        message.streaming = false;
        message.error = err?.name === 'AbortError' ? 'Stopped.' : (err?.message || String(err));
      }
    }
  } finally {
    if (live()) {
      chat.pending = false;
      await loadChats().catch(() => {});
      // Re-read the conversation so the stored ids, title, and counts are exact
      // rather than the optimistic ones built while streaming.
      if (state.route.name === 'chat' && state.route.id === chat.id) {
        await loadChat(chat.id).catch(() => {});
        render();
        scrollChatToBottom();
      }
    }
    chatAbort = null;
  }
}

function stopChat() {
  chatAbort?.abort();
}

/** Re-pin the conversation's model. Applies to the next turn. */
async function pinChatModel(model) {
  const chat = state.chat;
  if (!chat || !model || model === chat.model) return;
  const previous = chat.model;
  chat.model = model;
  render();
  try {
    await api.updateChat(chat.id, { model });
    await loadChats().catch(() => {});
  } catch (err) {
    chat.model = previous;
    state.error = err.message;
    render();
  }
}

function renameChatFlow(chat) {
  if (!chat || chat.pending) return;
  const overlay = renderRenameChatDialog({
    chat,
    onClose: () => overlay.remove(),
    onSubmit: async (payload) => {
      const doc = await api.updateChat(chat.id, payload);
      overlay.remove();
      state.chat = { ...doc.chat, pending: false };
      await loadChats().catch(() => {});
      render();
    }
  });
  document.body.append(overlay);
}

async function deleteChatFlow(chat) {
  if (!chat) return;
  if (chat.pending) {
    state.error = 'Stop the turn in flight before deleting this chat.';
    render();
    return;
  }
  if (!window.confirm(`Delete chat "${chat.title || 'New chat'}"? The conversation is removed for good.`)) return;
  try {
    await api.deleteChat(chat.id);
    await loadChats().catch(() => {});
    state.chat = null;
    go('#/chats');
  } catch (err) {
    state.error = err.message;
    render();
  }
}

/* --------------------------------------------------------------- github */

/**
 * Sync the repo catalogue. Manual by design: the button is the only thing
 * that touches the GitHub API, so nothing polls and nothing runs traffic
 * the reader did not ask for.
 */
async function syncGithub() {
  if (state.githubSyncing) return;
  state.githubSyncing = true;
  render();
  try {
    state.github = await api.syncGithub();
    // A sync may have created projects, so the sidebar picks them up now
    // rather than on the next navigation.
    await loadProjects().catch(() => {});
  } catch (err) {
    state.error = err.message;
  } finally {
    state.githubSyncing = false;
    render();
  }
}

/** Point one synced repo at a different local clone. */
async function setRepoPath(payload) {
  const doc = await api.setRepoPath(payload);
  if (doc.repo && state.github) {
    const repos = state.github.repos || [];
    const at = repos.findIndex((r) => r.fullName === doc.repo.fullName);
    if (at >= 0) repos[at] = doc.repo;
    render();
  }
  await loadProjects().catch(() => {});
  render();
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
    if (state.route.name === 'github') {
      await Promise.all([loadGithub(), loadProjects().catch(() => {})]);
      render();
      return;
    }
    if (state.route.name === 'budget') {
      await Promise.all([loadConfig(true), loadStatus()]);
      render();
      return;
    }
    if (state.route.name === 'chats') {
      await Promise.all([loadChats(), loadChatModels()]);
      render();
      return;
    }
    if (state.route.name === 'schedules') {
      await Promise.all([loadSchedules(), loadProjects().catch(() => {})]);
      render();
      return;
    }
    if (state.route.name === 'workfolk') {
      await loadWorkfolk();
      render();
      return;
    }
    if (state.route.name === 'chat') {
      await Promise.all([loadChat(state.route.id), loadChatModels()]);
      render();
      scrollChatToBottom();
      return;
    }
    if (state.route.name === 'dashboard') {
      // The dashboard is one endpoint, but the sidebar counts and the bridge
      // dot still need their own reads.
      try {
        await Promise.all([
          loadDashboard(),
          loadSchedules().catch(() => {}),
          loadWorkfolk().catch(() => {}),
          state.runList.length === 0 ? loadRuns().catch(() => {}) : null,
          loadProjects().catch(() => {}),
          loadHealth().catch(() => {})
        ]);
      } catch (err) {
        state.error = err.message;
        state.dashboard = null;
      }
      render();
      return;
    }
    await loadRuns();
    await loadProjects().catch(() => {});
    await loadSchedules().catch(() => {});
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
  if ((event.ctrlKey || event.metaKey) && event.key === '\\') {
    event.preventDefault();
    setSidebarCollapsed(!sidebarCollapsed);
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
  dom.collapseSidebarBtn?.addEventListener('click', () => {
    setSidebarCollapsed(true);
  });

  if (dom.app) {
    dom.app.classList.toggle('app--sidebar-collapsed', sidebarCollapsed);
  }
  document.documentElement.classList.remove('sidebar-collapsed-init');

  applyTheme(currentThemeSetting);

  const search = dom.search;
  search.addEventListener('input', () => {
    state.query = search.value;
    if (state.route.name !== 'runs') {
      window.location.hash = '#/runs';
      return;
    }
    render();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && state.selectedId) openRun(state.selectedId);
  });

  dom.quickNewRun?.addEventListener('click', () => {
    openComposer().catch((err) => {
      state.error = err.message;
      render();
    });
  });

  dom.workspace?.addEventListener('click', () => go('#/'));
  dom.workspace?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go('#/');
    }
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

  // The sidebar lists chats on every page, so they load once at boot and after
  // each mutation rather than only when the chat routes are visited.
  loadChats().then(renderSidebar).catch(() => {});

  route();
}

boot();
