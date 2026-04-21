import { describe, it, expect } from 'vitest';
import { MockFileSystem, MockShell as MockServicesShell } from './MockServices';
import { MockShell } from './MockShell';

describe('MockServices', () => {
  describe('MockFileSystem', () => {
    it('readFile throws error when file does not exist', () => {
      const fs = new MockFileSystem();
      expect(() => fs.readFile('nonexistent.txt')).toThrow('File not found: nonexistent.txt');
    });
  });

  describe('MockServicesShell', () => {
    it('execute returns resolved promise when response exists', async () => {
      const shell = new MockServicesShell();
      shell.__setupResponse('test-cmd', { stdout: 'success', stderr: '', exitCode: 0 });
      const res = await shell.execute('test-cmd');
      expect(res.stdout).toBe('success');
    });
  });

  describe('MockShell', () => {
    it('exec returns resolved promise when response exists', async () => {
      const shell = new MockShell();
      shell.setMockResponse('test-cmd', { stdout: 'success', stderr: '' });
      const res = await shell.exec('test-cmd');
      expect(res.stdout).toBe('success');
    });
  });
});
