# Integração SAC/QFront ↔ Sankhya (via API Gateway)

Consulta em tempo real de Parceiro, Pedido/Nota e Título/Boleto para enriquecer os tickets do SAC com dados reais do ERP. Cliente em `integration/sankhya-gateway/sankhya-gateway.js`.

## Status (validado ao vivo em 2026-07-03)

| Capacidade | Status | Como |
|---|---|---|
| Consulta de Parceiro (Cód./CNPJ) | ✅ **Funcional** | `DbExplorerSP.executeQuery` (SELECT) |
| Consulta de Pedido/Nota (NUNOTA) | ✅ **Funcional** | idem |
| Consulta de Títulos/Boletos | ✅ **Funcional** | idem |
| Gravação de parecer em `AD_ATENDIMENTOOS` | ❌ **Bloqueado** (ver §3) | `CRUDServiceProvider.saveRecord` — não disponível nesta instância |

## 1. Autenticação — Sankhya API Gateway

Fluxo oficial OAuth2 client_credentials + header `X-Token` ([doc oficial](https://developer.sankhya.com.br/reference/post_authenticate.md)):

```
POST https://api.sankhya.com.br/authenticate
Content-Type: application/x-www-form-urlencoded
X-Token: <Token de Integração>

client_id=<Client ID>&client_secret=<Client Secret>&grant_type=client_credentials
```

Retorna `access_token` (JWT, expira em ~300s) usado como `Authorization: Bearer <token>` nas chamadas seguintes.

**Onde pegar as credenciais:**
- **Token de Integração**: dentro do Sankhya → *Configurações Gateway* (`system.jsp`) → aba do app vinculado → campo "Token de Integração".
- **Client ID / Client Secret**: [areadev.sankhya.com.br](https://areadev.sankhya.com.br) → *Minhas soluções* → componente do addon → seção *Produção* (ou *Sandbox* para testes).

> ⚠️ Reaproveitamos, por decisão do usuário (2026-07-03), a credencial já registrada para o addon **Addon-Fastchannel-APISANKYA**. Isso funciona, mas mistura o rastro de auditoria dos dois sistemas na mesma identidade de API do Sankhya — considerar provisionar um app dedicado (`Addon-SAC-QFront`) no futuro.

## 2. Consulta de dados (funcional)

Todas as consultas usam `DbExplorerSP.executeQuery` (SQL direto, somente `SELECT`):

```
POST https://api.sankhya.com.br/gateway/v1/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json
Authorization: Bearer <token>

{"serviceName":"DbExplorerSP.executeQuery","requestBody":{"sql":"SELECT ..."}}
```

Funções prontas em `sankhya-gateway.js`:
- `lookupParceiro({ codParc | cnpj })` → `TGFPAR` (nome, razão social, CNPJ, e-mail, vendedor, limite de crédito, status)
- `lookupPedido({ nunota })` → `TGFCAB` (número, empresa, tipo de operação, data, valor, status)
- `lookupTitulos({ nunota | codParc })` → `TGFFIN` (vencimento, valor, se está pago — `DHBAIXA`)

## 3. Por que a gravação de parecer NÃO funciona (ainda)

Testado ao vivo contra produção (2026-07-03), com autorização do usuário:

1. **`DbExplorerSP.executeQuery` com INSERT** → bloqueado por design: `CORE_E03690` — *"Permitido apenas a execução de consultas, a instrução possui 'UPDATE', 'DELETE' ou 'INSERT' e tais comandos não são permitidos."* Este serviço é somente-leitura por segurança, sem exceção.
2. **`CRUDServiceProvider.saveRecord`** (o caminho correto para escrita) → retorna **`Erro interno (NPE)`** consistentemente, inclusive para a entidade padrão **`Parceiro`** (não é problema específico da tabela `AD_ATENDIMENTOOS`). `CRUDServiceProvider.loadRecords` também dá o mesmo erro.
3. **Hipótese testada e descartada**: `TSIUSU.OPTGAT='N'` em todos os 409 usuários parecia suspeito. Com autorização, habilitei `OPTGAT='S'` só no usuário 167 e testei de novo com token novo — **mesmo erro NPE**. Revertido para `N` (mudança sem efeito não deve ficar em produção). **`OPTGAT` não é o gate real.**

**Hipóteses ainda não testadas:**
- Módulo/licença do `CRUDServiceProvider` via Gateway pode precisar de habilitação a nível de **instância/tenant** (não de usuário) — verificar com suporte Sankhya.
- Pode existir um allowlist de `serviceName` por **aplicação registrada** no Sankhya (`Addon-Fastchannel-APISANKYA`) — a tela "Configurações Gateway" pode ter um campo de "serviços permitidos" não visível via SQL. Vale inspecionar a UI com atenção, ou abrir chamado com a Sankhya citando o erro NPE consistente em `CRUDServiceProvider` via Gateway.

**Código já pronto para quando for habilitado:** função `gravarParecer({ nunota, codusu, parecer, finalizarOs })` em `sankhya-gateway.js`, escrevendo em `AD_ATENDIMENTOOS` (colunas confirmadas: `NUNOTA, SEQUENCIA, CODUSU, DATA, PARECER, FINALIZAROS, RESPFALHA`).

## 4. Como plugar no `email-bridge.js`

O módulo é standalone; para enriquecer os tickets automaticamente, adicione no `email-bridge.js`:

```js
const sankhya = require('../sankhya-gateway/sankhya-gateway');

// dentro de applyExtractedFields() ou logo após extractFields(), quando cod_parceiro/cnpj for detectado:
async function enrichFromSankhya(convId, fields) {
  const upd = {};
  try {
    if (fields.cod_parceiro || fields.cnpj) {
      const p = await sankhya.lookupParceiro({ codParc: fields.cod_parceiro, cnpj: fields.cnpj });
      if (p) { upd.parceiro_nome = p.NOMEPARC; upd.parceiro_vendedor = String(p.CODVEND || ''); }
    }
    if (fields.pedido_nunota) {
      const ped = await sankhya.lookupPedido({ nunota: fields.pedido_nunota });
      if (ped) upd.pedido_status = String(ped.STATUSNOTA || '');
    }
    if (Object.keys(upd).length) await qf('POST', `/conversations/${convId}/custom_attributes`, { custom_attributes: upd });
  } catch (e) { log('WARN sankhya enrich', convId, e.message); } // nunca bloqueia o fluxo principal do ticket
}
```

> Cria os campos personalizados `parceiro_nome`, `parceiro_vendedor`, `pedido_status` no QFront antes de usar (Configurações → Atributos personalizados → Conversa).

## 5. Variáveis de ambiente

Ver `integration/sankhya-gateway/.env.example`. Mesmo padrão do `email-bridge`: nunca commitar o `.env` real.
