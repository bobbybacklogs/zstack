/**
 * Rendering.
 *
 * Every piece of text here comes from a model, a file path, or a run record,
 * and all of it is untrusted. So this module builds DOM nodes and assigns
 * `textContent`, and never assembles `innerHTML`. A run page that rendered a
 * model's output as markup would be a script injection in the same process
 * that can start shell commands, which is the worst place to have one.
 */

/** Build an element. `text` is always assigned as text, never parsed as HTML. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    // Event types are case-sensitive and spelled in lower case, so `onClick`
    // must become `click`. Slicing without lowering attaches no listener at
    // all, which fails silently: the element renders, the click lands, and
    // nothing happens.
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  const list = Array.isArray(children) ? children.flat(Infinity) : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect>',
  runs: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>',
  agent: '<rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8.01" y2="16"></line><line x1="16" y1="16" x2="16.01" y2="16"></line>',
  task: '<polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line>',
  check: '<polyline points="20 6 9 17 4 12"></polyline>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>',
  health: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>',
  budget: '<line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line>',
  github: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path>',
  search: '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
  chevron: '<polyline points="9 18 15 12 9 6"></polyline>',
  chevronDown: '<polyline points="6 9 12 15 18 9"></polyline>',
  compose: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>',
  sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line>',
  sun: '<circle cx="12" cy="12" r="4"></circle><line x1="12" y1="2" x2="12" y2="4"></line><line x1="12" y1="20" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"></line><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="4" y2="12"></line><line x1="20" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"></line><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"></line>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>'
};

/** Render the zstack 3D cube logo mark as an adaptive light/dark image node. */
export function renderLogoIcon(extraClass = '') {
  const span = el('span', { class: `z-logo-icon ${extraClass}`.trim() }, [
    el('img', { class: 'z-logo-icon__img z-logo-icon__img--light', src: '/assets/zLogo1.png', alt: 'zStack' }),
    el('img', { class: 'z-logo-icon__img z-logo-icon__img--dark', src: '/assets/zLogo_White.png', alt: 'zStack' })
  ]);
  return span;
}

/** Render the full horizontal zstack wordmark logo as an adaptive light/dark image node. */
export function renderWordmarkLogo(extraClass = '') {
  const span = el('span', { class: `z-logo-main ${extraClass}`.trim() }, [
    el('img', { class: 'z-logo-main__img z-logo-main__img--light', src: '/assets/zMain1.png', alt: 'zStack' }),
    el('img', { class: 'z-logo-main__img z-logo-main__img--dark', src: '/assets/zMain2.png', alt: 'zStack' })
  ]);
  return span;
}

/** Render a crisp 16x16 Notion-style SVG icon. */
export function renderIcon(name, extraClass = '') {
  const cls = `nav__icon ${extraClass}`.trim();
  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser();
    const inner = ICON_PATHS[name] || ICON_PATHS.folder;
    const doc = parser.parseFromString(
      `<svg xmlns="${SVG_NS}" class="${cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`,
      'image/svg+xml'
    );
    const element = doc.documentElement;
    if (element && element.nodeName.toLowerCase() === 'svg') {
      return document.importNode(element, true);
    }
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  return svg;
}

const TONE_MARK = { ok: '·', error: '!', warning: '!', declined: '×', neutral: '·' };
const APPROVAL_LABEL = {
  approved: 'approved',
  declined: 'declined',
  denied: 'denied'
};

/** "3s ago", from an ISO timestamp. */
export function relativeTime(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/** One block of a run page. */
export function renderBlock(block) {
  const tone = block.tone || 'neutral';
  switch (block.kind) {
    case 'callout':
      return el('div', { class: `block block--callout tone-${tone}` }, [
        el('div', { class: 'callout__bar' }),
        el('div', {}, [
          el('div', { class: 'callout__text', text: block.text }),
          block.detail ? el('div', { class: 'callout__detail', text: block.detail }) : null
        ])
      ]);

    case 'prose':
      return el('div', {
        class: `block block--prose${block.streaming ? ' streaming' : ''}`,
        text: block.text
      });

    case 'tool': {
      const row = el('div', { class: `block block--tool tone-${tone}` }, [
        el('span', { class: 'tool__mark', text: TONE_MARK[tone] || '·' }),
        el('span', { class: 'tool__body' }, [
          el('span', { class: 'tool__name', text: block.name }),
          block.target ? el('span', { class: 'tool__target', text: ` ${block.target}` }) : null
        ]),
        el('span', {
          class: 'tool__outcome',
          text: [block.outcome, block.durationText].filter(Boolean).join(' · ')
        })
      ]);
      // A failed call carries the tool's own words, which is the only thing that
      // explains it: "error · 0ms" on its own sends the reader hunting through a
      // session file. Shown open, because a reason nobody expands is a reason
      // nobody reads; the details element is what keeps a long one collapsible.
      if (block.output && tone === 'error') {
        return el('div', { class: 'block block--tool-failure' }, [
          row,
          el('details', { class: 'tool__failure', open: true }, [
            el('summary', { class: 'tool__failure-head', text: block.outputTruncated ? 'Why it failed (truncated)' : 'Why it failed' }),
            el('pre', { class: 'tool__failure-body', text: block.output })
          ])
        ]);
      }
      return row;
    }

    case 'approval':
      return el('div', { class: 'block block--approval' }, [
        el('span', { class: `chip chip--${tone}`, text: APPROVAL_LABEL[block.decision] || block.decision }),
        el('span', { text: `approval for ${block.tool}` }),
        block.risk ? el('span', { text: `risk: ${block.risk}` }) : null
      ]);

    case 'divider':
      return el('div', { class: 'block block--divider' }, [
        el('span', { class: 'divider__label', text: block.label }),
        el('span', { class: 'divider__rule' }),
        block.tokens ? el('span', { class: 'divider__tokens', text: `${block.tokens} tokens` }) : null
      ]);

    case 'notice':
      return el('div', { class: `block block--notice tone-${tone}`, text: block.text });

    case 'summary':
      return el('div', { class: 'block block--summary' }, [
        el('div', { class: 'summary__head' }, [
          el('span', { class: `chip chip--${tone}`, text: block.label })
        ]),
        el('div', { class: 'summary__items' },
          (block.items || []).map((item) =>
            el('div', { class: 'summary__item' }, [
              el('span', { text: item.name }),
              el('span', { class: 'summary__detail', text: item.detail })
            ])
          )
        )
      ]);

    default:
      // An unknown block is shown rather than skipped. A blank row would be a
      // silent hole in a run's record, which is worse than an ugly one.
      return el('div', { class: 'block block--notice', text: `Unrendered block: ${block.kind}` });
  }
}

export function renderBlocks(blocks) {
  const wrap = el('div', { class: 'blocks' });
  for (const block of blocks) wrap.append(renderBlock(block));
  return wrap;
}

/** The status chip for a run. */
export function statusChip(status, tone) {
  const label = {
    running: 'running',
    starting: 'starting',
    ok: 'ok',
    failed: 'failed',
    cancelled: 'stopped',
    paused: 'paused',
    archived: 'ok'
  }[status] || status;
  return el('span', { class: `chip chip--${tone || 'neutral'}`, text: label });
}

/**
 * The dashboard: the answer to "what needs me" before the run list.
 *
 * Three stat cards (running now, failed in the last day, runs in the window),
 * one row per project with its latest activity, and the newest runs. Every
 * row and card is a link to the page it summarizes — a dashboard that cannot
 * be clicked through is a poster, not a console. Empty states name the next
 * action rather than the absence.
 */
export function renderDashboard(dashboard, { bridge, onOpenRun, onOpenProject, onOpenRuns, onNewRun, onNewProject }) {
  const stats = el('div', { class: 'grid2', style: 'margin-bottom:20px' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat__head' }, [
        renderIcon('runs', 'stat__icon'),
        el('div', { class: 'stat__label', text: 'running now' })
      ]),
      el('div', { class: 'stat__value', text: String(dashboard.running) })
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat__head' }, [
        renderIcon('agent', 'stat__icon'),
        el('div', { class: 'stat__label', text: 'failed in the last 24h' })
      ]),
      el('div', { class: 'stat__value', text: String(dashboard.failed24h) })
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat__head' }, [
        renderIcon('dashboard', 'stat__icon'),
        el('div', { class: 'stat__label', text: 'runs in the recent window' })
      ]),
      el('div', { class: 'stat__value', text: String(dashboard.windowRuns) })
    ])
  ]);

  const bridgeNote = !bridge
    ? null
    : el('div', { class: 'panel' }, [
      el('div', { class: 'panel__title' }, [
        el('span', { class: `dot ${bridge.ok ? 'dot--ok' : 'dot--error'}` }),
        el('span', { text: bridge.ok ? `Bridge connected (${bridge.mode || 'live'})` : 'Bridge unreachable' })
      ]),
      bridge.ok
        ? null
        : el('p', { class: 'hint', text: `New runs will fail until it is back: ${bridge.error || 'unknown error'}` })
    ]);

  const projects = dashboard.projects || [];
  // Rows link to project pages; the unassigned bucket opens the full list,
  // which is where those runs can be found and moved.
  const projectPanel = el('div', { class: 'panel' }, [
    el('div', { class: 'panel__title' }, [
      renderIcon('folder', 'panel__icon'),
      el('span', { text: 'Projects' })
    ]),
    projects.length === 0
      ? el('div', {}, [
        el('p', { class: 'hint', text: 'No projects yet. Group runs under a folder to see activity per area.' }),
        el('div', { style: 'margin-top:10px' }, [
          el('button', { class: 'btn', type: 'button', text: 'New project', onClick: onNewProject })
        ])
      ])
      : projects.map((p) => el('button', {
        class: 'prow',
        type: 'button',
        onClick: () => p.projectId ? onOpenProject(p.projectId) : onOpenRuns()
      }, [
        el('div', { class: 'prow__left' }, [
          renderIcon('folder', 'prow__icon'),
          el('span', { class: 'prow__name', text: p.projectName || 'No project' })
        ]),
        el('span', { class: 'prow__meta', text: p.runs === 0 ? 'no recent runs' : `${p.runs} run${p.runs === 1 ? '' : 's'} · ${relativeTime(p.lastAt)}` })
      ]))
  ]);

  const recent = dashboard.recent || [];
  const recentPanel = el('div', { class: 'panel' }, [
    el('div', { class: 'panel__title' }, [
      renderIcon('runs', 'panel__icon'),
      el('span', { text: 'Recent runs' })
    ]),
    recent.length === 0
      ? el('div', {}, [
        el('p', { class: 'hint', text: 'Nothing here yet. Start the first run to see it land.' }),
        el('div', { style: 'margin-top:10px' }, [
          el('button', { class: 'btn btn--primary', type: 'button', text: 'New run', onClick: onNewRun })
        ])
      ])
      : el('div', { class: 'list' }, recent.map((card) => renderRunCard(card, {
        selected: false,
        onOpen: onOpenRun
      })))
  ]);

  return el('div', { class: 'page page--wide' }, [
    el('header', { class: 'page__header' }, [
      el('div', { class: 'page__icon-box' }, [renderIcon('dashboard', 'page__header-icon')]),
      el('div', { class: 'page__badge' }, [el('span', { class: 'chip chip--neutral', text: 'workspace' })]),
      el('h1', { class: 'page__title', text: 'Dashboard' }),
      el('div', { class: 'page__meta', text: 'Status, activity, and the newest runs.' })
    ]),
    el('div', { style: 'margin:18px 0' }, [stats]),
    bridgeNote,
    projectPanel,
    recentPanel
  ]);
}

