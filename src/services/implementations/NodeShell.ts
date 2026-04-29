import { exec } from 'node:child_process';
import { IShell } from '../interfaces/ICoreServices';

export class NodeShell implements IShell {
  execute(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      // Define a secure, fixed PATH to prevent ReDoS/Path injection issues
      const secureEnv = {
        ...process.env,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin'
      };

      exec(command, { env: secureEnv }, (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error ? error.code || 1 : 0
        });
      });
    });
  }
}
