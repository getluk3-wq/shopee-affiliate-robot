'use strict';

const express = require('express');
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const { createClient } = require('@supabase/supabase-js');
const baileys = require('@whiskeysockets/baileys');

const makeWASocket = baileys.default;

const {
  DisconnectReason,
  BufferJSON,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  Browsers,
  fetchLatestBaileysVersion
} = baileys;


// ======================================================
// CONFIGURAÇÕES PRINCIPAIS
// ======================================================

const app = express();

const PORT = Number(process.env.PORT || 3000);

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, 'data');

const PROFILE_IDS = ['rafael', 'usuario2'];

const SUPABASE_URL =
  process.env.SUPABASE_URL || '';

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const AUTOMATION_TIME_ZONE =
  process.env.AUTOMATION_TIME_ZONE ||
  'America/Sao_Paulo';

const WHATSAPP_AUTO_RECONNECT =
  process.env.WHATSAPP_AUTO_RECONNECT !== 'false';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      })
    : null;

fs.mkdirSync(DATA_DIR, {
  recursive: true
});

app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({
  limit: '5mb'
}));

app.use(express.urlencoded({
  extended: true,
  limit: '5mb'
}));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});


// ======================================================
// MEMÓRIA DO SERVIDOR
// ======================================================

const sockets = new Map();
const socketStarts = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();

const connectionIds = new Map();

const connectionStatus = new Map();
const qrCache = new Map();
const pairingCache = new Map();
const authRegistered = new Map();

const automationLocks = new Set();

// Mantém rastreados envios Baileys que demoram além do limite, para não reenviar duplicado.
const inFlightWhatsAppSends = new Map();

const storeCache = Object.fromEntries(
  PROFILE_IDS.map(profile => [
    profile,
    null
  ])
);


// ======================================================
// NICHOS E CATEGORIAS
// ======================================================

// As categorias abaixo servem para classificar PRODUTOS.
// O nicho de cada grupo é escolhido manualmente no painel.
// Nunca identificar o nicho de um grupo pelo nome dele.

const NICHE_DEFINITIONS = [
  {
    id: 'eletricos',
    label: 'Eletrônicos e tecnologia',
    aliases: [
      'eletronico',
      'eletronicos',
      'tecnologia',
      'celular',
      'fone',
      'informatica',
      'computador',
      'gadget',
      'tv',
      'smartwatch'
    ]
  },
  {
    id: 'perfumaria',
    label: 'Perfumes',
    aliases: [
      'perfume',
      'perfumaria',
      'colonia',
      'deo parfum',
      'body splash',
      'fragrancia'
    ]
  },
  {
    id: 'beleza',
    label: 'Beleza e maquiagem',
    aliases: [
      'beleza',
      'maquiagem',
      'make',
      'batom',
      'base',
      'skincare',
      'cabelo',
      'unha',
      'cosmetico'
    ]
  },
  {
    id: 'moda_feminina',
    label: 'Moda feminina',
    aliases: [
      'moda feminina',
      'feminino',
      'feminina',
      'vestido',
      'blusa feminina',
      'saia',
      'lingerie',
      'cropped'
    ]
  },
  {
    id: 'moda_masculina',
    label: 'Moda masculina',
    aliases: [
      'moda masculina',
      'roupa masculina',
      'roupas masculinas',
      'masculino',
      'masculina',
      'camiseta masculina',
      'camisa masculina',
      'camisa social masculina',
      'cueca masculina',
      'cueca',
      'bermuda masculina',
      'short masculino',
      'shorts masculino',
      'calca masculina',
      'calca jeans masculina',
      'jaqueta masculina'
    ]
  },
  {
    id: 'moda_infantil',
    label: 'Moda infantil',
    aliases: [
      'infantil',
      'crianca',
      'bebe',
      'menino',
      'menina',
      'roupa infantil'
    ]
  },
  {
    id: 'calcados',
    label: 'Calçados',
    aliases: [
      'calcado',
      'calcados',
      'sapato',
      'tenis',
      'sandalia',
      'chinelo',
      'bota'
    ]
  },
  {
    id: 'casa',
    label: 'Casa e utilidades',
    aliases: [
      'casa',
      'utilidades',
      'organizacao',
      'organizador',
      'limpeza',
      'banheiro',
      'lavanderia'
    ]
  },
  {
    id: 'cozinha',
    label: 'Cozinha',
    aliases: [
      'cozinha',
      'panela',
      'frigideira',
      'air fryer',
      'airfryer',
      'talher',
      'garrafa',
      'pote'
    ]
  },
  {
    id: 'decoracao',
    label: 'Decoração',
    aliases: [
      'decoracao',
      'decorativo',
      'quadro',
      'vaso',
      'tapete',
      'cortina',
      'luminaria'
    ]
  },
  {
    id: 'fitness',
    label: 'Fitness e esportes',
    aliases: [
      'fitness',
      'academia',
      'esporte',
      'treino',
      'halter',
      'suplemento',
      'legging fitness'
    ]
  },
  {
    id: 'pet',
    label: 'Pet shop',
    aliases: [
      'pet',
      'cachorro',
      'cachorros',
      'gato',
      'gatos',
      'cao',
      'caes',
      'para gatos',
      'para cachorro',
      'para caes',
      'para pets',
      'racao',
      'ração para pássaros',
      'racao para passaros',
      'passaro',
      'passaros',
      'ave',
      'aves',
      'calopsita',
      'papagaio',
      'canario',
      'alpiste',
      'gaiola',
      'viveiro',
      'coleira',
      'brinquedo pet'
    ]
  },
  {
    id: 'brinquedos',
    label: 'Brinquedos',
    aliases: [
      'brinquedo',
      'brinquedos',
      'boneca',
      'carrinho',
      'jogo infantil',
      'lego'
    ]
  },
  {
    id: 'acessorios',
    label: 'Acessórios e bolsas',
    aliases: [
      'acessorio',
      'acessorios',
      'bolsa',
      'carteira',
      'relogio',
      'oculos',
      'bijuteria',
      'joia'
    ]
  }
];


// ======================================================
// DADOS PADRÃO DOS PERFIS
// ======================================================

function defaultProfileData() {
  return {
    accessEnabled: true,
    automation: {
      enabled: false,
      active: false,
      intervalMinutes: 30,
      intervalSeconds: 1800,
      maxProducts: 10,
      destinationIds: [],
      groupSelectionMode: false,
      groupIds: [],
      groupNiches: {},
      groupNames: {},
      startTime: '',
      endTime: '',
      scheduleTimes: [],
      lastRunAt: null,
      lastSentAt: null,
      lastError: null
    },

    destinations: [],
    products: [],
    queue: [],
    sentProducts: {},

    whatsappAuth: {
      creds: null,
      keys: {}
    },

    shopeeCredentials: null,
    updatedAt: new Date().toISOString()
  };
}


// ======================================================
// FUNÇÕES UTILITÁRIAS
// ======================================================

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function normalizeGroupId(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function normalizeWhatsAppJid(value) {
  let raw = String(value || '')
    .trim()
    .replace(/\s+/g, '');

  if (!raw) return '';

  if (raw.includes('@')) {
    const at = raw.lastIndexOf('@');

    return (
      raw.slice(0, at) +
      '@' +
      raw.slice(at + 1).toLowerCase()
    );
  }

  if (/^\d+-\d+$/.test(raw)) {
    return `${raw}@g.us`;
  }

  let digits = raw.replace(/\D/g, '');

  if (
    digits.length === 10 ||
    digits.length === 11
  ) {
    digits = `55${digits}`;
  }

  if (
    digits.length >= 12 &&
    digits.length <= 15
  ) {
    return `${digits}@s.whatsapp.net`;
  }

  return '';
}

function getMapValueByGroupId(map, groupId) {
  if (!map || typeof map !== 'object') {
    return undefined;
  }

  const target = normalizeGroupId(groupId);

  for (const [key, value] of Object.entries(map)) {
    if (normalizeGroupId(key) === target) {
      return value;
    }
  }

  return undefined;
}


// ======================================================
// NORMALIZAÇÃO DO NICHO MANUAL
// ======================================================

function normalizeNicheId(value) {
  let raw = value;

  if (
    raw &&
    typeof raw === 'object'
  ) {
    raw =
      raw.id ??
      raw.nicheId ??
      raw.value ??
      '';
  }

  const normalized = normalizeText(raw)
    .replace(/[\s-]+/g, '_');

  if (
    !normalized ||
    [
      'auto',
      'automatico',
      'automatica',
      'automatic',
      'unknown',
      'desconhecido',
      'nao_identificado',
      'manual',
      'selecione',
      'selecione_manualmente'
    ].includes(normalized)
  ) {
    return '';
  }

  if (
    [
      'all',
      'todos',
      'todas',
      'geral',
      'todos_os_nichos',
      'todas_as_categorias'
    ].includes(normalized)
  ) {
    return 'all';
  }

  const definition = NICHE_DEFINITIONS.find(item => {
    if (item.id === normalized) {
      return true;
    }

    if (normalizeText(item.label) === normalizeText(raw)) {
      return true;
    }

    return item.aliases.some(alias =>
      normalizeText(alias) === normalizeText(raw)
    );
  });

  return definition ? definition.id : '';
}


function profileIdFrom(req) {
  const requested =
    req.headers['x-profile'] ||
    req.query?.profile ||
    req.body?.profile ||
    'rafael';

  const profile = String(requested).trim();

  return PROFILE_IDS.includes(profile)
    ? profile
    : 'rafael';
}

function getData(profile) {
  if (!PROFILE_IDS.includes(profile)) {
    throw new Error('Perfil inválido.');
  }

  if (!storeCache[profile]) {
    storeCache[profile] = defaultProfileData();
  }

  return storeCache[profile];
}

function safeJson(value, fallback = null) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_) {
      return fallback;
    }
  }

  return value;
}


// ======================================================
// NORMALIZAÇÃO DOS DADOS
// ======================================================

function mergeProfileData(value) {
  const defaults = defaultProfileData();
  const parsed = safeJson(value, {});

  if (!parsed || typeof parsed !== 'object') {
    return defaults;
  }

  const oldAutomation = parsed.automation || {};

  const intervalSeconds = Number(
    oldAutomation.intervalSeconds
  );

  const intervalMinutes = Number(
    oldAutomation.intervalMinutes
  );

  let finalSeconds = 1800;

  if (
    Number.isFinite(intervalSeconds) &&
    intervalSeconds > 0
  ) {
    finalSeconds = intervalSeconds;
  } else if (
    Number.isFinite(intervalMinutes) &&
    intervalMinutes > 0
  ) {
    finalSeconds = intervalMinutes * 60;
  }

  finalSeconds = Math.max(
    10,
    Math.min(86400, Math.round(finalSeconds))
  );

  const active = Boolean(
    oldAutomation.active ??
    oldAutomation.enabled ??
    false
  );

  const whatsappAuth = parsed.whatsappAuth || {};

  const rawGroupNiches =
    oldAutomation.groupNiches &&
    typeof oldAutomation.groupNiches === 'object'
      ? oldAutomation.groupNiches
      : {};

  const normalizedGroupNiches = {};

  for (const [groupId, niche] of Object.entries(rawGroupNiches)) {
    normalizedGroupNiches[normalizeGroupId(groupId)] =
      normalizeNicheId(niche);
  }

  return {
    ...defaults,
    ...parsed,

    automation: {
      ...defaults.automation,
      ...oldAutomation,

      enabled: active,
      active,

      intervalSeconds: finalSeconds,

      intervalMinutes: Math.max(
        1,
        Math.ceil(finalSeconds / 60)
      ),

      maxProducts: Math.max(
        1,
        Math.min(
          50,
          Number(oldAutomation.maxProducts) || 10
        )
      ),

      destinationIds: Array.isArray(
        oldAutomation.destinationIds
      )
        ? oldAutomation.destinationIds
        : [],

      groupIds: Array.isArray(
        oldAutomation.groupIds
      )
        ? oldAutomation.groupIds
        : [],

      groupNiches: normalizedGroupNiches,

      groupNames:
        oldAutomation.groupNames &&
        typeof oldAutomation.groupNames === 'object'
          ? oldAutomation.groupNames
          : {},

      scheduleTimes: Array.isArray(
        oldAutomation.scheduleTimes
      )
        ? oldAutomation.scheduleTimes
        : []
    },

    destinations: Array.isArray(parsed.destinations)
      ? parsed.destinations.map(destination => ({
          ...destination,
          nicheId: normalizeNicheId(
            destination?.nicheId ??
            destination?.niche ??
            ''
          )
        }))
      : [],

    products: Array.isArray(parsed.products)
      ? parsed.products
      : [],

    queue: Array.isArray(parsed.queue)
      ? parsed.queue
      : [],

    sentProducts:
      parsed.sentProducts &&
      typeof parsed.sentProducts === 'object'
        ? parsed.sentProducts
        : {},

    whatsappAuth: {
      creds: whatsappAuth.creds || null,
      keys:
        whatsappAuth.keys &&
        typeof whatsappAuth.keys === 'object'
          ? whatsappAuth.keys
          : {}
    },

    updatedAt: new Date().toISOString()
  };
}


// ======================================================
// SUPABASE: LOCALIZAÇÃO DOS REGISTROS
// ======================================================

async function findProfileRow(profile) {
  if (!supabase) return null;

  const profileColumns = [
    'perfil',
    'profile',
    'profile_id',
    'id'
  ];

  const dataColumns = [
    'dados',
    'data',
    'config',
    'settings',
    'conteudo',
    'payload'
  ];

  for (const profileColumn of profileColumns) {
    for (const dataColumn of dataColumns) {
      try {
        const { data, error } = await supabase
          .from('robo_perfis')
          .select('*')
          .eq(profileColumn, profile)
          .maybeSingle();

        if (error) continue;

        if (data) {
          return {
            row: data,
            profileColumn,
            dataColumn
          };
        }
      } catch (_) {}
    }
  }

  return null;
}


// ======================================================
// CARREGAR PERFIL
// ======================================================

