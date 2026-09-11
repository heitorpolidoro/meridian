# Tasks em JSONL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir `<project>/.meridian/tasks.json` por `tasks.jsonl` (uma task por linha) com `expected_results` movido para `tasks/<id>.json`, cortando o payload do board de 696KB para ~76KB no maior projeto.

**Architecture:** Todo o conhecimento do split fica em `lib/tasks.js`. `getTasks` lê linhas e **não** hidrata `expected_results`; `getTask` hidrata uma task; `saveTasks` escreve o detalhe antes da linha. `server.js` muda pouco: `/api/status` fica leve e ganha um irmão `GET /api/projects/tasks/:taskId` para o caminho hidratado. Migração one-shot com backup e verificação, corte seco sem convivência de formatos.

**Tech Stack:** Node.js CommonJS, Express 5, `node --test` (test runner nativo), sem dependências novas.

**Spec:** `docs/superpowers/specs/2026-09-11-tasks-jsonl-design.md`

## Global Constraints

- `.meridian/` é gitignored: um arquivo de tasks perdido é **irrecuperável**. Nunca truncar, nunca escrever a partir de lista vazia, nunca sobrescrever arquivo ilegível.
- Toda escrita de arquivo é atômica: serializa → arquivo temporário irmão → `fs.renameSync`. Padrão já em `lib/tasks.js:97`.
- Ordem de escrita: **detalhe antes da linha**. Sempre.
- `saveTasks` distingue `expected_results` ausente (não toca no detalhe) de array vazio (apaga o detalhe).
- Os nove status: `backlog`, `spec_review`, `ready_todo`, `in_progress`, `code_review`, `qa_review`, `blocked`, `done`, `nope`.
- As quatro prioridades: `critical`, `high`, `medium`, `low`.
- Commits em Conventional Commits com escopo da task Meridian quando houver.
- **Antes da Task 1:** parar o servidor (`kill $(cat meridian-server.pid)`). O board fica fora do ar entre a Task 1 e a Task 7 — é o preço do corte seco. Religar após a Task 7.

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `lib/tasks.js` (modificar) | Única fronteira do split: leitura/escrita JSONL, detalhe por task, erros |
| `server.js` (modificar) | Rotas: `/api/status` leve, novo `GET /api/projects/tasks/:taskId`, `DELETE` apaga detalhe |
| `scripts/migrate-tasks-jsonl.js` (criar) | Migração one-shot com backup e verificação |
| `scripts/migrate-task-ids.js` (modificar) | Renomear `tasks/<antigo>.json` junto com o id |
| `test/tasks.test.js` (modificar) | Unidade do módulo |
| `test/api-tasks.test.js` (modificar) | Contrato HTTP |
| `test/migrate-tasks-jsonl.test.js` (criar) | Migração, incluindo o caminho de falha |
| `plugin/plugins/meridian/references/*.md`, `skills/*/SKILL.md`, `agents/*.md`, `agents/Odin.md`, `agents/pm.md`, `prompts/boilerplate.txt` (modificar) | Documentação do formato e do novo endpoint |

Nenhuma mudança em `lib/board.js`, `lib/stats.js`, `lib/events.js`, `lib/routes.js`, `public/app.js`: nenhum deles lê `expected_results`. O watcher de `server.js:1049` observa `.meridian/` recursivamente, então `tasks/` já entra na cobertura sem mudança — a contrapartida é um `broadcastUpdate()` extra por save, comportamento pré-existente do watcher sem debounce e fora do escopo.

---

### Task 1: `tasks.jsonl` como formato de leitura e escrita

Sem split ainda — só a troca de container. `expected_results` continua viajando na linha até a Task 2.

**Files:**
- Modify: `lib/tasks.js:73-110` (`getTasks`, `saveTasks`, `MalformedTasksError`)
- Test: `test/tasks.test.js:35-110`

**Interfaces:**
- Consumes: nada de tasks anteriores.
- Produces: `getTasks(projPath) -> { tasks: Array<object> }`; `saveTasks(projPath, { tasks }) -> void`; `class MalformedTasksError extends Error` com `.tasksPath`; `class LegacyTasksFileError extends Error` com `.tasksPath`.

- [ ] **Step 1: Write the failing tests**

Substituir o helper `tmpProject` e os testes de `getTasks`/`saveTasks` em `test/tasks.test.js` por:

