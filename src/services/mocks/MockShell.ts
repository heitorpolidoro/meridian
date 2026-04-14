import { IShell } from '../IShell.ts';

export class MockShell implements IShell {
  private mockResponses: Map<string, { stdout: string; stderr: string }> = new Map();

  async exec(command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
    if (this.mockResponses.has(command)) {
      return this.mockResponses.get(command)!;
    }
    return { stdout: '', stderr: '' };
  }

  setMockResponse(command: string, response: { stdout: string; stderr: string }): void {
    this.mockResponses.set(command, response);
  }
}
