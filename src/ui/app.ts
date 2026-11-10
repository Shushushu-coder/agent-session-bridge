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
const root = document.getElementById('app')!;
const app = new App({ name: 'agent-session-bridge-board', version: '0.6.0' });

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
  const wrap = el('div', 'batch-wrap');
  wrap.append(row, bar);
  return wrap;
}

function taskLine(t: BoardTaskSummary, nameOf: (id: string) => string, live: boolean): HTMLElement {
  const row = el('div', `taskline${live ? ' live' : ''}`);
  row.append(el('span', live ? 'wname' : 'dim', nameOf(t.workerId)));
  row.append(chip(t.status));
  const detail = live ? (t.lastProgress?.summary ?? t.label ?? '') : (t.label ?? '');
  const p = el('span', 'dim progress-text grow2', detail);
  p.title = detail;
  row.append(p);
  const timing = live
    ? fmtDur(t.startedAt ?? t.createdAt)
    : `${fmtDur(t.startedAt, t.completedAt)} · ${fmtNum(t.usage?.output_tokens ?? 0)} out · ${fmtTime(t.completedAt ?? t.updatedAt)}`;
  row.append(el('span', 'dim mono', timing));
  return row;
}

function workerCard(w: BoardWorkerView): HTMLElement {
  const card = el('div', `wcard st-${w.state}`);
  const top = el('div', 'wtop');
  top.append(el('span', 'wname', w.name), chip(w.state));
  card.append(top);

  // Model line — what this worker will request on its next turn.
  const model = el('div', 'wline dim mono model-line', modelOf(w));
  model.title = modelOf(w);
  card.append(model);

  const t = w.latestTask;
  if (t) {
    // What it's doing: status + the task's own label.
    const line = el('div', 'wline');
    line.append(chip(t.status));
    const label = el('span', 'progress-text', t.label ?? t.lastProgress?.summary ?? '');
    label.title = t.label ?? '';
    line.append(label);
    card.append(line);

    // Progress meta: elapsed & event count live; duration & tokens settled.
    const meta = LIVE_STATUSES.has(t.status)
      ? `${fmtDur(t.startedAt ?? t.createdAt)} · ${t.progressCount} events` +
        (t.lastProgress?.summary ? ` — ${t.lastProgress.summary}` : '')
      : `${fmtDur(t.startedAt, t.completedAt)} · ${
          t.usage ? `${fmtNum(t.usage.output_tokens)} out` : '—'
        } · ${fmtTime(t.completedAt ?? t.updatedAt)}`;
    const metaEl = el('div', 'wline dim progress-text', meta);
    metaEl.title = meta;
    card.append(metaEl);
  } else {
    card.append(el('div', 'wline dim', 'no tasks yet'));
  }
  if (w.lastError) card.append(el('div', 'wline err-text', w.lastError.slice(0, 120)));
  return card;
}

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

  // Stat strip: worker health + live task count + cumulative output.
  const busy = snapshot.workers.filter((w) => w.state === 'busy').length;
  const errs = snapshot.workers.filter(
    (w) => w.state === 'error' || w.state === 'initialization_uncertain',
  ).length;
  const liveTasks = snapshot.recentTasks.filter((t) => LIVE_STATUSES.has(t.status));
  const openBatches = snapshot.recentBatches.filter((b) => !b.allSettled);
  const totalOut = snapshot.workers.reduce(
    (n, w) => n + (w.usageTotals?.output_tokens ?? 0),
    0,
  );
  const strip = el('div', 'statstrip');
  strip.append(el('span', 'stat', `${snapshot.workerCount} workers`));
  if (busy) strip.append(el('span', 'stat stat-busy', `${busy} busy`));
  if (errs) strip.append(el('span', 'stat stat-err', `${errs} error`));
  if (liveTasks.length) strip.append(el('span', 'stat stat-busy', `${liveTasks.length} running`));
  if (totalOut) strip.append(el('span', 'stat', `Σ ${fmtNum(totalOut)} out`));
  root.append(strip);

  // Workers first — the primary monitoring target; active workers lead.
  root.append(el('h2', undefined, 'Workers'));
  if (snapshot.workers.length === 0) {
    root.append(el('div', 'empty', 'no workers this session'));
  } else {
    const ordered = [...snapshot.workers].sort(
      (a, b) => Number(Boolean(b.activeTaskId)) - Number(Boolean(a.activeTaskId)),
    );
    for (const w of ordered) root.append(workerCard(w));
  }

  // Live section — only rendered while something is in flight.
  if (liveTasks.length || openBatches.length) {
    root.append(el('h2', 'live-h', 'Live'));
    for (const t of liveTasks) root.append(taskLine(t, nameOf, true));
    for (const b of openBatches) root.append(batchLine(b));
  }

  // History — settled tasks, collapsed by default.
  const done = snapshot.recentTasks.filter((t) => !LIVE_STATUSES.has(t.status));
  if (done.length) {
    const d = el('details');
    d.append(el('summary', undefined, `History · ${done.length} recent task(s)`));
    for (const t of done.slice(0, HISTORY_LIMIT)) d.append(taskLine(t, nameOf, false));
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
