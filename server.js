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

const storeCache = Object.fromEntries(
  PROFILE_IDS.map(profile => [
    profile,
    null
  ])
);


// ======================================================
// NICHOS E CATEGORIAS
// ======================================================

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
      'masculino',
      'masculina',
      'camiseta masculina',
      'cueca',
      'bermuda masculina'
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
      'gato',
      'cao',
      'racao',
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
}function getMapValueByGroupId(map, groupId) {
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

      groupNiches:
        oldAutomation.groupNiches &&
        typeof oldAutomation.groupNiches === 'object'
          ? oldAutomation.groupNiches
          : {},

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
      ? parsed.destinations
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

    if (!error) return true;        profile,
        error: error.message
      },
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
// CLASSIFICAÇÃO DE GRUPOS E PRODUTOS
// ======================================================

function classifyGroupNiche(name) {
  const normalized = normalizeText(name);

  for (const niche of NICHE_DEFINITIONS) {
    if (
      niche.aliases.some(alias =>
        normalized.includes(normalizeText(alias))
      )
    ) {
      return {
        id: niche.id,
        label: niche.label
      };
    }
  }

  return {
    id: 'unknown',
    label: 'Não identificado'
  };
}

function classifyProductNiches(product) {
  const text = normalizeText([
    product?.productName,
    product?.name,
    product?.title,
    product?.description,
    product?.category
  ].filter(Boolean).join(' '));

  const matches = [];

  for (const niche of NICHE_DEFINITIONS) {
    if (
      niche.aliases.some(alias =>
        text.includes(normalizeText(alias))
      )
    ) {
      matches.push(niche.id);
    }
  }

  return [...new Set(matches)];
}

