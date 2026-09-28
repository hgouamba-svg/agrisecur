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

const SESSION_DUREE_MS = 7 * 24 * 3600 * 1000; // 7 jours

// La base ne garde que l'empreinte SHA-256 du jeton, jamais le jeton lui-même :
// une copie de la base (sauvegarde, export admin) ne permet pas d'ouvrir les
// sessions des utilisateurs.
function empreinte(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function createSession(userType, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DUREE_MS).toISOString(); // 7 jours
  db.prepare(`INSERT INTO sessions (token, user_type, user_id, expires_at) VALUES (?, ?, ?, ?)`)
    .run(empreinte(token), userType, userId, expires);
  return token;
}

function getSession(token) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const cle = empreinte(token);
  const session = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(cle);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(cle);
    return null;
  }
  return session;
}

// Déconnexion : le jeton devient immédiatement inutilisable côté serveur.
function supprimerSession(token) {
  if (typeof token === "string" && token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(empreinte(token));
}

// Révoque toutes les sessions d'un compte (changement / réinitialisation de mot de passe).
function revoquerSessions(userType, userId) {
  db.prepare(`DELETE FROM sessions WHERE user_type = ? AND user_id = ?`).run(userType, userId);
}

// Purge horaire des sessions expirées (dates ISO : comparaison lexicale valable).
function purgerSessionsExpirees() {
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(new Date().toISOString());
}
purgerSessionsExpirees();
setInterval(purgerSessionsExpirees, 3600 * 1000);

// Clé admin "temporaire" pour les actions de back-office (validation KYC,
// médiation de litige) — le temps qu'un vrai panneau d'administration avec
// ses propres comptes existe. Change tout le temps qu'on la garde par défaut.
const ADMIN_KEY_DEFAUT = "changez-cette-cle-admin";
const ADMIN_KEY_MIN = 16;
const cleAdminFournie = process.env.ADMIN_KEY || "";
const cleAdminValable = !!cleAdminFournie && cleAdminFournie !== ADMIN_KEY_DEFAUT;
// Une clé absente ou laissée à sa valeur par défaut (publique, puisqu'elle
// figure dans ce fichier) n'ouvre plus le back-office, même hors production :
// elle est remplacée par une clé aléatoire que personne ne connaît.
const ADMIN_KEY = cleAdminValable ? cleAdminFournie : crypto.randomBytes(32).toString("hex");
if (!cleAdminValable && process.env.NODE_ENV !== "production") {
  console.warn("[admin] ADMIN_KEY absente ou laissée par défaut : back-office désactivé. Définissez ADMIN_KEY pour y accéder.");
}
if (cleAdminValable && cleAdminFournie.length < ADMIN_KEY_MIN) {
  console.warn(`[admin] ADMIN_KEY fait moins de ${ADMIN_KEY_MIN} caractères : remplacez-la par une clé longue et aléatoire (ex. openssl rand -hex 24).`);
}

// Filet de sécurité : si NODE_ENV=production est réglé (à ajouter comme
// variable d'environnement sur votre hébergeur, en plus d'ADMIN_KEY) et que
// la clé est restée à sa valeur par défaut, le serveur refuse de démarrer
// plutôt que de tourner avec un accès admin ouvert à tous.
if (process.env.NODE_ENV === "production" && !cleAdminValable) {
  console.error(
    "ERREUR CRITIQUE : NODE_ENV=production est réglé mais ADMIN_KEY n'a pas été " +
    "défini (ou est resté à sa valeur par défaut). Définissez une vraie clé " +
    "secrète dans les variables d'environnement avant de redémarrer."
  );
  process.exit(1);
}

module.exports = { hashPassword, verifyPassword, createSession, getSession, supprimerSession, revoquerSessions, ADMIN_KEY };