async function loadProfile(profile) {
  if (!PROFILE_IDS.includes(profile)) {
    throw new Error('Perfil inválido.');
  }

  let localData = null;

  const filePath = path.join(
    DATA_DIR,
    `${profile}.json`
  );

  try {
    if (fs.existsSync(filePath)) {
      localData = safeJson(
        fs.readFileSync(filePath, 'utf8'),
        null
      );
    }
  } catch (error) {
    logger.error(
      {
        profile,
        error: error.message
      },
      'Erro ao ler arquivo local do perfil'
    );
  }

  if (supabase) {
    try {
      const found = await findProfileRow(profile);

      if (found?.row) {
        const remoteData = safeJson(
          found.row[found.dataColumn],
          null
        );

        if (remoteData) {
          storeCache[profile] = mergeProfileData(
            remoteData
          );

          return storeCache[profile];
        }
      }
    } catch (error) {
      logger.warn(
        {
          profile,
          error: error.message
        },
        'Não foi possível carregar perfil do Supabase'
      );
    }
  }

  storeCache[profile] = mergeProfileData(
    localData || storeCache[profile] || {}
  );

  return storeCache[profile];
}


// ======================================================
// SALVAR PERFIL
// ======================================================

async function saveProfile(profile) {
  const data = getData(profile);

  data.updatedAt = new Date().toISOString();
  storeCache[profile] = data;

  const filePath = path.join(
    DATA_DIR,
    `${profile}.json`
  );

  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify(data, null, 2),
      'utf8'
    );
  } catch (error) {
    logger.error(
      {
        profile,
        error: error.message
      },
      'Erro ao salvar arquivo local'
    );
  }

  if (!supabase) return true;

  const profileColumns = [
    'perfil',
    'profile',
    'profile_id',
    'id'
  ];

  const dataColumns = [
    'dados',
    'data',
    'config',
    'settings',
    'conteudo',
    'payload'
  ];

  const existing = await findProfileRow(profile);

  if (existing) {
    const payload = {
      [existing.dataColumn]: data,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('robo_perfis')
      .update(payload)
      .eq(existing.profileColumn, profile);

    if (!error) return true;

    logger.error(
      { profile, error: error.message },
      'Falha ao atualizar perfil no Supabase'
    );
  }

  for (const profileColumn of profileColumns) {
    for (const dataColumn of dataColumns) {
      try {
        const payload = {
          [profileColumn]: profile,
          [dataColumn]: data,
          updated_at: new Date().toISOString()
        };

        const { error } = await supabase
          .from('robo_perfis')
          .insert(payload);

        if (!error) return true;
      } catch (_) {}
    }
  }

  logger.warn(
    { profile },
    'Perfil salvo localmente; Supabase não confirmou gravação.'
  );

  return true;
}


// ======================================================
// CLASSIFICAÇÃO DE PRODUTOS
// ======================================================

// Esta função classifica somente o produto.
// Ela não recebe nem consulta o nome do grupo.

function containsNichePhrase(text, phrase) {
  const textWords = normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const phraseWords = normalizeText(phrase)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (!phraseWords.length || phraseWords.length > textWords.length) {
    return false;
  }

  for (let i = 0; i <= textWords.length - phraseWords.length; i++) {
    let found = true;

    for (let j = 0; j < phraseWords.length; j++) {
      if (textWords[i + j] !== phraseWords[j]) {
        found = false;
        break;
      }
    }

    if (found) return true;
  }

  return false;
}

function classifyProductNiches(product) {
  const item = product && typeof product === 'object' ? product : {};

  const text = normalizeText([
    item.productName,
    item.name,
    item.title,
    item.category,
    item.categoryName,
    item.description
  ].filter(Boolean).join(' '));

  if (!text) return [];

  const genericAliases = new Set([
    'make', 'base', 'casa', 'feminino', 'feminina',
    'masculino', 'masculina', 'menino', 'menina'
  ]);

  const matches = [];

  for (const niche of NICHE_DEFINITIONS) {
    for (const alias of (niche.aliases || [])) {
      const normalizedAlias = normalizeText(alias);

      if (genericAliases.has(normalizedAlias)) continue;

      if (containsNichePhrase(text, normalizedAlias)) {
        // Termos específicos de cozinha devem prevalecer sobre
        // descrições genéricas como "utilidades" ou "organização".
        // Assim, itens de cozinha não são desviados para o nicho amplo "casa".
        const broadHomeTerms = new Set([
          'utilidades',
          'organizacao',
          'organizador',
          'limpeza',
          'banheiro',
          'lavanderia'
        ]);
        const specificNicheBoost = niche.id === 'cozinha' ? 30 : 0;
        const broadHomePenalty =
          niche.id === 'casa' && broadHomeTerms.has(normalizedAlias)
            ? 25
            : 0;

        matches.push({
          id: niche.id,
          score: normalizedAlias.length +
            specificNicheBoost -
            broadHomePenalty
        });
      }
    }
  }

  if (!matches.length) {
    const sourceNiches = Array.isArray(item.sourceNicheIds)
      ? item.sourceNicheIds.map(normalizeNicheId).filter(Boolean)
      : [];

    const singleSource = normalizeNicheId(item.sourceNicheId);

    if (singleSource) sourceNiches.push(singleSource);

    return [...new Set(sourceNiches)];
  }

  const bestScore = Math.max(...matches.map(item => item.score));
  const bestNiches = [...new Set(
    matches.filter(item => item.score === bestScore).map(item => item.id)
  )];

  return bestNiches.length === 1 ? bestNiches : [];
}


// ======================================================
// VERIFICAR COMPATIBILIDADE DO DESTINO
// ======================================================

// Regras:
// 1. "all" recebe qualquer produto.
// 2. Nicho vazio não recebe ofertas automáticas.
// 3. Nicho específico só recebe produtos compatíveis.
// 4. Nunca tenta descobrir o nicho pelo nome do grupo.

function destinationMatchesProduct(destination, product) {
  const selected = normalizeNicheId(
    destination?.nicheId ??
    destination?.niche ??
    ''
  );

  if (selected === 'all') {
    return {
      matches: true,
      reason: 'Destino configurado para todos os nichos.'
    };
  }

  if (!selected) {
    return {
      matches: false,
      reason: 'Este grupo ainda não possui um nicho selecionado manualmente.'
    };
  }

  // Quando a oferta veio de uma busca feita explicitamente para um nicho,
  // essa origem é a referência mais confiável. Não deixe o título/descrição
  // reclassificar o produto e bloquear os grupos que escolheram esse nicho.
  const sourceNiches = Array.isArray(product?.sourceNicheIds)
    ? product.sourceNicheIds.map(normalizeNicheId).filter(Boolean)
    : [];
  const sourceNiche = normalizeNicheId(product?.sourceNicheId);
  if (sourceNiche) sourceNiches.push(sourceNiche);

  if (sourceNiches.includes(selected)) {
    return {
      matches: true,
      reason: 'Oferta encontrada pela busca do nicho selecionado para este grupo.'
    };
  }

  const productNiches = classifyProductNiches(product);

  if (!productNiches.length) {
    return {
      matches: false,
      reason: 'Não foi possível identificar a categoria deste produto.'
    };
  }

  const matches = productNiches.includes(selected);

  return {
    matches,
    reason: matches
      ? 'Produto compatível com o nicho selecionado.'
      : 'Produto não pertence ao nicho selecionado para este grupo.'
  };
}


// ======================================================
// DESTINOS DA AUTOMAÇÃO
// ======================================================

function getAutomationTargets(data) {
  const automation = data.automation || {};

  if (automation.groupSelectionMode) {
    const selectedIds = Array.isArray(
      automation.groupIds
    )
      ? automation.groupIds
      : [];

    return selectedIds.map(groupId => {
      const destination = data.destinations.find(
        item =>
          normalizeGroupId(item.groupId || item.id) ===
          normalizeGroupId(groupId)
      );

      const savedNiche = getMapValueByGroupId(
        automation.groupNiches,
        groupId
      );

      // Se existir uma escolha manual no mapa, ela é
      // autoritativa, inclusive quando estiver vazia.
      // Não usar || aqui: isso poderia recuperar um nicho antigo.
      const selectedNiche =
        savedNiche !== undefined
          ? savedNiche
          : (
              destination?.nicheId ??
              destination?.niche ??
              ''
            );

      return {
        ...(destination || {}),
        id: groupId,
        groupId,

        name:
          getMapValueByGroupId(
            automation.groupNames,
            groupId
          ) ||
          destination?.name ||
          groupId,

        nicheId: normalizeNicheId(selectedNiche),

        active: true
      };
    });
  }

  const selected = Array.isArray(
    automation.destinationIds
  )
    ? automation.destinationIds
    : [];

  return data.destinations
    .filter(destination => {
      if (destination.active === false) return false;
      if (!selected.length) return false;

      return selected.some(id =>
        String(id) === String(destination.id) ||
        normalizeGroupId(id) ===
          normalizeGroupId(destination.groupId)
      );
    })
    .map(destination => ({
      ...destination,
      nicheId: normalizeNicheId(
        destination.nicheId ??
        destination.niche ??
        ''
      )
    }));
}


// ======================================================
// CRIPTOGRAFIA DAS CREDENCIAIS
// ======================================================

function encryptionKey() {
  const secret =
    process.env.SHOPEE_CREDENTIALS_KEY ||
    process.env.APP_ENCRYPTION_KEY ||
    '';

  if (!secret) return null;

  return crypto
    .createHash('sha256')
    .update(secret)
    .digest();
}

function encryptObject(value) {
  const key = encryptionKey();

  if (!key) {
    throw new Error(
      'Configure SHOPEE_CREDENTIALS_KEY ou APP_ENCRYPTION_KEY nas variáveis do servidor.'
    );
  }

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    key,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify(value),
      'utf8'
    ),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptObject(payload) {
  if (!payload) return null;

  const key = encryptionKey();

  if (!key) return null;

  try {
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const encrypted = Buffer.from(payload.data, 'base64');

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      iv
    );

    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);

    return JSON.parse(
      decrypted.toString('utf8')
    );
  } catch (error) {
    logger.warn(
      { error: error.message },
      'Não foi possível descriptografar credenciais.'
    );

    return null;
  }
}


// ======================================================
// SUPABASE: ARMAZENAMENTO PERMANENTE DO WHATSAPP
// Tabela: public.whatsapp_auth_store
// Colunas: profile, key, value, updated_at
// ======================================================

const authMemoryCache = new Map();

function authCacheKey(profile, key) {
  return `${profile}:${key}`;
}

function packAuthValue(value) {
  return JSON.parse(
    JSON.stringify(value, BufferJSON.replacer)
  );
}

function unpackAuthValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  try {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch (_) {
        return null;
      }
    }

    return JSON.parse(
      JSON.stringify(value),
      BufferJSON.reviver
    );

  } catch (error) {
    logger.error(
      { error: error.message },
      'Erro ao recuperar dado de autenticação.'
    );

    return null;
  }
}

async function readWhatsAppAuth(profile, key) {
  if (!supabase) {
    throw new Error(
      'Supabase não configurado. Verifique as variáveis do Render.'
    );
  }

  const cacheKey = authCacheKey(profile, key);

  if (authMemoryCache.has(cacheKey)) {
    return authMemoryCache.get(cacheKey);
  }

  const { data, error } = await supabase
    .from('whatsapp_auth_store')
    .select('value')
    .eq('profile', profile)
    .eq('key', key)
    .maybeSingle();

  if (error) {
    logger.error(
      {
        profile,
        key,
        error: error.message
      },
      'Erro ao ler autenticação do Supabase.'
    );

    throw error;
  }

  const value = data
    ? unpackAuthValue(data.value)
    : null;

  if (value !== null && value !== undefined) {
    authMemoryCache.set(cacheKey, value);
  }

  return value;
}

async function writeWhatsAppAuth(profile, key, value) {
  if (!supabase) {
    throw new Error(
      'Supabase não configurado. Não é seguro salvar a sessão somente na memória.'
    );
  }

  const cacheKey = authCacheKey(profile, key);
  const storedValue = packAuthValue(value);

  const { error } = await supabase
    .from('whatsapp_auth_store')
    .upsert(
      {
        profile,
        key,
        value: storedValue,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: 'profile,key'
      }
    );

  if (error) {
    logger.error(
      {
        profile,
        key,
        error: error.message
      },
      'Falha ao salvar autenticação no Supabase.'
    );

    throw error;
  }

  authMemoryCache.set(cacheKey, value);

  return true;
}

async function deleteWhatsAppAuth(profile, key) {
  if (!supabase) {
    throw new Error('Supabase não configurado.');
  }

  const { error } = await supabase
    .from('whatsapp_auth_store')
    .delete()
    .eq('profile', profile)
    .eq('key', key);

  if (error) {
    logger.error(
      {
        profile,
        key,
        error: error.message
      },
      'Falha ao excluir chave de autenticação.'
    );

    throw error;
  }

  authMemoryCache.delete(
    authCacheKey(profile, key)
  );

  return true;
}

async function deleteAllWhatsAppAuth(profile) {
  if (!supabase) {
    throw new Error('Supabase não configurado.');
  }

  const { error } = await supabase
    .from('whatsapp_auth_store')
    .delete()
    .eq('profile', profile);

  if (error) {
    logger.error(
      {
        profile,
        error: error.message
      },
      'Falha ao limpar autenticação do Supabase.'
    );

    throw error;
  }

  for (const key of authMemoryCache.keys()) {
    if (key.startsWith(`${profile}:`)) {
      authMemoryCache.delete(key);
    }
  }

  return true;
}

async function hasWhatsAppAuth(profile) {
  const creds = await readWhatsAppAuth(
    profile,
    'creds'
  );

  return Boolean(creds?.registered);
}


// ======================================================
// ESTADO DE AUTENTICAÇÃO BAILEYS
// ======================================================

