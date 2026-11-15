
const express = require("express");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;
const TIME_ZONE = "America/Sao_Paulo";

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));

const DATA_DIR = path.join(__dirname, "data");

const PROFILES = {
  rafael: {
    id: "rafael",
    name: "Rafael",
    authDir: path.join(__dirname, ".baileys_auth"),
    dataFile: path.join(DATA_DIR, "store.json")
  },
  usuario2: {
    id: "usuario2",
    name: "Usuário 2",
    authDir: path.join(__dirname, ".baileys_auth_usuario2"),
    dataFile: path.join(DATA_DIR, "usuario2", "store.json")
  }
};

function createSession() {
  return {
    socket: null,
    status: "disconnected",
    qr: null,
    pairingCode: null,
    initPromise: null,
    manualDisconnect: false,
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

// -------------------------
// DADOS E CONFIGURAÇÕES
// -------------------------

function defaultAutomation() {
  return {
    active: false,
    scheduleTimes: ["08:00"],
    intervalMinutes: 30,
    destinationIds: [],
    sentProductIds: [],
    lastWindowKey: null,
    nextSendAt: null,
    lastSentAt: null,
    lastError: null
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

function getProfile(req) {
  const requested =
    req.query.profile ||
    req.body?.profile ||
    req.headers["x-profile"] ||
    "rafael";

  return PROFILES[requested] ? requested : "rafael";
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

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadStore(profileId) {
  const file = PROFILES[profileId].dataFile;

  try {
    ensureDirectory(file);

    if (!fs.existsSync(file)) {
      const initial = defaultStore();
      fs.writeFileSync(file, JSON.stringify(initial, null, 2));
      return initial;
    }

    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const automation = {
      ...defaultAutomation(),
      ...(data.automation || {})
    };

    return {
      products: Array.isArray(data.products) ? data.products : [],
      destinations: Array.isArray(data.destinations) ? data.destinations : [],
      queue: Array.isArray(data.queue) ? data.queue : [],
      automation: {
        ...automation,
        scheduleTimes: Array.isArray(automation.scheduleTimes)
          ? automation.scheduleTimes
          : ["08:00"],
        destinationIds: Array.isArray(automation.destinationIds)
          ? automation.destinationIds
          : [],
        sentProductIds: Array.isArray(automation.sentProductIds)
          ? automation.sentProductIds
          : []
      }
    };
  } catch (error) {
    console.error("Erro ao carregar dados:", error);
    return defaultStore();
  }
}

function saveStore(profileId, data) {
  const file = PROFILES[profileId].dataFile;
  ensureDirectory(file);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// -------------------------
// HORÁRIO DE SÃO PAULO
// -------------------------

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

function getCurrentWindow(automation, now = new Date()) {
  const currentTime = getSaoPauloTime(now);
  const dateParts = getSaoPauloDateParts(now);
  const dateKey = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;

  if (currentTime < "08:00" || currentTime >= "18:00") {
    return null;
  }

  const times = [...automation.scheduleTimes].sort();

  let currentStart = null;
  let nextStart = null;

  for (const time of times) {
    if (time <= currentTime) {
      currentStart = time;
    } else if (!nextStart) {
      nextStart = time;
    }
  }

  if (!currentStart) return null;

  const endTime = nextStart || "18:00";

  if (currentTime >= endTime) return null;

  return {
    start: currentStart,
    end: endTime,
    key: `${dateKey}-${currentStart}`
  };
}

// -------------------------
// CRIPTOGRAFIA SHOPEE
// -------------------------

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
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
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
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
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
    throw new Error(
      "Cadastre as credenciais Shopee deste perfil primeiro."
    );
  }

  return {
    appId: saved.appId,
    secret: decryptSecret(saved.encryptedSecret)
  };
}

// -------------------------
// REQUISIÇÕES SHOPEE
// -------------------------

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
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }

      if (!response.ok) {
        const error = new Error(
          result.message || result.error || `Erro HTTP ${response.status} na Shopee.`
        );
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }

      if (result.errors?.length) {
        const message = result.errors
          .map(item => item.message || "Erro desconhecido")
          .join("; ");

        const error = new Error(message);
        error.retryable = /10000|system\s*error|temporar|internal server/i.test(message);
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

// -------------------------
// BUSCAR PRODUTOS PARA ENVIO
// -------------------------

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

  if (!Number.isFinite(number)) return null;

  return number.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });
}

function createOfferMessage(product) {
  const link = product.offerLink || product.productLink;

  if (!link) {
    throw new Error("O produto não possui link de afiliado.");
  }

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

  const price = formatMoney(product.priceMin);
  const commission = product.commissionRate;

  const lines = [
    "🔥 OFERTA ENCONTRADA!",
    "",
    `🛍️ ${product.productName || "Confira esta oferta"}`
  ];

  if (price) lines.push(`💰 Preço: ${price}`);
  if (commission !== undefined && commission !== null) {
    lines.push(`⭐ Comissão informada: ${commission}`);
  }

  lines.push(
    "",
    "👉 Confira aqui:",
    safeLink
  );

  return lines.join("\n");
}

// -------------------------
// WHATSAPP - BAILEYS
// -------------------------

async function initializeWhatsApp(profileId) {
  const session = sessions[profileId];

  if (session.initPromise) return session.initPromise;

  if (session.socket && session.status === "connected") {
    return session;
  }

  session.manualDisconnect = false;
  session.status = "starting";
  session.lastError = null;

  session.initPromise = (async () => {
    try {
      ensureDirectory(path.join(PROFILES[profileId].authDir, "placeholder"));

      const { state, saveCreds } = await useMultiFileAuthState(
        PROFILES[profileId].authDir
      );

      const socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ["MEDEIROS DIGITAL", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        markOnlineOnConnect: false,
        syncFullHistory: false
      });

      session.socket = socket;
      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("connection.update", async update => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          session.qr = await QRCode.toDataURL(qr);
          session.status = "qr";
        }

        if (connection === "connecting") {
          session.status = "starting";
        }

        if (connection === "open") {
          session.status = "connected";
          session.qr = null;
          session.pairingCode = null;
          session.lastError = null;
          console.log(`WhatsApp conectado: ${profileId}`);
        }

        if (connection === "close") {
          session.socket = null;
          session.qr = null;

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect =
            !session.manualDisconnect &&
            statusCode !== DisconnectReason.loggedOut;

          session.status = "disconnected";

          if (lastDisconnect?.error) {
            session.lastError =
              lastDisconnect.error.message || "Conexão encerrada";
          }

          if (shouldReconnect) {
            setTimeout(() => {
              initializeWhatsApp(profileId).catch(error => {
                console.error("Falha ao reconectar WhatsApp:", error);
              });
            }, 5000);
          }
        }
      });

      return session;
    } catch (error) {
      session.status = "error";
      session.lastError = error.message;
      session.socket = null;
      throw error;
    } finally {
      session.initPromise = null;
    }
  })();

  return session.initPromise;
}