/** A run card for the list. */
export function renderRunCard(card, { selected, onOpen }) {
  const sub = el('div', { class: 'card__sub' }, [
    el('span', { text: card.badge }),
    card.playbook ? el('span', { text: card.playbook }) : null,
    card.model ? el('span', { class: 'mono', text: card.model }) : null,
    card.agentic ? el('span', { text: card.applied ? 'apply' : 'read-only' }) : null,
    card.turns ? el('span', { text: `${card.turns} turns` }) : null,
    card.toolCalls ? el('span', { text: `${card.toolCalls} calls` }) : null,
    card.failedTools ? el('span', { class: 'chip chip--error', text: `${card.failedTools} failed` }) : null,
    card.declinedTools ? el('span', { class: 'chip chip--declined', text: `${card.declinedTools} declined` }) : null,
    card.fileChangeCount ? el('span', { text: `${card.fileChangeCount} files` }) : null,
    card.prUrl ? el('span', { class: 'chip chip--pr', text: 'PR' }) : null,
    card.truncated ? el('span', { class: 'chip chip--warning', text: 'partial' }) : null
  ]);

  return el('button', {
    class: `card${selected ? ' card--selected' : ''}`,
    type: 'button',
    dataset: { id: card.id },
    onClick: () => onOpen(card.id)
  }, [
    el('div', { class: 'card__title', text: card.title }),
    el('div', { class: 'card__side' }, [
      statusChip(card.status, card.tone),
      el('span', { text: card.durationText || '' })
    ]),
    sub,
    el('div', { class: 'card__side' }, [
      el('span', { text: relativeTime(card.at) }),
      card.tokensText ? el('span', { text: `${card.tokensText} tok` }) : null
    ])
  ]);
}

/** The list view, grouped so finished and in-flight runs read differently. */
export function renderRunList({ runs, hasMore, liveCount, selectedId, onOpen, onLoadMore, query }) {
  if (runs.length === 0) {
    return el('div', { class: 'empty' }, [
      el('h2', { text: query ? 'No runs match that search' : 'No runs yet' }),
      el('p', {
        text: query
          ? 'Clear the search to see everything.'
          : 'Start one from here, or run `zstack "your task"` on the command line. Both land in this list.'
      })
    ]);
  }

  const wrap = el('div', { class: 'list' });
  const running = runs.filter((r) => r.live || r.status === 'running' || r.status === 'starting');
  const rest = runs.filter((r) => !running.includes(r));

  if (running.length > 0) {
    wrap.append(el('div', { class: 'list__group', text: `Running (${running.length})` }));
    for (const card of running) wrap.append(renderRunCard(card, { selected: card.id === selectedId, onOpen }));
  }
  if (rest.length > 0) {
    wrap.append(el('div', { class: 'list__group', text: `Runs (${rest.length}${hasMore ? '+' : ''})` }));
    for (const card of rest) wrap.append(renderRunCard(card, { selected: card.id === selectedId, onOpen }));
  }
  if (hasMore) {
    wrap.append(el('div', { style: 'margin-top:12px' }, [
      el('button', { class: 'btn', type: 'button', text: 'Load more', onClick: onLoadMore })
    ]));
  }
  if (liveCount === 0 && running.length === 0) {
    wrap.append(el('p', { class: 'hint', style: 'margin-top:20px' },
      'Every run here is archived. Re-open one to see what it did, or start a new one.'));
  }
  return wrap;
}

/** The header and properties of a run page. */
/**
 * The badge row for a run page.
 *
 * Built here rather than inside the header so the live stream can rebuild it
 * with the same code. It is patched mid-run, and a row assembled in two places
 * drifts: each new chip added to the header silently disappeared from the run
 * the moment its status changed. One builder means a chip is either in both or
 * in neither.
 */
export function renderBadgeRow(page, { onOpenProject } = {}) {
  return [
    statusChip(page.status, page.tone),
    el('span', { text: page.badge }),
    // A run whose project was deleted keeps its projectId but resolves to no
    // name, so there is nothing to link to. Omission, not a dead link.
    page.projectName && page.projectId && onOpenProject
      ? el('button', {
        class: 'chip chip--project',
        type: 'button',
        text: String(page.projectName),
        onClick: () => onOpenProject(page.projectId)
      })
      : null,
    // A continuation says so, because a run that picks up someone else's work
    // reads as a fresh unrelated run otherwise.
    page.continuationOf
      ? el('span', { class: 'chip', title: `Continues ${page.continuationOf}`, text: 'continued' })
      : null,
    page.prUrl
      ? el('a', {
        class: 'chip chip--pr',
        href: page.prUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'Pull Request ↗'
      })
      : null
  ];
}

const PROP_ICONS = {
  playbook: 'task',
  model: 'agent',
  policy: 'check',
  workspace: 'folder',
  turns: 'task',
  turnBudget: 'task',
  tokens: 'budget',
  files: 'folder',
  role: 'agent',
  prompt: 'compose',
  promptChars: 'compose',
  duration: 'dashboard',
  directory: 'folder',
  runs: 'runs',
  pr: 'github',
  prUrl: 'github',
  autoPr: 'github'
};

