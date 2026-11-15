
const express = require("express");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const INDEX_FILE = path.join(__dirname, "index.html");

// Rafael mantém a pasta antiga para preservar a sessão já existente.
const PROFILES = {
  rafael: {
    id: "rafael",
    name: "Rafael",
    authDir: path.join(__dirname, ".baileys_auth"),
    dataFile: path.join(DATA_DIR, "store.json")
  },
  usuario2: {
    id: "usuario2",
    name: "Segundo usuário",
    authDir: path.join(__dirname, ".baileys_auth_usuario2"),
    dataFile: path.join(DATA_DIR, "usuario2", "store.json")
  }
};

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "200kb" }));

// =====================================
// ESTADO INDEPENDENTE DOS PERFIS
// =====================================

const sessions = {};

for (const id of Object.keys(PROFILES)) {
  sessions[id] = {
    socket: null,
    status: "disconnected",
    qr: null,
    pairingCode: null,
    initPromise: null,
    authState: null,
    lastPairingRequest: 0,
    manualDisconnect: false
  };
}

function getProfileId(value) {
  const id = String(value || "rafael").trim().toLowerCase();
  return PROFILES[id] ? id : null;
}

function getSession(id) {
  return sessions[id];
}

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
// ARMAZENAMENTO SEPARADO
// =====================================

function emptyStore() {
  return {
    products: [],
    destinations: [],
    queue: []
  };
}

function loadStore(profileId = "rafael") {
  const profile = PROFILES[profileId];

  if (!profile) return emptyStore();

  try {
    if (!fs.existsSync(profile.dataFile)) {
      return emptyStore();
    }

    const data = JSON.parse(
      fs.readFileSync(profile.dataFile, "utf8")
    );

    return {
      products: Array.isArray(data.products) ? data.products : [],
      destinations: Array.isArray(data.destinations) ? data.destinations : [],
      queue: Array.isArray(data.queue) ? data.queue : []
    };
  } catch (error) {
    console.error(
      `Erro ao ler dados do perfil ${profileId}:`,
      error.stack || error.message
    );

    return emptyStore();
  }
}

