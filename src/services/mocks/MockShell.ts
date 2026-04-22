import { IShell } from '../interfaces/ICoreServices';

/**
 * Mock implementation of IShell for testing.
 */
export class MockShell implements IShell {
  private readonly responses: Map<string, { stdout: string; stderr: string; exitCode: number }> = new Map();

  /**
   * Executes a mock shell command and returns the predefined response.
   */
  execute(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const response = this.responses.get(command);

    if (response) {
      return Promise.resolve(response);
    }
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  }

  /**
   * Helper for tests to setup command responses.
   */
  __setupResponse(command: string, response: { stdout: string; stderr: string; exitCode: number }) {
    this.responses.set(command, response);
  }

  setMockResponse(command: string, response: { stdout: string; stderr: string; exitCode: number }) {
    this.__setupResponse(command, response);
  }
}
