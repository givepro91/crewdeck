import { describe, it, expect, vi } from 'vitest';
import {
  AgentActivityRing,
  ActivityLogStore,
  parseActivityEvents,
  truncateDetail,
  ACTIVITY_RING_SIZE,
  ACTIVITY_DETAIL_MAX,
} from '../core/agent/activity-log.js';

describe('AgentActivityRing — bounded ring buffer', () => {
  it('caps at ACTIVITY_RING_SIZE, evicting oldest first', () => {
    const ring = new AgentActivityRing();
    for (let i = 0; i < ACTIVITY_RING_SIZE + 20; i++) {
      ring.push('command', `cmd-${i}`, `2026-07-08T00:00:${String(i % 60).padStart(2, '0')}.000Z`);
    }
    const list = ring.list();
    expect(ring.size).toBe(ACTIVITY_RING_SIZE);
    expect(list.length).toBe(ACTIVITY_RING_SIZE);
    // Oldest surviving entry is #20 (0..19 evicted)
    expect(list[0].detail).toBe('cmd-20');
    expect(list[list.length - 1].detail).toBe(`cmd-${ACTIVITY_RING_SIZE + 19}`);
  });

  it('truncates detail to ACTIVITY_DETAIL_MAX chars and tracks lastEventAt', () => {
    const ring = new AgentActivityRing();
    expect(ring.lastEventAt).toBeNull();
    const long = 'x'.repeat(500);
    const ev = ring.push('text', long, '2026-07-08T01:02:03.000Z');
    expect(ev.detail.length).toBe(ACTIVITY_DETAIL_MAX);
    expect(ring.lastEventAt).toBe('2026-07-08T01:02:03.000Z');
  });

  it('list() preserves chronological order and clear() empties it', () => {
    const ring = new AgentActivityRing();
    ring.push('command', 'a', '2026-07-08T00:00:01.000Z');
    ring.push('file_read', 'b', '2026-07-08T00:00:02.000Z');
    expect(ring.list().map((e) => e.detail)).toEqual(['a', 'b']);
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.lastEventAt).toBeNull();
    expect(ring.snapshot()).toEqual({ lastEventAt: null, events: [] });
  });
});

describe('truncateDetail', () => {
  it('collapses whitespace to a single line', () => {
    expect(truncateDetail('  foo\n\t  bar  baz ')).toBe('foo bar baz');
  });
  it('returns empty string for null/undefined', () => {
    expect(truncateDetail(null)).toBe('');
    expect(truncateDetail(undefined)).toBe('');
  });
});

describe('parseActivityEvents — stream-json line → activity', () => {
  it('extracts assistant text and tool_use blocks in order', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check the file' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    });
    const events = parseActivityEvents(line);
    expect(events).toEqual([
      { kind: 'text', detail: 'Let me check the file' },
      { kind: 'command', detail: 'ls -la' },
    ]);
  });

  it('maps Read to file_read and Edit to file_edit using file_path', () => {
    const read = parseActivityEvents(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }] },
    }));
    expect(read).toEqual([{ kind: 'file_read', detail: '/a/b.ts' }]);

    const edit = parseActivityEvents(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/c/d.ts' } }] },
    }));
    expect(edit).toEqual([{ kind: 'file_edit', detail: '/c/d.ts' }]);
  });

  it('maps unknown tools to "tool" kind with the tool name as fallback detail', () => {
    const events = parseActivityEvents(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'WebSearch', input: {} }] },
    }));
    expect(events).toEqual([{ kind: 'tool', detail: 'WebSearch' }]);
  });

  it('ignores empty/whitespace-only text blocks and malformed JSON', () => {
    expect(parseActivityEvents('not json')).toEqual([]);
    expect(parseActivityEvents('')).toEqual([]);
    const events = parseActivityEvents(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '   \n  ' }] },
    }));
    expect(events).toEqual([]);
  });

  it('ignores non-assistant events (result/system/user tool_result)', () => {
    expect(parseActivityEvents(JSON.stringify({ type: 'result', result: 'done' }))).toEqual([]);
    expect(parseActivityEvents(JSON.stringify({ type: 'system', session_id: 's1' }))).toEqual([]);
  });
});

describe('ActivityLogStore — per-agent rings + throttled broadcast', () => {
  it('returns an empty snapshot for an unknown agent', () => {
    const store = new ActivityLogStore();
    expect(store.snapshot('nobody')).toEqual({ lastEventAt: null, events: [] });
  });

  it('records events per agent and reset() clears only that agent', () => {
    const store = new ActivityLogStore();
    store.record('a1', 'command', 'ls', '2026-07-08T00:00:01.000Z');
    store.record('a2', 'file_read', '/x', '2026-07-08T00:00:02.000Z');
    expect(store.snapshot('a1').events).toHaveLength(1);
    expect(store.snapshot('a1').lastEventAt).toBe('2026-07-08T00:00:01.000Z');
    store.reset('a1');
    expect(store.snapshot('a1')).toEqual({ lastEventAt: null, events: [] });
    expect(store.snapshot('a2').events).toHaveLength(1);
  });

  it('throttles broadcasts to at most one per second per agent', () => {
    const spy = vi.fn();
    const store = new ActivityLogStore(); // default 1000ms throttle
    store.setBroadcaster(spy);
    store.record('a1', 'command', 'one');
    store.record('a1', 'command', 'two'); // within 1s → throttled
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('agent:activity', expect.objectContaining({ agentId: 'a1' }));
    // Ring still captured both despite the dropped broadcast
    expect(store.snapshot('a1').events).toHaveLength(2);
  });

  it('broadcasts every event when throttle window is zero', () => {
    const spy = vi.fn();
    const store = new ActivityLogStore({ throttleMs: 0 });
    store.setBroadcaster(spy);
    store.record('a1', 'command', 'one');
    store.record('a1', 'command', 'two');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
