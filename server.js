// server.js — API AgriSecur MVP (filière cacao, V1)
//
// Portée volontairement réduite, conformément à la priorisation V1 du cahier
// des charges : catalogue + tunnel séquestre + KYC de base. Pas d'espace
// vendeur enrichi, pas de paiement réel branché (cf. README pour la suite).
//
// Écrit sans dépendance npm externe (http natif + node:sqlite) pour tourner
// sans `npm install`, y compris hors-ligne.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { envoyerEmail } = require("./mailer");
const { router, match } = require("./router");
const payments = require("./payments");
const { genererBonCommandePDF } = require("./pdf");
const { envoyerBonCommandeParEmail } = require("./email");
const { hashPassword, verifyPassword, createSession, getSession, supprimerSession, revoquerSessions, ADMIN_KEY } = require("./auth");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "video/mp4" };

function serveStatic(req, res, pathname) {
  const filePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) return false; // anti path-traversal
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) return false;
  const ext = path.extname(fullPath);
  // Pages, scripts et styles : toujours revalidés, pour que chaque mise à jour
  // du site soit visible tout de suite. Images et polices : cache d'un jour.
  const frais = [".html", ".js", ".css", ".webmanifest", ".json"].includes(ext);
  const entetes = { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": frais ? "no-cache" : "public, max-age=86400" };
  // Sons et vidéos : lecture par morceaux (Range), indispensable à Safari et à
  // l'iPhone pour lire une vidéo, et diffusés en flux plutôt que chargés en mémoire.
  if (ext === ".mp4" || ext === ".mp3") {
    const taille = fs.statSync(fullPath).size;
    entetes["Accept-Ranges"] = "bytes";
    const plage = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (plage && (plage[1] || plage[2])) {
      let debut = plage[1] ? parseInt(plage[1], 10) : taille - parseInt(plage[2], 10);
      let fin = plage[1] && plage[2] ? parseInt(plage[2], 10) : taille - 1;
      debut = Math.max(0, debut); fin = Math.min(fin, taille - 1);
      if (debut > fin) {
        res.writeHead(416, { "Content-Range": `bytes */${taille}` });
        res.end();
        return true;
      }
      res.writeHead(206, { ...entetes, "Content-Range": `bytes ${debut}-${fin}/${taille}`, "Content-Length": fin - debut + 1 });
      fs.createReadStream(fullPath, { start: debut, end: fin }).pipe(res);
      return true;
    }
    res.writeHead(200, { ...entetes, "Content-Length": taille });
    fs.createReadStream(fullPath).pipe(res);
    return true;
  }
  res.writeHead(200, entetes);
  res.end(fs.readFileSync(fullPath));
  return true;
}

// App « AgriSecur Admin » (back-office) : fichiers rangés dans admin/, hors
// de public/, et servis uniquement à ces deux adresses. Non indexée, jamais
// mise en cache : le site public ne contient ni lien ni code admin.
const ADMIN_DIR = path.join(__dirname, "admin");
const FICHIERS_APP_ADMIN = {
  "/admin": ["index.html", "text/html; charset=utf-8"],
  "/admin/": ["index.html", "text/html; charset=utf-8"],
  "/admin.webmanifest": ["admin.webmanifest", "application/manifest+json"],
};
function servirAppAdmin(res, pathname) {
  const [fichier, type] = FICHIERS_APP_ADMIN[pathname];
  res.writeHead(200, { "Content-Type": type, "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" });
  res.end(fs.readFileSync(path.join(ADMIN_DIR, fichier)));
}

// Extrait le jeton "Authorization: Bearer xxx" et résout la session.
// Renvoie null si absent/invalide — chaque route décide si c'est bloquant.
function getAuth(req) {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const session = getSession(token);
  if (!session) return null;
  return { type: session.user_type, id: session.user_id };
}

// Comparaison à temps constant (empreintes SHA-256 de même longueur) pour ne
// pas laisser deviner la clé admin caractère par caractère via le timing.
function isAdmin(req) {
  const fournie = req.headers["x-admin-key"];
  if (typeof fournie !== "string" || !fournie) return false;
  const a = crypto.createHash("sha256").update(fournie).digest();
  const b = crypto.createHash("sha256").update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

function isAdminAvecLimite(req, res) {
  if (isAdmin(req)) {
    reinitialiserTentatives(req, "admin");
    return true;
  }
  if (!limiterTentatives(req, res, "admin")) return false; // réponse 429 déjà envoyée
  send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  return false;
}

// Variante pour les routes mixtes (utilisées à la fois par l'admin et par de
// simples vendeurs/acheteurs, ex. GET /api/orders). Ne compte comme
// "tentative" que si une clé admin a été fournie et qu'elle est fausse —
// son absence pure et simple est le cas normal d'un utilisateur classique,
// et ne doit jamais faire compter/bloquer sur le rate-limit admin.
// Renvoie : true (admin confirmé) ; false (pas admin, l'appelant retombe sur
// sa logique normale) ; "blocked" (429 déjà envoyé, l'appelant doit arrêter
// immédiatement sans rien renvoyer d'autre).
function estAdminSansBloquerFlux(req, res) {
  if (!req.headers["x-admin-key"]) return false;
  if (isAdmin(req)) {
    reinitialiserTentatives(req, "admin");
    return true;
  }
  if (!limiterTentatives(req, res, "admin")) return "blocked"; // 429 déjà envoyé
  return false;
}

// ---------- Anti brute-force (rate-limiting) ----------
// Protège les points d'entrée sensibles (connexion, admin, changement de mot
// de passe) contre les tentatives répétées. Compteur en mémoire, par IP —
// suffisant pour un serveur mono-instance ; à remplacer par Redis/base
// partagée si vous passez un jour à plusieurs réplicas.
const RATE_LIMIT_MAX = 5;          // tentatives autorisées
const RATE_LIMIT_FENETRE_MS = 15 * 60 * 1000;  // fenêtre de 15 minutes
const rateLimitStore = new Map();  // clé "ip:route" -> { count, premiereTentative }

// Derrière un proxy (Fly, Railway, Caddy), req.socket.remoteAddress ne donne
// que l'adresse du proxy. On ne fait confiance qu'aux en-têtes posés par le
// proxy lui-même : Fly-Client-IP sur Fly.io, sinon (TRUST_PROXY=1) la DERNIÈRE
// entrée de X-Forwarded-For, ajoutée par le proxy — la première est fournie
// par le client et donc falsifiable. Sans TRUST_PROXY, on voit l'IP du proxy.
function getClientIp(req) {
  const fly = req.headers["fly-client-ip"];
  if (fly && process.env.FLY_APP_NAME) return String(fly).trim();
  // Derrière un proxy (Railway, Caddy local…), la connexion vient d'une adresse
  // privée : on prend alors la DERNIÈRE entrée de X-Forwarded-For, ajoutée par
  // le proxy lui-même (les premières peuvent être falsifiées par le client).
  const distant = String(req.socket.remoteAddress || "");
  const viaProxyPrive = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)|^::1$|^f[cd]/i.test(distant);
  if (process.env.TRUST_PROXY === "1" || viaProxyPrive) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) {
      const derniere = String(fwd).split(",").pop().trim();
      if (derniere) return derniere;
    }
  }
  return req.socket.remoteAddress || "inconnu";
}

// options.parIp=false : compteur global sur la clé (ex. par email), quelle que soit l'IP.
function limiterTentatives(req, res, cle, options = {}) {
  const key = options.parIp === false ? cle : `${getClientIp(req)}:${cle}`;
  const max = options.max || RATE_LIMIT_MAX;
  const maintenant = Date.now();
  const entree = rateLimitStore.get(key);

  if (entree && maintenant - entree.premiereTentative < RATE_LIMIT_FENETRE_MS) {
    if (entree.count >= max) {
      const attenteMin = Math.ceil((RATE_LIMIT_FENETRE_MS - (maintenant - entree.premiereTentative)) / 60000);
      send(res, 429, { error: `Trop de tentatives. Réessayez dans ${attenteMin} minute${attenteMin > 1 ? "s" : ""}.` });
      return false;
    }
    entree.count++;
  } else {
    rateLimitStore.set(key, { count: 1, premiereTentative: maintenant });
  }
  return true;
}

function reinitialiserTentatives(req, cle, options = {}) {
  rateLimitStore.delete(options.parIp === false ? cle : `${getClientIp(req)}:${cle}`);
}

// Purge périodique pour ne pas accumuler indéfiniment des entrées expirées en mémoire
setInterval(() => {
  const maintenant = Date.now();
  for (const [key, entree] of rateLimitStore) {
    if (maintenant - entree.premiereTentative > RATE_LIMIT_FENETRE_MS) rateLimitStore.delete(key);
  }
}, 10 * 60 * 1000);

const COMMISSION_TAUX = 0.04; // Article 6 des CGU/CGV — 4% HT flat

// Frais de traitement des paiements, estimés — à ajuster dès que les vrais
// tarifs sont négociés avec l'agrégateur (mobile money) et la banque
// (virement). Réglables sans toucher au code via variables d'environnement :
//   MOBILE_MONEY_FRAIS_TAUX=0.025 VIREMENT_FRAIS_FCFA=5000 node server.js
const MOBILE_MONEY_FRAIS_TAUX = Number(process.env.MOBILE_MONEY_FRAIS_TAUX || 0.025); // % du montant, estimation de marché
const VIREMENT_FRAIS_FCFA = Number(process.env.VIREMENT_FRAIS_FCFA || 5000); // frais fixe par virement, valeur provisoire

// Promotion de lancement — commission réduite pour les tout premiers
// vendeurs, pour construire du volume face à un concurrent déjà installé.
// Réversible et daté, contrairement à un changement de tarif permanent :
//   PROMO_ACTIVE=true node server.js    → réactive la promo (désactivée par défaut depuis le 26/09/2026)
//   PROMO_SEUIL_VENDEURS=50 PROMO_COMMISSION_TAUX=0 node server.js
const PROMO_ACTIVE = process.env.PROMO_ACTIVE === "true"; // désactivée par défaut
const PROMO_SEUIL_VENDEURS = Number(process.env.PROMO_SEUIL_VENDEURS || 100);
const PROMO_COMMISSION_TAUX = Number(process.env.PROMO_COMMISSION_TAUX || 0.02);
const PROMO_JOURS_LIMITE = Number(process.env.PROMO_JOURS_LIMITE || 60);

// Date de lancement de la promo — fixée une seule fois (première exécution),
// puis conservée en base pour ne pas repartir de zéro à chaque redémarrage.
let promoDebut = db.prepare(`SELECT valeur FROM app_config WHERE cle = 'promo_debut'`).get();
if (!promoDebut) {
  const maintenant = new Date().toISOString();
  db.prepare(`INSERT INTO app_config (cle, valeur) VALUES ('promo_debut', ?)`).run(maintenant);
  promoDebut = { valeur: maintenant };
}
const PROMO_DATE_DEBUT = new Date(promoDebut.valeur);

function promoEnrolementOuvert() {
  if (!PROMO_ACTIVE) return false;
  const joursEcoules = (Date.now() - PROMO_DATE_DEBUT.getTime()) / (1000 * 3600 * 24);
  if (joursEcoules >= PROMO_JOURS_LIMITE) return false;
  const nbVendeurs = db.prepare(`SELECT COUNT(*) AS n FROM sellers WHERE vendeur_fondateur = 1`).get().n;
  return nbVendeurs < PROMO_SEUIL_VENDEURS;
}

// Parrainage acheteurs — récompense versée au parrain quand son filleul
// clôture son tout premier achat. Appliqué automatiquement en réduction des
// frais mobile money de la commande suivante du parrain.
const REFERRAL_CREDIT_FCFA = Number(process.env.REFERRAL_CREDIT_FCFA || 5000);

// Estimation fiscale — régime Microentreprises (5-50M FCFA de CA), taxe
// unique sur le chiffre d'affaires qui remplace IS/TVA/patente. À CONFIRMER
// avec un comptable ivoirien : l'assiette fiscale d'AgriSecur devrait être
// la commission encaissée (pas le volume total des transactions séquestrées,
// dont vous n'êtes qu'intermédiaire) — hypothèse retenue ici, pas garantie.
const TAUX_IMPOT_ESTIME = Number(process.env.TAUX_IMPOT_ESTIME || 0.05);

// Tarifs SVA (services à valeur ajoutée) — pas encore reliés à un vrai
// paiement, cf. README. Enregistrés dans sva_achats pour suivi comptable réel.
const BOOST_TARIFS = { 3: 5000, 7: 9000, 14: 15000 }; // jours -> FCFA
const ABONNEMENT_PRO_FCFA = 10000; // par mois
const ABONNEMENT_PRO_DUREE_JOURS = 30;

// Coordonnées de paiement affichées au vendeur pour régler un Boost ou un
// abonnement Pro. Réglables sans toucher au code (variables d'environnement).
// Tant qu'aucun paiement en ligne n'est branché, le vendeur paie par Mobile
// Money ou virement, puis le back-office confirme la réception.
const SVA_PAIEMENT_MOMO = process.env.SVA_PAIEMENT_MOMO || ""; // ex. "+225 07 00 00 00 00 (Wave / Orange Money)"
const SVA_PAIEMENT_INFO = process.env.SVA_PAIEMENT_INFO || ""; // ex. "Virement : IBAN CI... — libellé = la référence"
const SVA_WHATSAPP = process.env.SVA_WHATSAPP || "33745984195";

function instructionsPaiementSva(reference, montant) {
  const lignes = [];
  if (SVA_PAIEMENT_MOMO) lignes.push(`Mobile Money : ${SVA_PAIEMENT_MOMO}`);
  if (SVA_PAIEMENT_INFO) lignes.push(SVA_PAIEMENT_INFO);
  lignes.push("Le paiement est encaissé sur un compte au nom d'AgriSecur SARL.");
  lignes.push(`Indiquez la référence « ${reference} » lors du paiement, puis prévenez-nous sur WhatsApp (+${SVA_WHATSAPP}). Votre avantage est activé dès que le paiement est confirmé.`);
  return { reference, montant_fcfa: montant, whatsapp: SVA_WHATSAPP, momo: SVA_PAIEMENT_MOMO || null, details: lignes.join("\n") };
}

