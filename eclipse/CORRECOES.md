# Eclipse — o que foi corrigido (2026-10-06)

## Novo
- `antiraid.js` + `antiraid-core.js` + `antiraid.sql` — anti-raid completo (comando `/antiraid`).
- `antiraid-core.test.mjs` — 12 testes automáticos (`npm test`).
- `faltando.sql` — tabelas/funções que o código usa mas não vinham nos .sql (guild_config, mensagens_log, daily_rewards, tickets, ticket_config, eco_premiar, eco_transferir).
- `.env.example` — lista de todas as variáveis de ambiente.

## Segurança
- moderation.js: botão **Banir** do alerta agora exige **Banir Membros** (antes bastava Gerenciar Mensagens). Mutar exige Moderar Membros.
- moderation.js: modal do painel de automod agora confere permissão.
- index.js + banimento.js: ban/desban/lista do **site** só valem no servidor de verificação (a tabela banned_users é global; qualquer servidor com o bot podia mexer nela).
- extras.js: `/ticket adicionar|remover|renomear` agora conferem permissão.

## Bugs
- index.js: erro do banco em `getGuildConfig` **apagava a config real** do servidor (gravava o padrão por cima). Corrigido.
- index.js: o bot respondia à palavra "zoe" em vez de "eclipse". Corrigido.
- index.js: aviso de cooldown da IA agora é só uma reação ⏳ (antes dava pra usar de spam).
- index.js: `/nuke` sem try/catch (deixava o usuário no vácuo quando faltava permissão). Corrigido.
- index.js: `client.once('ready')` → `Events.ClientReady` (o nome antigo está sendo aposentado).
- moderation.js: anti-spam com janela > 30s ou limite > 20 **nunca disparava**. Corrigido.
- moderation.js: anti-spam agora apaga a rajada inteira (antes só a última mensagem) e dá timeout em reincidente.
- moderation.js: ban/mute engoliam o erro e diziam "foi banido" mesmo falhando. Corrigido.
- extras.js: `/diario` podia ser resgatado 2x (race). `abrirTicket` sem try/catch, sem cooldown e com clique duplo criando 2 canais. Corrigido.
- ia.js / duelos.js / moggedimg.js: chamadas externas sem timeout. Corrigido (25s IA, 15s imagens).
- economia.js: vazamento de memória nos mapas de cooldown. Corrigido.

## Anti-raid também protege a cota de IA
- moderation.js: teto de 40 avaliações de IA por minuto por servidor.

## NÃO alterado (de propósito)
- verificacao.js e a API HTTP de `/send-dm`: veja o aviso no guia.


## Gatilho de conversa (v3)
- O chat da Eclipse é acionado quando o nome/apelido aparece em qualquer posição da mensagem, sem diferenciar maiúsculas/minúsculas.
- Também responde quando o usuário menciona o bot ou responde a uma mensagem dele.
