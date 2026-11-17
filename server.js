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
  proto,
  makeCacheableSignalKeyStore,
  Browsers
} = baileys;

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROFILE_IDS = ['rafael', 'usuario2'];
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

fs.mkdirSync(DATA_DIR, { recursive: true });
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const sockets = new Map();
const connectionStatus = new Map();
const qrCache = new Map();
const pairingCache = new Map();
const automationLocks = new Set();
const storeCache = Object.fromEntries(PROFILE_IDS.map(id => [id, defaultProfileData()]));

function defaultProfileData() {
  return {
    automation: { enabled: false, intervalMinutes: 30, maxProducts: 10, destinationIds: [], lastRunAt: null },
    destinations: [],
    products: [],
    queue: [],
    sentProducts: {},
    whatsappAuth: { creds: null, keys: {} },
    shopeeCredentials: null,
    updatedAt: new Date().toISOString()
  };
}

const NICHE_DEFINITIONS = [
  { id: 'eletricos', label: 'Eletrônicos e tecnologia', aliases: ['eletronico', 'eletronicos', 'tecnologia', 'celular', 'fone', 'informatica', 'computador', 'gadget', 'tv', 'smartwatch'] },
  { id: 'perfumaria', label: 'Perfumes', aliases: ['perfume', 'perfumaria', 'colonia', 'deo parfum', 'body splash', 'fragrancia'] },
  { id: 'beleza', label: 'Beleza e maquiagem', aliases: ['beleza', 'maquiagem', 'make', 'batom', 'base', 'skincare', 'cabelo', 'unha', 'cosmetico'] },
  { id: 'moda_feminina', label: 'Moda feminina', aliases: ['moda feminina', 'feminino', 'feminina', 'vestido', 'blusa feminina', 'saia', 'lingerie', 'cropped'] },
  { id: 'moda_masculina', label: 'Moda masculina', aliases: ['moda masculina', 'masculino', 'masculina', 'camiseta masculina', 'cueca', 'bermuda masculina'] },
  { id: 'moda_infantil', label: 'Moda infantil', aliases: ['infantil', 'crianca', 'bebe', 'bebê', 'menino', 'menina', 'roupa infantil'] },
  { id: 'calcados', label: 'Calçados', aliases: ['calcado', 'calcados', 'sapato', 'tenis', 'tênis', 'sandalia', 'chinelo', 'bota'] },
  { id: 'casa', label: 'Casa e utilidades', aliases: ['casa', 'utilidades', 'organizacao', 'organizador', 'limpeza', 'banheiro', 'lavanderia'] },
  { id: 'cozinha', label: 'Cozinha', aliases: ['cozinha', 'panela', 'frigideira', 'air fryer', 'airfryer', 'talher', 'garrafa', 'pote'] },
  { id: 'decoracao', label: 'Decoração', aliases: ['decoracao', 'decorativo', 'quadro', 'vaso', 'tapete', 'cortina', 'luminaria'] },
  { id: 'fitness', label: 'Fitness e esportes', aliases: ['fitness', 'academia', 'esporte', 'treino', 'halter', 'suplemento', 'legging fitness'] },
  { id: 'pet', label: 'Pet shop', aliases: ['pet', 'cachorro', 'gato', 'cao', 'ração', 'racao', 'coleira', 'brinquedo pet'] },
  { id: 'brinquedos', label: 'Brinquedos', aliases: ['brinquedo', 'brinquedos', 'boneca', 'carrinho', 'jogo infantil', 'lego'] },
  { id: 'acessorios', label: 'Acessórios e bolsas', aliases: ['acessorio', 'acessorios', 'bolsa', 'carteira', 'relogio', 'oculos', 'bijuteria', 'joia'] }
];

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function profileIdFrom(req) {
  const candidate = String(req.headers['x-profile'] || req.query.profile || req.body?.profile || 'rafael').trim().toLowerCase();
  return PROFILE_IDS.includes(candidate) ? candidate : 'rafael';
}
function getData(profile) {
  if (!storeCache[profile]) storeCache[profile] = defaultProfileData();
  return storeCache[profile];
}
function safeJson(value, fallback = null) {
  try { return typeof value === 'string' ? JSON.parse(value) : (value ?? fallback); }
  catch { return fallback; }
}
function mergeProfileData(value) {
  const base = defaultProfileData();
  const incoming = value && typeof value === 'object' ? value : {};
  return {
    ...base,
    ...incoming,
    automation: { ...base.automation, ...(incoming.automation || {}) },
    destinations: Array.isArray(incoming.destinations) ? incoming.destinations : [],
    products: Array.isArray(incoming.products) ? incoming.products : [],
    queue: Array.isArray(incoming.queue) ? incoming.queue : [],
    sentProducts: incoming.sentProducts && typeof incoming.sentProducts === 'object' ? incoming.sentProducts : {},
    whatsappAuth: { creds: incoming.whatsappAuth?.creds || null, keys: incoming.whatsappAuth?.keys || {} }
  };
}

