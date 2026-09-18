# Tasks em JSONL com campos pesados fora do registro

**Data:** 2026-09-11
**Status:** aprovado, pronto para virar plano de implementação

## Problema

Hoje as tasks de um projeto vivem em `<project>/.meridian/tasks.json`, um array
JSON indentado lido e reescrito inteiro a cada mudança. Medições do workspace em
2026-09-11:

| Projeto | Bytes | Tasks |
|---|---:|---:|
| `project_e` | [redacted] | [redacted] |
| `project_b` | [redacted] | [redacted] |
| `project_a` | [redacted] | [redacted] |
| `meridian` | 30.160 | 11 |

No maior arquivo, `expected_results` sozinho ocupa **89% do total**. Disso decorrem três custos:

1. **Leitura.** Os agentes leem `tasks.json` cru (autorizado por
   `references/preamble.md:136` e `references/schema.md:198`). Ver o board custa
   696KB para usar ~10KB de campos leves.
2. **API.** `GET /api/status` devolve todas as tasks de todos os projetos com
   todos os campos. Nem `public/app.js` nem `lib/stats.js` usam
   `expected_results`: o payload mais caro do sistema é dominado por um campo
   que nenhum dos seus consumidores lê.
3. **Escrita.** Cada mudança de status reescreve 696KB, e `fs.watch` dispara a
   reconstrução do board em cima disso.

Não há disputa entre escritores: todas as escritas passam por um único processo
(`server.js`, mais `scripts/normalize-tasks.js` e `scripts/migrate-task-ids.js`).
O problema é volume, não concorrência.

## Decisão

Uma task por linha em `tasks.jsonl`, com `expected_results` — e apenas ele —
movido para um arquivo de detalhe por task.

`justification` **permanece na linha**: `public/app.js:1011` o renderiza no
board, e tirá-lo obrigaria a UI a abrir N arquivos de detalhe para desenhar uma
coluna. São 32KB (5%), ruído dentro do orçamento.

`expected_results` **sai**: nenhuma UI o mostra, e todo consumidor lê uma task
por vez, no dispatch de developer e QA (`references/stages.md:89` e
`stages.md:112`).

## Layout em disco

```
<project>/.meridian/
  tasks.jsonl              # uma task por linha, sem expected_results
  tasks/<id>.json          # { "expected_results": [...] } — só quando não-vazio
  events.jsonl             # já existe, inalterado
```

- **`tasks.jsonl`** — JSON compacto por linha (sem indentação), uma linha por
  task, ordem igual à do array atual, newline final. Sem `expected_results`, os
  as tasks do maior board ficam em ~1KB por linha:
  `grep '"id":"PE-42"' tasks.jsonl` devolve a task inteira barata e `wc -l` dá a
  contagem sem parsear.
- **`tasks/<id>.json`**, em JSON e não em Markdown — `expected_results` é array
  de strings, e um resultado contendo quebra de linha ou começando com `- `
  quebraria o round-trip de um formato de lista. JSON é lossless e abre espaço
  para outro campo pesado no futuro sem nova migração. O arquivo só existe
  quando há resultados.
- **`tasks.json` deixa de existir.** Duas fontes vivas para o mesmo estado é
  como o backlog se perde.

Campos que ficam na linha: `id`, `title`, `status`, `priority`, `justification`,
`blockedBy`, `parent`, `spec_path`, `spec_iterations`,
`code_review_iterations`, `qa_iterations`, `last_review_findings`, `running`,
`resume_context`, `created_at`, `updated_at`, `moved_at`, `completed_at`.

## `lib/tasks.js` — a fronteira do split

Todo o conhecimento da divisão fica neste módulo. `server.js` continua tratando
`expected_results` como campo comum em memória.

- **`getTasks(projPath)`** — lê `tasks.jsonl` linha a linha, `JSON.parse` por
  linha, ignorando linhas em branco. **Não hidrata** `expected_results`. É o
  caminho do board e de `GET /api/status`. `backfillTasks` continua aplicado.
- **`getTask(projPath, id)`** — a linha correspondente mesclada com
  `tasks/<id>.json`. Retorna `null` quando o id não existe.
- **`saveTasks(projPath, tasksData)`** — grava `tasks/<id>.json` via tmp+rename
  e depois as linhas **sem** o campo, também via tmp+rename. A regra por task
  distingue ausência de vazio, e isso é a invariante mais importante do módulo:
  - `expected_results === undefined` → **não toca** no arquivo de detalhe;
  - array não-vazio → grava o arquivo;
  - array vazio → apaga o arquivo.

  Sem essa distinção, um round-trip `getTasks` → `saveTasks` (que é o que toda
  rota de escrita faz) leria tasks sem o campo e apagaria os detalhes de todas
  elas no primeiro save.
- **`deleteTaskDetail(projPath, id)`** — apaga o `tasks/<id>.json`, tolerando
  ausência. A rota `DELETE` continua filtrando a lista e chamando `saveTasks`
  como hoje, e chama isto em seguida: como a task já saiu da lista, `saveTasks`
  nunca veria o campo para decidir apagar o detalhe.

**Ordem de escrita: detalhe primeiro, linha depois.** Um crash no intervalo
deixa um detalhe adiantado, que é inerte — a linha é o que faz a task existir.
A ordem inversa deixaria a task existindo com resultados defasados, e um
resultado defasado é o erro que o QA não percebe.

**Detalhes órfãos são inertes**: um `tasks/<id>.json` sem linha correspondente é
ignorado na leitura. Nada os apaga automaticamente.

