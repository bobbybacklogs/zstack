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
  const list = Array.isArray(children) ? children : [children];
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

    case 'tool':
      return el('div', { class: `block block--tool tone-${tone}` }, [
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
    archived: 'ok'
  }[status] || status;
  return el('span', { class: `chip chip--${tone || 'neutral'}`, text: label });
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
export function renderPageHeader(page, { onCancel, onOpenProject, onRename, onMove, onDelete }) {
  const meta = [];
  if (page.at) meta.push(relativeTime(page.at));
  if (page.counts?.turns) meta.push(`${page.counts.turns} turns`);
  if (page.counts?.toolCalls) meta.push(`${page.counts.toolCalls} tool calls`);
  if (page.counts?.fileChanges) meta.push(`${page.counts.fileChanges} files changed`);

  const head = el('header', {}, [
    el('div', { class: 'page__badge' }, [
      statusChip(page.status, page.tone),
      el('span', { text: page.badge }),
      // A run whose project was deleted keeps its projectId but resolves to
      // no name, so there is nothing to link to. Omission, not a dead link.
      // The whole conditional is the chip: `el` skips false children, so each
      // clause is spelled out rather than nested ternaries.
      page.projectName && page.projectId && onOpenProject
        ? el('button', {
          class: 'chip chip--project',
          type: 'button',
          text: String(page.projectName),
          onClick: () => onOpenProject(page.projectId)
        })
        : null
    ]),
    el('h1', { class: 'page__title', text: page.title }),
    el('div', { class: 'page__meta', text: meta.join('  ·  ') })
  ]);

  if (page.live && (page.status === 'running' || page.status === 'starting') && onCancel) {
    head.append(el('div', { style: 'margin: 10px 0' }, [
      el('button', { class: 'btn btn--danger', type: 'button', text: 'Stop run', onClick: onCancel })
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
    (page.props || []).map((prop) =>
      el('div', { class: 'props__row' }, [
        el('div', { class: 'props__key', text: prop.label }),
        el('div', {
          class: `props__val${/model|workspace|files|role/.test(prop.key) ? ' props__val--mono' : ''}`,
          text: prop.value
        })
      ])
    )
  );

  return [head, props];
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
        el('span', { class: 'dot dot--error' }),
        el('span', { text: 'Role mappings' })
      ]),
      el('p', { class: 'hint', text: `Unavailable while the bridge is down: ${status.error || 'unknown error'}` })
    ]);
  }
  const mapping = status.mapping || {};
  return el('div', { class: 'panel' }, [
    el('div', { class: 'panel__title' }, [
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
  const budget = config?.budget || {};
  const makeSelect = (label, name, options, selected, hint) => {
    const select = el('select', { name },
      options.map((opt) =>
        el('option', { value: opt.id, text: opt.label, selected: opt.id === selected })
      )
    );
    return el('div', { class: 'field' }, [
      el('label', { text: label }),
      select,
      hint ? el('div', { class: 'field__hint', text: hint }) : null
    ]);
  };

  const tierSelect = makeSelect(
    'Budget tier',
    'tier',
    (config?.tiers || []).map((t) => ({ id: t, label: t })),
    budget.tier,
    'Higher tiers map roles to stronger models.'
  );
  const sourceSelect = makeSelect(
    'Model source',
    'source',
    [
      { id: 'catalog', label: 'catalog' },
      { id: 'config', label: 'config' }
    ],
    budget.source,
    'config uses the models pinned in your ModelHitch config.'
  );
  const laneSelect = makeSelect(
    'Provider lane',
    'lane',
    (config?.lanes || []).map((l) => ({ id: l.id, label: l.name || l.id })),
    budget.lane,
    'Which provider family role models resolve from.'
  );

  const state = { tier: budget.tier, source: budget.source, lane: budget.lane };
  for (const [key, node] of [['tier', tierSelect], ['source', sourceSelect], ['lane', laneSelect]]) {
    node.querySelector('select').addEventListener('change', (event) => {
      state[key] = event.target.value;
    });
  }

  const note = el('div', { class: 'field__hint' });
  const apply = el('button', {
    class: 'btn btn--primary',
    type: 'button',
    text: 'Apply mapping',
    onClick: async () => {
      apply.disabled = true;
      note.textContent = '';
      try {
        await onApply({ ...state });
        note.textContent = 'Mapping updated.';
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
      el('div', { class: 'panel__title', text: 'Model routing' }),
      el('p', { class: 'hint', style: 'margin:0 0 14px' },
        'These decide which model every role resolves to, for runs started here and from the command line.'),
      el('div', { class: 'grid2' }, [tierSelect, sourceSelect, laneSelect]),
      el('div', { style: 'margin-top:14px; display:flex; gap:10px; align-items:center' }, [apply, note]),
      status && status.laneApplied === false
        ? el('p', { class: 'hint', style: 'margin-top:10px' },
          'Your ModelHitch config pins the models, so the lane is recorded but not applied.')
        : null
    ]),
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel__title', text: 'Resolved roles' }),
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
export function renderComposer({ config, health, projects, presetProjectId, defaults, onClose, onSubmit }) {
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
  const projectSelect = el('select', { name: 'project' }, [
    el('option', { value: '', text: 'No project' }),
    ...((projects || []).map((p) =>
      el('option', {
        value: p.id,
        text: `${p.name} — ${p.dir}`,
        selected: presetProjectId === p.id
      })
    ))
  ]);
  const workspaceInput = el('input', {
    type: 'text',
    name: 'workspaceDir',
    placeholder: defaults.workspaceDir || 'the directory this server was started in'
  });
  if (defaults.workspaceDir) workspaceInput.value = defaults.workspaceDir;
  const turnsInput = el('input', { type: 'number', name: 'maxTurns', min: '1', placeholder: '8' });

  // A project and a freeform workspace cannot both decide where the run
  // executes. Picking a project locks the field to the project's directory so
  // the reader sees the server's rule rather than discovering it as an error.
  // The project's defaults pre-select the playbook and policy, but an explicit
  // choice always wins: a default that overrides the reader is a trap.
  const syncProjectState = ( { keepChoices = false } = {}) => {
    const chosen = (projects || []).find((p) => p.id === projectSelect.value);
    if (chosen) {
      workspaceInput.value = chosen.dir;
      workspaceInput.disabled = true;
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
      }
    } else {
      workspaceInput.disabled = false;
      if (!defaults.workspaceDir) workspaceInput.value = '';
      if (!keepChoices) {
        playbookSelect.value = '';
        policySelect.value = 'read-only';
        delete playbookSelect.dataset.projectDefaultUnknown;
      }
    }
  };
  projectSelect.addEventListener('change', () => syncProjectState());
  for (const select of [playbookSelect, policySelect]) {
    select.addEventListener('change', () => syncProjectState({ keepChoices: true }));
  }
  syncProjectState();

  const problem = el('div', { class: 'composer__warning' });
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
    // The server takes the directory from the stored project, so the payload
    // carries the id, never the path.
    if (projectSelect.value) payload.projectId = projectSelect.value;
    else if (workspaceInput.value.trim()) payload.workspaceDir = workspaceInput.value.trim();
    if (turnsInput.value) payload.maxTurns = Number(turnsInput.value);

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

  const box = el('div', { class: 'composer', onClick: (e) => e.stopPropagation() }, [
    el('div', { class: 'composer__head', text: 'New run' }),
    textarea,
    el('div', { class: 'composer__controls' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Playbook' }), playbookSelect]),
      el('div', { class: 'field' }, [el('label', { text: 'Provider lane' }), laneSelect]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Policy' }),
        policySelect,
        el('div', { class: 'field__hint' },
          'The harness decides under a non-interactive stdin, so approval is a run-level choice.')
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'Workspace' }), workspaceInput]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Project' }),
        projectSelect,
        el('div', { class: 'field__hint' }, 'A project fixes the workspace and pre-selects its defaults.')
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Max turns' }),
        turnsInput,
        el('div', { class: 'field__hint' }, 'Leave blank for the harness default of 8.')
      ]),
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
    el('header', {}, [
      el('div', { class: 'page__badge' }, [
        el('span', { class: 'chip chip--neutral', text: 'project' })
      ]),
      el('h1', { class: 'page__title', text: project.name }),
      el('div', { class: 'page__meta', text: project.dir })
    ]),
    el('div', { class: 'props' }, [
      el('div', { class: 'props__row' }, [
        el('div', { class: 'props__key', text: 'Directory' }),
        el('div', { class: 'props__val props__val--mono', text: project.dir })
      ]),
      el('div', { class: 'props__row' }, [
        el('div', { class: 'props__key', text: 'Runs' }),
        el('div', { class: 'props__val', text: `${runs.length}${project.hasMore ? '+' : ''}${running.length > 0 ? ` (${running.length} running)` : ''}` })
      ])
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
export function renderProjectDialog({ existing, playbooks, policies, onClose, onSubmit }) {
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
  }
  const problem = el('div', { class: 'composer__warning' });
  const submit = el('button', {
    class: 'btn btn--primary',
    type: 'button',
    text: existing ? 'Save changes' : 'Create project'
  });

  const currentDefaults = () => ({
    defaultPlaybook: playbookSelect.value === '' ? null : playbookSelect.value,
    defaultPolicy: policySelect.value === '' ? null : policySelect.value
  });

  const save = async () => {
    const payload = {};
    if (nameInput.value.trim() !== (existing?.name || '')) payload.name = nameInput.value.trim();
    if (dirInput.value.trim() !== (existing?.dir || '')) payload.dir = dirInput.value.trim();
    const next = currentDefaults();
    const prev = {
      defaultPlaybook: existing?.defaultPlaybook ?? null,
      defaultPolicy: existing?.defaultPolicy ?? null
    };
    if (next.defaultPlaybook !== prev.defaultPlaybook) payload.defaultPlaybook = next.defaultPlaybook;
    if (next.defaultPolicy !== prev.defaultPolicy) payload.defaultPolicy = next.defaultPolicy;
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
          ...(next.defaultPolicy ? { defaultPolicy: next.defaultPolicy } : {})
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