// Persistência tolerante a variações comuns no nome das colunas das tabelas já existentes.
async function findProfileRow(profile) {
  if (!supabase) return { row: null, profileColumn: null, dataColumn: null };
  const profileColumns = ['perfil', 'profile', 'profile_id', 'id'];
  for (const column of profileColumns) {
    try {
      const { data, error } = await supabase.from('robo_perfis').select('*').eq(column, profile).maybeSingle();
      if (!error && data) {
        const dataColumn = ['dados', 'data', 'config', 'settings', 'conteudo', 'payload'].find(key => Object.prototype.hasOwnProperty.call(data, key));
        if (dataColumn) return { row: data, profileColumn: column, dataColumn };
      }
    } catch (_) {}
  }
  return { row: null, profileColumn: null, dataColumn: null };
}
async function loadProfile(profile) {
  const localFile = path.join(DATA_DIR, `${profile}.json`);
  let localData = null;
  try { localData = safeJson(fs.readFileSync(localFile, 'utf8')); } catch (_) {}
  if (supabase) {
    const found = await findProfileRow(profile);
    if (found.row && found.dataColumn) {
      const parsed = safeJson(found.row[found.dataColumn], found.row[found.dataColumn]);
      storeCache[profile] = mergeProfileData(parsed);
      return storeCache[profile];
    }
  }
  if (localData) storeCache[profile] = mergeProfileData(localData);
  return getData(profile);
}
async function saveProfile(profile) {
  const data = getData(profile);
  data.updatedAt = new Date().toISOString();
  try { fs.writeFileSync(path.join(DATA_DIR, `${profile}.json`), JSON.stringify(data, null, 2)); }
  catch (error) { logger.warn({ error: error.message }, 'Falha ao salvar cópia local'); }
  if (!supabase) return;

  const found = await findProfileRow(profile);
  if (found.row && found.dataColumn) {
    const payload = { [found.dataColumn]: data };
    if (Object.prototype.hasOwnProperty.call(found.row, 'updated_at')) payload.updated_at = data.updatedAt;
    const { error } = await supabase.from('robo_perfis').update(payload).eq(found.profileColumn, profile);
    if (error) logger.error({ error: error.message }, 'Falha ao atualizar robo_perfis');
    return;
  }

  const candidates = [
    { perfil: profile, dados: data },
    { profile, data },
    { profile_id: profile, data },
    { perfil: profile, data },
    { id: profile, dados: data }
  ];
  for (const payload of candidates) {
    try {
      const { error } = await supabase.from('robo_perfis').insert(payload);
      if (!error) return;
    } catch (_) {}
  }
  logger.warn('Não foi possível gravar em robo_perfis. Confira as colunas da tabela; cópia local mantida.');
}

function classifyGroupNiche(name) {
  const normalized = normalizeText(name);
  for (const niche of NICHE_DEFINITIONS) {
    if (niche.aliases.some(alias => normalized.includes(normalizeText(alias)))) return { id: niche.id, label: niche.label };
  }
  return { id: 'unknown', label: 'Geral / não identificado' };
}
function classifyProductNiches(product) {
  const text = normalizeText([
    product?.productName, product?.name, product?.title, product?.description,
    product?.categoryName, product?.category, product?.productCatName
  ].filter(Boolean).join(' '));
  return NICHE_DEFINITIONS.filter(niche => niche.aliases.some(alias => text.includes(normalizeText(alias))));
}
function destinationMatchesProduct(destination, product) {
  const selectedNicheId = String(destination?.nicheId || 'auto').trim().toLowerCase();
  const productNiches = classifyProductNiches(product || {});
  if (['all', 'geral', 'todos', 'todas', 'qualquer'].includes(selectedNicheId)) {
    return { matches: true, reason: 'Grupo configurado para receber todos os nichos.', groupNiche: { id: 'all', label: 'Todos os nichos' }, productNiches };
  }
  let groupNiche;
  if (!selectedNicheId || selectedNicheId === 'auto') groupNiche = classifyGroupNiche(destination?.name || '');
  else {
    const selected = NICHE_DEFINITIONS.find(item => item.id === selectedNicheId);
    if (!selected) return { matches: false, reason: 'O nicho selecionado para este grupo não é válido.', groupNiche: { id: 'invalid', label: 'Nicho inválido' }, productNiches };
    groupNiche = { id: selected.id, label: selected.label };
  }
  if (groupNiche.id === 'unknown') return { matches: false, reason: 'Selecione manualmente o nicho deste grupo.', groupNiche, productNiches };
  if (!productNiches.length) return { matches: false, reason: 'Não foi possível identificar o nicho do produto.', groupNiche, productNiches };
  const matches = productNiches.some(item => item.id === groupNiche.id);
  return { matches, reason: matches ? `Produto compatível com ${groupNiche.label}.` : `Produto fora do nicho ${groupNiche.label}.`, groupNiche, productNiches };
}

