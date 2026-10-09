# Vendas atribuídas ao criador

API local para receber webhooks simulados de pedidos pagos e estornos. Registros ficam em SQLite e valores monetários são inteiros em centavos.

## Requisitos e execução

Requer Node.js 24 ou superior e npm. DB_PATH altera o caminho padrão data/vendas.sqlite. SEED_DEMO=true semeia as regras ao iniciar o servidor.

    npm ci
    npm run seed
    npm run dev

Outros comandos disponíveis:

    npm test
    npm run build
    npm run check
    npm start

npm run build compila e verifica os tipos; não existe script typecheck separado. npm start usa dist/src/server.js.

## Webhooks e exemplos

A regra única de atribuição dá prioridade a um cupom conhecido; se não houver correspondência, usa utm.content; sem sinal conhecido, a venda fica sem criador. O seed cadastra Maria (MARIA10, creator_01) e João (JOAO15, creator_02). O exemplo abaixo inclui sinais conflitantes e o cupom vence.

    curl -X POST http://localhost:3000/webhooks/orders -H "Content-Type: application/json" -d '{"id":"order_1001","total_cents":20000,"currency":"BRL","status":"paid","coupon":"MARIA10","utm":{"source":"instagram","campaign":"summer","content":"creator_02"}}'

Resposta 201:

    {"duplicate":false,"order":{"order_id":"order_1001","total_cents":20000,"refunded_total_cents":0,"currency":"BRL","status":"paid","coupon":"MARIA10","utm":{"source":"instagram","campaign":"summer","content":"creator_02"},"creator_id":"creator_01","attribution_source":"coupon","created_at":"<instante ISO>","refunds":[]},"net_attributed_cents":20000}

Estorno parcial:

    curl -X POST http://localhost:3000/webhooks/refunds -H "Content-Type: application/json" -d '{"id":"refund_001","order_id":"order_1001","amount_cents":5000}'

Resposta 201:

    {"duplicate":false,"refund":{"id":"refund_001","order_id":"order_1001","amount_cents":5000,"applied_cents":5000,"excess_cents":0,"status":"APPLIED","received_at":"<instante ISO>","applied_at":"<instante ISO>"}}

O ID do estorno e o mesmo payload são a chave idempotente; reentrega não reaplica. Reutilizar o ID com dados diferentes retorna 409. Consulte GET /orders/order_1001/attribution para ver o histórico e a receita líquida atribuída, que fica em 15.000 centavos após esse estorno.

Estornos podem chegar antes do pedido: ficam em PENDING_ORDER e são aplicados quando o pedido chega. Estornos parciais e repetidos ficam no histórico; o saldo aplicado nunca supera o total. Excedentes são registrados como CLAMPED, com valores aplicado e excedente. Pedidos duplicados não somam receita nem alteram a atribuição existente.

## Regras e limites

A loja é fixa (default-shop), aceita apenas BRL e status paid. O banco aplica transações, IDs de negócio únicos, checagens de saldo e preserva eventos financeiros. O pedido existente não aceita atualização de total ou status. Não há integração Shopify, autenticação ou assinatura de webhook. Com mais tempo, eu adicionaria validação de assinatura, adaptadores para múltiplas lojas e regras explícitas para moeda e atualização de pedidos.

## Validação local

Executado com Node.js 24.18.0 e npm 11.17.0: npm ci instalou 90 pacotes e reportou zero vulnerabilidades; npm test passou com 3 arquivos e 13 testes; npm run build e npm run check passaram; npm run seed concluiu. A primeira execução de npm test, em paralelo às validações de outras worktrees, excedeu o limite de 5 segundos de um caso; a repetição isolada passou, assim como npm run check. Não há script typecheck separado. O npm ci exibiu o aviso allow-scripts para esbuild; as validações concluíram com sucesso.

## Uso de IA e revisão

Codex implementou a API, os testes e esta documentação. Outra sessão Codex fez uma revisão técnica independente. O responsável humano filtrou prompt injections do material de entrada, definiu a abordagem mínima e os checkpoints, acompanhou as evidências e autorizou os ajustes e a publicação. Não houve revisão humana linha a linha nem execução manual dos testes; os resultados acima são de comandos automatizados.