async function createSupabaseAuthState(profile) {
  if (!supabase) {
    throw new Error(
      'Conexão com Supabase obrigatória para salvar a sessão do WhatsApp.'
    );
  }

  let creds = await readWhatsAppAuth(
    profile,
    'creds'
  );

  if (!creds) {
    creds = initAuthCreds();
  }

  const keysCache = new Map();

  const keyStore = {
    async get(type, ids) {
      const result = {};
      const missing = [];

      for (const id of ids) {
        const cacheKey = `${type}:${id}`;

        if (keysCache.has(cacheKey)) {
          result[id] = keysCache.get(cacheKey);
        } else {
          missing.push({ id, key: cacheKey });
        }
      }

      // Consultas .in muito grandes podem ser rejeitadas pelo PostgREST
      // (HTTP 400). Divide a leitura em lotes pequenos sem alterar as
      // chaves nem a sessão persistida de cada perfil.
      const batchSize = 40;
      const found = new Map();

      for (let offset = 0; offset < missing.length; offset += batchSize) {
        const batch = missing.slice(offset, offset + batchSize);
        const keyNames = batch.map(item => item.key);

        const { data, error } = await supabase
          .from('whatsapp_auth_store')
          .select('key,value')
          .eq('profile', profile)
          .in('key', keyNames);

        if (error) {
          logger.error(
            {
              profile,
              keyType: type,
              requestedKeys: keyNames.length,
              error: error.message,
              code: error.code || null,
              details: error.details || null,
              hint: error.hint || null
            },
            'Erro ao recuperar lote de chaves criptográficas do WhatsApp.'
          );

          throw error;
        }

        for (const row of data || []) {
          found.set(row.key, unpackAuthValue(row.value));
        }
      }

      for (const item of missing) {
        if (found.has(item.key)) {
          const value = found.get(item.key);

          if (value !== null && value !== undefined) {
            keysCache.set(item.key, value);
            result[item.id] = value;
          }
        }
      }

      return result;
    },

    async set(dataToSet) {
      const rowsToUpsert = [];
      const keysToDelete = [];

      for (const [type, entries] of Object.entries(dataToSet || {})) {
        for (const [id, value] of Object.entries(entries || {})) {
          const key = `${type}:${id}`;

          if (value === null || value === undefined) {
            keysCache.delete(key);
            keysToDelete.push(key);
          } else {
            rowsToUpsert.push({
              profile,
              key,
              value: packAuthValue(value),
              updated_at: new Date().toISOString()
            });
          }
        }
      }

      // Evita centenas de requisições simultâneas ao Supabase.
      // O armazenamento é atualizado em lotes pequenos e ordenados.
      const batchSize = 40;

      for (let offset = 0; offset < rowsToUpsert.length; offset += batchSize) {
        const batch = rowsToUpsert.slice(offset, offset + batchSize);
        const { error } = await supabase
          .from('whatsapp_auth_store')
          .upsert(batch, { onConflict: 'profile,key' });

        if (error) {
          logger.error(
            {
              profile,
              batchSize: batch.length,
              error: error.message,
              code: error.code || null,
              details: error.details || null
            },
            'Falha ao salvar lote de chaves criptográficas do WhatsApp.'
          );
          throw error;
        }

        for (const row of batch) {
          const keyTypeAndId = row.key;
          const splitAt = keyTypeAndId.indexOf(':');
          const type = keyTypeAndId.slice(0, splitAt);
          const id = keyTypeAndId.slice(splitAt + 1);
          const originalValue = dataToSet?.[type]?.[id];
          if (originalValue !== undefined && originalValue !== null) {
            keysCache.set(keyTypeAndId, originalValue);
          }
          authMemoryCache.set(authCacheKey(profile, keyTypeAndId), originalValue);
        }
      }

      for (let offset = 0; offset < keysToDelete.length; offset += batchSize) {
        const batch = keysToDelete.slice(offset, offset + batchSize);
        const { error } = await supabase
          .from('whatsapp_auth_store')
          .delete()
          .eq('profile', profile)
          .in('key', batch);

        if (error) {
          logger.error(
            {
              profile,
              batchSize: batch.length,
              error: error.message,
              code: error.code || null,
              details: error.details || null
            },
            'Falha ao excluir lote de chaves criptográficas do WhatsApp.'
          );
          throw error;
        }

        for (const key of batch) {
          authMemoryCache.delete(authCacheKey(profile, key));
        }
      }
    }
  };

  async function saveCreds() {
    await writeWhatsAppAuth(
      profile,
      'creds',
      creds
    );
  }

  const cachedKeys =
    typeof makeCacheableSignalKeyStore === 'function'
      ? makeCacheableSignalKeyStore(
          keyStore,
          logger
        )
      : keyStore;

  return {
    state: {
      creds,
      keys: cachedKeys
    },
    saveCreds
  };
}


// ======================================================
// STATUS DO WHATSAPP
// ======================================================

function setStatus(
  profile,
  status,
  extra = {}
) {
  connectionStatus.set(profile, {
    status,
    updatedAt: new Date().toISOString(),
    ...extra
  });
}

function getStatus(profile) {
  return connectionStatus.get(profile) || {
    status: 'disconnected',
    updatedAt: null
  };
}


// ======================================================
// LIMPAR AUTENTICAÇÃO DO WHATSAPP
// ======================================================

async function clearWhatsAppAuth(profile) {
  const data = getData(profile);

  // Limpa somente a sessão do perfil solicitado.
  // Não apaga produtos, grupos ou configurações.
  await deleteAllWhatsAppAuth(profile);

  data.whatsappAuth = {
    creds: null,
    keys: {}
  };

  qrCache.delete(profile);
  pairingCache.delete(profile);
  authRegistered.delete(profile);

  await saveProfile(profile);

  logger.info(
    { profile },
    'Autenticação do WhatsApp removida do armazenamento.'
  );
}


// ======================================================
// AGENDAMENTO DA RECONEXÃO
// ======================================================

function scheduleWhatsAppReconnect(profile, connectionId) {
  if (!WHATSAPP_AUTO_RECONNECT) return;

  if (reconnectTimers.has(profile)) return;

  if (connectionIds.get(profile) !== connectionId) return;

  const attempts =
    (reconnectAttempts.get(profile) || 0) + 1;

  reconnectAttempts.set(profile, attempts);

  const delay = Math.min(
    60000,
    3000 * Math.pow(2, Math.min(attempts - 1, 4))
  );

  logger.info(
    {
      profile,
      attempts,
      delay
    },
    'Reconexão automática agendada.'
  );

  const timer = setTimeout(() => {
    reconnectTimers.delete(profile);

    if (connectionIds.get(profile) !== connectionId) {
      return;
    }

    startWhatsApp(profile).catch(error => {
      logger.error(
        {
          profile,
          error: error.message
        },
        'Falha na reconexão automática.'
      );
    });
  }, delay);

  reconnectTimers.set(profile, timer);
}


// ======================================================
// CONEXÃO WHATSAPP - BAILEYS
// ======================================================

async function startWhatsApp(profile) {
  if (!PROFILE_IDS.includes(profile)) {
    throw new Error('Perfil inválido.');
  }

  const existingSocket = sockets.get(profile);

  if (existingSocket) {
    const currentStatus = getStatus(profile).status;

    if (
      currentStatus === 'connected' ||
      currentStatus === 'qr' ||
      currentStatus === 'connecting'
    ) {
      return {
        ok: true,
        status: getStatus(profile),
        qr: qrCache.get(profile) || null
      };
    }

    sockets.delete(profile);
  }

  if (socketStarts.has(profile)) {
    return socketStarts.get(profile);
  }

  const connectionId =
    (connectionIds.get(profile) || 0) + 1;

  connectionIds.set(profile, connectionId);

  const pendingTimer = reconnectTimers.get(profile);

  if (pendingTimer) {
    clearTimeout(pendingTimer);
    reconnectTimers.delete(profile);
  }

  const isCurrentConnection = sock => {
    return (
      connectionIds.get(profile) === connectionId &&
      (!sock || sockets.get(profile) === sock)
    );
  };

  const startPromise = (async () => {
    try {
      await loadProfile(profile);

      if (!isCurrentConnection()) {
        throw new Error(
          'Inicialização cancelada por uma conexão mais recente.'
        );
      }

      qrCache.delete(profile);
      pairingCache.delete(profile);

      setStatus(profile, 'connecting', {
        message: 'Iniciando conexão com o WhatsApp...'
      });

      logger.info(
        { profile, connectionId },
        'Iniciando conexão WhatsApp.'
      );

      const auth = await createSupabaseAuthState(profile);

      if (!isCurrentConnection()) {
        throw new Error(
          'Inicialização cancelada antes de criar o socket.'
        );
      }

      let version;

      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;

        logger.info(
          { profile, version },
          'Versão do WhatsApp obtida.'
        );
      } catch (error) {
        logger.warn(
          {
            profile,
            error: error.message
          },
          'Não foi possível consultar a versão mais recente do WhatsApp.'
        );
      }

      if (!isCurrentConnection()) {
        throw new Error(
          'Inicialização cancelada antes de abrir o socket.'
        );
      }

      const socketOptions = {
        auth: auth.state,

        logger: pino({
          level: 'silent'
        }),

        printQRInTerminal: false,

        browser:
          typeof Browsers?.macOS === 'function'
            ? Browsers.macOS('Chrome')
            : [
                'MEDEIROS DIGITAL',
                'Chrome',
                '1.0.0'
              ],

        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,

        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: true
      };

      if (version) {
        socketOptions.version = version;
      }

      const sock = makeWASocket(socketOptions);

      sockets.set(profile, sock);

      // A aceitação de sendMessage não garante entrega. Acompanhar os
      // recibos enviados pelo WhatsApp para diagnosticar entrega real.
      sock.ev.on('messages.update', updates => {
        if (!isCurrentConnection(sock) || !Array.isArray(updates)) return;

        const statusLabels = {
          0: 'PENDING',
          1: 'SERVER_ACK',
          2: 'DELIVERY_ACK',
          3: 'READ',
          4: 'PLAYED'
        };

        for (const entry of updates) {
          if (!entry?.key?.fromMe) continue;

          const status = entry.update?.status;
          logger.info(
            {
              profile,
              jid: entry.key.remoteJid || null,
              messageId: entry.key.id || null,
              status,
              statusLabel: statusLabels[status] || 'UNKNOWN'
            },
            'Confirmação de status da mensagem WhatsApp.'
          );
        }
      });

      sock.ev.on('creds.update', async () => {
        if (!isCurrentConnection(sock)) return;

        try {
          await auth.saveCreds();
        } catch (error) {
          logger.error(
            {
              profile,
              error: error.message
            },
            'Erro ao salvar credenciais do WhatsApp.'
          );
        }
      });

      sock.ev.on('connection.update', async update => {
        if (!isCurrentConnection(sock)) {
          logger.debug(
            { profile, connectionId },
            'Evento antigo do WhatsApp ignorado.'
          );
          return;
        }

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (qr) {
          try {
            const qrDataUrl = await QRCode.toDataURL(qr, {
              errorCorrectionLevel: 'M',
              margin: 2,
              width: 360
            });

            if (!isCurrentConnection(sock)) return;

            qrCache.set(profile, qrDataUrl);

            setStatus(profile, 'qr', {
              message: 'Escaneie o QR Code pelo WhatsApp.'
            });

            logger.info(
              { profile, connectionId },
              'QR Code recebido e gerado com sucesso.'
            );
          } catch (error) {
            logger.error(
              {
                profile,
                error: error.message
              },
              'Erro ao gerar QR Code.'
            );
          }
        }

        if (connection === 'connecting') {
          if (!qrCache.has(profile)) {
            setStatus(profile, 'connecting', {
              message: 'Aguardando conexão com o WhatsApp...'
            });
          }
        }

        if (connection === 'open') {
          if (!isCurrentConnection(sock)) return;

          qrCache.delete(profile);
          pairingCache.delete(profile);

          reconnectAttempts.set(profile, 0);
          authRegistered.set(profile, true);

          setStatus(profile, 'connected', {
            message: 'WhatsApp conectado com sucesso.'
          });

          logger.info(
            { profile, connectionId },
            'WhatsApp conectado.'
          );
        }

        if (connection === 'close') {
          if (!isCurrentConnection(sock)) return;

          sockets.delete(profile);
          qrCache.delete(profile);
          pairingCache.delete(profile);

          const statusCode =
            lastDisconnect?.error?.output?.statusCode ||
            lastDisconnect?.error?.statusCode ||
            null;

          const loggedOut =
            statusCode === DisconnectReason.loggedOut ||
            statusCode === 401;

          logger.warn(
            {
              profile,
              connectionId,
              statusCode,
              error: lastDisconnect?.error?.message || null
            },
            'Conexão WhatsApp encerrada.'
          );

          if (loggedOut) {
            setStatus(profile, 'logged_out', {
              reason: statusCode,
              message: 'Sessão encerrada. Conecte novamente pelo QR Code.'
            });

            try {
              await clearWhatsAppAuth(profile);

              logger.warn(
                { profile, statusCode },
                'Autenticação encerrada pelo WhatsApp.'
              );
            } catch (clearError) {
              logger.error(
                {
                  profile,
                  error: clearError.message
                },
                'Não foi possível limpar a autenticação antiga.'
              );
            }

            return;
          }

          setStatus(profile, 'disconnected', {
            reason: statusCode,
            message: 'Conexão do WhatsApp encerrada.'
          });

          scheduleWhatsAppReconnect(
            profile,
            connectionId
          );
        }
      });

      return {
        ok: true,
        status: getStatus(profile),
        qr: qrCache.get(profile) || null
      };

    } catch (error) {
      if (connectionIds.get(profile) === connectionId) {
        const failedSocket = sockets.get(profile);

        if (failedSocket) {
          sockets.delete(profile);

          try {
            failedSocket.end(
              new Error('Falha ao iniciar conexão.')
            );
          } catch (_) {
            try {
              failedSocket.ws?.close();
            } catch (_) {}
          }
        }

        setStatus(profile, 'disconnected', {
          message: 'Falha ao iniciar conexão.',
          reason: error.message
        });
      }

      logger.error(
        {
          profile,
          connectionId,
          error: error.message
        },
        'Erro ao iniciar WhatsApp.'
      );

      throw error;

    } finally {
      if (socketStarts.get(profile) === startPromise) {
        socketStarts.delete(profile);
      }
    }
  })();

  socketStarts.set(profile, startPromise);

  return startPromise;
}