// ---------- Analyse satellite de risque de déforestation (WHISP / FAO) ----------
// API publique WHISP (Forest Data Partnership / FAO) : whisp.openforis.org.
// Fournit une INDICATION automatisée de risque basée sur des données
// satellite publiques, PAS une certification de conformité RDUE. Le badge
// affiché au public doit toujours refléter cette nuance.
//
// Format vérifié sur le code source officiel (github.com/forestdatapartnership/whisp-app) :
//   - toutes les réponses sont une enveloppe { code, message, data }
//   - POST /submit/geojson  → code "analysis_queued" + data.token (mode async)
//                             ou "analysis_completed" + data = FeatureCollection
//   - GET  /status/{token}  → "analysis_queued" / "analysis_processing" (en cours),
//                             "analysis_completed" + data = FeatureCollection,
//                             sinon erreur (analysis_error, analysis_timeout, ...)
//   - le niveau de risque est dans features[0].properties :
//       risk_pcrop (cultures pérennes : cacao, café, anacarde, hévéa, palmier)
//       risk_acrop (cultures annuelles), valeurs "low" / "high" / "more_info_needed"
const WHISP_API_KEY = process.env.WHISP_API_KEY || null;
const WHISP_API_BASE = process.env.WHISP_API_BASE || "https://whisp.openforis.org/api";
const WHISP_ACTIF = !!WHISP_API_KEY;
const WHISP_EN_COURS = ["analysis_queued", "analysis_processing"];
const FILIERES_PERENNES = ["cacao", "cafe", "anacarde", "hevea", "palmier", "fruits"];

if (!WHISP_ACTIF) {
  console.log("[whisp] WHISP_API_KEY non définie — vérification satellite désactivée.");
}

// Outil d'Audit RDUE express (back-office) : contrôle des fichiers de parcelles
// des coopératives + analyse WHISP groupée. Voir audit.js.
require("./audit")({ router, db, send, isAdminAvecLimite, limiterTentatives, envoyerEmail, whispKey: WHISP_API_KEY, whispBase: WHISP_API_BASE });

async function lireEnveloppeWhisp(res) {
  const texte = await res.text().catch(() => "");
  try { return JSON.parse(texte); } catch { return { code: null, message: texte.slice(0, 300) }; }
}

// Renvoie { token } si l'analyse est en file d'attente, ou { resultat } si
// WHISP a répondu immédiatement.
async function soumettreAnalyseWhisp(lat, lng) {
  const res = await fetch(`${WHISP_API_BASE}/submit/geojson`, {
    method: "POST",
    headers: { "x-api-key": WHISP_API_KEY, "Content-Type": "application/json", "x-whisp-agent": "agrisecur" },
    body: JSON.stringify({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: {} }], // GeoJSON : [longitude, latitude]
      analysisOptions: { nationalCodes: ["ci"], async: true },
    }),
  });
  const env = await lireEnveloppeWhisp(res);
  if (env.code === "analysis_completed") return { resultat: env.data };
  if (WHISP_EN_COURS.includes(env.code) && env.data && env.data.token) return { token: env.data.token };
  throw new Error(`WHISP submit a échoué (${res.status} ${env.code || ""}) : ${env.message || ""}`);
}

// Renvoie { termine: bool, erreur: bool, resultat: FeatureCollection|null }
async function verifierStatutWhisp(token) {
  const res = await fetch(`${WHISP_API_BASE}/status/${encodeURIComponent(token)}`, {
    headers: { "x-api-key": WHISP_API_KEY, "x-whisp-agent": "agrisecur" },
  });
  const env = await lireEnveloppeWhisp(res);
  if (WHISP_EN_COURS.includes(env.code)) return { termine: false, erreur: false, resultat: null };
  if (env.code === "analysis_completed") return { termine: true, erreur: false, resultat: env.data };
  console.error(`[whisp] job ${token} en échec (${res.status} ${env.code}) : ${env.message || ""}`);
  return { termine: true, erreur: true, resultat: null };
}

function extraireNiveauRisque(resultat, filiere) {
  const props = resultat?.features?.[0]?.properties;
  if (!props) return "indetermine";
  const cles = FILIERES_PERENNES.includes(filiere)
    ? ["risk_pcrop", "risk_acrop"]
    : ["risk_acrop", "risk_pcrop"];
  let brut = null;
  for (const cle of cles) if (props[cle]) { brut = String(props[cle]).toLowerCase(); break; }
  if (!brut) {
    console.error("[whisp] niveau de risque absent de la réponse :", JSON.stringify(props).slice(0, 600));
    return "indetermine";
  }
  if (brut.includes("low")) return "faible";
  if (brut.includes("high")) return "eleve";
  return "indetermine";
}

function enregistrerResultatWhisp(product, resultat) {
  db.prepare(`
    UPDATE products SET whisp_statut = 'termine', whisp_risque = ?, whisp_verifie_le = ?, whisp_token = NULL
    WHERE id = ?
  `).run(extraireNiveauRisque(resultat, product.filiere), new Date().toISOString(), product.id);
}

function logEvent(orderId, type, detail = null) {
  db.prepare(`INSERT INTO order_events (order_id, type, detail) VALUES (?, ?, ?)`).run(orderId, type, detail);
}

function getOrder(id) {
  const order = db.prepare(`
    SELECT o.*, p.nom AS produit_nom, p.filiere AS filiere, p.mode_livraison AS mode_livraison,
      s.nom AS vendeur_nom, b.nom AS acheteur_nom
    FROM orders o
    JOIN products p ON p.id = o.product_id
    JOIN sellers s ON s.id = o.seller_id
    JOIN buyers b ON b.id = o.buyer_id
    WHERE o.id = ?
  `).get(id);
  if (!order) return null;
  const events = db.prepare(`SELECT * FROM order_events WHERE order_id = ? ORDER BY id ASC`).all(id);
  return { ...order, events };
}

// ---------- Authentification ----------

const MOT_DE_PASSE_MIN = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TYPES_VENDEUR = ["producteur", "gie", "cooperative", "transformateur"];
const TYPES_ACHETEUR = ["professionnel", "particulier"];

// Champ texte facultatif (vide accepté) ou obligatoire, borné en longueur.
function texteValide(v, max, requis) {
  if (v === undefined || v === null || v === "") return !requis;
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

// Contrôles communs aux deux inscriptions — renvoie un message d'erreur ou null.
function erreurInscription({ nom, email, password }) {
  if (!texteValide(nom, 120, true)) return "nom invalide (120 caractères max)";
  if (typeof email !== "string" || email.length > 254 || !EMAIL_REGEX.test(email)) return "adresse email invalide";
  if (typeof password !== "string" || password.length < MOT_DE_PASSE_MIN || password.length > 256) {
    return `le mot de passe doit faire au moins ${MOT_DE_PASSE_MIN} caractères`;
  }
  return null;
}

router.post("/api/auth/register-seller", (req, res, params, body) => {
  if (!limiterTentatives(req, res, "inscription", { max: 10 })) return;
  const { nom, type, localisation, rccm, email, password } = body;
  if (!nom || !type || !email || !password) return send(res, 400, { error: "nom, type, email, password requis" });
  const erreur = erreurInscription(body);
  if (erreur) return send(res, 400, { error: erreur });
  if (!TYPES_VENDEUR.includes(type)) return send(res, 400, { error: "type de vendeur invalide" });
  if (!texteValide(localisation, 120, false)) return send(res, 400, { error: "localisation invalide (120 caractères max)" });
  if (!texteValide(rccm, 60, false)) return send(res, 400, { error: "numéro RCCM invalide (60 caractères max)" });
  const existing = db.prepare(`SELECT id FROM sellers WHERE email = ?`).get(email);
  if (existing) return send(res, 409, { error: "un compte vendeur existe déjà avec cet email" });

  const estFondateur = promoEnrolementOuvert() ? 1 : 0;

  const info = db.prepare(
    `INSERT INTO sellers (nom, type, localisation, rccm, email, password_hash, vendeur_fondateur) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(nom, type, localisation || null, rccm || null, email, hashPassword(password), estFondateur);
  const seller = db.prepare(`SELECT id, nom, type, localisation, rccm, email, kyc_statut, kyc_document_identite_url, kyc_document_rccm_url, kyc_soumis_le, kyc_motif_rejet, abonnement_pro_jusqua, vendeur_fondateur, created_at FROM sellers WHERE id = ?`).get(info.lastInsertRowid);
  const token = createSession("seller", seller.id);
  send(res, 201, { token, user: seller });
});

// Seules des images encodées en base64 (png/jpeg/webp) sont acceptées : pas de
// SVG, pas d'URL arbitraire, pas de caractère pouvant sortir d'un attribut HTML.
const PHOTO_REGEX = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
function photoValide(dataUrl) {
  return typeof dataUrl === "string" && dataUrl.length <= 900000 && PHOTO_REGEX.test(dataUrl);
}

// node:sqlite (contrairement à better-sqlite3) n'a pas de méthode
// .transaction() intégrée — on l'implémente à la main avec BEGIN/COMMIT/
// ROLLBACK. Protège les opérations financières à plusieurs étapes (ex.
// déduction d'un crédit de parrainage + création de la commande) contre un
// état incohérent si le serveur s'interrompt en plein milieu.
function executerEnTransaction(fn) {
  db.exec("BEGIN");
  try {
    const resultat = fn();
    db.exec("COMMIT");
    return resultat;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function genererCodeParrainage() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  } while (db.prepare(`SELECT 1 FROM buyers WHERE code_parrainage = ?`).get(code));
  return code;
}

router.post("/api/auth/register-buyer", (req, res, params, body) => {
  if (!limiterTentatives(req, res, "inscription", { max: 10 })) return;
  const { nom, type, email, password, code_parrainage_saisi } = body;
  if (!nom || !email || !password) return send(res, 400, { error: "nom, email, password requis" });
  const erreur = erreurInscription(body);
  if (erreur) return send(res, 400, { error: erreur });
  if (type && !TYPES_ACHETEUR.includes(type)) return send(res, 400, { error: "type d'acheteur invalide" });
  if (code_parrainage_saisi && typeof code_parrainage_saisi !== "string") return send(res, 400, { error: "code de parrainage invalide" });
  const existing = db.prepare(`SELECT id FROM buyers WHERE email = ?`).get(email);
  if (existing) return send(res, 409, { error: "un compte acheteur existe déjà avec cet email" });

  let parrainId = null;
  if (code_parrainage_saisi) {
    const parrain = db.prepare(`SELECT id FROM buyers WHERE code_parrainage = ?`).get(code_parrainage_saisi.trim().toUpperCase());
    if (!parrain) return send(res, 400, { error: "code de parrainage invalide" });
    parrainId = parrain.id;
  }

  const monCode = genererCodeParrainage();
  const info = db.prepare(
    `INSERT INTO buyers (nom, type, email, password_hash, code_parrainage, parraine_par) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(nom, type || "professionnel", email, hashPassword(password), monCode, parrainId);
  const buyer = db.prepare(`SELECT id, nom, type, email, code_parrainage, parraine_par, credit_parrainage_fcfa, created_at FROM buyers WHERE id = ?`).get(info.lastInsertRowid);
  const token = createSession("buyer", buyer.id);
  send(res, 201, { token, user: buyer });
});

router.post("/api/auth/login", (req, res, params, body) => {
  if (!limiterTentatives(req, res, "login")) return;
  const { role, email, password } = body;
  if (!["seller", "buyer"].includes(role) || !email || !password) return send(res, 400, { error: "role, email, password requis" });
  if (typeof email !== "string" || typeof password !== "string") return send(res, 400, { error: "role, email, password requis" });
  // Second compteur par compte visé (toutes IP confondues) : freine le
  // brute-force distribué sur un même email.
  const cleEmail = `login-email:${role}:${email.trim().toLowerCase()}`;
  if (!limiterTentatives(req, res, cleEmail, { parIp: false, max: 10 })) return;
  const table = role === "seller" ? "sellers" : "buyers";
  const user = db.prepare(`SELECT * FROM ${table} WHERE email = ?`).get(email);
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    return send(res, 401, { error: "identifiants invalides" });
  }
  reinitialiserTentatives(req, "login"); // connexion réussie : on repart à zéro
  reinitialiserTentatives(req, cleEmail, { parIp: false });
  const token = createSession(role, user.id);
  delete user.password_hash;
  send(res, 200, { token, user });
});

router.post("/api/auth/change-password", (req, res, params, body) => {
  const auth = getAuth(req);
  if (!auth) return send(res, 401, { error: "connexion requise" });
  if (!limiterTentatives(req, res, "change-password")) return;
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) return send(res, 400, { error: "mot de passe actuel et nouveau mot de passe requis" });
  if (typeof newPassword !== "string" || typeof currentPassword !== "string") return send(res, 400, { error: "mot de passe actuel et nouveau mot de passe requis" });
  if (newPassword.length < MOT_DE_PASSE_MIN || newPassword.length > 256) return send(res, 400, { error: `le nouveau mot de passe doit faire au moins ${MOT_DE_PASSE_MIN} caractères` });

  const table = auth.type === "seller" ? "sellers" : "buyers";
  const user = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(auth.id);
  if (!user.password_hash || !verifyPassword(currentPassword, user.password_hash)) {
    return send(res, 401, { error: "mot de passe actuel incorrect" });
  }
  reinitialiserTentatives(req, "change-password");
  db.prepare(`UPDATE ${table} SET password_hash = ? WHERE id = ?`).run(hashPassword(newPassword), auth.id);
  // Déconnecte toutes les autres sessions (appareil perdu, mot de passe
  // compromis) et renvoie un jeton neuf pour l'appareil courant.
  revoquerSessions(auth.type, auth.id);
  send(res, 200, { ok: true, token: createSession(auth.type, auth.id) });
});

