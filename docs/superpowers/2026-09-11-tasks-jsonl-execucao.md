# SDD ledger — plan: docs/superpowers/plans/2026-09-11-tasks-jsonl.md

Spec: docs/superpowers/specs/2026-09-11-tasks-jsonl-design.md (lida)
Baseline: 204/205 na main em 779642f. A falha (`GET /styles.css serves the
#board-panel / #stats-panel flex-chain rules`) é flake de colisão de porta —
passa sozinha em 260ms. Pré-existente, não atribuir a nenhuma task.

Ruling: trabalhar direto na main — o operador recusou worktree quando
perguntado. Custo se errado: um erro no meio deixa a main quebrada e a
recuperação é `git revert` dos commits da task.

Ruling: não parar nem reiniciar o servidor (pid 58805) durante as Tasks 1–6.
Ele já tem o código antigo carregado em memória e segue operando sobre
tasks.json; o disco mudar debaixo dele não o afeta. Custo se errado: se algo
reiniciar o servidor entre a Task 1 e a Task 7, ele sobe e responde 500
`LegacyTasksFileError` até a migração rodar — reversível rodando a Task 7.

Ruling: parar antes da Task 7 e confirmar com o operador. Ela migra os seis
boards reais num diretório gitignored e derruba o servidor — efeito fora do
escopo de código, da classe que se pergunta antes. Custo se errado: nenhum,
só uma pergunta a mais.

## Pré-flight — varredura de conflitos

| Par / Task | Produz vs consome | Achado |
|---|---|---|
| T1 ↔ T2 | Ambas em `lib/tasks.js` e `test/tasks.test.js`. T1 produz `getTasks`/`saveTasks`/`LegacyTasksFileError`; T2 reescreve o corpo de `saveTasks` trocando o tmp inline por `writeAtomic` | OK — T2 declara a substituição. O teste "leaves no temp file behind" da T1 segue válido: a task do teste não tem `expected_results`, logo não cria `tasks/` |
| T1 ↔ T3 | T1 produz `LegacyTasksFileError`; T3 o consome em `handleTaskReadError` | OK |
| T2 ↔ T3 | T2 produz `getTask`, `deleteTaskDetail`; T3 os importa em `server.js` | OK — nomes idênticos nos dois lados |
| T2 ↔ T5 | T5 consome `detailPathFor`, que T2 define mas **não** exporta | Conflito. Ruling: T5 é dona do export, como seu Step 3 já manda. Sem mudança na T2. Custo se errado: nenhum — falharia imediatamente no teste da T5 |
| T4 ↔ T5 | Ambas em `test/migrate-tasks-jsonl.test.js`; T5 acrescenta ao arquivo que T4 cria | OK — ordem do plano (4 antes de 5) resolve |
| T4 ↔ T7 | T7 executa o script que T4 cria | OK |
| T6 ↔ T7 | T7 Step 6 depende do `boilerplate.txt` alterado na T6 | OK |
| T3 ↔ T6 | T6 documenta o endpoint que T3 cria | OK — ordem resolve |
| T1 (interna) | Testes importam `LegacyTasksFileError`; Step 3 a define e exporta | Coerente |
| T2 (interna) | Teste espia `fs.renameSync`; `writeAtomic` chama `fs.renameSync(...)` pelo objeto do módulo | Coerente — o monkeypatch pega |
| T3 (interna) | Testes assumem `data.projects[0].tasks` em `/api/status` | A verificar na implementação; se a forma for outra, o implementador ajusta o acesso, não o contrato |
| T4 (interna) | `sameTask` compara só as chaves do original; `readMigrated` relê cru sem passar por `lib/tasks` | Coerente — a verificação não pode confiar no código que escreveu |
| T5 (interna) | Teste novo no arquivo da T4 + export em `lib/tasks.js` | Coerente |
| T6 (interna) | Só prosa; `grep` no Step 4 varre o que os passos anteriores não pegaram | Coerente |
| T7 (interna) | Operações manuais sobre os boards reais | Coerente; ver ruling acima |


## Task 1

Task 1: review 1 — spec ✅, quality Approved (d7dece4). 29/29 em test/tasks.test.js.
Task 1: ⚠️ resolvido pelo controller — `scripts/migrate-tasks-jsonl.js` citado na
mensagem de `LegacyTasksFileError` ainda não existe: é a Task 4, e a migração dos
boards reais é a Task 7. Sequenciamento do plano, não lacuna. O servidor vivo
(pid 58805) tem o código antigo em memória e não relê lib/tasks.js, então não
quebra antes da Task 7.
Task 1: Ruling: o achado Minor do arquivo de 0 bytes é real e entra em fix round,
apesar de Minor. O `test/tasks.test.js:86` antigo garantia que um tasks.json vazio
lança em vez de ler como "nenhuma task"; meu brief deixou essa proteção cair. Um
arquivo truncado por terceiros passaria a ler como lista vazia e o save seguinte
gravaria por cima do backlog — exatamente o modo de falha que o comentário de
MalformedTasksError existe para impedir. saveTasks nunca produz 0 bytes (uma lista
vazia serializa como "\n"), e projeto sem board não tem arquivo nenhum, então
lançar em 0 bytes não tem falso positivo. Custo se errado: um projeto com
tasks.jsonl legitimamente vazio de 0 bytes passaria a exigir intervenção manual.
Task 1: fix round 1/5 (1 addressed, 0 open — arquivo de 0 bytes volta a lançar; commits d7dece4..e917b52)
Task 1: complete (commits 535cc08..e917b52, review clean) — 30/30 em test/tasks.test.js