```javascript
function tmpProject(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-test-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    if (lines !== undefined) {
        fs.writeFileSync(
            path.join(dir, '.meridian', 'tasks.jsonl'),
            lines.map(t => JSON.stringify(t)).join('\n') + '\n'
        );
    }
    return dir;
}

test('getTasks: reads one task per line', () => {
    const dir = tmpProject([{ id: 'A-1' }, { id: 'A-2' }]);
    assert.deepEqual(getTasks(dir).tasks.map(t => t.id), ['A-1', 'A-2']);
});

test('getTasks: applies the read-path defaults', () => {
    const dir = tmpProject([{ id: 'A-1' }]);
    assert.equal(getTasks(dir).tasks[0].priority, 'medium');
});

test('getTasks: blank lines are skipped, not parsed', () => {
    const dir = tmpProject(undefined);
    fs.writeFileSync(
        path.join(dir, '.meridian', 'tasks.jsonl'),
        '{"id":"A-1"}\n\n{"id":"A-2"}\n'
    );
    assert.deepEqual(getTasks(dir).tasks.map(t => t.id), ['A-1', 'A-2']);
});

test('getTasks: missing file yields an empty list', () => {
    const dir = tmpProject(undefined);
    assert.deepEqual(getTasks(dir).tasks, []);
});

test('getTasks: an unparseable line names its line number and aborts the read', () => {
    const dir = tmpProject(undefined);
    fs.writeFileSync(
        path.join(dir, '.meridian', 'tasks.jsonl'),
        '{"id":"A-1"}\n{not json\n{"id":"A-3"}\n'
    );
    assert.throws(() => getTasks(dir), (err) => {
        assert.ok(err instanceof MalformedTasksError);
        assert.match(err.message, /line 2/);
        return true;
    });
});

test('getTasks: a legacy tasks.json without tasks.jsonl demands the migration', () => {
    const dir = tmpProject(undefined);
    fs.writeFileSync(
        path.join(dir, '.meridian', 'tasks.json'),
        JSON.stringify([{ id: 'A-1' }])
    );
    assert.throws(() => getTasks(dir), (err) => {
        assert.ok(err instanceof LegacyTasksFileError);
        assert.match(err.message, /migrate-tasks-jsonl/);
        return true;
    });
});

test('saveTasks: writes one compact line per task with a trailing newline', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', title: 'um' }, { id: 'A-2', title: 'dois' }] });
    const raw = fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8');
    assert.equal(raw, '{"id":"A-1","title":"um"}\n{"id":"A-2","title":"dois"}\n');
});

test('saveTasks: leaves no temp file behind', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1' }] });
    const entries = fs.readdirSync(path.join(dir, '.meridian'));
    assert.deepEqual(entries, ['tasks.jsonl']);
});
```

Adicionar `LegacyTasksFileError` ao `require` no topo do arquivo.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/tasks.test.js`
Expected: FAIL — `LegacyTasksFileError` é `undefined` no destructuring, e os testes de leitura falham porque `getTasks` ainda procura `tasks.json`.

- [ ] **Step 3: Write the implementation**

Em `lib/tasks.js`, substituir `getTasks` e `saveTasks` e acrescentar a nova classe de erro:

```javascript
// Levantado quando só o formato antigo está presente. Um fallback silencioso
// para tasks.json deixaria duas fontes vivas para o mesmo estado, que é como um
// backlog se perde — o operador roda a migração e segue.
class LegacyTasksFileError extends Error {
    constructor(tasksPath) {
        super(`Legacy tasks.json at ${tasksPath}: run scripts/migrate-tasks-jsonl.js to convert this project to tasks.jsonl`);
        this.name = 'LegacyTasksFileError';
        this.tasksPath = tasksPath;
    }
}

function tasksPathFor(projPath) {
    return path.join(projPath, '.meridian', 'tasks.jsonl');
}

function getTasks(projPath) {
    const tasksPath = tasksPathFor(projPath);
    if (!fs.existsSync(tasksPath)) {
        const legacy = path.join(projPath, '.meridian', 'tasks.json');
        if (fs.existsSync(legacy)) throw new LegacyTasksFileError(legacy);
        return { tasks: [] };
    }
    const raw = fs.readFileSync(tasksPath, 'utf8');
    const tasks = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch (e) {
            // Aborta a leitura inteira: uma lista parcial seria reescrita por
            // cima do arquivo no próximo save, perdendo a task ilegível.
            throw new MalformedTasksError(tasksPath, `line ${i + 1}: ${e.message}`);
        }
        tasks.push(parsed);
    }
    return { tasks: backfillTasks(tasks) };
}