router.post("/api/auth/logout", (req, res) => {
  const header = req.headers["authorization"];
  if (header && header.startsWith("Bearer ")) supprimerSession(header.slice(7));
  send(res, 200, { ok: true });
});

// ---------- Vendeurs (KYC) ----------


router.post("/api/sellers/:id/kyc", (req, res, params, body) => {
  if (!isAdminAvecLimite(req, res)) return;
  const { statut, motif_rejet } = body;
  if (!["valide", "rejete"].includes(statut)) return send(res, 400, { error: "statut invalide" });
  if (statut === "rejete" && !motif_rejet) return send(res, 400, { error: "un motif de rejet est requis, pour que le vendeur sache quoi corriger" });
  db.prepare(`UPDATE sellers SET kyc_statut = ?, kyc_motif_rejet = ? WHERE id = ?`).run(statut, statut === "rejete" ? motif_rejet : null, params.id);
  send(res, 200, db.prepare(`SELECT id, nom, type, localisation, kyc_statut, kyc_motif_rejet FROM sellers WHERE id = ?`).get(params.id));
});

router.post("/api/sellers/me/kyc-documents", (req, res, params, body) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  const { document_identite_url, document_rccm_url } = body;
  if (!document_identite_url) return send(res, 400, { error: "la pièce d'identité (ou attestation de coopérative) est obligatoire" });
  if (!photoValide(document_identite_url)) return send(res, 400, { error: "document d'identité invalide ou trop volumineux (compressez avant envoi)" });
  if (document_rccm_url && !photoValide(document_rccm_url)) return send(res, 400, { error: "document RCCM invalide ou trop volumineux (compressez avant envoi)" });

  const seller = db.prepare(`SELECT kyc_statut FROM sellers WHERE id = ?`).get(auth.id);
  // Un nouveau dépôt de documents relance l'examen si le dossier avait été rejeté
  const nouveauStatut = seller.kyc_statut === "rejete" ? "en_attente" : seller.kyc_statut;

  db.prepare(`
    UPDATE sellers SET kyc_document_identite_url = ?, kyc_document_rccm_url = ?, kyc_soumis_le = ?, kyc_statut = ?
    WHERE id = ?
  `).run(document_identite_url, document_rccm_url || null, new Date().toISOString(), nouveauStatut, auth.id);

  send(res, 200, { ok: true, kyc_statut: nouveauStatut });
});

router.get("/api/sellers/me", (req, res) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  const seller = db.prepare(`SELECT id, nom, type, localisation, rccm, email, kyc_statut, kyc_document_identite_url, kyc_document_rccm_url, kyc_soumis_le, kyc_motif_rejet, abonnement_pro_jusqua, vendeur_fondateur, created_at FROM sellers WHERE id = ?`).get(auth.id);
  const tarifFondateurActif = promoEnrolementOuvert() && seller.vendeur_fondateur;
  send(res, 200, { ...seller, taux_commission_actuel: tarifFondateurActif ? PROMO_COMMISSION_TAUX : COMMISSION_TAUX, tarif_fondateur_actif: !!tarifFondateurActif });
});

router.get("/api/buyers/me", (req, res) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "buyer") return send(res, 401, { error: "connexion acheteur requise" });
  const buyer = db.prepare(`SELECT id, nom, type, email, code_parrainage, parraine_par, credit_parrainage_fcfa, created_at FROM buyers WHERE id = ?`).get(auth.id);
  const nbFilleuls = db.prepare(`SELECT COUNT(*) AS n FROM parrainages WHERE parrain_id = ?`).get(auth.id).n;
  send(res, 200, { ...buyer, nb_filleuls_recompenses: nbFilleuls });
});

router.get("/api/sellers/:id", (req, res, params) => {
  const seller = db.prepare(`SELECT id, nom, type, localisation, kyc_statut, created_at FROM sellers WHERE id = ?`).get(params.id);
  if (!seller) return send(res, 404, { error: "vendeur introuvable" });
  send(res, 200, seller);
});

// ---------- Back-office (admin) ----------

router.get("/api/admin/sellers", (req, res) => {
  if (!isAdminAvecLimite(req, res)) return;
  send(res, 200, db.prepare(
    `SELECT id, nom, type, localisation, rccm, email, kyc_statut, kyc_document_identite_url, kyc_document_rccm_url, kyc_soumis_le, kyc_motif_rejet, created_at FROM sellers ORDER BY created_at DESC`
  ).all());
});

router.get("/api/admin/buyers", (req, res) => {
  if (!isAdminAvecLimite(req, res)) return;
  send(res, 200, db.prepare(
    `SELECT id, nom, type, email, created_at FROM buyers ORDER BY created_at DESC`
  ).all());
});

function genererMotDePasseTemporaire() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

router.post("/api/admin/sellers/:id/reset-password", (req, res, params) => {
  if (!isAdminAvecLimite(req, res)) return;
  const seller = db.prepare(`SELECT id FROM sellers WHERE id = ?`).get(params.id);
  if (!seller) return send(res, 404, { error: "vendeur introuvable" });
  const temp = genererMotDePasseTemporaire();
  db.prepare(`UPDATE sellers SET password_hash = ? WHERE id = ?`).run(hashPassword(temp), params.id);
  revoquerSessions("seller", seller.id);
  send(res, 200, { mot_de_passe_temporaire: temp });
});

router.post("/api/admin/sellers/:id/supprimer", (req, res, params, body) => {
  if (!isAdminAvecLimite(req, res)) return;
  const seller = db.prepare(`SELECT id, nom FROM sellers WHERE id = ?`).get(params.id);
  if (!seller) return send(res, 404, { error: "vendeur introuvable" });
  const force = !!(body && body.force === true);

  const nbCommandes = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE seller_id = ?`).get(params.id).n;
  if (nbCommandes > 0 && !force) {
    return send(res, 409, {
      error: `Suppression impossible : ce vendeur a ${nbCommandes} commande(s) réelle(s) — l'historique financier ne peut pas être effacé sans confirmation explicite. Une suppression forcée est possible, mais effacera aussi ces commandes définitivement.`,
      nb_commandes: nbCommandes,
    });
  }

  executerEnTransaction(() => {
    const commandeIds = db.prepare(`SELECT id FROM orders WHERE seller_id = ?`).all(params.id).map((o) => o.id);
    for (const oid of commandeIds) {
      db.prepare(`DELETE FROM order_events WHERE order_id = ?`).run(oid);
      db.prepare(`DELETE FROM avis WHERE order_id = ?`).run(oid);
    }
    db.prepare(`DELETE FROM orders WHERE seller_id = ?`).run(params.id);
    db.prepare(`DELETE FROM sva_achats WHERE seller_id = ?`).run(params.id);
    db.prepare(`DELETE FROM products WHERE seller_id = ?`).run(params.id);
    db.prepare(`DELETE FROM sessions WHERE user_type = 'seller' AND user_id = ?`).run(params.id);
    db.prepare(`DELETE FROM sellers WHERE id = ?`).run(params.id);
  });
  send(res, 200, { ok: true, supprime: seller.nom, commandes_effacees: nbCommandes });
});

router.post("/api/admin/buyers/:id/supprimer", (req, res, params, body) => {
  if (!isAdminAvecLimite(req, res)) return;
  const buyer = db.prepare(`SELECT id, nom FROM buyers WHERE id = ?`).get(params.id);
  if (!buyer) return send(res, 404, { error: "acheteur introuvable" });
  const force = !!(body && body.force === true);

  const nbCommandes = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE buyer_id = ?`).get(params.id).n;
  if (nbCommandes > 0 && !force) {
    return send(res, 409, {
      error: `Suppression impossible : cet acheteur a ${nbCommandes} commande(s) réelle(s) — l'historique financier ne peut pas être effacé sans confirmation explicite. Une suppression forcée est possible, mais effacera aussi ces commandes définitivement.`,
      nb_commandes: nbCommandes,
    });
  }
  const estLieAUnParrainage = db.prepare(`SELECT COUNT(*) AS n FROM parrainages WHERE parrain_id = ? OR filleul_id = ?`).get(params.id, params.id).n;
  if (estLieAUnParrainage > 0 && !force) {
    return send(res, 409, { error: "Suppression impossible : ce compte est lié à un programme de parrainage déjà récompensé. Une suppression forcée effacera aussi ce lien." });
  }
  const filleulsDirects = db.prepare(`SELECT COUNT(*) AS n FROM buyers WHERE parraine_par = ?`).get(params.id).n;
  if (filleulsDirects > 0 && !force) {
    return send(res, 409, { error: "Suppression impossible : d'autres comptes acheteurs ont été parrainés par celui-ci. Une suppression forcée détachera ce lien, sans supprimer ces autres comptes." });
  }

  executerEnTransaction(() => {
    const commandeIds = db.prepare(`SELECT id FROM orders WHERE buyer_id = ?`).all(params.id).map((o) => o.id);
    for (const oid of commandeIds) {
      db.prepare(`DELETE FROM order_events WHERE order_id = ?`).run(oid);
      db.prepare(`DELETE FROM avis WHERE order_id = ?`).run(oid);
    }
    db.prepare(`DELETE FROM orders WHERE buyer_id = ?`).run(params.id);
    db.prepare(`DELETE FROM parrainages WHERE parrain_id = ? OR filleul_id = ?`).run(params.id, params.id);
    db.prepare(`UPDATE buyers SET parraine_par = NULL WHERE parraine_par = ?`).run(params.id); // détache sans supprimer les comptes parrainés par celui-ci
    db.prepare(`DELETE FROM sessions WHERE user_type = 'buyer' AND user_id = ?`).run(params.id);
    db.prepare(`DELETE FROM buyers WHERE id = ?`).run(params.id);
  });
  send(res, 200, { ok: true, supprime: buyer.nom, commandes_effacees: nbCommandes });
});

router.post("/api/admin/buyers/:id/reset-password", (req, res, params) => {
  if (!isAdminAvecLimite(req, res)) return;
  const buyer = db.prepare(`SELECT id FROM buyers WHERE id = ?`).get(params.id);
  if (!buyer) return send(res, 404, { error: "acheteur introuvable" });
  const temp = genererMotDePasseTemporaire();
  db.prepare(`UPDATE buyers SET password_hash = ? WHERE id = ?`).run(hashPassword(temp), params.id);
  revoquerSessions("buyer", buyer.id);
  send(res, 200, { mot_de_passe_temporaire: temp });
});

router.get("/api/admin/virements-en-attente", (req, res) => {
  if (!isAdminAvecLimite(req, res)) return;
  const rows = db.prepare(`
    SELECT o.*, p.nom AS produit_nom, b.nom AS acheteur_nom, s.nom AS vendeur_nom
    FROM orders o
    JOIN products p ON p.id = o.product_id
    JOIN buyers b ON b.id = o.buyer_id
    JOIN sellers s ON s.id = o.seller_id
    WHERE o.statut = 'attente_virement'
    ORDER BY o.created_at ASC
  `).all();
  send(res, 200, rows);
});

router.post("/api/admin/orders/:id/confirmer-virement", (req, res, params) => {
  if (!isAdminAvecLimite(req, res)) return;
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  if (order.statut !== "attente_virement") return send(res, 409, { error: "cette commande n'est pas en attente de virement" });

  db.prepare(`UPDATE orders SET statut = 'sequestre' WHERE id = ?`).run(order.id);
  logEvent(order.id, "confirmation_virement",
    `Virement de ${order.montant_total_fcfa} FCFA confirmé reçu (réf. ${order.virement_reference}) — paiement enregistré`);
  send(res, 200, getOrder(order.id));
});

router.get("/api/admin/depenses", (req, res) => {
  if (!isAdminAvecLimite(req, res)) return;
  const rows = db.prepare(`SELECT * FROM depenses ORDER BY date_depense DESC, id DESC`).all();
  const total = db.prepare(`SELECT COALESCE(SUM(montant_fcfa),0) AS total FROM depenses`).get().total;
  send(res, 200, { depenses: rows, total_fcfa: total });
});

router.post("/api/admin/depenses", (req, res, params, body) => {
  if (!isAdminAvecLimite(req, res)) return;
  const { categorie, description, montant_fcfa, date_depense } = body;
  if (!categorie || !montant_fcfa || !date_depense) return send(res, 400, { error: "categorie, montant_fcfa, date_depense requis" });
  const info = db.prepare(`INSERT INTO depenses (categorie, description, montant_fcfa, date_depense) VALUES (?, ?, ?, ?)`)
    .run(categorie, description || null, montant_fcfa, date_depense);
  send(res, 201, db.prepare(`SELECT * FROM depenses WHERE id = ?`).get(info.lastInsertRowid));
});

router.post("/api/admin/depenses/:id/supprimer", (req, res, params) => {
  if (!isAdminAvecLimite(req, res)) return;
  const existe = db.prepare(`SELECT id FROM depenses WHERE id = ?`).get(params.id);
  if (!existe) return send(res, 404, { error: "dépense introuvable" });
  db.prepare(`DELETE FROM depenses WHERE id = ?`).run(params.id);
  send(res, 200, { ok: true });
});

function genererCsv(colonnes, lignes) {
  const echapper = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    // Un nom de lot ou de compte commençant par = + - @ deviendrait une
    // formule exécutée par Excel à l'ouverture (injection CSV).
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const entete = colonnes.map(echapper).join(";");
  const corps = lignes.map((ligne) => ligne.map(echapper).join(";")).join("\n");
  return entete + "\n" + corps;
}

// Sauvegarde complète de la base (admin) : copie cohérente via VACUUM INTO,
// envoyée en téléchargement puis supprimée. Sert à migrer d'hébergeur et à
// garder des sauvegardes régulières.
router.get("/api/admin/export/base.sqlite", (req, res) => {
  if (!isAdminAvecLimite(req, res)) return;
  const fichier = require("path").join(require("os").tmpdir(), `agrisecur-sauvegarde-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${fichier.replace(/'/g, "''")}'`);
  } catch (err) {
    console.error("[sauvegarde] échec :", err.message);
    return send(res, 500, { error: "sauvegarde impossible" });
  }
  const date = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    "Content-Type": "application/vnd.sqlite3",
    "Content-Disposition": `attachment; filename="agrisecur-${date}.db"`,
    "Cache-Control": "no-store",
  });
  const flux = require("fs").createReadStream(fichier);
  const nettoyer = () => require("fs").unlink(fichier, () => {});
  flux.on("close", nettoyer);
  flux.on("error", nettoyer);
  flux.pipe(res);
});

