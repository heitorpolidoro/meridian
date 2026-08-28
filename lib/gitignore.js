'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Appends `.meridian/` to a project's .gitignore unless it is already mentioned,
// creating the file when it does not exist. Registering a project writes a task
// board into <project>/.meridian, and schema.md states that directory is
// gitignored - so both registration paths (cli.js add and POST /api/projects)
// have to make that true.
//
// Returns true when the entry was appended, false when it was already there.
// Throws only on an unreadable/unwritable .gitignore; callers decide whether
// that is fatal.
function ensureMeridianIgnored(projectPath) {
    const gitignorePath = path.join(projectPath, '.gitignore');
    let content = '';
    if (fs.existsSync(gitignorePath)) {
        content = fs.readFileSync(gitignorePath, 'utf8');
    }
    if (content.includes('.meridian')) {
        return false;
    }
    const nl = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(gitignorePath, nl + '.meridian/\n', 'utf8');
    return true;
}

module.exports = { ensureMeridianIgnored };
