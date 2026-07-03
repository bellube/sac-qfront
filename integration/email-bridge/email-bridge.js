/**
 * Bridge de E-MAIL sac@bellube.com.br (Microsoft 365) ⇄ QFront/Chatwoot, via Microsoft Graph (OAuth2 app-only).
 * Resolve o bloqueio de IMAP basic-auth do M365 — Graph usa OAuth2 (moderno, não bloqueado).
 *
 * Modos:
 *   node email-bridge.js import   -> importa TODO o histórico (todas as pastas em GRAPH_FOLDERS) p/ a caixa de histórico.
 *   node email-bridge.js          -> roda contínuo: inbound (novos e-mails -> QFront) + outbound (resposta do agente -> e-mail como sac@, com whitelist).
 *
 * App Registration (Entra) precisa de Application permissions: Mail.Read, Mail.ReadWrite, Mail.Send (+ admin consent).
 */
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const sankhya = require('../sankhya-gateway/sankhya-gateway');
require('dotenv').config();
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const C = {
  tenant: process.env.MS_TENANT_ID, clientId: process.env.MS_CLIENT_ID, secret: process.env.MS_CLIENT_SECRET,
  mailbox: process.env.MS_MAILBOX || 'sac@bellube.com.br',
  graphFolders: list(process.env.GRAPH_FOLDERS || 'Inbox'),
  qfBase: process.env.QFRONT_BASE, qfAccess: process.env.QFRONT_ACCESS_TOKEN, qfClient: process.env.QFRONT_CLIENT, qfUid: process.env.QFRONT_UID,
  qfInbox: parseInt(process.env.QFRONT_INBOX_ID || '0'),         // caixa do canal sac@ (inbound + outbound)
  qfHistInbox: parseInt(process.env.QFRONT_HIST_INBOX_ID || process.env.QFRONT_INBOX_ID || '0'),
  triageTeam: parseInt(process.env.TRIAGE_TEAM_ID || '1'),        // time p/ triagem automatica INSTANTANEA (1 = triagem/gestao)
  autoAck: (process.env.AUTO_ACK || 'true') === 'true',           // auto-resposta de confirmacao ao cliente com protocolo
  pollMs: parseInt(process.env.POLL_MS || '20000'),
  outbound: (process.env.OUTBOUND_ENABLED || 'false') === 'true',
  whitelist: list(process.env.OUTBOUND_WHITELIST),               // e-mails permitidos p/ envio (vazio=nenhum; '*'=todos)
};
const STATE = './email-state.json';
let st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : { lastReceived: null, sessions: {}, sentOut: {}, seen: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(st));
const log = (...a) => console.log(new Date().toISOString(), ...a);