// -------------------------
// MOTOR DE AUTOMAÇÃO
// -------------------------

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
      saveStore(profileId, store);
      return;
    }

    if (automation.lastWindowKey !== window.key) {
      automation.lastWindowKey = window.key;
      automation.nextSendAt = new Date().toISOString();
      automation.lastError = null;
      saveStore(profileId, store);
    }

    if (
      automation.nextSendAt &&
      Date.now() < new Date(automation.nextSendAt).getTime()
    ) {
      return;
    }

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
    const message = createOfferMessage(product);

    let sentCount = 0;
    const errors = [];

    for (const destination of selectedDestinations) {
      try {
        await session.socket.sendMessage(destination.groupId, {
          text: message
        });

        sentCount++;
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

      // Mantém o histórico de IDs em tamanho controlado.
      automation.sentProductIds =
        automation.sentProductIds.slice(-5000);

      automation.lastSentAt = new Date().toISOString();
      automation.lastError = errors.length
        ? `Enviado parcialmente. ${errors.join(" | ")}`
        : null;

      const interval = Math.max(
        1,
        Number(automation.intervalMinutes) || 30
      );

      automation.nextSendAt = new Date(
        Date.now() + interval * 60 * 1000
      ).toISOString();

      console.log(
        `Oferta ${productId} enviada pelo perfil ${profileId} para ${sentCount} destino(s).`
      );
    } else {
      throw new Error(
        errors.join(" | ") || "Não foi possível enviar para os grupos."
      );
    }

    saveStore(profileId, store);
  } catch (error) {
    console.error(`Automação ${profileId}:`, error.message);

    const store = loadStore(profileId);
    store.automation.lastError = error.message;

    // Tenta novamente após 5 minutos em caso de falha.
    store.automation.nextSendAt = new Date(
      Date.now() + 5 * 60 * 1000
    ).toISOString();

    saveStore(profileId, store);
  } finally {
    automationRunning[profileId] = false;
  }
}

