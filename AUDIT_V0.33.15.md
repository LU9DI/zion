# Zion v0.33.15 — TLS expiry regression audit

## Escopo

Esta versão adiciona um teste de integração HTTPS que usa um certificado de servidor `localhost` deliberadamente expirado, assinado por uma CA de teste confiável. O teste comprova que confiar na CA emissora não desabilita a validação de validade temporal do certificado.

O certificado expirado, sua chave privada e a CA são fixtures exclusivas de teste. **Nunca use essas chaves em produção.**

## Verificações executadas

Ambiente de validação: Node.js v22.16.0; OpenSSL 3.5.5 disponível durante a preparação da fixture.

- `node --test test/remote-witness-tls-handshake.test.js`: 4 testes aprovados, 0 falhas.
- `npm test`: 466 testes aprovados, 0 falhas.
- `npm run check`: sintaxe aprovada para 142 arquivos JavaScript.
- `npm run demo`: código de saída 0.
- `unzip -t`: integridade do arquivo ZIP verificada.
- `sha256sum -c`: checksum do pacote verificado.

## Cobertura TLS

1. Certificado confiável e hostname correspondente: handshake HTTPS bem-sucedido.
2. Certificado confiável com hostname incorreto: conexão rejeitada.
3. Certificado emitido por CA não confiável: conexão rejeitada.
4. Certificado expirado assinado por CA confiável: conexão rejeitada.

## Limitações

- A cobertura testa o comportamento do cliente HTTPS do Node.js com servidor local; não demonstra a configuração TLS de uma implantação pública.
- Não comprova revogação OCSP/CRL, rotação de certificados em produção, políticas de proxy ou terminação TLS em infraestrutura externa.
- Testes locais não provam durabilidade contra falhas físicas, nem a semântica de sistemas de arquivos distribuídos.
- Nenhuma publicação no GitHub ou implantação em produção foi realizada por esta tarefa.

## Reproduzir

```sh
node --test test/remote-witness-tls-handshake.test.js
npm test
npm run check
npm run demo
```
