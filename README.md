# SAC Bel Lube — Integração Megleo QFront

Plataforma de atendimento ao cliente (SAC) da **Bel Lube / Bel Distribuidor de Lubrificantes** implantada sobre o **Megleo QFront** (base **Chatwoot** white-label), com integrações próprias em **Node.js** que conectam o SAC ao **e-mail corporativo (Microsoft 365 / Graph)**, ao **WhatsApp (Neppo)** e ao **ERP Sankhya**.

Este repositório contém o **código das integrações** e a **documentação técnica e operacional** necessária para outro desenvolvedor continuar, manter e dar suporte ao projeto.

> ⚠️ **Repositório público.** Nenhum segredo, token, senha ou dado pessoal de cliente é versionado aqui. Toda configuração sensível vem de arquivos `.env` locais (ver `*.env.example`), que estão no `.gitignore`.

---

## O que é

O SAC recebe demandas por **e-mail** (`sac@bellube.com.br`) e **WhatsApp**, centraliza tudo em conversas (tickets) no QFront, roteia automaticamente para o **time da área correta** (Financeiro, Logística, RH, etc.) e mantém protocolo único, histórico e campos estruturados (CNPJ, NF, Pedido, Cód. Parceiro) extraídos automaticamente do conteúdo.

Como o QFront/Chatwoot não expõe conector nativo para a caixa `sac@` (M365) nem para o WhatsApp da Neppo, o elo é feito por **pontes (bridges)** próprias que rodam como serviço `systemd` e conversam com as APIs REST dos dois lados.

```
┌──────────────┐   Microsoft Graph    ┌───────────────────┐   REST devise-token   ┌──────────────┐
│ Caixa sac@   │ ◀──────────────────▶ │  email-bridge.js  │ ◀───────────────────▶ │   QFront      │
│ (M365)       │   (poll + sendMail)  │  (Node, systemd)  │   (conversations…)    │  (Chatwoot)   │
└──────────────┘                      └───────────────────┘                       └──────┬───────┘
                                                                                          │
┌──────────────┐   Neppo Chat API     ┌───────────────────┐                              │
│ WhatsApp     │ ◀──────────────────▶ │  neppo-bridge.js  │ ◀────────────────────────────┘
│ (Neppo)      │                      │  (Node, systemd)  │
└──────────────┘                      └───────────────────┘
                                                                                   ┌──────────────┐
                                        (consulta read-only) ─────────────────────▶│ ERP Sankhya  │
                                                                                   └──────────────┘
```

---

## Estrutura do repositório

```
SAC_QFront/
├── README.md                          ← este arquivo
├── CONTRIBUTING.md                    ← como rodar, padrões, fluxo de deploy
├── .gitignore                         ← exclui segredos, PII, estado de runtime
├── config/
│   └── canned_responses.md            ← respostas prontas (texto) configuradas no QFront
├── docs/
│   ├── GUIA_DESENVOLVEDOR.md          ← arquitetura, código, APIs, como autenticar
│   ├── OPERACOES_RUNBOOK.md           ← deploy, serviço, monitoramento, troubleshooting
│   ├── CONFIGURACAO_QFRONT.md         ← times, caixas, etiquetas, campos, roteamento
│   └── INTEGRACAO_SANKHYA.md          ← consulta Parceiro/Pedido/Título via Sankhya API Gateway
└── integration/
    ├── email-bridge/                  ← ponte sac@ (M365 Graph) ↔ QFront  [PRINCIPAL]
    │   ├── email-bridge.js
    │   ├── .env.example
    │   ├── package.json
    │   └── sac-email-bridge.service
    ├── neppo-bridge/                  ← ponte WhatsApp (Neppo) → QFront
    ├── sankhya-gateway/                ← consulta Parceiro/Pedido/Título via Sankhya API Gateway
    └── sac-import/                    ← script de importação de histórico
```

> Arquivos que **não** estão no Git (por conterem segredos/PII): `.env`, `*state*.json`, `*.log`, `contatos_sankhya.csv`, os manuais em PDF/HTML com prints reais, e o dossiê `lei-do-bem/`. Eles permanecem apenas no ambiente interno da Bel Lube.

---

## Início rápido (dev)

```bash
cd integration/email-bridge
cp .env.example .env      # preencha os valores (ver GUIA_DESENVOLVEDOR.md)
npm install
npm start                 # roda o polling em foreground
```

Para importar histórico: `npm run import`.

Ver **[docs/GUIA_DESENVOLVEDOR.md](docs/GUIA_DESENVOLVEDOR.md)** para o passo a passo completo (como obter os tokens do QFront, registrar o app no Entra, etc.) e **[docs/OPERACOES_RUNBOOK.md](docs/OPERACOES_RUNBOOK.md)** para operar em produção.

---

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Plataforma SAC | Megleo QFront (Chatwoot white-label) |
| Pontes | Node.js 18+ · `axios` · `dotenv` |
| E-mail | Microsoft 365 · Microsoft Graph API (app-only) |
| WhatsApp | Neppo Chat API |
| ERP | Sankhya (consulta read-only via API/SQL) |
| Execução | Linux · `systemd` (serviço `--user` ou de sistema) |

---

## Estado atual

- ✅ Ponte de e-mail `sac@` em produção 24/7 (inbound + outbound + auto-ack + protocolo + threading + extração de campos).
- ✅ Roteamento automático por time (palavra-chave → área) funcionando.
- ✅ Base QFront configurada: 8 times, caixas, 23 etiquetas, 18 campos personalizados, respostas prontas.
- ✅ Importação de histórico.
- ✅ Consulta ao Sankhya via API Gateway (Parceiro, Pedido/Nota, Título/Boleto) — `integration/sankhya-gateway/`, ver `docs/INTEGRACAO_SANKHYA.md`.
- 🔜 Fase 2: gravação de parecer no Sankhya (`AD_ATENDIMENTOOS`) — bloqueada até habilitação de `CRUDServiceProvider` na instância Sankhya (ver docs); chatbot de triagem no WhatsApp; Kanban/SLA nas Funções Extras Megleo.

Ver `docs/` para detalhes. Licença: uso interno Bel Lube (ver seção de licença no final do GUIA).