setInterval(() => {
  runAutomation("rafael").catch(console.error);
  runAutomation("usuario2").catch(console.error);
}, 15000);

// -------------------------
// ROTAS PÚBLICAS
// -------------------------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "medeiros-shopee-affiliate-robot",
    whatsapp: {
      rafael: sessions.rafael.status,
      usuario2: sessions.usuario2.status
    }
  });
});

// -------------------------
// PERFIS E STATUS
// -------------------------

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

// -------------------------
// AUTOMAÇÃO - CONFIGURAÇÃO
// -------------------------

app.get("/api/automation", adminOnly, (req, res) => {
  const profileId = getProfile(req);
  const store = loadStore(profileId);

  res.json({
    ok: true,
    automation: store.automation
  });
});

app.post("/api/automation", adminOnly, (req, res) => {
  const profileId = getProfile(req);
  const store = loadStore(profileId);
  const body = req.body || {};

  const times = Array.isArray(body.scheduleTimes)
    ? [...new Set(body.scheduleTimes.map(String))]
    : store.automation.scheduleTimes;

  for (const time of times) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return res.status(400).json({
        error: `Horário inválido: ${time}`
      });
    }

    if (time < "08:00" || time >= "18:00") {
      return res.status(400).json({
        error: "Os horários de início devem estar entre 08:00 e 17:59."
      });
    }
  }

  const intervalMinutes = Number(
    body.intervalMinutes ?? store.automation.intervalMinutes
  );

  if (
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > 1440
  ) {
    return res.status(400).json({
      error: "O intervalo deve ser de 1 a 1440 minutos."
    });
  }

  const destinationIds = Array.isArray(body.destinationIds)
    ? [...new Set(body.destinationIds.map(String))]
    : store.automation.destinationIds;

  const knownIds = new Set(
    store.destinations.map(destination => destination.id)
  );

  if (destinationIds.some(id => !knownIds.has(id))) {
    return res.status(400).json({
      error: "Um ou mais destinos selecionados não existem neste perfil."
    });
  }

  store.automation.scheduleTimes = times.sort();
  store.automation.intervalMinutes = intervalMinutes;
  store.automation.destinationIds = destinationIds;

  if (typeof body.active === "boolean") {
    if (body.active) {
      if (!times.length) {
        return res.status(400).json({
          error: "Cadastre pelo menos um horário de início."
        });
      }

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
  }

  saveStore(profileId, store);

  res.json({
    ok: true,
    automation: store.automation,
    message: store.automation.active
      ? "Automação ativada para este perfil."
      : "Configurações salvas."
  });
});

// -------------------------
// WHATSAPP
// -------------------------

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

