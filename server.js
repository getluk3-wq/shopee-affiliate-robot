
const express = require("express");
const helmet = require("helmet");
const crypto = require("crypto");
const path = require("path");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");

const {
  default: makeWASocket,
  DisconnectReason,
  BufferJSON,
  initAuthCreds,
  proto
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;
const TIME_ZONE = "America/Sao_Paulo";
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));

// =====================================================
// SUPABASE
// =====================================================

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Render.");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

async function updateProfileColumn(profileId, column, value) {
  const allowed = ["dados", "credenciais_shopee", "sessao_whatsapp"];

  if (!allowed.includes(column)) {
    throw new Error("Coluna de perfil não permitida.");
  }

  const payload = {
    [column]: value,
    atualizado_em: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from("robo_perfis")
    .update(payload)
    .eq("perfil", profileId)
    .select("perfil");

  if (error) throw error;

  if (!data || data.length === 0) {
    const { error: insertError } = await supabase
      .from("robo_perfis")
      .insert({ perfil: profileId, ...payload });

    if (insertError) throw insertError;
  }
}

// =====================================================
// PERFIS
// =====================================================

const PROFILES = {
  rafael: { id: "rafael", name: "Rafael" },
  usuario2: { id: "usuario2", name: "Usuário 2" }
};

function createSession() {
  return {
    socket: null,
    authState: null,
    status: "disconnected",
    qr: null,
    pairingCode: null,
    initPromise: null,
    pairingPromise: null,
    pairingReady: false,
    pairingWaiters: [],
    manualDisconnect: false,
    reconnectTimer: null,
    reconnectAttempts: 0,
    lastError: null
  };
}

const sessions = {
  rafael: createSession(),
  usuario2: createSession()
};

const shopeeCredentials = {
  rafael: null,
  usuario2: null
};

const activeSearches = {
  rafael: false,
  usuario2: false
};

const automationRunning = {
  rafael: false,
  usuario2: false
};

// =====================================================
// IDENTIFICAÇÃO AUTOMÁTICA DE NICHOS
// =====================================================

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NICHE_DEFINITIONS = [
  {
    id: "moda_feminina",
    label: "Moda Feminina",
    keywords: [
      "moda feminina", "roupa feminina", "vestido", "blusa feminina",
      "saia", "cropped", "conjunto feminino", "lingerie", "sutia",
      "calcinha", "body feminino", "top feminino", "calca feminina",
      "short feminino", "moda mulher", "feminino"
    ]
  },
  {
    id: "moda_masculina",
    label: "Moda Masculina",
    keywords: [
      "moda masculina", "roupa masculina", "camisa masculina",
      "camiseta masculina", "bermuda masculina", "calca masculina",
      "cueca", "polo masculina", "moletom masculino",
      "masculino"
    ]
  },
  {
    id: "calcados_bolsas",
    label: "Calçados e Bolsas",
    keywords: [
      "calcados", "sapato", "tenis", "sandalia", "chinelo",
      "bota", "rasteirinha", "scarpin", "bolsa", "mochila",
      "carteira", "mala", "sapatilha"
    ]
  },
  {
    id: "eletronicos",
    label: "Eletrônicos",
    keywords: [
      "eletronicos", "celular", "smartphone", "fone", "headphone",
      "bluetooth", "caixa de som", "televisao", "televisor",
      "smartwatch", "carregador", "cabo usb", "camera digital",
      "tablet", "controle remoto", "videogame", "console",
      "power bank", "tv"
    ]
  },
  {
    id: "informatica",
    label: "Informática",
    keywords: [
      "informatica", "notebook", "laptop", "computador",
      "teclado", "mouse", "monitor", "impressora", "roteador",
      "webcam", "hd externo", "ssd", "memoria ram",
      "placa de video", "gabinete"
    ]
  },
  {
    id: "casa_decoracao",
    label: "Casa e Decoração",
    keywords: [
      "casa e decoracao", "decoracao", "cozinha", "panela",
      "utensilio", "organizador", "sofa", "mesa", "cadeira",
      "cama", "banho", "cortina", "tapete", "luminaria",
      "eletrodomestico", "ventilador", "liquidificador",
      "air fryer", "fritadeira", "cafeteira", "torneira"
    ]
  },
  {
    id: "beleza_cosmeticos",
    label: "Beleza e Cosméticos",
    keywords: [
      "beleza", "cosmeticos", "maquiagem", "batom",
      "rimel", "mascara de cilios", "base facial", "corretivo",
      "skincare", "hidratante", "shampoo", "condicionador",
      "esmalte", "unha", "creme facial", "protetor solar",
      "cosmetico", "pincel de maquiagem"
    ]
  },
  {
    id: "perfumes",
    label: "Perfumes",
    keywords: [
      "perfume", "perfumaria", "colonia", "deo parfum",
      "eau de parfum", "body splash", "fragrancia",
      "desodorante"
    ]
  },
  {
    id: "infantil_bebe",
    label: "Infantil e Bebê",
    keywords: [
      "infantil", "bebe", "brinquedo", "fralda", "mamadeira",
      "carrinho de bebe", "roupa infantil", "crianca",
      "boneca", "lego", "chocalho", "berco", "puericultura"
    ]
  },
  {
    id: "esportes_fitness",
    label: "Esportes e Fitness",
    keywords: [
      "esportes", "fitness", "academia", "halter", "anilha",
      "bicicleta", "corrida", "treino", "yoga", "pilates",
      "bola esportiva", "tenis esportivo", "colchonete",
      "equipamento de ginastica"
    ]
  },
  {
    id: "mercado_alimentos",
    label: "Mercado e Alimentos",
    keywords: [
      "mercado", "alimentos", "cafe", "arroz", "feijao",
      "acucar", "oleo de cozinha", "biscoito", "chocolate",
      "alimento", "bebida", "mantimento", "mercearia"
    ]
  },
  {
    id: "automotivo",
    label: "Automotivo",
    keywords: [
      "automotivo", "carro", "moto", "veiculo", "pneu",
      "peca automotiva", "acessorios carro", "capacete",
      "oleo motor", "ferramenta automotiva", "som automotivo"
    ]
  }
];

function scoreNiche(text, definition) {
  const normalized = normalizeText(text);
  if (!normalized) return 0;

  let score = 0;

  for (const keyword of definition.keywords) {
    const normalizedKeyword = normalizeText(keyword);

    if (!normalizedKeyword) continue;

    if (normalized.includes(normalizedKeyword)) {
      // Expressões específicas têm mais peso.
      score += normalizedKeyword.includes(" ") ? 3 : 2;
    }
  }

  return score;
}

function classifyGroupNiche(groupName) {
  const text = normalizeText(groupName);

  if (!text) {
    return {
      id: "unknown",
      label: "Não identificado",
      confidence: 0
    };
  }

  const scores = NICHE_DEFINITIONS
    .map(definition => ({
      id: definition.id,
      label: definition.label,
      score: scoreNiche(text, definition)
    }))
    .sort((a, b) => b.score - a.score);

  const best = scores[0];
  const second = scores[1];

  // Para grupos, exige um nome suficientemente específico.
  if (
    !best ||
    best.score < 2 ||
    (second && best.score === second.score)
  ) {
    return {
      id: "unknown",
      label: "Não identificado",
      confidence: 0
    };
  }

  return {
    id: best.id,
    label: best.label,
    confidence: Math.min(100, best.score * 20)
  };
}

function classifyProductNiches(product) {
  const title = normalizeText(product?.productName || product?.name || product?.title);
  const description = normalizeText(product?.description || "");
  const category = normalizeText(
    product?.category || product?.categoryName || product?.category_name || ""
  );
  const shop = normalizeText(product?.shopName || "");

  const titleScores = NICHE_DEFINITIONS.map(definition => ({
    id: definition.id,
    label: definition.label,
    score: scoreNiche(title, definition)
  }));

  const categoryScores = NICHE_DEFINITIONS.map(definition => ({
    id: definition.id,
    score: scoreNiche(category, definition)
  }));

  const descriptionScores = NICHE_DEFINITIONS.map(definition => ({
    id: definition.id,
    score: scoreNiche(description, definition)
  }));

  const shopScores = NICHE_DEFINITIONS.map(definition => ({
    id: definition.id,
    score: scoreNiche(shop, definition)
  }));

  const results = [];

  for (const definition of NICHE_DEFINITIONS) {
    const titleScore =
      titleScores.find(item => item.id === definition.id)?.score || 0;

    const categoryScore =
      categoryScores.find(item => item.id === definition.id)?.score || 0;

    const descriptionScore =
      descriptionScores.find(item => item.id === definition.id)?.score || 0;

    const shopScore =
      shopScores.find(item => item.id === definition.id)?.score || 0;

    // O título é a principal fonte de identificação.
    const total =
      titleScore * 3 +
      categoryScore * 3 +
      descriptionScore +
      shopScore;

    // Sem evidência suficiente no título ou categoria, não classifica.
    const confident =
      titleScore >= 2 ||
      categoryScore >= 2 ||
      (titleScore >= 1 && descriptionScore >= 3);

    if (total >= 4 && confident) {
      results.push({
        id: definition.id,
        label: definition.label,
        score: total
      });
    }
  }

  // Ordena os nichos identificados por força da correspondência.
  results.sort((a, b) => b.score - a.score);

  return results;
}

function getProductNicheLabels(product) {
  return classifyProductNiches(product).map(item => item.label);
}

function destinationMatchesProduct(destination, product) {
  const groupNiche = classifyGroupNiche(destination.name);
  const productNiches = classifyProductNiches(product);

  if (groupNiche.id === "unknown") {
    return {
      matches: false,
      reason: `Nicho do grupo "${destination.name}" não identificado.`,
      groupNiche,
      productNiches
    };
  }

  if (!productNiches.length) {
    return {
      matches: false,
      reason: `Nicho do produto "${product.productName || product.name}" não identificado.`,
      groupNiche,
      productNiches
    };
  }

  const matches = productNiches.some(item => item.id === groupNiche.id);

  return {
    matches,
    reason: matches
      ? "Nicho compatível."
      : `Produto não pertence ao nicho ${groupNiche.label}.`,
    groupNiche,
    productNiches
  };
}

// =====================================================
// UTILITÁRIOS
// =====================================================

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidProfile(profileId) {
  return Boolean(PROFILES[profileId]);
}

function isValidTime(value) {
  return typeof value === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function getProfile(req) {
  const requested =
    req.query.profile ||
    req.body?.profile ||
    req.headers["x-profile"] ||
    "rafael";

  return isValidProfile(requested) ? requested : "rafael";
}

function adminOnly(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    return res.status(500).json({
      error: "ADMIN_PASSWORD não configurada no Render."
    });
  }

  if (req.headers["x-admin-password"] !== password) {
    return res.status(401).json({
      error: "Senha administrativa inválida."
    });
  }

  next();
}

function defaultAutomation() {
  return {
    active: false,
    startTime: "08:00",
    endTime: "18:00",
    scheduleTimes: ["08:00"],
    intervalSeconds: 1800,
    intervalMinutes: 30,
    destinationIds: [],
    sentProductIds: [],
    lastWindowKey: null,
    nextSendAt: null,
    lastSentAt: null,
    lastError: null
  };
}

function normalizeAutomation(saved = {}) {
  const defaults = defaultAutomation();

  let seconds = saved.intervalSeconds !== undefined
    ? Number(saved.intervalSeconds)
    : saved.intervalMinutes !== undefined
      ? Number(saved.intervalMinutes) * 60
      : defaults.intervalSeconds;

  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 86400) {
    seconds = defaults.intervalSeconds;
  }

  const legacyStart = Array.isArray(saved.scheduleTimes)
    ? saved.scheduleTimes[0]
    : null;

  const startTime = isValidTime(saved.startTime)
    ? saved.startTime
    : isValidTime(legacyStart)
      ? legacyStart
      : defaults.startTime;

  const endTime = isValidTime(saved.endTime)
    ? saved.endTime
    : defaults.endTime;

  return {
    ...defaults,
    ...saved,
    startTime,
    endTime,
    intervalSeconds: seconds,
    intervalMinutes: seconds / 60,
    scheduleTimes: [startTime],
    destinationIds: Array.isArray(saved.destinationIds)
      ? saved.destinationIds
      : [],
    sentProductIds: Array.isArray(saved.sentProductIds)
      ? saved.sentProductIds
      : []
  };
}