export function renderPageHeader(page, { onCancel, onOpenProject, onRename, onMove, onDelete, onContinue, onPause, onResume }) {
  const meta = [];
  if (page.at) meta.push(relativeTime(page.at));
  if (page.counts?.turns) meta.push(`${page.counts.turns} turns`);
  if (page.counts?.toolCalls) meta.push(`${page.counts.toolCalls} tool calls`);
  if (page.counts?.fileChanges) meta.push(`${page.counts.fileChanges} files changed`);
  /** "3 turns" / "1 turn", for the copy that names how far the run got. */
  const budgetTextFor = (p) => {
    const turns = p?.counts?.turns || p?.turnBudget?.used || 0;
    return `${turns} turn${turns === 1 ? '' : 's'}`;
  };

  const head = el('header', { class: 'page__header' }, [
    el('div', { class: 'page__icon-box' }, [
      renderIcon(page.badge === 'agent' ? 'agent' : 'runs', 'page__header-icon')
    ]),
    el('div', { class: 'page__badge' }, [...renderBadgeRow(page, { onOpenProject })]),
    el('h1', { class: 'page__title', text: page.title }),
    el('div', { class: 'page__meta', text: meta.join('  ·  ') })
  ]);

  // Pause and stop sit together while a run is going, because they are the two
  // ways to stop spending tokens and they differ in one way that matters: pause
  // keeps the work, stop throws it away. Saying so on the button is the whole
  // difference between a reader choosing the safe one and losing a long run.
  const running = page.live && (page.status === 'running' || page.status === 'starting');
  if (running && (onPause || onCancel)) {
    head.append(el('div', { style: 'margin: 10px 0; display: flex; gap: 10px; align-items: center' }, [
      onPause
        ? el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'Pause',
          title: 'Finishes the turn in flight, then stops. The work is kept and can be resumed.',
          onClick: onPause
        })
        : null,
      onCancel
        ? el('button', {
          class: 'btn btn--danger',
          type: 'button',
          text: 'Stop run',
          title: 'Kills the harness now. Nothing is saved, so this run cannot be resumed.',
          onClick: onCancel
        })
        : null,
      el('span', { class: 'hint', text: 'Pause keeps the work; stop does not.' })
    ]));
  }

  // A paused run is waiting on the reader, so the page says what happened and
  // offers the one action that continues it.
  if (page.status === 'paused') {
    const canResumeInPlace = page.turnBudget?.canContinue && page.turnBudget.inPlace;
    head.append(el('div', { class: 'panel', style: 'margin: 12px 0' }, [
      el('div', { class: 'panel__title' }, [
        renderIcon('task', 'panel__icon'),
        el('span', { text: `Paused after ${budgetTextFor(page)}` })
      ]),
      el('p', {
        class: 'hint',
        // Resuming a pause happens in the process that paused it. A restart
        // leaves the record saying "paused" with nothing in memory to continue,
        // so the page says that instead of offering a button that would 404.
        text: page.turnBudget?.staleAfterRestart
          ? 'The turn in flight finished and the session was saved, so nothing is being spent. This server restarted since, so the run cannot be picked up in place, but it can be continued as a new run from the session it saved.'
          : 'The turn in flight finished and the session was saved, so nothing is being spent while this waits. Resuming continues from here in the same run.'
      }),
      canResumeInPlace && onResume
        ? el('div', { style: 'margin-top: 10px' }, [
          el('button', {
            class: 'btn btn--primary',
            type: 'button',
            text: 'Resume run',
            onClick: onResume
          })
        ])
        : page.turnBudget?.canContinue && onContinue
          ? el('div', { style: 'margin-top: 10px' }, [
            el('button', {
              class: 'btn btn--primary',
              type: 'button',
              text: 'Continue as a new run',
              onClick: onContinue
            })
          ])
          : el('p', { class: 'hint', text: 'This run has no saved session, so it cannot be continued.' })
    ]));
  }

  // A run that reaches its budget is continued rather than stopped, so this
  // panel only appears when the ceiling itself was reached: every turn allowed
  // has been spent and the model still wanted more. That is worth saying
  // plainly, because the alternative reading of a stopped run is that the task
  // finished.
  const budget = page.turnBudget;
  if (budget && budget.limitReached && !page.live) {
    head.append(el('div', { class: 'panel', style: 'margin: 12px 0' }, [
      el('div', { class: 'panel__title' }, [
        renderIcon('task', 'panel__icon'),
        el('span', { text: `Stopped at the ${budget.maxTurns}-turn ceiling` })
      ]),
      el('p', {
        class: 'hint',
        text: budget.canContinue
          ? `It ran past the ${budget.maxTurns} turns it was sized for and kept working, so this is a task that is not converging rather than one that needed a little more room. Continuing resumes the same session.`
          : 'It ran past the size it was started with and still wanted more. This run predates saved sessions, so it cannot be continued; start a fresh run.'
      }),
      budget.canContinue && onContinue
        ? el('div', { style: 'margin-top: 10px' }, [
          el('button', {
            class: 'btn btn--primary',
            type: 'button',
            text: 'Continue with more turns',
            onClick: onContinue
          })
        ])
        : null
    ]));
  }

  // Rename, move, and delete live beside the run they act on. A confirm sits
  // behind delete because it hides the run from every list; a rename or move
  // applies on submit and shows the server's problems inline.
  if (onRename || onMove || onDelete) {
    const actions = el('div', { style: 'display:flex; gap:10px; margin:10px 0' }, [
      onRename
        ? el('button', { class: 'btn', type: 'button', text: 'Rename', onClick: onRename })
        : null,
      onMove
        ? el('button', { class: 'btn', type: 'button', text: 'Move to project', onClick: onMove })
        : null,
      onDelete
        ? el('button', { class: 'btn btn--danger', type: 'button', text: 'Delete run', onClick: onDelete })
        : null
    ]);
    head.append(actions);
  }

  const props = el('div', { class: 'props' },
    (page.props || []).map((prop) => {
      const isPr = prop.key === 'pr' || prop.key === 'prUrl';
      const isUrl = typeof prop.value === 'string' && /^https?:\/\//.test(prop.value);
      return el('div', { class: 'props__row', dataset: { key: prop.key } }, [
        el('div', { class: 'props__key' }, [
          renderIcon(PROP_ICONS[prop.key] || 'task', 'props__icon'),
          el('span', { class: 'props__key-label', text: prop.label })
        ]),
        el('div', {
          class: `props__val${/model|workspace|files|role/.test(prop.key) ? ' props__val--mono' : ''}`,
          text: isPr && isUrl ? undefined : prop.value
        }, isPr && isUrl ? [
          el('a', {
            class: 'chip chip--pr',
            href: prop.value,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: 'Pull Request ↗'
          })
        ] : undefined)
      ]);
    })
  );

  return [head, props];
}

/**
 * The turn budget line for the page's property list.
 *
 * Read from the live counts rather than the page's own copy, because the
 * property list is projected once and the stream patches it as turns land. A
 * budget that reads "0 of 25" while a run is on turn 7 is worse than no budget
 * at all: it is a number the reader would act on.
 *
 * Mirrors `turnBudgetText` in `src/blocks.mjs`, and has to: the same run is
 * described by both, so a divergence shows one number before the run ends and
 * another after. A run is driven a turn at a time, so "extended 7×" would be
 * printed on every run of any length and mean nothing.
 */
export function turnBudgetLine(page) {
  const budget = page?.turnBudget;
  if (!budget) return null;
  const chosen = Number(budget.maxTurns);
  if (!Number.isFinite(chosen) || chosen <= 0) return null;
  const used = Number(page?.counts?.turns ?? budget.used) || 0;
  if (used > chosen || budget.limitReached) {
    return budget.limitReached
      ? `${used} turns, stopped at the ceiling`
      : `${used} turns, continued past ${chosen}`;
  }
  return `${used} of ${chosen}`;
}

/** Bridge and history state. */
export function renderHealth(health, status) {
  const bridge = health?.bridge || {};
  const rows = [
    ['Bridge', bridge.ok ? 'connected' : 'unreachable'],
    ['Address', bridge.baseUrl || 'unknown'],
    ['Mode', bridge.mode || 'unknown'],
    ['Providers', (bridge.providers || []).join(', ') || 'none reported'],
    ['History file', health?.history?.path || 'unknown'],
    ['Uptime', health?.uptimeMs != null ? `${Math.round(health.uptimeMs / 1000)}s` : 'unknown']
  ];
  return el('div', {}, [
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel__title' }, [
        renderIcon('health', 'panel__icon'),
        el('span', { class: `dot ${bridge.ok ? 'dot--ok' : 'dot--error'}` }),
        el('span', { text: 'ModelHitch gateway' })
      ]),
      el('table', { class: 'data' },
        rows.map(([k, v]) =>
          el('tr', {}, [el('th', { text: k }), el('td', { text: v })])
        )
      ),
      bridge.ok
        ? null
        : el('p', { class: 'hint', style: 'margin-top:12px' },
          `Start it with: modelhitch bridge --background. Error: ${bridge.error || 'unknown'}`)
    ]),
    status ? renderStatusTable(status) : null
  ]);
}

function renderStatusTable(status) {
  if (!status.connected) {
    return el('div', { class: 'panel' }, [
      el('div', { class: 'panel__title' }, [
        renderIcon('agent', 'panel__icon'),
        el('span', { class: 'dot dot--error' }),
        el('span', { text: 'Role mappings' })
      ]),
      el('p', { class: 'hint', text: `Unavailable while the bridge is down: ${status.error || 'unknown error'}` })
    ]);
  }
  const mapping = status.mapping || {};
  return el('div', { class: 'panel' }, [
    el('div', { class: 'panel__title' }, [
      renderIcon('agent', 'panel__icon'),
      el('span', { class: 'dot dot--ok' }),
      el('span', { text: 'Role mappings' })
    ]),
    el('table', { class: 'data' }, [
      el('tr', {}, [el('th', { text: 'Role' }), el('th', { text: 'Model' })]),
      ...Object.entries(mapping).map(([role, model]) =>
        el('tr', {}, [
          el('td', { text: role }),
          el('td', { class: 'mono', text: model })
        ])
      )
    ]),
    status.panelModels?.length
      ? el('p', { class: 'hint', style: 'margin-top:12px' },
        `Panel models: ${status.panelModels.join(', ')}`)
      : null
  ]);
}

