
const express = require("express");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const INDEX_FILE = path.join(__dirname, "index.html");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "200kb" }));

// =====================================
// PAINEL PRINCIPAL
// =====================================

app.get("/", (_req, res) => {
  res.sendFile(INDEX_FILE, (err) => {
    if (err && !res.headersSent) {
      res.status(500).send("Não foi possível carregar o painel.");
    }
  });
});

// =====================================
// BANCO DE DADOS LOCAL
// =====================================

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { products: [], destinations: [], queue: [] };
    }

    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    return {
      products: Array.isArray(data.products) ? data.products : [],
      destinations: Array.isArray(data.destinations) ? data.destinations : [],
      queue: Array.isArray(data.queue) ? data.queue : []
    };
  } catch (error) {
    console.error("Erro ao ler dados:", error.stack || error.message);
    return { products: [], destinations: [], queue: [] };
  }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

// =====================================
// PROTEÇÃO ADMINISTRATIVA
// =====================================

function adminOnly(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    return res.status(503).json({
      ok: false,
      error: "ADMIN_PASSWORD não configurada."
    });
  }

  if (req.headers["x-admin-password"] !== expected) {
    return res.status(401).json({
      ok: false,
      error: "Senha administrativa inválida."
    });
  }

  next();
}

// =====================================
// WHATSAPP
// =====================================

let whatsappClient = null;
let whatsappStatus = "disconnected";
let whatsappQR = null;
let whatsappPairingCode = null;
let whatsappInitPromise = null;
let lastPairingRequest = 0;

function clearWhatsAppData() {
  whatsappQR = null;
  whatsappPairingCode = null;
}

function getChromePath() {
  const chromePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    puppeteer.executablePath();

  if (!fs.existsSync(chromePath)) {
    throw new Error(
      "Chrome não encontrado no caminho configurado: " + chromePath
    );
  }

  return chromePath;
}

// Inicialização do WhatsApp sem duplicidade
function startWhatsApp() {
  if (whatsappStatus === "ready") {
    return Promise.resolve();
  }

  if (whatsappInitPromise) {
    return whatsappInitPromise;
  }

  if (whatsappClient) {
    return Promise.resolve();
  }

  whatsappStatus = "starting";
  clearWhatsAppData();

  let chromePath;

  try {
    chromePath = getChromePath();
    console.log("Chrome encontrado:", chromePath);
  } catch (error) {
    whatsappStatus = "error";
    console.error("Erro ao localizar Chrome:", error.stack || error.message);
    return Promise.reject(error);
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: "medeiros-digital",
      dataPath: path.join(__dirname, ".wwebjs_auth")
    }),

    puppeteer: {
      executablePath: chromePath,
      headless: true,
      timeout: 120000,
      protocolTimeout: 180000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-features=Translate,BackForwardCache",
        "--no-first-run",
        "--no-default-browser-check"
      ]
    }
  });

  whatsappClient = client;

  client.on("qr", async (qr) => {
    try {
      whatsappQR = await QRCode.toDataURL(qr);
      whatsappStatus = "qr";
      console.log("QR Code do WhatsApp disponível.");
    } catch (error) {
      whatsappStatus = "error";
      console.error("Erro ao gerar QR Code:", error.stack || error.message);
    }
  });

  client.on("authenticated", () => {
    whatsappStatus = "authenticated";
    clearWhatsAppData();
    console.log("WhatsApp autenticado.");
  });

  client.on("ready", () => {
    whatsappStatus = "ready";
    clearWhatsAppData();
    console.log("WhatsApp conectado e pronto.");
  });

  client.on("auth_failure", (message) => {
    whatsappStatus = "error";
    clearWhatsAppData();
    console.error("Falha na autenticação:", message);
  });

  client.on("disconnected", (reason) => {
    whatsappStatus = "disconnected";
    clearWhatsAppData();

    if (whatsappClient === client) {
      whatsappClient = null;
    }

    console.log("WhatsApp desconectado:", reason);
  });

  const initPromise = Promise.resolve()
    .then(() => client.initialize())
    .catch(async (error) => {
      whatsappStatus = "error";

      if (whatsappClient === client) {
        whatsappClient = null;
      }

      clearWhatsAppData();

      console.error(
        "Erro completo ao iniciar WhatsApp:",
        error.stack || error.message
      );

      try {
        await client.destroy();
      } catch (destroyError) {
        console.error(
          "Erro ao encerrar navegador:",
          destroyError.message
        );
      }

      throw error;
    })
    .finally(() => {
      if (whatsappInitPromise === initPromise) {
        whatsappInitPromise = null;
      }
    });

  whatsappInitPromise = initPromise;

  return initPromise;
}

