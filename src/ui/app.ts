import { App } from '@modelcontextprotocol/ext-apps';
import type {
  BoardBatchSummary,
  BoardSnapshot,
  BoardTaskSummary,
  BoardWorkerView,
} from '../contracts/board.js';

const POLL_MS = 1500;
const HISTORY_LIMIT = 8;
const LIVE_STATUSES = new Set(['accepted', 'running']);
const BAR_CLASS: Record<string, string> = {
  accepted: 'indet idle',
  running: 'indet',
  completed: 'done',
  failed: 'fail',
  unknown: 'unk',
};
const root = document.getElementById('app')!;
const app = new App({ name: 'agent-session-bridge-board', version: '0.7.0' });

let timer: ReturnType<typeof setInterval> | null = null;
let lastError: string | null = null;
let snapshot: BoardSnapshot | null = null;
let inflight = false;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chip(value: string): HTMLElement {
  return el('span', `chip st-${value}`, value);
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function fmtNum(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

/** "2m10s" between two ISO stamps; `toIso` null/omitted means now. */
function fmtDur(fromIso: string | null, toIso?: string | null): string {
  if (!fromIso) return '';
  const start = new Date(fromIso).getTime();
  const end = toIso ? new Date(toIso).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  const s = Math.max(0, Math.round((end - start) / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

function applyTheme(): void {
  const ctx = app.getHostContext();
  if (ctx?.theme) document.documentElement.dataset.theme = ctx.theme;
  else delete document.documentElement.dataset.theme;
}

async function toggleDisplayMode(): Promise<void> {
  const ctx = app.getHostContext();
  const next = ctx?.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
  if (!ctx?.availableDisplayModes || ctx.availableDisplayModes.includes(next)) {
    try {
      await app.requestDisplayMode({ mode: next });
    } catch {
      // Host refused — stay in the current mode.
    }
  }
  render();
}

/** Model the worker will request, or a readable marker for runtime default. */
function modelOf(w: BoardWorkerView): string {
  if (w.effectiveModel) return w.effectiveModel;
  return w.modelSource === 'runtime_default' ? 'runtime default' : '—';
}

function show(node: HTMLElement, on: boolean): void {
  node.style.display = on ? '' : 'none';
}

/* ------------------------------------------------------------------ */
/* Worker cards: built once per workerId, updated in place so the      */
/* progress-bar animation is not restarted by every poll.              */
/* ------------------------------------------------------------------ */

interface CardRefs {
  root: HTMLElement;
  dot: HTMLElement;
  nameEl: HTMLElement;
  stateEl: HTMLElement;
  modelEl: HTMLElement;
  taskRow: HTMLElement;
  taskStatus: HTMLElement;
  taskLabel: HTMLElement;
  barWrap: HTMLElement;
  barFill: HTMLElement;
  meta: HTMLElement;
  noTask: HTMLElement;
  errEl: HTMLElement;
}

const workerCards = new Map<string, CardRefs>();

function makeCard(): CardRefs {
  const card = el('div', 'wcard');
  const top = el('div', 'wtop');
  const left = el('div', 'wleft');
  const dot = el('span', 'sdot');
  const nameEl = el('span', 'wname');
  left.append(dot, nameEl);
  const stateEl = el('span', 'chip');
  top.append(left, stateEl);

  const modelRow = el('div', 'wline');
  const modelEl = el('span', 'badge');
  modelRow.append(modelEl);

  const taskRow = el('div', 'wline task');
  const taskStatus = el('span', 'chip');
  const taskLabel = el('span', 'tasklabel');
  taskRow.append(taskStatus, taskLabel);

  const barWrap = el('div', 'progressbar');
  const barFill = el('span', 'barfill');
  barWrap.append(barFill);

  const meta = el('div', 'wline dim progress-text');
  const noTask = el('div', 'wline dim', 'no tasks yet');
  const errEl = el('div', 'wline err-text');
  errEl.style.display = 'none';

  card.append(top, modelRow, taskRow, barWrap, meta, noTask, errEl);
  return {
    root: card,
    dot,
    nameEl,
    stateEl,
    modelEl,
    taskRow,
    taskStatus,
    taskLabel,
    barWrap,
    barFill,
    meta,
    noTask,
    errEl,
  };
}

function syncCard(refs: CardRefs, w: BoardWorkerView): void {
  refs.root.className = `wcard st-${w.state}`;
  refs.dot.className = `sdot st-${w.state}`;
  refs.nameEl.textContent = w.name;
  refs.stateEl.className = `chip st-${w.state}`;
  refs.stateEl.textContent = w.state;
  const model = modelOf(w);
  refs.modelEl.textContent = model;
  refs.modelEl.title = model;

  const t = w.latestTask;
  show(refs.noTask, !t);
  show(refs.taskRow, Boolean(t));
  show(refs.barWrap, Boolean(t));
  show(refs.meta, Boolean(t));
  if (t) {
    refs.taskStatus.className = `chip st-${t.status}`;
    refs.taskStatus.textContent = t.status;
    const label = t.label ?? t.lastProgress?.summary ?? '';
    refs.taskLabel.textContent = label;
    refs.taskLabel.title = label;
    refs.barFill.className = `barfill ${BAR_CLASS[t.status] ?? 'indet'}`;
    const meta = LIVE_STATUSES.has(t.status)
      ? `${fmtDur(t.startedAt ?? t.createdAt)} · ${t.progressCount} events` +
        (t.lastProgress?.summary ? ` — ${t.lastProgress.summary}` : '')
      : `${fmtDur(t.startedAt, t.completedAt)} · ${
          t.usage ? `${fmtNum(t.usage.output_tokens)} out` : '—'
        } · ${fmtTime(t.completedAt ?? t.updatedAt)}`;
    refs.meta.textContent = meta;
    refs.meta.title = meta;
  }
  show(refs.errEl, Boolean(w.lastError));
  if (w.lastError) refs.errEl.textContent = w.lastError.slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* Rebuilt rows (no animation state to preserve).                      */
/* ------------------------------------------------------------------ */

function batchLine(b: BoardBatchSummary): HTMLElement {
  const row = el('div', 'taskline');
  row.append(el('span', 'wname', b.requestKey));
  row.append(
    el(
      'span',
      'dim grow2',
      `${b.statusCounts.completed}/${b.dispatchedCount} done` +
        (b.rejectedCount ? ` · ${b.rejectedCount} rejected` : ''),
    ),
  );
  row.append(el('span', 'dim mono', fmtTime(b.createdAt)));
  const bar = el('div', 'bar');
  const total = Math.max(1, b.dispatchedCount);
  for (const key of ['completed', 'running', 'accepted', 'failed', 'unknown'] as const) {
    const n = b.statusCounts[key];
    if (!n) continue;
    const seg = el('span', `b-${key}`);
    seg.style.width = `${(n / total) * 100}%`;
    bar.append(seg);
  }
  const wrap = el('div', 'batchcard');
  wrap.append(row, bar);
  return wrap;
}

function taskLine(t: BoardTaskSummary, nameOf: (id: string) => string): HTMLElement {
  const row = el('div', 'taskline');
  row.append(el('span', 'dim', nameOf(t.workerId)));
  row.append(chip(t.status));
  const detail = t.label ?? t.lastProgress?.summary ?? '';
  const p = el('span', 'dim progress-text grow2', detail);
  p.title = detail;
  row.append(p);
  row.append(
    el(
      'span',
      'dim mono',
      `${fmtDur(t.startedAt, t.completedAt)} · ${fmtNum(t.usage?.output_tokens ?? 0)} out · ${fmtTime(t.completedAt ?? t.updatedAt)}`,
    ),
  );
  return row;
}

function kpi(label: string, value: string, tone?: 'blue' | 'red'): HTMLElement {
  const tile = el('div', 'kpi');
  tile.append(el('div', `kpi-num${tone ? ` ${tone}` : ''}`, value));
  tile.append(el('div', 'kpi-label', label));
  return tile;
}

/* ------------------------------------------------------------------ */

function render(): void {
  root.replaceChildren();
  const top = el('div', 'topbar');
  top.append(
    el('span', `dot ${snapshot ? (snapshot.runtimeConnected ? 'ok' : 'err') : ''}`),
    el('h1', undefined, 'Worker Board'),
    el('span', 'grow'),
  );
  const ctx = app.getHostContext();
  if (ctx?.availableDisplayModes?.includes('fullscreen')) {
    const btn = el(
      'button',
      undefined,
      ctx.displayMode === 'fullscreen' ? 'collapse' : 'expand panel',
    );
    btn.onclick = () => void toggleDisplayMode();
    top.append(btn);
  }
  const refresh = el('button', undefined, 'refresh');
  refresh.onclick = () => void refreshOnce();
  top.append(refresh);
  root.append(top);

  if (lastError) {
    const banner = el('div', 'err-banner', lastError);
    banner.style.display = 'block';
    root.append(banner);
  }
  if (!snapshot) {
    root.append(el('div', 'empty', 'waiting for first snapshot…'));
    return;
  }

  const nameOf = (id: string): string =>
    snapshot!.workers.find((w) => w.workerId === id)?.name ?? id.slice(0, 14);

  const liveTasks = snapshot.recentTasks.filter((t) => LIVE_STATUSES.has(t.status));
  const openBatches = snapshot.recentBatches.filter((b) => !b.allSettled);
  const busy = snapshot.workers.filter((w) => w.state === 'busy').length;
  const errs = snapshot.workers.filter(
    (w) => w.state === 'error' || w.state === 'initialization_uncertain',
  ).length;
  const totalOut = snapshot.workers.reduce(
    (n, w) => n + (w.usageTotals?.output_tokens ?? 0),
    0,
  );

  // KPI tiles.
  const kpis = el('div', 'kpis');
  kpis.append(kpi('Workers', `${snapshot.workerCount}`));
  kpis.append(kpi('Running', `${liveTasks.length}`, liveTasks.length ? 'blue' : undefined));
  kpis.append(kpi('Errors', `${errs}`, errs ? 'red' : undefined));
  kpis.append(kpi('Tokens out', fmtNum(totalOut)));
  root.append(kpis);

  // Live batch cards sit above the worker grid.
  for (const b of openBatches) root.append(batchLine(b));

  // Worker cards — active first; DOM nodes are reused per workerId.
  root.append(el('h2', undefined, 'Workers'));
  if (snapshot.workers.length === 0) {
    root.append(el('div', 'empty', 'no workers this session'));
  } else {
    const grid = el('div', 'workers-grid');
    const ordered = [...snapshot.workers].sort(
      (a, b) => Number(Boolean(b.activeTaskId)) - Number(Boolean(a.activeTaskId)),
    );
    const seen = new Set<string>();
    for (const w of ordered) {
      let refs = workerCards.get(w.workerId);
      if (!refs) {
        refs = makeCard();
        workerCards.set(w.workerId, refs);
      }
      syncCard(refs, w);
      grid.append(refs.root);
      seen.add(w.workerId);
    }
    for (const [id] of workerCards) if (!seen.has(id)) workerCards.delete(id);
    root.append(grid);
  }

  // History — settled tasks, collapsed by default.
  const done = snapshot.recentTasks.filter((t) => !LIVE_STATUSES.has(t.status));
  if (done.length) {
    const d = el('details');
    d.append(el('summary', undefined, `History · ${done.length} recent task(s)`));
    for (const t of done.slice(0, HISTORY_LIMIT)) d.append(taskLine(t, nameOf));
    root.append(d);
  }

  // Batch history — collapsed; requestKey is the primary label.
  const batches = [...snapshot.recentBatches].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  if (batches.length) {
    const d = el('details');
    d.append(el('summary', undefined, `Batches · ${batches.length}`));
    for (const b of batches) d.append(batchLine(b));
    root.append(d);
  }

  const foot = el('div', 'foot');
  foot.append(el('span', undefined, `poll ${POLL_MS}ms`));
  foot.append(el('span', undefined, `snapshot ${fmtTime(snapshot.generatedAt)}`));
  root.append(foot);
}

async function refreshOnce(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const result = await app.callServerTool({ name: 'get_board_snapshot', arguments: {} });
    if (result.isError) {
      lastError = `get_board_snapshot failed: ${JSON.stringify(result.content).slice(0, 200)}`;
    } else {
      snapshot = (result.structuredContent ?? null) as BoardSnapshot | null;
      lastError = null;
    }
  } catch (error) {
    lastError = `get_board_snapshot failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    inflight = false;
    render();
  }
}

async function main(): Promise<void> {
  render();
  try {
    await app.connect();
  } catch (error) {
    lastError = `host connect failed: ${error instanceof Error ? error.message : String(error)}`;
    render();
    return;
  }
  applyTheme();
  app.onhostcontextchanged = () => {
    applyTheme();
    render();
  };
  app.onteardown = () => {
    if (timer) clearInterval(timer);
    timer = null;
    return {};
  };
  // Seed with the tool result that opened this view, when the host forwards it.
  app.ontoolresult = (params) => {
    const sc = (params as { structuredContent?: BoardSnapshot }).structuredContent;
    if (sc?.workers) {
      snapshot = sc;
      render();
    }
  };
  await refreshOnce();
  timer = setInterval(() => void refreshOnce(), POLL_MS);
}

void main();