/** Budget controls, with the resolved mapping they produce. */
export function renderBudget(config, status, { onApply }) {
  let budget = config?.budget;
  if (!budget) {
    try {
      const stored = localStorage.getItem('zstack:budget');
      if (stored) budget = JSON.parse(stored);
    } catch {}
  }
  budget = budget || {};

  const activeTier = budget.tier || 'med-high';
  const activeSource = budget.source || 'catalog';
  const activeLane = budget.lane || 'auto';

  const makeSelect = (label, name, options, activeValue, hint) => {
    const activeOpt = options.find((o) => o.id === activeValue) || options[0];
    const activeLabel = activeOpt ? activeOpt.label : activeValue;

    const select = el('select', { name });
    for (const opt of options) {
      const isCurrent = opt.id === activeValue;
      const optEl = el('option', {
        value: opt.id,
        text: isCurrent ? `${opt.label} • Active` : opt.label
      });
      if (isCurrent) {
        optEl.selected = true;
        optEl.setAttribute('selected', '');
      }
      select.append(optEl);
    }
    if (activeValue !== undefined && activeValue !== null) {
      select.value = activeValue;
    }

    const badge = el('span', {
      class: 'chip chip--neutral field__active-badge',
      title: `Currently set in system: ${activeLabel}`
    }, [
      el('span', { class: 'dot dot--ok', style: 'width:6px; height:6px; flex:none;' }),
      el('span', { class: 'field__active-badge-text', text: `Set: ${activeOpt ? activeOpt.id : activeValue}` })
    ]);

    const header = el('div', { class: 'field__header' }, [
      el('label', { text: label }),
      badge
    ]);

    select.addEventListener('change', () => {
      if (select.value === activeValue) {
        badge.className = 'chip chip--neutral field__active-badge';
        badge.title = `Currently set in system: ${activeLabel}`;
        badge.replaceChildren(
          el('span', { class: 'dot dot--ok', style: 'width:6px; height:6px; flex:none;' }),
          el('span', { class: 'field__active-badge-text', text: `Set: ${activeOpt ? activeOpt.id : activeValue}` })
        );
      } else {
        const chosenOpt = options.find((o) => o.id === select.value);
        const chosenId = chosenOpt ? chosenOpt.id : select.value;
        badge.className = 'chip chip--warning field__active-badge';
        badge.title = `Unsaved change. Currently active: ${activeLabel}`;
        badge.replaceChildren(
          el('span', { class: 'dot dot--running', style: 'width:6px; height:6px; flex:none;' }),
          el('span', { class: 'field__active-badge-text', text: `Selected: ${chosenId}` })
        );
      }
    });

    return {
      node: el('div', { class: 'field' }, [
        header,
        select,
        hint ? el('div', { class: 'field__hint', text: hint }) : null
      ]),
      select,
      getValue: () => select.value
    };
  };

  const tierControl = makeSelect(
    'Budget tier',
    'tier',
    (config?.tiers || ['low-med', 'med-high', 'high', 'max']).map((t) => {
      const meta = {
        'low-med': 'Low-Med (Fast & light)',
        'med-high': 'Med-High (Balanced default)',
        'high': 'High (Frontier reasoning)',
        'max': 'Max (Exhaustive reasoning)'
      };
      return { id: t, label: meta[t] || t };
    }),
    activeTier,
    'Higher tiers map roles to stronger models.'
  );

  const sourceControl = makeSelect(
    'Model source',
    'source',
    [
      { id: 'catalog', label: 'catalog (Active Provider Alignment)' },
      { id: 'config', label: 'config (ModelHitch Config Only)' }
    ],
    activeSource,
    'config uses the models pinned in your ModelHitch config.'
  );

  const laneOptions = (config?.lanes && config.lanes.length > 0)
    ? config.lanes.map((l) => ({ id: l.id, label: l.name ? `${l.name} (${l.id})` : l.id }))
    : [
      { id: 'auto', label: 'Auto (OpenCode when present, else Hitch)' },
      { id: 'zen', label: 'OpenCode Zen (opencode/<model>)' },
      { id: 'go', label: 'OpenCode Go (opencode-go/<model>)' },
      { id: 'hitch', label: 'ModelHitch Auto' }
    ];

  const laneControl = makeSelect(
    'Provider lane',
    'lane',
    laneOptions,
    activeLane,
    'Which provider family role models resolve from.'
  );

  const note = el('div', { class: 'field__hint' });
  const apply = el('button', {
    class: 'btn btn--primary',
    type: 'button',
    text: 'Apply mapping',
    onClick: async () => {
      apply.disabled = true;
      note.textContent = 'Applying mapping...';
      try {
        const payload = {
          tier: tierControl.getValue(),
          source: sourceControl.getValue(),
          lane: laneControl.getValue()
        };
        await onApply(payload);
        note.textContent = '✓ Mapping updated and set.';
      } catch (err) {
        note.textContent = err.message;
      } finally {
        apply.disabled = false;
      }
    }
  });

  const mapping = status?.mapping || {};
  const rows = Object.entries(mapping);

  return el('div', {}, [
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel__title' }, [
        renderIcon('budget', 'panel__icon'),
        el('span', { text: 'Model routing' })
      ]),
      el('p', { class: 'hint', style: 'margin:0 0 14px' },
        'These decide which model every role resolves to, for runs started here and from the command line.'),
      el('div', { class: 'grid2' }, [tierControl.node, sourceControl.node, laneControl.node]),
      el('div', { style: 'margin-top:14px; display:flex; gap:10px; align-items:center' }, [apply, note]),
      status && status.laneApplied === false
        ? el('p', { class: 'hint', style: 'margin-top:10px' },
          'Your ModelHitch config pins the models, so the lane is recorded but not applied.')
        : null
    ]),
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel__title' }, [
        renderIcon('agent', 'panel__icon'),
        el('span', { text: 'Resolved roles' })
      ]),
      rows.length === 0
        ? el('p', { class: 'hint', text: 'No mapping available. The bridge may be down.' })
        : el('table', { class: 'data' }, [
          el('tr', {}, [el('th', { text: 'Role' }), el('th', { text: 'Model' })]),
          ...rows.map(([role, model]) =>
            el('tr', {}, [el('td', { text: role }), el('td', { class: 'mono', text: model })])
          )
        ])
    ])
  ]);
}

