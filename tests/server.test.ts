import { describe, it, expect } from '@jest/globals';
import { createMcpServer, TOOL_ANNOTATIONS, completable, McpServer } from '../src/server.js';

describe('server module', () => {
  describe('createMcpServer', () => {
    it('returns an McpServer instance', () => {
      const server = createMcpServer('test-mcp', '1.2.3');
      expect(server).toBeInstanceOf(McpServer);
      expect(typeof server.registerTool).toBe('function');
      expect(typeof server.registerPrompt).toBe('function');
    });

    it('creates an independent instance per call', () => {
      const a = createMcpServer('a', '1.0.0');
      const b = createMcpServer('b', '1.0.0');
      expect(a).not.toBe(b);
    });
  });

  describe('TOOL_ANNOTATIONS presets', () => {
    it('readOnly is read-only + idempotent', () => {
      expect(TOOL_ANNOTATIONS.readOnly).toEqual({ readOnlyHint: true, idempotentHint: true });
    });

    it('idempotentWrite is a non-read, idempotent write', () => {
      expect(TOOL_ANNOTATIONS.idempotentWrite).toEqual({ readOnlyHint: false, idempotentHint: true });
    });

    it('mutableWrite is a non-idempotent write', () => {
      expect(TOOL_ANNOTATIONS.mutableWrite).toEqual({ readOnlyHint: false, idempotentHint: false });
    });

    it('destructive carries the destructive hint', () => {
      expect(TOOL_ANNOTATIONS.destructive).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });
    });
  });

  describe('re-exports', () => {
    it('completable is a function (SDK re-export)', () => {
      expect(typeof completable).toBe('function');
    });
  });
});
