# Publicações da Ayla

## Perfil compartilhado: HOME e VIP

Em `/admin`, abra **Perfil — nome, bio, avatar e capa**. Edite os textos, selecione
JPG/PNG/WebP para substituir as imagens e clique em **Salvar perfil**. Sem selecionar
arquivo, a imagem atual é mantida. **Recarregar perfil** busca a última versão salva.
As duas páginas recebem os mesmos dados ao abrir/atualizar; não há cópia da bio no HTML.

A tabela aditiva `creator_profiles` guarda nome, username, bio e referências às imagens.
O perfil de `backend/vip-content.js` é somente o padrão inicial, incluindo a bio atual
da HOME. A inicialização existente cria a tabela em SQLite/PostgreSQL e ativa RLS no
PostgreSQL. Nenhuma migração de posts ou upload é disparado automaticamente.

Avatar e capa selecionados são **imagens públicas de apresentação**, embora armazenados
no bucket privado existente. Apenas as duas imagens salvas no perfil são acessíveis
pelas rotas fixas `/api/profile/media/avatar` e `/api/profile/media/cover`, com redirecionamento
assinado do Storage. Os posts VIP continuam exigindo assinatura ativa. Não selecione
uma foto exclusiva como avatar/capa. A chave do Storage nunca vai ao navegador.

A capa usa a mesma proporção de banner nas duas telas (1098:450), sem distorção.
O arquivo atual já é um close no rosto; para mostrar rosto e corpo, envie uma foto
horizontal mais aberta. CSS não recupera partes ausentes do arquivo original.

Os controles existentes continuam em **Nova publicação** e **Editar**: mídia/legenda,
publicação/rascunho, Preview HOME e ordem. **Excluir / arquivar** retira do feed sem
apagar a mídia; use **Mostrar → Arquivados → Restaurar como rascunho** para recuperar.

## Visual e escopo

O VIP continua a home: branco, laranja, coluna de 430 px centralizada, cartões brancos, cabeçalho pequeno, mídia, legenda e ações. Os filtros, o mimo informativo e a autorização do comprador permanecem. A folha de estilo tem versão no endereço para evitar mostrar a antiga aparência em cache.

Não foram alterados preços, checkout, SigiloPay, webhook ou regras de assinatura. Nenhum arquivo do outro projeto foi acessado. Nenhuma mídia existente foi enviada.

## Configurar e acessar /admin

1. Instale as dependências em `E:\Privacy_Ayla\backend` com `npm.cmd ci`.
2. Configure no **backend/.env local**, ou nas variáveis do servidor/Vercel:

```dotenv
ADMIN_ACCESS_SECRET=
ADMIN_ORIGIN=
ADMIN_UPLOAD_MAX_MB=250
VIP_MEDIA_DRIVER=supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
VIP_MEDIA_BUCKET=vip-ayla
```

`ADMIN_ACCESS_SECRET` é uma chave administrativa **nova, aleatória, com pelo menos 32 caracteres**. Não reutilize a service role, a credencial do comprador ou as chaves de pagamento. Gere-a em seu gerenciador de senhas e mantenha-a lá. Nenhum valor real foi preenchido pela implementação.

`ADMIN_ORIGIN` é a origem exata usada no navegador: por exemplo, `http://localhost:3333` no desenvolvimento ou `https://seu-dominio` na produção. Sem essa variável, o servidor usa `PUBLIC_APP_URL`; no desenvolvimento sem ambos, usa a própria origem da requisição. Escolha localhost **ou** 127.0.0.1 e mantenha a mesma origem. Produção deve usar HTTPS.

As configurações já existentes de `DATABASE_URL` (PostgreSQL em produção), `VIP_MEDIA_SECRET`, pagamento e `PUBLIC_APP_URL` continuam necessárias. O bucket deve permanecer **privado**, sem políticas de leitura/upload para visitantes. O painel bloqueia upload se detectar bucket público. Configure os limites de arquivo do bucket e do projeto para o tamanho pretendido.

3. Reinicie o backend/deploy. No local: `npm.cmd start` (respeitando seu provedor configurado). A inicialização cria as tabelas novas de forma aditiva no banco existente. Não é necessário substituir nem recriar as tabelas de pedidos.
4. Acesse `http://localhost:3333/admin` ou `https://seu-dominio/admin` e informe a chave administrativa.

Sem configuração de admin, nenhum login é aceito. `/admin` redireciona visitantes ao login; o painel, sua lista, suas ações e seu script de gerenciamento exigem sessão administrativa. Credenciais de comprador não servem para o painel.

A sessão dura quatro horas, é persistida no banco somente como hash e usa cookie HttpOnly/SameSite=Strict/Secure em produção. As alterações exigem origem válida e token CSRF. Há limite de tentativas de login persistido no banco. Sair revoga a sessão; trocar `ADMIN_ACCESS_SECRET` invalida as sessões anteriores. Não compartilhe essa chave com compradores.

