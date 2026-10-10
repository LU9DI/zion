# Zion: Especificação Técnica do Protocolo Distribuído

**Versão do documento:** 0.1 — rascunho para revisão  
**Versão de referência do software:** 0.31.0  
**Estado:** proposta arquitetural; não é declaração de implementação completa nem de prontidão para produção.

## Resumo

Zion é uma proposta de rede peer-to-peer para armazenar e recuperar objetos cifrados usando recursos voluntários de computadores participantes. A rede pretende evitar um catálogo central obrigatório, tolerar a entrada e saída frequente de nós e verificar criptograficamente a integridade dos dados recuperados.

A arquitetura proposta combina identidade de pares, transporte autenticado, descoberta distribuída de provedores via Kademlia DHT, armazenamento endereçado por conteúdo, codificação de apagamento, reparação de fragmentos e auditorias verificáveis de armazenamento. Nenhuma destas técnicas, isoladamente, garante disponibilidade permanente, resistência total a ataques Sybil ou escalabilidade ilimitada. A disponibilidade depende da diversidade real dos provedores, conectividade, incentivos, capacidade de reparação e governança operacional.

**Importante:** na versão 0.31.0, a integração real com libp2p/Kademlia, NAT traversal em produção, Reed–Solomon e prova contínua de armazenamento não devem ser considerados implementados apenas porque estão especificados aqui. Esta especificação separa requisitos-alvo do estado verificado do protótipo.

## 1. Objetivos e não objetivos

### Objetivos

- Não depender de um único servidor central para o catálogo de provedores.
- Cifrar os dados no cliente antes de distribuí-los.
- Verificar a integridade de todos os fragmentos por hashes criptográficos.
- Descobrir provedores por uma DHT e transferir dados diretamente sempre que possível.
- Recuperar objetos mesmo quando parte dos nós estiver offline, desde que reste redundância suficiente.
- Limitar recursos consumidos por pares não confiáveis e permitir revogação de identidades.
- Definir mensagens, limites, versões e testes de interoperabilidade explícitos.

### Não objetivos e limites

- Garantir que um arquivo esteja sempre disponível sem um número suficiente de fragmentos online.
- Garantir anonimato absoluto ou impedir análise de tráfego.
- Tratar reputação como prova criptográfica de armazenamento.
- Permitir armazenamento ilimitado ou gratuito sem limites locais, mecanismos antiabuso e políticas de contribuição.
- Declarar resistência a ataques de nível militar. Essa expressão não é uma propriedade técnica mensurável.

## 2. Modelo de ameaças

Assume-se que qualquer nó remoto pode ser malicioso, estar comprometido, mentir sobre disponibilidade, enviar dados inválidos, desaparecer a qualquer momento ou criar várias identidades. A rede deve considerar também eclipse attacks, envenenamento de registros DHT, replay, Sybil, abuso de bandwidth/CPU/memória, partições de rede, NAT/CGNAT, relógios incorretos e perda de chaves.

Os controles mínimos incluem limites de tamanho e taxa, deadlines reais, autenticação de pares, validação de todos os dados recebidos, deduplicação de pedidos, expiração de registros, diversidade de peers, reputação limitada e recuperabilidade por múltiplos provedores. Nenhum score de reputação deve ser a única base para descartar dados de um usuário.

## 3. Identidade e segurança criptográfica

Cada instalação deve gerar uma identidade criptográfica persistente. A chave privada deve ser armazenada por mecanismo apropriado ao sistema operacional, com permissões restritas e opção de rotação. A chave pública identifica o peer, mas não prova que ele é confiável ou que possui recursos honestos.

A conexão deve autenticar a identidade do par e cifrar o tráfego. Para transportes libp2p, utilizar os mecanismos de segurança suportados e mantidos pela stack, sem criar criptografia própria. Chaves de cifragem dos arquivos são distintas das chaves de identidade da rede e não devem ser publicadas na DHT.

Cada objeto é cifrado no cliente antes de codificação e distribuição. Metadados publicados devem ser mínimos; nomes de arquivos, chaves de descriptografia e dados pessoais não devem ser incluídos em registros públicos da DHT.

