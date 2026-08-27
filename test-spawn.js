const { spawn } = require('child_process');
const fs = require('fs');

fs.writeFileSync('dummy.txt', 'echo hello world and exit', 'utf8');

console.log('Spawning agy...');
const child = spawn('agy "Read dummy.txt and execute it."', { shell: true });

child.stdout.on('data', data => console.log('STDOUT:', data.toString()));
child.stderr.on('data', data => console.log('STDERR:', data.toString()));

child.on('close', code => console.log('Exited with code:', code));
child.on('error', err => console.error('Error:', err));