router.get("/api/admin/export/commandes.csv", (req, res) => {
  if (!isAdminAvecLimite(req, res)) return;
  const rows = db.prepare(`
    SELECT o.id, o.created_at, o.cloture_at, o.statut, o.mode_paiement, p.nom AS produit, p.filiere,
      b.nom AS acheteur, s.nom AS vendeur, o.montant_total_fcfa, o.frais_paiement_fcfa,
      o.commission_taux, o.commission_fcfa, o.montant_net_vendeur_fcfa
    FROM orders o
    JOIN products p ON p.id = o.product_id
    JOIN buyers b ON b.id = o.buyer_id
    JOIN sellers s ON s.id = o.seller_id
    ORDER BY o.created_at DESC
  `).all();
  const csv = genererCsv(
    ["ID", "Créée le", "Clôturée le", "Statut", "Mode paiement", "Produit", "Filière", "Acheteur", "Vendeur", "Montant total FCFA", "Frais paiement FCFA", "Taux commission", "Commission FCFA", "Net vendeur FCFA"],
    rows.map((r) => [r.id, r.created_at, r.cloture_at, r.statut, r.mode_paiement, r.produit, r.filiere, r.acheteur, r.vendeur, r.montant_total_fcfa, r.frais_paiement_fcfa, r.commission_taux, r.commission_fcfa, r.montant_net_vendeur_fcfa])
  );
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=agrisecur-commandes.csv" });
  res.end("\uFEFF" + csv);
});

router.get("/api/admin/export/depenses.csv", (req, res) => {
  if (!isAdminAvecLimite(req, res)) return;
  const rows = db.prepare(`SELECT * FROM depenses ORDER BY date_depense DESC`).all();
  const csv = genererCsv(
    ["ID", "Date", "Catégorie", "Description", "Montant FCFA"],
    rows.map((r) => [r.id, r.date_depense, r.categorie, r.description, r.montant_fcfa])
  );
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=agrisecur-depenses.csv" });
  res.end("\uFEFF" + csv);
});

router.get("/api/admin/marge-nette", (req, res) => {
  if (!isAdminAvecLimite(req, res)) return;

  const parMode = db.prepare(`
    SELECT mode_paiement,
      COUNT(*) AS n,
      COALESCE(SUM(montant_total_fcfa),0) AS volume_fcfa,
      COALESCE(SUM(commission_fcfa),0) AS commission_fcfa,
      COALESCE(SUM(frais_paiement_fcfa),0) AS frais_collectes_acheteur_fcfa
    FROM orders WHERE statut = 'cloture'
    GROUP BY mode_paiement
  `).all();

  // Depuis le changement de modèle : le mobile money est neutre pour la
  // plateforme (frais collectés côté acheteur, reversés à l'agrégateur) ;
  // seul le virement reste absorbé sur la commission (frais fixe, faible
  // sur les gros montants habituellement virés).
  let commissionBrute = 0, fraisAbsorbes = 0;
  const detail = parMode.map((m) => {
    const frais = m.mode_paiement === "virement" ? m.n * VIREMENT_FRAIS_FCFA : 0;
    commissionBrute += m.commission_fcfa;
    fraisAbsorbes += frais;
    return { ...m, frais_absorbes_fcfa: frais, marge_nette_fcfa: m.commission_fcfa - frais };
  });

  const margeNette = commissionBrute - fraisAbsorbes;
  const impotEstime = Math.round(commissionBrute * TAUX_IMPOT_ESTIME);
  const SEUIL_MICROENTREPRISE_FCFA = 50000000;
  const totalSva = db.prepare(`SELECT COALESCE(SUM(montant_fcfa),0) AS total FROM sva_achats WHERE statut = 'paye'`).get().total;
  const totalDepenses = db.prepare(`SELECT COALESCE(SUM(montant_fcfa),0) AS total FROM depenses`).get().total;
  const resultatNet = margeNette - impotEstime + totalSva - totalDepenses;

  send(res, 200, {
    parametres: { mobile_money_frais_taux: MOBILE_MONEY_FRAIS_TAUX, virement_frais_fcfa: VIREMENT_FRAIS_FCFA, taux_impot_estime: TAUX_IMPOT_ESTIME },
    par_mode: detail,
    total: {
      commission_brute_fcfa: commissionBrute,
      frais_absorbes_fcfa: fraisAbsorbes,
      marge_nette_fcfa: margeNette,
      impot_estime_fcfa: impotEstime,
      marge_nette_apres_impot_fcfa: margeNette - impotEstime,
      revenus_sva_fcfa: totalSva,
      depenses_operationnelles_fcfa: totalDepenses,
      resultat_net_fcfa: resultatNet,
    },
    regime_fiscal: {
      seuil_microentreprise_fcfa: SEUIL_MICROENTREPRISE_FCFA,
      part_seuil_pourcent: Math.min(100, Math.round((commissionBrute / SEUIL_MICROENTREPRISE_FCFA) * 1000) / 10),
    },
  });
});

router.get("/api/admin/revenue-sva", (req, res) => {
  if (!isAdminAvecLimite(req, res)) return;
  const total = db.prepare(`SELECT COALESCE(SUM(montant_fcfa),0) AS total, COUNT(*) AS n FROM sva_achats WHERE statut = 'paye'`).get();
  const enAttente = db.prepare(`SELECT COALESCE(SUM(montant_fcfa),0) AS total, COUNT(*) AS n FROM sva_achats WHERE statut = 'en_attente'`).get();
  const parType = db.prepare(`SELECT type, COUNT(*) AS n, COALESCE(SUM(montant_fcfa),0) AS total FROM sva_achats WHERE statut = 'paye' GROUP BY type`).all();
  const recents = db.prepare(`
    SELECT sva.*, s.nom AS vendeur_nom FROM sva_achats sva JOIN sellers s ON s.id = sva.seller_id
    WHERE sva.statut = 'paye' ORDER BY sva.created_at DESC LIMIT 20
  `).all();
  send(res, 200, { total_fcfa: total.total, nb_achats: total.n, en_attente_fcfa: enAttente.total, nb_en_attente: enAttente.n, par_type: parType, recents });
});

// Demandes de Boost / Pro en attente de paiement (back-office).
router.get("/api/admin/sva-demandes", (req, res) => {
  if (!isAdminAvecLimite(req, res)) return;
  const rows = db.prepare(`
    SELECT sva.id, sva.type, sva.description, sva.montant_fcfa, sva.reference, sva.jours,
           sva.created_at, sva.product_id, s.nom AS vendeur_nom, s.id AS seller_id, p.nom AS produit_nom, p.statut AS produit_statut
    FROM sva_achats sva
    JOIN sellers s ON s.id = sva.seller_id
    LEFT JOIN products p ON p.id = sva.product_id
    WHERE sva.statut = 'en_attente'
    ORDER BY sva.id ASC
  `).all();
  send(res, 200, rows);
});

// Confirme la réception du paiement d'une demande et active l'avantage
// (mise en avant du lot, ou prolongation de l'abonnement Pro) de façon atomique.
router.post("/api/admin/sva-demandes/:id/confirmer", (req, res, params, body) => {
  if (!isAdminAvecLimite(req, res)) return;
  const demande = db.prepare(`SELECT * FROM sva_achats WHERE id = ?`).get(params.id);
  if (!demande) return send(res, 404, { error: "demande introuvable" });
  if (demande.statut !== "en_attente") return send(res, 409, { error: "cette demande n'est plus en attente" });
  const mode = ["mobile_money", "virement", "especes", "autre"].includes(body && body.mode_paiement) ? body.mode_paiement : "autre";

  try {
    executerEnTransaction(() => {
      const now = new Date().toISOString();
      if (demande.type === "boost") {
        const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(demande.product_id);
        if (!product) throw new Error("le lot associé n'existe plus");
        const base = new Date(product.mis_en_avant_jusqua && new Date(product.mis_en_avant_jusqua) > new Date() ? product.mis_en_avant_jusqua : Date.now());
        const jusqua = new Date(base.getTime() + demande.jours * 24 * 3600 * 1000).toISOString();
        db.prepare(`UPDATE products SET mis_en_avant_jusqua = ? WHERE id = ?`).run(jusqua, product.id);
      } else if (demande.type === "abonnement_pro") {
        const seller = db.prepare(`SELECT * FROM sellers WHERE id = ?`).get(demande.seller_id);
        const base = new Date(seller.abonnement_pro_jusqua && new Date(seller.abonnement_pro_jusqua) > new Date() ? seller.abonnement_pro_jusqua : Date.now());
        const jusqua = new Date(base.getTime() + (demande.jours || ABONNEMENT_PRO_DUREE_JOURS) * 24 * 3600 * 1000).toISOString();
        db.prepare(`UPDATE sellers SET abonnement_pro_jusqua = ? WHERE id = ?`).run(jusqua, seller.id);
      }
      db.prepare(`UPDATE sva_achats SET statut = 'paye', mode_paiement = ?, confirme_le = ? WHERE id = ?`).run(mode, now, demande.id);
    });
  } catch (err) {
    return send(res, 409, { error: err.message });
  }
  send(res, 200, { ok: true, id: demande.id, type: demande.type, montant_fcfa: demande.montant_fcfa });
});

// Rejette une demande (paiement jamais reçu, doublon…).
router.post("/api/admin/sva-demandes/:id/rejeter", (req, res, params) => {
  if (!isAdminAvecLimite(req, res)) return;
  const demande = db.prepare(`SELECT * FROM sva_achats WHERE id = ?`).get(params.id);
  if (!demande) return send(res, 404, { error: "demande introuvable" });
  if (demande.statut !== "en_attente") return send(res, 409, { error: "cette demande n'est plus en attente" });
  db.prepare(`UPDATE sva_achats SET statut = 'annule' WHERE id = ?`).run(demande.id);
  send(res, 200, { ok: true });
});

// ---------- Catalogue ----------

