// auth.js — hachage de mot de passe + sessions par jeton, sans dépendance
// externe (module natif "crypto"). Suffisant pour un pilote ; à durcir
// (expiration plus courte, rotation, rate-limiting) avant une vraie mise en
// production à grande échelle.

const crypto = require("crypto");
const db = require("./db");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_type TEXT NOT NULL CHECK(user_type IN ('seller','buyer')),
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
`);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  // comparaison à temps constant pour limiter les attaques par timing
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

function createSession(userType, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(); // 30 jours
  db.prepare(`INSERT INTO sessions (token, user_type, user_id, expires_at) VALUES (?, ?, ?, ?)`)
    .run(token, userType, userId, expires);
  return token;
}

function getSession(token) {
  const session = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  return session;
}

// Clé admin "temporaire" pour les actions de back-office (validation KYC,
// médiation de litige) — le temps qu'un vrai panneau d'administration avec
// ses propres comptes existe. Change tout le temps qu'on la garde par défaut.
const ADMIN_KEY = process.env.ADMIN_KEY || "changez-cette-cle-admin";

module.exports = { hashPassword, verifyPassword, createSession, getSession, ADMIN_KEY };