## 4. Endereçamento de conteúdo e manifesto

O conteúdo deve ser dividido em blocos de tamanho configurável, cifrado com esquema autenticado e identificado por hash criptográfico do conteúdo armazenado. Um manifesto versionado descreve: identificador do objeto, algoritmo e parâmetros de cifragem, tamanho original, parâmetros de codificação, lista ordenada de identificadores de fragmentos, tamanhos, versão do formato e informação necessária para validação e reconstrução.

O manifesto deve ser autenticado pelo proprietário do objeto ou por mecanismo equivalente. A integridade dos fragmentos não autentica por si só a autoria do manifesto. Não se deve reutilizar nonce com a mesma chave em esquemas AEAD.

## 5. Descoberta distribuída: Kademlia DHT

A camada de descoberta proposta usa Kademlia através de libp2p. A DHT mantém registros de roteamento e associa chaves de conteúdo a anúncios de provedores. A busca é iterativa e consulta um conjunto limitado de peers próximos no espaço de IDs; o número de saltos e a latência real dependem da topologia, parâmetros e conectividade — não existe garantia fixa de milissegundos nem de exatamente quatro ou cinco consultas.

Requisitos:

1. Validar a forma e o tamanho de cada chave e registro.
2. Aplicar TTL, renovação e expiração de anúncios.
3. Limitar o número de provedores retornados e deduplicar resultados.
4. Verificar a identidade e testar a disponibilidade do provedor antes de confiar nele.
5. Buscar vários provedores independentes, evitando depender de um único peer.
6. Tratar respostas da DHT como pistas não confiáveis, nunca como prova de que os dados existem.
7. Usar mecanismos de bootstrap configuráveis e documentar os riscos de eclipse e dependência de bootstrap.

A DHT é um índice distribuído, não o armazenamento do arquivo e nem um mecanismo de consenso global.

## 6. Conectividade e NAT traversal

A conectividade deve usar os transportes suportados pelo libp2p. O objetivo é preferir conexões diretas, incluindo QUIC sobre UDP quando disponível, e usar mecanismos de descoberta de endereço público, hole punching e relay quando necessário.

STUN, TURN e ICE são conceitos e protocolos relacionados, mas não devem ser apresentados como recursos automaticamente garantidos por qualquer configuração libp2p. A implementação deve selecionar e testar explicitamente mecanismos compatíveis, por exemplo AutoNAT, relay e hole punching conforme a versão da stack. CGNAT simétrico, firewalls corporativos e redes móveis podem impedir conexão direta; nesses casos pode ser necessário relay, com custo e implicações de privacidade.

Toda conexão deve ter timeout, limite de conexões, limite de streams, limites de tamanho de mensagem e política de backpressure. Conexões relay não devem permitir uso ilimitado de banda.

## 7. Transporte: QUIC e compatibilidade

QUIC sobre UDP é o transporte preferencial quando suportado pela stack e pela rede, devido ao estabelecimento de conexão e multiplexação de streams. TCP pode ser mantido como fallback de compatibilidade. A seleção do transporte deve ser negociada e testada, não presumida.

O uso de QUIC não elimina latência, perda de pacotes, restrições de NAT ou ataques de exaustão de recursos. A implementação deve manter limites explícitos e métricas que não exponham dados privados.

## 8. Redundância e Erasure Coding

O desenho-alvo suporta codificação Reed–Solomon ou outro código MDS bem especificado. Com parâmetros **k=10** fragmentos de dados e **m=20** fragmentos de paridade, são gerados 30 fragmentos; um código MDS correto permite reconstrução a partir de quaisquer 10 fragmentos válidos. Isso representa 3× o volume de dados codificados antes de metadados e overhead, não economia de espaço em relação a uma única cópia. A vantagem é tolerar até 20 fragmentos ausentes entre os 30, desde que os 10 restantes sejam distintos e válidos.