function encryptionKey() {
  const raw = process.env.SHOPEE_CREDENTIALS_KEY || process.env.APP_ENCRYPTION_KEY || '';
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest();
}
function encryptObject(value) {
  const key = encryptionKey();
  if (!key) throw new Error('Configure SHOPEE_CREDENTIALS_KEY nas variáveis do serviço.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}
function decryptObject(payload) {
  if (!payload) return null;
  try {
    const key = encryptionKey();
    if (!key) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const clear = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(clear);
  } catch (error) {
    logger.error({ error: error.message }, 'Não foi possível descriptografar as credenciais Shopee');
    return null;
  }
}

function serializeAuth(value) { return JSON.stringify(value, BufferJSON.replacer); }
function deserializeAuth(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return value;
  return JSON.parse(value, BufferJSON.reviver);
}

async function readAuthTableValue(profile, key) {
  if (!supabase) return null;
  const profileColumns = ['perfil', 'profile', 'profile_id'];
  const keyColumns = ['chave', 'key', 'nome'];
  const valueColumns = ['valor', 'value', 'dados', 'data', 'conteudo'];
  for (const profileColumn of profileColumns) {
    for (const keyColumn of keyColumns) {
      try {
        const { data, error } = await supabase.from('robo_whatsapp_chaves').select('*')
          .eq(profileColumn, profile).eq(keyColumn, key).maybeSingle();
        if (error || !data) continue;
        const valueColumn = valueColumns.find(column => Object.prototype.hasOwnProperty.call(data, column));
        if (valueColumn) return data[valueColumn];
      } catch (_) {}
    }
  }
  return null;
}
async function writeAuthTableValue(profile, key, value) {
  if (!supabase) return false;  const profileColumns = ['perfil', 'profile', 'profile_id'];
  const keyColumns = ['chave', 'key', 'nome'];
  const valueColumns = ['valor', 'value', 'dados', 'data', 'conteudo'];
  for (const profileColumn of profileColumns) {
    for (const keyColumn of keyColumns) {
      for (const valueColumn of valueColumns) {
        try {
          const where = query => query.eq(profileColumn, profile).eq(keyColumn, key);
          const { data: updated, error: updateError } = await where(
            supabase.from('robo_whatsapp_chaves').update({ [valueColumn]: value }).select('*')
          );
          if (!updateError && Array.isArray(updated) && updated.length) return true;
          if (!updateError && updated && !Array.isArray(updated)) return true;
          const payload = { [profileColumn]: profile, [keyColumn]: key, [valueColumn]: value };
          const { error: insertError } = await supabase.from('robo_whatsapp_chaves').insert(payload);
          if (!insertError) return true;
        } catch (_) {}
      }
    }
  }
  return false;
}
async function deleteAuthTableValues(profile) {
  if (!supabase) return;
  for (const profileColumn of ['perfil', 'profile', 'profile_id']) {
    try {
      const { error } = await supabase.from('robo_whatsapp_chaves').delete().eq(profileColumn, profile);
      if (!error) return;
    } catch (_) {}
  }
}
async function deleteAuthTableValue(profile, key) {
  if (!supabase) return;
  for (const profileColumn of ['perfil', 'profile', 'profile_id']) {
    for (const keyColumn of ['chave', 'key', 'nome']) {
      try {
        const { error } = await supabase.from('robo_whatsapp_chaves').delete()
          .eq(profileColumn, profile).eq(keyColumn, key);
        if (!error) return;
      } catch (_) {}
    }
  }
}
async function createSupabaseAuthState(profile) {
  const data = getData(profile);
  const auth = data.whatsappAuth || { creds: null, keys: {} };
  const storedCreds = await readAuthTableValue(profile, 'creds');
  const creds = storedCreds ? deserializeAuth(storedCreds) : (auth.creds ? deserializeAuth(auth.creds) : initAuthCreds());
  const keys = auth.keys || {};
  const persistCreds = async () => {
    const serialized = serializeAuth(creds);
    data.whatsappAuth = { creds: serialized, keys };
    await writeAuthTableValue(profile, 'creds', serialized);
    await saveProfile(profile);
  };
  const keyStore = {
    get: async (type, ids) => {
      const result = {};
      for (const id of ids) {
        const storageKey = `${type}-${id}`;
        let stored = await readAuthTableValue(profile, storageKey);
        if (stored == null) stored = keys[storageKey];
        if (stored !== undefined && stored !== null) result[id] = deserializeAuth(stored);
      }
      return result;
    },
    set: async (dataToSet) => {
      for (const [type, entries] of Object.entries(dataToSet || {})) {
        for (const [id, value] of Object.entries(entries || {})) {
          const storageKey = `${type}-${id}`;
          if (value == null) {
            delete keys[storageKey];
            await deleteAuthTableValue(profile, storageKey);
          } else {
            const serialized = serializeAuth(value);
            keys[storageKey] = serialized;
            await writeAuthTableValue(profile, storageKey, serialized);
          }
        }
      }
      data.whatsappAuth = { creds: data.whatsappAuth?.creds || serializeAuth(creds), keys };
      await saveProfile(profile);
    }
  };
  return {
    state: { creds, keys: makeCacheableSignalKeyStore ? makeCacheableSignalKeyStore(keyStore, logger) : keyStore },
    saveCreds: persistCreds
  };
}

function setStatus(profile, status, extra = {}) {
  connectionStatus.set(profile, { status, updatedAt: new Date().toISOString(), ...extra });
}
function getStatus(profile) {
  return connectionStatus.get(profile) || { status: 'disconnected', updatedAt: null };
}
async function startWhatsApp(profile) {
  if (sockets.has(profile)) return { ok: true, status: getStatus(profile).status };
  setStatus(profile, 'starting');
  await loadProfile(profile);
  const auth = await createSupabaseAuthState(profile);
  const sock = makeWASocket({
    auth: auth.state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers?.macOS ? Browsers.macOS('Chrome') : ['MEDEIROS DIGITAL', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true
  });
  sockets.set(profile, sock);
  sock.ev.on('creds.update', auth.saveCreds);
  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try { qrCache.set(profile, await QRCode.toDataURL(qr)); setStatus(profile, 'qr'); }
      catch (error) { logger.error({ error: error.message }, 'Erro ao gerar QR'); }
    }
    if (connection === 'connecting') setStatus(profile, 'connecting');
    if (connection === 'open') {
      qrCache.delete(profile);
      pairingCache.delete(profile);
      setStatus(profile, 'connected', { phone: sock.user?.id || null });
      logger.info({ profile }, 'WhatsApp conectado');
    }
    if (connection === 'close') {
      sockets.delete(profile);
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      setStatus(profile, loggedOut ? 'logged_out' : 'disconnected', { reason: code || null });
      if (!loggedOut && process.env.WHATSAPP_AUTO_RECONNECT !== 'false') {
        const delay = Math.min(15000, Number(process.env.WHATSAPP_RECONNECT_MS || 5000));
        setTimeout(() => startWhatsApp(profile).catch(err => logger.error({ error: err.message }, 'Falha ao reconectar WhatsApp')), delay);
      }
    }
  });
  return { ok: true, status: getStatus(profile).status };
}
async function clearWhatsAppAuth(profile) {
  const data = getData(profile);
  data.whatsappAuth = { creds: null, keys: {} };
  await deleteAuthTableValues(profile);
  await saveProfile(profile);
  qrCache.delete(profile);
  pairingCache.delete(profile);
}

