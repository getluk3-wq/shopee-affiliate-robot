
const express = require("express");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const INDEX_FILE = path.join(__dirname, "index.html");
const AUTH_DIR = path.join(__dirname, ".baileys_auth");

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
// WHATSAPP - BAILEYS
// =====================================

let whatsappClient = null;
let whatsappStatus = "disconnected";
let whatsappQR = null;
let whatsappPairingCode = null;
let whatsappInitPromise = null;
let whatsappAuthState = null;
let lastPairingRequest = 0;
let manualDisconnect = false;

function clearWhatsAppData() {
  whatsappQR = null;
  whatsappPairingCode = null;
}

async function startWhatsApp() {
  if (whatsappClient) {
    return whatsappClient;
  }

  if (whatsappInitPromise) {
    return whatsappInitPromise;
  }

  whatsappStatus = "starting";
  manualDisconnect = false;
  clearWhatsAppData();

  const initPromise = (async () => {
    try {
      const baileys = await import("@whiskeysockets/baileys");

      const makeWASocket = baileys.default || baileys.makeWASocket;
      const useMultiFileAuthState = baileys.useMultiFileAuthState;
      const Browsers = baileys.Browsers;

      if (!makeWASocket || !useMultiFileAuthState) {
        throw new Error("Não foi possível carregar as funções do Baileys.");
      }

      fs.mkdirSync(AUTH_DIR, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      whatsappAuthState = state;

      const socket = makeWASocket({
        auth: state,
        browser: Browsers
          ? Browsers.macOS("MEDEIROS DIGITAL")
          : undefined,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 250,
        generateHighQualityLinkPreview: false
      });

      whatsappClient = socket;

      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            whatsappQR = await QRCode.toDataURL(qr);
            whatsappStatus = "qr";
            console.log("QR Code do WhatsApp disponível.");
          } catch (error) {
            whatsappStatus = "error";
            console.error("Erro ao gerar QR:", error.stack || error.message);
          }
        }

        if (connection === "connecting") {
          if (whatsappStatus !== "pairing") {
            whatsappStatus = "starting";
          }
          console.log("Conectando ao WhatsApp...");
        }

        if (connection === "open") {
          whatsappStatus = "ready";
          clearWhatsAppData();
          console.log("WhatsApp conectado e pronto.");
        }

        if (connection === "close") {
          const statusCode =
            lastDisconnect?.error?.output?.statusCode;

          const loggedOut =
            statusCode === baileys.DisconnectReason?.loggedOut;

          whatsappClient = null;
          clearWhatsAppData();

          if (manualDisconnect) {
            whatsappStatus = "disconnected";
          } else if (loggedOut) {
            whatsappStatus = "disconnected";
            console.log("Sessão do WhatsApp encerrada. Será necessário conectar novamente.");
          } else {
            whatsappStatus = "error";
            console.error(
              "Conexão WhatsApp encerrada:",
              lastDisconnect?.error?.message || "Motivo não informado"
            );
          }
        }
      });

      console.log("Cliente Baileys inicializado.");
      return socket;

    } catch (error) {
      whatsappClient = null;
      whatsappStatus = "error";
      clearWhatsAppData();

      console.error(
        "Erro ao iniciar Baileys:",
        error.stack || error.message
      );

      throw error;
    }
  })();

  whatsappInitPromise = initPromise;

  try {
    return await initPromise;
  } finally {
    if (whatsappInitPromise === initPromise) {
      whatsappInitPromise = null;
    }
  }
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

    if (method === "qr") {
      startWhatsApp().catch((error) => {
        console.error(
          "Falha na inicialização:",
          error.stack || error.message
        );
      });

      return res.status(202).json({
        ok: true,
        status: whatsappStatus,
        message: "Inicialização solicitada. Aguarde o QR Code."
      });
    }

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
        message: "WhatsApp está inicializando. Aguarde alguns segundos e tente novamente."
      });
    }

    if (whatsappInitPromise) {
      return res.status(202).json({
        ok: true,
        status: whatsappStatus,
        message: "WhatsApp ainda está inicializando. Aguarde."
      });
    }

    if (
      whatsappStatus !== "qr" &&
      whatsappStatus !== "starting" &&
      whatsappStatus !== "pairing"
    ) {
      return res.status(409).json({
        ok: false,
        status: whatsappStatus,
        error: "A conexão ainda não está pronta. Tente novamente."
      });
    }

    if (whatsappAuthState?.creds?.registered) {
      return res.status(409).json({
        ok: false,
        status: whatsappStatus,
        error: "Esta sessão já possui registro. Tente conectar pelo QR Code."
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
    const socket = whatsappClient;

    manualDisconnect = true;
    whatsappClient = null;
    whatsappInitPromise = null;
    whatsappStatus = "disconnected";
    clearWhatsAppData();

    if (socket) {
      try {
        socket.end(undefined);
      } catch (error) {
        console.error("Erro ao encerrar socket:", error.message);
      }
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
// ENVIAR MENSAGEM DE TESTE PELO WHATSAPP
// =====================================

app.post("/api/whatsapp/send", adminOnly, async (req, res) => {
  try {
    if (!whatsappClient || whatsappStatus !== "ready") {
      return res.status(409).json({
        ok: false,
        error: "WhatsApp não está conectado."
      });
    }

    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    const message = String(req.body?.message || "").trim();

    if (!/^\d{12,13}$/.test(phone)) {
      return res.status(400).json({
        ok: false,
        error: "Informe o telefone com código do país e DDD."
      });
    }

    if (!message || message.length > 4000) {
      return res.status(400).json({
        ok: false,
        error: "A mensagem deve ter entre 1 e 4000 caracteres."
      });
    }

    const jid = `${phone}@s.whatsapp.net`;

    const result = await whatsappClient.sendMessage(jid, {
      text: message
    });

    return res.json({
      ok: true,
      message: "Mensagem enviada.",
      messageId: result?.key?.id || null
    });

  } catch (error) {
    console.error(
      "Erro ao enviar mensagem:",
      error.stack || error.message
    );

    return res.status(500).json({
      ok: false,
      error: "Não foi possível enviar a mensagem."
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