function saveTasks(projPath, tasksData) {
    const localMeridianDir = path.join(projPath, '.meridian');
    if (!fs.existsSync(localMeridianDir)) {
        fs.mkdirSync(localMeridianDir, { recursive: true });
    }
    const target = tasksPathFor(projPath);
    const payload = tasksData.tasks.map(t => JSON.stringify(t)).join('\n') + '\n';
    const tmp = path.join(localMeridianDir, `.tasks.jsonl.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, target);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (e) { /* nothing to clean up */ }
        throw err;
    }
}
```

Atualizar o comentário de `MalformedTasksError` (`lib/tasks.js:60-64`) para citar `tasks.jsonl`, e o `module.exports` para incluir `LegacyTasksFileError`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/tasks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks.js test/tasks.test.js
git commit -m "feat(tasks-jsonl): ler e escrever tasks em jsonl"
```

---

### Task 2: `expected_results` fora da linha

**Files:**
- Modify: `lib/tasks.js` (`saveTasks`, novas `getTask` e `deleteTaskDetail`)
- Test: `test/tasks.test.js`

**Interfaces:**
- Consumes: `getTasks`, `saveTasks`, `LegacyTasksFileError` da Task 1.
- Produces: `getTask(projPath, id) -> object | null` (task hidratada); `deleteTaskDetail(projPath, id) -> void`. `getTasks` continua **sem** `expected_results`.

- [ ] **Step 1: Write the failing tests**

Acrescentar a `test/tasks.test.js` (e incluir `getTask`, `deleteTaskDetail` no `require`):

```javascript
const detail = (dir, id) => path.join(dir, '.meridian', 'tasks', `${id}.json`);

test('saveTasks: expected_results goes to the detail file, not the line', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', title: 'um', expected_results: ['r1', 'r2'] }] });
    const line = fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8');
    assert.ok(!line.includes('expected_results'), 'a linha não carrega o campo pesado');
    assert.deepEqual(
        JSON.parse(fs.readFileSync(detail(dir, 'A-1'), 'utf8')),
        { expected_results: ['r1', 'r2'] }
    );
});

test('saveTasks: an empty expected_results writes no detail file', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: [] }] });
    assert.equal(fs.existsSync(detail(dir, 'A-1')), false);
});

test('saveTasks: emptying expected_results deletes the detail file', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: ['r1'] }] });
    saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: [] }] });
    assert.equal(fs.existsSync(detail(dir, 'A-1')), false);
});

test('saveTasks: an absent expected_results leaves the detail file untouched', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: ['r1'] }] });
    // É exatamente o round-trip que toda rota de escrita faz: getTasks devolve
    // a task sem o campo, e o save seguinte não pode apagar os resultados.
    const light = getTasks(dir);
    light.tasks[0].status = 'done';
    saveTasks(dir, light);
    assert.deepEqual(
        JSON.parse(fs.readFileSync(detail(dir, 'A-1'), 'utf8')),
        { expected_results: ['r1'] }
    );
});

test('getTasks: does not hydrate expected_results', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: ['r1'] }] });
    assert.equal(getTasks(dir).tasks[0].expected_results, undefined);
});

test('getTask: merges the line with its detail file', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', title: 'um', expected_results: ['r1'] }] });
    const task = getTask(dir, 'A-1');
    assert.equal(task.title, 'um');
    assert.deepEqual(task.expected_results, ['r1']);
});

test('getTask: a task with no detail file reads expected_results as empty', () => {
    const dir = tmpProject([{ id: 'A-1' }]);
    assert.deepEqual(getTask(dir, 'A-1').expected_results, []);
});

test('getTask: an unknown id is null', () => {
    const dir = tmpProject([{ id: 'A-1' }]);
    assert.equal(getTask(dir, 'A-9'), null);
});

test('getTasks: an orphan detail file is inert', () => {
    const dir = tmpProject([{ id: 'A-1' }]);
    fs.mkdirSync(path.join(dir, '.meridian', 'tasks'), { recursive: true });
    fs.writeFileSync(detail(dir, 'A-ORPHAN'), JSON.stringify({ expected_results: ['x'] }));
    assert.deepEqual(getTasks(dir).tasks.map(t => t.id), ['A-1']);
});

test('deleteTaskDetail: removes the file and tolerates its absence', () => {
    const dir = tmpProject(undefined);
    saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: ['r1'] }] });
    deleteTaskDetail(dir, 'A-1');
    assert.equal(fs.existsSync(detail(dir, 'A-1')), false);
    deleteTaskDetail(dir, 'A-1');
});

