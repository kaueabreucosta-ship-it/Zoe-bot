# O que mudou nesta versão

## Visual — tema preto e roxo
- `cores.js` tem a paleta nova (`ROXO` + `CORES`). Todos os embeds, painéis e a imagem do "MOGGED" já usam ela.
- Erros e alertas ficam em rosa-avermelhado pra continuar chamando atenção sem sair do tema.

## IA — agora em `ia.js` + `zoe-ia.js`
- **Persona como instrução de sistema** (mais barata e mais obediente) e prompt enxuto: menos tokens por mensagem.
- **Memória de conversa**: ela lembra as últimas trocas com cada pessoa em cada canal (20 min) e do que ela mesma disse no canal.
- **Vê imagens**: anexo na mensagem, na mensagem respondida ou em `/perguntar imagem:`.
- **Entende reply** (sabe qual mensagem você está respondendo) e **sabe data e hora**.
- **Resposta do tamanho certo**: pergunta curta = resposta curta (economiza cota).
- **Chamada pelo nome mais esperta**: responde a "zoe, ..." / "e aí zoe" / mensagens curtas com o nome, mas não a qualquer frase longa que só cita o nome.
- **Blindagem**: nunca marca @everyone/@here, ignora "esqueça suas regras", remove raciocínio vazado de modelos grátis, nunca quebra palavra ou bloco de código ao dividir mensagens longas.
- **Roteador mais esperto**: falhas seguidas entram em backoff, chave inválida pausa o provedor, os mais saudáveis vêm primeiro, e modelos gpt-oss rodam com raciocínio baixo (`IA_REASONING_EFFORT`).
- **`/perguntar`**: aceita imagem, opção `publico`, e tem cache de 5 min pra pergunta repetida no mesmo servidor.
- **`/iastatus`** (admin): mostra cada provedor, se está pausado por cota, falhas, velocidade e último erro.
- O dono não tem cooldown de IA.

## Painel `/cargos`
- Seleção múltipla de cargos (até 25) e de canais (até 25); tudo vale pra todos os selecionados.
- Permissões: adicionar / remover / substituir. Canais: ver, ocultar, escrever, só leitura, limpar e permissões avançadas.
- Exclusão pede confirmação. Bug dos menus que não respondiam foi corrigido.

## Código
- Comandos registrados em paralelo no start (bot fica pronto bem mais rápido).
- Desligamento limpo ao receber SIGTERM (deploy no Render).
- Lógica de chat saiu do `index.js` pra `zoe-ia.js`; funções de texto puras em `texto-util.js` (com testes: `npm test`).

## Variáveis novas (todas opcionais, veja `.env.example`)
`BOT_NOME`, `BOT_APELIDOS`, `BOT_TZ`, `IA_REASONING_EFFORT`.

## Não alterado
- `verificacao.js` e as rotas `/verificar`, `/send-dm`: não mexi. Ver aviso na conversa.

## Naturalidade + Responsividade (v4)

- **Prompt de personalidade redesenhado**: respostas mais fluidas, frases curtas, sem aberturas robóticas ("Claro!", "Ótima pergunta!"), continua o papo de verdade.
- **Typing contínuo**: enquanto a IA gera, o bot fica "digitando" (reenvia a cada 8s).
- **Cooldown 7s** (antes 10s) e memória de conversa 30 min / 4 trocas (antes 20 min / 3).
- **Paralelismo**: baixa imagens e busca contexto do canal ao mesmo tempo.
- **Tokens adaptativos**: "oi" / cumprimentos → resposta bem curta (~120 tokens); explicações longas → mais espaço.
- **Limpeza extra**: remove aberturas típicas de IA da saída.
- **Temperature 0.9**: respostas um pouco mais variadas e naturais.

## /cargos mais prático (v4.1)
- Selecionar uma **categoria** inclui automaticamente **todos os canais** dela (texto, voz, fórum, stage).
- Aviso no painel quando a expansão acontece (respeita o limite de 25).
- Placeholder e textos deixam claro: vários cargos, vários canais ou categoria de uma vez.
- Categorias aparecem como 📁 **nome** na lista selecionada.

## Personalidade v5 (zoe-ia.js + texto-util.js)
- **Persona redesenhada**: agora é uma personagem (debochada, leal, com opinião e humor seco), não só "bot que xinga". Sarcasmo é a base, palavrão é tempero.
- **Humor do momento**: muda a cada ~3h por conversa (zoeira solta, seca, animada, preguiçosa, sarcástica, parceira de resenha) — a Zoe parece "viva" sem ficar aleatória.
- **Hora do dia**: de vez em quando (25%) comenta madrugada/manhã/noite quando encaixa.
- **Paciência de verdade**: só fica impaciente quando a pessoa REPETE a mesma pergunta (detecção por sobreposição de palavras), e zoa a situação/comportamento — não a inteligência da pessoa.
- **Lê o ambiente**: assunto sério (luto, tristeza forte, risco de se machucar) desliga deboche e palavrão e acolhe (cita o CVV 188).
- **Anti-repetição**: se as últimas respostas já tinham muito palavrão, a próxima zoa na ironia.
- **Ajuda de verdade**: dúvida séria = resposta certa primeiro, piada depois.
- Novas funções puras em `texto-util.js` (com testes): `detectarSeriedade`, `contarPalavroes`, `ehRepeticao`, `periodoDoDia`, `escolherHumor`.

## /backup (backup.js + backup.sql)
- `/backup criar [nome]` salva cargos, categorias, canais (com permissões por cargo, tópico, slowmode, NSFW, bitrate) e emojis no Supabase.
- `/backup listar` · `/backup info id` (árvore do servidor) · `/backup excluir id` (com confirmação).
- `/backup restaurar id [emojis]` recria só o que **ainda não existe** (compara por nome); nunca apaga nem altera nada. Dá pra restaurar em servidor novo (se foi você que criou o backup).
- **Só o dono do bot (OWNER_ID)** executa. O comando aparece só para administradores, mas quem não é o dono recebe uma recusa. Limite de 10 backups por servidor.
- **Rode `backup.sql` uma vez no Supabase** antes de usar. A tabela fica com RLS ligado e sem policies (só a chave service_role do bot acessa).
- Não salva: mensagens, membros e seus cargos, bots, webhooks, convites, stickers, eventos.

## /permissoes — vários cargos × vários comandos de uma vez (banimento.js)
- Escolha **até 25 cargos** e **vários comandos** no mesmo painel, depois o modo e **Aplicar**:
  - ➕ **Adicionar**: dá os comandos aos cargos (mantém o que já tinham)
  - ➖ **Remover**: tira os comandos dos cargos
  - ♻️ **Substituir**: deixa os cargos com SÓ os comandos escolhidos (sem comandos = limpa)
- Escolhendo **um** cargo, o painel já mostra os comandos que ele tem hoje.
- Botões 📋 **Resumo** (tudo que cada cargo pode) e 🧹 **Limpar** (zera a seleção).
- Aviso quando o @everyone entra na lista (todo mundo passaria a usar o comando).
- Comandos controláveis: `banir`, `desbanir`, `banidos`, `nuke`, `moderacao`, `contexto`, `antiraid`. O `/backup` não entra: é só do dono.
- Usa a mesma tabela `cargo_permissoes` (banimento.sql); não precisa rodar SQL novo.