function defaultStore() {
  return {
    products: [],
    destinations: [],
    queue: [],
    automation: defaultAutomation()
  };
}

function normalizeStore(data = {}) {
  return {
    products: Array.isArray(data.products) ? data.products : [],
    destinations: Array.isArray(data.destinations) ? data.destinations : [],
    queue: Array.isArray(data.queue) ? data.queue : [],
    automation: normalizeAutomation(data.automation || {})
  };
}

// =====================================================
// DADOS DO PAINEL NO SUPABASE
// =====================================================

const storeCache = {
  rafael: defaultStore(),
  usuario2: defaultStore()
};

const storeWriteQueues = {
  rafael: Promise.resolve(),
  usuario2: Promise.resolve()
};

async function loadStoresFromSupabase() {
  const { data, error } = await supabase
    .from("robo_perfis")
    .select("perfil, dados, credenciais_shopee");

  if (error) throw error;

  for (const profileId of Object.keys(PROFILES)) {
    const row = (data || []).find(item => item.perfil === profileId);

    storeCache[profileId] = normalizeStore(row?.dados || {});

    if (row?.credenciais_shopee) {
      shopeeCredentials[profileId] = row.credenciais_shopee;
    }
  }
}

function loadStore(profileId) {
  return isValidProfile(profileId)
    ? storeCache[profileId]
    : defaultStore();
}

function saveStore(profileId, data) {
  if (!isValidProfile(profileId)) {
    return Promise.reject(new Error("Perfil inválido."));
  }

  const normalized = normalizeStore(data);
  storeCache[profileId] = normalized;

  storeWriteQueues[profileId] = storeWriteQueues[profileId]
    .catch(() => {})
    .then(() => updateProfileColumn(profileId, "dados", normalized));

  return storeWriteQueues[profileId];
}

async function persistShopeeCredentials(profileId, credentials) {
  await updateProfileColumn(profileId, "credenciais_shopee", credentials);
}

// =====================================================
// HORÁRIO DE SÃO PAULO
// =====================================================

function getSaoPauloDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") result[part.type] = part.value;
  }

  return result;
}

function getSaoPauloTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function getDateKey(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getPreviousDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));

  return [
    previous.getUTCFullYear(),
    String(previous.getUTCMonth() + 1).padStart(2, "0"),
    String(previous.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function getCurrentWindow(automation, now = new Date()) {
  const startTime = automation.startTime || "08:00";
  const endTime = automation.endTime || "18:00";

  if (!isValidTime(startTime) || !isValidTime(endTime)) return null;
  if (startTime === endTime) return null;

  const currentTime = getSaoPauloTime(now);
  const todayKey = getDateKey(getSaoPauloDateParts(now));
  const crossesMidnight = startTime > endTime;

  let isInsideWindow = false;
  let sessionDateKey = todayKey;

  if (!crossesMidnight) {
    isInsideWindow = currentTime >= startTime && currentTime < endTime;
  } else {
    isInsideWindow = currentTime >= startTime || currentTime < endTime;

    if (currentTime < endTime) {
      sessionDateKey = getPreviousDateKey(todayKey);
    }
  }

  if (!isInsideWindow) return null;

  return {
    start: startTime,
    end: endTime,
    key: `${sessionDateKey}-${startTime}-${endTime}`
  };
}

// =====================================================
// CRIPTOGRAFIA SHOPEE
// =====================================================

function getEncryptionKey() {
  const value = process.env.SHOPEE_CREDENTIALS_KEY || "";

  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(
      "Configure SHOPEE_CREDENTIALS_KEY no Render com 64 caracteres hexadecimais."
    );
  }

  return Buffer.from(value, "hex");
}

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final()
  ]);

  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: encrypted.toString("hex")
  };
}

function decryptSecret(saved) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(saved.iv, "hex")
  );

  decipher.setAuthTag(Buffer.from(saved.tag, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(saved.data, "hex")),
    decipher.final()
  ]).toString("utf8");
}

function getShopeeCredentials(profileId) {
  const saved = shopeeCredentials[profileId];

  if (!saved) {
    throw new Error("Cadastre as credenciais Shopee deste perfil primeiro.");
  }

  return {
    appId: saved.appId,
    secret: decryptSecret(saved.encryptedSecret)
  };
}

async function shopeeRequest(profileId, query, variables = {}) {
  const credentials = getShopeeCredentials(profileId);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({ query, variables });

      const signature = crypto
        .createHash("sha256")
        .update(
          credentials.appId +
          timestamp +
          payload +
          credentials.secret
        )
        .digest("hex");

      const authorization =
        `SHA256 Credential=${credentials.appId}, ` +
        `Timestamp=${timestamp}, Signature=${signature}`;

      const response = await fetch(
        "https://open-api.affiliate.shopee.com.br/graphql",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authorization
          },
          body: payload,
          signal: AbortSignal.timeout(30000)
        }
      );

      const raw = await response.text();
      let result;

      try {
        result = JSON.parse(raw);
      } catch {
        const error = new Error(
          `Resposta inesperada da Shopee. HTTP ${response.status}.`
        );

        error.retryable =
          response.status === 429 || response.status >= 500;

        throw error;
      }

      if (!response.ok) {
        const error = new Error(
          result.message ||
          result.error ||
          `Erro HTTP ${response.status} na Shopee.`
        );

        error.retryable =
          response.status === 429 || response.status >= 500;

        throw error;
      }

      if (result.errors?.length) {
        const message = result.errors
          .map(item => item.message || "Erro desconhecido")
          .join("; ");

        const error = new Error(message);

        error.retryable =
          /10000|system\s*error|temporar|internal server/i.test(message);

        throw error;
      }

      return result.data;
    } catch (error) {
      const retryable =
        error.retryable === true ||
        error.name === "TimeoutError" ||
        error.name === "AbortError" ||
        error.name === "TypeError";

      if (!retryable || attempt === 3) throw error;

      await wait(attempt * 2000);
    }
  }

  throw new Error("Não foi possível consultar a Shopee.");
}

// =====================================================
// AUTENTICAÇÃO WHATSAPP PERSISTENTE NO SUPABASE
// =====================================================

function serializeBaileys(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function deserializeBaileys(value) {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

async function createSupabaseAuthState(profileId) {
  const { data: profile, error: profileError } = await supabase
    .from("robo_perfis")
    .select("sessao_whatsapp")
    .eq("perfil", profileId)
    .maybeSingle();

  if (profileError) throw profileError;

  const creds = profile?.sessao_whatsapp
    ? deserializeBaileys(profile.sessao_whatsapp)
    : initAuthCreds();

  const { data: savedKeys, error: keysError } = await supabase
    .from("robo_whatsapp_chaves")
    .select("chave, valor")
    .eq("perfil", profileId);

  if (keysError) throw keysError;

  const keysMap = new Map(
    (savedKeys || []).map(row => [row.chave, row.valor])
  );

  let credsWriteQueue = Promise.resolve();

  const keys = {
    get: async (type, ids) => {
      const result = {};

      for (const id of ids) {
        const stored = keysMap.get(`${type}-${id}`);

        if (stored !== undefined && stored !== null) {
          let value = deserializeBaileys(stored);

          if (type === "app-state-sync-key") {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }

          result[id] = value;
        }
      }

      return result;
    },

    set: async data => {
      const upserts = [];
      const deletions = [];

      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries || {})) {
          const chave = `${type}-${id}`;

          if (value === null || value === undefined) {
            deletions.push(chave);
          } else {
            upserts.push({
              perfil: profileId,
              chave,
              valor: serializeBaileys(value),
              atualizado_em: new Date().toISOString()
            });
          }
        }
      }

      if (upserts.length) {
        const { error } = await supabase
          .from("robo_whatsapp_chaves")
          .upsert(upserts, { onConflict: "perfil,chave" });

        if (error) throw error;

        for (const item of upserts) {
          keysMap.set(item.chave, item.valor);
        }
      }

      if (deletions.length) {
        const { error } = await supabase
          .from("robo_whatsapp_chaves")
          .delete()
          .eq("perfil", profileId)
          .in("chave", deletions);

        if (error) throw error;

        for (const key of deletions) {
          keysMap.delete(key);
        }
      }
    }
  };

  const saveCreds = async () => {
    const snapshot = serializeBaileys(creds);

    credsWriteQueue = credsWriteQueue
      .catch(() => {})
      .then(async () => {
        let lastError;

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await updateProfileColumn(
              profileId,
              "sessao_whatsapp",
              snapshot
            );

            console.log(
              `Credenciais WhatsApp salvas no Supabase: ${profileId}`
            );

            return;
          } catch (error) {
            lastError = error;

            console.error(
              `Tentativa ${attempt}/3 ao salvar sessão (${profileId}):`,
              error.message
            );

            if (attempt < 3) await wait(attempt * 1000);
          }
        }

        throw lastError;
      });

    return credsWriteQueue;
  };

  return {
    state: { creds, keys },
    saveCreds,
    storedKeysCount: keysMap.size
  };
}

async function clearWhatsAppAuth(profileId) {
  await updateProfileColumn(profileId, "sessao_whatsapp", null);

  const { error } = await supabase
    .from("robo_whatsapp_chaves")
    .delete()
    .eq("perfil", profileId);

  if (error) throw error;
}

// =====================================================
// PRODUTOS E OFERTAS
// =====================================================