test('saveTasks: the detail file lands before the line', () => {
    const dir = tmpProject(undefined);
    const order = [];
    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => { order.push(path.basename(to)); return realRename(from, to); };
    try {
        saveTasks(dir, { tasks: [{ id: 'A-1', expected_results: ['r1'] }] });
    } finally {
        fs.renameSync = realRename;
    }
    assert.deepEqual(order, ['A-1.json', 'tasks.jsonl']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/tasks.test.js`
Expected: FAIL — `getTask` e `deleteTaskDetail` não existem; `expected_results` ainda é serializado na linha.

- [ ] **Step 3: Write the implementation**

Em `lib/tasks.js`:

```javascript
// O único campo que mora fora da linha. É 89% dos bytes do maior board e
// nenhuma UI o lê: todo consumidor pega uma task por vez, no dispatch.
const DETAIL_FIELD = 'expected_results';

function detailDir(projPath) {
    return path.join(projPath, '.meridian', 'tasks');
}

function detailPathFor(projPath, id) {
    return path.join(detailDir(projPath), `${id}.json`);
}

function writeAtomic(targetPath, payload) {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, targetPath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (e) { /* nothing to clean up */ }
        throw err;
    }
}

function deleteTaskDetail(projPath, id) {
    try {
        fs.unlinkSync(detailPathFor(projPath, id));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
}

function readTaskDetail(projPath, id) {
    const p = detailPathFor(projPath, id);
    if (!fs.existsSync(p)) return [];
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        throw new MalformedTasksError(p, e.message);
    }
    return Array.isArray(parsed[DETAIL_FIELD]) ? parsed[DETAIL_FIELD] : [];
}

function getTask(projPath, id) {
    const task = getTasks(projPath).tasks.find(t => t.id === id);
    if (!task) return null;
    task[DETAIL_FIELD] = readTaskDetail(projPath, id);
    return task;
}
```

Reescrever o corpo de `saveTasks` para separar antes de serializar, preservando o `writeAtomic` da linha:

```javascript
function saveTasks(projPath, tasksData) {
    const localMeridianDir = path.join(projPath, '.meridian');
    if (!fs.existsSync(localMeridianDir)) {
        fs.mkdirSync(localMeridianDir, { recursive: true });
    }
    // Detalhe primeiro, linha depois. Um crash no intervalo deixa um detalhe
    // adiantado, que é inerte — a linha é o que faz a task existir. A ordem
    // inversa deixaria resultados defasados numa task viva, e resultado
    // defasado é o erro que o QA não percebe.
    const lines = [];
    for (const task of tasksData.tasks) {
        const results = task[DETAIL_FIELD];
        if (results !== undefined) {
            // Ausente ≠ vazio: getTasks devolve tasks sem o campo, e tratar
            // ausência como vazio apagaria todo detalhe no primeiro save.
            if (Array.isArray(results) && results.length > 0) {
                writeAtomic(detailPathFor(projPath, task.id), JSON.stringify({ [DETAIL_FIELD]: results }));
            } else {
                deleteTaskDetail(projPath, task.id);
            }
        }
        const line = { ...task };
        delete line[DETAIL_FIELD];
        lines.push(JSON.stringify(line));
    }
    writeAtomic(tasksPathFor(projPath), lines.join('\n') + '\n');
}
```

Exportar `getTask` e `deleteTaskDetail`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/tasks.test.js`
Expected: PASS. O teste de "leaves no temp file behind" da Task 1 continua valendo — `writeAtomic` limpa o tmp.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks.js test/tasks.test.js
git commit -m "feat(tasks-jsonl): mover expected_results para arquivo de detalhe por task"
```

---

### Task 3: rotas — `/api/status` leve e `GET /api/projects/tasks/:taskId`

**Files:**
- Modify: `server.js:193-200` (`handleTaskReadError`), `server.js:569-635` (POST), `server.js:637-720` (PUT), `server.js:723-753` (DELETE), e uma rota nova antes do POST
- Test: `test/api-tasks.test.js`

**Interfaces:**
- Consumes: `getTasks`, `getTask`, `saveTasks`, `deleteTaskDetail`, `MalformedTasksError`, `LegacyTasksFileError` de `lib/tasks`.
- Produces: `GET /api/projects/tasks/:taskId?project=<abs path>` → `200 { task }` hidratada, `400` sem `project`, `404` em id desconhecido.

- [ ] **Step 1: Write the failing tests**

Acrescentar a `test/api-tasks.test.js`:

```javascript
test('GET /api/status omits expected_results', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await fetch(`${base}/api/projects/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, title: 'T', expected_results: ['r1'] })
        });
        const data = await (await fetch(`${base}/api/status`)).json();
        const task = data.projects[0].tasks.find(t => t.title === 'T');
        assert.equal(task.expected_results, undefined);
    });
});

test('GET /api/projects/tasks/:taskId returns the hydrated task', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const created = await (await fetch(`${base}/api/projects/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, title: 'T', expected_results: ['r1', 'r2'] })
        })).json();
        const url = `${base}/api/projects/tasks/${created.task.id}?project=${encodeURIComponent(dir)}`;
        const res = await fetch(url);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.task.expected_results, ['r1', 'r2']);
        assert.equal(body.task.title, 'T');
    });
});

test('GET /api/projects/tasks/:taskId is 400 without project and 404 for an unknown id', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        assert.equal((await fetch(`${base}/api/projects/tasks/TST-1`)).status, 400);
        const url = `${base}/api/projects/tasks/TST-99?project=${encodeURIComponent(dir)}`;
        assert.equal((await fetch(url)).status, 404);
    });
});

test('POST and PUT return the task with expected_results and persist it to the detail file', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const created = await (await fetch(`${base}/api/projects/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, title: 'T', expected_results: ['r1'] })
        })).json();
        assert.deepEqual(created.task.expected_results, ['r1']);
        const detail = path.join(dir, '.meridian', 'tasks', `${created.task.id}.json`);
        assert.deepEqual(JSON.parse(fs.readFileSync(detail, 'utf8')), { expected_results: ['r1'] });

        const updated = await (await fetch(`${base}/api/projects/tasks/${created.task.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, expected_results: ['r1', 'r2'] })
        })).json();
        assert.deepEqual(updated.task.expected_results, ['r1', 'r2']);
        assert.deepEqual(JSON.parse(fs.readFileSync(detail, 'utf8')), { expected_results: ['r1', 'r2'] });
    });
});

