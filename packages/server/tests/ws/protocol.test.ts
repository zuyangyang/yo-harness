/**
 * WebSocket 协议编解码测试。
 */
import { describe, it, expect } from 'vitest';
import {
  isClientMessage,
  encodeServerMessage,
  decodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '../../src/ws/protocol.js';

describe('isClientMessage', () => {
  it('subscribe 消息 → true', () => {
    expect(isClientMessage({ type: 'subscribe', sessionId: 's1' })).toBe(true);
  });

  it('unsubscribe 消息 → true', () => {
    expect(isClientMessage({ type: 'unsubscribe', sessionId: 's1' })).toBe(true);
  });

  it('approval.resolve 消息 → true', () => {
    expect(isClientMessage({ type: 'approval.resolve', approvalId: 'a1', approved: true })).toBe(true);
  });

  it('ping 消息 → true', () => {
    expect(isClientMessage({ type: 'ping' })).toBe(true);
  });

  it('未知 type → false', () => {
    expect(isClientMessage({ type: 'unknown' })).toBe(false);
  });

  it('非对象 → false', () => {
    expect(isClientMessage('string')).toBe(false);
    expect(isClientMessage(null)).toBe(false);
    expect(isClientMessage(undefined)).toBe(false);
  });

  it('服务端消息类型 → false', () => {
    expect(isClientMessage({ type: 'event', sessionId: 's1', event: {} })).toBe(false);
    expect(isClientMessage({ type: 'pong' })).toBe(false);
    expect(isClientMessage({ type: 'error', code: 'x', message: 'y' })).toBe(false);
    expect(isClientMessage({ type: 'approval.request', approvalId: 'a', sessionId: 's', toolName: 't', summary: '' })).toBe(false);
  });
});

describe('encodeServerMessage', () => {
  it('event 消息序列化为 JSON', () => {
    const msg: ServerMessage = {
      type: 'event',
      sessionId: 's1',
      event: { id: 'e1', sessionId: 's1', type: 'assistant.text', timestamp: 0, data: { text: 'hi' } },
    };
    const encoded = encodeServerMessage(msg);
    const parsed = JSON.parse(encoded);
    expect(parsed.type).toBe('event');
    expect(parsed.sessionId).toBe('s1');
    expect(parsed.event.data.text).toBe('hi');
  });

  it('pong 消息序列化', () => {
    const msg: ServerMessage = { type: 'pong' };
    expect(JSON.parse(encodeServerMessage(msg))).toEqual({ type: 'pong' });
  });

  it('error 消息序列化', () => {
    const msg: ServerMessage = { type: 'error', code: 'bad', message: 'something wrong' };
    const parsed = JSON.parse(encodeServerMessage(msg));
    expect(parsed.code).toBe('bad');
    expect(parsed.message).toBe('something wrong');
  });

  it('approval.request 消息序列化', () => {
    const msg: ServerMessage = {
      type: 'approval.request',
      approvalId: 'a1',
      sessionId: 's1',
      toolName: 'Bash',
      summary: 'rm -rf /',
    };
    const parsed = JSON.parse(encodeServerMessage(msg));
    expect(parsed.toolName).toBe('Bash');
  });
});

describe('decodeClientMessage', () => {
  it('合法 subscribe JSON → ClientMessage', () => {
    const msg = decodeClientMessage('{"type":"subscribe","sessionId":"s1"}');
    expect(msg).toEqual({ type: 'subscribe', sessionId: 's1' });
  });

  it('合法 ping JSON → ClientMessage', () => {
    const msg = decodeClientMessage('{"type":"ping"}');
    expect(msg).toEqual({ type: 'ping' });
  });

  it('合法 approval.resolve JSON → ClientMessage', () => {
    const raw = '{"type":"approval.resolve","approvalId":"a1","approved":false,"scope":"session"}';
    const msg = decodeClientMessage(raw);
    expect(msg).toEqual({ type: 'approval.resolve', approvalId: 'a1', approved: false, scope: 'session' });
  });

  it('无效 JSON → null', () => {
    expect(decodeClientMessage('not json')).toBeNull();
  });

  it('未知 type → null', () => {
    expect(decodeClientMessage('{"type":"unknown"}')).toBeNull();
  });

  it('服务端消息类型 → null', () => {
    expect(decodeClientMessage('{"type":"pong"}')).toBeNull();
  });
});