/** The composer, with every control the server actually honours. */
export function renderComposer({
  config,
  health,
  projects,
  repos,
  presetProjectId,
  defaults = {},
  onClose,
  onSubmit,
  onOptimize,
  onClassify,
  autoOptimize = false,
  deletedProjectNote = null,
  truncatedNote = null
}) {
  const textarea = el('textarea', {
    placeholder: 'Describe the task. The playbook is picked for you unless you pin one.',
    rows: 4
  });
  textarea.value = defaults.prompt || '';

  const playbookSelect = el('select', { name: 'playbook' }, [
    el('option', { value: '', text: 'Auto-detect' }),
    ...(config?.playbooks || []).map((p) => el('option', { value: p.id, text: `${p.id} — ${p.title}` }))
  ]);
  const laneSelect = el('select', { name: 'lane' }, [
    el('option', { value: '', text: 'Stored default' }),
    ...(config?.lanes || []).map((l) => el('option', { value: l.id, text: l.name || l.id }))
  ]);
  const policySelect = el('select', { name: 'policy' }, [
    el('option', { value: 'read-only', text: 'Read-only — mutating calls are declined' }),
    el('option', { value: 'apply', text: 'Apply — the agent may change files' }),
    el('option', { value: 'strict', text: 'Strict — nothing is auto-approved' })
  ]);
  const targetProjectId = presetProjectId || defaults.projectId || '';
  const projectExists = (projects || []).some((p) => p.id === targetProjectId);
  const effectiveProjectId = projectExists ? targetProjectId : '';
  const projectSelect = el('select', { name: 'project' }, [
    el('option', { value: '', text: 'No project' }),
    ...((projects || []).map((p) =>
      el('option', {
        value: p.id,
        text: `${p.name} — ${p.dir}`,
        selected: effectiveProjectId === p.id
      })
    ))
  ]);
  // The workspace is picked from one of two sources: a synced GitHub repo
  // (whose local clone path the run executes in) or a local directory typed
  // by hand. A toggle switches between them; the repo side lists what the
  // Repos page synced, and the local side is the directory path itself —
  // never the folder's contents, which the run discovers on its own.
  const repoList = repos || [];
  const workspaceInput = el('input', {
    type: 'text',
    name: 'workspaceDir',
    placeholder: defaults.workspaceDir || 'a directory on this machine',
    list: 'workspace-suggestions',
    spellcheck: 'false'
  });
  if (defaults.workspaceDir) workspaceInput.value = defaults.workspaceDir;
  // Known directories as one-click suggestions, so the local side rarely
  // needs typing either.
  const suggestions = el('datalist', { id: 'workspace-suggestions' }, [
    ...projects.map((p) => el('option', { value: p.dir })),
    ...repoList.filter((r) => r.cloned).map((r) => el('option', { value: r.localPath }))
  ]);
  const repoSelect = el('select', { name: 'repo' }, [
    ...(repoList.length === 0
      ? [el('option', { value: '', text: 'No synced repos — sync on the Repos page' })]
      : repoList.map((r) =>
        el('option', {
          value: r.fullName,
          text: `${r.fullName}${r.cloned ? '' : ' — not cloned locally'}`
        })
      ))
  ]);
  let workspaceMode = repoList.some((r) => r.cloned) ? 'repo' : 'local';
  const repoButton = el('button', { class: 'toggle__btn', type: 'button', text: 'Repo' });
  const localButton = el('button', { class: 'toggle__btn', type: 'button', text: 'Local' });
  const syncWorkspaceMode = () => {
    repoButton.classList.toggle('toggle__btn--active', workspaceMode === 'repo');
    localButton.classList.toggle('toggle__btn--active', workspaceMode === 'local');
    repoSelect.hidden = workspaceMode !== 'repo';
    workspaceInput.hidden = workspaceMode !== 'local';
  };
  repoButton.addEventListener('click', () => {
    workspaceMode = 'repo';
    syncWorkspaceMode();
  });
  localButton.addEventListener('click', () => {
    workspaceMode = 'local';
    syncWorkspaceMode();
  });
  const workspaceControls = el('div', {}, [
    el('div', { class: 'toggle' }, [repoButton, localButton]),
    repoSelect,
    workspaceInput,
    suggestions,
    el('div', { class: 'field__hint' },
      'A repo runs in its local clone; local takes any directory path. Sync repos on the Repos page.')
  ]);
  // A chosen project decides the workspace, so the picker stands down entirely
  // rather than showing controls that no longer apply.
  const projectDirNote = el('div', { class: 'field__hint mono', hidden: true });
  const workspaceField = el('div', { class: 'field' }, [
    el('label', { text: 'Workspace' }),
    workspaceControls,
    projectDirNote
  ]);
  // The initial mode is applied, not just remembered: without this the
  // unselected side renders alongside the selected one until the first click.
  syncWorkspaceMode();

  // The turn budget, asked for as a shape of work rather than a number.
  //
  // Nobody knows how many model turns a task needs, including the model, so a
  // bare number field is a question with no answer. "Standard" or "Deep" is a
  // question a person can answer, and the number is shown beside it so the
  // choice is still concrete. Custom stays available for the case where a
  // number is genuinely known.
  const presets = config?.turnPresets || [];
  const turnsSelect = el('select', { name: 'maxTurns' }, [
    ...presets.map((p) => el('option', { value: String(p.turns), text: `${p.label} — ${p.turns} turns` })),
    el('option', { value: 'custom', text: 'Custom…' })
  ]);
  const turnsInput = el('input', {
    type: 'number',
    name: 'customMaxTurns',
    min: '1',
    max: config?.maxMaxTurns ? String(config.maxMaxTurns) : '500',
    placeholder: String(config?.defaultMaxTurns || 25)
  });
  const turnsHint = el('div', { class: 'field__hint' });

  const selectedTurns = () => {
    if (turnsSelect.value !== 'custom') return Number(turnsSelect.value);
    return Number(turnsInput.value) || config?.defaultMaxTurns || 25;
  };
  const syncTurns = () => {
    const custom = turnsSelect.value === 'custom';
    turnsInput.hidden = !custom;
    if (custom) {
      turnsInput.style.display = '';
      if (!turnsInput.value) turnsInput.value = String(config?.defaultMaxTurns || 25);
    } else {
      turnsInput.style.display = 'none';
    }
    const preset = presets.find((p) => String(p.turns) === turnsSelect.value);
    const turns = selectedTurns();
    // The hint teaches what the budget buys and says the run is not cut off at
    // it. That second fact is what makes the choice low-stakes: the budget is
    // where zstack starts, not where your work stops.
    turnsHint.textContent = preset
      ? `${preset.hint} Extends on its own if it needs more.`
      : `${turns} turns. Extends on its own if it needs more.`;
  };
  turnsSelect.addEventListener('change', syncTurns);

  /** Point the control at a budget, from a project default or a preset id. */
  const applyTurns = (value) => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && presets.some((p) => p.turns === n)) {
      turnsSelect.value = String(n);
      turnsInput.value = '';
    } else if (Number.isInteger(n) && n > 0) {
      turnsSelect.value = 'custom';
      turnsInput.value = String(n);
    } else {
      turnsSelect.value = String(config?.defaultMaxTurns || presets.find((p) => p.id === 'standard')?.turns || 25);
      turnsInput.value = '';
    }
    syncTurns();
  };

  const autoPrCheckbox = el('input', {
    type: 'checkbox',
    name: 'autoPr',
    id: 'composer-auto-pr'
  });
  const autoPrLabel = el('label', { for: 'composer-auto-pr', text: 'Create PR on completion if changes are made' });
  const autoPrField = el('div', { class: 'field field--checkbox' }, [
    el('div', { class: 'checkbox-line' }, [autoPrCheckbox, autoPrLabel]),
    el('div', { class: 'field__hint' },
      'Pushes a feature branch and opens a GitHub pull request when a run with apply policy finishes with file changes.')
  ]);

  // A project and a picked workspace cannot both decide where the run
  // executes. Picking a project stands the picker down and says where the run
  // will happen, so the reader sees the server's rule rather than discovering
  // it as an error. The project's defaults pre-select the playbook and policy,
  // but an explicit choice always wins: a default that overrides the reader
  // is a trap.
  const syncProjectState = ( { keepChoices = false } = {}) => {
    const chosen = (projects || []).find((p) => p.id === projectSelect.value);
    if (chosen) {
      workspaceControls.hidden = true;
      projectDirNote.hidden = false;
      projectDirNote.textContent = `The project decides the workspace: ${chosen.dir}`;
      if (!keepChoices) {
        if (chosen.defaultPlaybook) {
          const known = [...playbookSelect.options].some((o) => o.value === chosen.defaultPlaybook);
          playbookSelect.value = known ? chosen.defaultPlaybook : '';
          if (!known) playbookSelect.dataset.projectDefaultUnknown = chosen.defaultPlaybook;
          else delete playbookSelect.dataset.projectDefaultUnknown;
        } else {
          playbookSelect.value = '';
          delete playbookSelect.dataset.projectDefaultUnknown;
        }
        policySelect.value = chosen.defaultPolicy || 'read-only';
        if (chosen.defaultAutoPr !== null && chosen.defaultAutoPr !== undefined) {
          autoPrCheckbox.checked = chosen.defaultAutoPr === true;
        } else {
          autoPrCheckbox.checked = false;
        }
        // A project's turn budget is a starting point. Picking the project
        // adopts it; picking a budget after that keeps your choice, because a
        // default that overrides the reader is a trap.
        applyTurns(chosen.defaultMaxTurns);
      }
    } else {
      workspaceControls.hidden = false;
      projectDirNote.hidden = true;
      if (!keepChoices) {
        playbookSelect.value = '';
        policySelect.value = 'read-only';
        autoPrCheckbox.checked = false;
        delete playbookSelect.dataset.projectDefaultUnknown;
        applyTurns(config?.defaultMaxTurns);
      }
    }
  };
  projectSelect.addEventListener('change', () => syncProjectState());
  for (const select of [playbookSelect, policySelect, turnsSelect]) {
    select.addEventListener('change', () => syncProjectState({ keepChoices: true }));
  }
  syncProjectState();
  syncTurns();
  if (defaults.lane && [...laneSelect.options].some((o) => o.value === defaults.lane)) {
    laneSelect.value = defaults.lane;
  }
  if (defaults.maxTurns) {
    applyTurns(defaults.maxTurns);
  }

  const problem = el('div', { class: 'composer__warning' });
  const notes = [];
  if (targetProjectId && !projectExists) {
    notes.push(deletedProjectNote || 'Project was deleted since this chat started; falling back to no project.');
  }
  if (truncatedNote) {
    notes.push(truncatedNote);
  }
  if (notes.length > 0) {
    problem.textContent = notes.join(' ');
  }
  const submit = el('button', { class: 'btn btn--primary', type: 'button', text: 'Start run' });

  const run = async () => {
    const prompt = textarea.value.trim();
    if (prompt === '') {
      problem.textContent = 'A run needs a prompt.';
      textarea.focus();
      return;
    }
    // A default naming a playbook this server has never loaded is stale data,
    // not a choice. It faults with the project's name so the reader knows
    // where to fix it rather than seeing an unknown-playbook error.
    if (playbookSelect.value === '' && playbookSelect.dataset.projectDefaultUnknown) {
      const chosen = (projects || []).find((p) => p.id === projectSelect.value);
      problem.textContent = chosen
        ? `Project "${chosen.name}" defaults to playbook "${playbookSelect.dataset.projectDefaultUnknown}", which this server does not know. Pick a playbook or clear the default.`
        : `The project's default playbook "${playbookSelect.dataset.projectDefaultUnknown}" is unknown to this server.`;
      return;
    }
    const payload = { prompt };
    if (playbookSelect.value) payload.playbook = playbookSelect.value;
    if (laneSelect.value) payload.lane = laneSelect.value;
    if (policySelect.value) payload.policy = policySelect.value;
    if (autoPrCheckbox.checked) payload.autoPr = true;
    // The server takes the directory from the stored project, so the payload
    // carries the id, never the path. A repo contributes its local clone
    // path, which is a path the reader has already confirmed exists — a
    // repo without a clone faults here rather than at the run.
    if (projectSelect.value) payload.projectId = projectSelect.value;
    else if (workspaceMode === 'repo') {
      const repo = repoList.find((r) => r.fullName === repoSelect.value);
      if (repo) {
        if (!repo.cloned) {
          problem.textContent = `"${repo.fullName}" is not cloned locally. Clone it, or point its path at the clone on the Repos page.`;
          return;
        }
        payload.workspaceDir = repo.localPath;
      }
    } else if (workspaceInput.value.trim()) {
      payload.workspaceDir = workspaceInput.value.trim();
    }
    // Always sent, never omitted: the server's default is more generous than
    // the harness's, and a run should record the budget it actually ran under.
    payload.maxTurns = selectedTurns();

    submit.disabled = true;
    problem.textContent = '';
    try {
      await onSubmit(payload);
    } catch (err) {
      submit.disabled = false;
      problem.textContent = err.problems ? err.problems.join(' ') : err.message;
    }
  };

  submit.addEventListener('click', run);
  textarea.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  });

  // Rewriting the prompt in place: the model returns a clearer version of the
  // text, and the original is kept behind Undo so a rewrite is never the last
  // word on what the reader wrote. Nothing is sent until Start run.
  const optimizeButton = el('button', {
    class: 'btn',
    type: 'button',
    text: 'Optimize prompt',
    title: 'Rewrite your text into a clearer task prompt. Review it, then send.'
  });
  const undoButton = el('button', { class: 'btn', type: 'button', text: 'Undo', hidden: true });
  const matchedChip = el('span', { class: 'chip chip--neutral composer__matched-chip', style: 'display:none' });
  let previousPrompt = null;
  const optimizeTools = onOptimize
    ? el('div', { class: 'composer__tools' }, [
      optimizeButton,
      undoButton,
      matchedChip,
      el('span', { class: 'hint', text: 'Rewrites your text into a task prompt. Nothing runs until you send.' })
    ])
    : null;

  const showMatchedPlaybook = (playbookId, isKeyword = false) => {
    if (!playbookId) {
      matchedChip.style.display = 'none';
      return;
    }
    playbookSelect.value = playbookId;
    const title = (config?.playbooks || []).find((p) => p.id === playbookId)?.title || playbookId;
    matchedChip.textContent = `Matched playbook: ${title}${isKeyword ? ' (keyword)' : ''}`;
    matchedChip.style.display = 'inline-flex';
  };

  const runOptimize = async () => {
    const text = textarea.value.trim();
    if (text === '') {
      problem.textContent = 'Write a request first, then optimize it.';
      textarea.focus();
      return;
    }
    optimizeButton.disabled = true;
    optimizeButton.textContent = 'Optimizing…';
    if (!targetProjectId || projectExists) {
      if (!truncatedNote) problem.textContent = '';
    }
    try {
      const doc = await onOptimize({
        prompt: text,
        // If the reader pinned a playbook, the rewrite targets it; otherwise
        // the server classifies the text to pick the playbook itself.
        playbook: playbookSelect.value || undefined,
        lane: laneSelect.value || undefined
      });
      const optimized = typeof doc?.prompt === 'string' ? doc.prompt.trim() : '';
      if (optimized && optimized !== text) {
        previousPrompt = textarea.value;
        textarea.value = optimized;
        undoButton.hidden = false;
        textarea.focus();
      }
      if (doc?.playbook) {
        showMatchedPlaybook(doc.playbook, doc.unreachable === true);
      }
      if (doc?.warning) {
        problem.textContent = doc.warning;
      }
    } catch (err) {
      let fallbackDone = false;
      if (onClassify) {
        try {
          const classDoc = await onClassify({ prompt: text });
          if (classDoc?.playbook) {
            showMatchedPlaybook(classDoc.playbook, true);
            fallbackDone = true;
          }
        } catch {}
      }
      const isUnreachable = err?.status === 502 || err?.kind === 'unreachable' || /reach|unreachable|connect/i.test(err?.message || '');
      if (isUnreachable) {
        problem.textContent = 'The bridge is unreachable; fell back to keyword scoring for playbook.';
      } else if (!fallbackDone) {
        problem.textContent = err.problems ? err.problems.join(' ') : err.message;
      }
    } finally {
      optimizeButton.disabled = false;
      optimizeButton.textContent = 'Optimize prompt';
    }
  };

  if (onOptimize) {
    optimizeButton.addEventListener('click', runOptimize);
    undoButton.addEventListener('click', () => {
      if (previousPrompt === null) return;
      textarea.value = previousPrompt;
      previousPrompt = null;
      undoButton.hidden = true;
      textarea.focus();
    });
  }

  if (autoOptimize && onOptimize && textarea.value.trim() !== '') {
    setTimeout(runOptimize, 0);
  }

  const box = el('div', { class: 'composer', onClick: (e) => e.stopPropagation() }, [
    el('div', { class: 'composer__head', text: 'New run' }),
    textarea,
    optimizeTools,
    el('div', { class: 'composer__controls' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Playbook' }), playbookSelect]),
      el('div', { class: 'field' }, [el('label', { text: 'Provider lane' }), laneSelect]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Policy' }),
        policySelect,
        el('div', { class: 'field__hint' },
          'The harness decides under a non-interactive stdin, so approval is a run-level choice.')
      ]),
      workspaceField,
      el('div', { class: 'field' }, [
        el('label', { text: 'Project' }),
        projectSelect,
        el('div', { class: 'field__hint' }, 'A project fixes the workspace and pre-selects its defaults.')
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'How much work' }),
        turnsSelect,
        turnsInput,
        turnsHint
      ]),
      autoPrField,
      problem
    ]),
    el('div', { class: 'composer__foot' }, [
      submit,
      el('span', { class: 'hint' }, [
        el('span', { class: 'kbd', text: 'Ctrl' }),
        ' + ',
        el('span', { class: 'kbd', text: 'Enter' }),
        ' to start, ',
        el('span', { class: 'kbd', text: 'Esc' }),
        ' to close'
      ]),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: onClose })
    ])
  ]);

  const overlay = el('div', { class: 'overlay', onClick: onClose }, [box]);
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') onClose();
  });
  setTimeout(() => textarea.focus(), 0);
  return overlay;
}