async function getAutomaticOffer(profileId, store) {
  const query = `
    query AutomaticOffers($page: Int, $limit: Int) {
      productOfferV2(
        keyword: "",
        sortType: 5,
        page: $page,
        limit: $limit
      ) {
        nodes {
          itemId
          productName
          productLink
          offerLink
          imageUrl
          priceMin
          priceMax
          priceDiscountRate
          sales
          ratingStar
          commissionRate
          sellerCommissionRate
          shopeeCommissionRate
          commission
          shopName
        }
        pageInfo {
          page
          limit
          hasNextPage
        }
      }
    }
  `;

  const data = await shopeeRequest(profileId, query, {
    page: 1,
    limit: 30
  });

  const products = data?.productOfferV2?.nodes || [];
  const sent = new Set(store.automation.sentProductIds);

  const available = products.find(product => {
    const id = String(product.itemId || "").trim();
    return id && !sent.has(id);
  });

  if (!available) {
    throw new Error(
      "Não há novos produtos nesta página da Shopee. Nenhum produto repetido será enviado."
    );
  }

  return available;
}

function formatMoney(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) return null;

  return number.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });
}

function getDiscountPercent(value) {
  const raw = Number(value);

  if (!Number.isFinite(raw) || raw <= 0 || raw >= 100) return null;

  const percent = raw < 1 ? raw * 100 : raw;

  return percent > 0 && percent < 100 ? percent : null;
}

function createOfferMessage(product) {
  const link = product.offerLink || product.productLink;

  if (!link) throw new Error("O produto não possui link de afiliado.");

  let safeLink;

  try {
    const parsed = new URL(link);

    if (parsed.protocol !== "https:") {
      throw new Error("Link não seguro.");
    }

    safeLink = parsed.href;
  } catch {
    throw new Error("Link de oferta inválido.");
  }

  const currentPriceNumber = Number(product.priceMin);
  const currentPrice = formatMoney(currentPriceNumber);
  const discountPercent = getDiscountPercent(product.priceDiscountRate);

  const lines = [
    "🔥 OFERTA IMPERDÍVEL!",
    "",
    `🛍️ ${product.productName || "Confira esta oferta"}`
  ];

  if (currentPrice) {
    lines.push(`💰 Por apenas: ${currentPrice}`);
  }

  if (
    currentPrice &&
    discountPercent !== null &&
    currentPriceNumber > 0
  ) {
    const originalPriceNumber =
      currentPriceNumber / (1 - discountPercent / 100);

    const originalPrice = formatMoney(originalPriceNumber);

    if (originalPrice && originalPriceNumber > currentPriceNumber) {
      lines.push(`❌ De: ${originalPrice}`);
      lines.push(`🔥 Desconto de ${Math.round(discountPercent)}%`);
    }
  }

  lines.push("", "👉 Aproveite aqui:", safeLink);

  return lines.join("\n");
}

// =====================================================
// ENVIO DA FOTO DO PRODUTO
// =====================================================

async function downloadProductImage(imageUrl) {
  if (!imageUrl || typeof imageUrl !== "string") {
    throw new Error("O produto não possui foto disponível.");
  }

  let parsed;

  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error("Endereço da foto inválido.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("A foto precisa utilizar uma conexão HTTPS.");
  }

  const response = await fetch(parsed.href, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent": "Mozilla/5.0 MEDEIROS-DIGITAL"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Não foi possível baixar a foto. HTTP ${response.status}.`
    );
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("O endereço informado não retornou uma imagem.");
  }

  const contentLength = Number(
    response.headers.get("content-length") || 0
  );

  if (contentLength > MAX_IMAGE_SIZE) {
    throw new Error("A foto do produto ultrapassa o limite de 8 MB.");
  }

  const imageBuffer = Buffer.from(await response.arrayBuffer());

  if (!imageBuffer.length || imageBuffer.length > MAX_IMAGE_SIZE) {
    throw new Error("A foto recebida está vazia ou ultrapassa 8 MB.");
  }

  return {
    buffer: imageBuffer,
    mimetype: contentType.split(";")[0].trim()
  };
}

async function sendProductOffer(socket, destination, product, message) {
  try {
    const image = await downloadProductImage(product.imageUrl);

    await socket.sendMessage(destination, {
      image: image.buffer,
      mimetype: image.mimetype,
      caption: message
    });

    return { sent: true, withImage: true };
  } catch (error) {
    console.error("Não foi possível enviar a foto:", error.message);

    await socket.sendMessage(destination, { text: message });

    return {
      sent: true,
      withImage: false,
      imageError: error.message
    };
  }
}

// =====================================================
// WHATSAPP - PAREAMENTO E RECONEXÃO
// =====================================================

function resolvePairingWaiters(session) {
  const waiters = session.pairingWaiters.splice(0);

  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
}

function rejectPairingWaiters(session, error) {
  const waiters = session.pairingWaiters.splice(0);

  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function waitForPairingReady(session, timeoutMs = 30000) {
  if (session.status === "connected") {
    return Promise.reject(
      new Error("Este WhatsApp já está conectado.")
    );
  }

  if (session.socket && session.pairingReady) {
    return Promise.resolve();
  }

  if (!session.socket) {
    return Promise.reject(
      new Error("O WhatsApp não iniciou corretamente. Tente conectar novamente.")
    );
  }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };

    waiter.timer = setTimeout(() => {
      const index = session.pairingWaiters.indexOf(waiter);

      if (index !== -1) {
        session.pairingWaiters.splice(index, 1);
      }

      reject(new Error(
        "O WhatsApp não disponibilizou o pareamento a tempo. Aguarde e tente novamente."
      ));
    }, timeoutMs);

    session.pairingWaiters.push(waiter);
  });
}

function scheduleReconnect(profileId) {
  const session = sessions[profileId];

  if (
    session.manualDisconnect ||
    session.reconnectTimer ||
    session.status === "connected"
  ) return;

  session.reconnectAttempts++;

  const delay = Math.min(
    5000 * Math.pow(2, session.reconnectAttempts - 1),
    60000
  );

  session.reconnectTimer = setTimeout(async () => {
    session.reconnectTimer = null;

    if (session.manualDisconnect) return;

    try {
      await initializeWhatsApp(profileId);
    } catch (error) {
      console.error(
        `Falha ao reconectar ${profileId}:`,
        error.message
      );

      scheduleReconnect(profileId);
    }
  }, delay);
}

