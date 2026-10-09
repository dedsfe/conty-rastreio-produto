# Rastreio do produto enviado ao criador

Integra com um agregador de rastreio fictício (o "TrackHub"): cadastra o código, consulta o status, traduz o dialeto de cada transportadora para cinco status estáveis e avisa quando o tempo em trânsito passa de um limite. O agregador pode mandar evento repetido e fora de ordem. Node 22, Hono, `node:sqlite`, TypeScript.

```bash
npm install
npm test        # 56 testes, data controlada
npm run dev     # http://127.0.0.1:3007, com dois pacotes simulados
```

Por onde ler: `src/aggregator.ts` (a fronteira) → `src/status.ts` e `src/delay.ts` (as duas regras, puras) → `src/shipments.ts` → `test/`.

## O agregador fica atrás de uma interface

Só `src/trackhub/` conhece o formato do TrackHub. O resto do sistema fala `TrackingAggregator` (`register`, `fetch`, `parseWebhook`) e `NormalizedEvent`, definidos em `src/aggregator.ts`. Trocar de agregador é escrever outro adaptador que devolva esses tipos; nenhuma outra linha muda. Dentro do adaptador há uma segunda fronteira: o transporte HTTP (`HttpTransport`) também é uma interface, então o `TrackHubClient` roda nos testes contra um `FakeTrackHub` que devolve o JSON bruto como o servidor de verdade faria.

## Payload bruto e status normalizado

Resposta bruta do TrackHub (`GET /v1/trackings/JD998877665544`):

```json
{
  "data": {
    "tracking_number": "JD998877665544",
    "courier": "jadlog",
    "checkpoints": [
      { "id": "cp_1", "checkpoint_time": "2026-05-03T09:00:00-03:00", "courier_status": "COLETADO" },
      { "id": "cp_2", "checkpoint_time": "2026-05-04T09:00:00-03:00", "courier_status": "STATUS_NOVO_DA_JADLOG" }
    ]
  }
}
```

O que o sistema guarda e devolve (`POST /shipments/:id/sync`; resposta real, resumida):

```json
{
  "summary": { "received": 2, "inserted": 2, "duplicates": 0, "unmapped": 1, "rejected": 0 },
  "shipment": {
    "tracking_code": "JD998877665544", "carrier": "jadlog",
    "status": "posted", "status_at": "2026-05-03T12:00:00.000Z",
    "posted_at": "2026-05-03T12:00:00.000Z", "delivered_at": null, "needs_review": true,
    "events": [
      { "event_key": "id:cp_1", "occurred_at": "2026-05-03T12:00:00.000Z", "status": "posted",
        "raw_status": "COLETADO", "unmapped": false },
      { "event_key": "id:cp_2", "occurred_at": "2026-05-04T12:00:00.000Z", "status": null,
        "raw_status": "STATUS_NOVO_DA_JADLOG", "unmapped": true }
    ]
  }
}
```

Os cinco status: `posted`, `in_transit`, `out_for_delivery`, `delivered`, `exception`. O horário vira UTC e o texto bruto da transportadora é sempre preservado.

(Os horários da demonstração são de maio e o relógio real é outro, por isso o pacote da demo aparece como atrasado; nos testes o relógio é controlado.)

## Status desconhecido nunca vira entregue

A tradução (`src/trackhub/dialects.ts`) é uma tabela por transportadora, com busca por **texto exato** depois de tirar acento, caixa e espaço sobrando, e nunca por trecho: "Objeto não entregue" contém "entregue" e não pode virar entregue (há teste). O que não está na tabela, ou vem de uma transportadora desconhecida, fica com `status: null`: o evento entra no histórico com o texto bruto, o pacote ganha `needs_review: true` e o status do pacote **não muda por causa dele**. É o sinal para alguém acrescentar a tradução.

## Evento fora de ordem não faz o status voltar

O status do pacote é **recalculado do histórico inteiro** a cada evento novo, nunca empilhado na ordem de chegada (`deriveStatus` em `src/status.ts`):

- vale o evento de **horário mais recente**; um evento antigo que chega tarde tem horário antigo e por isso não muda nada;
- **entregue é final**: nenhum evento depois dele (nem um com horário mais novo) muda o status;
- exceção seguida de andamento mais novo se recupera; andamento mais antigo não derruba a exceção;
- empate de horário: entregue > exceção > saiu para entrega > em trânsito > postado;
- evento sem horário legível é descartado e contado em `rejected`, em vez de ganhar um horário inventado.

