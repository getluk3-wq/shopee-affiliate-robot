# MEDEIROS DIGITAL — Shopee Affiliate Robot (Free starter)

## O que esta versão faz
- Painel escuro responsivo.
- Health check e status das integrações.
- Cadastro manual de produtos, destinos e rascunhos de fila via API protegida por senha.
- Blueprint Render com **um serviço web no plano Free**, sem banco pago.

## Limitações importantes
- Esta é uma base inicial para teste, não uma automação pronta.
- Shopee Affiliate API e Meta Groups API ainda NÃO estão integradas. Não há consulta real de produtos nem publicação/envio de mensagens.
- Dados são gravados em arquivo local. No Render Free o sistema de arquivos é efêmero: dados podem ser perdidos ao reiniciar ou fazer deploy. Não use como armazenamento de produção.
- Serviços Free podem dormir após inatividade e ter limites de uso. Confira as condições atuais do Render.
- A API padrão do WhatsApp Business não garante publicação em grupos arbitrários. Valide elegibilidade, permissões e destinos com a Meta antes de qualquer envio.

## Deploy
1. Envie o conteúdo desta pasta para a raiz de um repositório GitHub.
2. No Render, New > Blueprint e selecione o repositório.
3. O arquivo `render.yaml` está na raiz e cria somente um Web Service `free`.
4. Revise o plano e os recursos antes de aplicar.
5. No Render, abra o serviço > Environment e defina uma senha forte em `ADMIN_PASSWORD` se a variável gerada não estiver disponível no Blueprint.
6. Abra a URL do serviço e teste `/health`.

## Segurança
- Nunca coloque tokens, App Secret, Partner Key ou chaves privadas no GitHub.
- Configure credenciais somente em Environment Variables no Render.
- Não habilite integrações até validar documentação oficial, permissões e limites.
- Use HTTPS, senha forte e acesso administrativo restrito.

## Desenvolvimento local
Requer Node.js 20+.
```bash
npm install
ADMIN_PASSWORD='uma-senha-forte' npm start
```
Abra `http://localhost:3000`.