// ======================================================
// NORMALIZAÇÃO DOS DESTINOS
// ======================================================

function publicDestination(destination) {
  const nicheId = normalizeNicheId(
    destination?.nicheId ??
    destination?.niche ??
    ''
  );

  let nicheLabel = 'Selecione manualmente';

  if (nicheId === 'all') {
    nicheLabel = 'Todos os nichos';
  } else if (nicheId) {
    const definition = NICHE_DEFINITIONS.find(
      item => item.id === nicheId
    );

    nicheLabel = definition
      ? definition.label
      : 'Selecione manualmente';
  }

  return {
    ...destination,
    nicheId,
    niche: nicheLabel
  };
}


// ======================================================
// NORMALIZAÇÃO DOS PRODUTOS
// ======================================================

function normalizeProduct(product) {
  const item = product || {};

  const priceMin =
    item.priceMin ??
    item.price ??
    item.productPrice ??
    '';

  const priceMax =
    item.priceMax ??
    '';

  const oldPrice =
    item.oldPrice ??
    item.originalPrice ??
    item.priceBeforeDiscount ??
    '';

  const discount =
    item.discount ??
    item.discountRate ??
    item.priceDiscountRate ??
    '';

  const rawCommission =
    item.commissionRate ??
    item.commission ??
    '';

  let commissionRate = '';

  if (
    rawCommission !== '' &&
    rawCommission !== null &&
    rawCommission !== undefined
  ) {
    const numericCommission = Number(rawCommission);

    if (Number.isFinite(numericCommission)) {
      const percentage =
        numericCommission <= 1
          ? numericCommission * 100
          : numericCommission;

      commissionRate =
        percentage.toLocaleString('pt-BR', {
          maximumFractionDigits: 2
        }) + '%';
    } else {
      commissionRate = String(rawCommission);
    }
  }

  const sales =
    item.sales ??
    item.soldCount ??
    '';

  const ratingStar =
    item.ratingStar ??
    item.rating ??
    '';

  return {
    id: String(
      item.id ||
      item.itemId ||
      item.productId ||
      crypto.randomUUID()
    ),

    itemId: String(
      item.itemId ||
      item.productId ||
      item.id ||
      ''
    ),

    shopId: String(
      item.shopId ||
      item.sellerId ||
      item.shop_id ||
      ''
    ),

    productName: String(
      item.productName ||
      item.name ||
      item.title ||
      'Produto Shopee'
    ),

    name: String(
      item.name ||
      item.productName ||
      item.title ||
      'Produto Shopee'
    ),

    productLink: String(
      item.productLink ||
      item.link ||
      item.url ||
      item.offerLink ||
      ''
    ),

    imageUrl: String(
      item.imageUrl ||
      item.image ||
      item.imageUrlList?.[0] ||
      ''
    ),

    price: String(priceMin),
    priceMin: String(priceMin),
    priceMax: String(priceMax),

    oldPrice: String(oldPrice),
    discount: String(discount),

    commissionRate,
    commissionRateRaw: String(rawCommission),

    sales,
    ratingStar,

    category: String(
      item.category ||
      item.categoryName ||
      ''
    ),

    description: String(
      item.description ||
      ''
    ),

    // Guarda a categoria da busca Shopee que originou a oferta.
    // Isso evita descartar produtos relevantes quando a API não
    // devolve o nome da categoria no ProductOfferV2.
    sourceNicheIds: [
      ...new Set([
        ...(Array.isArray(item.sourceNicheIds)
          ? item.sourceNicheIds
          : []),
        item.sourceNicheId
      ].map(normalizeNicheId).filter(Boolean))
    ],

    createdAt:
      item.createdAt ||
      new Date().toISOString()
  };
}


// ======================================================
function productSellerKey(product) {
  const item = product || {};
  const itemId = String(
    item.itemId || item.id || item.productId || ''
  ).trim();
  const shopId = String(
    item.shopId || item.sellerId || item.shop_id || ''
  ).trim();

  // A mesma mercadoria anunciada por outra loja é uma oferta diferente.
  if (itemId && shopId) return `${shopId}:${itemId}`;
  if (itemId) return itemId;

  return String(
    item.productLink || item.offerLink || item.productName || ''
  ).trim();
}

// TEXTO DA OFERTA
// ======================================================

function buildOfferMessage(product) {
  const item = normalizeProduct(product);
  const productName = String(
    item.productName || 'Oferta especial'
  ).trim();

  const lines = [
    '🔥 *OFERTA IMPERDÍVEL* 🔥',
    '',
    `🛍️ *${productName}*`,
    ''
  ];

  if (item.oldPrice) {
    lines.push(`❌ De: R$ ${item.oldPrice}`);
  }

  if (item.price) {
    lines.push(`✅ *POR: R$ ${item.price}*`);
  }

  if (item.discount) {
    lines.push(`🏷️ *${item.discount}*`);
  }

  if (item.productLink) {
    lines.push('');
    lines.push('🛒 *COMPRE AQUI:*');
    lines.push(item.productLink);
  }

  lines.push('');
  lines.push('⏳ Aproveite enquanto a oferta estiver disponível!');
  lines.push('');
  lines.push('💬 Compartilhe com quem também vai gostar.');

  return lines.join('\n');
}// ======================================================
// ENVIO PARA UM DESTINO WHATSAPP
// ======================================================

async function sendToDestination(
  profile,
  destination,
  product
) {
  const sock = sockets.get(profile);

  if (
    !sock ||
    getStatus(profile).status !== 'connected'
  ) {
    throw new Error(
      'WhatsApp não está conectado.'
    );
  }

  const target =
    destination?.groupId ||
    destination?.jid ||
    destination?.phone ||
    destination?.id ||
    '';

  const jid = normalizeWhatsAppJid(target);

  logger.info(
    {
      profile,
      destinationName: String(destination?.name || ''),
      destinationId: String(destination?.id || ''),
      groupId: String(destination?.groupId || ''),
      rawTarget: String(target || ''),
      jid
    },
    'Destino WhatsApp resolvido para envio.'
  );

  if (!jid) {
    throw new Error(
      'Número ou ID do grupo inválido.'
    );
  }

  const item = normalizeProduct(product);
  const caption = buildOfferMessage(item);
  const productKey = productSellerKey(item) ||
    String(item.itemId || item.id || item.productName || 'produto-sem-chave');
  const sendKey = `${profile}:${productKey}:${jid}`;

  // Se o Baileys ainda estiver processando uma tentativa anterior,
  // não inicia outro envio para o mesmo produto/grupo.
  const previousAttempt = inFlightWhatsAppSends.get(sendKey);

  if (previousAttempt) {
    if (!previousAttempt.settled) {
      const pendingError = new Error(
        'O WhatsApp ainda está processando a tentativa anterior para este grupo; evitando envio duplicado.'
      );
      pendingError.code = 'WHATSAPP_SEND_PENDING';
      throw pendingError;
    }

    inFlightWhatsAppSends.delete(sendKey);

    if (previousAttempt.error) {
      throw previousAttempt.error;
    }

    if (previousAttempt.result) {
      logger.info(
        { profile, jid, messageId: previousAttempt.result?.key?.id || null },
        'Envio anterior foi confirmado após o tempo limite; não será enviada uma cópia.'
      );
      return previousAttempt.result;
    }
  }

  const sendPromise = (async () => {
    if (
      item.imageUrl &&
      /^https?:\/\//i.test(item.imageUrl)
    ) {
      try {
        return await sock.sendMessage(
          jid,
          {
            image: {
              url: item.imageUrl
            },
            caption
          }
        );
      } catch (error) {
        logger.warn(
          {
            profile,
            jid,
            error: error.message
          },
          'Falha ao enviar imagem; tentando enviar texto.'
        );

        return await sock.sendMessage(
          jid,
          {
            text: caption
          }
        );
      }
    }

    return await sock.sendMessage(
      jid,
      {
        text: caption
      }
    );
  })();

  const attempt = {
    promise: sendPromise,
    settled: false,
    result: null,
    error: null
  };

  inFlightWhatsAppSends.set(sendKey, attempt);

  // Registra a conclusão mesmo se o ciclo principal já tiver atingido
  // o limite de espera. O próximo ciclo poderá recuperar o resultado
  // sem repetir uma mensagem que tenha sido aceita tardiamente.
  sendPromise.then(
    result => {
      attempt.settled = true;
      attempt.result = result;
    },
    error => {
      attempt.settled = true;
      attempt.error = error;
    }
  );

  let result;

  try {
    result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(
          'O WhatsApp demorou mais de 45 segundos para responder. A tentativa continuará sendo acompanhada sem gerar envio duplicado.'
        );
        error.code = 'WHATSAPP_SEND_PENDING';
        reject(error);
      }, 45000);

      timer.unref?.();

      sendPromise.then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  } catch (error) {
    if (error.code !== 'WHATSAPP_SEND_PENDING') {
      inFlightWhatsAppSends.delete(sendKey);
    } else {
      logger.warn(
        { profile, jid, productKey },
        'Envio WhatsApp excedeu o tempo de espera; o restante dos grupos continuará e esta tentativa será acompanhada.'
      );
    }

    throw error;
  }

  inFlightWhatsAppSends.delete(sendKey);

  logger.info(
    {
      profile,
      jid,
      messageId: result?.key?.id || null
    },
    'Mensagem aceita pelo WhatsApp para envio.'
  );

  return result;
}


// ======================================================
// CREDENCIAIS DA SHOPEE
// ======================================================

function getShopeeCredentials(profile) {
  const data = getData(profile);

  const saved = decryptObject(
    data.shopeeCredentials
  );

  return {
    appId: String(
      saved?.appId ||
      process.env.SHOPEE_APP_ID ||
      process.env.SHOPEE_PARTNER_ID ||
      ''
    ),

    appSecret: String(
      saved?.appSecret ||
      process.env.SHOPEE_APP_SECRET ||
      process.env.SHOPEE_PARTNER_KEY ||
      ''
    )
  };
}


// ======================================================
// REQUISIÇÃO GRAPHQL DA SHOPEE
// ======================================================

