// tinyprobe-app: the page. It shows what `tinyprobe inspect --json` says about the files of a folder, and runs
// `tinyprobe call` and `tinyprobe run` through the launcher, rendering their ndjson events with the run view
// shared with the VS Code extension. Every value from files and runs is set with textContent, never as HTML.
(function () {
  'use strict';

  const core = globalThis.tinyprobeCore;
  const runView = globalThis.tinyprobeRunView;
  const envFile = globalThis.tinyprobeEnvironmentFile;
  const requestHistory = globalThis.tinyprobeHistory;
  const flows = globalThis.tinyprobeFlow;

  /** As in the extension: the last 50 calls, bodies cut at 64 KiB. */
  const HISTORY_SIZE = 50;

  const state = {
    info: null,
    root: null,
    listing: null,
    model: null,
    environment: null,
    selection: { kind: 'home' },
    outcomes: new Map(),
    variables: [],
    history: [],
    // The events of the last run of each workflow, to light its diagram up again; the diagram on screen.
    runs: new Map(),
    flow: null
  };

  // --- Helpers ---------------------------------------------------------------------------------------------

  /** An element with attributes and children; strings become text nodes, so nothing is parsed as HTML. */
  function h(tag, attributes, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes ?? {})) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'class') node.className = value;
      else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
      else if (name in node && typeof value !== 'string') node[name] = value;
      else node.setAttribute(name, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const $ = id => document.getElementById(id);

  function remember(key, value) {
    try {
      localStorage.setItem(`tinyprobe:${key}`, JSON.stringify(value));
    } catch {
      // A private window: the page works, it only forgets.
    }
  }

  function recall(key, fallback) {
    try {
      const value = localStorage.getItem(`tinyprobe:${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  const slash = path => String(path ?? '').replace(/\\/g, '/');
  const baseName = path => slash(path).split('/').filter(Boolean).pop() ?? path;

  class RestartError extends Error {}

  async function api(path, body) {
    const options = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const response = await fetch(path, options);
    if (response.status === 401) {
      showRestart();
      throw new RestartError('restart');
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(json?.error ?? `The app answered ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return json;
  }

  async function text(path) {
    const response = await fetch(path);
    if (response.status === 401) {
      showRestart();
      throw new RestartError('restart');
    }
    if (!response.ok) return null;
    return response.text();
  }

  const query = parameters => new URLSearchParams(parameters).toString();

  // --- Start ---------------------------------------------------------------------------------------------

  async function boot() {
    try {
      state.info = await api('/api/state');
    } catch (e) {
      if (!(e instanceof RestartError)) showFatal(e.message);
      return;
    }
    const fromLink = new URLSearchParams(location.hash.slice(1)).get('folder');
    if (location.hash) history.replaceState(null, '', '/');
    const known = state.info.folders.filter(f => f.exists).map(f => f.path);
    const wanted = [fromLink, recall('root', null), known[0]].find(path => path && known.includes(path));
    renderChrome();
    if (state.info.tinyprobe && wanted) await openRoot(wanted);
    else render();
  }

  async function openRoot(root) {
    state.root = root;
    state.environment = recall(`env:${root}`, null);
    state.selection = { kind: 'home' };
    state.outcomes = new Map();
    remember('root', root);
    $('results').replaceChildren();
    state.history = await api(`/api/history?${query({ root })}`).catch(() => []);
    await loadListing();
  }

  async function loadListing() {
    if (!state.root || !state.info?.tinyprobe) return;
    try {
      state.listing = await api(`/api/folder?${query({ root: state.root })}`);
    } catch (e) {
      if (e instanceof RestartError) return;
      state.listing = null;
      state.model = null;
      state.root = null;
      remember('root', null);
      render();
      showMessage(`The folder could not be read: ${e.message}`);
      return;
    }
    state.model = model(state.listing);
    if (state.environment && !state.listing.environments.includes(state.environment)) state.environment = null;
    // One environment file: nothing to choose.
    if (!state.environment && state.listing.environments.length === 1 && recall(`env:${state.root}`, undefined) === undefined) state.environment = state.listing.environments[0];
    await loadVariables();
    render();
  }

  async function loadVariables() {
    state.variables = [];
    if (!state.environment) return;
    const content = await text(`/api/file?${query({ root: state.root, path: state.environment })}`).catch(() => null);
    if (content !== null) state.variables = core.topLevelKeys(content);
  }

  /** The folder as people look at it: API files with their endpoints, workflows, sequences, and invalid files. */
  function model(listing) {
    const apis = [];
    const workflows = [];
    const sequences = [];
    const invalid = [];
    for (const file of listing.files) {
      const inspect = file.inspect;
      if (!inspect) {
        invalid.push({ path: file.path, errors: [{ text: `${file.path}: tinyprobe could not read this file` }] });
        continue;
      }
      if (!inspect.valid) {
        invalid.push({ path: file.path, errors: inspect.errors ?? [] });
        continue;
      }
      // Endpoints are listed where they are written; a workflow lists those of its imports too.
      const own = (inspect.endpoints ?? []).filter(e => slash(e.location?.file) === file.path || slash(e.location?.file).endsWith(`/${file.path}`));
      if (inspect.kind === 'api') apis.push({ path: file.path, endpoints: own, inspect });
      else if (inspect.kind === 'workflow') {
        workflows.push({ path: file.path, name: inspect.name || baseName(file.path), inspect });
        if (own.length > 0) apis.push({ path: file.path, endpoints: own, inspect, workflow: true });
      } else if (inspect.kind === 'sequence') sequences.push({ path: file.path, name: inspect.name || baseName(file.path), inspect });
    }
    return { apis, workflows, sequences, invalid };
  }

  // --- Rendering -------------------------------------------------------------------------------------------

  function render() {
    renderChrome();
    renderSidebar();
    renderView();
  }

  function renderChrome() {
    const ready = Boolean(state.info?.tinyprobe && state.root && state.listing);
    const folderButton = $('folder-button');
    folderButton.hidden = !state.info?.tinyprobe || !state.root;
    folderButton.replaceChildren(h('span', null, '📁'), h('span', null, baseName(state.root ?? '')), h('span', { 'aria-hidden': 'true' }, '▾'));
    folderButton.title = state.root ?? '';
    $('refresh').hidden = !ready;
    $('env-label').hidden = !ready;
    $('shell').classList.toggle('no-sidebar', !ready);
    if (ready) {
      const select = $('env');
      select.replaceChildren(
        h('option', { value: '' }, 'None'),
        ...state.listing.environments.map(path => h('option', { value: path, selected: path === state.environment }, path))
      );
      select.value = state.environment ?? '';
    }
    renderBanner();
  }

  function renderBanner() {
    const banner = $('banner');
    banner.replaceChildren();
    if (state.info?.icon !== 'offer' || !state.info?.tinyprobe) return;
    const where = { windows: 'the Start menu and the desktop', macos: 'Applications', linux: 'the applications menu' }[state.info.platform];
    banner.append(h('div', { class: 'banner' },
      h('p', null, `Add tinyprobe to ${where}? The icon starts the app; closing its window stops it.`),
      h('button', { type: 'button', class: 'button primary small', onclick: () => icon('create') }, 'Add icon'),
      h('button', { type: 'button', class: 'button small', onclick: () => icon('decline') }, 'Not now')));
  }

  async function icon(action) {
    try {
      state.info = await api('/api/icon', { action });
      renderBanner();
      if (action === 'create') showMessage('The tinyprobe icon is ready.', 'info');
    } catch (e) {
      if (!(e instanceof RestartError)) showMessage(`The icon could not be added: ${e.message}`);
    }
  }

  function renderSidebar() {
    const sidebar = $('sidebar');
    const m = state.model;
    sidebar.hidden = !m;
    if (!m) return;

    const selected = state.selection;
    const isSelected = (kind, file, name) => selected.kind === kind && selected.file === file && (name === undefined || selected.name === name);

    const groups = [];
    // The overview, the environment and the history first: the list of endpoints can be long.
    groups.push(h('div', { class: 'group' }, h('ul', { class: 'tree' },
      h('li', null, item({ label: 'Overview', mark: '⌂', selected: selected.kind === 'home', onclick: () => select({ kind: 'home' }) })),
      h('li', null, item({ mark: '⚙', label: state.environment ? `Environment: ${baseName(state.environment)}` : 'Environment', selected: selected.kind === 'environment', onclick: () => select({ kind: 'environment' }) })),
      h('li', null, item({ mark: '↺', label: state.history.length > 0 ? `History (${state.history.length})` : 'History', selected: selected.kind === 'history', onclick: () => select({ kind: 'history' }) })))));

    const apiGroup = h('div', { class: 'group' }, h('div', { class: 'group-title' }, h('span', null, 'API')));
    const tree = h('ul', { class: 'tree' });
    for (const file of m.apis) {
      tree.append(h('li', { class: 'file' }, file.workflow ? `${file.path} (workflow)` : file.path));
      for (const endpoint of file.endpoints) {
        tree.append(h('li', null, item({
          verb: endpoint.method,
          label: endpoint.name,
          selected: isSelected('endpoint', file.path, endpoint.name),
          onclick: () => select({ kind: 'endpoint', file: file.path, name: endpoint.name })
        })));
      }
    }
    tree.append(h('li', null, item({ label: '+ New request', className: 'add', selected: selected.kind === 'new', onclick: () => select({ kind: 'new' }) })));
    apiGroup.append(tree);
    groups.push(apiGroup);

    if (m.workflows.length > 0) {
      const list = h('ul', { class: 'tree' });
      for (const workflow of m.workflows) {
        const outcome = state.outcomes.get(workflow.path);
        list.append(h('li', null, item({
          mark: outcome === true ? '✓' : outcome === false ? '✗' : '▸',
          markClass: outcome === true ? 'passed' : outcome === false ? 'failed' : '',
          label: workflow.name,
          title: workflow.path,
          selected: isSelected('workflow', workflow.path),
          onclick: () => select({ kind: 'workflow', file: workflow.path })
        })));
      }
      groups.push(h('div', { class: 'group' }, h('div', { class: 'group-title' }, h('span', null, 'Workflows')), list));
    }

    if (m.sequences.length > 0) {
      const list = h('ul', { class: 'tree' });
      for (const sequence of m.sequences) {
        list.append(h('li', null, item({
          mark: '↳', label: sequence.name, title: sequence.path,
          selected: isSelected('sequence', sequence.path),
          onclick: () => select({ kind: 'sequence', file: sequence.path })
        })));
      }
      groups.push(h('div', { class: 'group' }, h('div', { class: 'group-title' }, h('span', null, 'Sequences')), list));
    }

    if (m.invalid.length > 0) {
      const list = h('ul', { class: 'tree' });
      for (const file of m.invalid) {
        list.append(h('li', null, item({ mark: '!', markClass: 'invalid', label: file.path, onclick: () => select({ kind: 'home' }) })));
      }
      groups.push(h('div', { class: 'group' }, h('div', { class: 'group-title' }, h('span', null, 'Not valid')), list));
    }

    if (state.environment) {
      groups.push(h('div', { class: 'variables' },
        h('div', null, `Variables of ${baseName(state.environment)}`),
        state.variables.length > 0 ? h('ul', null, state.variables.map(name => h('li', null, name))) : h('div', null, 'None')));
    }
    sidebar.replaceChildren(...groups);
  }

  function item({ label, verb, mark, markClass, title, selected, onclick, className }) {
    return h('button', { type: 'button', class: `item${selected ? ' selected' : ''}${className ? ` ${className}` : ''}`, title: title ?? label, onclick, 'aria-current': selected ? 'true' : null },
      verb ? h('span', { class: `verb verb-${verb}` }, verb) : mark ? h('span', { class: `mark ${markClass ?? ''}` }, mark) : null,
      h('span', { class: 'label' }, label));
  }

  function select(selection) {
    state.selection = selection;
    renderSidebar();
    renderView();
    $('view').scrollIntoView({ block: 'start' });
  }

  function renderView() {
    const view = $('view');
    if (!state.info) return;
    if (!state.info.tinyprobe) return view.replaceChildren(installView());
    if (!state.root || !state.model) return view.replaceChildren(welcomeView());
    const s = state.selection;
    const content =
      s.kind === 'endpoint' ? endpointView(s) :
      s.kind === 'workflow' ? workflowView(s) :
      s.kind === 'sequence' ? sequenceView(s) :
      s.kind === 'new' ? newRequestView() :
      s.kind === 'environment' ? environmentView() :
      s.kind === 'history' ? historyView() :
      homeView();
    view.replaceChildren(content ?? homeView());
  }

  // --- tinyprobe missing -----------------------------------------------------------------------------------

  function installView() {
    const status = h('p', { class: 'lead', 'aria-live': 'polite' });
    const button = h('button', { type: 'button', class: 'button primary', onclick: download }, `Download tinyprobe`);
    async function download() {
      button.disabled = true;
      status.textContent = 'Downloading tinyprobe (about 4 MB) and checking its checksum…';
      status.classList.remove('error-text');
      try {
        state.info = await api('/api/tinyprobe/download', {});
        await boot();
      } catch (e) {
        if (e instanceof RestartError) return;
        button.disabled = false;
        status.textContent = e.message;
        status.classList.add('error-text');
      }
    }
    return h('div', { class: 'welcome' },
      h('h1', null, 'tinyprobe is needed'),
      h('p', { class: 'lead' }, `The app sends your requests and runs your workflows with tinyprobe ${state.info.minimum} or newer. It downloads it from the tinyprobe releases on GitHub into its own folder; a tinyprobe you install yourself is used instead.`),
      state.info.problem ? h('p', { class: 'aside' }, state.info.problem) : null,
      h('div', { class: 'actions' }, button, h('a', { class: 'link', href: 'https://github.com/kikutano/tinyprobe#install', target: '_blank', rel: 'noreferrer' }, 'Install it yourself')),
      status);
  }

  // --- No folder yet ---------------------------------------------------------------------------------------

  function welcomeView() {
    const folders = state.info.folders;
    return h('div', { class: 'welcome' },
      h('h1', null, 'Open the folder of your API tests'),
      h('p', { class: 'lead' }, 'tinyprobe works on the YAML files of a folder, usually the tinyprobe/ folder of a project. The app reads them, sends their requests and runs their workflows; the same files run with tinyprobe in a terminal and in CI.'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button primary', onclick: () => openFolderDialog() }, 'Open a folder…')),
      folders.length > 0 ? h('h2', null, 'Recent folders') : null,
      folders.length > 0 ? h('ul', { class: 'recent' }, folders.map(folder => h('li', null,
        h('button', { type: 'button', class: `item${folder.exists ? '' : ' missing'}`, disabled: !folder.exists, title: folder.path, onclick: () => openRoot(folder.path) },
          h('span', { class: 'mark' }, '📁'), h('span', { class: 'label' }, folder.path))))) : null);
  }

  // --- Overview of the folder ------------------------------------------------------------------------------

  function homeView() {
    const m = state.model;
    const endpoints = m.apis.reduce((sum, file) => sum + file.endpoints.length, 0);
    const empty = endpoints === 0 && m.workflows.length === 0 && m.sequences.length === 0 && m.invalid.length === 0;
    return h('div', null,
      h('h1', null, baseName(state.root)),
      h('div', { class: 'where' }, state.root),
      h('div', { class: 'counts' },
        h('span', { class: 'count' }, h('strong', null, endpoints), endpoints === 1 ? 'endpoint' : 'endpoints'),
        h('span', { class: 'count' }, h('strong', null, m.workflows.length), m.workflows.length === 1 ? 'workflow' : 'workflows'),
        m.sequences.length > 0 ? h('span', { class: 'count' }, h('strong', null, m.sequences.length), m.sequences.length === 1 ? 'sequence' : 'sequences') : null,
        h('span', { class: 'count' }, h('strong', null, state.listing.environments.length), state.listing.environments.length === 1 ? 'environment' : 'environments')),
      h('div', { class: 'actions' },
        m.workflows.length > 0 ? h('button', { type: 'button', class: 'button primary', onclick: runAll }, '▶ Run all workflows') : null,
        h('button', { type: 'button', class: 'button', onclick: () => select({ kind: 'new' }) }, '+ New request')),
      state.listing.truncated ? h('div', { class: 'notice info' }, `Only the first 500 YAML files are listed: open the tinyprobe/ folder of the project instead of the whole project.`) : null,
      m.invalid.length > 0 ? h('div', { class: 'notice' },
        h('strong', null, m.invalid.length === 1 ? '1 file is not valid' : `${m.invalid.length} files are not valid`),
        h('ul', null, m.invalid.flatMap(file => file.errors.map(e => h('li', null, e.text))))) : null,
      empty ? h('div', { class: 'notice info' },
        h('strong', null, 'No tinyprobe files here yet. '),
        'Add a request with + New request, or ask your coding agent to write them: the prompts are in the ',
        h('a', { class: 'link', href: 'https://github.com/kikutano/tinyprobe#generate-tests-with-a-coding-agent', target: '_blank', rel: 'noreferrer' }, 'tinyprobe README'), '.') : null,
      h('p', { class: 'aside' }, 'A request sent from here remembers nothing for the next one. To pass a token or an id from one request to another, a workflow saves it with save: and every run starts from zero.'));
  }

  // --- An endpoint -----------------------------------------------------------------------------------------

  function endpointView({ file, name }) {
    const api = state.model.apis.find(a => a.path === file);
    const endpoint = api?.endpoints.find(e => e.name === name);
    if (!endpoint) return null;

    const key = `args:${state.root}:${file}:${name}`;
    const saved = recall(key, {});
    const params = [...endpoint.params].sort((a, b) => Number(b.required) - Number(a.required));
    const named = new Set(params.map(p => p.name));
    const queryNames = (endpoint.query ?? []).filter(n => n && !named.has(n));
    queryNames.forEach(n => named.add(n));
    // What the environment defines (baseUrl, token) is folded away; what it does not is a value to fill in.
    const fromEnvironment = new Set(state.variables);
    const rest = (endpoint.arguments ?? []).filter(n => !named.has(n));
    const free = rest.filter(n => !fromEnvironment.has(n));
    const others = rest.filter(n => fromEnvironment.has(n));

    const inputs = new Map();
    const field = (argument, { required = false, fallback = null, hint = null } = {}) => {
      const id = `arg-${argument}`;
      const input = h('input', { class: 'input mono', id, name: argument, value: saved[argument] ?? '', placeholder: fallback ?? (required ? 'required' : ''), autocomplete: 'off', spellcheck: 'false' });
      inputs.set(argument, { input, required });
      return [
        h('label', { for: id }, argument, required ? h('span', { class: 'required', 'aria-label': 'required' }, '*') : null),
        h('div', { class: 'field' }, input, fallback !== null ? h('span', { class: 'default' }, 'default') : null),
        hint ? h('div', { class: 'hint' }, hint) : null
      ];
    };

    const send = h('button', { type: 'submit', class: 'button primary' }, '▶ Send');
    const form = h('form', { onsubmit: event => {
      event.preventDefault();
      const values = {};
      const missing = [];
      for (const [argument, { input, required }] of inputs) {
        input.classList.remove('invalid');
        if (input.value !== '') values[argument] = input.value;
        else if (required) {
          missing.push(argument);
          input.classList.add('invalid');
        }
      }
      remember(key, values);
      if (missing.length > 0) {
        showMessage(`Fill in ${missing.join(', ')}: ${missing.length === 1 ? 'it is' : 'they are'} required.`);
        inputs.get(missing[0]).input.focus();
        return;
      }
      callEndpoint(file, endpoint, values);
    } },
      params.length + queryNames.length + free.length > 0
        ? h('div', { class: 'form' },
          params.flatMap(p => field(p.name, { required: p.required, fallback: p.default === null || p.default === undefined ? null : JSON.stringify(p.default) })),
          free.flatMap(n => field(n, { hint: state.environment ? `not in ${baseName(state.environment)}: fill it in` : 'no environment picked: fill it in, or pick one at the top' })),
          queryNames.flatMap(n => field(n, { hint: 'query parameter, sent only when filled in' })))
        : h('p', { class: 'aside' }, 'Nothing to fill in: send it as it is.'),
      others.length > 0 ? h('details', { class: 'more' },
        h('summary', null, `From ${baseName(state.environment)}: ${others.join(', ')} (fill in to override)`),
        h('div', { class: 'form' }, others.flatMap(n => field(n)))) : null,
      h('div', { class: 'actions' }, send,
        h('span', { class: 'aside' }, 'Values are read like YAML: 42 is a number, true a boolean, "42" a string.')));

    return h('div', null,
      h('div', { class: 'title-row' }, h('span', { class: `verb verb-${endpoint.method}` }, endpoint.method), h('h1', null, endpoint.name)),
      h('div', { class: 'where' }, `${file}:${endpoint.location?.line ?? ''}`),
      h('div', { class: 'path' }, `${endpoint.base_url ?? ''}${endpoint.path}`),
      form);
  }

  // --- A workflow and a sequence ---------------------------------------------------------------------------

  function workflowView({ file }) {
    const workflow = state.model.workflows.find(w => w.path === file);
    if (!workflow) return null;
    const steps = workflow.inspect.steps ?? [];
    const mode = recall('workflow-view', 'diagram');
    const toggle = next => { remember('workflow-view', next); renderView(); };

    let content;
    if (mode === 'diagram') {
      const model = flows.flowModel(workflow.inspect, state.variables);
      const details = h('div', { class: 'flow-details', 'aria-live': 'polite' });
      const picture = h('div', { class: 'flow' });
      const diagram = flows.createFlow(picture, model, { onSelect: at => showStep(workflow, steps[at], diagram, details) });
      for (const event of state.runs.get(workflow.path) ?? []) diagram.apply(event);
      state.flow = { path: workflow.path, diagram };
      const inputs = model.inputs;
      content = h('div', null,
        inputs.environment.length + inputs.variables.length + inputs.other.length > 0 ? h('div', { class: 'flow-inputs' },
          inputs.environment.length ? h('span', null, 'From the environment: ', inputs.environment.flatMap((n, i) => [h('code', null, n), i < inputs.environment.length - 1 ? ', ' : ''])) : null,
          inputs.variables.length ? h('span', null, "From the workflow's variables: ", inputs.variables.flatMap((n, i) => [h('code', null, n), i < inputs.variables.length - 1 ? ', ' : ''])) : null,
          inputs.other.length ? h('span', { class: 'error-text' }, 'Defined nowhere: ', inputs.other.flatMap((n, i) => [h('code', null, n), i < inputs.other.length - 1 ? ', ' : ''])) : null) : null,
        picture,
        details,
        h('p', { class: 'aside' }, 'Each colored line is a value a step saves, down to the steps that use it. Click a step to see what it sends and checks.'));
    } else {
      state.flow = null;
      content = h('ol', { class: 'step-table' }, steps.map(step => h('li', null,
        h('span', { class: 'step-number' }, step.index + 1),
        h('span', { class: 'step-label' }, step.name,
          step.sequence ? h('span', { class: 'step-kind' }, `  · from ${step.sequence.name || baseName(step.sequence.file)}`) : null,
          step.for_each ? h('span', { class: 'step-kind' }, '  · for each item') : null,
          step.until ? h('span', { class: 'step-kind' }, '  · until') : null),
        step.type === 'call' ? h('span', { class: 'verb' }, step.call ?? '') : h('span', { class: 'step-kind' }, step.type),
        h('button', { type: 'button', class: 'button small', title: 'Run the workflow up to this step and show its response', onclick: () => runWorkflow(workflow, step.index + 1) }, 'Run to here'))));
    }

    return h('div', null,
      h('h1', null, workflow.name),
      h('div', { class: 'where' }, file),
      workflow.inspect.description ? h('p', { class: 'lead' }, workflow.inspect.description) : null,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'button primary', onclick: () => runWorkflow(workflow) }, '▶ Run'),
        h('span', { class: 'spacer' }),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show the steps as' },
          h('button', { type: 'button', class: `button small${mode === 'diagram' ? ' active' : ''}`, 'aria-pressed': String(mode === 'diagram'), onclick: () => toggle('diagram') }, 'Diagram'),
          h('button', { type: 'button', class: `button small${mode === 'list' ? ' active' : ''}`, 'aria-pressed': String(mode === 'list'), onclick: () => toggle('list') }, 'List'))),
      content,
      mode === 'list' ? h('p', { class: 'aside' }, 'Run to here runs the steps before it again each time: nothing is kept between runs.') : null);
  }

  /** What a step of the diagram sends, checks and saves, with its result in the last run. */
  function showStep(workflow, step, diagram, details) {
    if (!step) return details.replaceChildren();
    const result = diagram.state(diagram.selected)?.result;
    const checks = [...(step.expect?.checks ?? [])];
    const withValues = Object.entries(step.with ?? {});
    const saves = Object.entries(step.save ?? {});
    details.replaceChildren(h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('span', { class: 'what' }, `${step.index + 1}. ${step.name}`),
        h('button', { type: 'button', class: 'button small', onclick: () => runWorkflow(workflow, step.index + 1) }, 'Run to here')),
      h('div', { class: 'panel-body' },
        step.type === 'call' ? h('div', { class: 'mono' }, `call ${step.call}`) : h('div', { class: 'mono' }, step.type),
        step.sequence ? h('div', { class: 'aside' }, `From the sequence ${step.sequence.name || baseName(step.sequence.file)}.`) : null,
        withValues.length ? h('div', null, h('h2', null, 'Sends'), h('ul', { class: 'plain' }, withValues.map(([k, v]) => h('li', { class: 'mono' }, `${k}: ${JSON.stringify(v)}`)))) : null,
        step.expect && (step.expect.status?.length || checks.length) ? h('div', null, h('h2', null, 'Checks'),
          h('ul', { class: 'plain' },
            step.expect.status?.length ? h('li', { class: 'mono' }, `status ${step.expect.status.join(' or ')}`) : null,
            checks.map(c => h('li', { class: 'mono' }, `${c.subject} ${c.condition}`)))) : null,
        step.until ? h('div', { class: 'aside' }, `Repeated every ${step.until.every_ms} ms, up to ${step.until.timeout_ms} ms, until its checks pass.`) : null,
        step.for_each ? h('div', { class: 'aside' }, 'Called once per item of its for_each.') : null,
        saves.length ? h('div', null, h('h2', null, 'Saves'), h('ul', { class: 'plain' }, saves.map(([k, v]) => h('li', { class: 'mono' }, `${k} ← ${v}`)))) : null,
        result ? h('div', null, h('h2', null, 'Last run'),
          h('div', { class: result.success ? '' : 'error-text' }, `${result.success ? 'Passed' : 'Failed'} · status ${result.status ?? 'none'} · ${runView.formatDuration(result.duration_ms)}${result.failure ? ` · ${result.failure}` : ''}`),
          h('div', { class: 'aside' }, 'Its request and response are in the result below.')) : null)));
  }

  function sequenceView({ file }) {
    const sequence = state.model.sequences.find(s => s.path === file);
    if (!sequence) return null;
    const params = sequence.inspect.params ?? [];
    return h('div', null,
      h('h1', null, sequence.name),
      h('div', { class: 'where' }, file),
      h('p', { class: 'lead' }, 'A sequence runs inside workflows, through a use: step, with the values given in its with:. Run a workflow that uses it to see it work.'),
      params.length > 0 ? h('h2', null, 'Params') : null,
      params.length > 0 ? h('div', { class: 'form' }, params.flatMap(p => [h('label', null, p.name, p.required ? h('span', { class: 'required' }, '*') : null), h('div', { class: 'aside' }, p.required ? 'required' : `default ${JSON.stringify(p.default)}`)])) : null,
      h('ol', { class: 'step-table' }, (sequence.inspect.steps ?? []).map(step => h('li', null,
        h('span', { class: 'step-number' }, step.index + 1),
        h('span', { class: 'step-label' }, step.name),
        h('span', { class: 'step-kind' }, step.type)))));
  }

  // --- New request -----------------------------------------------------------------------------------------

  function newRequestView() {
    const apiFiles = state.model.apis.filter(a => !a.workflow);
    const draft = recall(`draft:${state.root}`, {});
    const status = h('div', { 'aria-live': 'polite' });
    const control = (tag, attributes, ...children) => h(tag, { class: tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : 'input', ...attributes }, ...children);

    const fileSelect = control('select', { id: 'new-file' },
      apiFiles.map(a => h('option', { value: a.path, selected: draft.file === a.path }, a.path)),
      h('option', { value: '', selected: apiFiles.length === 0 || draft.file === '' }, 'A new API file…'));
    const newName = control('input', { id: 'new-api-name', placeholder: 'shop', value: draft.apiName ?? '' });
    const baseUrl = control('input', { id: 'new-base-url', class: 'input mono', placeholder: 'https://api.example.com or ${baseUrl}', value: draft.baseUrl ?? '' });
    const name = control('input', { id: 'new-name', class: 'input mono', placeholder: 'get_user', value: draft.name ?? '', autocomplete: 'off', spellcheck: 'false' });
    const method = control('select', { id: 'new-method' }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(m => h('option', { value: m, selected: (draft.method ?? 'GET') === m }, m)));
    const path = control('input', { id: 'new-path', class: 'input mono', placeholder: '/users/${id}', value: draft.path ?? '', spellcheck: 'false' });
    const auth = control('select', { id: 'new-auth' }, h('option', { value: '' }, 'None'));
    const queryNames = control('input', { id: 'new-query', class: 'input mono', placeholder: 'page, search', value: draft.query ?? '', spellcheck: 'false' });
    const body = control('textarea', { id: 'new-body', placeholder: '{ "title": "${title}" }', spellcheck: 'false' });
    body.value = draft.body ?? '';
    const headerRows = h('div', { class: 'rows' });
    const defaultRows = h('div', { class: 'rows' });

    const addHeader = (header = { name: '', value: '' }) => {
      const row = h('div', { class: 'row' },
        h('input', { class: 'input mono', placeholder: 'X-Client', value: header.name, 'aria-label': 'Header name', oninput: changed }),
        h('input', { class: 'input mono', placeholder: 'tinyprobe', value: header.value, 'aria-label': 'Header value', oninput: changed }),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Remove this header', onclick: () => { row.remove(); changed(); } }, '✕'));
      headerRows.append(row);
    };
    (draft.headers ?? []).forEach(addHeader);

    let fileText = null;
    let existingNames = [];
    async function fileChanged() {
      const chosen = fileSelect.value;
      for (const node of form.querySelectorAll('.new-file')) node.hidden = chosen !== '';
      fileText = null;
      existingNames = [];
      auth.replaceChildren(h('option', { value: '' }, 'None'));
      if (chosen) {
        fileText = await text(`/api/file?${query({ root: state.root, path: chosen })}`).catch(() => null);
        existingNames = apiFiles.find(a => a.path === chosen)?.endpoints.map(e => e.name) ?? [];
        for (const set of core.childKeys(fileText ?? '', 'auth')) auth.append(h('option', { value: set, selected: draft.auth === set }, set));
      }
    }

    function collect() {
      return {
        file: fileSelect.value,
        apiName: newName.value.trim(),
        baseUrl: baseUrl.value.trim(),
        name: name.value.trim(),
        method: method.value,
        path: path.value.trim(),
        auth: auth.value,
        query: queryNames.value,
        body: body.value,
        headers: [...headerRows.children].map(row => ({ name: row.children[0].value.trim(), value: row.children[1].value })).filter(h => h.name || h.value),
        defaults: [...defaultRows.children].map(row => ({ name: row.dataset.name, value: row.querySelector('input').value }))
      };
    }

    function changed() {
      const values = collect();
      remember(`draft:${state.root}`, values);
      // The values a call can pass: every ${name} written in the request. A default makes it optional.
      const found = core.placeholders(values.path, values.body, ...values.headers.map(x => x.value), ...values.query.split(',').map(x => x.trim() ? `\${${x.trim()}}` : ''));
      const current = new Map([...defaultRows.children].map(row => [row.dataset.name, row.querySelector('input').value]));
      const remembered = new Map((draft.defaults ?? []).map(d => [d.name, d.value]));
      defaultRows.replaceChildren(...found.map(argument => {
        const row = h('div', { class: 'row', 'data-name': argument },
          h('label', { class: 'mono', for: `default-${argument}` }, argument),
          h('input', { class: 'input mono', id: `default-${argument}`, placeholder: 'no default: from the call or the environment', value: current.get(argument) ?? remembered.get(argument) ?? '', oninput: () => remember(`draft:${state.root}`, collect()) }),
          h('span'));
        return row;
      }));
    }

    for (const input of [newName, baseUrl, name, path, queryNames, body]) input.addEventListener('input', changed);
    for (const input of [method, auth]) input.addEventListener('change', changed);
    fileSelect.addEventListener('change', () => { fileChanged(); changed(); });

    const save = h('button', { type: 'submit', class: 'button primary' }, 'Save');
    const form = h('form', { onsubmit: async event => {
      event.preventDefault();
      const values = collect();
      status.replaceChildren();
      const problem = core.checkName(values.name, existingNames);
      if (problem) return status.append(h('div', { class: 'notice' }, problem));
      if (!values.path.startsWith('/') && !values.path.startsWith('${')) return status.append(h('div', { class: 'notice' }, 'The path starts with /, e.g. /users/${id}'));

      const request = {
        name: values.name, method: values.method, path: values.path, auth: values.auth,
        query: values.query.split(','), headers: values.headers, body: values.body,
        // Only the placeholders given a default become params: the others stay free, filled by the call or the environment.
        defaults: values.defaults.filter(d => d.value !== '')
      };
      let target = values.file;
      let result;
      if (target) {
        result = core.addEndpoint(fileText ?? '', request);
      } else {
        target = core.apiFileName(values.apiName);
        if (!target) return status.append(h('div', { class: 'notice' }, 'Give the new API file a name, e.g. shop'));
        if (state.listing.files.some(f => f.path === target)) return status.append(h('div', { class: 'notice' }, `${target} already exists: pick it in the list.`));
        result = core.newApiFile(values.baseUrl, request);
      }
      if (result.error) return status.append(h('div', { class: 'notice' }, result.error));

      save.disabled = true;
      try {
        const answer = await api('/api/save', { root: state.root, path: target, text: result.text, basis: values.file ? fileText : null });
        if (!answer.saved) {
          status.append(h('div', { class: 'notice' },
            h('strong', null, 'Not saved: tinyprobe does not accept the file with this request. The file is as it was.'),
            h('ul', null, (answer.inspect?.errors ?? []).map(e => h('li', null, e.text)))));
          return;
        }
        remember(`draft:${state.root}`, {});
        await loadListing();
        select({ kind: 'endpoint', file: target, name: values.name });
        showMessage(`Saved ${values.name} in ${target}.`, 'info');
      } catch (e) {
        if (e instanceof RestartError) return;
        if (e.status === 409) {
          await fileChanged();
          status.append(h('div', { class: 'notice' }, 'The file changed on disk since it was read: it is read again now. Save again.'));
        } else {
          status.append(h('div', { class: 'notice' }, e.message));
        }
      } finally {
        save.disabled = false;
      }
    } },
      h('div', { class: 'form' },
        h('label', { for: 'new-file' }, 'API file'), fileSelect,
        h('label', { for: 'new-api-name', class: 'new-file' }, 'New file'), h('div', { class: 'field new-file' }, newName, h('span', { class: 'default' }, 'in api/')),
        h('label', { for: 'new-base-url', class: 'new-file' }, 'Base URL'), h('div', { class: 'field new-file' }, baseUrl),
        h('label', { for: 'new-name' }, 'Name'), name,
        h('label', { for: 'new-method' }, 'Method'), method,
        h('label', { for: 'new-path' }, 'Path'), path,
        h('div', { class: 'hint' }, 'Write ${name} where a value goes: /users/${id}. Each one becomes a value to fill in when you send it.'),
        h('label', { for: 'new-auth' }, 'Auth'), auth,
        h('label', { for: 'new-query' }, 'Query'), queryNames,
        h('div', { class: 'hint' }, 'Names of query parameters, separated by commas; each is sent only when it has a value.'),
        h('label', null, 'Headers'), h('div', null, headerRows, h('button', { type: 'button', class: 'button small', onclick: () => { addHeader(); } }, '+ Header')),
        h('label', { for: 'new-body' }, 'JSON body'), body,
        h('label', null, 'Defaults'), defaultRows),
      h('div', { class: 'actions' }, save, h('span', { class: 'aside' }, 'The request is added to the YAML file, which tinyprobe checks before it is kept.')),
      status);

    queueMicrotask(async () => {
      await fileChanged();
      changed();
    });

    return h('div', null,
      h('h1', null, 'New request'),
      h('p', { class: 'lead' }, 'An endpoint of an API file: a request you can send from here, call from a workflow and run in CI.'),
      form);
  }

  // --- Environment -------------------------------------------------------------------------------------------

  /**
   * The variables of the selected environment file, edited in place: each change rewrites only that variable's
   * lines, so the file keeps its comments and order. Names that look like secrets are hidden until shown.
   */
  function environmentView() {
    if (state.listing.environments.length === 0) {
      return h('div', null,
        h('h1', null, 'Environment'),
        h('p', { class: 'lead' }, 'An environment file holds the values your requests use: the base URL, the credentials. This folder has none yet.'),
        h('p', { class: 'aside' }, 'Create env.local.yaml in the folder (tinyprobe init does it for a project), with lines such as baseUrl: http://localhost:8080/. Keep files with credentials out of Git.'));
    }
    if (!state.environment) {
      return h('div', null,
        h('h1', null, 'Environment'),
        h('p', { class: 'lead' }, 'Pick the environment at the top: its values go into every request and run.'));
    }

    const container = h('div', null, h('p', { class: 'aside' }, 'Reading the file…'));
    const status = h('div', { 'aria-live': 'polite' });
    const path = state.environment;
    let content = null;

    async function load() {
      content = await text(`/api/file?${query({ root: state.root, path })}`).catch(() => null);
      draw();
    }

    async function write(next, message) {
      status.replaceChildren();
      try {
        await api('/api/environment', { root: state.root, path, text: next, basis: content });
        content = next;
        state.variables = envFile.parse(content).map(v => v.name);
        renderSidebar();
        draw();
        showMessage(message, 'info');
      } catch (e) {
        if (e instanceof RestartError) return;
        if (e.status === 409) {
          await load();
          status.append(h('div', { class: 'notice' }, 'The file changed on disk: it was read again. Make the change again.'));
        } else {
          status.append(h('div', { class: 'notice' }, e.message));
        }
      }
    }

    function draw() {
      if (content === null) {
        container.replaceChildren(h('div', { class: 'notice' }, `${path} cannot be read.`));
        return;
      }
      const variables = envFile.parse(content);
      const rows = variables.map(variable => {
        const secret = envFile.isSecretName(variable.name);
        const editable = variable.kind !== 'block';
        const current = variable.kind === 'scalar' ? variable.value : variable.raw;
        const save = () => {
          if (input.value !== current) write(envFile.setValue(content, variable, input.value), `${variable.name} saved in ${baseName(path)}.`);
        };
        const input = h('input', {
          class: 'input mono', id: `env-${variable.name}`, value: editable ? current : variable.value,
          type: secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', disabled: !editable,
          onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); save(); } }
        });
        return [
          h('label', { for: `env-${variable.name}` }, variable.name),
          h('div', { class: 'field' }, input,
            secret ? h('button', { type: 'button', class: 'icon-button', title: 'Show or hide the value', 'aria-label': `Show or hide ${variable.name}`, onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; } }, '👁') : null,
            editable ? h('button', { type: 'button', class: 'button small', onclick: save }, 'Save') : h('span', { class: 'default' }, 'edit it in the file'),
            h('button', { type: 'button', class: 'icon-button', title: `Delete ${variable.name}`, 'aria-label': `Delete ${variable.name}`, onclick: () => {
              if (confirm(`Delete ${variable.name} from ${baseName(path)}?`)) write(envFile.removeVariable(content, variable), `${variable.name} deleted.`);
            } }, '✕'))
        ];
      });

      const name = h('input', { class: 'input mono', id: 'env-new-name', placeholder: 'apiKey', autocomplete: 'off', spellcheck: 'false' });
      const value = h('input', { class: 'input mono', id: 'env-new-value', placeholder: 'value', autocomplete: 'off', spellcheck: 'false' });
      const add = h('form', { onsubmit: event => {
        event.preventDefault();
        status.replaceChildren();
        const chosen = name.value.trim();
        const problem = envFile.checkName(chosen, variables.map(v => v.name));
        if (problem) return status.append(h('div', { class: 'notice' }, problem));
        write(envFile.addVariable(content, chosen, value.value), `${chosen} added to ${baseName(path)}.`);
      } },
        h('h2', null, 'Add a variable'),
        h('div', { class: 'form' },
          h('label', { for: 'env-new-name' }, 'Name'), name,
          h('label', { for: 'env-new-value' }, 'Value'), h('div', { class: 'field' }, value, h('button', { type: 'submit', class: 'button primary small' }, 'Add'))));

      container.replaceChildren(
        variables.length > 0 ? h('div', { class: 'form' }, rows.flat()) : h('p', { class: 'aside' }, 'No variables yet.'),
        add);
    }

    queueMicrotask(load);
    return h('div', null,
      h('h1', null, 'Environment'),
      h('div', { class: 'where' }, path),
      h('p', { class: 'lead' }, 'Values are read like YAML: 42 is a number, true a boolean, "42" a string. A change is written to the file at once, its comments and order kept.'),
      status,
      container,
      h('p', { class: 'aside' }, 'Names that look like secrets (password, token, apiKey…) are hidden until you show them. Keep files with credentials out of Git.'));
  }

  // --- History -----------------------------------------------------------------------------------------------

  function historyView() {
    const entries = state.history;
    const timeOf = entry => new Date(entry.time).toLocaleString();
    const argsOf = entry => (entry.args ?? []).map(([k, v]) => `${k}=${v}`).join(' ');
    const findEndpoint = entry => state.model.apis.find(a => a.path === entry.file)?.endpoints.find(e => e.name === entry.endpoint) ?? null;

    function show(entry) {
      const { body } = panel(`${entry.method ?? ''} ${entry.endpoint}${argsOf(entry) ? `  ${argsOf(entry)}` : ''} · ${timeOf(entry)}`);
      const view = runView.create(body);
      view.reset(entry.endpoint, entry.environment);
      for (const event of entry.events ?? []) view.apply(event);
    }

    function again(entry) {
      const endpoint = findEndpoint(entry);
      if (!endpoint) return showMessage(`${entry.endpoint} is no longer in ${entry.file}.`);
      callEndpoint(entry.file, endpoint, Object.fromEntries(entry.args ?? []));
    }

    return h('div', null,
      h('h1', null, 'History'),
      h('p', { class: 'lead' }, `The last ${HISTORY_SIZE} requests sent from here, newest first. Click one to see its request and response again, or send it again with its values and the environment picked now.`),
      entries.length === 0
        ? h('p', { class: 'aside' }, 'Nothing yet: the requests you send from an endpoint appear here.')
        : h('ol', { class: 'step-table' }, entries.map(entry => h('li', null,
          h('span', { class: `verb verb-${entry.method}` }, entry.method ?? ''),
          h('span', { class: 'step-label' },
            h('button', { type: 'button', class: 'link', onclick: () => show(entry), title: 'Show the request and the response' }, entry.endpoint),
            argsOf(entry) ? h('span', { class: 'step-kind' }, `  ${argsOf(entry)}`) : null,
            h('div', { class: 'step-kind' }, `${timeOf(entry)} · ${entry.file}${entry.environment ? ` · ${baseName(entry.environment)}` : ''}`)),
          h('span', { class: `code ${runView.statusClass(entry.status)}` }, entry.status ?? '---'),
          h('span', { class: 'step-kind' }, runView.formatDuration(entry.duration_ms)),
          h('button', { type: 'button', class: 'button small', onclick: () => again(entry), disabled: !findEndpoint(entry) }, 'Send again')))),
      entries.length > 0 ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button small', onclick: async () => {
        if (!confirm('Clear the history of this folder? Its requests and responses are deleted.')) return;
        state.history = [];
        await api('/api/history', { root: state.root, entries: [] }).catch(() => {});
        render();
      } }, 'Clear history')) : null,
      h('p', { class: 'aside' }, "The history is kept in the app's own folder on this computer, not in your project: requests and responses carry credentials. Bodies are cut at 64 KiB."));
  }

  // --- Calls and runs --------------------------------------------------------------------------------------

  /** A result panel; closing it stops the request or the run. */
  function panel(title) {
    const controller = new AbortController();
    const body = h('div', { class: 'panel-body' });
    const node = h('article', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('span', { class: 'what' }, title),
        h('span', { class: 'when' }, new Date().toLocaleTimeString()),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Close and stop', title: 'Close (stops it if it is running)', onclick: () => { controller.abort(); node.remove(); } }, '✕')),
      body);
    $('results').prepend(node);
    // At most a few panels: older results go, as in a terminal's scrollback.
    while ($('results').children.length > 8) $('results').lastElementChild.remove();
    return { node, body, signal: controller.signal };
  }

  /** Posts to a streaming route and passes each tinyprobe event on; returns the app's own last line. */
  async function stream(path, payload, onEvent, signal) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
    if (response.status === 401) {
      showRestart();
      throw new RestartError('restart');
    }
    if (!response.ok) {
      const json = await response.json().catch(() => null);
      throw new Error(json?.error ?? `The app answered ${response.status}.`);
    }
    let exit = null;
    const lines = new core.LineSplitter(line => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.app === 'exit') exit = event;
      else onEvent(event);
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      lines.push(decoder.decode(value, { stream: true }));
    }
    lines.push(decoder.decode());
    lines.end();
    return exit;
  }

  function stopped(view, exit, events) {
    if (exit && exit.code !== 0 && events === 0) {
      view.error(exit.stderr?.trim() || `tinyprobe stopped with exit code ${exit.code}.`);
    }
  }

  async function callEndpoint(file, endpoint, values) {
    const shown = Object.entries(values).map(([k, v]) => `${k}=${v}`).join(' ');
    const { body, signal } = panel(`${endpoint.method} ${endpoint.name}${shown ? `  ${shown}` : ''}`);
    const view = runView.create(body);
    view.reset(endpoint.name, state.environment);
    const events = [];
    const root = state.root;
    const environment = state.environment;
    try {
      const exit = await stream('/api/call', {
        root, file, endpoint: endpoint.name, env: environment,
        with: Object.entries(values).map(([name, value]) => ({ name, value }))
      }, event => { events.push(event); view.apply(event); }, signal);
      stopped(view, exit, events.length);
    } catch (e) {
      if (e.name !== 'AbortError' && !(e instanceof RestartError)) view.error(e.message);
    }
    await record(root, { file, endpoint: endpoint.name, args: Object.entries(values), environment, events, time: Date.now() });
  }

  /** A call that sent a request goes into the folder's history; one stopped by invalid arguments does not. */
  async function record(root, call) {
    const entry = requestHistory.historyEntry(call);
    if (!entry || root !== state.root) return;
    state.history = requestHistory.addToHistory(state.history, entry, HISTORY_SIZE);
    renderSidebar();
    if (state.selection.kind === 'history') renderView();
    await api('/api/history', { root, entries: state.history }).catch(() => {});
  }

  async function runWorkflow(workflow, to) {
    const { body, signal } = panel(to ? `${workflow.name}, up to step ${to}` : workflow.name);
    const view = runView.create(body);
    view.reset(workflow.name, state.environment);
    let events = 0;
    const recorded = [];
    state.runs.set(workflow.path, recorded);
    try {
      const exit = await stream('/api/run', { root: state.root, files: [workflow.path], to: to ?? null, env: state.environment }, event => {
        events++;
        view.apply(event);
        // The diagram lights up as the run goes, and again when the workflow is opened later.
        recorded.push(event);
        if (state.flow?.path === workflow.path) state.flow.diagram.apply(event);
        if (event.event === 'run_finished' && !to) {
          state.outcomes.set(workflow.path, event.success);
          renderSidebar();
        }
      }, signal);
      stopped(view, exit, events);
    } catch (e) {
      if (e.name !== 'AbortError' && !(e instanceof RestartError)) view.error(e.message);
    }
  }

  /** The folder as a suite: one run view per workflow, as they start. */
  async function runAll() {
    const { node, body, signal } = panel(`All workflows of ${baseName(state.root)}`);
    const first = runView.create(body);
    first.reset('All workflows', state.environment);
    let current = null;
    let currentFile = null;
    let events = 0;
    let firstUsed = false;
    const summary = h('div', { class: 'suite-summary', hidden: true });
    node.append(summary);
    try {
      const exit = await stream('/api/run', { root: state.root, files: [], env: state.environment }, event => {
        events++;
        if (event.event === 'run_started') {
          // The first workflow uses the panel's own view; each next one gets a view below it.
          const part = firstUsed ? h('div', { class: 'panel-body' }) : body;
          if (firstUsed) node.insertBefore(part, summary);
          current = firstUsed ? runView.create(part) : first;
          firstUsed = true;
          current.reset(event.workflow, state.environment);
          currentFile = state.model.workflows.find(w => state.root && slash(event.file).endsWith(`/${w.path}`))?.path ?? null;
        }
        if (event.event === 'suite_started' || event.event === 'suite_finished') {
          if (event.event === 'suite_finished') {
            const s = event.summary;
            summary.hidden = false;
            summary.textContent = `${s.passed_workflows}/${s.total_workflows} workflows passed · ${s.passed_steps}/${s.total_steps} steps · ${runView.formatDuration(s.duration_ms)}`;
          }
          return;
        }
        (current ?? first).apply(event);
        if (event.event === 'run_finished' && currentFile) {
          state.outcomes.set(currentFile, event.success);
          renderSidebar();
        }
      }, signal);
      stopped(current ?? first, exit, events);
    } catch (e) {
      if (e.name !== 'AbortError' && !(e instanceof RestartError)) (current ?? first).error(e.message);
    }
  }

  // --- Folders dialog --------------------------------------------------------------------------------------

  async function openFolderDialog(start) {
    const dialog = $('folders');
    const body = $('folders-body');
    async function show(path) {
      let listing;
      try {
        listing = await api(`/api/browse?${query({ path: path ?? '' })}`);
      } catch (e) {
        if (e instanceof RestartError) return;
        body.prepend(h('div', { class: 'notice' }, e.message));
        return;
      }
      const recent = state.info.folders.filter(f => f.exists && f.path !== state.root);
      body.replaceChildren(
        recent.length > 0 ? h('div', { class: 'group' },
          h('div', { class: 'group-title' }, h('span', null, 'Recent')),
          h('ul', { class: 'recent' }, recent.map(f => h('li', null,
            h('button', { type: 'button', class: 'item', title: f.path, onclick: () => { dialog.close(); openRoot(f.path); } }, h('span', { class: 'mark' }, '📁'), h('span', { class: 'label' }, f.path)),
            h('button', { type: 'button', class: 'icon-button', 'aria-label': `Forget ${f.path}`, title: 'Remove from the list', onclick: async () => { state.info = await api('/api/folders/remove', { root: f.path }); show(listing.path); } }, '✕'))))) : null,
        h('div', { class: 'crumb' }, listing.path || 'This computer'),
        h('div', { class: 'actions' },
          listing.parent !== null ? h('button', { type: 'button', class: 'button small', onclick: () => show(listing.parent) }, '↑ Up') : null,
          listing.path ? h('button', { type: 'button', class: 'button primary small', onclick: () => choose(listing.path) }, 'Open this folder') : null),
        h('ul', { class: 'browse' }, listing.folders.length === 0
          ? h('li', { class: 'aside empty-row' }, 'No folders inside.')
          : listing.folders.map(f => h('li', null,
            h('button', { type: 'button', class: 'item', onclick: () => show(f.path), ondblclick: () => choose(f.path) },
              h('span', { class: 'mark' }, '📁'), h('span', { class: 'label' }, f.name),
              f.tinyprobe ? h('span', { class: 'badge-tests' }, 'tinyprobe/') : null)))),
        h('p', { class: 'aside' }, 'A folder with a tinyprobe/ folder opens on its tests.'));
    }
    async function choose(path) {
      try {
        const { root } = await api('/api/folders/open', { path });
        state.info = await api('/api/state');
        dialog.close();
        await openRoot(root);
      } catch (e) {
        if (!(e instanceof RestartError)) body.prepend(h('div', { class: 'notice' }, e.message));
      }
    }
    await show(start ?? (state.root ? state.root : state.info.home));
    if (!dialog.open) dialog.showModal();
  }

  // --- Settings --------------------------------------------------------------------------------------------

  function openSettings() {
    const dialog = $('settings');
    const body = $('settings-body');
    const info = state.info;
    const cli = info?.tinyprobe;
    const output = h('pre', { class: 'body', hidden: true });
    const update = cli?.source === 'app' ? h('button', { type: 'button', class: 'button small', onclick: async () => {
      update.disabled = true;
      output.hidden = false;
      output.textContent = 'Updating tinyprobe…';
      try {
        const result = await api('/api/tinyprobe/update', {});
        output.textContent = result.output || (result.code === 0 ? 'Up to date.' : `tinyprobe update stopped with exit code ${result.code}.`);
        state.info = await api('/api/state');
      } catch (e) {
        output.textContent = e.message;
      } finally {
        update.disabled = false;
      }
    } }, 'Update tinyprobe') : null;
    body.replaceChildren(
      h('dl', { class: 'pairs-settings' },
        h('dt', null, 'App'), h('dd', null, `tinyprobe-app ${info?.app ?? ''}`),
        h('dt', null, 'tinyprobe'), h('dd', null, cli ? `${cli.version}` : `not installed (${info?.minimum} or newer is needed)`),
        cli ? h('dt', null, 'Binary') : null, cli ? h('dd', { class: 'mono' }, cli.path) : null,
        cli ? h('dt', null, 'Source') : null,
        cli ? h('dd', null, { path: 'your installation (on the PATH): update it as you installed it', app: "the app's own copy", env: 'TINYPROBE_PATH' }[cli.source] ?? cli.source) : null),
      info?.problem ? h('p', { class: 'aside' }, info.problem) : null,
      h('div', { class: 'actions' }, update,
        info?.icon !== 'unsupported' ? h('button', { type: 'button', class: 'button small', onclick: () => icon('create') }, info?.icon === 'created' ? 'Add the icon again' : 'Add the tinyprobe icon') : null),
      output,
      h('p', { class: 'aside' }, 'The app runs on this computer only (127.0.0.1). Requests and responses, Authorization headers included, are shown here and are not sent anywhere else.'));
    dialog.showModal();
  }

  // --- Messages --------------------------------------------------------------------------------------------

  function showMessage(message, kind) {
    const results = $('results');
    const node = h('div', { class: `notice${kind === 'info' ? ' info' : ''}`, role: 'status' }, message);
    results.prepend(node);
    setTimeout(() => node.remove(), kind === 'info' ? 4000 : 8000);
  }

  function showRestart() {
    if (document.querySelector('.overlay')) return;
    document.body.append(h('div', { class: 'overlay', role: 'alertdialog', 'aria-labelledby': 'restart-title' },
      h('div', { class: 'card' },
        h('h2', { id: 'restart-title' }, 'Open tinyprobe again'),
        h('p', null, 'The app was stopped or restarted, so this page cannot reach it. Start tinyprobe from its icon: it opens a new page.'))));
  }

  function showFatal(message) {
    $('view').replaceChildren(h('div', { class: 'welcome' }, h('h1', null, 'The app does not answer'), h('p', { class: 'lead' }, message)));
  }

  // --- Events ----------------------------------------------------------------------------------------------

  $('folder-button').addEventListener('click', () => openFolderDialog());
  $('settings-button').addEventListener('click', openSettings);
  $('refresh').addEventListener('click', () => loadListing());
  $('env').addEventListener('change', async event => {
    state.environment = event.target.value || null;
    remember(`env:${state.root}`, state.environment);
    await loadVariables();
    renderSidebar();
    renderView();
  });

  // The user edits the YAML in an editor at the same time: read the folder again when the page comes back.
  let refreshing = null;
  window.addEventListener('focus', () => {
    if (!state.root || refreshing) return;
    refreshing = setTimeout(async () => {
      await loadListing();
      refreshing = null;
    }, 150);
  });

  boot();
})();
