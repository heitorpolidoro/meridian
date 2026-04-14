import { exec } from 'node:child_process';
import { IShell } from '../interfaces/ICoreServices';

export class NodeShell implements IShell {
  execute(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      exec(command, (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error ? error.code || 1 : 0
        });
      });
    });
  }
}
