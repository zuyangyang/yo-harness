/**
 * utils/logger 单测：级别解析（宽松回落）与级别过滤（sink 注入捕获，
 * 不碰全局 process.stderr）。
 */
import { describe, expect, it } from 'vitest';

import { createLogger, parseLogLevel, type LogSink } from '../../src/utils/logger.js';

function capture(): { lines: string[]; sink: LogSink } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe('parseLogLevel', () => {
  it('未设置 / 空白回落 info', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('   ')).toBe('info');
  });

  it('大小写与空白不敏感', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel(' warn ')).toBe('warn');
    expect(parseLogLevel('Error')).toBe('error');
    expect(parseLogLevel('silent')).toBe('silent');
  });

  it('未知值回落 info（日志配置不该把程序搞挂）', () => {
    expect(parseLogLevel('verbose')).toBe('info');
    expect(parseLogLevel('1')).toBe('info');
  });
});

describe('createLogger', () => {
  it('输出带 yo 前缀与级别，data 序列化为 JSON 后缀', () => {
    const { lines, sink } = capture();
    createLogger('debug', sink).warn('disk full', { path: '/tmp/a' });
    expect(lines).toEqual(['yo warn disk full {"path":"/tmp/a"}']);
  });

  it('无 data 时不带后缀', () => {
    const { lines, sink } = capture();
    createLogger('info', sink).info('started');
    expect(lines).toEqual(['yo info started']);
  });

  it('低于级别的日志被过滤', () => {
    const { lines, sink } = capture();
    const logger = createLogger('warn', sink);
    logger.debug('nope');
    logger.info('nope');
    logger.warn('yes');
    logger.error('yes');
    expect(lines).toEqual(['yo warn yes', 'yo error yes']);
  });

  it('silent 全部静默', () => {
    const { lines, sink } = capture();
    const logger = createLogger('silent', sink);
    logger.debug('a');
    logger.error('b');
    expect(lines).toEqual([]);
  });

  it('stringify 失败（循环引用）降级 String 且不抛', () => {
    const { lines, sink } = capture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => createLogger('debug', sink).error('boom', circular)).not.toThrow();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('yo error boom');
  });
});