function saveStore(store, profileId = "rafael") {
  const profile = PROFILES[profileId];

  if (!profile) {
    throw new Error("Perfil inválido.");
  }

  fs.mkdirSync(path.dirname(profile.dataFile), {
    recursive: true
  });

  fs.writeFileSync(
    profile.dataFile,
    JSON.stringify(store, null, 2)
  );
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

function requireProfile(req, res, next) {
  const requested =
    req.query.profile ||
    req.body?.profile ||
    req.headers["x-profile"] ||
    "rafael";

  const profileId = getProfileId(requested);

  if (!profileId) {
    return res.status(400).json({
      ok: false,
      error: "Perfil inválido. Use rafael ou usuario2."
    });
  }

  req.profileId = profileId;
  req.profile = PROFILES[profileId];
  req.session = getSession(profileId);

  next();
}

// =====================================
// WHATSAPP - BAILEYS
// =====================================

function clearWhatsAppData(session) {
  session.qr = null;
  session.pairingCode = null;
}

async function startWhatsApp(profileId) {
  const profile = PROFILES[profileId];
  const session = getSession(profileId);

  if (session.socket) {
    return session.socket;
  }

  if (session.initPromise) {
    return session.initPromise;
  }

  session.status = "starting";
  session.manualDisconnect = false;
  clearWhatsAppData(session);

  const initPromise = (async () => {
    try {
      const baileys = await import("@whiskeysockets/baileys");

      const makeWASocket =
        baileys.default || baileys.makeWASocket;

      const useMultiFileAuthState =
        baileys.useMultiFileAuthState;

      const Browsers = baileys.Browsers;

      if (!makeWASocket || !useMultiFileAuthState) {
        throw new Error(
          "Não foi possível carregar as funções do Baileys."
        );
      }

      fs.mkdirSync(profile.authDir, {
        recursive: true
      });

      const { state, saveCreds } =
        await useMultiFileAuthState(profile.authDir);

      session.authState = state;

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

      session.socket = socket;

      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("connection.update", async (update) => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        // Ignora eventos de uma conexão antiga.
        if (session.socket !== socket) return;

        if (qr) {
          try {
            session.qr = await QRCode.toDataURL(qr);
            session.status = "qr";

            console.log(
              `QR Code disponível para ${profile.name}.`
            );
          } catch (error) {
            session.status = "error";

            console.error(
              "Erro ao gerar QR:",
              error.stack || error.message
            );
          }
        }

        if (connection === "connecting") {
          if (session.status !== "pairing") {
            session.status = "starting";
          }

          console.log(
            `Conectando WhatsApp de ${profile.name}...`
          );
        }

        if (connection === "open") {
          session.status = "ready";
          clearWhatsAppData(session);

          console.log(
            `WhatsApp de ${profile.name} conectado.`
          );
        }

        if (connection === "close") {
          const statusCode =
            lastDisconnect?.error?.output?.statusCode;

          const loggedOut =
            statusCode === baileys.DisconnectReason?.loggedOut;

          session.socket = null;
          clearWhatsAppData(session);

          if (session.manualDisconnect) {
            session.status = "disconnected";
          } else if (loggedOut) {
            session.status = "disconnected";

            console.log(
              `Sessão de ${profile.name} encerrada.`
            );
          } else {
            session.status = "error";

            console.error(
              `Conexão de ${profile.name} encerrada:`,
              lastDisconnect?.error?.message ||
                "Motivo não informado"
            );
          }
        }
      });

      console.log(
        `Cliente Baileys inicializado para ${profile.name}.`
      );

      return socket;

    } catch (error) {
      session.socket = null;
      session.status = "error";
      clearWhatsAppData(session);

      console.error(
        `Erro ao iniciar WhatsApp de ${profile.name}:`,
        error.stack || error.message
      );

      throw error;
    }
  })();

  session.initPromise = initPromise;

  try {
    return await initPromise;
  } finally {
    if (session.initPromise === initPromise) {
      session.initPromise = null;
    }
  }
}

// =====================================
// SAÚDE DO SERVIDOR
// =====================================

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "medeiros-shopee-affiliate-robot",
    profiles: {
      rafael: sessions.rafael.status,
      usuario2: sessions.usuario2.status
    }
  });
});

// =====================================
// STATUS DOS PERFIS
// =====================================

app.get("/api/profiles", adminOnly, (_req, res) => {
  res.json({
    ok: true,
    profiles: [
      {
        id: "rafael",
        name: "Rafael"
      },
      {
        id: "usuario2",
        name: "Segundo usuário"
      }
    ]
  });
});

app.get(
  "/api/status",
  adminOnly,
  requireProfile,
  (req, res) => {
    const store = loadStore(req.profileId);

    res.json({
      ok: true,
      profile: req.profileId,
      integrations: {
        shopee: "disabled",
        metaGroups: "disabled"
      },
      whatsapp: req.session.status,
      counts: {
        products: store.products.length,
        destinations: store.destinations.length,
        queue: store.queue.length
      },
      note:
        "A integração Shopee e a publicação automática ainda precisam ser configuradas e testadas."
    });
  }
);

// =====================================
// INFORMAÇÕES PRIVADAS DO WHATSAPP
// =====================================

app.get(
  "/api/whatsapp",
  adminOnly,
  requireProfile,
  (req, res) => {
    res.json({
      ok: true,
      profile: req.profileId,
      status: req.session.status,
      qr: req.session.qr,
      pairingCode: req.session.pairingCode
    });
  }
);

// =====================================
// INICIAR CONEXÃO WHATSAPP
// =====================================