async function initializeWhatsApp(profileId) {
  const session = sessions[profileId];

  if (!isValidProfile(profileId)) {
    throw new Error("Perfil inválido.");
  }

  if (session.initPromise) return session.initPromise;

  if (
    session.socket &&
    ["connected", "qr", "starting"].includes(session.status)
  ) {
    return session;
  }

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  session.manualDisconnect = false;
  session.status = "starting";
  session.lastError = null;
  session.pairingReady = false;
  session.pairingCode = null;
  session.qr = null;

  session.initPromise = (async () => {
    try {
      const auth = await createSupabaseAuthState(profileId);

      session.authState = auth;

      const socket = makeWASocket({
        auth: auth.state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "22.04.4"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        markOnlineOnConnect: false,
        syncFullHistory: false
      });

      session.socket = socket;

      socket.ev.on("creds.update", async () => {
        try {
          await auth.saveCreds();
        } catch (error) {
          session.lastError = error.message;

          console.error(
            `Erro ao salvar credenciais WhatsApp (${profileId}):`,
            error.message
          );
        }
      });

      socket.ev.on("connection.update", async update => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            session.qr = await QRCode.toDataURL(qr);
            session.pairingReady = true;
            session.status = "qr";

            resolvePairingWaiters(session);
          } catch (error) {
            session.lastError = error.message;
            console.error("Erro ao gerar QR:", error.message);
          }
        }

        if (connection === "connecting") {
          if (!session.pairingReady) {
            session.status = "starting";
          }
        }

        if (connection === "open") {
          auth.state.creds.registered = true;

          let credentialsSaved = false;

          try {
            await auth.saveCreds();
            credentialsSaved = true;

            console.log(
              `Sessão autenticada e salva no Supabase: ${profileId}`
            );
          } catch (error) {
            session.lastError = error.message;

            console.error(
              `Erro ao confirmar sessão no Supabase (${profileId}):`,
              error.message
            );
          }

          session.status = "connected";
          session.qr = null;
          session.pairingCode = null;
          session.pairingReady = false;
          session.reconnectAttempts = 0;

          if (credentialsSaved) {
            session.lastError = null;
          }

          resolvePairingWaiters(session);

          console.log(`WhatsApp conectado: ${profileId}`);
        }

        if (connection === "close") {
          session.socket = null;
          session.qr = null;
          session.pairingReady = false;

          rejectPairingWaiters(
            session,
            new Error(
              "A conexão do WhatsApp foi encerrada. Tente novamente."
            )
          );

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          session.status = "disconnected";

          if (lastDisconnect?.error) {
            session.lastError =
              lastDisconnect.error.message || "Conexão encerrada";

            console.error(
              `WhatsApp desconectado (${profileId}). Código:`,
              statusCode,
              "Erro:",
              session.lastError
            );
          }

          // IMPORTANTE: não apaga automaticamente as credenciais.
          if (loggedOut) {
            session.lastError =
              "WhatsApp retornou loggedOut. Dados preservados no Supabase. Verifique a sessão antes de parear novamente.";

            console.warn(
              `WhatsApp retornou loggedOut (${profileId}). Sessão e chaves preservadas.`
            );
          } else if (!session.manualDisconnect) {
            scheduleReconnect(profileId);
          }
        }
      });

      return session;
    } catch (error) {
      session.status = "error";
      session.lastError = error.message;
      session.socket = null;
      session.pairingReady = false;

      rejectPairingWaiters(session, error);

      throw error;
    } finally {
      session.initPromise = null;
    }
  })();

  return session.initPromise;
}

// =====================================================
// MOTOR DE AUTOMAÇÃO COM FILTRO DE NICHOS
// =====================================================

async function runAutomation(profileId) {
  if (automationRunning[profileId]) return;

  automationRunning[profileId] = true;

  try {
    const store = loadStore(profileId);
    const automation = store.automation;

    if (!automation.active) return;

    const window = getCurrentWindow(automation);

    if (!window) {
      automation.lastWindowKey = null;
      automation.nextSendAt = null;
      await saveStore(profileId, store);
      return;
    }

    if (automation.lastWindowKey !== window.key) {
      automation.lastWindowKey = window.key;
      automation.nextSendAt = new Date().toISOString();
      automation.lastError = null;
      await saveStore(profileId, store);
    }

    if (
      automation.nextSendAt &&
      Date.now() < new Date(automation.nextSendAt).getTime()
    ) return;

    const session = sessions[profileId];

    if (!session.socket || session.status !== "connected") {
      throw new Error("WhatsApp deste perfil não está conectado.");
    }

    if (!shopeeCredentials[profileId]) {
      throw new Error("Cadastre as credenciais Shopee deste perfil.");
    }

    const selectedDestinations = store.destinations.filter(destination =>
      automation.destinationIds.includes(destination.id) &&
      destination.active !== false
    );

    if (!selectedDestinations.length) {
      throw new Error("Selecione pelo menos um grupo ativo no painel.");
    }

    for (const destination of selectedDestinations) {
      if (!String(destination.groupId || "").endsWith("@g.us")) {
        throw new Error(
          `O destino "${destination.name}" não possui uma identificação de grupo válida.`
        );
      }
    }

    const product = await getAutomaticOffer(profileId, store);
    const productNiches = classifyProductNiches(product);

    if (!productNiches.length) {
      throw new Error(
        `Produto ignorado: não foi possível identificar com segurança o nicho de "${product.productName}". Nenhum grupo recebeu esta oferta.`
      );
    }

    const matchingDestinations = [];
    const skippedDestinations = [];

    for (const destination of selectedDestinations) {
      const result = destinationMatchesProduct(destination, product);

      if (result.matches) {
        matchingDestinations.push(destination);
      } else {
        skippedDestinations.push({
          name: destination.name,
          reason: result.reason
        });
      }
    }

    if (!matchingDestinations.length) {
      const productLabels = productNiches
        .map(item => item.label)
        .join(", ");

      const skippedText = skippedDestinations
        .map(item => `${item.name}: ${item.reason}`)
        .join(" | ");

      throw new Error(
        `Nenhum grupo compatível com o produto "${product.productName}". Nicho identificado: ${productLabels}. ${skippedText}`
      );
    }

    const message = createOfferMessage(product);

    let sentCount = 0;
    let imageSentCount = 0;

    const errors = [];

    for (const destination of matchingDestinations) {
      try {
        const result = await sendProductOffer(
          session.socket,
          destination.groupId,
          product,
          message
        );

        sentCount++;

        if (result.withImage) {
          imageSentCount++;
        }

        if (result.imageError) {
          console.warn(
            `Oferta enviada sem foto para ${destination.name}:`,
            result.imageError
          );
        }

        await wait(1500);
      } catch (error) {
        errors.push(`${destination.name}: ${error.message}`);
      }
    }

    if (sentCount > 0) {
      const productId = String(product.itemId);

      if (!automation.sentProductIds.includes(productId)) {
        automation.sentProductIds.push(productId);
      }

      automation.sentProductIds =
        automation.sentProductIds.slice(-5000);

      automation.lastSentAt = new Date().toISOString();

      const skippedSummary = skippedDestinations.length
        ? ` Grupos ignorados por nicho diferente ou não identificado: ${skippedDestinations.map(item => item.name).join(", ")}.`
        : "";

      automation.lastError = errors.length
        ? `Enviado parcialmente. ${errors.join(" | ")}${skippedSummary}`
        : skippedSummary || null;

      const intervalSeconds = Math.max(
        10,
        Math.min(
          86400,
          Number(automation.intervalSeconds) || 1800
        )
      );

      automation.intervalSeconds = intervalSeconds;
      automation.intervalMinutes = intervalSeconds / 60;

      automation.nextSendAt = new Date(
        Date.now() + intervalSeconds * 1000
      ).toISOString();

      console.log(
        `Oferta ${productId} (${productNiches.map(item => item.label).join(", ")}) enviada pelo perfil ${profileId} para ${sentCount} grupo(s). Com foto: ${imageSentCount}.`
      );

      if (skippedDestinations.length) {
        console.log(
          `Grupos ignorados: ${skippedDestinations.map(item => item.name).join(", ")}`
        );
      }
    } else {
      throw new Error(
        errors.join(" | ") ||
        "Não foi possível enviar para os grupos compatíveis."
      );
    }

    await saveStore(profileId, store);
  } catch (error) {
    console.error(`Automação ${profileId}:`, error.message);

    const store = loadStore(profileId);

    store.automation.lastError = error.message;

    store.automation.nextSendAt = new Date(
      Date.now() + 5 * 60 * 1000
    ).toISOString();

    await saveStore(profileId, store);
  } finally {
    automationRunning[profileId] = false;
  }
}

