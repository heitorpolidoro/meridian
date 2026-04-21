import { IShell } from '../IShell.ts';

export class MockShell implements IShell {
  private mockResponses: Map<string, { stdout: string; stderr: string }> = new Map();

  // skipcq: JS-0105
  exec(command: string, _options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
    const response = this.mockResponses.get(command);
    if (response) {
      return Promise.resolve(response);
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  }

  setMockResponse(command: string, response: { stdout: string; stderr: string }): void {
    this.mockResponses.set(command, response);
  }
}