## Task 2

Task 2: review 1 — spec ✅, quality Approved (8e01e69). 41/41 em test/tasks.test.js.
Task 2: minor (deferred): readTaskDetail indexa `parsed[DETAIL_FIELD]` sem checar
que o JSON parseado é objeto — um detalhe contendo `null` ou um primitivo lança
TypeError cru em vez de MalformedTasksError (lib/tasks.js:152-162).
Task 2: minor (deferred): sem teste para o ramo de JSON malformado de
readTaskDetail nem para expected_results não-array dentro de um detalhe existente.
Task 2: complete (commits e917b52..8e01e69, review clean)

## Task 3

Task 3: review 1 — spec ✅, quality Approved (120480c). Suíte cheia 221/221.
Task 3: minor (deferred): seis cópias inline de parse/serialize jsonl em
test/api-tasks.test.js onde um helper readJsonl/writeJsonl resolveria.
Task 3: minor (deferred): server.js:771 chama deleteTaskDetail depois de saveTasks;
um erro que não seja ENOENT deixaria a linha já apagada, o detalhe órfão e a
resposta em 500.
Task 3: complete (commits 8e01e69..120480c, review clean)

## Task 4

Task 4: review 1 — spec ✅ nos requisitos mandados, quality Needs fixes (2316ed0).
225/225 na suíte. O revisor traçou à mão a comparação de verificação e a ordem dos
passos destrutivos: ambas corretas, nenhum caminho apaga o legado antes do backup.
Task 4: Ruling: os três achados Important entram em fix round, inclusive os dois
rotulados plan-mandated — o defeito é meu, do plano, e a spec (a autoridade) manda
que uma falha de verificação deixe o projeto num estado recuperável. Custo se
errado: mais uma rodada de fix num script que ainda não tocou dado real.
  (1) dry-run escreve tasks.jsonl de verdade e getTasks passa a preferi-lo; a
      execução real vira no-op "already on tasks.jsonl" e o tasks.json nunca é
      aposentado. Rota plausível para perder edições pós-dry-run.
  (2) abort de verificação deixa o tasks.jsonl não-verificado vivo no disco, e o
      board passa a servir exatamente o que o script declarou não confiável.
  (3) test/migrate-tasks-jsonl.test.js:61 `assert.ok(before.length > 0)` é
      tautologia — passaria contra um script que truncasse o tasks.json in place.
Task 4: minor (deferred): sameTask não inspeciona chaves só do lado migrado; backup
sem assert de conteúdo; "abort se a cópia falhar" sem teste; nenhum teste cobre a
perda de um escalar simples (só expected_results); mkdtemp sem limpeza.
Task 4: fix round 1/5 (3 addressed, 0 open — cleanupPartialOutput compartilhado
para dry-run e abort, early return distingue meio-migrado, teste de abort agora
compara bytes; commits 2316ed0..e625a14). Suíte 227/227.
Task 4: complete (commits 120480c..e625a14, review clean)

## Task 5

Task 5: review 1 — spec ❌, quality Needs fixes (d8bc0bf). Critical: renameTaskDetail
é chamado um id por vez dentro do loop de migrate-task-ids.js, e o idMap pode conter
ciclos de reuso (array [A-2, A-1] renumerado vira {A-2:A-1, A-1:A-2}). fs.renameSync
sobrescreve o destino em silêncio: o primeiro rename destrói o A-1.json original, o
segundo devolve o arquivo corrompido — uma task fica sem detalhe e outra fica com os
expected_results de terceiros. Nenhum teste cobria o caso.
Task 5: Ruling: trocar o primitivo de um arquivo por uma operação em duas fases sobre
o idMap inteiro (encosta todos os origens em .tmp, depois assenta todos nos destinos),
substituindo renameTaskDetail por renameTaskDetails(projPath, idMap) em vez de manter
os dois. Duas funções para o mesmo trabalho é como a insegura volta a ser chamada.
Custo se errado: a assinatura exportada muda e o teste do brief precisa ser reescrito
para dirigir pelo idMap — trabalho pequeno, e o brief já estava errado no ponto.
Task 5: fix round 1/5 (2 addressed, 0 open — renameTaskDetails em duas fases,
chamada uma vez fora do loop, teste de ciclo prova a troca; commits d8bc0bf..bb744ed)
Task 5: minor (deferred): um crash entre as duas fases deixa detalhes sob o nome
.rename.<pid>.tmp — conteúdo intacto, recuperável à mão, mas é um modo de falha novo.
Task 5: complete (commits e625a14..bb744ed, review clean)

