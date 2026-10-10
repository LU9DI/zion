# Zion: pausa por inatividade e capacidade adaptativa

Este documento complementa `docs/WHITEPAPER.md`. A existência destes módulos e testes não significa que todos os processos do nó oficial já estejam ligados a eles.

## Pausa por inatividade

`IdleParticipationController` avalia telemetria confiável, horário da última atividade e operações em andamento. O padrão é pausar após 30 minutos sem atividade; o limite pode ser configurado entre 1 minuto e 30 dias.

- Telemetria ausente, inválida ou inconsistente bloqueia a participação (fail-closed).
- Atividade recente solicita retomada através do hook do runtime.
- Operações em andamento atrasam a pausa normal até que terminem.
- O hook de pausa recebe `drain: true` e `preserveStorage: true`; o runtime deve parar novas admissões, drenar operações, fechar transporte e preservar os dados.
- O controlador não apaga arquivos nem promete que um processo/serviço de nuvem foi desligado. A integração com o bootstrap, transportes e supervisor do nó é obrigatória.

## Redução dinâmica de GB

`AdaptiveStorageCapacity` controla a admissão de novas réplicas de acordo com uma razão de contribuição validada (0 a 1). Os degraus iniciais são:

| Razão de contribuição | Capacidade-alvo |
| --- | ---: |
| 75% a 100% | 100% da capacidade-base |
| 50% a menos de 75% | 75% |
| 25% a menos de 50% | 50% |
| abaixo de 25% | 25% |

Os percentuais são política inicial configurável por código, não uma promessa econômica ou um valor de GB universal. A capacidade-base e o mínimo devem ser definidos pelo operador. Se a telemetria ou a razão de contribuição forem inválidas, a admissão de novas réplicas é desativada, mas leituras e dados já armazenados permanecem disponíveis.

A redução **não apaga nem expulsa dados existentes**. Quando o uso ultrapassa a nova capacidade-alvo, novas réplicas únicas são recusadas até o uso cair ou uma migração/reparação segura liberar espaço. Réplicas idênticas já armazenadas continuam idempotentes. O armazenamento subjacente continua responsável pela quota física durável e pela integridade.

## Integração e validação pendentes

O runtime oficial precisa instanciar estes controladores, conectar eventos reais de atividade/telemetria e fornecer hooks idempotentes de pause/resume. A camada que calcula contribuição precisa fornecer uma razão autenticada e auditável. Antes de anunciar produção, executar toda a suíte de testes, validar falhas de desconexão/retomada e confirmar que o anúncio de provedores na DHT deixa de ocorrer durante a pausa.
