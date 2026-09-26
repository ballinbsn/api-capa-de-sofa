# api-capa-de-sofa

Backend do checkout Pix da **Capa de Sofá Vicenza — Leve 2 Pague 1** (gateway ADEX). Guarda as chaves da ADEX e a tabela de preços. O navegador nunca vê as chaves e nunca decide o valor.

## Oferta (definida em `server.js`)

Kit = 2 capas (cor da 1ª e da 2ª à escolha) + 2 almofadas inclusas. Preço por kit, conforme o tamanho:

| Tamanho | Preço |
|---|---|
| 2 Assentos | R$ 87,90 |
| 3 Assentos | R$ 87,90 |
| 4 Assentos | R$ 97,90 |
| 5 Assentos | R$ 107,90 |

Cores: `cinza`, `vermelho`, `marrom`. Quantidade: 1 a 5 kits.

## Rotas

| Método | Rota | O que faz |
|---|---|---|
| POST | `/api/pix` | Valida dados + kit (`{ size, color1, color2, quantity }`), cria a cobrança na ADEX, devolve QR Code e copia-e-cola |
| GET | `/api/pix/:id/status` | Consulta o status (a página faz polling a cada 5s) |
| POST | `/api/webhook` | Recebe avisos da ADEX (`charge.paid` etc.), valida `x-webhook-signature` |
| GET | `/health` | Health check |

## Variáveis de ambiente (Railway → Variables)

Veja `.env.example`. Obrigatórias: `ADEX_PUBLIC_KEY`, `ADEX_SECRET_KEY`, `ALLOWED_ORIGINS`, `PORT=8080`. Recomendadas: `ADEX_WEBHOOK_SECRET`, `PUBLIC_API_URL`, `UTMIFY_API_TOKEN`.

## Rodar local

```bash
npm install
cp .env.example .env   # preencha (use chaves pk_test_/sk_test_)
npm run dev
```

`MOCK_ADEX=true` sobe sem chamar a ADEX (Pix falso, "pago" após 20s) — só para testar a tela.

## Deploy no Railway

1. New Project → Deploy from GitHub repo → `ballinbsn/api-capa-de-sofa`.
2. Variables: preencha as variáveis acima (as chaves quem digita é o dono da conta ADEX).
3. Settings → Networking → Generate Domain (porta 8080). Essa URL vai em `PUBLIC_API_URL` e em `API_URL` (`assets/checkout/config.js` do site).
4. Painel ADEX → Webhooks: cadastre `https://SUA-URL/api/webhook` e copie o segredo para `ADEX_WEBHOOK_SECRET`.
5. Faça uma compra de teste (chaves `test`) e confira o valor cobrado.
