// db.js — connexion SQLite + schéma
//
// Utilise le module natif node:sqlite (disponible nativement depuis Node 22)
// plutôt qu'une dépendance npm externe : zéro `npm install` requis pour démarrer.
// À migrer vers PostgreSQL avant une mise en production réelle (cf. README).

const { DatabaseSync } = require("node:sqlite");
const path = require("path");

// Emplacement du fichier de base de données — réglable via DB_PATH pour
// pointer vers un volume persistant en hébergement (ex. Railway : montez un
// volume sur /app/data, puis lancez avec DB_PATH=/app/data/agrisecur.db).
// Sans cette variable, reste à côté du code comme avant (usage local).
const dbPath = process.env.DB_PATH || path.join(__dirname, "agrisecur.db");
const db = new DatabaseSync(dbPath);
console.log(`[db] Base de données : ${dbPath}`);

db.exec(`
CREATE TABLE IF NOT EXISTS sellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('producteur','gie','cooperative','transformateur')),
  localisation TEXT,
  rccm TEXT,
  email TEXT UNIQUE,
  password_hash TEXT,
  abonnement_pro_jusqua TEXT,
  vendeur_fondateur INTEGER NOT NULL DEFAULT 0,
  kyc_statut TEXT NOT NULL DEFAULT 'en_attente' CHECK(kyc_statut IN ('en_attente','valide','rejete')),
  kyc_document_identite_url TEXT,
  kyc_document_rccm_url TEXT,
  kyc_soumis_le TEXT,
  kyc_motif_rejet TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS buyers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'professionnel' CHECK(type IN ('professionnel','particulier')),
  email TEXT UNIQUE,
  password_hash TEXT,
  code_parrainage TEXT UNIQUE,
  parraine_par INTEGER REFERENCES buyers(id),
  credit_parrainage_fcfa REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  nom TEXT NOT NULL,
  filiere TEXT NOT NULL DEFAULT 'cacao',
  quantite_kg REAL NOT NULL,
  prix_unitaire_fcfa REAL NOT NULL,
  prix_avec_transport_fcfa REAL,
  mode_livraison TEXT NOT NULL DEFAULT 'acheteur' CHECK(mode_livraison IN ('acheteur','vendeur','a_convenir')),
  mis_en_avant_jusqua TEXT,
  photo_url TEXT,
  parcelle_latitude REAL,
  parcelle_longitude REAL,
  declaration_non_deforestation INTEGER NOT NULL DEFAULT 0,
  statut TEXT NOT NULL DEFAULT 'disponible' CHECK(statut IN ('disponible','reserve','vendu','retire')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  buyer_id INTEGER NOT NULL REFERENCES buyers(id),
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  quantite_kg REAL NOT NULL,
  montant_total_fcfa REAL NOT NULL,
  avec_transport INTEGER NOT NULL DEFAULT 0,
  mode_paiement TEXT NOT NULL DEFAULT 'mobile_money' CHECK(mode_paiement IN ('mobile_money','virement')),
  virement_reference TEXT,
  frais_paiement_fcfa REAL NOT NULL DEFAULT 0,
  commission_taux REAL NOT NULL DEFAULT 0.04,
  commission_fcfa REAL NOT NULL,
  montant_net_vendeur_fcfa REAL NOT NULL,
  statut TEXT NOT NULL DEFAULT 'sequestre' CHECK(statut IN (
    'attente_virement','sequestre','expedie','en_controle','litige','cloture','rembourse'
  )),
  delai_contestation_heures INTEGER NOT NULL DEFAULT 48,
  delai_livraison_estime_jours INTEGER NOT NULL DEFAULT 3,
  photo_expedition_url TEXT,
  photo_reclamation_url TEXT,
  reference_paiement_agregateur TEXT,
  reference_reversement_agregateur TEXT,
  expedie_at TEXT,
  controle_ouvert_at TEXT,
  cloture_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Revenus liés aux services à valeur ajoutée (SVA) : mise en avant de lots,
-- abonnement Vendeur Pro. Pas encore relié à un vrai paiement (cf. README) —
-- sert de journal comptable pour suivre ce que ces services rapportent
-- réellement une fois activés.
-- Configuration applicative persistante (ex. date de lancement de la promo
-- fondateur), pour survivre aux redémarrages du serveur.
CREATE TABLE IF NOT EXISTS app_config (
  cle TEXT PRIMARY KEY,
  valeur TEXT NOT NULL
);

-- Suivi léger des dépenses opérationnelles (hébergement, marketing, etc.)
-- Ne remplace pas une vraie comptabilité SYSCOHADA — sert de journal interne
-- et de base d'export pour votre comptable.
-- Signalements des utilisateurs (bug rencontré, suggestion, ou problème de
-- connexion) — remontés directement au back-office pour un suivi rapide,
-- sans dépendre d'un canal externe (WhatsApp, email) pour être vus.
CREATE TABLE IF NOT EXISTS signalements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('bug','suggestion','connexion')),
  description TEXT NOT NULL,
  contexte TEXT,
  contact TEXT,
  user_type TEXT,
  user_id INTEGER,
  statut TEXT NOT NULL DEFAULT 'nouveau' CHECK(statut IN ('nouveau','en_cours','resolu')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS depenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  categorie TEXT NOT NULL,
  description TEXT,
  montant_fcfa REAL NOT NULL,
  date_depense TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sva_achats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  type TEXT NOT NULL CHECK(type IN ('boost','abonnement_pro')),
  description TEXT,
  montant_fcfa REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Parrainages acheteurs : trace chaque récompense versée pour éviter tout
-- double crédit, et sert de journal pour le suivi du programme.
CREATE TABLE IF NOT EXISTS parrainages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parrain_id INTEGER NOT NULL REFERENCES buyers(id),
  filleul_id INTEGER NOT NULL REFERENCES buyers(id) UNIQUE,
  montant_credit_fcfa REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;

// ---- Migration légère pour les bases créées avant l'authentification ----
// (utile si vous aviez déjà lancé une version antérieure du MVP en local)
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("sellers", "email", "TEXT");
ensureColumn("sellers", "password_hash", "TEXT");
ensureColumn("buyers", "email", "TEXT");
ensureColumn("buyers", "password_hash", "TEXT");
ensureColumn("buyers", "code_parrainage", "TEXT");
ensureColumn("buyers", "parraine_par", "INTEGER");
ensureColumn("buyers", "credit_parrainage_fcfa", "REAL DEFAULT 0");
ensureColumn("products", "mode_livraison", "TEXT DEFAULT 'acheteur'");
ensureColumn("products", "prix_avec_transport_fcfa", "REAL");
ensureColumn("products", "mis_en_avant_jusqua", "TEXT");
ensureColumn("products", "photo_url", "TEXT");
ensureColumn("products", "parcelle_latitude", "REAL");
ensureColumn("products", "parcelle_longitude", "REAL");
ensureColumn("products", "declaration_non_deforestation", "INTEGER DEFAULT 0");
ensureColumn("sellers", "abonnement_pro_jusqua", "TEXT");
ensureColumn("sellers", "vendeur_fondateur", "INTEGER DEFAULT 0");
ensureColumn("sellers", "kyc_document_identite_url", "TEXT");
ensureColumn("sellers", "kyc_document_rccm_url", "TEXT");
ensureColumn("sellers", "kyc_soumis_le", "TEXT");
ensureColumn("sellers", "kyc_motif_rejet", "TEXT");
ensureColumn("orders", "avec_transport", "INTEGER DEFAULT 0");
ensureColumn("orders", "mode_paiement", "TEXT DEFAULT 'mobile_money'");
ensureColumn("orders", "virement_reference", "TEXT");
ensureColumn("orders", "frais_paiement_fcfa", "REAL DEFAULT 0");
ensureColumn("orders", "delai_livraison_estime_jours", "INTEGER DEFAULT 3");
ensureColumn("orders", "photo_expedition_url", "TEXT");
ensureColumn("orders", "photo_reclamation_url", "TEXT");
ensureColumn("orders", "reference_paiement_agregateur", "TEXT");
ensureColumn("orders", "reference_reversement_agregateur", "TEXT");
