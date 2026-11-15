
const express = require("express");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const INDEX_FILE = path.join(__dirname, "index.html");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "200kb" }));

app.get("/", (_req, res) => {
  res.sendFile(INDEX_FILE, (err) => {
    if (err && !res.headersSent) {
      res.status(500).send("Não foi possível carregar o painel.");
    }
  });
});

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { products: [], destinations: [], queue: [] };
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (error) {
    console.error("Erro ao ler dados:", error.message);
    return { products: [], destinations: [], queue: [] };
  }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function adminOnly(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    return res.status(503).json({
      error: "ADMIN_PASSWORD não configurada."
    });
  }

  if (req.headers["x-admin-password"] !== expected) {
    return res.status(401).json({
      error: "Senha administrativa inválida."
    });
  }

  next();
}

// WhatsApp
let whatsappClient = null;
let whatsappStatus = "disconnected";
let whatsappQR = null;
let whatsappPairingCode = null;
let whatsappInitPromise = null;
let lastPairingRequest = 0;

async function startWhatsApp() {
  if (whatsappClient) {
    return;
  }

  whatsappStatus = "starting";
  whatsappQR = null;
  whatsappPairingCode = null;

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: "medeiros-digital"
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    }
  });

  whatsappClient = client;

  client.on("qr", async (qr) => {
    try {
      whatsappQR = await QRCode.toDataURL(qr);
      whatsappStatus = "qr";
      console.log("Novo QR Code do WhatsApp disponível no painel.");
    } catch (error) {
      whatsappStatus = "error";
      console.error("Erro ao gerar QR:", error.message);
    }
  });

  client.on("authenticated", () => {
    whatsappStatus = "authenticated";
    whatsappQR = null;
    whatsappPairingCode = null;
    console.log("WhatsApp autenticado.");
  });

  client.on("ready", () => {
    whatsappStatus = "ready";
    whatsappQR = null;
    whatsappPairingCode = null;
    console.log("WhatsApp conectado e pronto.");
  });

  client.on("auth_failure", (message) => {
    whatsappStatus = "error";
    console.error("Falha na autenticação do WhatsApp:", message);
  });

  client.on("disconnected", (reason) => {
    whatsappStatus = "disconnected";
    whatsappQR = null;
    whatsappPairingCode = null;
    whatsappClient = null;
    whatsappInitPromise = null;
    console.log("WhatsApp desconectado:", reason);
  });

  whatsappInitPromise = client.initialize().catch((error) => {
    whatsappStatus = "error";
    whatsappClient = null;
    whatsappInitPromise = null;
    console.error("Erro ao iniciar WhatsApp:", error.message);
    throw error;
  });

  await whatsappInitPromise;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "medeiros-shopee-affiliate-robot"
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

// Informações privadas da conexão
app.get("/api/whatsapp", adminOnly, (_req, res) => {
  res.json({
    status: whatsappStatus,
    qr: whatsappQR,
    pairingCode: whatsappPairingCode
  });
});

// Iniciar conexão por QR Code ou código de pareamento
app.post("/api/whatsapp/connect", adminOnly, async (req, res) => {
  try {
    const method = req.body?.method;

    if (!["qr", "pairing"].includes(method)) {
      return res.status(400).json({
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

    if (!whatsappClient) {
      await startWhatsApp();
    } else if (whatsappInitPromise) {
      await whatsappInitPromise;
    }

    if (method === "qr") {
      return res.json({
        ok: true,
        status: whatsappStatus,
        message: "Aguardando o QR Code. Consulte a conexão no painel."
      });
    }

    const phone = String(req.body?.phone || "").replace(/\D/g, "");

    if (!/^\d{12,13}$/.test(phone)) {
      return res.status(400).json({
        error: "Informe o telefone com código do país e DDD, somente números."
      });
    }

    if (Date.now() - lastPairingRequest < 60000) {
      return res.status(429).json({
        error: "Aguarde 60 segundos antes de solicitar outro código."
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
    console.error("Erro na conexão WhatsApp:", error.message);

    return res.status(500).json({
      error: "Não foi possível iniciar a conexão. Verifique os logs do Render."
    });
  }
});

// Desconectar WhatsApp
app.post("/api/whatsapp/disconnect", adminOnly, async (_req, res) => {
  try {
    if (whatsappClient) {
      const client = whatsappClient;
      whatsappClient = null;
      whatsappInitPromise = null;
      await client.destroy();
    }

    whatsappStatus = "disconnected";
    whatsappQR = null;
    whatsappPairingCode = null;

    res.json({
      ok: true,
      status: whatsappStatus
    });
  } catch (error) {
    console.error("Erro ao desconectar:", error.message);
    res.status(500).json({
      error: "Não foi possível desconectar."
    });
  }
});

// Produtos
app.get("/api/data", adminOnly, (_req, res) => {
  res.json(loadStore());
});

app.post("/api/products", adminOnly, (req, res) => {
  const { name, affiliateUrl, price } = req.body || {};

  if (!name || typeof name !== "string") {
    return res.status(400).json({
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

// Destinos
app.post("/api/destinations", adminOnly, (req, res) => {
  const { name, channel } = req.body || {};

  if (!name || !channel) {
    return res.status(400).json({
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

// Fila de ofertas
app.post("/api/queue", adminOnly, (req, res) => {
  const { productId, destinationId, scheduledAt } = req.body || {};
  const store = loadStore();

  if (!store.products.some((x) => x.id === productId)) {
    return res.status(400).json({
      error: "Produto não encontrado."
    });
  }

  if (!store.destinations.some((x) => x.id === destinationId)) {
    return res.status(400).json({
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

app.use((err, _req, res, _next) => {
  console.error("Erro na requisição:", err.message);
  res.status(500).json({
    error: "Erro interno."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MEDEIROS DIGITAL iniciado na porta ${PORT}`);
});