**`MalformedTasksError` mantém a garantia atual** (`lib/tasks.js:63`): qualquer
linha impossível de parsear aborta a leitura inteira, nunca degrada para lista
parcial, e nunca se sobrescreve um arquivo ilegível. O formato por linha permite
uma melhora de diagnóstico que hoje não existe: a mensagem passa a citar o
número da linha.

## API

- **`GET /api/status`** — deixa de trazer `expected_results`. É 89% do payload e
  nenhum consumidor da rota o usa.
- **`GET /api/projects/tasks/:taskId`** (novo) — exige `project` (path absoluto)
  na query; devolve a task hidratada, `expected_results` incluído. `404` quando
  o id não existe no board; os mesmos erros de leitura malformada das demais
  rotas.
- **`POST /api/projects/tasks`** e **`PUT /api/projects/tasks/:taskId`** —
  contrato de entrada inalterado: aceitam `expected_results` no body e
  `saveTasks` roteia sozinho. A resposta devolve a task com `expected_results`
  (um arquivo, custo trivial).
- **`DELETE /api/projects/tasks/:taskId`** — passa a apagar linha e detalhe.

Sem flag `?details=1` em `/api/status`: manter o caminho caro disponível é
garantir que alguém o use por engano e o ganho vaze de volta.

## Scripts existentes

`scripts/normalize-tasks.js` passa pelo módulo e não muda. `scripts/migrate-task-ids.js`
renomeia ids, e o nome do arquivo de detalhe é o id — ele precisa renomear
`tasks/<antigo>.json` para `tasks/<novo>.json` junto, ou os resultados ficam
órfãos e as tasks renomeadas perdem seus `expected_results` silenciosamente.

## Migração

`scripts/migrate-tasks-jsonl.js`, one-shot, com o servidor parado
(`meridian-server.pid`). `.meridian/` é gitignored — um erro aqui é
irrecuperável. Por projeto de `projects.json`:

1. Copia `tasks.json` para `tasks.json.bak.<timestamp>` **antes de qualquer
   escrita**; aborta o projeto se a cópia falhar.
2. Lê pelo caminho legado e escreve `tasks.jsonl` + `tasks/<id>.json`.
3. Relê o resultado pelo caminho novo e compara task a task com o original:
   contagem, ids e cada campo, com `expected_results` remontado. Divergência
   aborta o projeto deixando o `.bak` e o `tasks.json` intactos.
4. Só após a verificação, renomeia `tasks.json` → `tasks.json.migrated`.

`--dry-run` executa 1–3 sem renomear nada.

**Corte seco, sem convivência.** `getTasks` que não encontra `tasks.jsonl` mas
encontra `tasks.json` lança erro explícito mandando rodar a migração, em vez de
fazer fallback silencioso. Os `STATUS_ALIASES` de `lib/tasks.js:30` são a prova
local de que período transitório sobrevive muito além do previsto.

## Testes

`node --test`, no estilo dos arquivos existentes.

**`test/tasks.test.js`** (reescrito):
- round-trip do split preserva todos os campos;
- `expected_results` vazio ou ausente não cria arquivo de detalhe;
- esvaziar `expected_results` apaga o arquivo;
- `tasks/<id>.json` órfão é ignorado na leitura;
- linha corrompida lança `MalformedTasksError` citando o número da linha e não
  sobrescreve o arquivo;
- `saveTasks` grava o detalhe antes da linha.

**`test/api-tasks.test.js`**:
- `GET /api/status` não traz `expected_results`;
- `GET /api/projects/tasks/:taskId` traz, e dá `404` em id inexistente;
- `POST`/`PUT` persistem `expected_results` no detalhe e o devolvem na resposta;
- `DELETE` apaga linha e detalhe;
- os testes atuais de recusa a escrever sobre arquivo malformado, reapontados
  para `tasks.jsonl`.

**`test/migrate-tasks-jsonl.test.js`** (novo): fixture de dois projetos,
migração bem-sucedida, e o caso de verificação falhando (aborta com `.bak` e
`tasks.json` intactos).

## Documentação

É o maior volume da mudança, não o código. Precisam ser atualizados:

- `plugin/plugins/meridian/references/schema.md` — "Where tasks live", tabela de
  campos, contrato da API;
- `references/stages.md` — dispatch de developer e QA passa a buscar os
  `expected_results` por `GET /api/projects/tasks/:taskId`;
- `references/pipeline.md` e `references/preamble.md` — a autorização de leitura
  direta passa a citar `tasks.jsonl`;
- as skills `status`, `next`, `work`, `new`;
- os seis agentes de `plugin/plugins/meridian/agents/`;
- `agents/Odin.md`, `agents/pm.md`;
- `prompts/boilerplate.txt`.

**Consequência operacional:** `server.js` compara o bloco
`MERIDIAN_INSTRUCTIONS` do `AGENTS.md` de cada projeto byte a byte com
`getBoilerplate()`. Mudar `boilerplate.txt` faz **todo projeto registrado
acusar `outdatedMeridianRules`**. Regravar o bloco em cada projeto é passo
explícito do plano, não efeito colateral a descobrir depois.

## Fora de escopo

- Log append-only de mutações com compactação: a escrita deixa de doer por
  tamanho (~15KB), sem precisar da complexidade.
- Um arquivo por task com índice derivado: resolve escrita incremental melhor,
  mas introduz dessincronização entre índice e diretório.
- Remover os `STATUS_ALIASES` — mudança independente, já registrada.