## Task 6

Task 6: review 1 — spec ✅, quality Approved com 1 Important (9547466). 230/230.
Varredura grep independente do revisor: zero menções remanescentes a tasks.json em
plugin/agents/prompts fora de tasks.json.migrated. Nada sob .meridian/reports/ tocado.
Task 6: Ruling: o "89% do payload" em schema.md entra em fix, mas a premissa do
revisor está errada — o número não foi inventado, eu medi em 2026-09-11 (620.204 de
695.896 bytes no project_e). A conclusão vale por outro motivo: um documento
que se declara fonte única da verdade não deve carregar uma medição que envelhece
sozinha. Trocar por formulação qualitativa. Custo se errado: nenhum — a prosa fica
menos específica e nada no comportamento muda.
Task 6: minor (deferred): agents/Odin.md tem um bloco de schema legado já defasado
antes desta mudança (shape {"tasks": [...]}, campos description/assignee/blockedReason,
vocabulário de status diferente) — só os nomes de arquivo foram atualizados.
Task 6: minor (deferred): schema.md não documenta DELETE, lacuna anterior a este plano.
Task 6: minor (deferred): a lista "File Shape" de prompts/boilerplate.txt é incompleta
desde antes (falta parent, spec_path, os três contadores, last_review_findings,
resume_context).
Task 6: fix round 1/5 (1 addressed, 0 open — medição pontual trocada por formulação
qualitativa; commits 9547466..31dbe90)
Task 6: complete (commits bb744ed..31dbe90, review clean)

## Revisão final do branch (779642f..31dbe90)

Veredito: pronto para mesclar, 0 Critical, 7 Important, 6 Minor. Suíte 230/230
confirmada independentemente. O revisor copiou os seis boards reais para o temp e
migrou as cópias: seis ok, comparação campo a campo escrita fora do sameTask não
achou perda. project_e 695.897 -> 61.968 bytes. Entrada real verificada em
modo leitura: zero tasks sem id, zero ids duplicados, zero ids com separador ou "..",
zero expected_results não-array, nenhum tasks.jsonl ou tasks/ preexistente.
Todos os rulings do controller confirmados corretos; a única nota é que a medição de
89% removida do schema.md sobrevive no comentário de lib/tasks.js:88.
Triagem dos minors deferidos: todos podem ficar, exceto o bloco de schema legado do
agents/Odin.md, escalado a Important — o rename transformou um bloco obsoleto em um
bloco ativamente errado.
Fix wave (uma só, como manda o processo): Important 1-7 + Minor 8,9,10,11 + o
try/catch do deleteTaskDetail.
Fix wave: 5 commits 31dbe90..ea37e41, re-review: 12/12 addressed, 0 open, 251/251.
Ruling: os três minors novos ficam parados, sem segunda leva de fix (o processo só
prevê uma). (a) agents/Odin.md:14 ainda diz "at the root of each project" — é o mesmo
erro de localização que o finding 6 mandou corrigir, sobrevivendo numa linha que o
finding não nomeou; engana o agente, não corrompe arquivo. (b) o guard de pid só lê o
caminho fixo e ignora MERIDIAN_PID_FILE — mitigado no procedimento da Task 7 checando
a porta, não só o pid file. (c) o teste do finding 8 fixa a mensagem da resposta mas
não o console.error restaurado. Custo se errado: (a) Odin procura o board no lugar
errado e falha visivelmente; (b) e (c) são defesa em profundidade, não o caminho
principal.
Ruling: manter o workspace do SDD até a Task 7 terminar — o ledger ainda é o mapa de
recuperação da única etapa que toca dado real.
ESTADO: Tasks 1-6 completas e revisadas. Task 7 (migrar os seis boards reais) parada
aguardando o operador, conforme o ruling do pré-flight.

## Task 7 — executada 2026-09-11 com autorização do operador

Servidor pid 58805 parado, porta 3333 confirmada muda antes de qualquer escrita.
Dry-run: 6 ok, e verificado que não deixou rastro (nenhum tasks.jsonl, tasks.json com
os bytes originais). Migração: 6 ok, 11/1/73/3/56/70 tasks — as mesmas contagens
medidas antes do plano. Linhas do jsonl batem task a task. project_e
695.897 -> 61.968 bytes. Dois .bak por projeto (um do dry-run, um da migração) mais
tasks.json.migrated; nenhum tasks.json remanescente.
Servidor religado no pid 80371. /api/status: 200, 214 tasks, zero expected_results,
186 justification preservadas, nenhum erro. GET /api/projects/tasks/MERID-1 devolve
22 expected_results hidratados. Bloco MERIDIAN_INSTRUCTIONS regravado nos seis via
POST /api/fix-with-ai; os seis voltaram a "ok". Suíte final 251/251.
Não commitei o AGENTS.md dos outros cinco projetos — repositórios deles, decisão do
operador. project_e em particular já tinha mudança staged antes (MM).
Task 7: complete