router.post("/api/products", (req, res, params, body) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  const seller = db.prepare(`SELECT * FROM sellers WHERE id = ?`).get(auth.id);
  if (seller.kyc_statut !== "valide") return send(res, 403, { error: "KYC vendeur non validé — impossible de publier un lot" });

  const { nom, quantite_kg, prix_unitaire_fcfa, filiere, mode_livraison, prix_avec_transport_fcfa, photo_url, parcelle_latitude, parcelle_longitude, declaration_non_deforestation } = body;
  if (!nom || !quantite_kg || !prix_unitaire_fcfa) return send(res, 400, { error: "nom, quantite_kg, prix_unitaire_fcfa requis" });
  if (!texteValide(nom, 120, true)) return send(res, 400, { error: "nom du lot invalide (120 caractères max)" });
  if (filiere !== undefined && filiere !== null && filiere !== "" && !texteValide(filiere, 40, true)) return send(res, 400, { error: "filière invalide" });
  const nombrePositif = (v) => (typeof v === "number" || typeof v === "string") && Number.isFinite(Number(v)) && Number(v) > 0;
  if (!nombrePositif(quantite_kg) || !nombrePositif(prix_unitaire_fcfa)) return send(res, 400, { error: "quantité et prix doivent être des nombres positifs" });
  if (prix_avec_transport_fcfa && !nombrePositif(prix_avec_transport_fcfa)) return send(res, 400, { error: "prix avec transport invalide" });
  if (mode_livraison && !["acheteur", "vendeur", "a_convenir"].includes(mode_livraison)) {
    return send(res, 400, { error: "mode_livraison invalide" });
  }
  if (prix_avec_transport_fcfa && prix_avec_transport_fcfa < prix_unitaire_fcfa) {
    return send(res, 400, { error: "le prix avec transport doit être supérieur ou égal au prix sans transport" });
  }
  if (photo_url && !photoValide(photo_url)) {
    return send(res, 400, { error: "photo invalide ou trop volumineuse (compressez avant envoi)" });
  }
  const lat = parcelle_latitude !== undefined && parcelle_latitude !== null && parcelle_latitude !== "" ? Number(parcelle_latitude) : null;
  const lng = parcelle_longitude !== undefined && parcelle_longitude !== null && parcelle_longitude !== "" ? Number(parcelle_longitude) : null;
  if ((lat !== null) !== (lng !== null)) {
    return send(res, 400, { error: "latitude et longitude doivent être renseignées ensemble" });
  }
  if (lat !== null && (isNaN(lat) || lat < 4 || lat > 11)) {
    return send(res, 400, { error: "latitude hors de la fourchette attendue pour la Côte d'Ivoire (4° à 11°)" });
  }
  if (lng !== null && (isNaN(lng) || lng < -9 || lng > -2)) {
    return send(res, 400, { error: "longitude hors de la fourchette attendue pour la Côte d'Ivoire (-9° à -2°)" });
  }

  const info = db.prepare(`
    INSERT INTO products (seller_id, nom, quantite_kg, prix_unitaire_fcfa, prix_avec_transport_fcfa, filiere, mode_livraison, photo_url, parcelle_latitude, parcelle_longitude, declaration_non_deforestation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(auth.id, nom, quantite_kg, prix_unitaire_fcfa, prix_avec_transport_fcfa || null, filiere || "cacao", mode_livraison || "acheteur", photo_url || null, lat, lng, declaration_non_deforestation ? 1 : 0);
  send(res, 201, db.prepare(`SELECT * FROM products WHERE id = ?`).get(info.lastInsertRowid));
});

router.post("/api/products/:id/retirer", (req, res, params) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(params.id);
  if (!product) return send(res, 404, { error: "lot introuvable" });
  if (product.seller_id !== auth.id) return send(res, 403, { error: "ce lot n'appartient pas à ce vendeur" });
  if (product.statut !== "disponible") return send(res, 409, { error: "seul un lot disponible peut être retiré" });
  db.prepare(`UPDATE products SET statut = 'retire' WHERE id = ?`).run(product.id);
  send(res, 200, db.prepare(`SELECT * FROM products WHERE id = ?`).get(product.id));
});

// Déclenche une analyse satellite de risque de déforestation (WHISP/FAO) pour
// un lot géolocalisé. Asynchrone : la réponse revient immédiatement, le
// résultat est récupéré par la tâche planifiée (cf. fin du fichier).
router.post("/api/products/:id/verifier-deforestation", (req, res, params) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  if (!WHISP_ACTIF) return send(res, 503, { error: "service d'analyse satellite indisponible pour le moment" });

  const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(params.id);
  if (!product) return send(res, 404, { error: "lot introuvable" });
  if (product.seller_id !== auth.id) return send(res, 403, { error: "ce lot n'appartient pas à ce vendeur" });
  if (product.parcelle_latitude === null || product.parcelle_longitude === null) {
    return send(res, 400, { error: "ce lot n'a pas de géolocalisation de parcelle renseignée" });
  }
  if (product.whisp_statut === "en_cours") {
    return send(res, 409, { error: "une analyse est déjà en cours pour ce lot" });
  }

  db.prepare(`UPDATE products SET whisp_statut = 'en_cours', whisp_soumis_le = ?, whisp_token = NULL WHERE id = ?`)
    .run(new Date().toISOString(), product.id);

  soumettreAnalyseWhisp(product.parcelle_latitude, product.parcelle_longitude)
    .then((r) => {
      if (r.resultat) enregistrerResultatWhisp(product, r.resultat);
      else db.prepare(`UPDATE products SET whisp_token = ? WHERE id = ?`).run(r.token, product.id);
    })
    .catch((err) => {
      console.error(`[whisp] échec de soumission pour le lot ${product.id} :`, err.message);
      db.prepare(`UPDATE products SET whisp_statut = 'erreur' WHERE id = ?`).run(product.id);
    });

  send(res, 202, { ok: true, whisp_statut: "en_cours" });
});

// ---------- SVA : mise en avant de lots & abonnement Vendeur Pro ----------

router.get("/api/frais-paiement", (req, res) => {
  send(res, 200, { mobile_money_taux: MOBILE_MONEY_FRAIS_TAUX, virement_fcfa: VIREMENT_FRAIS_FCFA, parrainage_credit_fcfa: REFERRAL_CREDIT_FCFA });
});

router.get("/api/sva/tarifs", (req, res) => {
  send(res, 200, { boost: BOOST_TARIFS, abonnement_pro: { fcfa: ABONNEMENT_PRO_FCFA, duree_jours: ABONNEMENT_PRO_DUREE_JOURS } });
});

// Boost : le vendeur demande une mise en avant. On enregistre une demande
// « en attente » avec le prix bloqué et le nombre de jours choisi ; le lot
// n'est PAS mis en avant avant confirmation du paiement par le back-office.
router.post("/api/products/:id/booster", (req, res, params, body) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(params.id);
  if (!product) return send(res, 404, { error: "lot introuvable" });
  if (product.seller_id !== auth.id) return send(res, 403, { error: "ce lot n'appartient pas à ce vendeur" });
  if (product.statut !== "disponible") return send(res, 409, { error: "seul un lot disponible peut être mis en avant" });

  const jours = Number(body.jours);
  if (!BOOST_TARIFS[jours]) return send(res, 400, { error: "durée invalide (3, 7 ou 14 jours)" });
  const montant = BOOST_TARIFS[jours];

  // Une seule demande de boost en attente par lot à la fois.
  const dejaEnAttente = db.prepare(`SELECT * FROM sva_achats WHERE seller_id = ? AND type = 'boost' AND product_id = ? AND statut = 'en_attente'`).get(auth.id, product.id);
  if (dejaEnAttente) {
    return send(res, 200, { deja_en_attente: true, demande: dejaEnAttente, paiement: instructionsPaiementSva(dejaEnAttente.reference, dejaEnAttente.montant_fcfa) });
  }

  const info = db.prepare(`INSERT INTO sva_achats (seller_id, type, description, montant_fcfa, statut, jours, product_id) VALUES (?, 'boost', ?, ?, 'en_attente', ?, ?)`)
    .run(auth.id, `Mise en avant ${jours}j — lot "${product.nom}"`, montant, jours, product.id);
  const reference = `BOOST-${info.lastInsertRowid}`;
  db.prepare(`UPDATE sva_achats SET reference = ? WHERE id = ?`).run(reference, info.lastInsertRowid);

  send(res, 201, { en_attente: true, reference, montant_fcfa: montant, paiement: instructionsPaiementSva(reference, montant) });
});

// Abonnement Pro : même principe — demande « en attente », rien n'est activé
// avant confirmation du paiement.
router.post("/api/sellers/me/abonnement-pro", (req, res) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });

  const dejaEnAttente = db.prepare(`SELECT * FROM sva_achats WHERE seller_id = ? AND type = 'abonnement_pro' AND statut = 'en_attente'`).get(auth.id);
  if (dejaEnAttente) {
    return send(res, 200, { deja_en_attente: true, demande: dejaEnAttente, paiement: instructionsPaiementSva(dejaEnAttente.reference, dejaEnAttente.montant_fcfa) });
  }

  const info = db.prepare(`INSERT INTO sva_achats (seller_id, type, description, montant_fcfa, statut, jours) VALUES (?, 'abonnement_pro', ?, ?, 'en_attente', ?)`)
    .run(auth.id, `Abonnement Vendeur Pro — ${ABONNEMENT_PRO_DUREE_JOURS} jours`, ABONNEMENT_PRO_FCFA, ABONNEMENT_PRO_DUREE_JOURS);
  const reference = `PRO-${info.lastInsertRowid}`;
  db.prepare(`UPDATE sva_achats SET reference = ? WHERE id = ?`).run(reference, info.lastInsertRowid);

  send(res, 201, { en_attente: true, reference, montant_fcfa: ABONNEMENT_PRO_FCFA, paiement: instructionsPaiementSva(reference, ABONNEMENT_PRO_FCFA) });
});

// Le vendeur consulte ses demandes de Boost / Pro (en attente et confirmées).
router.get("/api/sellers/me/sva-demandes", (req, res) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  const rows = db.prepare(`
    SELECT sva.id, sva.type, sva.description, sva.montant_fcfa, sva.statut, sva.reference, sva.jours,
           sva.created_at, sva.confirme_le, sva.mode_paiement, p.nom AS produit_nom
    FROM sva_achats sva LEFT JOIN products p ON p.id = sva.product_id
    WHERE sva.seller_id = ? AND sva.statut IN ('en_attente','paye')
    ORDER BY sva.id DESC LIMIT 50
  `).all(auth.id);
  send(res, 200, rows.map((r) => ({ ...r, paiement: r.statut === "en_attente" ? instructionsPaiementSva(r.reference, r.montant_fcfa) : null })));
});

// Le vendeur peut annuler sa propre demande tant qu'elle n'est pas payée.
router.post("/api/sellers/me/sva-demandes/:id/annuler", (req, res, params) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  const demande = db.prepare(`SELECT * FROM sva_achats WHERE id = ?`).get(params.id);
  if (!demande || demande.seller_id !== auth.id) return send(res, 404, { error: "demande introuvable" });
  if (demande.statut !== "en_attente") return send(res, 409, { error: "seule une demande en attente peut être annulée" });
  db.prepare(`UPDATE sva_achats SET statut = 'annule' WHERE id = ?`).run(demande.id);
  send(res, 200, { ok: true });
});

// Analytique comparative — réservée aux vendeurs Pro : prix moyen constaté
// sur la plateforme, filière par filière, pour évaluer son positionnement.
router.get("/api/sellers/me/analytics-pro", (req, res) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  const seller = db.prepare(`SELECT * FROM sellers WHERE id = ?`).get(auth.id);
  const isPro = seller.abonnement_pro_jusqua && new Date(seller.abonnement_pro_jusqua) > new Date();
  if (!isPro) return send(res, 403, { error: "réservé aux vendeurs abonnés Pro" });

  const marche = db.prepare(`
    SELECT filiere, ROUND(AVG(prix_unitaire_fcfa)) AS prix_moyen_marche, COUNT(*) AS nb_lots
    FROM products WHERE statut IN ('disponible','reserve','vendu') GROUP BY filiere
  `).all();
  const mesLots = db.prepare(`
    SELECT filiere, ROUND(AVG(prix_unitaire_fcfa)) AS mon_prix_moyen
    FROM products WHERE seller_id = ? GROUP BY filiere
  `).all(auth.id);
  const mesLotsMap = Object.fromEntries(mesLots.map((l) => [l.filiere, l.mon_prix_moyen]));

  send(res, 200, marche.map((m) => ({ ...m, mon_prix_moyen: mesLotsMap[m.filiere] || null })));
});

// Vue vendeur : tous ses lots (tous statuts confondus), pas seulement les disponibles
router.get("/api/sellers/me/products", (req, res) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  send(res, 200, db.prepare(`SELECT * FROM products WHERE seller_id = ? ORDER BY created_at DESC`).all(auth.id));
});

// Tableau de bord vendeur : chiffre d'affaires, commission versée, commandes en cours
router.get("/api/sellers/me/dashboard", (req, res) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });

  const completees = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(montant_net_vendeur_fcfa),0) AS net, COALESCE(SUM(commission_fcfa),0) AS commission
     FROM orders WHERE seller_id = ? AND statut IN ('cloture')`
  ).get(auth.id);
  const enCours = db.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE seller_id = ? AND statut IN ('sequestre','en_controle','litige')`
  ).get(auth.id);
  const lotsActifs = db.prepare(
    `SELECT COUNT(*) AS n FROM products WHERE seller_id = ? AND statut = 'disponible'`
  ).get(auth.id);

  const parFiliere = db.prepare(
    `SELECT p.filiere AS filiere, COUNT(*) AS n, COALESCE(SUM(o.montant_net_vendeur_fcfa),0) AS net
     FROM orders o JOIN products p ON p.id = o.product_id
     WHERE o.seller_id = ? AND o.statut = 'cloture'
     GROUP BY p.filiere ORDER BY net DESC`
  ).all(auth.id);

  const seller = db.prepare(`SELECT abonnement_pro_jusqua FROM sellers WHERE id = ?`).get(auth.id);
  const estPro = !!(seller.abonnement_pro_jusqua && new Date(seller.abonnement_pro_jusqua) > new Date());
  const sva = db.prepare(`SELECT COALESCE(SUM(montant_fcfa),0) AS total FROM sva_achats WHERE seller_id = ? AND statut = 'paye'`).get(auth.id);

  send(res, 200, {
    ventes_nettes_fcfa: completees.net,
    commission_versee_fcfa: completees.commission,
    commandes_completees: completees.n,
    commandes_en_cours: enCours.n,
    lots_actifs: lotsActifs.n,
    par_filiere: parFiliere,
    abonnement_pro_actif: estPro,
    abonnement_pro_jusqua: seller.abonnement_pro_jusqua,
    sva_depense_fcfa: sva.total,
  });
});

// ---------- Prix du jour : prix officiels bord champ + cours mondiaux ----------
// Les prix officiels sont fixés par l'État (Conseil Café-Cacao, Conseil du Coton
// et de l'Anacarde). Valeurs par défaut vérifiées le 26/09/2026, modifiables
// depuis le back-office (onglet Rentabilité) à chaque nouvelle campagne.
const PRIX_OFFICIELS_DEFAUT = [
  { filiere: "cacao", prix_fcfa_kg: 1200, detail: "", campagne: "Campagne principale 2026-2027", depuis: "2026-09-01", source: "Conseil Café-Cacao" },
  { filiere: "cafe", prix_fcfa_kg: 1300, detail: "", campagne: "Campagne principale 2026-2027", depuis: "2026-09-01", source: "Conseil Café-Cacao" },
  { filiere: "anacarde", prix_fcfa_kg: 400, detail: "", campagne: "Campagne 2026", depuis: "2026-02-09", source: "Conseil du Coton et de l'Anacarde" },
  { filiere: "coton", prix_fcfa_kg: 310, detail: "1er choix · 2e choix : 285 FCFA/kg", campagne: "Campagne 2025-2026", depuis: "2025-07-31", source: "Conseil du Coton et de l'Anacarde" },
];

// Fichier du dépôt (tenu à jour par l'agent de veille), relu à chaque appel.
function prixOfficielsFichier() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "prix-officiels.json"), "utf8"));
    return Array.isArray(d.prix) && d.prix.length ? d.prix : PRIX_OFFICIELS_DEFAUT;
  } catch { return PRIX_OFFICIELS_DEFAUT; }
}

// Fusion par filière : la saisie du back-office l'emporte si elle est plus récente.
function lirePrixOfficiels() {
  const base = prixOfficielsFichier();
  let saisis = [];
  const ligne = db.prepare(`SELECT valeur FROM app_config WHERE cle = 'prix_officiels'`).get();
  if (ligne) { try { const v = JSON.parse(ligne.valeur); if (Array.isArray(v)) saisis = v; } catch {} }
  const parFiliere = new Map(base.map((p) => [p.filiere, p]));
  for (const p of saisis) {
    const actuel = parFiliere.get(p.filiere);
    if (!actuel || String(p.depuis || "") >= String(actuel.depuis || "")) parFiliere.set(p.filiere, p);
  }
  return [...parFiliere.values()];
}

// Cours des bourses internationales (contrats à terme). Deux fournisseurs
// gratuits sans clé : Yahoo Finance, puis Stooq en secours.
const XOF_PAR_EUR = 655.957; // parité fixe FCFA / euro
const LIVRE_KG = 0.45359237;
const COURS_MONDIAUX = [
  { filiere: "cacao", marche: "Cacao · ICE New York", yahoo: "CC=F", stooq: "cc.f", unite: "USD/t", versKg: (p) => p / 1000 },
  { filiere: "cafe", marche: "Café arabica · ICE New York", yahoo: "KC=F", stooq: "kc.f", unite: "cents US/lb", versKg: (p) => p / 100 / LIVRE_KG },
  { filiere: "coton", marche: "Coton fibre · ICE New York", yahoo: "CT=F", stooq: "ct.f", unite: "cents US/lb", versKg: (p) => p / 100 / LIVRE_KG },
  { filiere: "riz", marche: "Riz paddy · CBOT Chicago", yahoo: "ZR=F", stooq: "zr.f", unite: "USD/quintal US", versKg: (p) => p / 45.359237 },
];

async function coursYahoo(symbole) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbole)}?range=5d&interval=1d`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AgriSecur/1.0)" }, signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`yahoo ${r.status}`);
  const m = (await r.json())?.chart?.result?.[0]?.meta;
  if (!m || typeof m.regularMarketPrice !== "number") throw new Error("yahoo vide");
  const precedent = m.chartPreviousClose ?? m.previousClose;
  return { prix: m.regularMarketPrice, precedent: typeof precedent === "number" ? precedent : null,
    maj: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : new Date().toISOString(), fournisseur: "Yahoo Finance" };
}