// =====================================================
// ROTAS PÚBLICAS
// =====================================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "medeiros-shopee-affiliate-robot",
    storage: "supabase",
    whatsapp: {
      rafael: sessions.rafael.status,
      usuario2: sessions.usuario2.status
    }
  });
});

// =====================================================
// PERFIS E STATUS
// =====================================================

app.get("/api/profiles", adminOnly, (req, res) => {
  res.json({
    profiles: Object.values(PROFILES).map(profile => ({
      id: profile.id,
      name: profile.name
    }))
  });
});

app.get("/api/status", adminOnly, (req, res) => {
  const profileId = getProfile(req);
  const store = loadStore(profileId);

  res.json({
    ok: true,
    profile: profileId,
    whatsapp: sessions[profileId].status,
    shopee: shopeeCredentials[profileId] ? "configured" : "disabled",
    products: store.products.length,
    destinations: store.destinations.length,
    queue: store.queue.length,
    automation: store.automation.active ? "active" : "paused"
  });
});

app.get("/api/data", adminOnly, (req, res) => {
  res.json(loadStore(getProfile(req)));
});

// =====================================================
// AUTOMAÇÃO
// =====================================================

app.get("/api/automation", adminOnly, (req, res) => {
  const store = loadStore(getProfile(req));

  res.json({
    ok: true,
    automation: store.automation
  });
});

app.post("/api/automation", adminOnly, async (req, res) => {
  const profileId = getProfile(req);
  const store = loadStore(profileId);
  const body = req.body || {};

  const legacyStart = Array.isArray(body.scheduleTimes)
    ? body.scheduleTimes[0]
    : undefined;

  const startTime = body.startTime !== undefined
    ? String(body.startTime)
    : legacyStart !== undefined
      ? String(legacyStart)
      : store.automation.startTime || "08:00";

  const endTime = body.endTime !== undefined
    ? String(body.endTime)
    : store.automation.endTime || "18:00";

  if (!isValidTime(startTime)) {
    return res.status(400).json({
      error: "Informe um horário de início válido."
    });
  }

  if (!isValidTime(endTime)) {
    return res.status(400).json({
      error: "Informe um horário de encerramento válido."
    });
  }

  if (startTime === endTime) {
    return res.status(400).json({
      error: "O horário de início e o de encerramento não podem ser iguais."
    });
  }

  let intervalSeconds;

  if (body.intervalSeconds !== undefined) {
    intervalSeconds = Number(body.intervalSeconds);
  } else if (body.intervalMinutes !== undefined) {
    intervalSeconds = Number(body.intervalMinutes) * 60;
  } else {
    intervalSeconds =
      Number(store.automation.intervalSeconds) || 1800;
  }

  if (
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < 10 ||
    intervalSeconds > 86400
  ) {
    return res.status(400).json({
      error: "O intervalo deve ser de 10 segundos até 24 horas."
    });
  }

  const destinationIds = Array.isArray(body.destinationIds)
    ? [...new Set(body.destinationIds.map(String))]
    : store.automation.destinationIds;

  const knownIds = new Set(
    store.destinations.map(item => item.id)
  );

  if (destinationIds.some(id => !knownIds.has(id))) {
    return res.status(400).json({
      error: "Um ou mais destinos selecionados não existem neste perfil."
    });
  }

  store.automation.startTime = startTime;
  store.automation.endTime = endTime;
  store.automation.scheduleTimes = [startTime];
  store.automation.intervalSeconds = intervalSeconds;
  store.automation.intervalMinutes = intervalSeconds / 60;
  store.automation.destinationIds = destinationIds;

  if (typeof body.active === "boolean") {
    if (body.active) {
      if (!destinationIds.length) {
        return res.status(400).json({
          error: "Selecione pelo menos um grupo autorizado."
        });
      }

      if (!shopeeCredentials[profileId]) {
        return res.status(400).json({
          error: "Cadastre as credenciais Shopee deste perfil."
        });
      }

      if (
        !sessions[profileId].socket ||
        sessions[profileId].status !== "connected"
      ) {
        return res.status(400).json({
          error: "Conecte o WhatsApp deste perfil antes de ativar."
        });
      }
    }

    store.automation.active = body.active;

    if (body.active) {
      store.automation.lastWindowKey = null;
      store.automation.nextSendAt = null;
      store.automation.lastError = null;
    } else {
      store.automation.nextSendAt = null;
    }
  } else if (store.automation.active) {
    store.automation.lastWindowKey = null;
    store.automation.nextSendAt = null;
  }

  try {
    await saveStore(profileId, store);

    res.json({
      ok: true,
      automation: store.automation,
      message: store.automation.active
        ? "Automação ativada para este perfil."
        : "Configurações salvas."
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Não foi possível salvar no Supabase: " + error.message
    });
  }
});

// =====================================================
// WHATSAPP
// =====================================================

app.get("/api/whatsapp", adminOnly, (req, res) => {
  const session = sessions[getProfile(req)];

  res.json({
    ok: true,
    status: session.status,
    qr: session.qr,
    pairingCode: session.pairingCode,
    error: session.lastError
  });
});