test('PUT that does not mention expected_results keeps the detail file', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const created = await (await fetch(`${base}/api/projects/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, title: 'T', expected_results: ['r1'] })
        })).json();
        await fetch(`${base}/api/projects/tasks/${created.task.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, status: 'done' })
        });
        const detail = path.join(dir, '.meridian', 'tasks', `${created.task.id}.json`);
        assert.deepEqual(JSON.parse(fs.readFileSync(detail, 'utf8')), { expected_results: ['r1'] });
    });
});

test('DELETE removes both the line and the detail file', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const created = await (await fetch(`${base}/api/projects/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, title: 'T', expected_results: ['r1'] })
        })).json();
        await fetch(`${base}/api/projects/tasks/${created.task.id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir })
        });
        assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks', `${created.task.id}.json`)), false);
        const raw = fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8');
        assert.ok(!raw.includes(created.task.id));
    });
});
```

Reapontar os testes existentes que escrevem `tasks.json` malformado (`api-tasks.test.js:312`, `:334`, `:339`, `:356`, `:360`, `:376`, `:568`, `:751`, `:768`) para `tasks.jsonl`, mantendo as asserções.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/api-tasks.test.js`
Expected: FAIL — a rota `GET /api/projects/tasks/:taskId` responde 404 do Express, `GET /api/status` ainda traz `expected_results`, e o `DELETE` deixa o detalhe para trás.

- [ ] **Step 3: Write the implementation**

Em `server.js`, importar o que falta na linha 4:

```javascript
const { deriveKey, nextTaskId, getTasks, getTask, saveTasks, deleteTaskDetail, stampNewTask, stampTaskUpdate, normalizeStatus, MalformedTasksError, LegacyTasksFileError } = require('./lib/tasks');
```

Estender `handleTaskReadError` para tratar o erro legado como 500 com a mesma mensagem acionável:

```javascript
function handleTaskReadError(err, res) {
    if (err instanceof MalformedTasksError || err instanceof LegacyTasksFileError) {
        res.status(500).json({ error: err.message });
        return true;
    }
    return false;
}
```

Inserir a rota nova imediatamente antes de `app.post('/api/projects/tasks', ...)`:

```javascript
// O irmão hidratado de /api/status. O board não precisa de expected_results e
// não os recebe; quem despacha developer ou QA pega uma task por aqui.
app.get('/api/projects/tasks/:taskId', (req, res) => {
    try {
        const projectPath = req.query.project;
        if (!projectPath) {
            return res.status(400).json({ error: 'project is required' });
        }
        let task;
        try {
            task = getTask(projectPath, req.params.taskId);
        } catch (err) {
            if (handleTaskReadError(err, res)) return;
            throw err;
        }
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }
        res.json({ task });
    } catch (err) {
        console.error('Error reading task:', err.message);
        res.status(500).json({ error: err.message });
    }
});
```

No `DELETE` (`server.js:746`), após `saveTasks(projectPath, tasksData);`:

```javascript
        deleteTaskDetail(projectPath, taskId);
```

`POST` e `PUT` não mudam: o objeto em memória carrega `expected_results`, `saveTasks` o roteia, e a resposta já devolve esse mesmo objeto.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS em todos os arquivos. `api-stats.test.js`, `board.test.js` e `stats.test.js` que montem fixtures de `tasks.json` precisam passar a escrever `tasks.jsonl` — corrigir onde acusar.

- [ ] **Step 5: Commit**

```bash
git add server.js test/api-tasks.test.js test/api-stats.test.js test/stats.test.js test/board.test.js
git commit -m "feat(tasks-jsonl): status enxuto e GET /api/projects/tasks/:taskId hidratado"
```

---

### Task 4: script de migração

**Files:**
- Create: `scripts/migrate-tasks-jsonl.js`
- Test: `test/migrate-tasks-jsonl.test.js`

**Interfaces:**
- Consumes: `saveTasks` de `lib/tasks`.
- Produces: `migrateProject(projPath, { dryRun }) -> { id, ok, reason? }` exportado para teste; CLI `node scripts/migrate-tasks-jsonl.js [--dry-run]` que varre `../../.meridian/projects.json`.

- [ ] **Step 1: Write the failing tests**