async function coursStooq(symbole) {
  const r = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(symbole)}&f=sd2t2ohlc&h&e=csv`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`stooq ${r.status}`);
  const lignes = (await r.text()).trim().split(/\r?\n/);
  const v = (lignes[1] || "").split(",");
  const ouverture = parseFloat(v[3]), cloture = parseFloat(v[6]);
  if (!isFinite(cloture)) throw new Error("stooq vide");
  const maj = v[1] && v[2] ? new Date(`${v[1]}T${v[2]}Z`).toISOString() : new Date().toISOString();
  return { prix: cloture, precedent: isFinite(ouverture) ? ouverture : null, maj, fournisseur: "Stooq" };
}

async function unCours(yahoo, stooq) {
  try { return await coursYahoo(yahoo); } catch (e1) {
    try { return await coursStooq(stooq); } catch (e2) { return null; }
  }
}

const PRIX_DU_JOUR_TTL_MS = 10 * 60 * 1000;
let cachePrixMondiaux = { at: 0, data: null, enCours: null };

async function rafraichirPrixMondiaux() {
  const [fx, ...cotations] = await Promise.all([unCours("EURUSD=X", "eurusd"), ...COURS_MONDIAUX.map((c) => unCours(c.yahoo, c.stooq))]);
  const xofParUsd = fx && fx.prix > 0 ? XOF_PAR_EUR / fx.prix : null;
  const resultats = COURS_MONDIAUX.map((c, i) => {
    const q = cotations[i];
    if (!q) return null;
    const variation = q.precedent ? ((q.prix - q.precedent) / q.precedent) * 100 : null;
    return {
      filiere: c.filiere, marche: c.marche, cours: q.prix, unite: c.unite,
      variation_pct: variation === null ? null : Math.round(variation * 100) / 100,
      fcfa_kg: xofParUsd ? Math.round(c.versKg(q.prix) * xofParUsd) : null,
      maj: q.maj, fournisseur: q.fournisseur,
    };
  });
  return { mondiaux: resultats.filter(Boolean), xof_par_usd: xofParUsd ? Math.round(xofParUsd * 100) / 100 : null, calcule_le: new Date().toISOString() };
}

async function prixMondiaux() {
  const frais = cachePrixMondiaux.data && Date.now() - cachePrixMondiaux.at < PRIX_DU_JOUR_TTL_MS;
  if (frais) return cachePrixMondiaux.data;
  if (!cachePrixMondiaux.enCours) {
    cachePrixMondiaux.enCours = rafraichirPrixMondiaux()
      .then((d) => {
        if (d.mondiaux.length) cachePrixMondiaux = { at: Date.now(), data: d, enCours: null };
        // Échec complet : on garde les anciens cours s'il y en a, et on réessaie dans 2 minutes.
        else cachePrixMondiaux = { at: Date.now() - PRIX_DU_JOUR_TTL_MS + 2 * 60 * 1000, data: cachePrixMondiaux.data || d, enCours: null };
        return cachePrixMondiaux.data;
      })
      .catch(() => { cachePrixMondiaux.enCours = null; return cachePrixMondiaux.data; });
  }
  // Données déjà en cache : servies tout de suite, le rafraîchissement continue en arrière-plan.
  // Premier appel : on attend au plus 5 s pour ne jamais bloquer la page d'accueil.
  if (cachePrixMondiaux.data) return cachePrixMondiaux.data;
  return Promise.race([cachePrixMondiaux.enCours, new Promise((ok) => setTimeout(() => ok(null), 5000))]);
}
// Préchauffe au démarrage, puis toutes les 10 minutes.
setTimeout(() => prixMondiaux().catch(() => {}), 2000);
setInterval(() => prixMondiaux().catch(() => {}), PRIX_DU_JOUR_TTL_MS);

router.get("/api/prix-du-jour", (req, res) => {
  envoyerPrixDuJour(res).catch((err) => {
    console.error("prix-du-jour:", err.message);
    if (!res.headersSent) send(res, 500, { error: "prix indisponibles" });
  });
});

async function envoyerPrixDuJour(res) {
  const lots = db.prepare(`
    SELECT filiere, ROUND(AVG(prix_unitaire_fcfa)) AS prix_moyen_fcfa, MIN(prix_unitaire_fcfa) AS prix_min_fcfa,
      MAX(prix_unitaire_fcfa) AS prix_max_fcfa, COUNT(*) AS nb_lots
    FROM products WHERE statut = 'disponible' GROUP BY filiere ORDER BY nb_lots DESC
  `).all();
  let marches = null;
  try { marches = await prixMondiaux(); } catch { marches = null; }
  send(res, 200, {
    officiels: lirePrixOfficiels(),
    mondiaux: marches?.mondiaux || [],
    xof_par_usd: marches?.xof_par_usd || null,
    mondiaux_calcules_le: marches?.calcule_le || null,
    lots,
  });
}

router.post("/api/admin/prix-officiels", (req, res, params, body) => {
  if (!isAdminAvecLimite(req, res)) return;
  const liste = Array.isArray(body?.prix) ? body.prix : null;
  if (!liste || !liste.length || liste.length > 12) return send(res, 400, { error: "liste de prix invalide" });
  const propres = [];
  for (const p of liste) {
    const prix = Number(p.prix_fcfa_kg);
    if (!p.filiere || !FILIERES_VALIDES_PRIX.includes(p.filiere) || !Number.isFinite(prix) || prix <= 0 || prix > 100000) {
      return send(res, 400, { error: `prix invalide pour ${p.filiere || "une filière"}` });
    }
    propres.push({
      filiere: p.filiere, prix_fcfa_kg: Math.round(prix),
      detail: String(p.detail || "").slice(0, 120), campagne: String(p.campagne || "").slice(0, 80),
      depuis: String(p.depuis || "").slice(0, 10), source: String(p.source || "").slice(0, 80),
    });
  }
  db.prepare(`INSERT INTO app_config (cle, valeur) VALUES ('prix_officiels', ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur`).run(JSON.stringify(propres));
  send(res, 200, { ok: true, officiels: propres });
});
const FILIERES_VALIDES_PRIX = ["cacao", "anacarde", "cafe", "coton", "hevea", "palmier", "riz", "vivrier"];

// Prix moyens constatés sur les lots publiés (ancienne adresse, gardée pour compatibilité).
router.get("/api/market-prices", (req, res) => {
  const rows = db.prepare(`
    SELECT filiere,
      ROUND(AVG(prix_unitaire_fcfa)) AS prix_moyen_fcfa,
      MIN(prix_unitaire_fcfa) AS prix_min_fcfa,
      MAX(prix_unitaire_fcfa) AS prix_max_fcfa,
      COUNT(*) AS nb_lots
    FROM products
    WHERE statut = 'disponible'
    GROUP BY filiere
    ORDER BY nb_lots DESC
  `).all();
  send(res, 200, rows);
});

router.get("/api/products", (req, res) => {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT p.*, s.nom AS vendeur_nom, s.localisation, s.vendeur_fondateur,
      (p.mis_en_avant_jusqua IS NOT NULL AND p.mis_en_avant_jusqua > ?) AS en_avant,
      (s.abonnement_pro_jusqua IS NOT NULL AND s.abonnement_pro_jusqua > ?) AS vendeur_pro,
      (
        SELECT CASE WHEN COUNT(*) >= 3 AND AVG((julianday(o.expedie_at) - julianday(o.created_at)) * 24) < 24 THEN 1 ELSE 0 END
        FROM orders o WHERE o.seller_id = s.id AND o.expedie_at IS NOT NULL
      ) AS vendeur_reactif
    FROM products p JOIN sellers s ON s.id = p.seller_id
    WHERE p.statut = 'disponible'
    ORDER BY en_avant DESC, p.created_at DESC
  `).all(now, now);
  send(res, 200, rows);
});

// Statut public de la promotion de lancement — pour le compteur de la page d'accueil
router.get("/api/promo-status", (req, res) => {
  const nbFondateurs = db.prepare(`SELECT COUNT(*) AS n FROM sellers WHERE vendeur_fondateur = 1`).get().n;
  const joursEcoules = (Date.now() - PROMO_DATE_DEBUT.getTime()) / (1000 * 3600 * 24);
  const joursRestants = Math.max(0, Math.ceil(PROMO_JOURS_LIMITE - joursEcoules));
  send(res, 200, {
    active: promoEnrolementOuvert(),
    seuil: PROMO_SEUIL_VENDEURS,
    jours_limite: PROMO_JOURS_LIMITE,
    jours_restants: joursRestants,
    commission_promo_taux: PROMO_COMMISSION_TAUX,
    commission_standard_taux: COMMISSION_TAUX,
    places_prises: nbFondateurs,
    places_restantes: Math.max(0, PROMO_SEUIL_VENDEURS - nbFondateurs),
  });
});

// ---------- Tunnel séquestre ----------

router.post("/api/orders", async (req, res, params, body) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "buyer") return send(res, 401, { error: "connexion acheteur requise" });

  const { avec_transport, mode_paiement, virement_reference } = body;
  const product_id = Number(body.product_id);
  const quantite_kg = body.quantite_kg;
  if (!Number.isInteger(product_id) || product_id <= 0) return send(res, 400, { error: "identifiant de produit invalide" });
  if (typeof quantite_kg !== "number" || !Number.isFinite(quantite_kg) || quantite_kg < 1) {
    return send(res, 400, { error: "quantité invalide (1 kg minimum)" });
  }
  if (virement_reference != null && !texteValide(virement_reference, 100, false)) return send(res, 400, { error: "référence de virement invalide (100 caractères max)" });
  const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(product_id);
  if (!product) return send(res, 404, { error: "produit introuvable" });
  if (product.statut !== "disponible") return send(res, 409, { error: "produit non disponible" });
  if (quantite_kg > product.quantite_kg) return send(res, 400, { error: "quantité demandée supérieure au stock du lot" });

  const paiement = mode_paiement === "virement" ? "virement" : "mobile_money";
  if (paiement === "virement" && !virement_reference) {
    return send(res, 400, { error: "référence de virement requise (celle indiquée par votre banque)" });
  }

  const wantsTransport = !!avec_transport;
  if (wantsTransport && !product.prix_avec_transport_fcfa) {
    return send(res, 400, { error: "ce lot ne propose pas d'option avec transport" });
  }
  const prixApplique = wantsTransport ? product.prix_avec_transport_fcfa : product.prix_unitaire_fcfa;

  const seller = db.prepare(`SELECT vendeur_fondateur FROM sellers WHERE id = ?`).get(product.seller_id);
  // Le tarif fondateur ne s'applique que tant que la fenêtre de promo est
  // encore ouverte (seuil de vendeurs ET durée) — pas indéfiniment, sinon
  // la plateforme perdrait de la marge en continu sur cette cohorte.
  const tauxApplique = promoEnrolementOuvert() && seller.vendeur_fondateur ? PROMO_COMMISSION_TAUX : COMMISSION_TAUX;

  const montant_total = quantite_kg * prixApplique;
  const commission = Math.round(montant_total * tauxApplique);
  const net_vendeur = montant_total - commission;
  const statutInitial = paiement === "virement" ? "attente_virement" : "sequestre";

  // Frais de traitement du paiement — répercutés sur l'acheteur pour le
  // mobile money (variable, %) ; absorbés par la plateforme pour le virement
  // (fixe, négligeable sur les gros montants habituellement virés).
  let fraisPaiement = paiement === "mobile_money" ? Math.round(montant_total * MOBILE_MONEY_FRAIS_TAUX) : 0;

  // Crédit de parrainage : appliqué automatiquement en réduction des frais
  // mobile money de l'acheteur, jusqu'à épuisement du crédit disponible.
  // Toute la séquence (déduction du crédit, création de la commande,
  // réservation du produit) est atomique : si une étape échoue, rien n'est
  // appliqué — pas de crédit débité sans commande créée en contrepartie.
  let creditUtilise = 0;
  const info = executerEnTransaction(() => {
    if (fraisPaiement > 0) {
      const acheteur = db.prepare(`SELECT credit_parrainage_fcfa FROM buyers WHERE id = ?`).get(auth.id);
      if (acheteur.credit_parrainage_fcfa > 0) {
        creditUtilise = Math.min(acheteur.credit_parrainage_fcfa, fraisPaiement);
        fraisPaiement -= creditUtilise;
        db.prepare(`UPDATE buyers SET credit_parrainage_fcfa = credit_parrainage_fcfa - ? WHERE id = ?`).run(creditUtilise, auth.id);
      }
    }

    const resultat = db.prepare(`
      INSERT INTO orders (product_id, buyer_id, seller_id, quantite_kg, montant_total_fcfa, avec_transport,
        mode_paiement, virement_reference, frais_paiement_fcfa, commission_taux, commission_fcfa, montant_net_vendeur_fcfa, statut)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(product_id, auth.id, product.seller_id, quantite_kg, montant_total, wantsTransport ? 1 : 0,
           paiement, virement_reference || null, fraisPaiement, tauxApplique, commission, net_vendeur, statutInitial);

    db.prepare(`UPDATE products SET statut = 'reserve' WHERE id = ?`).run(product_id);
    return resultat;
  });

  if (creditUtilise > 0) {
    logEvent(info.lastInsertRowid, "creation", `Crédit de parrainage appliqué : ${creditUtilise} FCFA déduits des frais de traitement.`);
  }

  // Appel au module de paiement — uniquement pour le mobile money, qui
  // passe réellement par un agrégateur (CinetPay demain). Le virement
  // bancaire est un process manuel : rien n'est "encaissé" à la création
  // de la commande, seulement à la confirmation de réception par l'admin
  // (cf. route /confirmer-virement) — appeler le module ici pour un
  // virement décrirait un encaissement qui n'a pas encore eu lieu.
  if (paiement === "mobile_money") {
    try {
      const resultatPaiement = await payments.encaisserPaiement({ id: info.lastInsertRowid, montant_total_fcfa: montant_total });
      db.prepare(`UPDATE orders SET reference_paiement_agregateur = ? WHERE id = ?`).run(resultatPaiement.reference, info.lastInsertRowid);
    } catch (err) {
      logEvent(info.lastInsertRowid, "erreur_paiement", `Échec de l'appel au module de paiement : ${err.message}`);
    }
  }
  if (paiement === "virement") {
    logEvent(info.lastInsertRowid, "creation",
      `Commande créée par virement bancaire (réf. ${virement_reference}) — ${montant_total} FCFA en attente de confirmation de réception`);
  } else {
    logEvent(info.lastInsertRowid, "creation",
      `Commande créée (${wantsTransport ? "avec" : "sans"} transport) — ${montant_total} FCFA enregistrés + ${fraisPaiement} FCFA de frais de traitement mobile money`);
  }

  const commandeComplete = getOrder(info.lastInsertRowid);
  // Email de confirmation avec bon de commande en pièce jointe — n'empêche
  // jamais la commande d'aboutir si l'envoi échoue (ex. SMTP pas encore
  // configuré) : juste consigné dans le journal de la commande.
  try {
    const acheteur = db.prepare(`SELECT email FROM buyers WHERE id = ?`).get(auth.id);
    if (acheteur && acheteur.email) {
      const pdf = genererBonCommandePDF(commandeComplete);
      const resultatEmail = await envoyerBonCommandeParEmail(commandeComplete, acheteur.email, pdf);
      if (resultatEmail.envoye) {
        logEvent(info.lastInsertRowid, "email", `Bon de commande envoyé par email à ${acheteur.email}`);
      } else {
        logEvent(info.lastInsertRowid, "erreur_email", `Échec de l'envoi du bon de commande par email : ${resultatEmail.raison}`);
      }
    }
  } catch (err) {
    logEvent(info.lastInsertRowid, "erreur_email", `Échec de l'envoi du bon de commande par email : ${err.message}`);
  }

  send(res, 201, commandeComplete);
});