app.post(
  "/api/whatsapp/connect",
  adminOnly,
  requireProfile,
  async (req, res) => {
    const session = req.session;
    const profile = req.profile;

    try {
      const method = req.body?.method;

      if (!["qr", "pairing"].includes(method)) {
        return res.status(400).json({
          ok: false,
          error: "Escolha qr ou pairing."
        });
      }

      if (session.status === "ready") {
        return res.json({
          ok: true,
          profile: req.profileId,
          status: "ready",
          message: "WhatsApp já está conectado."
        });
      }

      if (method === "qr") {
        startWhatsApp(req.profileId).catch((error) => {
          console.error(
            `Falha ao iniciar ${profile.name}:`,
            error.message
          );
        });

        return res.status(202).json({
          ok: true,
          profile: req.profileId,
          status: session.status,
          message: "Inicialização solicitada. Aguarde o QR Code."
        });
      }

      const phone = String(
        req.body?.phone || ""
      ).replace(/\D/g, "");

      if (!/^\d{12,13}$/.test(phone)) {
        return res.status(400).json({
          ok: false,
          error:
            "Informe o telefone com código do país e DDD, somente números."
        });
      }

      if (
        Date.now() - session.lastPairingRequest < 60000
      ) {
        return res.status(429).json({
          ok: false,
          error:
            "Aguarde 60 segundos antes de solicitar outro código."
        });
      }

      if (!session.socket) {
        startWhatsApp(req.profileId).catch((error) => {
          console.error(
            `Falha ao iniciar ${profile.name}:`,
            error.message
          );
        });

        return res.status(202).json({
          ok: true,
          profile: req.profileId,
          status: session.status,
          message:
            "WhatsApp está inicializando. Aguarde e tente novamente."
        });
      }

      if (session.initPromise) {
        return res.status(202).json({
          ok: true,
          status: session.status,
          message: "WhatsApp ainda está inicializando."
        });
      }

      if (
        session.status !== "qr" &&
        session.status !== "starting" &&
        session.status !== "pairing"
      ) {
        return res.status(409).json({
          ok: false,
          status: session.status,
          error:
            "A conexão ainda não está pronta. Tente novamente."
        });
      }

      if (session.authState?.creds?.registered) {
        return res.status(409).json({
          ok: false,
          status: session.status,
          error:
            "Esta sessão já possui registro. Tente conectar pelo QR Code."
        });
      }

      session.lastPairingRequest = Date.now();

      const code =
        await session.socket.requestPairingCode(phone);

      session.pairingCode = code;
      session.status = "pairing";

      return res.json({
        ok: true,
        profile: req.profileId,
        status: session.status,
        pairingCode: code
      });

    } catch (error) {
      session.status = "error";

      console.error(
        `Erro na conexão de ${profile.name}:`,
        error.stack || error.message
      );

      return res.status(500).json({
        ok: false,
        status: "error",
        error:
          "Não foi possível iniciar a conexão. Consulte os logs do servidor."
      });
    }
  }
);

// =====================================
// DESCONECTAR WHATSAPP
// =====================================

app.post(
  "/api/whatsapp/disconnect",
  adminOnly,
  requireProfile,
  async (req, res) => {
    const session = req.session;

    try {
      const socket = session.socket;

      session.manualDisconnect = true;
      session.socket = null;
      session.initPromise = null;
      session.status = "disconnected";

      clearWhatsAppData(session);

      if (socket) {
        try {
          socket.end(undefined);
        } catch (error) {
          console.error(
            "Erro ao encerrar socket:",
            error.message
          );
        }
      }

      return res.json({
        ok: true,
        profile: req.profileId,
        status: "disconnected"
      });

    } catch (error) {
      console.error(
        "Erro ao desconectar:",
        error.stack || error.message
      );

      return res.status(500).json({
        ok: false,
        error: "Não foi possível desconectar."
      });
    }
  }
);

// =====================================
// ENVIAR MENSAGEM DE TESTE
// =====================================