let tok = null, exp = 0;
async function graphToken() {
  if (tok && Date.now() < exp - 60000) return tok;
  const body = new URLSearchParams({ client_id: C.clientId, client_secret: C.secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
  const r = await axios.post(`https://login.microsoftonline.com/${C.tenant}/oauth2/v2.0/token`, body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  tok = r.data.access_token; exp = Date.now() + (r.data.expires_in || 3600) * 1000; log('Graph token OK'); return tok;
}
const graph = async (method, url, data) => { const t = await graphToken(); return (await axios({ method, url: url.startsWith('http') ? url : 'https://graph.microsoft.com/v1.0' + url, data, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } })).data; };
const qf = async (m, p, b) => (await axios({ method: m, url: C.qfBase + p, data: b, headers: { 'access-token': C.qfAccess, client: C.qfClient, uid: C.qfUid, 'token-type': 'Bearer', 'Content-Type': 'application/json' } })).data;

async function ensureContact(name, email) {
  if (email) { const s = await qf('GET', `/contacts/search?q=${encodeURIComponent(email)}`); const c = (s.payload || []).find(x => (x.email || '').toLowerCase() === email.toLowerCase()); if (c) return c.id; }
  return (await qf('POST', '/contacts', { name: name || email || 'Desconhecido', email: email || undefined, identifier: 'mail-' + (email || Math.random().toString(36).slice(2)) })).payload.contact.id;
}
// classifica motivo (label) por palavra-chave do assunto+corpo; sempre adiciona origem (cliente/colaborador)
function classifyLabels(subject, body, fromAddr) {
  const t = (subject + ' ' + body).toLowerCase();
  const has = (...ws) => ws.some(w => t.includes(w));
  const out = [fromAddr.endsWith('@bellube.com.br') ? 'aberto-colaborador' : 'aberto-cliente'];
  if (has('boleto') && has('atualiz', 'vencid', 'vencimento')) out.push('fin-atualizacao-boleto');
  else if (has('boleto', 'segunda via', '2 via', '2a via', 'reemiss')) out.push('fin-reemissao-boleto-nf');
  if (has('nota fiscal', 'nf-e', 'nfe', 'danfe', 'xml da nota')) out.push('fin-nota-fiscal');
  if (has('cadastro', 'dados cadastrais', 'atualizar dados', 'alterar dados')) out.push('fin-cadastro');
  if (has('suspender', 'suspensao') && has('cobranca', 'cobrança')) out.push('fin-suspender-cobranca');
  if (has('cotacao', 'cotação', 'orcamento', 'orçamento', 'tabela de preco', 'tabela de preço')) out.push('comercial-cotacao');
  if (has('avaria', 'avariado', 'danificad', 'quebrad', 'vazou', 'vazamento', 'violad')) out.push('log-avaria');
  if (has('cancelar', 'cancelamento') && has('nota', ' nf', 'pedido')) out.push('log-cancelamento-nf');
  if (has('devolucao', 'devolução', 'devolver', 'devolvid')) out.push('log-devolucao');
  if (has('arquivo edi', 'edi bancario', 'ocorrencia edi', 'retorno edi')) out.push('log-edi-ocorrencia');
  if (has('granel')) out.push('log-manutencao-granel');
  if (has('brinde')) out.push('mkt-brinde');
  if (has('patrocinio', 'patrocínio', 'verba de marketing', 'investimento de marketing')) out.push('mkt-investimento');
  if (has('desconto')) out.push('os-desconto');
  if (has('ferias', 'férias', 'folga')) out.push('rh-folga-ferias');
  if (has('atestado', 'ausencia', 'ausência')) out.push('rh-consulta-ausencia');
  if (has('inflamavel', 'inflamáveis', 'inflamaveis')) out.push('area-inflaveis');
  if (has('motoroil', 'motor oil', 'oleo de motor', 'óleo de motor')) out.push('area-motoroil');
  if (has('pelo site', 'no site', 'website', 'portal do cliente')) out.push('area-site');
  return [...new Set(out)];
}
// motivo (label) -> time de destino (ordem dos labels = prioridade). Sem motivo claro -> triagem/gestao.
// times: 1=triagem/gestao 2=financeiro 3=faturamento 4=logistica 5=cadastro 6=marketing 7=rh 8=comercial/vendas
const TEAM_BY_LABEL = {
  'fin-atualizacao-boleto': 2, 'fin-reemissao-boleto-nf': 2, 'fin-suspender-cobranca': 2,
  'fin-nota-fiscal': 3,
  'fin-cadastro': 5,
  'log-avaria': 4, 'log-cancelamento-nf': 4, 'log-devolucao': 4, 'log-edi-ocorrencia': 4, 'log-manutencao-granel': 4,
  'mkt-brinde': 6, 'mkt-investimento': 6,
  'rh-folga-ferias': 7, 'rh-consulta-ausencia': 7,
  'comercial-cotacao': 8, 'os-desconto': 8,
};
function teamForLabels(labels) {
  for (const l of labels) if (TEAM_BY_LABEL[l]) return TEAM_BY_LABEL[l];
  return C.triageTeam;
}
// auto-resposta de confirmacao ao cliente com protocolo (guardas anti-loop: nunca p/ sac@/no-reply; rate-limit 1x/4h por endereco)
async function maybeAck(to, subject, protocolo, convId) {
  if (!C.autoAck || !to) return;
  if (to === C.mailbox.toLowerCase() || /no-?reply|noreply|mailer-daemon|postmaster|do-?not-?reply/i.test(to)) return;
  st.ackedAddr = st.ackedAddr || {};
  const now = Date.now();
  if (st.ackedAddr[to] && now - st.ackedAddr[to] < 4 * 3600 * 1000) return;
  const body = `Ola,\n\nRecebemos o seu contato no SAC da Bel Lube. Seu atendimento foi registrado sob o protocolo ${protocolo}.\n\nNossa equipe ira analisar e retornar o mais breve possivel; por favor mantenha este protocolo como referencia.\n\nEsta e uma confirmacao automatica - nao e necessario responder a este e-mail.\n\nAtenciosamente,\nSAC Bel Lube`;
  try {
    await graph('POST', `/users/${C.mailbox}/sendMail`, { message: { subject: subjectWithProtocolo(protocolo, subject, true), body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true });
    st.ackedAddr[to] = now; save();
    try { await qf('POST', `/conversations/${convId}/messages`, { content: `🔖 ${protocolo} — confirmacao automatica de recebimento enviada a ${to}.`, private: true }); } catch (e) {}
    log('ACK', to, protocolo);
  } catch (e) { log('WARN ack', convId, e.response ? e.response.status : e.message); }
}
// busca anexos do e-mail no Graph (fileAttachment com bytes); pula icones inline minusculos (assinatura) e arquivos > 25MB
async function graphAttachments(msgId) {
  try {
    const d = await graph('GET', `/users/${C.mailbox}/messages/${msgId}/attachments`);
    return (d.value || []).filter(a => a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes
      && (a.size || 0) <= 25 * 1024 * 1024 && (!a.isInline || (a.size || 0) >= 5120));
  } catch (e) { log('WARN attachments', msgId, e.response ? e.response.status : e.message); return []; }
}
// monta o envelope de e-mail (content_attributes) p/ o QFront renderizar como E-MAIL (nao chat)
function buildEmailEnvelope(msg, from, htmlFull, textFull, nAtt) {
  const addr = r => ((r && r.emailAddress && r.emailAddress.address) || '').toLowerCase();
  const to = (msg.toRecipients || []).map(addr).filter(Boolean);
  const cc = (msg.ccRecipients || []).map(addr).filter(Boolean);
  return {
    email: {
      from: [(from.address || '').toLowerCase()].filter(Boolean),
      to, cc, bcc: null, subject: msg.subject || '(sem assunto)', date: msg.receivedDateTime || null,
      message_id: msg.internetMessageId || msg.id, content_type: 'text/html', multipart: nAtt > 0,
      number_of_attachments: nAtt,
      html_content: { full: htmlFull, reply: textFull, quoted: textFull },
      text_content: { full: textFull, reply: textFull, quoted: textFull },
      in_reply_to: null, references: [], headers: null, auto_reply: false,
    },
    cc_email: cc.length ? cc.join(', ') : null,
    bcc_email: null,
  };
}
// posta mensagem como incoming_email (renderiza como e-mail); multipart se houver anexos, senao JSON
async function qfPostMessage(convId, content, env, atts) {
  const srcId = (env && env.email && env.email.message_id) || undefined;
  if (!atts || !atts.length) return qf('POST', `/conversations/${convId}/messages`, { content, message_type: 'incoming', content_type: 'incoming_email', source_id: srcId, content_attributes: env });
  const fd = new FormData();
  fd.append('content', content || '');
  fd.append('message_type', 'incoming');
  fd.append('content_type', 'incoming_email');
  if (srcId) fd.append('source_id', srcId);
  fd.append('content_attributes', JSON.stringify(env));
  for (const a of atts) fd.append('attachments[]', Buffer.from(a.contentBytes, 'base64'), { filename: a.name || 'arquivo', contentType: a.contentType || 'application/octet-stream' });
  return (await axios.post(C.qfBase + `/conversations/${convId}/messages`, fd, {
    headers: { ...fd.getHeaders(), 'access-token': C.qfAccess, client: C.qfClient, uid: C.qfUid, 'token-type': 'Bearer' },
    maxContentLength: Infinity, maxBodyLength: Infinity,
  })).data;
}
// extrai campos personalizados do texto do e-mail (CNPJ, NF, Pedido/NUNOTA, Cód Parceiro)
function extractFields(text) {
  const t = text || '';
  const out = {};
  const cnpj = t.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/);
  if (cnpj) out.cnpj = cnpj[0];
  const nf = t.match(/\b(?:nota\s*fiscal|nf-?e|danfe|nf)\b[^\d]{0,8}(\d{3,12})/i);
  if (nf) out.nota_fiscal = nf[1];
  const ped = t.match(/\b(?:pedido|nunota)\b[^\d]{0,8}(\d{3,12})/i);
  if (ped) out.pedido_nunota = ped[1];
  const cod = t.match(/\bc[oó]d(?:igo)?\.?\s*parc(?:eiro)?\b[^\d]{0,6}(\d{2,8})/i);
  if (cod) out.cod_parceiro = cod[1];
  return out;
}
// preenche os campos personalizados VAZIOS com o que extraiu (mantem o que ja existe / foi preenchido pelo agente)
async function applyExtractedFields(convId, text, currentAttrs) {
  const ext = extractFields(text); const upd = {};
  for (const k of Object.keys(ext)) { const cur = currentAttrs ? currentAttrs[k] : null; if (cur === undefined || cur === null || String(cur).trim() === '' || cur === '---') upd[k] = ext[k]; }
  if (Object.keys(upd).length) { try { await qf('POST', `/conversations/${convId}/custom_attributes`, { custom_attributes: upd }); log('CAMPOS', convId, JSON.stringify(upd)); } catch (e) { log('WARN campos', convId, e.message); } }
}
// consulta o Sankhya (Parceiro/Pedido) e preenche parceiro_nome/parceiro_vendedor/pedido_status; nunca bloqueia o fluxo do ticket
async function enrichFromSankhya(convId, fields) {
  const upd = {};
  try {
    if (fields.cod_parceiro || fields.cnpj) {
      const p = await sankhya.lookupParceiro({ codParc: fields.cod_parceiro, cnpj: fields.cnpj });
      if (p) { upd.parceiro_nome = p.NOMEPARC || ''; upd.parceiro_vendedor = String(p.CODVEND || ''); }
    }
    if (fields.pedido_nunota) {
      const ped = await sankhya.lookupPedido({ nunota: fields.pedido_nunota });
      if (ped) upd.pedido_status = String(ped.STATUSNOTA || '');
    }
    if (Object.keys(upd).length) { await qf('POST', `/conversations/${convId}/custom_attributes`, { custom_attributes: upd }); log('SANKHYA', convId, JSON.stringify(upd)); }
  } catch (e) { log('WARN sankhya', convId, e.message); }
}
// monta o assunto com o protocolo NO INICIO (bem visivel), sem duplicar prefixos
function subjectWithProtocolo(protocolo, subject, isReply) {
  let s = (subject || '').replace(/\[SAC-\d+\]/gi, '').replace(/^\s*((re|res|enc|fwd|fw)\s*:\s*)+/i, '').trim();
  if (!s) s = 'Atendimento SAC';
  return `[${protocolo}]${isReply ? ' Re:' : ''} ${s}`;
}
const titleTeam = name => (name || '').replace(/\b\w/g, c => c.toUpperCase());
// acha conversa existente pelo protocolo SAC-00XXXX no assunto (resposta a ticket) -> mantem o historico na mesma conversa
async function findExistingConv(subject) {
  const mm = (subject || '').match(/SAC-(\d{4,7})/i);
  if (!mm) return null;
  const id = parseInt(mm[1], 10);
  if (!id) return null;
  try {
    const c = await qf('GET', `/conversations/${id}`);
    const o = c.payload || c;
    if (o && o.id === id && o.inbox_id === C.qfInbox) return { id, status: o.status, attrs: o.custom_attributes || {} };
  } catch (e) {}
  return null;
}
async function toQFront(msg, inboxId, resolved) {
  if (st.seen[msg.id]) return false;
  const from = (msg.from && msg.from.emailAddress) || {};
  const isHtml = !!(msg.body && msg.body.contentType === 'html');
  const esc = s => (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const rawText = (isHtml ? (msg.body.content || '').replace(/<[^>]+>/g, ' ') : (msg.body && msg.body.content) || msg.bodyPreview || '');
  const textFull = rawText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000);
  const bodyTxt = textFull;  // usado na classificacao de motivo
  let htmlFull = isHtml ? (msg.body.content || '') : ('<pre style="white-space:pre-wrap;font-family:inherit">' + esc(rawText) + '</pre>');
  htmlFull = htmlFull.replace(/<img[^>]*src=["']cid:[^"'>]*["'][^>]*>/gi, '');  // remove imagens inline cid (aparecem como anexo)
  const content = textFull || (msg.subject || '(sem assunto)');
  const atts = msg.hasAttachments ? await graphAttachments(msg.id) : [];
  const env = buildEmailEnvelope(msg, from, htmlFull, textFull, atts.length);

  // THREADING: resposta a um ticket existente (protocolo no assunto) -> anexa na MESMA conversa, mantendo o historico
  if (!resolved) {
    const existing = await findExistingConv(msg.subject);
    if (existing) {
      await qfPostMessage(existing.id, content, env, atts);
      await applyExtractedFields(existing.id, (msg.subject || '') + ' ' + bodyTxt, existing.attrs);  // mantem/enriquece os campos a cada interacao
      enrichFromSankhya(existing.id, { ...extractFields((msg.subject || '') + ' ' + bodyTxt), ...existing.attrs });  // fire-and-forget, nao atrasa o ticket
      if (existing.status === 'resolved') { try { await qf('POST', `/conversations/${existing.id}/toggle_status`, { status: 'open' }); } catch (e) {} }  // reabre o ticket
      st.sessions['c' + existing.id] = st.sessions['c' + existing.id] || { email: (from.address || '').toLowerCase(), subject: msg.subject, graphId: msg.id, protocolo: 'SAC-' + String(existing.id).padStart(6, '0') };
      st.seen[msg.id] = existing.id; save();
      log('REPLY ->', existing.id, '|', from.address, '|', (msg.subject || '').slice(0, 50));
      return true;
    }
  }

  // NOVA conversa (sem protocolo no assunto, ou nao encontrada)
  const cid = await ensureContact(from.name, (from.address || '').toLowerCase());
  const conv = await qf('POST', '/conversations', { inbox_id: inboxId, contact_id: cid, source_id: 'msg-' + msg.id.slice(-40) });
  await qfPostMessage(conv.id, content, env, atts);
  if (!resolved) {  // SAC: roteamento INSTANTANEO pro time do motivo + protocolo unico + etiquetas, sem depender do job assincrono do QFront
    const protocolo = 'SAC-' + String(conv.id).padStart(6, '0');
    const labels = classifyLabels(msg.subject || '', bodyTxt, (from.address || '').toLowerCase());
    const team = teamForLabels(labels);
    try { await qf('POST', `/conversations/${conv.id}/assignments`, { team_id: team }); } catch (e) { log('WARN assign', conv.id, e.response ? e.response.status : e.message); }
    const extracted = extractFields((msg.subject || '') + ' ' + bodyTxt);
    try { await qf('POST', `/conversations/${conv.id}/custom_attributes`, { custom_attributes: { protocolo_sac: protocolo, ...extracted } }); } catch (e) { log('WARN protocolo', conv.id, e.response ? e.response.status : e.message); }
    if (Object.keys(extracted).length) log('CAMPOS', conv.id, JSON.stringify(extracted));
    enrichFromSankhya(conv.id, extracted);  // fire-and-forget, nao atrasa o ticket
    if (labels.length) { try { await qf('POST', `/conversations/${conv.id}/labels`, { labels }); } catch (e) { log('WARN labels', conv.id, e.response ? e.response.status : e.message); } }
    await maybeAck((from.address || '').toLowerCase(), msg.subject || '', protocolo, conv.id);
    st.sessions['c' + conv.id] = { email: (from.address || '').toLowerCase(), subject: msg.subject, graphId: msg.id, protocolo, team };
    log('ROTA', conv.id, protocolo, 'team', team, '|', labels.join(','));
  } else {
    st.sessions['c' + conv.id] = { email: (from.address || '').toLowerCase(), subject: msg.subject, graphId: msg.id };
  }
  if (resolved) { try { await qf('POST', `/conversations/${conv.id}/toggle_status`, { status: 'resolved' }); } catch (e) {} }
  st.seen[msg.id] = conv.id; save();
  log((resolved ? 'HIST' : 'IN '), from.address, '|', (msg.subject || '').slice(0, 50));
  return true;
}
async function importHistory() {
  let n = 0;
  for (const folder of C.graphFolders) {
    let url = `/users/${C.mailbox}/mailFolders/${folder}/messages?$top=50&$select=id,subject,from,toRecipients,ccRecipients,internetMessageId,receivedDateTime,bodyPreview,body,hasAttachments&$orderby=receivedDateTime asc`;
    while (url) { const d = await graph('GET', url); for (const m of d.value) { if (await toQFront(m, C.qfHistInbox, true)) n++; } url = d['@odata.nextLink'] || null; }
    log('pasta', folder, 'ok');
  }
  log('HISTÓRICO IMPORTADO:', n);
}
async function pollInbound() {
  // sem $filter (Graph rejeita $filter+$orderby no mesmo campo) — busca recentes e filtra por data + dedupe(seen) no codigo
  const d = await graph('GET', `/users/${C.mailbox}/mailFolders/Inbox/messages?$top=25&$orderby=receivedDateTime desc&$select=id,subject,from,toRecipients,ccRecipients,internetMessageId,receivedDateTime,bodyPreview,body,hasAttachments`);
  const msgs = (d.value || []).slice().reverse(); // oldest->newest
  for (const m of msgs) {
    if (st.lastReceived && m.receivedDateTime < st.lastReceived) continue;  // < (nao <=) p/ nao perder e-mails do mesmo segundo; dedupe real por st.seen
    await toQFront(m, C.qfInbox, false);
    if (!st.lastReceived || m.receivedDateTime > st.lastReceived) st.lastReceived = m.receivedDateTime;
  }
  save();
}
async function pollOutbound() {
  if (!C.outbound) return;
  for (const [key, sess] of Object.entries(st.sessions)) {
    if (!key.startsWith('c')) continue; const convId = key.slice(1);
    try {
      const cd = await qf('GET', `/conversations/${convId}`); const co = cd.payload || cd;
      const setor = (co.meta && co.meta.team && co.meta.team.name) ? ' — ' + titleTeam(co.meta.team.name) : '';
      const msgs = (await qf('GET', `/conversations/${convId}/messages`)).payload || [];
      for (const m of msgs) {
        if (m.message_type !== 1 || m.private || st.sentOut[m.id] || !m.content) continue;
        const to = sess.email; const ok = C.whitelist.includes('*') || C.whitelist.includes(to);
        if (!ok) { st.sentOut[m.id] = true; save(); log('OUT bloqueado (whitelist):', to); continue; }
        const agente = (m.sender && (m.sender.available_name || m.sender.name)) || 'Equipe SAC';
        const protocolo = sess.protocolo || ('SAC-' + String(convId).padStart(6, '0'));
        const assinatura = `\n\n--\nAtendente responsável: ${agente}${setor}\nSAC Bel Lube  ·  Protocolo: ${protocolo}\nsac@bellube.com.br  ·  Atendimento de segunda a sexta, das 9h às 17h`;
        const corpo = (m.content || '') + assinatura;
        await graph('POST', `/users/${C.mailbox}/sendMail`, { message: { subject: subjectWithProtocolo(protocolo, sess.subject, true), body: { contentType: 'Text', content: corpo }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true });
        st.sentOut[m.id] = true; save(); log('OUT sac@->', to, '| agente:', agente + setor, '|', (m.content || '').slice(0, 40));
      }
    } catch (e) {
      if (e.response && e.response.status === 404) { delete st.sessions[key]; save(); log('OUT sessao removida (conversa inexistente):', convId); }
      else { log('WARN out', convId, e.response ? e.response.status : e.message); }
    }
  }
}
async function loop() {
  try { await pollInbound(); await pollOutbound(); } catch (e) { log('ERRO', e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message); }
  setTimeout(loop, C.pollMs);
}
(async () => {
  if (process.argv[2] === 'import') { await importHistory(); process.exit(0); }
  process.on('SIGTERM', () => { log('SIGTERM — encerrando'); process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
  log(`Email-bridge on. mailbox=${C.mailbox} inbox=${C.qfInbox} outbound=${C.outbound} whitelist=[${C.whitelist.join(',')}]`);
  loop();
})().catch(e => { console.error('FALHA:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
