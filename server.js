import { createServer } from "node:http";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8080);
const adminEmail = (process.env.ADMIN_EMAIL || "admin@subscript.local").toLowerCase();
const dataDir = join(root, "data");
const usersFile = join(dataDir, "users.json");
const sessions = new Map();

mkdirSync(dataDir, { recursive: true });
if (!existsSync(usersFile)) writeFileSync(usersFile, "[]\n");

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const saveUsers = (users) => writeFileSync(usersFile, JSON.stringify(users, null, 2) + "\n");
const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const readBody = async (req) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
};
const publicUser = ({ passwordHash, ...user }) => user;
const hashPassword = (password, salt = randomBytes(16).toString("hex")) =>
  `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const validPassword = (password, stored) => {
  const [salt, expected] = stored.split(":");
  const actual = scryptSync(password, salt, 64).toString("hex");
  return expected && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
};
const token = () => randomBytes(32).toString("hex");

function currentUser(req) {
  const value = req.headers.authorization || "";
  const session = sessions.get(value.replace(/^Bearer\s+/i, ""));
  if (!session) return null;
  return json(usersFile).find((user) => user.id === session.userId) || null;
}

function catalog() {
  return json(join(root, "clips.json"));
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/clips") {
    const user = currentUser(req);
    const requestedLevel = String(url.searchParams.get("level") || "").toUpperCase();
    const allowedLevels = { A1: ["A1"], A2: ["A1", "A2"], B1: ["B1", "B2"], B2: ["B2", "C1"], C1: ["C1"] };
    const levels = allowedLevels[user?.level || requestedLevel] || null;
    return send(res, 200, {
      clips: levels ? catalog().filter((clip) => levels.includes(clip.level)) : catalog(),
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

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = String(body.name || "").trim();
    if (!name || !email.includes("@") || password.length < 8) {
      return send(res, 400, { error: "Ad, geçerli e-posta ve en az 8 karakterli şifre gerekli." });
    }
    const users = json(usersFile);
    if (users.some((user) => user.email === email)) return send(res, 409, { error: "Bu e-posta zaten kayıtlı." });
    const user = { id: randomBytes(12).toString("hex"), name, email, passwordHash: hashPassword(password), level: null, createdAt: new Date().toISOString() };
    users.push(user);
    saveUsers(users);
    const sessionToken = token();
    sessions.set(sessionToken, { userId: user.id });
    return send(res, 201, { token: sessionToken, user: publicUser(user) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(req);
    const user = json(usersFile).find((item) => item.email === String(body.email || "").trim().toLowerCase());
    if (!user || !validPassword(String(body.password || ""), user.passwordHash)) {
      return send(res, 401, { error: "E-posta veya şifre hatalı." });
    }
    const sessionToken = token();
    sessions.set(sessionToken, { userId: user.id });
    return send(res, 200, { token: sessionToken, user: publicUser(user) });
  }

  if (req.method === "POST" && url.pathname === "/api/profile/level") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Giriş yapmalısın." });
    const level = String((await readBody(req)).level || "").toUpperCase();
    if (!["A1", "A2", "B1", "B2", "C1"].includes(level)) return send(res, 400, { error: "Geçersiz seviye." });
    const users = json(usersFile);
    const index = users.findIndex((item) => item.id === user.id);
    users[index].level = level;
    saveUsers(users);
    return send(res, 200, { user: publicUser(users[index]) });
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
  if (!existsSync(file)) return send(res, 404, { error: "Dosya bulunamadı." });
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
