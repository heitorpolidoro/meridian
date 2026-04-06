# Sistema de Multi-Agentes no Gemini CLI

Este documento resume o funcionamento da arquitetura de agentes, delegação e políticas de autonomia no Gemini CLI.

## 1. Arquitetura de Sub-Agentes
O Gemini CLI opera com um **Agente Principal (Orquestrador)** e **Sub-Agentes Especializados**.
- **Agente Principal:** Atua como o ponto de contato com o usuário, gerencia o contexto global e toma decisões estratégicas.
- **Sub-Agentes:** São "especialistas" invocados para tarefas específicas (ex: `codebase_investigator` para análise de código ou `browser_agent` para navegação web).
- **Isolamento de Contexto:** Cada sub-agente possui seu próprio loop de execução. O histórico detalhado do sub-agente não "suja" a conversa principal, economizando tokens e mantendo o foco.

## 2. Fluxo de Delegação e Comunicação
A delegação pode ser **Automática** (decidida pelo orquestrador) ou **Manual** (via sintaxe `@nome_do_agente`).
- **Restrição de Recursão:** Sub-agentes não podem invocar outros sub-agentes diretamente para evitar loops infinitos.
- **Interoperabilidade via Orquestrador:** Se o Agente A precisa de uma informação que apenas o Agente B possui, o Agente A reporta essa necessidade ao Agente Principal. O Agente Principal então consulta o Agente B e retorna o dado necessário ao Agente A para que ele conclua sua tarefa.

## 3. Permissões e Autonomia (Policy Engine)
Por padrão, o Gemini CLI opera em modo **"Human-in-the-loop"**, exigindo confirmação para ações de escrita ou comandos shell. A autonomia pode ser configurada via **Políticas (`.toml`)**:

### Formas de Ativação Autônoma:
1.  **Regras de Auto-Aprovação:** Definição de regras em arquivos `.toml` (em `~/.gemini/policies/` ou `.gemini/policies/`) que permitem ferramentas específicas (`write_file`, `replace`, `run_shell_command`) com base em padrões de argumentos (Regex).
2.  **Modos de Aprovação:** O modo `auto_edit` pode ser ativado via configuração ou flag (`--approval-mode=auto_edit`) para permitir edições automáticas baseadas em políticas pré-definidas.
3.  **Herança de Permissões:** Sub-agentes herdam as políticas de segurança e autonomia configuradas no ambiente do Agente Principal.

## 4. Segurança
- **Proteção de Segredos:** O sistema possui travas internas para evitar leitura/edição de arquivos sensíveis (ex: `.env`, `.git`).
- **Revisão Manual:** Mesmo com autonomia de edição, o sistema não realiza `git commit` ou `push` automaticamente sem uma instrução explícita do usuário.