function publicDestination(destination) {
  return { ...destination, niche: destination.nicheId === 'auto' ? classifyGroupNiche(destination.name) : (NICHE_DEFINITIONS.find(n => n.id === destination.nicheId) || { id: destination.nicheId, label: destination.nicheId }) };
}
function normalizeProduct(product) {
  const item = { ...product };
  item.id = String(item.id || item.productId || item.itemId || crypto.randomUUID());
  item.productName = String(item.productName || item.name || item.title || 'Oferta Shopee');
  item.productLink = String(item.productLink || item.offerLink || item.productUrl || item.url || '');
  item.imageUrl = String(item.imageUrl || item.image || item.image_url || '');
  item.price = item.price ?? item.priceMin ?? item.price_min ?? null;
  const discountRate = Number(item.priceDiscountRate || item.discountRate || 0);
  const currentPrice = Number(item.price);
  if (!item.oldPrice && discountRate > 0 && discountRate < 100 && currentPrice > 0) {
    item.oldPrice = (currentPrice / (1 - discountRate / 100)).toFixed(2);
  }
  if (!item.discount && discountRate > 0) item.discount = `${discountRate}% de desconto`;
  item.createdAt = item.createdAt || new Date().toISOString();
  return item;
}
function buildOfferMessage(product) {
  const price = product.price != null ? `R$ ${String(product.price).replace('.', ',')}` : '';
  const oldPrice = product.oldPrice || product.priceMax || '';
  const discount = product.discount ? `🔥 ${product.discount}\n` : '';
  return `🔥 *OFERTA IMPERDÍVEL* 🔥\n\n🛍️ *${product.productName}*\n${oldPrice ? `De: R$ ${String(oldPrice).replace('.', ',')}\n` : ''}${price ? `Por: *${price}*\n` : ''}${discount}\n🔗 ${product.productLink || 'Consulte o link da oferta'}`;
}
async function sendToDestination(profile, destination, product) {
  const sock = sockets.get(profile);
  if (!sock) throw new Error('WhatsApp não está conectado.');
  const jid = destination.groupId || destination.phone;
  if (!jid) throw new Error(`Destino ${destination.name} sem ID de grupo ou telefone.`);
  const text = buildOfferMessage(product);
  if (product.imageUrl && /^https?:\/\//i.test(product.imageUrl)) {
    await sock.sendMessage(jid, { image: { url: product.imageUrl }, caption: text });
  } else {
    await sock.sendMessage(jid, { text });
  }
}