## Criar uma publicação

1. Clique em **Nova publicação**.
2. Selecione JPG, PNG, WebP, MP4 ou WebM. O painel mostra uma prévia local do arquivo.
3. Escreva a legenda e defina a **Ordem no feed** (menor número aparece primeiro).
4. Marque **Publicado**, ou deixe desmarcado para rascunho.
5. Clique em **Salvar publicação** e aguarde o envio concluir. Em falha de conexão, tente salvar novamente com o mesmo arquivo selecionado: o envio consulta o progresso persistido. Não feche a janela durante o upload.
6. Quando estiver pronta para substituir o feed antigo, clique em **Usar publicações do painel**. A troca é explícita. Enquanto não fizer isso, os posts preparados aqui não substituem o feed antigo.

O limite padrão é 250 MiB, configurável entre 1 e 500 MiB, sujeito também ao limite do bucket. Não há upload direto pelo navegador para o Supabase. Os bytes passam por endpoints administrativos autenticados em blocos de 3 MiB. O backend combina até 6 MiB e usa o protocolo TUS do Storage. Isso respeita o [limite de requisição da Vercel](https://vercel.com/docs/functions/limitations) e os blocos do [upload retomável do Supabase](https://supabase.com/docs/guides/storage/uploads/resumable-uploads).

Apenas uma fração temporária do upload fica no banco; ela é removida ao confirmar o bloco. Fragmentos de envios abandonados expiram e são limpos no início de um próximo upload. Não há dependência de disco local persistente na Vercel. O backend confere tamanho, formato, assinatura inicial do arquivo, posição dos blocos e bucket privado. A service role e a URL remota de upload nunca são devolvidas ao navegador.

## Editar, ordenar, despublicar e excluir

- **Editar:** altere legenda ou ordem. Se não selecionar um arquivo, a mídia atual permanece. Selecionar outro arquivo faz um novo upload com caminho único, sem sobrescrever o anterior.
- **Publicar/Despublicar:** use o botão na lista, ou marque/desmarque Publicado no editor. No feed gerenciado, rascunhos não aparecem.
- **Excluir / arquivar:** retira a publicação do feed e preserva o registro, as curtidas e a mídia. Não apaga fisicamente o arquivo do bucket.
- **Restaurar:** no filtro Arquivados, restaure como rascunho e revise antes de publicar.
- **Ordenar:** use **Mover para cima** / **Mover para baixo** na lista, que trocam a posição com o vizinho, ou edite o número Ordem no feed diretamente. A classificação é `sort_order`, `created_at` e `id` como desempate estável.

Duas edições simultâneas não se sobrescrevem silenciosamente: o painel pede para recarregar a versão atual. Arquivos substituídos, arquivados ou de uploads sem publicação são preservados no bucket; a limpeza definitiva é manual e não faz parte desta etapa.

## Prévia bloqueada da HOME

A página de venda mostra uma amostra bloqueada do feed. Quem decide o que entra ali é o painel, pelo campo **Mostrar como prévia na HOME**. Uma publicação aparece na HOME quando ela está **publicada** e **marcada como prévia**; rascunho e arquivado nunca aparecem.

Na lista, o botão **Mostrar na prévia da HOME** / **Tirar da prévia da HOME** alterna sem abrir o editor, e a etiqueta *Prévia HOME* marca quem está no ar. No editor, a mesma opção fica abaixo de Publicado.

O visitante **não recebe a mídia original**. Ao selecionar o arquivo, o painel gera no seu próprio navegador uma **amostra de 64×80 pixels** e mostra como ela vai ficar. É essa amostra — cerca de 1 KB — que a HOME publica, desfocada por CSS. Nesse tamanho o conteúdo do arquivo já se perdeu de forma irreversível: não existe como reconstruir a foto ou o quadro do vídeo a partir dela. O arquivo pago continua só no bucket privado, entregue por link assinado de curta duração a quem tem assinatura ativa. O endpoint público `/api/home/previews` devolve apenas id, tipo, legenda e a amostra; nunca `media_path`, nunca link de mídia.

O servidor reconfere a amostra antes de guardar: precisa ser JPEG de verdade (assinatura do arquivo), no máximo 96 px de largura e 24 KB. Qualquer outra coisa é recusada — inclusive um envio manipulado que tentasse subir o arquivo inteiro como "prévia".

Consequências práticas:

- **Trocar a mídia apaga a amostra antiga**, porque ela mostrava o arquivo anterior. Selecione o novo arquivo e salve: a amostra é gerada junto.
- **Marcar a prévia sem amostra é recusado.** Posts importados do feed antigo e posts salvos antes desta etapa não têm amostra. Abra *Editar*, selecione a mídia novamente e salve.
- Se o navegador não conseguir decodificar o vídeo (formato que ele não abre), o painel avisa e a publicação segue normalmente para o VIP — só não pode ser marcada como prévia da HOME até você enviar um arquivo que ele leia.
- Sem nenhuma publicação marcada, a HOME mantém as prévias estáticas já existentes em `previews/`. A troca é automática assim que a primeira for marcada, e volta sozinha se você desmarcar todas.
- No máximo 12 prévias aparecem na HOME, na mesma ordem do feed.

## Comprador e mídias

O feed gerenciado consulta somente `creator_id='ayla'`, `published=1` e `archived=0`, depois de validar o pedido e o entitlement ativo. O `media_path` não é enviado no JSON do feed. Imagem/vídeo continua usando a rota assinada existente e a signed URL curta do bucket privado.

Despublicar/arquivar bloqueia novas entregas pela rota da aplicação. Uma signed URL do Storage que já foi emitida permanece válida até seu TTL configurado (normalmente 120 segundos, limitado a 60–300 segundos). Arquivos já baixados ou exibidos não podem ser revogados do dispositivo do usuário.

Posts do painel usam contagem real, começando em zero, com uma curtida por post e pedido/assinatura. Clicar novamente remove a curtida; repetições não duplicam a interação. Como não há uma conta de comprador independente do pedido, duas assinaturas diferentes são dois identificadores. O fallback antigo mantém suas contagens fixas e reação local; não se fabricam novos números a cada carregamento. O mimo continua sem processamento de pagamento.

## Tabelas adicionadas

| Tabela | Uso |
|---|---|
| `vip_posts` | Conteúdo, mídia, ordem, publicação, arquivamento, prévia da HOME e versão |
| `vip_content_settings` | Seleção explícita entre feed antigo e gerenciado |
| `vip_post_likes` | Curtidas reais únicas por post/pedido |
| `admin_sessions` | Hash e validade das sessões administrativas |
| `admin_login_limits` | Limite de tentativas entre instâncias do servidor |
| `vip_uploads` | Caminho privado, progresso e fragmento temporário do upload |

Colunas acrescentadas nesta etapa em `vip_posts`: `show_as_preview` (0/1) e `preview_image` (a amostra da HOME em base64). São **aditivas**: bancos criados antes recebem as colunas no boot, sem recriar a tabela e sem perder publicações, e nenhum post antigo vira prévia sozinho.

O schema está em `backend/db/schema.content.sql`, reutilizado pelos drivers existentes. No PostgreSQL, as tabelas novas recebem RLS sem políticas de acesso público; os endpoints backend usam a conexão privada do banco. Não crie políticas públicas para essas tabelas.

## Migração do feed antigo

`backend/vip-content.js` foi preservado e continua como fallback inicial. Não houve migração automática.

**Importar posts antigos como rascunhos** copia os registros de foto/vídeo e seus caminhos para o banco, com IDs estáveis. Repetir a importação não duplica nem sobrescreve os posts já importados. Os blocos promocionais antigos permanecem apenas no fallback. Todas as mídias importadas precisam ser revisadas: caminhos locais não viram objetos do Supabase; substitua a mídia pelo painel antes de publicar na produção. As contagens ilustrativas antigas não são importadas como curtidas reais.

Após preparar seus posts definitivos, ative **Usar publicações do painel**. Um feed gerenciado vazio continua vazio; nunca reativa silenciosamente os posts antigos. O botão **Usar feed antigo** permite retorno explícito ao fallback durante a migração.

## Testes

- `npm.cmd test`: testes existentes de pagamento, persistência, autorização, mídias e Storage simulado, mais a suíte administrativa e conteúdo/PostgreSQL.
- `node tests/admin.js`: autenticação separada, CSRF, bucket público recusado, CRUD, arquivamento/restauração, fallback, migração idempotente, curtidas concorrentes, expiração, upload dividido com falha/repetição e a prévia da HOME (amostra inválida recusada, marcar sem amostra recusado, rascunho e arquivado fora da HOME, e nenhum caminho de mídia na resposta pública).
- `node tests/content-postgres.js`: motor PostgreSQL via PGlite, usando o adapter de produção, para schema, CRUD, migração, sessões, curtidas e RLS.
- `npm.cmd run check`: sintaxe de todos os JavaScripts.
- `npm.cmd run audit:security`: auditoria existente.
- Navegador: login, editor, legenda/ordem/publicação, troca explícita do feed e curtida persistida no VIP, em banco descartável.

Nenhum teste usou sua conta real de Storage, banco remoto ou cobrança real. A comunicação com o Supabase real e as permissões do seu bucket ainda precisam de uma validação no ambiente configurado por você. PGlite testa o motor/SQL; não substitui o teste de rede, credenciais e pooler de produção.