router.post("/api/orders/:id/expedier", (req, res, params, body) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  if (order.seller_id !== auth.id) return send(res, 403, { error: "cette commande n'appartient pas à ce vendeur" });
  if (order.statut !== "sequestre") return send(res, 409, { error: `transition impossible depuis l'état '${order.statut}'` });

  const delaiJours = Number(body.delai_livraison_estime_jours) || 3;
  if (delaiJours < 1 || delaiJours > 30) return send(res, 400, { error: "délai de livraison estimé invalide (1 à 30 jours)" });
  if (body.photo_expedition_url && !photoValide(body.photo_expedition_url)) {
    return send(res, 400, { error: "photo d'expédition invalide ou trop volumineuse (compressez avant envoi)" });
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE orders SET statut = 'expedie', expedie_at = ?, delai_livraison_estime_jours = ?, photo_expedition_url = ? WHERE id = ?`)
    .run(now, delaiJours, body.photo_expedition_url || null, order.id);
  logEvent(order.id, "expedition", `Lot expédié${body.photo_expedition_url ? " (avec photo de preuve)" : ""} — livraison estimée sous ${delaiJours} jour${delaiJours > 1 ? "s" : ""}. Le délai de contestation démarrera à la confirmation de réception (ou automatiquement si l'acheteur ne confirme pas).`);
  send(res, 200, getOrder(order.id));
});

router.post("/api/orders/:id/confirmer-reception", (req, res, params) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "buyer") return send(res, 401, { error: "connexion acheteur requise" });
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  if (order.buyer_id !== auth.id) return send(res, 403, { error: "cette commande n'appartient pas à cet acheteur" });
  if (order.statut !== "expedie") return send(res, 409, { error: `confirmation impossible depuis l'état '${order.statut}'` });

  const now = new Date().toISOString();
  db.prepare(`UPDATE orders SET statut = 'en_controle', controle_ouvert_at = ? WHERE id = ?`).run(now, order.id);
  logEvent(order.id, "reception_confirmee", "Réception confirmée par l'acheteur — fenêtre de contestation ouverte");
  send(res, 200, getOrder(order.id));
});

router.post("/api/orders/:id/reclamer", (req, res, params, body) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "buyer") return send(res, 401, { error: "connexion acheteur requise" });
  const { motif, photo_reclamation_url } = body;
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  if (order.buyer_id !== auth.id) return send(res, 403, { error: "cette commande n'appartient pas à cet acheteur" });
  if (!["expedie", "en_controle"].includes(order.statut)) return send(res, 409, { error: `réclamation impossible depuis l'état '${order.statut}'` });
  if (!motif) return send(res, 400, { error: "motif requis (Article 5 : réserve motivée)" });
  if (!texteValide(motif, 1000, true)) return send(res, 400, { error: "motif invalide (1000 caractères max)" });
  if (!photo_reclamation_url) return send(res, 400, { error: "une photo du problème constaté est requise pour ouvrir une réclamation" });
  if (!photoValide(photo_reclamation_url)) return send(res, 400, { error: "photo invalide ou trop volumineuse (compressez avant envoi)" });

  db.prepare(`UPDATE orders SET statut = 'litige', photo_reclamation_url = ? WHERE id = ?`).run(photo_reclamation_url, order.id);
  logEvent(order.id, "reclamation", `${motif} (photo de preuve jointe)`);
  send(res, 200, getOrder(order.id));
});

// Récompense le parrain quand son filleul clôture son tout premier achat.
// Le crédit versé est appliqué automatiquement (cf. création de commande)
// sur les frais mobile money de la prochaine commande du parrain.
// Séquence critique partagée par les 3 points de clôture d'une commande
// (validation acheteur, expiration automatique du délai, médiation de
// litige) : mise à jour du statut de la commande, du produit, et récompense
// de parrainage éventuelle — le tout atomique, pour ne jamais se retrouver
// avec un statut à moitié mis à jour si le serveur s'interrompt en cours de
// route.
async function cloturerCommandeAtomique(order, statutFinal) {
  const now = new Date().toISOString();
  executerEnTransaction(() => {
    db.prepare(`UPDATE orders SET statut = ?, cloture_at = ? WHERE id = ?`).run(statutFinal, now, order.id);
    db.prepare(`UPDATE products SET statut = ? WHERE id = ?`).run(statutFinal === "cloture" ? "vendu" : "disponible", order.product_id);
    if (statutFinal === "cloture") recompenserParrainageSiPremierAchat(order.buyer_id);
  });

  if (statutFinal === "cloture") {
    try {
      const resultat = await payments.declencherReversement(order);
      db.prepare(`UPDATE orders SET reference_reversement_agregateur = ? WHERE id = ?`).run(resultat.reference, order.id);
    } catch (err) {
      logEvent(order.id, "erreur_paiement", `Échec de l'appel au module de reversement : ${err.message}`);
    }
  }
  return now;
}

function recompenserParrainageSiPremierAchat(buyerId) {
  const buyer = db.prepare(`SELECT parraine_par FROM buyers WHERE id = ?`).get(buyerId);
  if (!buyer || !buyer.parraine_par) return;

  const dejaRecompense = db.prepare(`SELECT 1 FROM parrainages WHERE filleul_id = ?`).get(buyerId);
  if (dejaRecompense) return; // déjà récompensé pour ce filleul, jamais deux fois

  const nbAchatsReussis = db.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE buyer_id = ? AND statut = 'cloture'`
  ).get(buyerId).n;
  if (nbAchatsReussis !== 1) return; // pas son premier achat réussi

  db.prepare(`UPDATE buyers SET credit_parrainage_fcfa = credit_parrainage_fcfa + ? WHERE id = ?`)
    .run(REFERRAL_CREDIT_FCFA, buyer.parraine_par);
  db.prepare(`INSERT INTO parrainages (parrain_id, filleul_id, montant_credit_fcfa) VALUES (?, ?, ?)`)
    .run(buyer.parraine_par, buyerId, REFERRAL_CREDIT_FCFA);
}

router.post("/api/orders/:id/trancher-litige", async (req, res, params, body) => {
  if (!isAdminAvecLimite(req, res)) return;
  const { resolution, note } = body;
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  if (order.statut !== "litige") return send(res, 409, { error: "aucun litige en cours sur cette commande" });
  if (!["rembourse", "cloture"].includes(resolution)) return send(res, 400, { error: "resolution invalide" });

  await cloturerCommandeAtomique(order, resolution);
  logEvent(order.id, "mediation", `Litige tranché : ${resolution}${note ? " — " + note : ""}`);
  send(res, 200, getOrder(order.id));
});

router.post("/api/orders/:id/cloturer", async (req, res, params) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "buyer") return send(res, 401, { error: "connexion acheteur requise" });
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  if (order.buyer_id !== auth.id) return send(res, 403, { error: "cette commande n'appartient pas à cet acheteur" });
  if (!["expedie", "en_controle"].includes(order.statut)) return send(res, 409, { error: `clôture impossible depuis l'état '${order.statut}'` });

  await cloturerCommandeAtomique(order, "cloture");
  logEvent(order.id, "liberation_fonds", `Fonds nets (${order.montant_net_vendeur_fcfa} FCFA) libérés au vendeur — validation acheteur`);
  send(res, 200, getOrder(order.id));
});

// Vérifie une commande "en_controle" et clôture automatiquement si le délai
// de contestation est expiré — utilisée à la fois par la route manuelle et
// par la tâche planifiée interne (cf. fin du fichier).
async function cloturerSiDelaiExpire(order) {
  if (order.statut !== "en_controle") return false;
  const ouverture = new Date(order.controle_ouvert_at);
  const limite = new Date(ouverture.getTime() + order.delai_contestation_heures * 3600 * 1000);
  if (new Date() < limite) return false;

  await cloturerCommandeAtomique(order, "cloture");
  logEvent(order.id, "liberation_fonds",
    `Fonds nets (${order.montant_net_vendeur_fcfa} FCFA) libérés au vendeur — délai de contestation expiré (vérification automatique)`);
  return true;
}

router.post("/api/orders/:id/verifier-delai", async (req, res, params) => {
  if (!isAdminAvecLimite(req, res)) return;
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  await cloturerSiDelaiExpire(order);
  send(res, 200, getOrder(order.id));
});