function getShopeeCredentials(profile) {
  const data = getData(profile);
  const stored = decryptObject(data.shopeeCredentials);
  const envId = process.env.SHOPEE_APP_ID || process.env.SHOPEE_PARTNER_ID || '';
  const envSecret = process.env.SHOPEE_APP_SECRET || process.env.SHOPEE_PARTNER_KEY || '';
  const credentials = stored || { appId: envId, appSecret: envSecret };
  return {
    appId: String(credentials.appId || credentials.partnerId || credentials.partner_id || envId),
    appSecret: String(credentials.appSecret || credentials.partnerKey || credentials.partner_key || envSecret)
  };
}
async function shopeeGraphQL(profile, query, variables = {}) {
  const credentials = getShopeeCredentials(profile);
  if (!credentials.appId || !credentials.appSecret) throw new Error('Configure o App ID e o Secret da Shopee no painel.');
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ query, variables });
  // A assinatura da API de afiliados é SHA256(AppId + Timestamp + Payload + Secret).
  const base = `${credentials.appId}${timestamp}${payload}${credentials.appSecret}`;
  const signature = crypto.createHash('sha256').update(base, 'utf8').digest('hex');
  const authorization = `SHA256 Credential=${credentials.appId}, Timestamp=${timestamp}, Signature=${signature}`;
  const response = await fetch(process.env.SHOPEE_API_URL || 'https://open-api.affiliate.shopee.com.br/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authorization },
    body: payload
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.errors?.length) throw new Error(result.errors?.[0]?.message || `Shopee respondeu HTTP ${response.status}`);
  return result.data || result;
}
async function fetchShopeeOffers(profile, limit = 10) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const query = `query { productOfferV2(listType: 1, sortType: 5, page: 1, limit: ${safeLimit}) { nodes { itemId productName productLink offerLink imageUrl priceMin priceMax priceDiscountRate sales ratingStar commissionRate sellerCommissionRate shopeeCommissionRate commission shopId shopName shopType } pageInfo { page limit hasNextPage } } }`;
  const data = await shopeeGraphQL(profile, query);
  const nodes = data?.productOfferV2?.nodes || data?.productOfferV2 || [];
  return (Array.isArray(nodes) ? nodes : []).map(normalizeProduct);
}

async function processQueue(profile) {
  const data = getData(profile);
  const item = data.queue.find(entry => entry.status === 'pending');
  if (!item) return;
  item.status = 'processing';
  item.startedAt = new Date().toISOString();
  await saveProfile(profile);
  try {
    const product = normalizeProduct(item.product || item);
    const destinations = data.destinations.filter(destination => destination.active !== false && (!data.automation.destinationIds?.length || data.automation.destinationIds.includes(destination.id)));
    let sent = 0;
    const results = [];
    for (const destination of destinations) {
      const match = destinationMatchesProduct(destination, product);
      if (!match.matches) { results.push({ destinationId: destination.id, sent: false, reason: match.reason }); continue; }
      try {
        await sendToDestination(profile, destination, product);
        sent++;
        results.push({ destinationId: destination.id, sent: true });
        await new Promise(resolve => setTimeout(resolve, 1200));
      } catch (error) { results.push({ destinationId: destination.id, sent: false, reason: error.message }); }
    }
    item.status = sent ? 'sent' : 'skipped';
    item.sentAt = new Date().toISOString();
    item.results = results;
  } catch (error) {
    item.status = 'error';
    item.error = error.message;
  }
  await saveProfile(profile);
}
async function runAutomation(profile) {
  if (automationLocks.has(profile)) return { ok: false, message: 'Automação já está em execução.' };
  automationLocks.add(profile);
  const data = getData(profile);
  try {
    if (!data.automation.enabled) return { ok: false, message: 'Automação pausada.' };
    if (!sockets.has(profile)) return { ok: false, message: 'Conecte o WhatsApp antes de iniciar a automação.' };
    await processQueue(profile);
    const offers = await fetchShopeeOffers(profile, data.automation.maxProducts || 10);
    const destinations = data.destinations.filter(destination => destination.active !== false && (!data.automation.destinationIds?.length || data.automation.destinationIds.includes(destination.id)));
    let sent = 0;
    for (const product of offers) {
      if (!product.productLink) continue;
      const productKey = String(product.id || product.productLink);      for (const destination of destinations) {
        const match = destinationMatchesProduct(destination, product);
        if (!match.matches) continue;
        const sentKey = `${destination.id}:${productKey}`;
        if (data.sentProducts[sentKey]) continue;
        try {
          await sendToDestination(profile, destination, product);
          data.sentProducts[sentKey] = new Date().toISOString();
          sent++;
          await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (error) { logger.warn({ profile, destination: destination.name, error: error.message }, 'Falha ao enviar oferta'); }
      }
    }
    data.automation.lastRunAt = new Date().toISOString();
    data.products = offers;
    // Limita o histórico de deduplicação para não crescer indefinidamente.
    const sentEntries = Object.entries(data.sentProducts).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 1500);
    data.sentProducts = Object.fromEntries(sentEntries);
    await saveProfile(profile);
    return { ok: true, found: offers.length, sent };
  } catch (error) {
    logger.error({ profile, error: error.message }, 'Erro na automação');
    return { ok: false, error: error.message };
  } finally { automationLocks.delete(profile); }
}

