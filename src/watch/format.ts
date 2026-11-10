import { redactSensitive } from '../storage/redact.js';

/**
 * Render one rollout JSONL line as a compact one-line summary.
 *
 * Rollout lines have the envelope `{timestamp, ordinal, type, payload}`.
 * We render only human-meaningful events (turns, messages, token counts)
 * and skip bulk records (developer instructions, world state, settings).
 * Unknown-but-small event types degrade to a `· <type>` marker; anything
 * unparseable returns null and is skipped.
 */

const MAX_TEXT = 160;

interface Envelope {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown> | undefined;
}

function clock(timestamp: string | undefined): string {
  const date = timestamp ? new Date(timestamp) : new Date();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `[${hh}:${mm}:${ss}]`;
}

function clip(text: string, max = MAX_TEXT): string {
  return redactSensitive(text, max);
}

function shortId(id: unknown): string {
  return typeof id === 'string' && id.length >= 8 ? id.slice(0, 8) : String(id ?? '?');
}

/** Join text fragments out of a message/item `content` array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join(' ');
}

function formatEventMsg(payload: Record<string, unknown>): string | null {
  const type = typeof payload.type === 'string' ? payload.type : 'event';
  switch (type) {
    case 'task_started':
      return `turn started · turn ${shortId(payload.turn_id)}`;
    case 'task_complete': {
      const secs =
        typeof payload.duration_ms === 'number' ? `${(payload.duration_ms / 1000).toFixed(1)}s` : '?';
      const last = typeof payload.last_agent_message === 'string' ? clip(payload.last_agent_message, 80) : '';
      return `turn done ${secs}${last ? ` · ${last}` : ''}`;
    }
    case 'item_completed': {
      const item = payload.item;
      if (!item || typeof item !== 'object') return 'item completed';
      const itemType = (item as Record<string, unknown>).type;
      const text = contentText((item as Record<string, unknown>).content);
      if (itemType === 'UserMessage') return `user: ${clip(text)}`;
      if (itemType === 'AgentMessage') return `agent: ${clip(text)}`;
      return `item completed · ${String(itemType ?? '?')}${text ? ` ${clip(text, 60)}` : ''}`;
    }
    case 'token_count': {
      const info = payload.info;
      const usage =
        info && typeof info === 'object'
          ? (info as Record<string, unknown>).last_token_usage
          : undefined;
      if (!usage || typeof usage !== 'object') return 'token count';
      const u = usage as Record<string, unknown>;
      const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
      const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
      const reasoning = typeof u.reasoning_output_tokens === 'number' ? u.reasoning_output_tokens : 0;
      return `tokens ${input} in / ${output} out${reasoning ? ` (+${reasoning} reasoning)` : ''}`;
    }
    case 'thread_settings_applied':
    case 'agent_message_delta':
      return null; // settings noise and streaming deltas are not useful here
    default:
      return `· ${type}`;
  }
}

/** Returns a display line, or null when the record should be skipped. */
export function formatRolloutLine(line: string): string | null {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(line) as Envelope;
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object') return null;
  const prefix = clock(envelope.timestamp);
  const payload = envelope.payload;

  switch (envelope.type) {
    case 'session_meta':
      return `${prefix} session ${shortId(payload?.session_id ?? payload?.id)} opened`;
    case 'event_msg':
      if (!payload) return null;
      {
        const formatted = formatEventMsg(payload);
        return formatted ? `${prefix} ${formatted}` : null;
      }
    // Bulk records and bookkeeping are not watch-worthy.
    case 'response_item':
    case 'turn_context':
    case 'world_state':
    case 'token_usage_record':
      return null;
    default:
      return null;
  }
}