## Repetido não duplica

Cada evento tem uma `event_key` (o id do agregador ou, se faltar, um resumo do horário, status e local), e `(pacote, event_key)` é a chave primária do histórico. Consultar de novo o mesmo código, ou receber o mesmo webhook duas vezes, devolve `duplicates` e deixa o histórico igual.

## Como o atraso é detectado sem marcar entrega normal como atraso

`src/delay.ts`, em uma regra:

```
início = horário do evento "postado" (se não houver, o evento mais antigo)
fim    = horário da ENTREGA, se entregue; senão, agora
atraso = (fim - início) > limite        (exatamente no limite ainda não é atraso)
```

A parte que evita o falso positivo é o `fim`: **o relógio para na entrega**. Quem chegou dentro do limite fica `delivered_on_time` para sempre, mesmo olhando três meses depois; comparar "agora menos postado" sem parar na entrega marcaria todo pacote entregue como atrasado. Estados: `not_started`, `in_time`, `late`, `delivered_on_time`, `delivered_late`.

O aviso sai só para `late` (em trânsito e acima do limite): **uma vez por pacote** (`delay_alerts` tem o pacote como chave) e nunca para quem já foi entregue (`delivered_late` fica só no registro). Ele é checado quando o pacote sincroniza e em `POST /delays/check`, que serve para um agendamento olhar todos os pacotes não entregues contra o relógio. Se o envio do aviso falhar, a trava é desfeita e a próxima checagem tenta de novo, em vez de perder o alerta. O limite padrão é de 168 h e pode ser definido por pacote (`max_transit_hours`).

## API

```bash
curl -s -X POST localhost:3007/shipments -H 'content-type: application/json' \
  -d '{"tracking_code":"JD998877665544","carrier":"jadlog","max_transit_hours":72}'
curl -s -X POST localhost:3007/shipments/$ID/sync              # consulta o agregador
curl -s localhost:3007/shipments/$ID                            # status, atraso e histórico
curl -s -X POST localhost:3007/webhooks/tracking -d '<corpo bruto do TrackHub>'
curl -s -X POST localhost:3007/delays/check                     # para o agendador
```

Códigos: `404` pacote ou código não encontrado, `502` falha do agregador (nada é alterado), `400` entrada inválida.

## Testes

56 testes, todos com data controlada: o status derivado (fora de ordem, entregue final, empate, exceção que se recupera); a regra de atraso nas bordas (no limite, 1 ms depois, entrega normal olhada 90 dias depois, entregue com atraso, sem eventos, dado ruim); os dialetos (os três, incluindo "Objeto não entregue", texto com espaço e caixa diferentes, status inventado, transportadora desconhecida); a normalização do bruto (fuso, chave sem id, evento sem horário, formato desconhecido); e o fluxo pela API (cadastro, sync repetido, evento novo, 404 e 502, webhook fora de ordem e repetido, status inventado, aviso uma vez só, limite por pacote, aviso que falha e é refeito). Para ter certeza de que eles pegam bug, mutei o código em seis pontos: entregue deixando de ser final, status igual ao último a chegar, limite exclusivo, relógio que não para na entrega, tradução por trecho e histórico que substitui em vez de ignorar duplicado. Todos quebram testes.

## O que ficou de fora

- **Sem retry, timeout nem limite de taxa no cliente do agregador.** Uma falha vira `502` e o chamador tenta de novo; o `TrackHubClient` é o lugar certo para isso.
- **Sem assinatura do webhook.** Qualquer um que conheça a rota poderia mandar eventos; em produção o adaptador validaria a assinatura do agregador.
- **O limite é em horas corridas**, sem dias úteis, feriados nem prazos diferentes por transportadora ou rota.
- **"Entregue" é final.** Se uma transportadora corrige uma entrega indevida, o sistema não reabre o pacote sozinho; o evento fica no histórico para revisão.
- **Tabelas de tradução só para três transportadoras**, e fixas no código; num sistema real ficariam em dados, com alerta quando `needs_review` crescer.
- **O agendamento de `/delays/check` não existe**: a rota está pronta, quem a chama (cron) não.
- **Sem autenticação** nas rotas.

## Uso de IA

Usei IA para escrever o código, os testes e este README. Acompanhei o desenvolvimento, os testes passando, as mutações que quebram os testes e o exemplo acima, que é a resposta real da API rodando. O repositório não tem nenhum arquivo dirigido a ferramenta.