function routeError(res, error, status = 400) {
  logger.error({ error: error?.message || String(error) }, 'Erro em rota');
  return res.status(status).json({ ok: false, error: error?.message || 'Erro interno.' });
}

app.get('/health', (req, res) => {
  const profile = profileIdFrom(req);
  res.json({ ok: true, whatsapp: getStatus(profile).status, note: 'Saúde do servidor; não garante que o WhatsApp esteja conectado.' });
});
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
  res.type('html').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>MEDEIROS DIGITAL</title><body style="font-family:Arial;background:#101010;color:#fff;padding:32px"><h1>MEDEIROS DIGITAL</h1><p>Servidor do Robô de Ofertas está ativo.</p><p>Abra o painel index.html publicado junto com este servidor.</p></body></html>');
});
app.get('/api/profiles', (req, res) => res.json({ ok: true, profiles: PROFILE_IDS.map(id => ({ id, name: id === 'rafael' ? 'Rafael' : 'Usuário 2' })) }));
app.get('/api/status', async (req, res) => {
  const profile = profileIdFrom(req); const data = await loadProfile(profile);
  res.json({ ok: true, profile, whatsapp: getStatus(profile), automation: data.automation, destinations: data.destinations.length, shopeeConfigured: Boolean(getShopeeCredentials(profile).appId && getShopeeCredentials(profile).appSecret) });
});
app.get('/api/data', async (req, res) => {
  const profile = profileIdFrom(req); const data = await loadProfile(profile);
  res.json({ ok: true, profile, data: { ...data, whatsappAuth: undefined, shopeeCredentials: undefined }, whatsapp: getStatus(profile), niches: NICHE_DEFINITIONS });
});
app.get('/api/automation', async (req, res) => {
  const profile = profileIdFrom(req); const data = await loadProfile(profile);
  res.json({ ok: true, automation: data.automation });
});
app.post('/api/automation', async (req, res) => {
  try {
    const profile = profileIdFrom(req); const data = await loadProfile(profile);
    const body = req.body || {};
    data.automation = {
      ...data.automation,
      enabled: body.enabled === undefined ? data.automation.enabled : Boolean(body.enabled),
      intervalMinutes: Math.max(5, Math.min(1440, Number(body.intervalMinutes || data.automation.intervalMinutes || 30))),
      maxProducts: Math.max(1, Math.min(50, Number(body.maxProducts || data.automation.maxProducts || 10))),
      destinationIds: Array.isArray(body.destinationIds) ? body.destinationIds.map(String) : data.automation.destinationIds
    };
    await saveProfile(profile);
    res.json({ ok: true, automation: data.automation });
  } catch (error) { routeError(res, error); }
});

app.get('/api/whatsapp', (req, res) => {
  const profile = profileIdFrom(req);
  res.json({ ok: true, status: getStatus(profile), qr: qrCache.get(profile) || null, pairingCode: pairingCache.get(profile) || null });
});
app.post('/api/whatsapp/connect', async (req, res) => {
  try { const profile = profileIdFrom(req); const result = await startWhatsApp(profile); res.json(result); }
  catch (error) { routeError(res, error); }
});
app.post('/api/whatsapp/pairing', async (req, res) => {
  try {
    const profile = profileIdFrom(req); const phone = String(req.body.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ ok: false, error: 'Informe o telefone com DDD e código do país.' });
    if (!sockets.has(profile)) await startWhatsApp(profile);
    const sock = sockets.get(profile);
    if (!sock?.requestPairingCode) return res.status(409).json({ ok: false, error: 'Aguarde o WhatsApp iniciar e tente novamente.' });
    const code = await sock.requestPairingCode(phone);
    pairingCache.set(profile, code);
    res.json({ ok: true, code });
  } catch (error) { routeError(res, error); }
});
app.post('/api/whatsapp/disconnect', async (req, res) => {
  const profile = profileIdFrom(req);
  try {
    const sock = sockets.get(profile);
    if (sock) { try { await sock.logout(); } catch (_) {} sockets.delete(profile); }
    await clearWhatsAppAuth(profile);
    setStatus(profile, 'disconnected');
    res.json({ ok: true, message: 'WhatsApp desconectado. A sessão salva foi removida por solicitação.' });
  } catch (error) { routeError(res, error); }
});
app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const profile = profileIdFrom(req); const sock = sockets.get(profile);
    if (!sock) return res.status(409).json({ ok: false, error: 'WhatsApp não conectado.' });
    const to = String(req.body.to || req.body.groupId || '').trim();
    const message = String(req.body.message || '').trim();
    if (!to || !message) return res.status(400).json({ ok: false, error: 'Informe destino e mensagem.' });
    await sock.sendMessage(to, { text: message });
    res.json({ ok: true });
  } catch (error) { routeError(res, error); }
});
app.get('/api/whatsapp/groups', async (req, res) => {
  try {
    const profile = profileIdFrom(req); const sock = sockets.get(profile);
    if (!sock) return res.status(409).json({ ok: false, error: 'WhatsApp não conectado.' });
    const groups = await sock.groupFetchAllParticipating();
    res.json({ ok: true, groups: Object.entries(groups || {}).map(([id, group]) => ({ id, groupId: id, name: group.subject || id, participants: group.participants?.length || 0 })) });
  } catch (error) { routeError(res, error); }
});