A codificação deve ocorrer sobre o conteúdo cifrado ou sobre um formato de fragmento autenticado. A reconstrução deve validar hashes e autenticação antes de entregar os dados ao chamador. O formato precisa fixar algoritmo, parâmetros, tamanhos e ordem dos fragmentos para garantir interoperabilidade.

O posicionamento deve distribuir fragmentos por domínios de falha independentes, evitando concentrar todos os fragmentos num mesmo provedor, ASN, região ou operador. A redundância matemática não garante durabilidade se os fragmentos restantes estiverem offline ou corrompidos.

## 9. Auditoria de armazenamento e proteção contra free-riders

Assinaturas digitais provam controle de uma chave, não posse contínua de um arquivo. Uma prova de armazenamento deve desafiar aleatoriamente posições ou blocos comprometidos por uma estrutura verificável, como Merkle tree ou esquema criptográfico de prova de posse, e exigir uma resposta dentro de um prazo razoável.

Os desafios devem ser imprevisíveis, limitados em custo e resistentes a replay. A rede deve definir frequência, amostragem, tolerância a falhas transitórias e procedimento de contestação. Um nó pode estar temporariamente offline; uma única falha não deve causar punição irreversível automática.

Reputação é um sinal probabilístico, não prova absoluta. Respostas inválidas repetidas podem reduzir a confiança ou excluir temporariamente um provedor. A rede não deve apagar os dados de outros usuários como punição coletiva, nem assumir que punir uma identidade impede ataques Sybil. Mitigações Sybil podem incluir limites de taxa, custos de recursos, diversidade de peers, auditorias e políticas de admissão; não há solução universal gratuita e perfeita.

## 10. Incentivos, quotas e fairness

Cada nó define quotas locais explícitas de disco, CPU, memória, conexões e banda. O operador pode interromper a participação a qualquer momento. A política de contribuição deve ser transparente, auditável e resistente a manipulação por identidades múltiplas. A versão inicial deve priorizar limites locais seguros e medição verificável antes de introduzir créditos, tokens ou punições econômicas.

## 11. Recuperação e reparação

Ao detectar fragmento indisponível, o coordenador procura provedores alternativos na DHT. Se houver pelo menos k fragmentos válidos, reconstrói-se o objeto ou um conjunto de fragmentos de substituição e publica-se novos anúncios. A reparação deve ser idempotente, limitada por orçamento, protegida contra loops e confirmada por verificações de integridade.

A localização DHT de um provedor não comprova durabilidade. Recibos assinados registram uma declaração em determinado momento, mas não demonstram armazenamento futuro contínuo. Auditorias periódicas e redundância diversificada são necessárias.

## 12. Versionamento e interoperabilidade

Todas as mensagens e manifestos devem conter versão explícita. Mudanças incompatíveis exigem nova versão de protocolo e estratégia de migração. Implementações devem rejeitar campos obrigatórios desconhecidos quando isso comprometer segurança, limitar extensões e manter vetores de teste públicos. O protocolo deve documentar comportamento de timeout, erros, retry, cancelamento, quotas e estados de conexão.

## 13. Plano de implementação

**Fase A — base segura:** identidade persistente, armazenamento de chaves, formatos de manifesto e fragmento, cifragem autenticada, hashes, quotas e testes de fuzzing.

**Fase B — rede de laboratório:** integração real com versões fixadas de libp2p/Kademlia, QUIC, nós bootstrap independentes, descoberta e transferência entre processos separados.

**Fase C — resiliência:** Reed–Solomon validado por vetores de teste, colocação por domínios de falha, reparação após churn e testes de interrupção.

**Fase D — antiabuso:** provas de armazenamento com modelo de segurança documentado, rate limits, diversidade, tratamento de falsos positivos e testes Sybil/eclipse.

**Fase E — piloto controlado:** auditoria externa, benchmark reproduzível, observabilidade sem dados sensíveis, política de incidentes e documentação de operadores.

A passagem de fase exige testes automatizados e evidências reproduzíveis. Testes simulados não contam como comprovação de interoperabilidade de rede real.

## 14. Estado verificado versus objetivos