/**
 * A project as a page: its directory and bookkeeping at the top, its runs
 * below, reusing the same run cards as the main list.
 */
export function renderProjectPage(project, { selectedId, onOpen, onNewRun, onEdit, onDelete }) {
  const runs = project.runs || [];
  const running = runs.filter((r) => r.live || r.status === 'running' || r.status === 'starting');

  return el('div', { class: 'page page--wide' }, [
    el('header', { class: 'page__header' }, [
      el('div', { class: 'page__icon-box' }, [renderIcon('folder', 'page__header-icon')]),
      el('div', { class: 'page__badge' }, [
        el('span', { class: 'chip chip--neutral', text: 'project' })
      ]),
      el('h1', { class: 'page__title', text: project.name }),
      el('div', { class: 'page__meta', text: project.dir })
    ]),
    el('div', { class: 'props' }, [
      el('div', { class: 'props__row', dataset: { key: 'directory' } }, [
        el('div', { class: 'props__key' }, [
          renderIcon('folder', 'props__icon'),
          el('span', { class: 'props__key-label', text: 'Directory' })
        ]),
        el('div', { class: 'props__val props__val--mono', text: project.dir })
      ]),
      el('div', { class: 'props__row', dataset: { key: 'runs' } }, [
        el('div', { class: 'props__key' }, [
          renderIcon('runs', 'props__icon'),
          el('span', { class: 'props__key-label', text: 'Runs' })
        ]),
        el('div', { class: 'props__val', text: `${runs.length}${project.hasMore ? '+' : ''}${running.length > 0 ? ` (${running.length} running)` : ''}` })
      ]),
      ...(project.defaultAutoPr !== null && project.defaultAutoPr !== undefined ? [
        el('div', { class: 'props__row', dataset: { key: 'autoPr' } }, [
          el('div', { class: 'props__key' }, [
            renderIcon('github', 'props__icon'),
            el('span', { class: 'props__key-label', text: 'Auto-PR' })
          ]),
          el('div', { class: 'props__val' }, [
            el('span', {
              class: project.defaultAutoPr ? 'chip chip--ok' : 'chip chip--neutral',
              text: project.defaultAutoPr ? 'enabled by default' : 'disabled by default'
            })
          ])
        ])
      ] : []),
      ...(project.defaultPolicy ? [
        el('div', { class: 'props__row', dataset: { key: 'policy' } }, [
          el('div', { class: 'props__key' }, [
            renderIcon('check', 'props__icon'),
            el('span', { class: 'props__key-label', text: 'Policy' })
          ]),
          el('div', { class: 'props__val', text: project.defaultPolicy })
        ])
      ] : []),
      ...(project.defaultPlaybook ? [
        el('div', { class: 'props__row', dataset: { key: 'playbook' } }, [
          el('div', { class: 'props__key' }, [
            renderIcon('task', 'props__icon'),
            el('span', { class: 'props__key-label', text: 'Playbook' })
          ]),
          el('div', { class: 'props__val', text: project.defaultPlaybook })
        ])
      ] : [])
    ]),
    el('div', { style: 'display:flex; gap:10px; margin:18px 0' }, [
      el('button', { class: 'btn btn--primary', type: 'button', text: 'New run in this project', onClick: () => onNewRun(project) }),
      el('button', { class: 'btn', type: 'button', text: 'Rename or re-point', onClick: onEdit }),
      el('button', { class: 'btn btn--danger', type: 'button', text: 'Delete project', onClick: onDelete })
    ]),
    runs.length === 0
      ? el('div', { class: 'empty' }, [
        el('h2', { text: 'No runs here yet' }),
        el('p', { text: 'Start the first one above. Runs started on the command line land here too, as long as they were started under this project.' })
      ])
      : renderRunList({
        runs,
        hasMore: !!project.hasMore,
        liveCount: running.length,
        selectedId,
        onOpen,
        onLoadMore: null,
        query: ''
      })
  ]);
}

