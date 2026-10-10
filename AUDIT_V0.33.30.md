# Zion v0.33.30 — Persistent Witness Replay Protection

## Escopo

Continuação local da v0.33.29. Esta versão fortalece o mecanismo de recuperação de temporários; não altera nem declara integração ativa com uma instância de produção do Witness.

## Alterações

- Recuperação serializada entre processos por meio de `.witness-recovery.lock`, criado exclusivamente; espera limitada e tentativa de remoção somente quando o PID registrado não existe mais.
- Ledger durável `.witness-replay-ledger.json`, gravado por arquivo temporário, `fsync`, rename e sincronização do diretório.
- Reserva de nonce persistida antes do commit. O mesmo `metadataId` pode retomar a operação após crash; um registro diferente não pode reutilizar a combinação publisher/nonce.
- O ledger corrompido bloqueia a recuperação antes da promoção de qualquer temporário.
- Recuperação do intervalo de crash após o hard-link do destino e antes da limpeza do staging, desde que o destino coincida em tamanho/hash com a operação reservada.
- Auditoria JSONL continua sendo sincronizada; destino final nunca é sobrescrito.

## Verificações executadas

- `npm test`: **531 aprovados, 0 falhas**.
- `npm run check`: sintaxe aprovada para 166 arquivos JavaScript.
- `npm run demo`: exit code 0.
- `npm run client:demo`: exit code 0; 7 chunks, 52 bytes de plaintext, adaptador armazena somente ciphertext.
- `unzip -t`: integridade do ZIP verificada após empacotamento.

## Limites e operação

- O ledger deve ser protegido, respaldado e mantido no mesmo domínio confiável dos dados; não se deve apagá-lo ou reconstruí-lo permissivamente. Ledger corrompido exige procedimento administrativo auditado.
- A autoridade de sessão continua sendo callback do integrador. Produção deve conectá-la ao estado de revogação e à autoridade real do Witness.
- O lock coordena instâncias que compartilham o mesmo filesystem local e respeitam a semântica de criação exclusiva. Não é um lock distribuído para filesystems remotos com semântica incerta.
- `fsync` e testes com `SIGKILL` não provam durabilidade contra perda elétrica ou hardware defeituoso.
- Não foram realizados deploy, publicação GitHub nem integração com um Witness de produção.
