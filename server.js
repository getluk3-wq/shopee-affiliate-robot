const express = require("express");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { products: [], destinations: [], queue: [] };
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { products: [], destinations: [], queue: [] };
  }
}
function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}
function adminOnly(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(503).json({ error: "ADMIN_PASSWORD não configurada." });
  const supplied = req.headers["x-admin-password"];
  if (supplied !== expected) return res.status(401).json({ error: "Senha administrativa inválida." });
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "medeiros-shopee-affiliate-robot" }));
app.get("/api/status", (_req, res) => {
  const store = loadStore();
  res.json({
    ok: true,
    integrations: {
      shopee: process.env.SHOPEE_API_ENABLED === "true" ? "configured-for-validation" : "disabled",
      metaGroups: process.env.META_GROUPS_API_ENABLED === "true" ? "configured-for-validation" : "disabled"
    },
    counts: { products: store.products.length, destinations: store.destinations.length, queue: store.queue.length },
    note: "Starter dashboard. Official API connections and real publishing are not implemented or enabled."
  });
});
app.get("/api/data", adminOnly, (_req, res) => res.json(loadStore()));
app.post("/api/products", adminOnly, (req, res) => {
  const { name, affiliateUrl, price } = req.body || {};
  if (!name || typeof name !== "string") return res.status(400).json({ error: "Informe o nome do produto." });
  const store = loadStore();
  const item = { id: Date.now().toString(), name: name.slice(0, 160), affiliateUrl: String(affiliateUrl || "").slice(0, 1000), price: String(price || "").slice(0, 40), createdAt: new Date().toISOString() };
  store.products.unshift(item); saveStore(store); res.status(201).json(item);
});
app.post("/api/destinations", adminOnly, (req, res) => {
  const { name, channel } = req.body || {};
  if (!name || !channel) return res.status(400).json({ error: "Informe nome e canal." });
  const store = loadStore();
  const item = { id: Date.now().toString(), name: String(name).slice(0, 100), channel: String(channel).slice(0, 60), status: "pending_validation" };
  store.destinations.unshift(item); saveStore(store); res.status(201).json(item);
});
app.post("/api/queue", adminOnly, (req, res) => {
  const { productId, destinationId, scheduledAt } = req.body || {};
  const store = loadStore();
  if (!store.products.some(x => x.id === productId)) return res.status(400).json({ error: "Produto não encontrado." });
  if (!store.destinations.some(x => x.id === destinationId)) return res.status(400).json({ error: "Destino não encontrado." });
  const item = { id: Date.now().toString(), productId, destinationId, scheduledAt: scheduledAt || null, status: "draft", createdAt: new Date().toISOString() };
  store.queue.unshift(item); saveStore(store); res.status(201).json(item);
});
app.use((err, _req, res, _next) => {
  console.error("Request error:", err.message);
  res.status(500).json({ error: "Erro interno." });
});
app.listen(PORT, "0.0.0.0", () => console.log(`Server listening on ${PORT}`));