function destinationMatchesProduct(destination, product) {
  const selected = normalizeText(
    destination?.nicheId ||
    destination?.niche ||
    'auto'
  );

  if (
    ['all', 'geral', 'todos', 'todas'].includes(selected)
  ) {
    return {
      matches: true,
      reason: 'Destino aceita todos os nichos.'
    };
  }

  let destinationNiche = selected;

  if (
    !destinationNiche ||
    destinationNiche === 'auto'
  ) {
    const classified = classifyGroupNiche(
      destination?.name ||
      destination?.subject ||
      ''
    );

    destinationNiche = classified.id;
  }

  if (destinationNiche === 'unknown') {
    return {
      matches: false,
      reason: 'Selecione manualmente o nicho deste grupo.'
    };
  }

  const productNiches = classifyProductNiches(product);

  if (!productNiches.length) {
    return {
      matches: false,
      reason: 'Não foi possível identificar o nicho do produto.'
    };
  }

  return {
    matches: productNiches.includes(destinationNiche),
    reason: productNiches.includes(destinationNiche)
      ? 'Nicho compatível.'
      : 'Produto não pertence ao nicho deste grupo.'
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

        nicheId:
          getMapValueByGroupId(
            automation.groupNiches,
            groupId
          ) ||
          destination?.nicheId ||
          'auto',

        active: true
      };
    });
  }

  const selected = Array.isArray(
    automation.destinationIds
  )
    ? automation.destinationIds
    : [];

  return data.destinations.filter(destination => {
    if (destination.active === false) return false;
    if (!selected.length) return false;

    return selected.some(id =>
      String(id) === String(destination.id) ||
      normalizeGroupId(id) ===
        normalizeGroupId(destination.groupId)
    );
  });
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

  const { error } = await supabase     .from('whatsapp_auth_store')
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
          missing.push({
            id,
            key: cacheKey
          });
        }
      }

      if (missing.length) {
        const keyNames = missing.map(
          item => item.key
        );

        const { data, error } = await supabase
          .from('whatsapp_auth_store')
          .select('key,value')
          .eq('profile', profile)
          .in('key', keyNames);

        if (error) {
          logger.error(
            {
              profile,
              error: error.message
            },
            'Erro ao recuperar chaves criptográficas do WhatsApp.'
          );

          throw error;
        }

        const found = new Map();

        for (const row of data || []) {
          found.set(
            row.key,
            unpackAuthValue(row.value)
          );
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
      }

      return result;
    },

    async set(dataToSet) {
      const operations = [];

      for (const [type, entries] of Object.entries(
        dataToSet || {}
      )) {
        for (const [id, value] of Object.entries(
          entries || {}
        )) {
          const key = `${type}:${id}`;

          if (value === null || value === undefined) {
            keysCache.delete(key);

            operations.push(
              deleteWhatsAppAuth(profile, key)
            );
          } else {
            keysCache.set(key, value);

            operations.push(
              writeWhatsAppAuth(profile, key, value)
            );
          }
        }
      }

      const results = await Promise.allSettled(
        operations
      );

      const failed = results.find(
        result => result.status === 'rejected'
      );

      if (failed) {
        throw failed.reason;
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

  if (pendingTimer) {    clearTimeout(pendingTimer);
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
  const classified = classifyGroupNiche(
    destination.name ||
    destination.subject ||
    ''
  );

  return {
    ...destination,

    niche:
      destination.nicheId &&
      destination.nicheId !== 'auto'
        ? (
            NICHE_DEFINITIONS.find(
              item => item.id === destination.nicheId
            )?.label ||
            destination.nicheId
          )
        : classified.label
  };
}


// ======================================================
// NORMALIZAÇÃO DOS PRODUTOS
// ======================================================

function normalizeProduct(product) {
  const item = product || {};

  const price = item.price ??
    item.productPrice ??
    item.priceMin ??
    '';

  const oldPrice = item.oldPrice ??
    item.originalPrice ??
    item.priceBeforeDiscount ??
    '';

  const discount = item.discount ??
    item.discountRate ??
    '';

  return {
    id: String(
      item.id ||
      item.productId ||
      crypto.randomUUID()
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

    price: String(price),
    oldPrice: String(oldPrice),
    discount: String(discount),

    category: String(
      item.category ||      item.categoryName ||
      ''
    ),

    description: String(
      item.description ||
      ''
    ),

    createdAt:
      item.createdAt ||
      new Date().toISOString()
  };
}


// ======================================================
// TEXTO DA OFERTA
// ======================================================

function buildOfferMessage(product) {
  const item = normalizeProduct(product);

  const lines = [
    '🔥 *OFERTA IMPERDÍVEL* 🔥',
    '',
    `🛍️ *${item.productName}*`
  ];

  if (item.oldPrice) {
    lines.push(`De: R$ ${item.oldPrice}`);
  }

  if (item.price) {
    lines.push(`Por: *R$ ${item.price}*`);
  }

  if (item.discount) {
    lines.push(`🔥 ${item.discount}`);
  }

  lines.push('');

  if (item.productLink) {
    lines.push(`🔗 ${item.productLink}`);
  }

  lines.push('');
  lines.push('⚡ Aproveite antes que acabe!');

  return lines.join('\n');
}


// ======================================================
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

  if (!jid) {
    throw new Error(
      'Número ou ID do grupo inválido.'
    );
  }

  const item = normalizeProduct(product);
  const caption = buildOfferMessage(item);

  let result;

  if (
    item.imageUrl &&
    /^https?:\/\//i.test(item.imageUrl)
  ) {
    try {
      result = await sock.sendMessage(
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

      result = await sock.sendMessage(
        jid,
        {
          text: caption
        }
      );
    }
  } else {
    result = await sock.sendMessage(
      jid,
      {
        text: caption
      }
    );
  }

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

  if (
    !credentials.appId ||
    !credentials.appSecret
  ) {
    throw new Error(
      'Configure o App ID e o App Secret da Shopee.'
    );
  }

  const endpoint =
    process.env.SHOPEE_API_URL ||
    'https://open-api.affiliate.shopee.com.br/graphql';

  const timestamp = Math.floor(
    Date.now() / 1000
  );

  const payload = JSON.stringify({
    query,
    variables
  });

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
    throw new Error(
      'A Shopee retornou uma resposta inválida.'
    );
  }

  if (!response.ok) {
    throw new Error(
      result?.message ||
      result?.error ||
      `Erro HTTP da Shopee: ${response.status}`
    );
  }

  if (
    Array.isArray(result?.errors) &&
    result.errors.length
  ) {
    throw new Error(
      result.errors
        .map(item => item.message)
        .filter(Boolean)
        .join('; ')
    );
  }

  return result?.data || result;
}


// ======================================================
// BUSCAR OFERTAS NA SHOPEE
// ======================================================

async function fetchShopeeOffers(
  profile,
  limit = 10
) {
  const safeLimit = Math.max(
    1,
    Math.min(50, Number(limit) || 10)
  );

  const query = `
    query ProductOffer($limit: Int!) {
      productOfferV2(
        listType: 0,
        sortType: 2,
        page: 1,
        limit: $limit
      ) {
        nodes {
          productName
          itemId
          priceMin
          priceMax
          priceDiscountRate
          imageUrl
          productLink
          offerLink
          sales
          ratingStar
          commissionRate
          categoryName
        }
      }
    }
  `;

  const result = await shopeeGraphQL(
    profile,
    query,
    {
      limit: safeLimit
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
    const price = item.priceMin ??
      item.priceMax ??
      '';

    const discount = item.priceDiscountRate;

    return normalizeProduct({
      id: item.itemId,
      productName: item.productName,
      name: item.productName,
      price,
      oldPrice: '',

      discount:
        discount !== undefined &&
        discount !== null
          ? `${discount}% OFF`
          : '',

      imageUrl: item.imageUrl,

      productLink:
        item.offerLink ||
        item.productLink ||
        '',

      category: item.categoryName,
      description: '',
      sales: item.sales,
      rating: item.ratingStar,
      commissionRate: item.commissionRate
    });
  });
}


// ======================================================
// PROCESSAMENTO DA FILA DE OFERTAS
// ======================================================

async function processQueue(profile) {
  const data = getData(profile);

  const current = data.queue.find(
    item => item.status === 'pending'
  );

  if (!current) {
    return {
      ok: false,
      message: 'Não existem ofertas pendentes.'
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
    }    for (const destination of targets) {
      const match = destinationMatchesProduct(
        destination,
        product
      );

      if (!match.matches) {
        results.push({
          destination: destination.name || destination.id,
          status: 'skipped',
          reason: match.reason
        });

        continue;
      }

      try {
        const sent = await sendToDestination(
          profile,
          destination,
          product
        );

        results.push({
          destination: destination.name || destination.id,
          status: 'accepted',
          messageId: sent?.key?.id || null
        });
      } catch (error) {
        results.push({
          destination: destination.name || destination.id,
          status: 'error',
          message: error.message
        });
      }

      await sleep(1200);
    }

    const accepted = results.filter(
      item => item.status === 'accepted'
    );

    const errors = results.filter(
      item => item.status === 'error'
    );

    if (accepted.length > 0) {
      current.status = 'sent';
      current.sentAt = new Date().toISOString();
      current.results = results;
      current.product = product;

      const key = String(
        current.productKey ||
        product.id ||
        product.productLink ||
        product.productName
      );

      if (key) {
        data.sentProducts[key] = {
          sentAt: current.sentAt,
          productName: product.productName
        };
      }

      data.automation.lastSentAt =
        current.sentAt;

    } else if (errors.length > 0) {
      current.status = 'error';

      current.error = errors
        .map(item => item.message)
        .join('; ');

      current.results = results;

    } else {
      current.status = 'skipped';

      current.error =
        'Nenhum destino compatível com o nicho do produto.';

      current.results = results;
    }

    current.finishedAt = new Date().toISOString();

    await saveProfile(profile);

    return {
      ok: accepted.length > 0,
      status: current.status,
      results
    };

  } catch (error) {
    current.status = 'error';
    current.error = error.message;
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

    const maxProducts = Math.max(
      1,
      Math.min(
        50,
        Number(automation.maxProducts) || 10
      )
    );

    const products = await fetchShopeeOffers(
      profile,
      maxProducts
    );

    if (!products.length) {
      throw new Error(
        'A Shopee não retornou ofertas.'
      );
    }

    const sevenDaysAgo =
      Date.now() - (7 * 24 * 60 * 60 * 1000);

    let queued = 0;
    let duplicated = 0;

    for (const product of products) {
      const productKey = String(
        product.id ||
        product.productLink ||
        product.productName
      );

      const previous =
        data.sentProducts[productKey];

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
        const itemKey = String(
          item.productKey ||
          item.product?.id ||
          item.product?.productLink ||
          ''
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
      data.queue.some(
        item => item.status === 'pending'
      ) &&
      processed < 100
    ) {
      const current = data.queue.find(
        item => item.status === 'pending'
      );

      if (!current) break;

      const result = await processQueue(profile);

      processed++;

      if (result.status === 'sent') {
        sent++;
      } else if (result.status === 'error') {
        failed++;
      } else if (result.status === 'skipped') {
        skipped++;
      }

      await sleep(1500);
    }

    automation.lastRunAt =
      new Date().toISOString();

    automation.lastError = null;

    await saveProfile(profile);

    logger.info(
      {
        profile,        productsFound: products.length,
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

    automation.lastRunAt =
      new Date().toISOString();

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

      if (scheduleTimes.length) {
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
  res.json({
    ok: true,
    profiles: PROFILE_IDS
  });
});


// ======================================================
// ROTAS DE STATUS
// ======================================================

app.get('/api/status', (req, res) => {
  const profile = profileIdFrom(req);

  res.json({
    ok: true,
    profile,
    status: getStatus(profile),
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
          Math.ceil(
            data.automation.intervalSeconds / 60
          )
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
        ok: false,        message: 'Informe telefone com DDD e código do país.'
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

app.post('/api/niches/classify', (req, res) => {
  const name = String(
    req.body?.name ||
    req.body?.groupName ||
    req.body?.productName ||
    ''
  );

  res.json({
    ok: true,
    niche: classifyGroupNiche(name)
  });
});


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

      nicheId: String(
        incoming.nicheId || 'auto'
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

    data.destinations[index] = {
      ...data.destinations[index],
      ...incoming
    };

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

    data.destinations[index] = {      ...data.destinations[index],
      ...(req.body || {})
    };

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

    data.destinations = data.destinations.filter(
      item =>
        String(item.id) !== String(req.params.id)
    );

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

    const products = await fetchShopeeOffers(
      profile,
      limit
    );

    res.json({
      ok: true,
      products
    });

  } catch (error) {
    res.status(400).json({
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
});// ======================================================
// INICIALIZAÇÃO DO SERVIDOR
// ======================================================

let httpServer = null;
let schedulerTimer = null;

async function initializeApp() {
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

          startWhatsApp(profile).catch(error => {
            logger.error(
              {
                profile,
                error: error.message
              },
              'Erro ao iniciar WhatsApp automaticamente.'
            );
          });
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
  }, 60000);

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