app.post("/api/whatsapp/pairing", adminOnly, async (req, res) => {
  const profileId = getProfile(req);
  const phone = String(req.body.phone || "").replace(/\D/g, "");

  if (phone.length < 10 || phone.length > 15) {
    return res.status(400).json({
      error: "Informe o telefone com DDI e DDD."
    });
  }

  try {
    await initializeWhatsApp(profileId);
    const session = sessions[profileId];

    if (!session.socket) {
      throw new Error("WhatsApp ainda está iniciando. Tente novamente.");
    }

    const code = await session.socket.requestPairingCode(phone);
    session.pairingCode = code;

    res.json({ ok: true, pairingCode: code });
  } catch (error) {
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

  try {
    if (session.socket) {
      await session.socket.logout();
      session.socket.end(undefined);
    }
  } catch (error) {
    console.error("Erro ao desconectar:", error.message);
  }

  session.socket = null;
  session.qr = null;
  session.pairingCode = null;
  session.status = "disconnected";

  res.json({ ok: true, status: "disconnected" });
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

// Lista grupos aos quais o WhatsApp conectado já pertence.
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

    const result = Object.entries(groups).map(([id, group]) => ({
      id,
      name: group.subject || "Grupo sem nome"
    }));

    res.json({
      ok: true,
      groups: result
    });
  } catch (error) {
    res.status(500).json({
      error: "Não foi possível carregar os grupos: " + error.message
    });
  }
});

// -------------------------
// PRODUTOS, DESTINOS E FILA
// -------------------------

app.get("/api/destinations", adminOnly, (req, res) => {
  const store = loadStore(getProfile(req));
  res.json({
    ok: true,
    destinations: store.destinations
  });
});

app.post("/api/products", adminOnly, (req, res) => {
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
    return res.status(400).json({ error: "Informe o nome do produto." });
  }

  store.products.unshift(product);
  saveStore(profileId, store);

  res.json({ ok: true, product });
});

app.post("/api/destinations", adminOnly, (req, res) => {
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
  saveStore(profileId, store);

  res.json({ ok: true, destination });
});

app.post("/api/queue", adminOnly, (req, res) => {
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
  saveStore(profileId, store);

  res.json({ ok: true, item });
});

// -------------------------
// SHOPEE - CREDENCIAIS
// -------------------------

app.get("/api/shopee/credentials", adminOnly, (req, res) => {
  const profileId = getProfile(req);

  res.json({
    ok: true,
    configured: Boolean(shopeeCredentials[profileId]),
    appId: shopeeCredentials[profileId]?.appId || ""
  });
});

app.post("/api/shopee/credentials", adminOnly, (req, res) => {
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
    shopeeCredentials[profileId] = {
      appId,
      encryptedSecret: encryptSecret(secret)
    };

    res.json({
      ok: true,
      configured: true,
      message: "Credenciais salvas para este perfil."
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// -------------------------
// SHOPEE - TESTAR CONEXÃO
// -------------------------

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

// -------------------------
// SHOPEE - PESQUISAR OFERTAS
// -------------------------

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
            throw new Error("A Shopee não retornou a lista de ofertas.");
          }

          successfulSearches++;
          pagesRead++;

          const products = Array.isArray(result.nodes) ? result.nodes : [];

          for (const product of products) {
            const id = String(product.itemId || "").trim();
            const link = String(product.offerLink || product.productLink || "").trim();
            const name = String(product.productName || "").trim();

            const uniqueKey = id
              ? `id:${id}`
              : link
                ? `link:${link}`
                : name.toLowerCase();

            if (!uniqueKey || uniqueKey === "id:") continue;

            if (!productsMap.has(uniqueKey)) {
              productsMap.set(uniqueKey, {
                ...product,
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
        error: errors[0]?.error || "Não foi possível pesquisar ofertas na Shopee.",
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

// -------------------------
// ERROS E INICIALIZAÇÃO
// -------------------------

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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MEDEIROS DIGITAL iniciado na porta ${PORT}`);
});