app.post("/api/whatsapp/connect", adminOnly, async (req, res) => {
  const profileId = getProfile(req);

  try {
    await initializeWhatsApp(profileId);

    res.json({
      ok: true,
      status: sessions[profileId].status,
      qr: sessions[profileId].qr
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// PAREAMENTO POR NÚMERO

app.post("/api/whatsapp/pairing", adminOnly, async (req, res) => {
  const profileId = getProfile(req);
  const session = sessions[profileId];

  const phone = String(req.body.phone || "").replace(/\D/g, "");

  if (phone.length < 10 || phone.length > 15) {
    return res.status(400).json({
      ok: false,
      error: "Informe o telefone com DDI e DDD, somente números."
    });
  }

  if (session.status === "connected") {
    return res.status(400).json({
      ok: false,
      error: "Este WhatsApp já está conectado."
    });
  }

  if (session.pairingPromise) {
    return res.status(409).json({
      ok: false,
      error: "Já existe uma solicitação de código em andamento. Aguarde."
    });
  }

  session.pairingPromise = (async () => {
    try {
      await initializeWhatsApp(profileId);

      if (!session.socket || !session.authState) {
        throw new Error(
          "Não foi possível iniciar o WhatsApp. Tente novamente."
        );
      }

      if (session.authState.state.creds.registered) {
        throw new Error(
          "Este perfil já possui uma sessão registrada. Não solicite outro código antes de verificar a conexão existente."
        );
      }

      await waitForPairingReady(session, 30000);

      if (!session.socket || session.status === "disconnected") {
        throw new Error(
          "A conexão foi encerrada antes da solicitação do código."
        );
      }

      if (session.status === "connected") {
        throw new Error("Este WhatsApp já está conectado.");
      }

      await wait(2000);

      const code = await session.socket.requestPairingCode(phone);

      session.pairingCode = code;

      console.log(
        `Código de pareamento solicitado para ${profileId}.`
      );

      return code;
    } finally {
      session.pairingPromise = null;
    }
  })();

  try {
    const code = await session.pairingPromise;

    res.json({
      ok: true,
      pairingCode: code,
      message: "Código gerado. Digite-o no WhatsApp do celular."
    });
  } catch (error) {
    session.lastError = error.message;

    console.error(
      `Erro no pareamento numérico (${profileId}):`,
      error.message
    );

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/whatsapp/disconnect", adminOnly, async (req, res) => {
  const profileId = getProfile(req);
  const session = sessions[profileId];

  session.manualDisconnect = true;

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  rejectPairingWaiters(
    session,
    new Error(
      "Pareamento cancelado porque o WhatsApp foi desconectado."
    )
  );

  try {
    if (session.socket) {
      await session.socket.logout();
      session.socket.end(undefined);
    }
  } catch (error) {
    console.error("Erro ao desconectar:", error.message);
  }

  try {
    await clearWhatsAppAuth(profileId);
  } catch (error) {
    console.error("Erro ao limpar autenticação:", error.message);

    return res.status(500).json({
      ok: false,
      error: "WhatsApp desconectado, mas não foi possível limpar a sessão no Supabase."
    });
  }

  session.socket = null;
  session.authState = null;
  session.qr = null;
  session.pairingCode = null;
  session.pairingReady = false;
  session.pairingPromise = null;
  session.status = "disconnected";
  session.reconnectAttempts = 0;

  res.json({
    ok: true,
    status: "disconnected"
  });
});

app.post("/api/whatsapp/send", adminOnly, async (req, res) => {
  const profileId = getProfile(req);
  const session = sessions[profileId];

  const destination = String(req.body.destination || "").trim();
  const message = String(req.body.message || "").trim();

  if (!destination || !message) {
    return res.status(400).json({
      error: "Informe o destino e a mensagem."
    });
  }

  if (!session.socket || session.status !== "connected") {
    return res.status(400).json({
      error: "WhatsApp não está conectado."
    });
  }

  try {
    const jid = /^\d+$/.test(destination)
      ? `${destination}@s.whatsapp.net`
      : destination;

    await session.socket.sendMessage(jid, { text: message });

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/whatsapp/groups", adminOnly, async (req, res) => {
  const profileId = getProfile(req);
  const session = sessions[profileId];

  if (!session.socket || session.status !== "connected") {
    return res.status(400).json({
      error: "Conecte o WhatsApp deste perfil primeiro."
    });
  }

  try {
    const groups = await session.socket.groupFetchAllParticipating();

    res.json({
      ok: true,
      groups: Object.entries(groups).map(([id, group]) => {
        const name = group.subject || "Grupo sem nome";
        const niche = classifyGroupNiche(name);

        return {
          id,
          name,
          niche: niche.id,
          nicheLabel: niche.label,
          confidence: niche.confidence,
          identified: niche.id !== "unknown"
        };
      })
    });
  } catch (error) {
    res.status(500).json({
      error: "Não foi possível carregar os grupos: " + error.message
    });
  }
});

// =====================================================
// CLASSIFICAÇÃO - TESTE DE NICHOS
// =====================================================

app.post("/api/niches/classify", adminOnly, (req, res) => {
  const text = String(req.body.text || "").trim();
  const product = req.body.product || null;

  if (product) {
    const niches = classifyProductNiches(product);

    return res.json({
      ok: true,
      type: "product",
      product: product.productName || product.name || product.title || "",
      niches,
      labels: niches.map(item => item.label)
    });
  }

  if (!text) {
    return res.status(400).json({
      ok: false,
      error: "Informe o texto do grupo ou produto."
    });
  }

  const niche = classifyGroupNiche(text);

  res.json({
    ok: true,
    type: "group",
    text,
    niche,
    identified: niche.id !== "unknown"
  });
});

app.get("/api/niches", adminOnly, (req, res) => {
  res.json({
    ok: true,
    niches: NICHE_DEFINITIONS.map(item => ({
      id: item.id,
      label: item.label
    }))
  });
});

// =====================================================
// PRODUTOS, DESTINOS E FILA
// =====================================================

app.get("/api/destinations", adminOnly, (req, res) => {
  const store = loadStore(getProfile(req));

  res.json({
    ok: true,
    destinations: store.destinations.map(destination => {
      const niche = classifyGroupNiche(destination.name);

      return {
        ...destination,
        detectedNiche: niche.id,
        nicheLabel: niche.label,
        nicheIdentified: niche.id !== "unknown"
      };
    })
  });
});

app.post("/api/products", adminOnly, async (req, res) => {
  const profileId = getProfile(req);
  const store = loadStore(profileId);

  const product = {
    id: crypto.randomUUID(),
    name: String(req.body.name || req.body.title || "").trim(),
    price: req.body.price || "",
    link: String(req.body.link || "").trim(),
    image: req.body.image || "",
    description: req.body.description || "",
    createdAt: new Date().toISOString()
  };

  if (!product.name) {
    return res.status(400).json({
      error: "Informe o nome do produto."
    });
  }

  store.products.unshift(product);

  try {
    await saveStore(profileId, store);

    res.json({
      ok: true,
      product
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Erro ao salvar produto no Supabase: " + error.message
    });
  }
});

app.post("/api/destinations", adminOnly, async (req, res) => {
  const profileId = getProfile(req);
  const store = loadStore(profileId);

  const destination = {
    id: crypto.randomUUID(),
    name: String(req.body.name || "").trim(),
    phone: String(req.body.phone || "").trim(),
    groupId: String(req.body.groupId || "").trim(),
    active: req.body.active !== false,
    createdAt: new Date().toISOString()
  };

  if (!destination.name || !destination.groupId) {
    return res.status(400).json({
      error: "Informe o nome e a identificação do destino."
    });
  }

  store.destinations.push(destination);

  try {
    await saveStore(profileId, store);

    res.json({
      ok: true,
      destination: {
        ...destination,
        ...{
          detectedNiche: classifyGroupNiche(destination.name).id,
          nicheLabel: classifyGroupNiche(destination.name).label
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Erro ao salvar destino no Supabase: " + error.message
    });
  }
});

app.post("/api/queue", adminOnly, async (req, res) => {
  const profileId = getProfile(req);
  const store = loadStore(profileId);

  const item = {
    id: crypto.randomUUID(),
    productId: req.body.productId || null,
    message: String(req.body.message || "").trim(),
    destination: String(req.body.destination || "").trim(),
    scheduledAt: req.body.scheduledAt || null,
    status: "pending",
    createdAt: new Date().toISOString()
  };

  if (!item.message || !item.destination) {
    return res.status(400).json({
      error: "Informe a mensagem e o destino."
    });
  }

  store.queue.push(item);

  try {
    await saveStore(profileId, store);

    res.json({
      ok: true,
      item
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Erro ao salvar fila: " + error.message
    });
  }
});

// =====================================================
// SHOPEE - CREDENCIAIS
// =====================================================

app.get("/api/shopee/credentials", adminOnly, (req, res) => {
  const profileId = getProfile(req);

  res.json({
    ok: true,
    configured: Boolean(shopeeCredentials[profileId]),
    appId: shopeeCredentials[profileId]?.appId || ""
  });
});

app.post("/api/shopee/credentials", adminOnly, async (req, res) => {
  const profileId = getProfile(req);

  const appId = String(req.body.appId || "").trim();
  const secret = String(req.body.secret || "").trim();

  if (!/^\d+$/.test(appId)) {
    return res.status(400).json({
      error: "O App ID deve conter somente números."
    });
  }

  if (secret.length < 8 || secret.length > 500) {
    return res.status(400).json({
      error: "A Secret informada parece inválida."
    });
  }

  try {
    const saved = {
      appId,
      encryptedSecret: encryptSecret(secret)
    };

    await persistShopeeCredentials(profileId, saved);
    shopeeCredentials[profileId] = saved;

    res.json({
      ok: true,
      configured: true,
      message: "Credenciais salvas com segurança para este perfil."
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// =====================================================
// SHOPEE - TESTAR CONEXÃO
// =====================================================

app.post("/api/shopee/test", adminOnly, async (req, res) => {
  const profileId = getProfile(req);

  const query = `
    query {
      productOfferV2(keyword: "", sortType: 5, page: 1, limit: 1) {
        nodes {
          itemId
          productName
          offerLink
          commissionRate
        }
        pageInfo {
          page
          limit
          hasNextPage
        }
      }
    }
  `;

  try {
    const data = await shopeeRequest(profileId, query);
    const products = data?.productOfferV2?.nodes || [];

    res.json({
      ok: true,
      connected: true,
      productsFound: products.length,
      message: "A API respondeu corretamente."
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      connected: false,
      error: error.message
    });
  }
});

// =====================================================
// SHOPEE - PESQUISAR OFERTAS
// =====================================================

app.get("/api/shopee/products", adminOnly, async (req, res) => {
  const profileId = getProfile(req);
  const keyword = String(req.query.keyword || "").trim();

  const limit = Math.min(
    Math.max(parseInt(req.query.limit || "30", 10) || 30, 1),
    30
  );

  if (activeSearches[profileId]) {
    return res.status(429).json({
      ok: false,
      error: "Já existe uma pesquisa em andamento. Aguarde terminar."
    });
  }

  activeSearches[profileId] = true;

  const sortModes = [
    { type: 1, name: "Relevância" },
    { type: 2, name: "Mais vendidos" },
    { type: 3, name: "Maior preço" },
    { type: 4, name: "Menor preço" },
    { type: 5, name: "Maior comissão" }
  ];

  const maxPages = 3;

  const query = `
    query SearchOffers(
      $keyword: String,
      $sortType: Int,
      $page: Int,
      $limit: Int
    ) {
      productOfferV2(
        keyword: $keyword,
        sortType: $sortType,
        page: $page,
        limit: $limit
      ) {
        nodes {
          itemId
          productName
          productLink
          offerLink
          imageUrl
          priceMin
          priceMax
          priceDiscountRate
          sales
          ratingStar
          commissionRate
          sellerCommissionRate
          shopeeCommissionRate
          commission
          shopName
        }
        pageInfo {
          page
          limit
          hasNextPage
        }
      }
    }
  `;

  const productsMap = new Map();
  const errors = [];

  let pagesRead = 0;
  let successfulSearches = 0;

  try {
    for (const mode of sortModes) {
      for (let page = 1; page <= maxPages; page++) {
        try {
          const data = await shopeeRequest(profileId, query, {
            keyword,
            sortType: mode.type,
            page,
            limit
          });

          const result = data?.productOfferV2;

          if (!result) {
            throw new Error(
              "A Shopee não retornou a lista de ofertas."
            );
          }

          successfulSearches++;
          pagesRead++;

          const products = Array.isArray(result.nodes)
            ? result.nodes
            : [];

          for (const product of products) {
            const id = String(product.itemId || "").trim();
            const link = String(
              product.offerLink || product.productLink || ""
            ).trim();
            const name = String(product.productName || "").trim();

            const uniqueKey = id
              ? `id:${id}`
              : link
                ? `link:${link}`
                : name.toLowerCase();

            if (!uniqueKey || uniqueKey === "id:") continue;

            if (!productsMap.has(uniqueKey)) {
              const niches = classifyProductNiches(product);

              productsMap.set(uniqueKey, {
                ...product,
                detectedNiches: niches.map(item => item.id),
                nicheLabels: niches.map(item => item.label),
                searchSort: mode.name
              });
            }
          }

          if (!result.pageInfo?.hasNextPage) break;

          await wait(500);
        } catch (error) {
          errors.push({
            sort: mode.name,
            page,
            error: error.message
          });

          break;
        }
      }

      await wait(700);
    }

    const products = Array.from(productsMap.values());

    if (successfulSearches === 0) {
      return res.status(502).json({
        ok: false,
        error: errors[0]?.error ||
          "Não foi possível pesquisar ofertas na Shopee.",
        details: errors
      });
    }

    res.json({
      ok: true,
      keyword: keyword || "Todas as ofertas",
      products,
      total: products.length,
      pagesRead,
      successfulSearches,
      duplicateFilter: true,
      partial: errors.length > 0,
      warnings: errors,
      message: products.length
        ? `${products.length} ofertas encontradas sem produtos repetidos.`
        : "A pesquisa terminou, mas não encontrou produtos."
    });
  } catch (error) {
    console.error("Erro geral na pesquisa Shopee:", error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    activeSearches[profileId] = false;
  }
});

// =====================================================
// ERROS E INICIALIZAÇÃO
// =====================================================

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Rota não encontrada."
  });
});

app.use((error, req, res, next) => {
  console.error("Erro no servidor:", error);

  res.status(500).json({
    ok: false,
    error: "Erro interno do servidor."
  });
});

async function initializeApp() {
  console.log("Carregando dados do Supabase...");

  await loadStoresFromSupabase();

  console.log("Dados do painel carregados.");

  for (const profileId of Object.keys(PROFILES)) {
    try {
      const auth = await createSupabaseAuthState(profileId);

      const hasRegisteredSession =
        auth.state.creds.registered === true;

      const hasSavedKeys =
        auth.storedKeysCount > 0;

      if (hasRegisteredSession || hasSavedKeys) {
        console.log(
          `Sessão ou chaves encontradas para ${profileId}. Tentando recuperar WhatsApp...`
        );

        initializeWhatsApp(profileId).catch(error => {
          console.error(
            `Erro ao restaurar WhatsApp (${profileId}):`,
            error.message
          );
        });
      } else {
        console.log(
          `Nenhuma sessão ou chave encontrada para ${profileId}.`
        );
      }
    } catch (error) {
      console.error(
        `Erro ao verificar sessão WhatsApp (${profileId}):`,
        error.message
      );
    }
  }

  setInterval(() => {
    runAutomation("rafael").catch(console.error);
    runAutomation("usuario2").catch(console.error);
  }, 1000);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `MEDEIROS DIGITAL iniciado na porta ${PORT}`
    );

    console.log("Persistência de dados: Supabase");
    console.log("Identificação automática de nichos: ativada");
  });
}

initializeApp().catch(error => {
  console.error(
    "Não foi possível iniciar o sistema:",
    error
  );

  process.exit(1);
});