// =====================================
// STATUS E SAÚDE DO SERVIDOR
// =====================================

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "medeiros-shopee-affiliate-robot",
    whatsapp: whatsappStatus
  });
});

app.get("/api/status", (_req, res) => {
  const store = loadStore();

  res.json({
    ok: true,
    integrations: {
      shopee: process.env.SHOPEE_API_ENABLED === "true"
        ? "configured-for-validation"
        : "disabled",

      metaGroups: process.env.META_GROUPS_API_ENABLED === "true"
        ? "configured-for-validation"
        : "disabled"
    },

    whatsapp: whatsappStatus,

    counts: {
      products: store.products.length,
      destinations: store.destinations.length,
      queue: store.queue.length
    },

    note: "Shopee API e publicação automática ainda não estão habilitadas."
  });
});

// =====================================
// INFORMAÇÕES PRIVADAS DO WHATSAPP
// =====================================

app.get("/api/whatsapp", adminOnly, (_req, res) => {
  res.json({
    ok: true,
    status: whatsappStatus,
    qr: whatsappQR,
    pairingCode: whatsappPairingCode
  });
});

// =====================================
// INICIAR CONEXÃO WHATSAPP
// =====================================

app.post("/api/whatsapp/connect", adminOnly, async (req, res) => {
  try {
    const method = req.body?.method;

    if (!["qr", "pairing"].includes(method)) {
      return res.status(400).json({
        ok: false,
        error: "Escolha qr ou pairing."
      });
    }

    if (whatsappStatus === "ready") {
      return res.json({
        ok: true,
        status: "ready",
        message: "WhatsApp já está conectado."
      });
    }

    // Conexão por QR Code
    if (method === "qr") {
      startWhatsApp().catch((error) => {
        console.error(
          "Falha na inicialização em segundo plano:",
          error.stack || error.message
        );
      });

      return res.status(202).json({
        ok: true,
        status: whatsappStatus,
        message: "Inicialização solicitada. Aguarde o QR Code."
      });
    }

    // Conexão por código de pareamento
    const phone = String(req.body?.phone || "").replace(/\D/g, "");

    if (!/^\d{12,13}$/.test(phone)) {
      return res.status(400).json({
        ok: false,
        error: "Informe o telefone com código do país e DDD, somente números."
      });
    }

    if (Date.now() - lastPairingRequest < 60000) {
      return res.status(429).json({
        ok: false,
        error: "Aguarde 60 segundos antes de solicitar outro código."
      });
    }

    if (!whatsappClient) {
      startWhatsApp().catch((error) => {
        console.error(
          "Falha na inicialização:",
          error.stack || error.message
        );
      });

      return res.status(202).json({
        ok: true,
        status: whatsappStatus,
        message: "WhatsApp está inicializando. Aguarde e tente novamente."
      });
    }

    if (whatsappInitPromise) {
      return res.status(202).json({
        ok: true,
        status: whatsappStatus,
        message: "WhatsApp ainda está inicializando. Aguarde."
      });
    }

    if (whatsappStatus !== "qr" && whatsappStatus !== "ready") {
      return res.status(409).json({
        ok: false,
        status: whatsappStatus,
        error: "A conexão ainda não está pronta. Aguarde."
      });
    }

    lastPairingRequest = Date.now();

    const code = await whatsappClient.requestPairingCode(phone);

    whatsappPairingCode = code;
    whatsappStatus = "pairing";

    return res.json({
      ok: true,
      status: whatsappStatus,
      pairingCode: code
    });

  } catch (error) {
    whatsappStatus = "error";

    console.error(
      "Erro na conexão WhatsApp:",
      error.stack || error.message
    );

    return res.status(500).json({
      ok: false,
      status: "error",
      error: "Não foi possível iniciar a conexão. Consulte os logs do servidor."
    });
  }
});