async function shopeeGraphQL(
  profile,
  query,
  variables = {}
) {
  const credentials = getShopeeCredentials(profile);

  if (!credentials.appId || !credentials.appSecret) {
    throw new Error(
      'Configure o App ID e o App Secret da Shopee.'
    );
  }

  const endpoint =
    process.env.SHOPEE_API_URL ||
    'https://open-api.affiliate.shopee.com.br/graphql';

  // A Shopee 10000 is an internal provider error. Retry for longer with
  // exponential backoff because short retries can all hit the same outage window.
  const maxAttempts = 5;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ query, variables });

    // A assinatura é refeita em cada tentativa para usar
    // um timestamp novo, conforme exigido pela API.
    const signature = crypto
      .createHash('sha256')
      .update(
        `${credentials.appId}${timestamp}${payload}${credentials.appSecret}`
      )
      .digest('hex');

    const authorization =
      `SHA256 Credential=${credentials.appId}, ` +
      `Timestamp=${timestamp}, ` +
      `Signature=${signature}`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authorization
        },
        body: payload,
        signal: AbortSignal.timeout(30000)
      });

      const responseText = await response.text();
      let result;

      try {
        result = JSON.parse(responseText);
      } catch (_) {
        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status}: a Shopee retornou uma resposta temporariamente inválida.`
          );
        }

        throw new Error(
          'A Shopee retornou uma resposta inválida.'
        );
      }

      const graphErrors = Array.isArray(result?.errors)
        ? result.errors
            .map(item => item?.message || item?.error)
            .filter(Boolean)
        : [];

      const apiError =
        (typeof result?.error === 'string' && result.error) ||
        result?.error?.message ||
        result?.message ||
        graphErrors.join('; ');

      if (!response.ok || apiError) {
        const message = String(
          apiError ||
          `Erro HTTP da Shopee: ${response.status}`
        );

        const errorCode =
          message.match(/\b(?:error\s*)?\[?(\d{4,})\]?/i)?.[1] || '';

        const retryable =
          errorCode === '10000' ||
          /system error|temporar|timeout|rate.?limit/i.test(message) ||
          [408, 425, 429, 500, 502, 503, 504].includes(response.status);

        if (retryable && attempt < maxAttempts) {
          logger.warn(
            {
              profile,
              attempt,
              maxAttempts,
              httpStatus: response.status,
              errorCode: errorCode || null,
              error: message
            },
            'Erro temporário na API Shopee; nova tentativa será realizada.'
          );

          await sleep(Math.min(15000, 2000 * (2 ** (attempt - 1))));
          continue;
        }

        throw new Error(message);
      }

      return result?.data || result;

    } catch (error) {
      lastError = error;

      const message = String(error?.message || error);
      const retryable =
        error?.name === 'AbortError' ||
        error?.name === 'TimeoutError' ||
        /fetch failed|network|socket|timeout|system error|error \[10000\]|\bHTTP (?:408|425|429|5\d{2})\b/i.test(message);

      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }

      logger.warn(
        {
          profile,
          attempt,
          maxAttempts,
          error: message
        },
        'Falha temporária ao consultar a Shopee; repetindo a consulta.'
      );

      await sleep(Math.min(15000, 2000 * (2 ** (attempt - 1))));
    }
  }

  throw lastError || new Error('Não foi possível consultar a API Shopee.');
}

// ======================================================
// BUSCAR OFERTAS NA SHOPEE
// ======================================================

async function fetchShopeeOffers(
  profile,
  limit = 10,
  keyword = '',
  page = 1
) {
  const safeLimit = Math.max(
    1,
    Math.min(50, Number(limit) || 10)
  );

  const safeKeyword = String(
    keyword || ''
  ).trim();

  const safePage = Math.max(
    1,
    Math.min(20, Math.floor(Number(page) || 1))
  );

  const query = `
    query ProductOffer(
      $limit: Int!,
      $keyword: String,
      $page: Int!
    ) {
      productOfferV2(
        keyword: $keyword,
        listType: 0,
        sortType: 2,
        page: $page,
        limit: $limit
      ) {
        nodes {
          productName
          itemId
          shopId
          priceMin
          priceMax
          priceDiscountRate
          imageUrl
          productLink
          offerLink
          sales
          ratingStar
          commissionRate
        }
      }
    }
  `;

  const result = await shopeeGraphQL(
    profile,
    query,
    {
      limit: safeLimit,
      keyword: safeKeyword || null,
      page: safePage
    }
  );

  const nodes =
    result?.productOfferV2?.nodes ||
    result?.productOfferV2?.products ||
    [];

  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes.map(item => {
    return normalizeProduct({
      id: item.itemId,
      itemId: item.itemId,
      shopId: item.shopId,

      productName: item.productName,
      name: item.productName,

      priceMin: item.priceMin,
      priceMax: item.priceMax,

      discount:
        item.priceDiscountRate !== undefined &&
        item.priceDiscountRate !== null
          ? `${item.priceDiscountRate}% OFF`
          : '',

      imageUrl: item.imageUrl,

      productLink:
        item.offerLink ||
        item.productLink ||
        '',

      sales: item.sales,
      ratingStar: item.ratingStar,
      commissionRate: item.commissionRate,

      category: '',
      description: ''
    });
  });
}


// ======================================================
// BUSCA DE OFERTAS POR NICHO SELECIONADO
// ======================================================

// A API de afiliados usada aqui não devolve o nome da categoria.
// Por isso, a busca é feita com a palavra-chave do nicho escolhido
// manualmente para os grupos. O nicho de origem fica registrado
// no produto e é usado somente quando o título não permite classificar.

const NICHE_SEARCH_KEYWORDS = {
  eletricos: 'eletrônicos',
  perfumaria: 'perfume',
  beleza: 'maquiagem',
  moda_feminina: 'moda feminina',
  moda_masculina: [
    'roupa masculina',
    'camiseta masculina',
    'bermuda masculina',
    'camisa masculina',
    'calça masculina'
  ],
  moda_infantil: 'roupa infantil',
  calcados: 'calçados',
  casa: [
    'utilidades domésticas',
    'organizador para casa',
    'itens para casa',
    'limpeza doméstica',
    'organização doméstica',
    'acessórios para banheiro',
    'lavanderia'
  ],
  cozinha: 'cozinha',
  decoracao: 'decoração',
  fitness: 'fitness',
  pet: [
    'pet',
    'ração para pássaros',
    'produtos para aves',
    'calopsita',
    'ração para cachorro',
    'ração para gato',
    'gaiola para pássaros',
    'alpiste'
  ],
  brinquedos: 'brinquedos',
  acessorios: 'acessórios'
};

async function fetchShopeeOffersForNiches(
  profile,
  limit,
  nicheIds
) {
  const niches = [...new Set(
    (Array.isArray(nicheIds) ? nicheIds : [])
      .map(normalizeNicheId)
      .filter(nicheId => nicheId && nicheId !== 'all')
  )];

  if (!niches.length) {
    return fetchShopeeOffers(profile, limit);
  }

  const totalLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const selectedNiches = niches;
  // Mantém uma lista separada por nicho para que o primeiro nicho
  // não ocupe sozinho todo o limite e deixe os demais sem ofertas.
  const offersByNiche = new Map();
  const nicheErrors = [];
  const data = getData(profile);

  if (!data.automation || typeof data.automation !== 'object') {
    data.automation = {};
  }

  if (
    !data.automation.nicheSearchPages ||
    typeof data.automation.nicheSearchPages !== 'object'
  ) {
    data.automation.nicheSearchPages = {};
  }

  // Busca uma quantidade maior por nicho e alterna as páginas da API.
  // Assim, a automação não fica presa repetindo sempre os mesmos primeiros produtos.
  const nicheLimit = Math.max(20, Math.min(50, totalLimit * 2));

  const processNiche = async (nicheId) => {
    const configuredKeywords = NICHE_SEARCH_KEYWORDS[nicheId];
    const keywords = Array.isArray(configuredKeywords)
      ? configuredKeywords
      : [configuredKeywords].filter(Boolean);

    if (!keywords.length) {
      return { nicheId, offers: [], accepted: 0, rejected: 0 };
    }

    const nicheOffers = new Map();
    let acceptedForNiche = 0;
    let rejectedForNiche = 0;

    // Os termos de um nicho continuam sequenciais para não sobrecarregar
    // a API, mas nichos diferentes são pesquisados em pequenos lotes.
    for (const keyword of keywords) {
      const pageKey = `${nicheId}:${keyword}`;
      const page = Math.max(
        1,
        Math.min(5, Number(data.automation.nicheSearchPages[pageKey]) || 1)
      );

      let offers = [];

      try {
        offers = await fetchShopeeOffers(
          profile,
          nicheLimit,
          keyword,
          page
        );

        data.automation.nicheSearchPages[pageKey] =
          page >= 5 ? 1 : page + 1;
      } catch (error) {
        nicheErrors.push({ nicheId, keyword, message: error.message });

        logger.warn(
          { profile, nicheId, keyword, error: error.message },
          'Falha em um termo de busca; os demais termos e nichos continuarão.'
        );

        continue;
      }

      for (const offer of offers) {
        let detectedNiches = classifyProductNiches(offer);

        if (!detectedNiches.length) {
          detectedNiches = [nicheId];
        }

        if (!detectedNiches.includes(nicheId)) {
          rejectedForNiche++;
          continue;
        }

        const key = productSellerKey(offer);
        if (!key || nicheOffers.has(key)) continue;

        const legacyItemKey = String(
          offer.itemId || offer.id || offer.productId || ''
        ).trim();
        const previous =
          data.sentProducts?.[key] ||
          (legacyItemKey ? data.sentProducts?.[legacyItemKey] : null);
        let previousDate = 0;

        if (typeof previous === 'string') {
          previousDate = Date.parse(previous) || 0;
        } else if (previous && typeof previous === 'object') {
          previousDate = Date.parse(
            previous.sentAt || previous.date || ''
          ) || 0;
        }

        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

        if (previousDate > sevenDaysAgo) {
          rejectedForNiche++;
          continue;
        }

        const queuedRecently = data.queue.some(item => {
          if (!['pending', 'processing'].includes(item.status)) return false;
          return productSellerKey(item.product || item) === key;
        });

        if (queuedRecently) {
          rejectedForNiche++;
          continue;
        }

        acceptedForNiche++;

        nicheOffers.set(key, normalizeProduct({
          ...offer,
          sourceNicheIds: [nicheId]
        }));
      }

      logger.info(
        {
          profile,
          nicheId,
          keyword,
          page,
          requestedLimit: nicheLimit,
          offersReturned: offers.length
        },
        'Busca específica do nicho concluída.'
      );

      if (nicheOffers.size >= totalLimit) break;
    }

    const offers = [...nicheOffers.values()];

    logger.info(
      {
        profile,
        nicheId,
        keywords,
        requestedLimit: nicheLimit,
        acceptedForNiche,
        rejectedForNiche,
        uniqueOffers: offers.length
      },
      'Resultado consolidado da busca por nicho.'
    );

    return {
      nicheId,
      offers,
      accepted: acceptedForNiche,
      rejected: rejectedForNiche
    };
  };

  // Até três nichos são pesquisados ao mesmo tempo. Isso evita que
  // buscas demoradas de um nicho segurem todos os demais e atrasem
  // o início dos envios, sem disparar dezenas de consultas simultâneas.
  const nicheResults = new Map();
  let nextNicheIndex = 0;
  const workerCount = Math.min(3, selectedNiches.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextNicheIndex < selectedNiches.length) {
        const nicheId = selectedNiches[nextNicheIndex++];
        const result = await processNiche(nicheId);
        nicheResults.set(nicheId, result.offers);
      }
    })
  );

  for (const nicheId of selectedNiches) {
    offersByNiche.set(nicheId, nicheResults.get(nicheId) || []);
  }

  const results = [];
  const seenOffers = new Set();
  const cursors = new Map(selectedNiches.map(nicheId => [nicheId, 0]));

  // Distribuição em rodízio: pega uma oferta de cada nicho por vez.
  // Assim, um nicho com muitos resultados não elimina os outros pelo slice.
  while (results.length < totalLimit) {
    let addedInRound = false;

    for (const nicheId of selectedNiches) {
      if (results.length >= totalLimit) break;

      const nicheOffers = offersByNiche.get(nicheId) || [];
      const cursor = cursors.get(nicheId) || 0;

      if (cursor >= nicheOffers.length) continue;

      const offer = nicheOffers[cursor];
      cursors.set(nicheId, cursor + 1);

      const key = productSellerKey(offer);
      if (!key || seenOffers.has(key)) continue;

      seenOffers.add(key);
      results.push(offer);
      addedInRound = true;
    }

    if (!addedInRound) break;
  }

  const distribution = Object.fromEntries(
    selectedNiches.map(nicheId => [
      nicheId,
      results.filter(product =>
        (product.sourceNicheIds || []).includes(nicheId)
      ).length
    ])
  );

  logger.info(
    {
      profile,
      selectedNiches,
      productsReturned: results.length,
      distribution
    },
    'Distribuição equilibrada de ofertas por nicho.'
  );

  if (!results.length && nicheErrors.length) {
    throw new Error(
      `A Shopee falhou em todos os nichos consultados: ${nicheErrors
        .map(item => `${item.nicheId}: ${item.message}`)
        .join(' | ')}`
    );
  }

  if (nicheErrors.length) {
    logger.warn(
      {
        profile,
        failedNiches: nicheErrors.map(item => item.nicheId),
        productsFound: results.length
      },
      'Busca parcial concluída; ofertas dos nichos disponíveis serão processadas.'
    );
  }

  return results;
}


// ======================================================
// PROCESSAMENTO DA FILA DE OFERTAS
// ======================================================

async function processQueue(profile) {
  const data = getData(profile);

  const now = Date.now();
  const current = data.queue.find(item =>
    item.status === 'pending' &&
    (!item.retryAfterAt || (Date.parse(item.retryAfterAt) || 0) <= now)
  );

  if (!current) {
    return {
      ok: false,
      status: 'waiting',
      message: 'Não há ofertas prontas para nova tentativa neste ciclo.'
    };
  }

  current.status = 'processing';
  current.startedAt = new Date().toISOString();

  await saveProfile(profile);

  const product = normalizeProduct(
    current.product || current
  );

  const targets = getAutomationTargets(data);
  const results = [];

  try {
    if (!targets.length) {
      throw new Error(
        'Nenhum grupo ou destino está selecionado.'
      );
    }

    // Filtra os destinos pelo nicho escolhido manualmente.
    // Nenhum nome de grupo é usado nessa comparação.
    const compatibleTargets = [];

    for (const destination of targets) {
      const match = destinationMatchesProduct(
        destination,
        product
      );

      logger.info(
        {
          profile,
          product: String(
            product.productName ||
            product.name ||
            product.title ||
            'Produto sem nome'
          ).slice(0, 180),
          destination: String(
            destination.name ||
            destination.groupId ||
            destination.id ||
            ''
          ),
          selectedNiche: normalizeNicheId(
            destination?.nicheId ??
            destination?.niche ??
            ''
          ),
          detectedProductNiches: classifyProductNiches(product),
          matches: match.matches,
          reason: match.reason
        },
        'Diagnóstico de compatibilidade da oferta com o grupo.'
      );

      if (match.matches) {
        compatibleTargets.push(destination);
      } else {
        results.push({
          destination:
            destination.name ||
            destination.id ||
            destination.groupId,

          status: 'skipped',
          reason: match.reason
        });
      }
    }

    // Se nenhum destino for compatível, não envia a oferta.
    if (!compatibleTargets.length) {
      current.status = 'skipped';

      current.error =
        'Nenhum destino selecionado possui nicho compatível com este produto.';

      current.results = results;
      current.product = product;
      current.finishedAt = new Date().toISOString();

      await saveProfile(profile);

      return {
        ok: false,
        status: 'skipped',
        message: current.error,
        results
      };
    }

    // Mantém os grupos que já receberam esta oferta registrados.
    // Em uma nova tentativa, não duplica a mensagem nesses grupos.
    const previousAccepted = Array.isArray(current.results)
      ? current.results.filter(item => item.status === 'accepted')
      : [];

    const wasAlreadyAccepted = destination => {
      const destinationId = normalizeGroupId(
        destination.groupId || destination.id || ''
      );
      const destinationName = String(
        destination.name || destination.groupId || destination.id || ''
      ).trim();

      return previousAccepted.some(item => {
        const previousId = normalizeGroupId(
          item.destinationId || item.groupId || ''
        );
        const previousName = String(item.destination || '').trim();

        return (
          (destinationId && previousId && destinationId === previousId) ||
          (!previousId && destinationName && previousName === destinationName)
        );
      });
    };

    const acceptedResults = [...previousAccepted];
    const pendingTargets = compatibleTargets.filter(
      destination => !wasAlreadyAccepted(destination)
    );

    // Envia para todos os grupos compatíveis que ainda não receberam.
    for (const destination of pendingTargets) {
      const destinationId = normalizeGroupId(
        destination.groupId || destination.id || ''
      );
      const destinationName =
        destination.name ||
        destination.id ||
        destination.groupId;

      try {
        const sent = await sendToDestination(
          profile,
          destination,
          product
        );

        acceptedResults.push({
          destination: destinationName,
          destinationId,
          status: 'accepted',
          messageId: sent?.key?.id || null,
          acceptedAt: new Date().toISOString()
        });

      } catch (error) {
        results.push({
          destination: destinationName,
          destinationId,
          status: 'error',
          message: error.message,
          attemptedAt: new Date().toISOString()
        });

        logger.warn(
          {
            profile,
            destination: destinationName,
            destinationId,
            error: error.message
          },
          'Falha em um grupo; a oferta permanecerá na fila para nova tentativa.'
        );
      }

      await sleep(1800);
    }

    const errors = results.filter(
      item => item.status === 'error'
    );
    const allDelivered = pendingTargets.length === 0 || errors.length === 0;

    current.results = [...acceptedResults, ...errors];
    current.product = product;
    current.lastAttemptAt = new Date().toISOString();
    current.attempts = (Number(current.attempts) || 0) + 1;

    if (allDelivered && acceptedResults.length > 0) {
      current.status = 'sent';
      current.sentAt = new Date().toISOString();
      current.finishedAt = current.sentAt;
      current.error = null;

      const key = productSellerKey(product);
      if (key) {
        data.sentProducts[key] = {
          sentAt: current.sentAt,
          productName: product.productName
        };
      }

      data.automation.lastSentAt = current.sentAt;

    } else if (errors.length > 0) {
      // Falhas ficam isoladas nesta oferta e aguardam o próximo intervalo.
      // A fila pode continuar processando outras ofertas/grupos sem ficar presa.
      current.status = 'pending';
      current.retryAfterAt = new Date(
        Date.now() + getAutomationIntervalMs(data.automation || {})
      ).toISOString();
      current.error = errors
        .map(item => item.destination + ': ' + item.message)
        .join('; ');
      current.finishedAt = null;

    } else {
      current.status = 'skipped';
      current.error =
        'Nenhum grupo recebeu a oferta por incompatibilidade de nicho.';
      current.finishedAt = new Date().toISOString();
    }

    await saveProfile(profile);

    return {
      ok: current.status === 'sent',
      status: errors.length > 0 ? 'retry' : current.status,
      accepted: acceptedResults.length,
      pending: errors.length,
      results: current.results
    };

  } catch (error) {
    current.status = 'error';
    current.error = error.message;
    current.results = results;
    current.finishedAt = new Date().toISOString();

    await saveProfile(profile);

    return {
      ok: false,
      status: 'error',
      message: error.message,
      results
    };
  }
}


// ======================================================
// CONFIGURAÇÕES DA AUTOMAÇÃO
// ======================================================

function isAutomationActive(automation) {
  return Boolean(
    automation?.active ||
    automation?.enabled
  );
}

function getAutomationIntervalMs(automation) {
  const seconds = Number(
    automation?.intervalSeconds
  );

  if (
    Number.isFinite(seconds) &&
    seconds > 0
  ) {
    return Math.max(
      10000,
      Math.min(86400000, seconds * 1000)
    );
  }

  const minutes = Number(
    automation?.intervalMinutes
  );

  return Math.max(
    60000,
    Math.min(
      86400000,
      (Number.isFinite(minutes) && minutes > 0
        ? minutes
        : 30) * 60000
    )
  );
}

function currentTimeInAutomationZone() {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: AUTOMATION_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(new Date());

  } catch (_) {
    return new Date().toTimeString().slice(0, 5);
  }
}

function isInsideAutomationWindow(automation) {
  const start = String(
    automation?.startTime || ''
  ).trim();

  const end = String(
    automation?.endTime || ''
  ).trim();

  if (!start && !end) return true;

  const validTime = value =>
    /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

  if (
    !validTime(start) ||
    !validTime(end)
  ) {
    return true;
  }

  const now = currentTimeInAutomationZone();

  const currentMinutes =
    Number(now.slice(0, 2)) * 60 +
    Number(now.slice(3, 5));

  const startMinutes =
    Number(start.slice(0, 2)) * 60 +
    Number(start.slice(3, 5));

  const endMinutes =
    Number(end.slice(0, 2)) * 60 +
    Number(end.slice(3, 5));

  if (startMinutes === endMinutes) {
    return true;
  }

  if (startMinutes < endMinutes) {
    return (
      currentMinutes >= startMinutes &&
      currentMinutes <= endMinutes
    );
  }

  return (
    currentMinutes >= startMinutes ||
    currentMinutes <= endMinutes
  );
}


// ======================================================
// EXECUTAR AUTOMAÇÃO
// ======================================================

async function runAutomation(profile) {
  if (automationLocks.has(profile)) {
    return {
      ok: false,
      message: 'Automação já está em execução.'
    };
  }

  automationLocks.add(profile);

  logger.info(
    { profile },
    'Iniciando ciclo da automação.'
  );

  const data = getData(profile);
  const automation = data.automation || {};

  try {
    if (!isAutomationActive(automation)) {
      return {
        ok: false,
        message: 'Automação está desativada.'
      };
    }

    if (!isInsideAutomationWindow(automation)) {
      return {
        ok: false,
        message: 'Fora do horário configurado.'
      };
    }

    if (getStatus(profile).status !== 'connected') {
      throw new Error(
        'Conecte o WhatsApp antes de executar a automação.'
      );
    }

    const destinations = getAutomationTargets(data);

    if (!destinations.length) {
      throw new Error(
        'Nenhum grupo ou destino foi selecionado.'
      );
    }

    // O intervalo é contado desde o início deste ciclo, e não do fim
    // das buscas/envios. Assim, uma execução demorada não empurra o próximo
    // horário programado ainda mais para frente.
    const cycleStartedAt = new Date().toISOString();
    automation.lastRunAt = cycleStartedAt;
    await saveProfile(profile);

    // PRIORIDADE: esvazia a fila que já estava pendente ANTES de consultar
    // a Shopee. Uma busca lenta ou erro externo não deve segurar ofertas prontas.
    let preprocessedQueueItems = 0;

    const hasReadyPendingItem = () => data.queue.some(item =>
      item.status === 'pending' &&
      (!item.retryAfterAt || (Date.parse(item.retryAfterAt) || 0) <= Date.now())
    );

    while (
      hasReadyPendingItem() &&
      preprocessedQueueItems < 100
    ) {
      const pendingResult = await processQueue(profile);
      preprocessedQueueItems++;

      if (pendingResult.status === 'waiting') break;

      // Uma oferta com erro fica em espera própria; não bloqueia as demais.
      await sleep(1500);
    }

    if (preprocessedQueueItems > 0) {
      logger.info(
        { profile, preprocessedQueueItems, queueBlockedByRetry },
        'Fila anterior priorizada antes das novas buscas da Shopee.'
      );
    }

    const maxProducts = Math.max(
      1,
      Math.min(
        50,
        Number(automation.maxProducts) || 10
      )
    );

    const selectedNiches = [
      ...new Set(
        destinations
          .map(destination => normalizeNicheId(
            destination?.nicheId ?? destination?.niche ?? ''
          ))
          .filter(Boolean)
      )
    ];

    const hasAllNichesDestination = selectedNiches.includes('all');

    const allNichesPage = Math.max(
      1,
      Math.min(5, Number(automation.searchPage) || 1)
    );

    // Reserva pelo menos uma oferta para cada nicho selecionado,
    // mesmo quando existem mais nichos do que o limite padrão do painel.
    const searchLimit = Math.max(
      maxProducts,
      Math.min(50, selectedNiches.length)
    );

    let products;

    if (hasAllNichesDestination) {
      // O destino "Todos os nichos" recebe ofertas gerais, mas os demais
      // grupos continuam precisando de produtos pesquisados por categoria.
      // Antes, a presença de um único destino "all" fazia o sistema buscar
      // somente ofertas gerais e podia repetir os mesmos produtos por ciclos.
      const specificNiches = selectedNiches.filter(
        nicheId => nicheId !== 'all'
      );

      const generalOffers = await fetchShopeeOffers(
        profile,
        maxProducts,
        '',
        allNichesPage
      );

      const nicheOffers = specificNiches.length
        ? await fetchShopeeOffersForNiches(
            profile,
            searchLimit,
            specificNiches
          )
        : [];

      const mergedOffers = new Map();

      for (const offer of [...generalOffers, ...nicheOffers]) {
        const key = productSellerKey(offer);
        if (!key || mergedOffers.has(key)) continue;
        mergedOffers.set(key, offer);
      }

      products = [...mergedOffers.values()].slice(0, 50);

      automation.searchPage =
        allNichesPage >= 5 ? 1 : allNichesPage + 1;

      logger.info(
        {
          profile,
          generalOffers: generalOffers.length,
          nicheOffers: nicheOffers.length,
          mergedOffers: products.length,
          searchedNiches: specificNiches
        },
        'Ofertas gerais e ofertas por nicho foram combinadas.'
      );
    } else {
      products = await fetchShopeeOffersForNiches(
        profile,
        searchLimit,
        selectedNiches
      );
    }

    logger.info(
      {
        profile,
        selectedNiches,
        hasAllNichesDestination,
        productsFound: products.length
      },
      'Busca de ofertas preparada para os nichos selecionados.'
    );

    const hasPendingQueue = data.queue.some(
      item => item.status === 'pending'
    );

    if (!products.length && !hasPendingQueue) {
      throw new Error(
        'A Shopee não retornou ofertas e não existem envios pendentes.'
      );
    }

    // Recupera ofertas antigas que foram marcadas como enviadas
    // apesar de um ou mais grupos terem falhado no envio.
    for (const item of data.queue) {
      if (
        item.status === 'sent' &&
        Array.isArray(item.results) &&
        item.results.some(result => result.status === 'error')
      ) {
        item.status = 'pending';
        item.finishedAt = null;
        item.error = 'Retomando envio para os grupos que falharam.';
        const key = item.productKey || productSellerKey(item.product || item);
        if (key && data.sentProducts[key]) {
          delete data.sentProducts[key];
        }
      }
    }

    const sevenDaysAgo =
      Date.now() - (7 * 24 * 60 * 60 * 1000);

    let queued = 0;
    let duplicated = 0;

    for (const product of products) {
      const productKey = productSellerKey(product);

      // Mantém no catálogo os produtos encontrados pela automação,
      // para que o indicador do painel reflita as ofertas processadas.
      if (productKey) {
        const existsInCatalog = data.products.some(item =>
          productSellerKey(item) === productKey
        );
        if (!existsInCatalog) {
          data.products.unshift(product);
        }
        data.products = data.products.slice(0, 500);
      }

      // Lê também registros antigos salvos apenas pelo itemId.
      const legacyItemKey = String(
        product.itemId || product.id || product.productId || ''
      ).trim();
      const previous =
        data.sentProducts[productKey] ||
        (legacyItemKey ? data.sentProducts[legacyItemKey] : null);

      let previousDate = 0;

      if (typeof previous === 'string') {
        previousDate = Date.parse(previous) || 0;

      } else if (
        previous &&
        typeof previous === 'object'
      ) {
        previousDate = Date.parse(
          previous.sentAt ||
          previous.date ||
          ''
        ) || 0;
      }

      if (previousDate > sevenDaysAgo) {
        duplicated++;
        continue;
      }

      const alreadyQueued = data.queue.some(item => {
        const itemKey = productSellerKey(
          item.product || item
        );

        return (
          itemKey === productKey &&
          ['pending', 'processing'].includes(item.status)
        );
      });

      if (alreadyQueued) {
        duplicated++;
        continue;
      }

      data.queue.push({
        id: crypto.randomUUID(),
        product,
        productKey,
        status: 'pending',
        source: 'automation',
        createdAt: new Date().toISOString()
      });

      queued++;
    }

    await saveProfile(profile);

    let processed = 0;
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    while (
      hasReadyPendingItem() &&
      processed < 100
    ) {
      const result = await processQueue(profile);

      if (result.status === 'waiting') break;

      processed++;

      if (result.status === 'sent') {
        sent++;
      } else if (result.status === 'retry') {
        failed++;
        // A oferta com falha já recebeu retryAfterAt; prossiga para as outras.
      } else if (result.status === 'error') {
        failed++;
      } else if (result.status === 'skipped') {
        skipped++;
      }

      await sleep(1500);
    }

    automation.lastError = null;

    await saveProfile(profile);

    logger.info(
      {
        profile,
        productsFound: products.length,
        queued,
        duplicated,
        sent,
        failed,
        skipped
      },
      'Execução da automação finalizada.'
    );

    return {
      ok: true,
      productsFound: products.length,
      queued,
      duplicated,
      processed,
      sent,
      failed,
      skipped,
      message: 'Automação finalizada.'
    };

  } catch (error) {
    automation.lastError = error.message;

    await saveProfile(profile);

    logger.error(
      {
        profile,
        error: error.message
      },
      'Erro durante a automação.'
    );

    return {
      ok: false,
      message: error.message
    };

  } finally {
    automationLocks.delete(profile);
  }
}


// ======================================================
// AGENDADOR AUTOMÁTICO
// ======================================================

function getAutomationMinuteKey(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: AUTOMATION_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(date).replace(' ', 'T');

  } catch (_) {
    return date.toISOString().slice(0, 16);
  }
}

async function automationSchedulerTick() {
  for (const profile of PROFILE_IDS) {
    try {
      const data = getData(profile);
      const automation = data.automation || {};

      if (!isAutomationActive(automation)) continue;
      if (!isInsideAutomationWindow(automation)) continue;
      if (automationLocks.has(profile)) continue;

      if (getStatus(profile).status !== 'connected') {
        continue;
      }

      const scheduleTimes = Array.isArray(
        automation.scheduleTimes
      )
        ? automation.scheduleTimes
        : [];

      const now = currentTimeInAutomationZone();
      const minuteKey = getAutomationMinuteKey();

      // O painel atual usa startTime/endTime como janela de funcionamento
      // e intervalSeconds como frequência. Uma única scheduleTime antiga
      // representa o início da janela, não um disparo único diário.
      // Mantemos horários fixos somente quando houver dois ou mais horários
      // explicitamente configurados (compatibilidade com configurações antigas).
      if (scheduleTimes.length > 1) {
        const alreadyRan =
          automation.lastScheduleMinute === minuteKey;

        if (
          scheduleTimes.includes(now) &&
          !alreadyRan
        ) {
          automation.lastScheduleMinute = minuteKey;

          await saveProfile(profile);
          await runAutomation(profile);
        }

        continue;
      }

      const intervalMs =
        getAutomationIntervalMs(automation);

      const lastRun = automation.lastRunAt
        ? new Date(automation.lastRunAt).getTime()
        : 0;

      const elapsed = Date.now() - lastRun;

      if (!lastRun || elapsed >= intervalMs) {
        await runAutomation(profile);
      }

    } catch (error) {
      logger.error(
        {
          profile,
          error: error.message
        },
        'Erro no agendador da automação.'
      );
    }
  }
}


// ======================================================
// ROTA DE SAÚDE
// ======================================================

// ======================================================
// SEGURANÇA E CONTROLE DE ACESSO DOS PERFIS
// ======================================================

function passwordMatchesSecret(secret, value) {
  const configured = String(secret || '');
  const supplied = String(value || '');
  if (!configured) return false;

  const expectedDigest = crypto.createHash('sha256').update(configured).digest();
  const suppliedDigest = crypto.createHash('sha256').update(supplied).digest();
  return crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

function isValidAdminPassword(value) {
  return passwordMatchesSecret(process.env.ADMIN_PASSWORD, value);
}

function isValidProfilePassword(profile, value) {
  if (profile === 'usuario2') {
    return passwordMatchesSecret(process.env.PROFILE_2_PASSWORD, value);
  }
  return false;
}

app.use((req, res, next) => {
  if (req.path === '/health' || (req.method === 'GET' && req.path === '/')) return next();

  const suppliedPassword = req.headers['x-admin-password'];
  const admin = isValidAdminPassword(suppliedPassword);
  const requestedProfile = profileIdFrom(req);
  const profileUser = isValidProfilePassword('usuario2', suppliedPassword);

  if (req.path === '/api/profiles') {
    if (admin || profileUser) return next();
    return res.status(401).json({
      ok: false,
      message: 'Senha inválida.'
    });
  }

  if (req.path.startsWith('/api/admin/')) {
    if (!admin) {
      return res.status(403).json({
        ok: false,
        message: 'Somente o administrador pode gerenciar os acessos.'
      });
    }
    return next();
  }

  if (!admin && (!profileUser || requestedProfile !== 'usuario2')) {
    return res.status(401).json({
      ok: false,
      message: 'Senha ou perfil inválido.'
    });
  }

  if (getData(requestedProfile).accessEnabled === false) {
    return res.status(403).json({
      ok: false,
      accessBlocked: true,
      message: 'Acesso deste perfil bloqueado pelo administrador.'
    });
  }

  next();
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'MEDEIROS DIGITAL',

    whatsapp: PROFILE_IDS.map(profile => ({
      profile,
      status: getStatus(profile).status
    })),

    timestamp: new Date().toISOString()
  });
});


// ======================================================
// ROTAS DE PERFIS
// ======================================================

app.get('/api/profiles', (req, res) => {
  const suppliedPassword = req.headers['x-admin-password'];
  const admin = isValidAdminPassword(suppliedPassword);

  if (admin) {
    return res.json({
      ok: true,
      role: 'admin',
      profiles: PROFILE_IDS
    });
  }

  return res.json({
    ok: true,
    role: 'profile',
    profiles: ['usuario2'],
    enabled: getData('usuario2').accessEnabled !== false
  });
});

app.get('/api/admin/profiles', (req, res) => {
  res.json({
    ok: true,
    profiles: PROFILE_IDS.map(profile => ({
      id: profile,
      label: profile === 'rafael' ? 'Perfil 1 — Rafael' : 'Perfil 2 — Segundo usuário',
      enabled: getData(profile).accessEnabled !== false,
      automationActive: isAutomationActive(getData(profile).automation)
    }))
  });
});

app.post('/api/admin/profiles/:profile/access', async (req, res) => {
  try {
    const profile = String(req.params.profile || '');
    if (!PROFILE_IDS.includes(profile)) {
      return res.status(404).json({ ok: false, message: 'Perfil não encontrado.' });
    }

    const enabled = req.body?.enabled === true;
    const data = getData(profile);
    data.accessEnabled = enabled;

    // Ao bloquear, pausa a automação para impedir novos envios.
    // A sessão WhatsApp e os grupos salvos são preservados.
    if (!enabled) {
      data.automation.active = false;
      data.automation.enabled = false;
    }

    await saveProfile(profile);

    return res.json({
      ok: true,
      profile,
      enabled,
      message: enabled
        ? 'Acesso liberado para este perfil.'
        : 'Acesso bloqueado e automação pausada. A conexão e as configurações foram preservadas.'
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});


// ======================================================
// ROTAS DE STATUS
// ======================================================

app.get('/api/status', (req, res) => {
  const profile = profileIdFrom(req);
  const data = getData(profile);
  const targets = getAutomationTargets(data);
  const pendingQueue = data.queue.filter(item =>
    ['pending', 'processing'].includes(item.status)
  ).length;

  res.json({
    ok: true,
    profile,
    status: getStatus(profile),
    products: Array.isArray(data.products) ? data.products.length : 0,
    destinations: targets.length,
    queue: pendingQueue,
    qr: qrCache.get(profile) || null,
    pairingCode: pairingCache.get(profile) || null,
    connected:
      getStatus(profile).status === 'connected'
  });
});


// ======================================================
// ROTAS DOS DADOS
// ======================================================

app.get('/api/data', async (req, res) => {
  try {
    const profile = profileIdFrom(req);
    const data = await loadProfile(profile);

    res.json({
      ok: true,
      profile,
      data
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.post('/api/data', async (req, res) => {
  try {
    const profile = profileIdFrom(req);
    const current = getData(profile);

    const incoming =
      req.body?.data ||
      req.body ||
      {};

    storeCache[profile] = mergeProfileData({
      ...current,
      ...incoming,

      automation: {
        ...current.automation,
        ...(incoming.automation || {})
      },

      whatsappAuth: current.whatsappAuth
    });

    await saveProfile(profile);

    res.json({
      ok: true,
      message: 'Dados salvos.',
      data: getData(profile)
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});


// ======================================================
// ROTAS DA AUTOMAÇÃO
// ======================================================

app.get('/api/automation', (req, res) => {
  const profile = profileIdFrom(req);
  const automation = getData(profile).automation;

  res.json({
    ok: true,
    automation,
    active: isAutomationActive(automation)
  });
});

app.post('/api/automation', async (req, res) => {
  try {
    const profile = profileIdFrom(req);

    const incoming =
      req.body?.automation ||
      req.body ||
      {};

    const data = getData(profile);

    data.automation = {
      ...data.automation,
      ...incoming
    };

    // Salva somente os nichos escolhidos manualmente.
    // Valores vazios também são preservados para apagar
    // qualquer seleção antiga daquele grupo.
    if (
      incoming.groupNiches &&
      typeof incoming.groupNiches === 'object' &&
      !Array.isArray(incoming.groupNiches)
    ) {
      const normalizedGroupNiches = {};

      for (const [groupId, niche] of Object.entries(
        incoming.groupNiches
      )) {
        normalizedGroupNiches[
          normalizeGroupId(groupId)
        ] = normalizeNicheId(niche);
      }

      data.automation.groupNiches = {
        ...(data.automation.groupNiches || {}),
        ...normalizedGroupNiches
      };
    }

    if (incoming.enabled !== undefined) {
      data.automation.enabled =
        Boolean(incoming.enabled);

      data.automation.active =
        Boolean(incoming.enabled);
    }

    if (incoming.active !== undefined) {
      data.automation.active =
        Boolean(incoming.active);

      data.automation.enabled =
        Boolean(incoming.active);
    }

    const seconds = Number(
      data.automation.intervalSeconds
    );

    if (
      Number.isFinite(seconds) &&
      seconds > 0
    ) {
      data.automation.intervalSeconds =
        Math.max(
          10,
          Math.min(86400, Math.round(seconds))
        );

      data.automation.intervalMinutes =
        Math.max(
          1,
          Math.ceil(data.automation.intervalSeconds / 60)
        );
    }

    await saveProfile(profile);

    res.json({
      ok: true,
      message: 'Configurações da automação salvas.',
      automation: data.automation
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.post('/api/automation/run', async (req, res) => {
  const profile = profileIdFrom(req);
  const result = await runAutomation(profile);

  res.status(result.ok ? 200 : 400).json(result);
});


// ======================================================
// ROTAS DO WHATSAPP
// ======================================================

app.get('/api/whatsapp', (req, res) => {
  const profile = profileIdFrom(req);

  res.json({
    ok: true,
    profile,
    status: getStatus(profile),
    qr: qrCache.get(profile) || null,
    pairingCode: pairingCache.get(profile) || null
  });
});

app.post('/api/whatsapp/connect', async (req, res) => {
  try {
    const profile = profileIdFrom(req);

    const result = await startWhatsApp(profile);

    res.json({
      ok: true,
      ...result,
      status: getStatus(profile),
      qr: qrCache.get(profile) || null
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.post('/api/whatsapp/pairing', async (req, res) => {
  try {
    const profile = profileIdFrom(req);

    let phone = String(
      req.body?.phone || ''
    ).replace(/\D/g, '');

    if (
      phone.length === 10 ||
      phone.length === 11
    ) {
      phone = `55${phone}`;
    }

    if (
      phone.length < 12 ||
      phone.length > 15
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Informe telefone com DDD e código do país.'
      });
    }

    await startWhatsApp(profile);

    let sock = sockets.get(profile);

    for (let attempt = 0; !sock && attempt < 20; attempt++) {
      await sleep(500);
      sock = sockets.get(profile);
    }

    if (!sock) {
      throw new Error(
        'Socket do WhatsApp ainda não está disponível.'
      );
    }

    if (
      typeof sock.requestPairingCode !== 'function'
    ) {
      throw new Error(
        'Esta versão do Baileys não oferece código de pareamento.'
      );
    }

    const code = await sock.requestPairingCode(phone);

    pairingCache.set(profile, code);

    res.json({
      ok: true,
      pairingCode: code,
      message: 'Código de pareamento gerado.'
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});


// ======================================================
// DESCONECTAR WHATSAPP
// ======================================================

app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    const profile = profileIdFrom(req);

    connectionIds.set(
      profile,
      (connectionIds.get(profile) || 0) + 1
    );

    const timer = reconnectTimers.get(profile);

    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(profile);
    }

    const sock = sockets.get(profile);

    sockets.delete(profile);

    if (sock) {
      try {
        sock.end(
          new Error('Desconexão solicitada pelo painel.')
        );
      } catch (_) {
        try {
          sock.ws?.close();
        } catch (_) {}
      }
    }

    reconnectAttempts.delete(profile);
    qrCache.delete(profile);
    pairingCache.delete(profile);

    setStatus(profile, 'disconnected', {
      message: 'WhatsApp desconectado pelo painel.'
    });

    res.json({
      ok: true,
      message: 'WhatsApp desconectado.'
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});


// ======================================================
// ENVIAR MENSAGEM WHATSAPP
// ======================================================

app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const profile = profileIdFrom(req);

    const destination =
      req.body?.destination ||
      req.body?.target ||
      req.body ||
      {};

    // Envio manual de teste: o painel envia destination como string
    // e a mensagem em req.body.message.
    if (typeof destination === 'string') {
      const sock = sockets.get(profile);

      if (!sock || getStatus(profile).status !== 'connected') {
        throw new Error('WhatsApp não está conectado.');
      }

      const jid = normalizeWhatsAppJid(destination);
      const message = String(req.body?.message || '').trim();

      if (!jid) {
        throw new Error('Número ou ID do grupo inválido.');
      }

      if (!message) {
        throw new Error('Digite uma mensagem para enviar.');
      }

      const result = await sock.sendMessage(jid, { text: message });

      logger.info(
        {
          profile,
          jid,
          messageId: result?.key?.id || null
        },
        'Mensagem manual de teste aceita pelo WhatsApp.'
      );

      return res.json({
        ok: true,
        message: 'Solicitação aceita pelo WhatsApp.',
        messageId: result?.key?.id || null
      });
    }

    const product = normalizeProduct(
      req.body?.product ||
      req.body?.offer ||
      req.body ||
      {}
    );

    const result = await sendToDestination(
      profile,
      destination,
      product
    );

    res.json({
      ok: true,
      message: 'Solicitação aceita pelo WhatsApp.',
      messageId: result?.key?.id || null
    });

  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message
    });
  }
});


// ======================================================
// LISTAR GRUPOS WHATSAPP
// ======================================================

app.get('/api/whatsapp/groups', async (req, res) => {
  try {
    const profile = profileIdFrom(req);
    const sock = sockets.get(profile);

    if (
      !sock ||
      getStatus(profile).status !== 'connected'
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Conecte o WhatsApp antes de listar os grupos.'
      });
    }

    if (
      typeof sock.groupFetchAllParticipating !== 'function'
    ) {
      throw new Error(
        'Não foi possível consultar os grupos nesta versão do Baileys.'
      );
    }

    const groups =
      await sock.groupFetchAllParticipating();

    const result = Object.entries(
      groups || {}
    ).map(([id, group]) => ({
      id,
      groupId: id,
      name: group.subject || group.name || id,
      subject: group.subject || '',
      participants: Array.isArray(group.participants)
        ? group.participants.length
        : 0
    }));

    res.json({
      ok: true,
      groups: result
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});


// ======================================================
// ROTAS DE NICHOS
// ======================================================

app.get('/api/niches', (req, res) => {
  res.json({
    ok: true,

    niches: [
      {
        id: 'all',
        label: 'Todos os nichos'
      },

      ...NICHE_DEFINITIONS.map(item => ({
        id: item.id,
        label: item.label
      }))
    ]
  });
});


// Não classifica mais o nome de grupos.
// A seleção do nicho deve ser feita manualmente no painel.

app.post('/api/niches/classify', (req, res) => {
  res.json({
    ok: true,

    niche: {
      id: '',
      label: 'Selecione manualmente'
    },

    manualSelectionRequired: true
  });
});


// ======================================================
// SINCRONIZAR NICHO MANUAL DO DESTINO
// ======================================================

function syncDestinationNiche(data, destination) {
  const groupId = normalizeGroupId(
    destination?.groupId ||
    destination?.jid ||
    ''
  );

  if (!groupId) return;

  if (
    !data.automation ||
    typeof data.automation !== 'object'
  ) {
    data.automation = {};
  }

  if (
    !data.automation.groupNiches ||
    typeof data.automation.groupNiches !== 'object'
  ) {
    data.automation.groupNiches = {};
  }

  data.automation.groupNiches[groupId] =
    normalizeNicheId(
      destination?.nicheId ??
      destination?.niche ??
      ''
    );
}


// ======================================================
// ROTAS DE DESTINOS E GRUPOS
// ======================================================

app.get('/api/destinations', (req, res) => {
  const profile = profileIdFrom(req);
  const destinations = getData(profile).destinations;

  res.json({
    ok: true,
    destinations: destinations.map(publicDestination)
  });
});

app.post('/api/destinations', async (req, res) => {
  try {
    const profile = profileIdFrom(req);
    const data = getData(profile);

    const incoming =
      req.body?.destination ||
      req.body ||
      {};

    const destination = {
      id: String(
        incoming.id ||
        crypto.randomUUID()
      ),

      groupId: String(
        incoming.groupId ||
        incoming.jid ||
        ''
      ),

      jid: String(
        incoming.jid ||
        incoming.groupId ||
        ''
      ),

      phone: String(
        incoming.phone || ''
      ),

      name: String(
        incoming.name ||
        incoming.subject ||
        incoming.groupId ||
        'Novo destino'
      ),

      nicheId: normalizeNicheId(
        incoming.nicheId ??
        incoming.niche ??
        ''
      ),

      active: incoming.active !== false,
      source: incoming.source || 'manual'
    };

    if (
      !destination.groupId &&
      !destination.phone
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Informe o ID do grupo ou telefone.'
      });
    }

    const existing = data.destinations.findIndex(
      item =>
        String(item.id) === destination.id
    );

    if (existing >= 0) {
      data.destinations[existing] = destination;
    } else {
      data.destinations.push(destination);
    }

    // Guarda a seleção manual do nicho para o grupo.
    syncDestinationNiche(data, destination);

    await saveProfile(profile);

    res.json({
      ok: true,
      destination: publicDestination(destination),
      destinations: data.destinations.map(publicDestination)
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.post('/api/destinations/update', async (req, res) => {
  try {
    const profile = profileIdFrom(req);
    const data = getData(profile);

    const incoming =
      req.body?.destination ||
      req.body ||
      {};

    const id = String(incoming.id || '');

    const index = data.destinations.findIndex(
      item => String(item.id) === id
    );

    if (index < 0) {
      return res.status(404).json({
        ok: false,
        message: 'Destino não encontrado.'
      });
    }

    const previous = data.destinations[index];

    data.destinations[index] = {
      ...previous,
      ...incoming
    };

    // Só altera o nicho quando o painel enviou
    // explicitamente uma nova seleção.
    if (
      incoming.nicheId !== undefined ||
      incoming.niche !== undefined
    ) {
      data.destinations[index].nicheId =
        normalizeNicheId(
          incoming.nicheId ??
          incoming.niche ??
          ''
        );

      syncDestinationNiche(
        data,
        data.destinations[index]
      );
    }

    await saveProfile(profile);

    res.json({
      ok: true,
      destination: publicDestination(
        data.destinations[index]
      )
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.patch('/api/destinations/:id', async (req, res) => {
  try {
    const profile = profileIdFrom(req);
    const data = getData(profile);

    const index = data.destinations.findIndex(
      item =>
        String(item.id) === String(req.params.id)
    );

    if (index < 0) {
      return res.status(404).json({
        ok: false,
        message: 'Destino não encontrado.'
      });
    }

    const incoming = req.body || {};

    data.destinations[index] = {
      ...data.destinations[index],
      ...incoming
    };

    if (
      incoming.nicheId !== undefined ||
      incoming.niche !== undefined
    ) {
      data.destinations[index].nicheId =
        normalizeNicheId(
          incoming.nicheId ??
          incoming.niche ??
          ''
        );

      syncDestinationNiche(
        data,
        data.destinations[index]
      );
    }

    await saveProfile(profile);

    res.json({
      ok: true,
      destination: publicDestination(
        data.destinations[index]
      )
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.delete('/api/destinations/:id', async (req, res) => {
  try {
    const profile = profileIdFrom(req);
    const data = getData(profile);

    const removed = data.destinations.find(
      item =>
        String(item.id) === String(req.params.id)
    );

    data.destinations = data.destinations.filter(
      item =>
        String(item.id) !== String(req.params.id)
    );

    // Remove a configuração de nicho associada ao grupo excluído.
    if (removed) {
      const groupId = normalizeGroupId(
        removed.groupId ||
        removed.jid ||
        ''
      );

      if (
        groupId &&
        data.automation?.groupNiches
      ) {
        delete data.automation.groupNiches[groupId];
      }
    }

    await saveProfile(profile);

    res.json({
      ok: true,
      destinations: data.destinations.map(publicDestination)
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});


// ======================================================
// ROTAS DE PRODUTOS
// ======================================================

app.get('/api/products', (req, res) => {
  const profile = profileIdFrom(req);

  res.json({
    ok: true,
    products: getData(profile).products
  });
});

app.post('/api/products', async (req, res) => {
  try {
    const profile = profileIdFrom(req);
    const data = getData(profile);

    const incoming =
      req.body?.product ||
      req.body ||
      {};

    const product = normalizeProduct(incoming);

    data.products.unshift(product);
    data.products = data.products.slice(0, 500);

    await saveProfile(profile);

    res.json({
      ok: true,
      product,
      products: data.products
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const profile = profileIdFrom(req);
    const data = getData(profile);

    data.products = data.products.filter(
      item =>
        String(item.id) !== String(req.params.id)
    );

    await saveProfile(profile);

    res.json({
      ok: true,
      products: data.products
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});


// ======================================================
// ROTAS DA FILA
// ======================================================

app.get('/api/queue', (req, res) => {
  const profile = profileIdFrom(req);

  res.json({
    ok: true,
    queue: getData(profile).queue
  });
});

app.post('/api/queue', async (req, res) => {
  try {
    const profile = profileIdFrom(req);
    const data = getData(profile);

    const incoming =
      req.body?.product ||
      req.body ||
      {};

    const product = normalizeProduct(incoming);

    const item = {
      id: crypto.randomUUID(),
      product,
      productKey: String(
        product.id ||
        product.productLink ||
        product.productName
      ),
      status: 'pending',
      source: 'manual',
      createdAt: new Date().toISOString()
    };

    data.queue.push(item);

    await saveProfile(profile);

    res.json({
      ok: true,
      item,
      queue: data.queue
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

app.post('/api/queue/process', async (req, res) => {
  try {
    const profile = profileIdFrom(req);

    let processed = 0;

    while (
      getData(profile).queue.some(
        item => item.status === 'pending'
      ) &&
      processed < 100
    ) {
      await processQueue(profile);
      processed++;
    }

    res.json({
      ok: true,
      processed,
      queue: getData(profile).queue
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});


// ======================================================
// ROTAS DA SHOPEE
// ======================================================

app.get('/api/shopee/credentials', (req, res) => {
  const profile = profileIdFrom(req);

  const credentials =
    getShopeeCredentials(profile);

  res.json({
    ok: true,

    configured: Boolean(
      credentials.appId &&
      credentials.appSecret
    ),

    appId: credentials.appId,

    appSecretConfigured: Boolean(
      credentials.appSecret
    )
  });
});

app.post('/api/shopee/credentials', async (req, res) => {
  try {
    const profile = profileIdFrom(req);

    const appId = String(
      req.body?.appId ||
      req.body?.partnerId ||
      ''
    ).trim();

    const appSecret = String(
      req.body?.appSecret ||
      req.body?.partnerKey ||
      ''
    ).trim();

    if (!appId || !appSecret) {
      return res.status(400).json({
        ok: false,
        message: 'Informe o App ID e o App Secret da Shopee.'
      });
    }

    const data = getData(profile);

    data.shopeeCredentials = encryptObject({
      appId,
      appSecret
    });

    await saveProfile(profile);

    res.json({
      ok: true,
      message: 'Credenciais Shopee salvas.'
    });

  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message
    });
  }
});

app.get('/api/shopee/products', async (req, res) => {
  try {
    const profile = profileIdFrom(req);

    const limit = Number(
      req.query.limit || 10
    );

    const keyword = String(
      req.query.keyword || ''
    ).trim();

    logger.info(
      {
        profile,
        keyword,
        limit
      },
      'Iniciando pesquisa de produtos Shopee.'
    );

    const products = await fetchShopeeOffers(
      profile,
      limit,
      keyword
    );

    return res.json({
      ok: true,
      keyword,
      total: products.length,
      products
    });

  } catch (error) {
    logger.error(
      {
        error: error.message,
        stack: error.stack
      },
      'Erro ao pesquisar produtos Shopee.'
    );

    return res.status(400).json({
      ok: false,
      message: error.message
    });
  }
});

app.post('/api/shopee/test', async (req, res) => {
  try {
    const profile = profileIdFrom(req);

    const products = await fetchShopeeOffers(
      profile,
      1
    );

    res.json({
      ok: true,
      connected: true,
      products,
      message: 'Conexão com a API Shopee realizada.'
    });

  } catch (error) {
    res.status(400).json({
      ok: false,
      connected: false,
      message: error.message
    });
  }
});


// ======================================================
// PÁGINA PRINCIPAL
// ======================================================

app.get('/', (req, res) => {
  const indexFile = path.join(
    __dirname,
    'index.html'
  );

  if (fs.existsSync(indexFile)) {
    return res.sendFile(indexFile);
  }

  res.type('html').send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>MEDEIROS DIGITAL</title>
    </head>

    <body style="
      background:#101010;
      color:white;
      font-family:Arial,sans-serif;
      padding:30px;
    ">
      <h1>MEDEIROS DIGITAL</h1>
      <p>Servidor do robô Shopee funcionando.</p>
      <p>O painel será carregado pelo arquivo index.html.</p>
    </body>
    </html>
  `);
});


