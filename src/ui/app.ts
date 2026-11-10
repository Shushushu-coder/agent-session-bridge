import { App } from '@modelcontextprotocol/ext-apps';
import type {
  BoardBatchSummary,
  BoardSnapshot,
  BoardTaskSummary,
  BoardWorkerView,
} from '../contracts/board.js';

const POLL_MS = 1500;
const root = document.getElementById('app')!;
const app = new App({ name: 'agent-session-bridge-board', version: '0.4.0' });

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

function fmtTokens(usage: BoardTaskSummary['usage']): string {
  if (!usage) return '—';
  const out = usage.output_tokens.toLocaleString();
  const inp = (usage.input_tokens / 1000).toFixed(0);
  return `${out} out / ${inp}k in`;
}

function shortId(id: string | null): string {
  return id ? id.slice(0, 14) : '—';
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

function workerRow(w: BoardWorkerView): HTMLElement {
  const tr = el('tr');
  const name = el('td');
  name.append(el('div', undefined, w.name), el('div', 'dim mono', w.workerId));
  tr.append(name);

  const state = el('td');
  state.append(chip(w.state));
  if (w.lastError) state.append(el('div', 'dim', w.lastError.slice(0, 80)));
  tr.append(state);

  const task = el('td');
  if (w.latestTask) {
    task.append(chip(w.latestTask.status));
    const p = el('div', 'dim progress-text', w.latestTask.lastProgress?.summary ?? '');
    p.title = w.latestTask.lastProgress?.summary ?? '';
    task.append(p);
  } else {
    task.append(el('span', 'dim', 'no tasks'));
  }
  tr.append(task);

  const tokens = el('td', 'mono', fmtTokens(w.latestTask?.usage ?? null));
  tr.append(tokens);

  const updated = el('td', 'dim', fmtTime(w.latestTask?.updatedAt ?? w.updatedAt));
  tr.append(updated);
  return tr;
}

function batchRow(b: BoardBatchSummary): HTMLElement {
  const tr = el('tr');
  const id = el('td');
  id.append(el('div', 'mono', b.batchId), el('div', 'dim', b.requestKey));
  tr.append(id);

  const counts = el('td');
  const total = Math.max(1, b.dispatchedCount);
  counts.append(
    el(
      'span',
      'dim',
      `${b.statusCounts.completed}/${b.dispatchedCount} done` +
        (b.rejectedCount ? ` · ${b.rejectedCount} rejected` : ''),
    ),
  );
  const bar = el('div', 'bar');
  for (const key of ['completed', 'running', 'accepted', 'failed', 'unknown'] as const) {
    const n = b.statusCounts[key];
    if (!n) continue;
    const seg = el('span', `b-${key}`);
    seg.style.width = `${(n / total) * 100}%`;
    bar.append(seg);
  }
  counts.append(bar);
  tr.append(counts);
  tr.append(el('td', 'dim', fmtTime(b.createdAt)));
  return tr;
}

function activityRow(t: BoardTaskSummary): HTMLElement {
  const tr = el('tr');
  tr.append(el('td', 'mono dim', t.taskId.slice(0, 18)));
  const st = el('td');
  st.append(chip(t.status));
  tr.append(st);
  const what = el('td', 'progress-text dim', t.lastProgress?.summary ?? '');
  what.title = t.lastProgress?.summary ?? '';
  tr.append(what);
  tr.append(el('td', 'dim', fmtTime(t.updatedAt)));
  return tr;
}

function render(): void {
  root.replaceChildren();
  const top = el('div', 'topbar');
  top.append(el('h1', undefined, 'Worker Board'));
  top.append(el('span', `dot ${snapshot ? (snapshot.runtimeConnected ? 'ok' : 'err') : ''}`));
  top.append(
    el(
      'span',
      'meta',
      snapshot
        ? `${snapshot.workerCount} worker(s) · ${snapshot.runtimeConnected ? 'runtime ok' : 'runtime down'}`
        : 'no data yet',
    ),
  );
  top.append(el('span', 'grow'));
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

  root.append(el('h2', undefined, 'Workers'));
  if (snapshot.workers.length === 0) {
    root.append(el('div', 'empty', 'no managed workers'));
  } else {
    const table = el('table');
    const head = el('tr');
    for (const h of ['worker', 'state', 'latest task', 'tokens', 'updated']) head.append(el('th', undefined, h));
    table.append(head);
    for (const w of snapshot.workers) table.append(workerRow(w));
    root.append(table);
  }

  if (snapshot.recentBatches.length > 0) {
    root.append(el('h2', undefined, 'Batches'));
    const table = el('table');
    const head = el('tr');
    for (const h of ['batch', 'progress', 'created']) head.append(el('th', undefined, h));
    table.append(head);
    for (const b of snapshot.recentBatches) table.append(batchRow(b));
    root.append(table);
  }

  if (snapshot.recentTasks.length > 0) {
    root.append(el('h2', undefined, 'Activity'));
    const table = el('table');
    const head = el('tr');
    for (const h of ['task', 'status', 'last event', 'updated']) head.append(el('th', undefined, h));
    table.append(head);
    for (const t of snapshot.recentTasks.slice(0, 8)) table.append(activityRow(t));
    root.append(table);
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