app.get('/api/niches', (req, res) => res.json({ ok: true, niches: NICHE_DEFINITIONS }));
app.post('/api/niches/classify', (req, res) => {
  const product = req.body.product || req.body || {};
  res.json({ ok: true, niches: classifyProductNiches(product) });
});
app.get('/api/destinations', async (req, res) => {
  const profile = profileIdFrom(req); const data = await loadProfile(profile);
  res.json({ ok: true, destinations: data.destinations.map(publicDestination), niches: NICHE_DEFINITIONS });
});
app.post('/api/destinations', async (req, res) => {
  try {
    const profile = profileIdFrom(req); const data = await loadProfile(profile);
    const body = req.body || {};
    const groupId = String(body.groupId || body.id || '').trim();
    const name = String(body.name || body.subject || '').trim();
    if (!name || !groupId) return res.status(400).json({ ok: false, error: 'Informe o nome e o ID do grupo WhatsApp.' });
    const existing = data.destinations.find(item => item.groupId === groupId);
    if (existing) return res.status(409).json({ ok: false, error: 'Este grupo já está cadastrado.', destination: publicDestination(existing) });
    const destination = {
      id: crypto.randomUUID(), name, phone: String(body.phone || '').trim(), groupId,
      nicheId: String(body.nicheId || 'auto').trim().toLowerCase(),
      active: body.active !== false, createdAt: new Date().toISOString()
    };
    if (destination.nicheId !== 'auto' && destination.nicheId !== 'all' && !NICHE_DEFINITIONS.some(n => n.id === destination.nicheId)) return res.status(400).json({ ok: false, error: 'Nicho inválido.' });
    data.destinations.push(destination); await saveProfile(profile);
    res.json({ ok: true, destination: publicDestination(destination), destinations: data.destinations.map(publicDestination) });
  } catch (error) { routeError(res, error); }
});
async function updateDestination(profile, id, body) {
  const data = await loadProfile(profile);
  const destination = data.destinations.find(item => item.id === id || item.groupId === id);
  if (!destination) return { error: 'Grupo não encontrado.', status: 404 };
  if (body.name !== undefined) destination.name = String(body.name).trim();
  if (body.nicheId !== undefined) destination.nicheId = String(body.nicheId).trim().toLowerCase();
  if (body.active !== undefined) destination.active = Boolean(body.active);
  if (body.groupId !== undefined) destination.groupId = String(body.groupId).trim();
  if (destination.nicheId !== 'auto' && destination.nicheId !== 'all' && !NICHE_DEFINITIONS.some(n => n.id === destination.nicheId)) return { error: 'Nicho inválido.', status: 400 };
  await saveProfile(profile);
  return { destination: publicDestination(destination), destinations: data.destinations.map(publicDestination) };
}
app.patch('/api/destinations/:id', async (req, res) => {
  try {
    const result = await updateDestination(profileIdFrom(req), req.params.id, req.body || {});
    if (result.error) return res.status(result.status).json({ ok: false, error: result.error });
    res.json({ ok: true, ...result });
  } catch (error) { routeError(res, error); }
});
app.post('/api/destinations/update', async (req, res) => {
  try {
    const id = String(req.body.id || req.body.destinationId || req.body.groupId || '');
    const result = await updateDestination(profileIdFrom(req), id, req.body || {});
    if (result.error) return res.status(result.status).json({ ok: false, error: result.error });
    res.json({ ok: true, ...result });
  } catch (error) { routeError(res, error); }
});
app.delete('/api/destinations/:id', async (req, res) => {
  const profile = profileIdFrom(req); const data = await loadProfile(profile);
  const before = data.destinations.length;
  data.destinations = data.destinations.filter(item => item.id !== req.params.id && item.groupId !== req.params.id);
  if (before === data.destinations.length) return res.status(404).json({ ok: false, error: 'Grupo não encontrado.' });
  await saveProfile(profile); res.json({ ok: true, destinations: data.destinations.map(publicDestination) });
});

