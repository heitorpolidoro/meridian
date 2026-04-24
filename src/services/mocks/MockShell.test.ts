import { describe, it, expect } from 'vitest';
import { MockShell } from './MockShell';

describe('MockShell', () => {
  it('should return a default response for an unknown command', async () => {
    const shell = new MockShell();
    const result = await shell.execute('unknown-command');
    
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('should return a predefined response set via setMockResponse', async () => {
    const shell = new MockShell();
    const mockResponse = { stdout: 'hello', stderr: '', exitCode: 0 };
    shell.setMockResponse('echo hello', mockResponse);
    
    const result = await shell.execute('echo hello');
    expect(result).toEqual(mockResponse);
  });

  it('should return a predefined response set via __setupResponse', async () => {
    const shell = new MockShell();
    const mockResponse = { stdout: '', stderr: 'error', exitCode: 1 };
    // @ts-expect-error accessing private-ish helper
    shell.__setupResponse('fail-cmd', mockResponse);
    
    const result = await shell.execute('fail-cmd');
    expect(result).toEqual(mockResponse);
  });
});