// ======================================================
// ROTA NÃO ENCONTRADA
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: 'Rota não encontrada.',
    path: req.path
  });
});


// ======================================================
// TRATAMENTO GLOBAL DE ERROS
// ======================================================

app.use((error, req, res, next) => {
  logger.error(
    {
      error: error.message,
      path: req.path
    },
    'Erro não tratado na aplicação.'
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    message: 'Erro interno do servidor.',

    detail:
      process.env.NODE_ENV === 'production'
        ? undefined
        : error.message
  });
});


// ======================================================
// INICIALIZAÇÃO DO SERVIDOR
// ======================================================

let httpServer = null;
let schedulerTimer = null;
let startupReconnectTimer = null;

async function initializeApp() {
  const profilesToReconnect = [];

  for (const profile of PROFILE_IDS) {
    try {
      await loadProfile(profile);

      // Verifica a sessão diretamente na nova tabela
      // whatsapp_auth_store do Supabase.
      try {
        const hasSavedSession = await hasWhatsAppAuth(profile);

        if (hasSavedSession) {
          logger.info(
            { profile },
            'Sessão encontrada no Supabase. Iniciando WhatsApp.'
          );

          profilesToReconnect.push(profile);
        } else {
          logger.info(
            { profile },
            'Nenhuma sessão registrada no Supabase. Aguardando QR Code.'
          );
        }

      } catch (authError) {
        logger.error(
          {
            profile,
            error: authError.message
          },
          'Não foi possível verificar a sessão salva no Supabase.'
        );
      }

    } catch (error) {
      logger.error(
        {
          profile,
          error: error.message
        },
        'Erro ao carregar perfil.'
      );
    }
  }

  httpServer = app.listen(
    PORT,
    '0.0.0.0',
    () => {
      logger.info(
        {
          port: PORT
        },
        'MEDEIROS DIGITAL iniciado.'
      );

      // Durante o deploy, a instância anterior pode continuar ativa.
      // Aguarda seu encerramento antes de abrir as sessões Baileys salvas,
      // evitando conexões simultâneas e conflitos 440/Bad MAC.
      if (profilesToReconnect.length) {
        startupReconnectTimer = setTimeout(() => {
          startupReconnectTimer = null;

          for (const profile of profilesToReconnect) {
            if (sockets.has(profile) || socketStarts.has(profile)) continue;

            startWhatsApp(profile).catch(error => {
              logger.error(
                { profile, error: error.message },
                'Erro ao iniciar WhatsApp após a janela segura de inicialização.'
              );
            });
          }
        }, 30000);

        startupReconnectTimer.unref?.();
      }
    }
  );

  schedulerTimer = setInterval(() => {
    automationSchedulerTick().catch(error => {
      logger.error(
        {
          error: error.message
        },
        'Erro no agendador.'
      );
    });
  }, 5000);

  schedulerTimer.unref?.();

  return httpServer;
}