/** Create or edit a project. Shows every validation problem at once. */
export function renderProjectDialog({ existing, playbooks, policies, turnPresets, defaultMaxTurns, onClose, onSubmit }) {
  const nameInput = el('input', { type: 'text', name: 'name', placeholder: 'Website redesign' });
  const dirInput = el('input', { type: 'text', name: 'dir', placeholder: 'C:\\code\\site or /home/you/site' });
  const playbookSelect = el('select', { name: 'defaultPlaybook' }, [
    el('option', { value: '', text: 'No default — auto-detect each run' }),
    ...((playbooks || []).map((p) => el('option', { value: p.id, text: `${p.id} — ${p.title}` })))
  ]);
  const policySelect = el('select', { name: 'defaultPolicy' }, [
    el('option', { value: '', text: 'No default — read-only each run' }),
    ...((policies || []).map((p) => el('option', { value: p.id, text: `${p.label} — ${p.id}` })))
  ]);
  // The turn budget a run in this project starts with. It pre-fills the
  // composer rather than capping anything: a project whose work is usually
  // long should not make the reader guess a number every time.
  const turnsSelect = el('select', { name: 'defaultMaxTurns' }, [
    el('option', { value: '', text: 'No default — use the server default' }),
    ...((turnPresets || []).map((p) => el('option', { value: String(p.turns), text: `${p.label} — ${p.turns} turns` })))
  ]);
  if (existing) {
    nameInput.value = existing.name || '';
    dirInput.value = existing.dir || '';
    // A default naming something this server no longer knows is shown, not
    // hidden: hiding it would silently drop a preference on save.
    if (existing.defaultPlaybook) {
      if (![...playbookSelect.options].some((o) => o.value === existing.defaultPlaybook)) {
        playbookSelect.append(el('option', {
          value: existing.defaultPlaybook,
          text: `${existing.defaultPlaybook} — unknown to this server`,
          selected: true
        }));
      } else {
        playbookSelect.value = existing.defaultPlaybook;
      }
    }
    if (existing.defaultPolicy) policySelect.value = existing.defaultPolicy;
    if (existing.defaultMaxTurns) {
      const asPreset = [...turnsSelect.options].some(
        (o) => o.value === String(existing.defaultMaxTurns)
      );
      if (asPreset) {
        turnsSelect.value = String(existing.defaultMaxTurns);
      } else {
        turnsSelect.append(el('option', {
          value: String(existing.defaultMaxTurns),
          text: `Custom — ${existing.defaultMaxTurns} turns`,
          selected: true
        }));
      }
    }
  } else if (defaultMaxTurns) {
    turnsSelect.value = String(defaultMaxTurns);
  }
  const problem = el('div', { class: 'composer__warning' });
  const submit = el('button', {
    class: 'btn btn--primary',
    type: 'button',
    text: existing ? 'Save changes' : 'Create project'
  });

  const currentDefaults = () => ({
    defaultPlaybook: playbookSelect.value === '' ? null : playbookSelect.value,
    defaultPolicy: policySelect.value === '' ? null : policySelect.value,
    defaultMaxTurns: turnsSelect.value === '' ? null : Number(turnsSelect.value)
  });

  const save = async () => {
    const payload = {};
    if (nameInput.value.trim() !== (existing?.name || '')) payload.name = nameInput.value.trim();
    if (dirInput.value.trim() !== (existing?.dir || '')) payload.dir = dirInput.value.trim();
    const next = currentDefaults();
    const prev = {
      defaultPlaybook: existing?.defaultPlaybook ?? null,
      defaultPolicy: existing?.defaultPolicy ?? null,
      defaultMaxTurns: existing?.defaultMaxTurns ?? null
    };
    if (next.defaultPlaybook !== prev.defaultPlaybook) payload.defaultPlaybook = next.defaultPlaybook;
    if (next.defaultPolicy !== prev.defaultPolicy) payload.defaultPolicy = next.defaultPolicy;
    // Sent as '' rather than null when clearing: the server reads an empty
    // value as "no default", and a null would be a different claim about it.
    if (next.defaultMaxTurns !== prev.defaultMaxTurns) {
      payload.defaultMaxTurns = next.defaultMaxTurns === null ? '' : next.defaultMaxTurns;
    }
    if (existing && Object.keys(payload).length === 0) {
      onClose();
      return;
    }
    submit.disabled = true;
    problem.textContent = '';
    try {
      // An empty string clears a default: the server treats it as absent, and
      // sending the key with a null would read as a different claim.
      const createPayload = existing
        ? payload
        : {
          name: nameInput.value.trim(),
          dir: dirInput.value.trim(),
          ...(next.defaultPlaybook ? { defaultPlaybook: next.defaultPlaybook } : {}),
          ...(next.defaultPolicy ? { defaultPolicy: next.defaultPolicy } : {}),
          ...(next.defaultMaxTurns !== null ? { defaultMaxTurns: next.defaultMaxTurns } : {})
        };
      await onSubmit(createPayload);
    } catch (err) {
      submit.disabled = false;
      problem.textContent = err.problems ? err.problems.join(' ') : err.message;
    }
  };

  submit.addEventListener('click', save);

  const box = el('div', { class: 'composer', onClick: (e) => e.stopPropagation() }, [
    el('div', { class: 'composer__head', text: existing ? 'Edit project' : 'New project' }),
    el('div', { class: 'composer__controls' }, [
      el('div', { class: 'field' }, [
        el('label', { text: 'Name' }),
        nameInput
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Directory' }),
        dirInput,
        el('div', { class: 'field__hint' }, 'The folder runs in this project execute in. It must already exist.')
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Default playbook' }),
        playbookSelect,
        el('div', { class: 'field__hint' }, 'Pre-selected when a run starts in this project. The reader can still pick another.')
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Default policy' }),
        policySelect,
        el('div', { class: 'field__hint' }, 'Pre-selected when a run starts in this project.')
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Default work size' }),
        turnsSelect,
        el('div', { class: 'field__hint' }, 'Pre-selected when a run starts in this project. Runs extend themselves if they need more.')
      ]),
      problem
    ]),
    el('div', { class: 'composer__foot' }, [
      submit,
      el('span', { class: 'hint' }, [
        el('span', { class: 'kbd', text: 'Esc' }),
        ' to close'
      ]),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: onClose })
    ])
  ]);

  const overlay = el('div', { class: 'overlay', onClick: onClose }, [box]);
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') onClose();
  });
  setTimeout(() => nameInput.focus(), 0);
  return overlay;
}

/** Rename one run. An empty title clears the custom one and restores the derived title. */
export function renderRenameRunDialog({ page, onClose, onSubmit }) {
  const titleInput = el('input', { type: 'text', name: 'title', placeholder: page.title || 'A name for this run' });
  const problem = el('div', { class: 'composer__warning' });
  const submit = el('button', { class: 'btn btn--primary', type: 'button', text: 'Rename run' });

  const save = async () => {
    submit.disabled = true;
    problem.textContent = '';
    try {
      // Empty means "clear": the server deletes the stored title and the page
      // falls back to the derived one, so the dialog must not refuse it.
      await onSubmit({ title: titleInput.value.trim() });
    } catch (err) {
      submit.disabled = false;
      problem.textContent = err.problems ? err.problems.join(' ') : err.message;
    }
  };

  submit.addEventListener('click', save);

  const box = el('div', { class: 'composer', onClick: (e) => e.stopPropagation() }, [
    el('div', { class: 'composer__head', text: 'Rename run' }),
    el('div', { class: 'composer__controls' }, [
      el('div', { class: 'field' }, [
        el('label', { text: 'Title' }),
        titleInput,
        el('div', { class: 'field__hint' }, 'Leave empty to restore the title derived from the prompt.')
      ]),
      problem
    ]),
    el('div', { class: 'composer__foot' }, [
      submit,
      el('span', { class: 'hint' }, [
        el('span', { class: 'kbd', text: 'Esc' }),
        ' to close'
      ]),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: onClose })
    ])
  ]);

  const overlay = el('div', { class: 'overlay', onClick: onClose }, [box]);
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') onClose();
  });
  setTimeout(() => {
    titleInput.focus();
    titleInput.select();
  }, 0);
  return overlay;
}

/** Move one run to another project, or detach it from projects entirely. */
export function renderMoveRunDialog({ page, projects, onClose, onSubmit }) {
  const projectSelect = el('select', { name: 'project' }, [
    el('option', { value: '', text: 'No project — detach this run' }),
    ...((projects || []).map((p) => el('option', {
      value: p.id,
      text: `${p.name} — ${p.dir}`,
      selected: page.projectId === p.id
    })))
  ]);
  const problem = el('div', { class: 'composer__warning' });
  const submit = el('button', { class: 'btn btn--primary', type: 'button', text: 'Move run' });

  const save = async () => {
    submit.disabled = true;
    problem.textContent = '';
    try {
      // The empty option detaches: the server stores an explicit null, which
      // the projections read as "no project" rather than "unknown".
      await onSubmit({ projectId: projectSelect.value === '' ? null : projectSelect.value });
    } catch (err) {
      submit.disabled = false;
      problem.textContent = err.problems ? err.problems.join(' ') : err.message;
    }
  };

  submit.addEventListener('click', save);

  const box = el('div', { class: 'composer', onClick: (e) => e.stopPropagation() }, [
    el('div', { class: 'composer__head', text: 'Move run to project' }),
    el('div', { class: 'composer__controls' }, [
      el('div', { class: 'field' }, [
        el('label', { text: 'Project' }),
        projectSelect,
        el('div', { class: 'field__hint' }, 'Moving changes where the run lists, not where it executed.')
      ]),
      problem
    ]),
    el('div', { class: 'composer__foot' }, [
      submit,
      el('span', { class: 'hint' }, [
        el('span', { class: 'kbd', text: 'Esc' }),
        ' to close'
      ]),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: onClose })
    ])
  ]);

  const overlay = el('div', { class: 'overlay', onClick: onClose }, [box]);
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') onClose();
  });
  setTimeout(() => projectSelect.focus(), 0);
  return overlay;
}

/**
 * Git work on a workspace: status, pull (ff-only), merge, commit.
 *
 * The safe set, one control used wherever a directory becomes a working
 * tree: the repos page per clone, and a run page for the workspace the run
 * executed in. Nothing pushes, nothing forces; the result area is the
 * operation's own words, so a refusal explains itself.
 */