router.get("/api/orders/:id", (req, res, params) => {
  const auth = getAuth(req);
  const order = getOrder(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  const owns = auth && ((auth.type === "seller" && auth.id === order.seller_id) || (auth.type === "buyer" && auth.id === order.buyer_id));
  if (!owns) {
    const adminCheck = estAdminSansBloquerFlux(req, res);
    if (adminCheck === "blocked") return;
    if (!adminCheck) return send(res, 403, { error: "accès réservé aux parties de la commande" });
  }
  send(res, 200, order);
});

router.get("/api/orders/:id/bon-commande.pdf", (req, res, params) => {
  const auth = getAuth(req);
  const order = getOrder(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  const owns = auth && ((auth.type === "seller" && auth.id === order.seller_id) || (auth.type === "buyer" && auth.id === order.buyer_id));
  if (!owns) {
    const adminCheck = estAdminSansBloquerFlux(req, res);
    if (adminCheck === "blocked") return;
    if (!adminCheck) return send(res, 403, { error: "accès réservé aux parties de la commande" });
  }
  const pdf = genererBonCommandePDF(order);
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="agrisecur-bon-commande-${order.id}.pdf"`,
  });
  res.end(pdf);
});

router.get("/api/orders", (req, res) => {
  const auth = getAuth(req);
  const adminCheck = estAdminSansBloquerFlux(req, res);
  if (adminCheck === "blocked") return;
  if (adminCheck === true) return send(res, 200, db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all());
  if (!auth) return send(res, 401, { error: "connexion requise" });
  const col = auth.type === "seller" ? "seller_id" : "buyer_id";
  send(res, 200, db.prepare(`SELECT * FROM orders WHERE ${col} = ? ORDER BY created_at DESC`).all(auth.id));
});

// Signalements — accessible même sans connexion (un utilisateur qui n'arrive
// pas à se connecter doit pouvoir signaler le problème malgré tout). Limité
// en fréquence pour éviter le spam sur un point d'entrée public non protégé
// par mot de passe.
router.post("/api/signalements", (req, res, params, body) => {
  if (!limiterTentatives(req, res, "signalement")) return;
  const { type, description, contexte, contact } = body;
  if (!["bug", "suggestion", "connexion", "contact"].includes(type)) return send(res, 400, { error: "type invalide" });
  if (typeof description !== "string" || description.trim().length < 5) return send(res, 400, { error: "description trop courte" });
  if (!texteValide(contexte, 500, false) || !texteValide(contact, 200, false)) return send(res, 400, { error: "contexte ou contact trop long" });
  if (description.length > 2000) return send(res, 400, { error: "description trop longue (2000 caractères max)" });

  const auth = getAuth(req);
  // Les messages du formulaire « Nous contacter » sont rangés avec les
  // suggestions (la table n'accepte que bug/suggestion/connexion), repérables
  // par le préfixe « Formulaire contact » dans le contexte.
  const typeStocke = type === "contact" ? "suggestion" : type;
  const contexteStocke = type === "contact" ? `Formulaire contact · ${String(contexte || "").slice(0, 200)}` : (contexte || null);
  const info = db.prepare(`
    INSERT INTO signalements (type, description, contexte, contact, user_type, user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(typeStocke, description.trim(), contexteStocke, contact || null, auth ? auth.type : null, auth ? auth.id : null);
  // Message du formulaire « Nous contacter » : copie par e-mail à la boîte
  // contact (sans bloquer la réponse, et sans effet si le SMTP n'est pas configuré).
  if (type === "contact") {
    envoyerEmail({
      to: process.env.CONTACT_EMAIL || "contact@agrisecur.com",
      subject: `Nouveau message de contact — ${String(contexte || "").slice(0, 80)}`,
      text: `De : ${contexte || "-"}\nPour répondre : ${contact || "-"}\n\n${description.trim()}\n\n(Message n° ${info.lastInsertRowid}, aussi visible dans le back-office, onglet Signalements.)`,
    }).catch((e) => console.log("[contact] e-mail non envoyé :", e.message));
  }
  send(res, 201, { ok: true, id: info.lastInsertRowid });
});

router.get("/api/admin/signalements", (req, res) => {
  if (!isAdminAvecLimite(req, res)) return;
  const rows = db.prepare(`SELECT * FROM signalements ORDER BY created_at DESC`).all();
  send(res, 200, rows);
});

router.post("/api/admin/signalements/:id/statut", (req, res, params, body) => {
  if (!isAdminAvecLimite(req, res)) return;
  const { statut } = body;
  if (!["nouveau", "en_cours", "resolu"].includes(statut)) return send(res, 400, { error: "statut invalide" });
  const existe = db.prepare(`SELECT id FROM signalements WHERE id = ?`).get(params.id);
  if (!existe) return send(res, 404, { error: "signalement introuvable" });
  db.prepare(`UPDATE signalements SET statut = ? WHERE id = ?`).run(statut, params.id);
  send(res, 200, { ok: true });
});

// Avis — uniquement possible sur une commande réellement clôturée,
// appartenant à l'acheteur qui note, un seul avis par commande.
router.post("/api/orders/:id/avis", (req, res, params, body) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "buyer") return send(res, 401, { error: "connexion acheteur requise" });
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  if (order.buyer_id !== auth.id) return send(res, 403, { error: "cette commande n'appartient pas à cet acheteur" });
  if (order.statut !== "cloture") return send(res, 409, { error: "seule une commande clôturée peut être notée" });
  const existant = db.prepare(`SELECT id FROM avis WHERE order_id = ?`).get(order.id);
  if (existant) return send(res, 409, { error: "cette commande a déjà été notée" });

  const { note, commentaire } = body;
  if (!Number.isInteger(note) || note < 1 || note > 5) return send(res, 400, { error: "note invalide (1 à 5)" });
  if (commentaire && commentaire.length > 500) return send(res, 400, { error: "commentaire trop long (500 caractères max)" });

  db.prepare(`INSERT INTO avis (order_id, seller_id, buyer_id, note, commentaire) VALUES (?, ?, ?, ?, ?)`)
    .run(order.id, order.seller_id, auth.id, note, commentaire || null);
  send(res, 201, { ok: true });
});

router.get("/api/sellers/:id/avis", (req, res, params) => {
  const rows = db.prepare(`
    SELECT a.note, a.commentaire, a.created_at, b.nom AS acheteur_nom
    FROM avis a JOIN buyers b ON b.id = a.buyer_id
    WHERE a.seller_id = ? ORDER BY a.created_at DESC
  `).all(params.id);
  const moyenne = rows.length > 0 ? rows.reduce((s, r) => s + r.note, 0) / rows.length : null;
  send(res, 200, { avis: rows, moyenne, total: rows.length });
});

// Statistiques publiques — calculées en direct depuis les vraies données,
// jamais de chiffre inventé. Grandissent naturellement avec l'usage réel.
router.get("/api/stats-publiques", (req, res) => {
  const vendeursVerifies = db.prepare(`SELECT COUNT(*) AS n FROM sellers WHERE kyc_statut = 'valide'`).get().n;
  const filieresActives = db.prepare(`SELECT COUNT(DISTINCT filiere) AS n FROM products WHERE statut = 'disponible'`).get().n;
  const commandesReussies = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE statut = 'cloture'`).get().n;
  const montantSecurise = db.prepare(`SELECT COALESCE(SUM(montant_total_fcfa),0) AS s FROM orders WHERE statut IN ('sequestre','expedie','en_controle')`).get().s;
  send(res, 200, {
    vendeurs_verifies: vendeursVerifies,
    filieres_disponibles: 8, // fixe : nombre de filières supportées par la plateforme, indépendant du volume réel
    commandes_reussies: commandesReussies,
    montant_securise_fcfa: montantSecurise,
  });
});

router.get("/api/health", (req, res) => send(res, 200, { ok: true, filiere_v1: "cacao", commission: COMMISSION_TAUX }));

// ---------- Plomberie HTTP ----------

function send(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(json);
}

// Verrou d'accès au site entier — utile pendant la phase de test avant
// lancement réel (le lien Railway est public dès sa création). Séparé des
// comptes vendeur/acheteur/admin de l'app : c'est une porte devant tout le
// reste. Désactivé par défaut ; s'active dès que SITE_PASSWORD est réglé.
const SITE_USER = process.env.SITE_USER || "agrisecur";
const SITE_PASSWORD = process.env.SITE_PASSWORD || null;

function verifierAccesSite(req, res) {
  if (!SITE_PASSWORD) return true; // verrou désactivé
  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const decode = Buffer.from(header.slice(6), "base64").toString();
    const i = decode.indexOf(":");
    const egal = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());
    if (i > 0 && egal(decode.slice(0, i), SITE_USER) && egal(decode.slice(i + 1), SITE_PASSWORD)) return true;
  }
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="AgriSecur - acces restreint"', "Content-Type": "text/plain; charset=utf-8" });
  res.end("Accès restreint — identifiants requis.");
  return false;
}

// En-têtes de sécurité posés sur toutes les réponses (statiques et API).
// CSP : les pages gardent leurs scripts inline ('unsafe-inline'), mais ne
// peuvent charger du code, des styles ou des polices que depuis le site et
// Google Fonts, et ne peuvent envoyer de données qu'au site lui-même
// (connect-src 'self') : un script injecté ne pourrait pas exfiltrer un jeton.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "connect-src 'self' https://api.open-meteo.com",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
const EN_TETES_SECURITE = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const server = http.createServer((req, res) => {
  // Filet de sécurité : aucune erreur imprévue pendant le traitement d'une
  // requête ne doit pouvoir arrêter le serveur pour tous les utilisateurs.
  try {
    traiterRequete(req, res);
  } catch (err) {
    console.error("[requête]", err);
    if (!res.headersSent) send(res, 500, { error: "erreur serveur" });
    else res.end();
  }
});

function traiterRequete(req, res) {
  for (const [nom, valeur] of Object.entries(EN_TETES_SECURITE)) res.setHeader(nom, valeur);
  if (req.method === "OPTIONS") return send(res, 204, {});
  // /api/health reste accessible pour le contrôle de santé de l'hébergeur.
  if (!req.url.startsWith("/api/health") && !verifierAccesSite(req, res)) return;

  // L'adresse est lue avec une base fixe : un en-tête Host invalide (« [bad »)
  // faisait lever une exception non rattrapée et arrêtait tout le serveur.
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return send(res, 400, { error: "adresse invalide" });
  }

  if (req.method === "GET" && !url.pathname.startsWith("/api")) {
    if (FICHIERS_APP_ADMIN[url.pathname]) return servirAppAdmin(res, url.pathname);
    if (url.pathname === "/depot" || url.pathname === "/depot/") return serveStatic(req, res, "/depot.html");
    if (serveStatic(req, res, url.pathname)) return;
  }

  const found = match(req.method, url.pathname);
  if (!found) return send(res, 404, { error: "route inconnue" });

  let raw = "";
  let tropVolumineux = false;
  const TAILLE_MAX_OCTETS = 4 * 1024 * 1024; // 4 Mo — large marge au-dessus des 2 photos compressées les plus grosses possibles
  req.on("data", (chunk) => {
    if (tropVolumineux) return;
    raw += chunk;
    if (Buffer.byteLength(raw) > TAILLE_MAX_OCTETS) {
      tropVolumineux = true;
      send(res, 413, { error: "Requête trop volumineuse (4 Mo max) — réessayez avec une photo moins lourde." });
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tropVolumineux) return;
    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "JSON invalide" }); }
      if (body === null || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { error: "JSON invalide" });
    }
    // Les handlers async rejettent une promesse au lieu de lever : on
    // intercepte les deux cas. Le détail de l'erreur reste dans les journaux.
    const erreurServeur = (err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: "erreur serveur" });
      else res.end();
    };
    try {
      Promise.resolve(found.handler(req, res, found.params, body)).catch(erreurServeur);
    } catch (err) {
      erreurServeur(err);
    }
  });
}

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`AgriSecur MVP API — écoute sur http://localhost:${PORT}`));

// ---------- Tâche planifiée : libération automatique des fonds ----------
// Sans ceci, une commande "en_controle" resterait bloquée indéfiniment si
// l'acheteur ne valide jamais et n'ouvre jamais de réclamation — alors que
// l'Article 4 des CGU/CGV promet une libération automatique après le délai
// de contestation. Tourne dans le process du serveur (zéro dépendance
// externe) ; réglable via CRON_INTERVAL_MINUTES. En production, préférez un
// vrai ordonnanceur externe (cron système, tâche planifiée du fournisseur
// cloud) qui survit à un redémarrage du serveur, plutôt que ce setInterval.
const CRON_INTERVAL_MINUTES = Number(process.env.CRON_INTERVAL_MINUTES || 5);

// Filet de sécurité : si l'acheteur ne confirme jamais la réception, on
// ouvre quand même la fenêtre de contestation une fois le délai de livraison
// estimé dépassé (+ marge) — pour ne pas bloquer indéfiniment le paiement du
// vendeur face à un acheteur injoignable ou de mauvaise foi.
const MARGE_LIVRAISON_JOURS = 2;

function ouvrirControleSiLivraisonDepassee(order) {
  if (order.statut !== "expedie") return false;
  const expedition = new Date(order.expedie_at);
  const limite = new Date(expedition.getTime() + (order.delai_livraison_estime_jours + MARGE_LIVRAISON_JOURS) * 24 * 3600 * 1000);
  if (new Date() < limite) return false;

  const now = new Date().toISOString();
  db.prepare(`UPDATE orders SET statut = 'en_controle', controle_ouvert_at = ? WHERE id = ?`).run(now, order.id);
  logEvent(order.id, "reception_presumee",
    `Réception présumée — délai de livraison estimé (${order.delai_livraison_estime_jours}j) + marge dépassé sans confirmation de l'acheteur. Fenêtre de contestation ouverte automatiquement.`);
  return true;
}

async function executerVerificationDelais() {
  const expedies = db.prepare(`SELECT * FROM orders WHERE statut = 'expedie'`).all();
  let ouvertes = 0;
  for (const order of expedies) {
    if (ouvrirControleSiLivraisonDepassee(order)) ouvertes++;
  }

  const enControle = db.prepare(`SELECT * FROM orders WHERE statut = 'en_controle'`).all();
  let cloturees = 0;
  for (const order of enControle) {
    if (await cloturerSiDelaiExpire(order)) cloturees++;
  }

  if (expedies.length > 0 || enControle.length > 0) {
    console.log(`[tâche planifiée] ${expedies.length} commande(s) en transit vérifiée(s) (${ouvertes} contrôle ouvert), ${enControle.length} en contrôle vérifiée(s) (${cloturees} clôturée(s)).`);
  }
}

setInterval(() => executerVerificationDelais().catch((err) => console.error("[tâche planifiée] erreur :", err.message)), CRON_INTERVAL_MINUTES * 60 * 1000);
executerVerificationDelais().catch((err) => console.error("[tâche planifiée] erreur au démarrage :", err.message)); // premier passage immédiat au démarrage

// Vérifie les analyses WHISP en cours et récupère leur résultat. Toute
// analyse bloquée plus de 30 minutes passe en erreur (le vendeur peut relancer).
const WHISP_TIMEOUT_MINUTES = 30;
const WHISP_INTERVAL_SECONDES = Number(process.env.WHISP_INTERVAL_SECONDES || 60);

async function executerVerificationWhisp() {
  if (!WHISP_ACTIF) return;
  const enCours = db.prepare(`SELECT * FROM products WHERE whisp_statut = 'en_cours'`).all();
  for (const product of enCours) {
    const depuisMin = (Date.now() - new Date(product.whisp_soumis_le || 0).getTime()) / 60000;
    if (depuisMin > WHISP_TIMEOUT_MINUTES) {
      db.prepare(`UPDATE products SET whisp_statut = 'erreur', whisp_token = NULL WHERE id = ?`).run(product.id);
      continue;
    }
    if (!product.whisp_token) continue; // soumission encore en vol
    try {
      const r = await verifierStatutWhisp(product.whisp_token);
      if (!r.termine) continue;
      if (r.erreur) db.prepare(`UPDATE products SET whisp_statut = 'erreur', whisp_token = NULL WHERE id = ?`).run(product.id);
      else enregistrerResultatWhisp(product, r.resultat);
    } catch (err) {
      console.error(`[whisp] erreur de vérification pour le lot ${product.id} :`, err.message);
    }
  }
}
setInterval(() => executerVerificationWhisp().catch((err) => console.error("[whisp] erreur :", err.message)), WHISP_INTERVAL_SECONDES * 1000);
executerVerificationWhisp().catch(() => {});