// ======================================================
// ENCERRAMENTO SEGURO
// ======================================================

async function shutdown(signal) {
  logger.info(
    { signal },
    'Encerrando MEDEIROS DIGITAL.'
  );

  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  if (startupReconnectTimer) {
    clearTimeout(startupReconnectTimer);
    startupReconnectTimer = null;
  }

  for (const [profile, timer] of reconnectTimers.entries()) {
    clearTimeout(timer);
    reconnectTimers.delete(profile);
  }

  for (const profile of PROFILE_IDS) {
    connectionIds.set(
      profile,
      (connectionIds.get(profile) || 0) + 1
    );
  }

  for (const [profile, sock] of sockets.entries()) {
    try {
      sock.end(
        new Error('Servidor encerrando.')
      );
    } catch (_) {
      try {
        sock.ws?.close();
      } catch (_) {}
    }

    sockets.delete(profile);
  }

  if (httpServer) {
    await new Promise(resolve => {
      httpServer.close(resolve);
    });
  }

  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch(error => {
    logger.error(
      { error: error.message },
      'Erro durante encerramento SIGTERM.'
    );

    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch(error => {
    logger.error(
      { error: error.message },
      'Erro durante encerramento SIGINT.'
    );

    process.exit(1);
  });
});


// ======================================================
// INICIAR APLICAÇÃO
// ======================================================

initializeApp().catch(error => {
  logger.fatal(
    {
      error: error.message
    },
    'Falha ao iniciar o servidor.'
  );

  process.exit(1);
});