export function renderGitWork({ onAction, defaultBranch = '', defaultCommitMessage = '' }) {
  const result = el('div', { class: 'git-result mono', hidden: true });
  const show = (text, ok) => {
    result.hidden = false;
    result.textContent = text;
    result.classList.toggle('git-result--error', ok !== true);
  };

  const statusButton = el('button', { class: 'btn', type: 'button', text: 'Status' });
  const pullButton = el('button', { class: 'btn', type: 'button', text: 'Pull' });
  const mergeButton = el('button', { class: 'btn', type: 'button', text: 'Merge…' });
  const commitButton = el('button', { class: 'btn', type: 'button', text: 'Commit entire tree…' });
  const buttons = [statusButton, pullButton, mergeButton, commitButton];

  const mergeForm = el('div', { class: 'git-form', hidden: true }, [
    el('input', {
      type: 'text',
      class: 'git-input',
      value: defaultBranch,
      placeholder: defaultBranch || 'origin/main',
      spellcheck: 'false'
    }),
    el('button', { class: 'btn btn--primary', type: 'button', text: 'Merge' }),
    el('button', { class: 'btn', type: 'button', text: 'Cancel' })
  ]);
  const commitForm = el('div', { class: 'git-form', hidden: true }, [
    el('input', {
      type: 'text',
      class: 'git-input',
      value: defaultCommitMessage,
      placeholder: 'a commit message',
      spellcheck: 'false'
    }),
    el('button', { class: 'btn btn--primary', type: 'button', text: 'Commit' }),
    el('button', { class: 'btn', type: 'button', text: 'Cancel' })
  ]);
  const [mergeBranchInput, mergeGo, mergeCancel] = mergeForm.children;
  const [commitMessageInput, commitGo, commitCancel] = commitForm.children;
  const controls = [...buttons, ...mergeForm.children, ...commitForm.children];

  const closeForms = () => {
    mergeForm.hidden = true;
    commitForm.hidden = true;
  };
  mergeButton.addEventListener('click', () => {
    const open = !mergeForm.hidden;
    closeForms();
    mergeForm.hidden = open;
    if (!open) mergeBranchInput.focus();
  });
  commitButton.addEventListener('click', () => {
    const open = !commitForm.hidden;
    closeForms();
    commitForm.hidden = open;
    if (!open) commitMessageInput.focus();
  });
  mergeCancel.addEventListener('click', () => { mergeForm.hidden = true; });
  commitCancel.addEventListener('click', () => { commitForm.hidden = true; });

  let busy = false;
  const act = async (payload) => {
    if (busy || !payload) return;
    busy = true;
    for (const control of controls) control.disabled = true;
    result.hidden = true;
    try {
      const doc = await onAction(payload);
      if (payload.op === 'status' && doc?.status) {
        const s = doc.status;
        const lines = [
          `${s.branch}${s.tracking ? ` vs ${s.tracking}` : ''}` +
            (s.ahead || s.behind ? ` — ahead ${s.ahead}, behind ${s.behind}` : '') +
            (s.clean ? ' — clean' : ` — ${s.changed} changed file${s.changed === 1 ? '' : 's'}`)
        ];
        for (const c of (s.changes || []).slice(0, 20)) {
          lines.push(`${c.status || 'M'}  ${c.path}`);
        }
        if (s.changed > 20) lines.push(`… ${s.changed - 20} more`);
        show(lines.join('\n'), true);
      } else if (doc?.nothing) {
        show(doc.output || 'Nothing to commit.', true);
      } else {
        show(doc?.output || (doc?.sha ? `Committed ${doc.sha}.` : 'Done.'), true);
      }
      closeForms();
    } catch (err) {
      show(err.problems ? err.problems.join('\n') : err.message, false);
    } finally {
      busy = false;
      for (const control of controls) control.disabled = false;
    }
  };

  statusButton.addEventListener('click', () => act({ op: 'status' }));
  // A pull that is not a fast-forward is refused by git with its own words,
  // which is exactly what the reader should see rather than a surprise merge.
  pullButton.addEventListener('click', () => {
    if (!window.confirm('Pull with --ff-only? A divergence is refused, never merged.')) return;
    act({ op: 'pull' });
  });
  mergeGo.addEventListener('click', () => {
    const branch = mergeBranchInput.value.trim();
    if (branch === '') {
      show('A merge needs a branch.', false);
      return;
    }
    if (!window.confirm(`Merge ${branch} into the current branch?`)) return;
    act({ op: 'merge', branch });
  });
  commitGo.addEventListener('click', () => {
    const message = commitMessageInput.value.trim();
    if (message === '') {
      show('A commit needs a message.', false);
      return;
    }
    if (!window.confirm(`Stage and commit the ENTIRE working tree, including changes unrelated to this run, with message "${message}"? Nothing is pushed.`)) return;
    act({ op: 'commit', message });
  });

  return el('div', { class: 'git-work' }, [
    el('div', { class: 'git-bar' }, buttons),
    el('p', { class: 'hint', text: 'Commit includes the entire working tree, not just run changes. Pull and merge require a clean tree. Mutations are blocked during active runs. Nothing is pushed.' }),
    mergeForm,
    commitForm,
    result
  ]);
}

/**
 * The GitHub repos page: the synced catalogue, one sync button.
 *
 * Syncing is manual on purpose — no polling, no background traffic — so the
 * page is a snapshot the reader refreshes when they want a newer one. Each
 * repo row carries its local clone path, editable in place, because the path
 * is the guess the sync made and the reader's machine is the authority.
 */
export function renderGithubPage({ github, syncing, onSync, onSetPath, onGitAction }) {
  const configured = !!github?.configured;
  const repos = github?.repos || [];

  const syncButton = el('button', {
    class: 'btn btn--primary',
    type: 'button',
    text: syncing ? 'Syncing…' : 'Sync now',
    disabled: !configured || syncing
  });
  syncButton.addEventListener('click', () => onSync?.());

  const heroHeader = el('header', { class: 'page__header' }, [
    el('div', { class: 'page__icon-box' }, [renderIcon('github', 'page__header-icon')]),
    el('div', { class: 'page__badge' }, [el('span', { class: 'chip chip--neutral', text: 'system' })]),
    el('h1', { class: 'page__title', text: 'GitHub repos' }),
    el('div', { class: 'page__meta', text: 'Synced repositories, branch status, and local workspace paths.' })
  ]);

  const head = el('div', { class: 'panel' }, [
    el('div', { class: 'panel__title' }, [
      renderIcon('github', 'panel__icon'),
      el('span', { text: 'GitHub connection' })
    ]),
    configured
      ? el('p', { class: 'hint', style: 'margin:0 0 10px' }, [
          github?.login ? `Signed in as ${github.login}. ` : 'GitHub authentication is available. ',
          github?.syncedAt
            ? `Last synced ${relativeTime(github.syncedAt)} (${github.syncedAt}). `
            : 'Never synced. ',
          `Clone paths guessed under ${github?.baseDir || 'the default base directory'}, editable per repo.`
        ])
      : el('p', { class: 'hint', style: 'margin:0 0 10px' }, [
          'No GitHub token. Set ',
          el('span', { class: 'mono', text: 'GITHUB_TOKEN' }),
          ' in a ',
          el('span', { class: 'mono', text: '.env' }),
          ' file next to the server (or export it), or run gh auth login. Restart the server, then sync.'
        ]),
    el('div', { style: 'display:flex; gap:10px; align-items:center' }, [
      syncButton,
      repos.length > 0
        ? el('span', { class: 'hint', text: `${repos.length} repo${repos.length === 1 ? '' : 's'}, ${repos.filter((r) => r.cloned).length} cloned locally` })
        : null
    ])
  ]);

  if (repos.length === 0) {
    return el('div', { class: 'page page--wide' }, [
      heroHeader,
      head,
      el('div', { class: 'panel' }, [
        el('p', { class: 'hint', style: 'margin:0' },
          'Nothing synced yet. Sync to list your GitHub repos here, then pick one as the workspace when starting a run.')
      ])
    ]);
  }

  const rows = repos.map((repo) => {
    const pathInput = el('input', {
      type: 'text',
      class: 'repo-path',
      value: repo.localPath,
      spellcheck: 'false'
    });
    const saveButton = el('button', { class: 'btn', type: 'button', text: 'Save path', disabled: true });
    const note = el('span', {
      class: 'hint',
      text: repo.cloned ? '' : 'Not cloned locally — this repo cannot be a run workspace until it is.'
    });
    const syncSave = () => {
      saveButton.disabled = pathInput.value.trim() === repo.localPath || pathInput.value.trim() === '';
    };
    pathInput.addEventListener('input', syncSave);
    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true;
      saveButton.textContent = 'Saving…';
      note.textContent = '';
      try {
        await onSetPath?.({ fullName: repo.fullName, localPath: pathInput.value.trim() });
        saveButton.textContent = 'Saved';
        setTimeout(() => { saveButton.textContent = 'Save path'; }, 1500);
      } catch (err) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save path';
        note.textContent = err.problems ? err.problems.join(' ') : err.message;
      }
    });

    return el('tr', { dataset: { repo: repo.fullName } }, [
      el('td', {}, [
        repo.htmlUrl
          ? el('a', { href: repo.htmlUrl, target: '_blank', rel: 'noopener noreferrer', class: 'repo-name', text: repo.fullName })
          : el('span', { class: 'repo-name', text: repo.fullName }),
        repo.private ? el('span', { class: 'chip chip--neutral', style: 'margin-left:8px', text: 'private' }) : null
      ]),
      el('td', { class: 'mono', text: repo.defaultBranch || '—' }),
      el('td', { text: relativeTime(repo.updatedAt) || '—' }),
      el('td', {}, [
        el('span', { class: `dot ${repo.cloned ? 'dot--ok' : 'dot--error'}`, title: repo.cloned ? 'Cloned locally' : 'Not cloned locally' }),
        el('span', { class: 'hint', style: 'margin-left:6px', text: repo.cloned ? 'cloned' : 'missing' })
      ]),
      el('td', {}, [pathInput, ' ', saveButton, note,
        repo.cloned && onGitAction ? renderGitWork({
          defaultBranch: repo.defaultBranch ? `origin/${repo.defaultBranch}` : '',
          onAction: (payload) => onGitAction({ ...payload, fullName: repo.fullName })
        }) : null
      ])
    ]);
  });

  return el('div', { class: 'page page--wide' }, [
    heroHeader,
    head,
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel__title' }, [
        renderIcon('folder', 'panel__icon'),
        el('span', { text: 'Synced repos' })
      ]),
      el('table', { class: 'data repo-table' }, [
        el('tr', {}, [
          el('th', { text: 'Repo' }),
          el('th', { text: 'Branch' }),
          el('th', { text: 'Updated' }),
          el('th', { text: 'Clone' }),
          el('th', { text: 'Local path' })
        ]),
        ...rows
      ])
    ])
  ]);
}