Criar `test/migrate-tasks-jsonl.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateProject } = require('../scripts/migrate-tasks-jsonl');

function legacyProject(tasks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mig-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, '.meridian', 'tasks.json'),
        JSON.stringify(tasks, null, 2)
    );
    return dir;
}

const TASKS = [
    { id: 'A-1', title: 'um', status: 'done', priority: 'high', expected_results: ['r1', 'r2'], completed_at: '2026-01-01T00:00:00.000Z' },
    { id: 'A-2', title: 'dois', status: 'backlog', priority: 'medium', expected_results: [] }
];

test('migrateProject: converts, verifies and retires the legacy file', () => {
    const dir = legacyProject(TASKS);
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, true);

    const lines = fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(!lines[0].includes('expected_results'));
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(dir, '.meridian', 'tasks', 'A-1.json'), 'utf8')),
        { expected_results: ['r1', 'r2'] }
    );
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks', 'A-2.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json.migrated')), true);
    assert.ok(fs.readdirSync(path.join(dir, '.meridian')).some(f => f.startsWith('tasks.json.bak.')));
});

test('migrateProject: dry-run leaves the legacy file in place', () => {
    const dir = legacyProject(TASKS);
    const result = migrateProject(dir, { dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json.migrated')), false);
});

test('migrateProject: a verification mismatch aborts with the legacy file intact', () => {
    const dir = legacyProject(TASKS);
    const before = fs.readFileSync(path.join(dir, '.meridian', 'tasks.json'), 'utf8');
    // Um id duplicado faz duas linhas disputarem o mesmo arquivo de detalhe:
    // a releitura não bate com o original e a migração tem de recusar.
    const broken = [{ id: 'A-1', expected_results: ['r1'] }, { id: 'A-1', expected_results: ['r9'] }];
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.json'), JSON.stringify(broken, null, 2));
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /verification/i);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json.migrated')), false);
    assert.ok(before.length > 0);
});

test('migrateProject: a project already on jsonl is skipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mig-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), '{"id":"A-1"}\n');
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, true);
    assert.match(result.reason, /already/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/migrate-tasks-jsonl.test.js`
Expected: FAIL — `Cannot find module '../scripts/migrate-tasks-jsonl'`.

- [ ] **Step 3: Write the implementation**

Criar `scripts/migrate-tasks-jsonl.js`:

