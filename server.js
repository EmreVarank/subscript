import { createServer } from "node:http";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8080);
const adminEmail = (process.env.ADMIN_EMAIL || "admin@subscript.local").toLowerCase();
const dataDir = join(root, "data");
const usersFile = join(dataDir, "users.json");
const databaseFile = join(dataDir, "subscript.sqlite");

mkdirSync(dataDir, { recursive: true });
const database = new DatabaseSync(databaseFile);
database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    level TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
`);

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(status === 204 ? undefined : JSON.stringify(body));
};
const readBody = async (req) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
};
const publicUser = ({ passwordHash, password_hash, createdAt, created_at, ...user }) => ({
  ...user,
  createdAt: createdAt || created_at
});
const hashPassword = (password, salt = randomBytes(16).toString("hex")) =>
  `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const validPassword = (password, stored) => {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64).toString("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};
const token = () => randomBytes(32).toString("hex");
const tokenHash = (value) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const sessionExpiry = () => new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();

function migrateUsers() {
  const count = database.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (count > 0 || !existsSync(usersFile)) return;
  const users = json(usersFile);
  const insert = database.prepare(`
    INSERT OR IGNORE INTO users (id, name, email, password_hash, level, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const user of users) {
    insert.run(user.id, user.name, user.email, user.passwordHash, user.level || null, user.createdAt || now());
  }
}

migrateUsers();

function currentUser(req) {
  const value = req.headers.authorization || "";
  const bearer = value.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return null;
  const session = database.prepare(`
    SELECT users.id, users.name, users.email, users.level, users.created_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash(bearer), now());
  return session || null;
}

function createSession(userId) {
  const sessionToken = token();
  database.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash(sessionToken), userId, sessionExpiry(), now());
  return sessionToken;
}

function findUserByEmail(email) {
  return database.prepare(`
    SELECT id, name, email, password_hash, level, created_at
    FROM users
    WHERE email = ?
  `).get(email);
}

function catalog() {
  return json(join(root, "clips.json"));
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/clips") {
    const user = currentUser(req);
    return send(res, 200, {
      clips: catalog(),
      user: user ? publicUser(user) : null
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/clips/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/clips/".length));
    const item = catalog().find((clip) => clip.id === id);
    if (!item) return send(res, 404, { error: "Klip bulunamadı." });
    const file = resolve(root, item.dataFile);
    if (relative(root, file).startsWith("..")) return send(res, 400, { error: "Geçersiz klip yolu." });
    return send(res, 200, json(file));
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = currentUser(req);
    return user ? send(res, 200, { user: publicUser(user) }) : send(res, 401, { error: "Oturum bulunamadı." });
  }

  if (req.method === "DELETE" && url.pathname === "/api/auth/session") {
    const value = req.headers.authorization || "";
    const bearer = value.replace(/^Bearer\s+/i, "").trim();
    if (bearer) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(bearer));
    return send(res, 204, {});
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = String(body.name || "").trim();
    if (!name || !email.includes("@") || password.length < 8) {
      return send(res, 400, { error: "Ad, geçerli e-posta ve en az 8 karakterli şifre gerekli." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: "Geçerli bir e-posta adresi gerekli." });
    if (findUserByEmail(email)) return send(res, 409, { error: "Bu e-posta zaten kayıtlı." });
    const user = { id: randomBytes(12).toString("hex"), name, email, passwordHash: hashPassword(password), level: null, createdAt: now() };
    database.prepare(`
      INSERT INTO users (id, name, email, password_hash, level, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.id, user.name, user.email, user.passwordHash, user.level, user.createdAt);
    const sessionToken = createSession(user.id);
    return send(res, 201, { token: sessionToken, user: publicUser(user) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(req);
    const user = findUserByEmail(String(body.email || "").trim().toLowerCase());
    if (!user || !validPassword(String(body.password || ""), user.password_hash)) {
      return send(res, 401, { error: "E-posta veya şifre hatalı." });
    }
    const sessionToken = createSession(user.id);
    return send(res, 200, { token: sessionToken, user: publicUser(user) });
  }

  if (req.method === "POST" && url.pathname === "/api/profile/level") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Giriş yapmalısın." });
    const level = String((await readBody(req)).level || "").toUpperCase();
    if (!["A1", "A2", "B1", "B2", "C1"].includes(level)) return send(res, 400, { error: "Geçersiz seviye." });
    database.prepare("UPDATE users SET level = ? WHERE id = ?").run(level, user.id);
    const updatedUser = database.prepare("SELECT id, name, email, level, created_at FROM users WHERE id = ?").get(user.id);
    return send(res, 200, { user: publicUser(updatedUser) });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/clips") {
    const user = currentUser(req);
    if (!user || user.email !== adminEmail) return send(res, 403, { error: "Bu işlem yalnızca admin içindir." });
    const body = await readBody(req);
    const required = ["id", "title", "level", "youtubeId", "dataFile"];
    if (required.some((key) => !body[key])) return send(res, 400, { error: "id, title, level, youtubeId ve dataFile gerekli." });
    const clips = catalog();
    if (clips.some((clip) => clip.id === body.id)) return send(res, 409, { error: "Bu klip id'si zaten kullanılıyor." });
    const item = { id: String(body.id), title: String(body.title), level: String(body.level).toUpperCase(), youtubeId: String(body.youtubeId), dataFile: String(body.dataFile) };
    writeFileSync(join(root, "clips.json"), JSON.stringify([...clips, item], null, 2) + "\n");
    return send(res, 201, { clip: item });
  }

  return send(res, 404, { error: "API endpoint bulunamadı." });
}

function staticFile(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = resolve(root, "." + normalize(requested));
  if (relative(root, file).startsWith("..")) return send(res, 403, { error: "Forbidden" });
  if (!existsSync(file)) {
    if (!extname(url.pathname)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(readFileSync(join(root, "index.html")));
    }
    return send(res, 404, { error: "Dosya bulunamadı." });
  }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
  res.writeHead(200, { "Content-Type": `${types[extname(file)] || "application/octet-stream"}; charset=utf-8` });
  res.end(readFileSync(file));
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else staticFile(req, res, url);
  } catch (error) {
    console.error(error);
    send(res, 500, { error: "Sunucu hatası." });
  }
}).listen(port, () => console.log(`subscript API: http://localhost:${port}`));
