import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeShell } from './NodeShell';

describe('NodeShell', () => {
  let mockExec: ReturnType<typeof vi.fn>;
  let shell: NodeShell;

  beforeEach(() => {
    mockExec = vi.fn();
    shell = new NodeShell(mockExec);
  });

  it('should execute a command successfully', async () => {
    const mockStdout = 'success output';
    const mockStderr = '';
    
    mockExec.mockImplementation((cmd: string, options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(null, mockStdout, mockStderr);
    });

    const result = await shell.execute('ls');

    expect(result.stdout).toBe(mockStdout);
    expect(result.stderr).toBe(mockStderr);
    expect(result.exitCode).toBe(0);
    expect(mockExec).toHaveBeenCalledWith(
      'ls',
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: expect.stringContaining('/bin')
        })
      }),
      expect.any(Function)
    );
  });

  it('should return exit code from error object if command fails', async () => {
    const mockStdout = '';
    const mockStderr = 'error message';
    const mockError = { code: 127 };
    
    mockExec.mockImplementation((cmd: string, options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(mockError, mockStdout, mockStderr);
    });

    const result = await shell.execute('invalid-command');

    expect(result.stdout).toBe(mockStdout);
    expect(result.stderr).toBe(mockStderr);
    expect(result.exitCode).toBe(127);
  });

  it('should fallback to exit code 1 if error object has no code', async () => {
    const mockError = {}; // No code property
    
    mockExec.mockImplementation((cmd: string, options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(mockError, '', '');
    });

    const result = await shell.execute('some-command');

    expect(result.exitCode).toBe(1);
  });
});