O código de referência v0.31.0 é um protótipo experimental. Há módulos de catálogo, coordenação de réplicas, governança de recursos, segurança de mensagens e um adaptador de descoberta, com testes locais. Isso não equivale a uma DHT libp2p operacional, rede global, NAT traversal completo, Reed–Solomon de produção ou prova contínua de armazenamento. Esses itens devem ser marcados como pendentes até que dependências reais estejam integradas e testes multi-processo independentes sejam aprovados.

O repositório também não deve ser divulgado como pronto para produção enquanto persistirem lacunas de segurança, auditoria e licença de distribuição.

## 15. Critérios mínimos antes de produção

- Testes reais com pelo menos três nós em processos independentes e redes distintas.
- Busca DHT e recuperação de fragmentos sem servidor central de catálogo.
- Testes de NAT/CGNAT e fallback relay com limites de custo.
- Vetores independentes de teste para cifragem, hashing e erasure coding.
- Testes de churn, corrupção, replay, flooding, eclipse e Sybil.
- Persistência, backup, rotação e revogação de chaves documentados.
- Benchmark reproduzível de CPU, RAM, disco, banda e latência.
- Auditoria externa e licença completa confirmada antes de distribuição pública.

## Referências técnicas primárias

- libp2p: https://libp2p.io/
- Documentação de conceitos libp2p: https://docs.libp2p.io/concepts/
- QUIC (RFC 9000): https://www.rfc-editor.org/rfc/rfc9000
- STUN (RFC 8489): https://www.rfc-editor.org/rfc/rfc8489
- ICE (RFC 8445): https://www.rfc-editor.org/rfc/rfc8445
- TURN (RFC 8656): https://www.rfc-editor.org/rfc/rfc8656
- Reed–Solomon, visão geral: https://en.wikipedia.org/wiki/Reed%E2%80%93Solomon_error_correction (referência introdutória; especificação final deve fixar uma implementação e seus vetores de teste).

---

**Aviso de status:** este documento especifica objetivos e requisitos de projeto. Não certifica que o software atual os implemente, nem constitui garantia de disponibilidade, segurança ou desempenho.


## Admission cost, gossip, and bandwidth policy

The reference tree now includes experimental building blocks for a public-key-bound proof-of-work admission puzzle, bounded gossip hints, and adaptive application-level bandwidth budgets. These do not yet constitute a production network: proof difficulty must be calibrated and governed network-wide; gossip events require authenticated origins; and bandwidth budgets must be enforced by a verified transport/OS adapter. A fixed 1–2 minute proof target is not portable across hardware. The DHT and gossip layers are discovery hints, not proof of durable storage or global consensus.


## Pausa por inatividade e capacidade de armazenamento adaptativa

A política de participação deve reduzir consumo quando o computador não está sendo utilizado, sem confundir inatividade do usuário com autorização para apagar dados. O controlador experimental `src/idle-participation-controller.js` solicita pausa após um intervalo configurado sem atividade, aguarda a conclusão de operações em andamento e exige hooks do runtime para interromper novas admissões e desconectar o transporte. Telemetria ausente ou inconsistente bloqueia a participação. O armazenamento local deve permanecer intacto durante a pausa.

A capacidade de armazenamento anunciada também pode variar segundo a contribuição verificada. O controlador experimental `src/adaptive-storage-capacity.js` limita a admissão de novas réplicas por degraus de contribuição e, quando a telemetria é inválida, desativa novas admissões. Uma redução de capacidade nunca deve provocar exclusão automática de réplicas existentes: se o uso atual superar o novo limite, o nó preserva os dados e recusa novas réplicas únicas até que haja espaço ou uma migração/reparação segura.

**Limite de implementação:** estes controladores e seus testes são building blocks, não prova de integração com todos os transportes, anúncios de provedores, supervisores de nuvem ou runtime oficial. Antes de declarar o comportamento completo, é necessário conectar os hooks reais do nó e verificar a pausa e retomada ponta a ponta. Consulte `docs/IDLE_AND_ADAPTIVE_CAPACITY.md` para os degraus iniciais e os critérios de validação.