// =====================================
// DESCONECTAR WHATSAPP
// =====================================

app.post("/api/whatsapp/disconnect", adminOnly, async (_req, res) => {
  try {
    const client = whatsappClient;

    whatsappClient = null;
    whatsappInitPromise = null;
    whatsappStatus = "disconnected";
    clearWhatsAppData();

    if (client) {
      await client.destroy();
    }

    return res.json({
      ok: true,
      status: "disconnected"
    });

  } catch (error) {
    console.error("Erro ao desconectar:", error.stack || error.message);

    return res.status(500).json({
      ok: false,
      error: "Não foi possível desconectar."
    });
  }
});

// =====================================
// PRODUTOS
// =====================================

app.get("/api/data", adminOnly, (_req, res) => {
  res.json(loadStore());
});

app.post("/api/products", adminOnly, (req, res) => {
  const { name, affiliateUrl, price } = req.body || {};

  if (!name || typeof name !== "string") {
    return res.status(400).json({
      ok: false,
      error: "Informe o nome do produto."
    });
  }

  const store = loadStore();

  const item = {
    id: Date.now().toString(),
    name: name.slice(0, 160),
    affiliateUrl: String(affiliateUrl || "").slice(0, 1000),
    price: String(price || "").slice(0, 40),
    createdAt: new Date().toISOString()
  };

  store.products.unshift(item);
  saveStore(store);

  res.status(201).json(item);
});

// =====================================
// DESTINOS
// =====================================

app.post("/api/destinations", adminOnly, (req, res) => {
  const { name, channel } = req.body || {};

  if (!name || !channel) {
    return res.status(400).json({
      ok: false,
      error: "Informe nome e canal."
    });
  }

  const store = loadStore();

  const item = {
    id: Date.now().toString(),
    name: String(name).slice(0, 100),
    channel: String(channel).slice(0, 60),
    status: "pending_validation"
  };

  store.destinations.unshift(item);
  saveStore(store);

  res.status(201).json(item);
});

// =====================================
// FILA DE OFERTAS
// =====================================

app.post("/api/queue", adminOnly, (req, res) => {
  const { productId, destinationId, scheduledAt } = req.body || {};
  const store = loadStore();

  if (!store.products.some((x) => x.id === productId)) {
    return res.status(400).json({
      ok: false,
      error: "Produto não encontrado."
    });
  }

  if (!store.destinations.some((x) => x.id === destinationId)) {
    return res.status(400).json({
      ok: false,
      error: "Destino não encontrado."
    });
  }

  const item = {
    id: Date.now().toString(),
    productId,
    destinationId,
    scheduledAt: scheduledAt || null,
    status: "draft",
    createdAt: new Date().toISOString()
  };

  store.queue.unshift(item);
  saveStore(store);

  res.status(201).json(item);
});

// =====================================
// ROTA NÃO ENCONTRADA
// =====================================

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "Rota não encontrada."
  });
});

// =====================================
// TRATAMENTO DE ERROS
// =====================================

app.use((err, _req, res, _next) => {
  console.error("Erro na requisição:", err.stack || err.message);

  if (res.headersSent) return;

  res.status(err.status || 500).json({
    ok: false,
    error: "Erro interno na requisição."
  });
});

// =====================================
// INICIALIZAÇÃO DO SERVIDOR
// =====================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MEDEIROS DIGITAL iniciado na porta ${PORT}`);
  console.log("Servidor pronto para receber requisições.");
});
