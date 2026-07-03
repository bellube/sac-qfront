/**
 * Cliente do Sankhya API Gateway (api.sankhya.com.br) — consulta read-only de Parceiro/Pedido/Título
 * para enriquecer tickets do SAC (QFront) com dados reais do ERP.
 *
 * Autenticação: OAuth2 client_credentials + X-Token (fluxo oficial documentado em
 * https://developer.sankhya.com.br/reference/post_authenticate.md).
 *
 * IMPORTANTE — limitação conhecida (validada ao vivo em 2026-07-03):
 *   - DbExplorerSP.executeQuery: funciona para leitura (SELECT), mas é BLOQUEADO por
 *     segurança para INSERT/UPDATE/DELETE (erro CORE_E03690 — "Permitido apenas a
 *     execução de consultas").
 *   - CRUDServiceProvider.loadRecords/saveRecord: retorna "Erro interno (NPE)" para
 *     QUALQUER entidade (mesmo "Parceiro", que é uma entidade padrão sempre mapeada) —
 *     não é um problema específico da tabela AD_ATENDIMENTOOS, é que o serviço não está
 *     disponível para esta credencial. Hipótese TSIUSU.OPTGAT='N' testada (habilitado
 *     'S' no usuário 167 com autorização, token novo gerado) e DESCARTADA — mesmo erro
 *     persistiu; revertido para 'N'. Causa real ainda desconhecida (possível allowlist de
 *     serviceName por app registrada, ou módulo/licença a nível de instância). Precisa de
 *     suporte Sankhya para habilitar antes de a Fase 2 (gravação de parecer) funcionar.
 *
 * Portanto este módulo cobre SOMENTE consultas (Fase 1). Ver docs/INTEGRACAO_SANKHYA.md.
 */
const axios = require('axios');
require('dotenv').config();

const C = {
  base: process.env.SANKHYA_GW_BASE || 'https://api.sankhya.com.br',
  clientId: process.env.SANKHYA_GW_CLIENT_ID,
  clientSecret: process.env.SANKHYA_GW_CLIENT_SECRET,
  xToken: process.env.SANKHYA_GW_TOKEN, // "Token de Integração" (tela Configurações Gateway no Sankhya)
};

let tok = null, exp = 0;
async function gwToken() {
  if (tok && Date.now() < exp - 15000) return tok; // cache; renova 15s antes de expirar (expires_in costuma ser 300s)
  const body = new URLSearchParams({ client_id: C.clientId, client_secret: C.clientSecret, grant_type: 'client_credentials' });
  const r = await axios.post(`${C.base}/authenticate`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Token': C.xToken },
  });
  tok = r.data.access_token;
  exp = Date.now() + (r.data.expires_in || 300) * 1000;
  return tok;
}

// executa uma consulta SQL somente-leitura (SELECT) via DbExplorerSP.executeQuery
async function query(sql) {
  const t = await gwToken();
  const r = await axios.post(
    `${C.base}/gateway/v1/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
    { serviceName: 'DbExplorerSP.executeQuery', requestBody: { sql } },
    { headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } }
  );
  const d = r.data;
  if (d.status !== '1') throw new Error(`Sankhya GW erro: ${d.statusMessage || JSON.stringify(d.tsError || d)}`);
  const cols = (d.responseBody.fieldsMetadata || []).map(f => f.name);
  return (d.responseBody.rows || []).map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

const esc = s => String(s).replace(/'/g, "''"); // escapa aspas simples p/ evitar quebra de SQL (uso interno, sem input direto de usuário externo sem sanitização)

// Parceiro por Cód. Parceiro ou CNPJ (limpo de máscara)
async function lookupParceiro({ codParc, cnpj }) {
  let where;
  if (codParc) where = `CODPARC = ${parseInt(codParc, 10)}`;
  else if (cnpj) where = `REPLACE(REPLACE(REPLACE(CGC_CPF,'.',''),'/',''),'-','') = '${esc(cnpj.replace(/\D/g, ''))}'`;
  else throw new Error('lookupParceiro: informe codParc ou cnpj');
  const rows = await query(
    `SELECT TOP 1 CODPARC, NOMEPARC, RAZAOSOCIAL, CGC_CPF, EMAIL, CODVEND, LIMCRED, CLIENTE, FORNECEDOR, ATIVO
     FROM TGFPAR WHERE ${where}`
  );
  return rows[0] || null;
}

// Pedido/Nota por NUNOTA
async function lookupPedido({ nunota }) {
  const rows = await query(
    `SELECT TOP 1 NUNOTA, NUMNOTA, CODPARC, CODEMP, CODTIPOPER, DTNEG, VLRNOTA, STATUSNOTA
     FROM TGFCAB WHERE NUNOTA = ${parseInt(nunota, 10)}`
  );
  return rows[0] || null;
}

// Título/boleto: por NUNOTA (todos os títulos da nota) ou por número do documento (NUMNOTA/NF na TGFCAB associada)
async function lookupTitulos({ nunota, codParc }) {
  if (nunota) {
    return query(
      `SELECT NUFIN, NUNOTA, CODPARC, DTVENC, DTVENCORIG, VLRDESDOB, RECDESP, DHBAIXA
       FROM TGFFIN WHERE NUNOTA = ${parseInt(nunota, 10)} ORDER BY DTVENC`
    );
  }
  if (codParc) {
    return query(
      `SELECT TOP 20 NUFIN, NUNOTA, CODPARC, DTVENC, DTVENCORIG, VLRDESDOB, RECDESP, DHBAIXA
       FROM TGFFIN WHERE CODPARC = ${parseInt(codParc, 10)} AND DHBAIXA IS NULL ORDER BY DTVENC`
    );
  }
  throw new Error('lookupTitulos: informe nunota ou codParc');
}

/**
 * FASE 2 (NÃO FUNCIONAL AINDA — ver aviso no topo do arquivo).
 * Mantido aqui para quando a permissão de escrita for habilitada no Sankhya.
 * Tenta gravar via CRUDServiceProvider.saveRecord; hoje retorna erro (NPE) sempre.
 */
async function gravarParecer({ nunota, codusu, parecer, finalizarOs }) {
  const t = await gwToken();
  const seqRows = await query(`SELECT ISNULL(MAX(SEQUENCIA),0)+1 AS PROXSEQ FROM AD_ATENDIMENTOOS WHERE NUNOTA=${parseInt(nunota, 10)}`);
  const seq = seqRows[0].PROXSEQ;
  const field = [
    { name: 'NUNOTA', $: String(nunota) },
    { name: 'SEQUENCIA', $: String(seq) },
    { name: 'CODUSU', $: String(codusu) },
    { name: 'DATA', $: new Date().toLocaleDateString('pt-BR').replace(/\//g, '') },
    { name: 'PARECER', $: parecer },
  ];
  if (finalizarOs) field.push({ name: 'FINALIZAROS', $: finalizarOs });
  const r = await axios.post(
    `${C.base}/gateway/v1/mge/service.sbr?serviceName=CRUDServiceProvider.saveRecord&outputType=json`,
    { serviceName: 'CRUDServiceProvider.saveRecord', requestBody: { entity: { name: 'AD_ATENDIMENTOOS', fieldset: { list: 'NUNOTA,SEQUENCIA,CODUSU,DATA,PARECER,FINALIZAROS' }, field } } },
    { headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } }
  );
  if (r.data.status !== '1') throw new Error(`gravarParecer falhou (esperado até habilitar CRUDServiceProvider no Sankhya): ${r.data.statusMessage}`);
  return r.data;
}

module.exports = { query, lookupParceiro, lookupPedido, lookupTitulos, gravarParecer };