```javascript
#!/usr/bin/env node
/**
 * Meridian — migração de tasks.json para tasks.jsonl.
 *
 * Por projeto: copia tasks.json para tasks.json.bak.<timestamp>, escreve
 * tasks.jsonl + tasks/<id>.json, relê e compara task a task com o original, e
 * só então aposenta tasks.json como tasks.json.migrated.
 *
 * .meridian/ é gitignored: um erro aqui é irrecuperável, por isso o backup vem
 * antes de qualquer escrita e a verificação vem antes de aposentar o original.
 *
 * Rodar com o servidor parado. `--dry-run` faz tudo menos aposentar o original.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { saveTasks } = require('../lib/tasks');

const PROJECTS_JSON_PATH = path.join(__dirname, '..', '..', '.meridian', 'projects.json');

function readLegacy(tasksPath) {
    const parsed = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
    throw new Error('expected an array of tasks');
}

// Releitura crua, sem passar por lib/tasks: a migração precisa conferir o que
// está no disco, não confiar no mesmo código que escreveu.
function readMigrated(meridianDir) {
    const raw = fs.readFileSync(path.join(meridianDir, 'tasks.jsonl'), 'utf8');
    return raw.split('\n').filter(l => l.trim()).map(line => {
        const task = JSON.parse(line);
        const detail = path.join(meridianDir, 'tasks', `${task.id}.json`);
        task.expected_results = fs.existsSync(detail)
            ? JSON.parse(fs.readFileSync(detail, 'utf8')).expected_results
            : [];
        return task;
    });
}

function sameTask(before, after) {
    const a = { ...before, expected_results: before.expected_results || [] };
    const b = { ...after };
    return JSON.stringify(Object.keys(a).sort().map(k => [k, a[k]]))
        === JSON.stringify(Object.keys(a).sort().map(k => [k, b[k]]));
}

function migrateProject(projPath, options) {
    const dryRun = Boolean(options && options.dryRun);
    const id = path.basename(projPath);
    const meridianDir = path.join(projPath, '.meridian');
    const legacyPath = path.join(meridianDir, 'tasks.json');

    if (fs.existsSync(path.join(meridianDir, 'tasks.jsonl'))) {
        return { id, ok: true, reason: 'already on tasks.jsonl' };
    }
    if (!fs.existsSync(legacyPath)) {
        return { id, ok: true, reason: 'no tasks.json to migrate' };
    }

    let original;
    try {
        original = readLegacy(legacyPath);
    } catch (err) {
        return { id, ok: false, reason: `unreadable tasks.json: ${err.message}` };
    }

    const backup = path.join(meridianDir, `tasks.json.bak.${Date.now()}`);
    try {
        fs.copyFileSync(legacyPath, backup);
    } catch (err) {
        return { id, ok: false, reason: `backup failed, nothing written: ${err.message}` };
    }

    try {
        saveTasks(projPath, { tasks: original.map(t => ({ ...t })) });
    } catch (err) {
        return { id, ok: false, reason: `write failed: ${err.message}` };
    }

    let roundTrip;
    try {
        roundTrip = readMigrated(meridianDir);
    } catch (err) {
        return { id, ok: false, reason: `verification failed to re-read: ${err.message}` };
    }
    if (roundTrip.length !== original.length) {
        return { id, ok: false, reason: `verification mismatch: ${original.length} tasks in, ${roundTrip.length} out` };
    }
    for (let i = 0; i < original.length; i++) {
        if (!sameTask(original[i], roundTrip[i])) {
            return { id, ok: false, reason: `verification mismatch on ${original[i].id}` };
        }
    }

    if (!dryRun) {
        fs.renameSync(legacyPath, path.join(meridianDir, 'tasks.json.migrated'));
    }
    return { id, ok: true, reason: dryRun ? 'dry-run verified' : `migrated ${original.length} tasks` };
}

function main() {
    const dryRun = process.argv.includes('--dry-run');
    const registry = JSON.parse(fs.readFileSync(PROJECTS_JSON_PATH, 'utf8'));
    let failed = 0;
    for (const proj of registry.projects || []) {
        const result = migrateProject(proj.path, { dryRun });
        if (!result.ok) failed++;
        console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.id}: ${result.reason}`);
    }
    if (failed > 0) {
        console.error(`\n${failed} project(s) failed. The .bak copy and tasks.json are intact for those.`);
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = { migrateProject };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/migrate-tasks-jsonl.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-tasks-jsonl.js test/migrate-tasks-jsonl.test.js
git commit -m "feat(tasks-jsonl): script de migracao com backup e verificacao"
```

---

### Task 5: `migrate-task-ids.js` renomeia o arquivo de detalhe

O nome do arquivo de detalhe é o id. Renomear ids sem renomear os detalhes faz a task perder seus `expected_results` em silêncio.

**Files:**
- Modify: `scripts/migrate-task-ids.js`
- Test: `test/migrate-tasks-jsonl.test.js` (mesmo arquivo, seção nova)

**Interfaces:**
- Consumes: `getTasks`, `saveTasks`, `detailPathFor` via `lib/tasks` (exportar `detailPathFor` nesta task).
- Produces: nenhuma assinatura nova consumida por tasks posteriores.

- [ ] **Step 1: Write the failing test**

Acrescentar a `test/migrate-tasks-jsonl.test.js`:

```javascript
const { renameTaskDetail } = require('../scripts/migrate-task-ids');

test('renameTaskDetail: moves the detail file with the id and tolerates its absence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ids-'));
    const tasksDir = path.join(dir, '.meridian', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'OLD-1.json'), JSON.stringify({ expected_results: ['r1'] }));

    renameTaskDetail(dir, 'OLD-1', 'NEW-1');
    assert.equal(fs.existsSync(path.join(tasksDir, 'OLD-1.json')), false);
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(tasksDir, 'NEW-1.json'), 'utf8')),
        { expected_results: ['r1'] }
    );

    renameTaskDetail(dir, 'MISSING-1', 'NEW-2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/migrate-tasks-jsonl.test.js`
Expected: FAIL — `renameTaskDetail is not a function`.

- [ ] **Step 3: Write the implementation**

Em `lib/tasks.js`, exportar `detailPathFor` junto dos demais. Em `scripts/migrate-task-ids.js`, acrescentar e chamar no ponto em que o id de uma task é reescrito:

```javascript
const { detailPathFor } = require('../lib/tasks');

// O nome do arquivo de detalhe é o id da task. Renomear o id sem mover o
// arquivo deixa um detalhe órfão e uma task sem expected_results — perda
// silenciosa, que é a pior classe de perda num diretório gitignored.
function renameTaskDetail(projPath, oldId, newId) {
    const from = detailPathFor(projPath, oldId);
    if (!fs.existsSync(from)) return;
    fs.renameSync(from, detailPathFor(projPath, newId));
}
```

Exportar `renameTaskDetail` no `module.exports` do script (criando o `module.exports` se ainda não houver).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks.js scripts/migrate-task-ids.js test/migrate-tasks-jsonl.test.js
git commit -m "fix(tasks-jsonl): renomear arquivo de detalhe junto com o id da task"
```

---

### Task 6: documentação do formato e do endpoint

**Files:**
- Modify: `plugin/plugins/meridian/references/schema.md`, `references/stages.md`, `references/pipeline.md`, `references/preamble.md`
- Modify: `plugin/plugins/meridian/skills/{status,next,work,new}/SKILL.md`
- Modify: `plugin/plugins/meridian/agents/{pm,spec-generator,spec-reviewer,developer,code-reviewer,qa}.md`
- Modify: `agents/Odin.md`, `agents/pm.md`, `prompts/boilerplate.txt`
- Test: `test/plugin.test.js` (se assertar conteúdo de referências)

**Interfaces:**
- Consumes: o contrato de rotas da Task 3.
- Produces: nada em código.

- [ ] **Step 1: Atualizar `schema.md`**

Na seção "Where tasks live", substituir a descrição do array JSON por: tasks em `<project>/.meridian/tasks.jsonl`, um objeto JSON por linha, sem indentação; `expected_results` mora em `<project>/.meridian/tasks/<id>.json` no formato `{"expected_results": [...]}`, ausente quando vazio. Manter o aviso de gitignore. Na tabela de campos, marcar `expected_results` como "arquivo de detalhe, não vem em `GET /api/status`". Na seção de API, documentar `GET /api/projects/tasks/:taskId?project=<abs path>`.

- [ ] **Step 2: Atualizar os pontos de dispatch**

Em `references/stages.md` (linhas ~21, ~26, ~42, ~59, ~89, ~112) e `references/pipeline.md` (~29, ~32, ~230, ~258): onde hoje se lê que o despachante passa os `expected_results` da task, indicar que eles vêm de `GET /api/projects/tasks/:taskId`, porque `GET /api/status` não os traz mais.

- [ ] **Step 3: Atualizar autorização de leitura direta**

Em `references/preamble.md:136` e `schema.md:198`: leitura direta continua permitida, apontando para `tasks.jsonl` (e `tasks/<id>.json` quando forem os resultados). Escrita segue proibida fora da API, e o "hand-edit como último recurso" passa a descrever os dois arquivos e a ordem detalhe-antes-da-linha.

- [ ] **Step 4: Varrer as menções restantes**

```bash
grep -rn "tasks\.json\b" plugin agents prompts --include="*.md" --include="*.txt" | grep -v "tasks.json.migrated"
```

Atualizar cada ocorrência em skills, agentes, `agents/Odin.md`, `agents/pm.md` e `prompts/boilerplate.txt`. Menções em `.meridian/reports/*.md` são registros históricos — **não** alterar.

- [ ] **Step 5: Rodar a suíte e commitar**

Run: `npm test`
Expected: PASS.

```bash
git add plugin agents prompts
git commit -m "docs(tasks-jsonl): formato jsonl, arquivo de detalhe e endpoint hidratado"
```

---

### Task 7: migrar o workspace real e regravar os AGENTS.md

**Files:**
- Nenhum arquivo do repositório: esta task executa a migração e propaga o boilerplate.

**Interfaces:**
- Consumes: `scripts/migrate-tasks-jsonl.js` da Task 4; `prompts/boilerplate.txt` da Task 6.
- Produces: workspace em `tasks.jsonl`.

- [ ] **Step 1: Confirmar o servidor parado**

```bash
ps -p $(cat meridian-server.pid) 2>/dev/null || echo "servidor parado"
```

Se estiver rodando, `kill $(cat meridian-server.pid)`.

- [ ] **Step 2: Dry-run em todos os projetos**

```bash
node scripts/migrate-tasks-jsonl.js --dry-run
```

Expected: uma linha `ok` por projeto. Qualquer `FAIL` interrompe a task — investigar antes de prosseguir, sem rodar a migração real.

- [ ] **Step 3: Migrar**

```bash
node scripts/migrate-tasks-jsonl.js
```

Expected: `ok <projeto>: migrated N tasks` para cada um dos seis projetos com board.

- [ ] **Step 4: Conferir o ganho e a integridade**

```bash
cd ~/workspace && for f in */.meridian/tasks.jsonl; do printf "%-44s %8s bytes %4s linhas\n" "$f" "$(wc -c <"$f"|tr -d ' ')" "$(wc -l <"$f"|tr -d ' ')"; done
```

Expected: `project_e` em torno de 76KB com 73 linhas (era 695.896 bytes), e as contagens de linha iguais às contagens de tasks de antes: 73, 56, 70, 11, 3, 1.

- [ ] **Step 5: Religar o servidor e validar o board**

```bash
node server.js > meridian-out.log 2> meridian-err.log &
```

Abrir o board, confirmar que as colunas carregam e que uma task com `justification` ainda mostra o texto ao expandir. Depois, num projeto de teste, confirmar o caminho hidratado:

```bash
curl -s "http://localhost:3333/api/projects/tasks/MERID-1?project=$HOME/workspace/meridian" | head -c 400
```

- [ ] **Step 6: Regravar o bloco MERIDIAN_INSTRUCTIONS**

`GET /api/status` agora marca `outdatedMeridianRules` em todo projeto registrado, porque `prompts/boilerplate.txt` mudou. Usar o caminho que o próprio Meridian oferece para regravar o bloco em cada projeto e confirmar que a flag zerou:

```bash
curl -s http://localhost:3333/api/status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const p of j.projects)console.log(p.name, p.outdatedMeridianRules||p.missingMeridianRules?"PENDENTE":"ok")})'
```

- [ ] **Step 7: Commit final**

```bash
git add -A
git commit -m "chore(tasks-jsonl): migrar boards do workspace para jsonl"
```

Os backups `tasks.json.bak.*` e `tasks.json.migrated` ficam em `.meridian/` (gitignored). Apagá-los só depois de alguns dias de uso normal do board.