app.post('/api/products', async (req, res) => {
  const profile = profileIdFrom(req); const data = await loadProfile(profile);
  const product = normalizeProduct(req.body.product || req.body);
  data.products.unshift(product); data.products = data.products.slice(0, 200);
  await saveProfile(profile); res.json({ ok: true, product });
});
app.post('/api/queue', async (req, res) => {
  const profile = profileIdFrom(req); const data = await loadProfile(profile);
  const product = normalizeProduct(req.body.product || req.body);
  const entry = { id: crypto.randomUUID(), product, status: 'pending', createdAt: new Date().toISOString() };
  data.queue.push(entry); await saveProfile(profile);
  res.json({ ok: true, item: entry, message: 'Oferta adicionada à fila.' });
});
app.get('/api/queue', async (req, res) => {
  const profile = profileIdFrom(req); const data = await loadProfile(profile);
  res.json({ ok: true, queue: data.queue.slice(-100).reverse() });
});
app.post('/api/queue/process', async (req, res) => {
  try { const profile = profileIdFrom(req); await processQueue(profile); res.json({ ok: true, queue: getData(profile).queue.slice(-100).reverse() }); }
  catch (error) { routeError(res, error); }
});

app.get('/api/shopee/credentials', async (req, res) => {
  const profile = profileIdFrom(req); const credentials = getShopeeCredentials(profile);
  const configured = Boolean(credentials.appId && credentials.appSecret);
  res.json({ ok: true, configured, credentials: { appId: credentials.appId ? '••••••' : '', appSecret: credentials.appSecret ? '••••••' : '', partnerId: credentials.appId ? '••••••' : '', partnerKey: credentials.appSecret ? '••••••' : '' } });
});
app.post('/api/shopee/credentials', async (req, res) => {
  try {
    const profile = profileIdFrom(req); const data = await loadProfile(profile); const body = req.body || {};
    const previous = getShopeeCredentials(profile);
    const credentials = {
      appId: String(body.appId || body.partnerId || body.partner_id || previous.appId || ''),
      appSecret: String(body.appSecret || body.partnerKey || body.partner_key || previous.appSecret || '')
    };
    if (!credentials.appId || !credentials.appSecret) return res.status(400).json({ ok: false, error: 'Informe o App ID e o Secret da Shopee.' });
    data.shopeeCredentials = encryptObject(credentials); await saveProfile(profile);
    res.json({ ok: true, configured: true, message: 'Credenciais salvas com segurança para este perfil.' });
  } catch (error) { routeError(res, error); }
});
app.get('/api/shopee/products', async (req, res) => {
  try { const profile = profileIdFrom(req); const products = await fetchShopeeOffers(profile, req.query.limit || 10); res.json({ ok: true, products }); }
  catch (error) { routeError(res, error); }
});
app.post('/api/shopee/test', async (req, res) => {
  try { const profile = profileIdFrom(req); const products = await fetchShopeeOffers(profile, 3); res.json({ ok: true, count: products.length, products }); }
  catch (error) { routeError(res, error); }
});
app.post('/api/automation/run', async (req, res) => {
  const profile = profileIdFrom(req); const result = await runAutomation(profile); res.status(result.ok ? 200 : 409).json(result);
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'Rota não encontrada.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  routeError(res, error, 500);
});

async function initializeApp() {
  for (const profile of PROFILE_IDS) await loadProfile(profile);
  logger.info({ port: PORT, supabase: Boolean(supabase), profiles: PROFILE_IDS }, 'MEDEIROS DIGITAL iniciado');
}

const automationTimer = setInterval(async () => {
  for (const profile of PROFILE_IDS) {
    const data = getData(profile);
    if (!data.automation.enabled) continue;
    const interval = Math.max(5, Number(data.automation.intervalMinutes || 30)) * 60 * 1000;
    const lastRun = data.automation.lastRunAt ? new Date(data.automation.lastRunAt).getTime() : 0;
    if (Date.now() - lastRun >= interval) await runAutomation(profile);
  }
}, 60 * 1000);
if (typeof automationTimer.unref === 'function') automationTimer.unref();

app.listen(PORT, '0.0.0.0', () => {
  initializeApp().catch(error => logger.error({ error: error.message }, 'Falha ao inicializar aplicação'));
});

process.on('unhandledRejection', error => logger.error({ error: error?.message || String(error) }, 'Promise rejeitada'));
process.on('uncaughtException', error => logger.error({ error: error?.message || String(error) }, 'Exceção não tratada'));