app.post(
  "/api/whatsapp/send",
  adminOnly,
  requireProfile,
  async (req, res) => {
    try {
      const session = req.session;

      if (
        !session.socket ||
        session.status !== "ready"
      ) {
        return res.status(409).json({
          ok: false,
          error: "WhatsApp deste perfil não está conectado."
        });
      }

      const phone = String(
        req.body?.phone || ""
      ).replace(/\D/g, "");

      const message = String(
        req.body?.message || ""
      ).trim();

      if (!/^\d{12,13}$/.test(phone)) {
        return res.status(400).json({
          ok: false,
          error:
            "Informe o telefone com código do país e DDD."
        });
      }

      if (!message || message.length > 4000) {
        return res.status(400).json({
          ok: false,
          error:
            "A mensagem deve ter entre 1 e 4000 caracteres."
        });
      }

      const jid = `${phone}@s.whatsapp.net`;

      const result = await session.socket.sendMessage(
        jid,
        { text: message }
      );

      return res.json({
        ok: true,
        profile: req.profileId,
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
  }
);

// =====================================
// DADOS DO PERFIL
// =====================================

app.get(
  "/api/data",
  adminOnly,
  requireProfile,
  (req, res) => {
    res.json({
      ok: true,
      profile: req.profileId,
      ...loadStore(req.profileId)
    });
  }
);

// =====================================
// PRODUTOS
// Mantido temporariamente para compatibilidade.
// A busca automática Shopee será implementada depois.
// =====================================

app.post(
  "/api/products",
  adminOnly,
  requireProfile,
  (req, res) => {
    const { name, affiliateUrl, price } = req.body || {};

    if (!name || typeof name !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Informe o nome do produto."
      });
    }

    const store = loadStore(req.profileId);

    const item = {
      id: Date.now().toString(),
      name: name.slice(0, 160),
      affiliateUrl: String(
        affiliateUrl || ""
      ).slice(0, 1000),
      price: String(price || "").slice(0, 40),
      createdAt: new Date().toISOString()
    };

    store.products.unshift(item);
    saveStore(store, req.profileId);

    res.status(201).json(item);
  }
);

// =====================================
// DESTINOS
// =====================================

app.post(
  "/api/destinations",
  adminOnly,
  requireProfile,
  (req, res) => {
    const { name, channel } = req.body || {};

    if (!name || !channel) {
      return res.status(400).json({
        ok: false,
        error: "Informe nome e canal."
      });
    }

    const store = loadStore(req.profileId);

    const item = {
      id: Date.now().toString(),
      name: String(name).slice(0, 100),
      channel: String(channel).slice(0, 60),
      status: "pending_validation"
    };

    store.destinations.unshift(item);
    saveStore(store, req.profileId);

    res.status(201).json(item);
  }
);

// =====================================
// FILA DE OFERTAS
// =====================================

app.post(
  "/api/queue",
  adminOnly,
  requireProfile,
  (req, res) => {
    const {
      productId,
      destinationId,
      scheduledAt
    } = req.body || {};

    const store = loadStore(req.profileId);

    if (!store.products.some((x) => x.id === productId)) {
      return res.status(400).json({
        ok: false,
        error: "Produto não encontrado."
      });
    }

    if (
      !store.destinations.some(
        (x) => x.id === destinationId
      )
    ) {
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
    saveStore(store, req.profileId);

    res.status(201).json(item);
  }
);

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
  console.error(
    "Erro na requisição:",
    err.stack || err.message
  );

  if (res.headersSent) return;

  res.status(err.status || 500).json({
    ok: false,
    error: "Erro interno na requisição."
  });
});

// =====================================
// INICIALIZAÇÃO
// =====================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `MEDEIROS DIGITAL iniciado na porta ${PORT}`
  );

  console.log(
    "Perfis disponíveis: Rafael e Segundo usuário."
  );

  console.log(
    "WhatsApps serão iniciados somente quando solicitados."
  );
});
