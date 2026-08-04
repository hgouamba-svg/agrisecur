// server.js — API AgriSecur MVP (filière cacao, V1)
//
// Portée volontairement réduite, conformément à la priorisation V1 du cahier
// des charges : catalogue + tunnel séquestre + KYC de base. Pas d'espace
// vendeur enrichi, pas de paiement réel branché (cf. README pour la suite).
//
// Écrit sans dépendance npm externe (http natif + node:sqlite) pour tourner
// sans `npm install`, y compris hors-ligne.

const http = require("http");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { router, match } = require("./router");
const { hashPassword, verifyPassword, createSession, getSession, ADMIN_KEY } = require("./auth");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serveStatic(req, res, pathname) {
  const filePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) return false; // anti path-traversal
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) return false;
  const ext = path.extname(fullPath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(fs.readFileSync(fullPath));
  return true;
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

function isAdmin(req) {
  return req.headers["x-admin-key"] === ADMIN_KEY;
}

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
//   PROMO_ACTIVE=false node server.js   → désactive la promo à tout moment
//   PROMO_SEUIL_VENDEURS=50 PROMO_COMMISSION_TAUX=0 node server.js
const PROMO_ACTIVE = process.env.PROMO_ACTIVE !== "false"; // activée par défaut
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

function logEvent(orderId, type, detail = null) {
  db.prepare(`INSERT INTO order_events (order_id, type, detail) VALUES (?, ?, ?)`).run(orderId, type, detail);
}

function getOrder(id) {
  const order = db.prepare(`
    SELECT o.*, p.nom AS produit_nom, p.filiere AS filiere, p.mode_livraison AS mode_livraison
    FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.id = ?
  `).get(id);
  if (!order) return null;
  const events = db.prepare(`SELECT * FROM order_events WHERE order_id = ? ORDER BY id ASC`).all(id);
  return { ...order, events };
}

// ---------- Authentification ----------

router.post("/api/auth/register-seller", (req, res, params, body) => {
  const { nom, type, localisation, rccm, email, password } = body;
  if (!nom || !type || !email || !password) return send(res, 400, { error: "nom, type, email, password requis" });
  const existing = db.prepare(`SELECT id FROM sellers WHERE email = ?`).get(email);
  if (existing) return send(res, 409, { error: "un compte vendeur existe déjà avec cet email" });

  const estFondateur = promoEnrolementOuvert() ? 1 : 0;

  const info = db.prepare(
    `INSERT INTO sellers (nom, type, localisation, rccm, email, password_hash, vendeur_fondateur) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(nom, type, localisation || null, rccm || null, email, hashPassword(password), estFondateur);
  const seller = db.prepare(`SELECT id, nom, type, localisation, rccm, email, kyc_statut, abonnement_pro_jusqua, vendeur_fondateur, created_at FROM sellers WHERE id = ?`).get(info.lastInsertRowid);
  const token = createSession("seller", seller.id);
  send(res, 201, { token, user: seller });
});

function photoValide(dataUrl) {
  return typeof dataUrl === "string" && dataUrl.startsWith("data:image/") && dataUrl.length <= 900000;
}

function genererCodeParrainage() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (db.prepare(`SELECT 1 FROM buyers WHERE code_parrainage = ?`).get(code));
  return code;
}

router.post("/api/auth/register-buyer", (req, res, params, body) => {
  const { nom, type, email, password, code_parrainage_saisi } = body;
  if (!nom || !email || !password) return send(res, 400, { error: "nom, email, password requis" });
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
  const { role, email, password } = body;
  if (!["seller", "buyer"].includes(role) || !email || !password) return send(res, 400, { error: "role, email, password requis" });
  const table = role === "seller" ? "sellers" : "buyers";
  const user = db.prepare(`SELECT * FROM ${table} WHERE email = ?`).get(email);
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    return send(res, 401, { error: "identifiants invalides" });
  }
  const token = createSession(role, user.id);
  delete user.password_hash;
  send(res, 200, { token, user });
});

router.post("/api/auth/change-password", (req, res, params, body) => {
  const auth = getAuth(req);
  if (!auth) return send(res, 401, { error: "connexion requise" });
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) return send(res, 400, { error: "mot de passe actuel et nouveau mot de passe requis" });
  if (newPassword.length < 6) return send(res, 400, { error: "le nouveau mot de passe doit faire au moins 6 caractères" });

  const table = auth.type === "seller" ? "sellers" : "buyers";
  const user = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(auth.id);
  if (!user.password_hash || !verifyPassword(currentPassword, user.password_hash)) {
    return send(res, 401, { error: "mot de passe actuel incorrect" });
  }
  db.prepare(`UPDATE ${table} SET password_hash = ? WHERE id = ?`).run(hashPassword(newPassword), auth.id);
  send(res, 200, { ok: true });
});

// ---------- Vendeurs (KYC) ----------


router.post("/api/sellers/:id/kyc", (req, res, params, body) => {
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  const { statut } = body;
  if (!["valide", "rejete"].includes(statut)) return send(res, 400, { error: "statut invalide" });
  db.prepare(`UPDATE sellers SET kyc_statut = ? WHERE id = ?`).run(statut, params.id);
  send(res, 200, db.prepare(`SELECT id, nom, type, localisation, kyc_statut FROM sellers WHERE id = ?`).get(params.id));
});

router.get("/api/sellers/me", (req, res) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  const seller = db.prepare(`SELECT id, nom, type, localisation, rccm, email, kyc_statut, abonnement_pro_jusqua, vendeur_fondateur, created_at FROM sellers WHERE id = ?`).get(auth.id);
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
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  send(res, 200, db.prepare(
    `SELECT id, nom, type, localisation, rccm, email, kyc_statut, created_at FROM sellers ORDER BY created_at DESC`
  ).all());
});

router.get("/api/admin/buyers", (req, res) => {
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  send(res, 200, db.prepare(
    `SELECT id, nom, type, email, created_at FROM buyers ORDER BY created_at DESC`
  ).all());
});

function genererMotDePasseTemporaire() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

router.post("/api/admin/sellers/:id/reset-password", (req, res, params) => {
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  const seller = db.prepare(`SELECT id FROM sellers WHERE id = ?`).get(params.id);
  if (!seller) return send(res, 404, { error: "vendeur introuvable" });
  const temp = genererMotDePasseTemporaire();
  db.prepare(`UPDATE sellers SET password_hash = ? WHERE id = ?`).run(hashPassword(temp), params.id);
  send(res, 200, { mot_de_passe_temporaire: temp });
});

router.post("/api/admin/buyers/:id/reset-password", (req, res, params) => {
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  const buyer = db.prepare(`SELECT id FROM buyers WHERE id = ?`).get(params.id);
  if (!buyer) return send(res, 404, { error: "acheteur introuvable" });
  const temp = genererMotDePasseTemporaire();
  db.prepare(`UPDATE buyers SET password_hash = ? WHERE id = ?`).run(hashPassword(temp), params.id);
  send(res, 200, { mot_de_passe_temporaire: temp });
});

router.get("/api/admin/virements-en-attente", (req, res) => {
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
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
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  if (order.statut !== "attente_virement") return send(res, 409, { error: "cette commande n'est pas en attente de virement" });

  db.prepare(`UPDATE orders SET statut = 'sequestre' WHERE id = ?`).run(order.id);
  logEvent(order.id, "confirmation_virement",
    `Virement de ${order.montant_total_fcfa} FCFA confirmé reçu (réf. ${order.virement_reference}) — fonds désormais en séquestre`);
  send(res, 200, getOrder(order.id));
});

router.get("/api/admin/depenses", (req, res) => {
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  const rows = db.prepare(`SELECT * FROM depenses ORDER BY date_depense DESC, id DESC`).all();
  const total = db.prepare(`SELECT COALESCE(SUM(montant_fcfa),0) AS total FROM depenses`).get().total;
  send(res, 200, { depenses: rows, total_fcfa: total });
});

router.post("/api/admin/depenses", (req, res, params, body) => {
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  const { categorie, description, montant_fcfa, date_depense } = body;
  if (!categorie || !montant_fcfa || !date_depense) return send(res, 400, { error: "categorie, montant_fcfa, date_depense requis" });
  const info = db.prepare(`INSERT INTO depenses (categorie, description, montant_fcfa, date_depense) VALUES (?, ?, ?, ?)`)
    .run(categorie, description || null, montant_fcfa, date_depense);
  send(res, 201, db.prepare(`SELECT * FROM depenses WHERE id = ?`).get(info.lastInsertRowid));
});

router.post("/api/admin/depenses/:id/supprimer", (req, res, params) => {
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  const existe = db.prepare(`SELECT id FROM depenses WHERE id = ?`).get(params.id);
  if (!existe) return send(res, 404, { error: "dépense introuvable" });
  db.prepare(`DELETE FROM depenses WHERE id = ?`).run(params.id);
  send(res, 200, { ok: true });
});

function genererCsv(colonnes, lignes) {
  const echapper = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const entete = colonnes.map(echapper).join(";");
  const corps = lignes.map((ligne) => ligne.map(echapper).join(";")).join("\n");
  return entete + "\n" + corps;
}

router.get("/api/admin/export/commandes.csv", (req, res) => {
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
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
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  const rows = db.prepare(`SELECT * FROM depenses ORDER BY date_depense DESC`).all();
  const csv = genererCsv(
    ["ID", "Date", "Catégorie", "Description", "Montant FCFA"],
    rows.map((r) => [r.id, r.date_depense, r.categorie, r.description, r.montant_fcfa])
  );
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=agrisecur-depenses.csv" });
  res.end("\uFEFF" + csv);
});

router.get("/api/admin/marge-nette", (req, res) => {
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });

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
  const totalSva = db.prepare(`SELECT COALESCE(SUM(montant_fcfa),0) AS total FROM sva_achats`).get().total;
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
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  const total = db.prepare(`SELECT COALESCE(SUM(montant_fcfa),0) AS total, COUNT(*) AS n FROM sva_achats`).get();
  const parType = db.prepare(`SELECT type, COUNT(*) AS n, COALESCE(SUM(montant_fcfa),0) AS total FROM sva_achats GROUP BY type`).all();
  const recents = db.prepare(`
    SELECT sva.*, s.nom AS vendeur_nom FROM sva_achats sva JOIN sellers s ON s.id = sva.seller_id
    ORDER BY sva.created_at DESC LIMIT 20
  `).all();
  send(res, 200, { total_fcfa: total.total, nb_achats: total.n, par_type: parType, recents });
});

// ---------- Catalogue ----------

router.post("/api/products", (req, res, params, body) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  const seller = db.prepare(`SELECT * FROM sellers WHERE id = ?`).get(auth.id);
  if (seller.kyc_statut !== "valide") return send(res, 403, { error: "KYC vendeur non validé — impossible de publier un lot" });

  const { nom, quantite_kg, prix_unitaire_fcfa, filiere, mode_livraison, prix_avec_transport_fcfa, photo_url, parcelle_latitude, parcelle_longitude, declaration_non_deforestation } = body;
  if (!nom || !quantite_kg || !prix_unitaire_fcfa) return send(res, 400, { error: "nom, quantite_kg, prix_unitaire_fcfa requis" });
  if (mode_livraison && !["acheteur", "vendeur", "a_convenir"].includes(mode_livraison)) {
    return send(res, 400, { error: "mode_livraison invalide" });
  }
  if (prix_avec_transport_fcfa && prix_avec_transport_fcfa < prix_unitaire_fcfa) {
    return send(res, 400, { error: "le prix avec transport doit être supérieur ou égal au prix sans transport" });
  }
  if (photo_url && (!photo_url.startsWith("data:image/") || photo_url.length > 900000)) {
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

// ---------- SVA : mise en avant de lots & abonnement Vendeur Pro ----------

router.get("/api/frais-paiement", (req, res) => {
  send(res, 200, { mobile_money_taux: MOBILE_MONEY_FRAIS_TAUX, virement_fcfa: VIREMENT_FRAIS_FCFA, parrainage_credit_fcfa: REFERRAL_CREDIT_FCFA });
});

router.get("/api/sva/tarifs", (req, res) => {
  send(res, 200, { boost: BOOST_TARIFS, abonnement_pro: { fcfa: ABONNEMENT_PRO_FCFA, duree_jours: ABONNEMENT_PRO_DUREE_JOURS } });
});

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

  const base = new Date(product.mis_en_avant_jusqua && new Date(product.mis_en_avant_jusqua) > new Date() ? product.mis_en_avant_jusqua : Date.now());
  const jusqua = new Date(base.getTime() + jours * 24 * 3600 * 1000).toISOString();
  db.prepare(`UPDATE products SET mis_en_avant_jusqua = ? WHERE id = ?`).run(jusqua, product.id);
  db.prepare(`INSERT INTO sva_achats (seller_id, type, description, montant_fcfa) VALUES (?, 'boost', ?, ?)`)
    .run(auth.id, `Mise en avant ${jours}j — lot "${product.nom}"`, montant);

  send(res, 200, { ...db.prepare(`SELECT * FROM products WHERE id = ?`).get(product.id), montant_paye_fcfa: montant });
});

router.post("/api/sellers/me/abonnement-pro", (req, res) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "seller") return send(res, 401, { error: "connexion vendeur requise" });
  const seller = db.prepare(`SELECT * FROM sellers WHERE id = ?`).get(auth.id);

  const base = new Date(seller.abonnement_pro_jusqua && new Date(seller.abonnement_pro_jusqua) > new Date() ? seller.abonnement_pro_jusqua : Date.now());
  const jusqua = new Date(base.getTime() + ABONNEMENT_PRO_DUREE_JOURS * 24 * 3600 * 1000).toISOString();
  db.prepare(`UPDATE sellers SET abonnement_pro_jusqua = ? WHERE id = ?`).run(jusqua, auth.id);
  db.prepare(`INSERT INTO sva_achats (seller_id, type, description, montant_fcfa) VALUES (?, 'abonnement_pro', ?, ?)`)
    .run(auth.id, `Abonnement Vendeur Pro — ${ABONNEMENT_PRO_DUREE_JOURS} jours`, ABONNEMENT_PRO_FCFA);

  send(res, 200, { abonnement_pro_jusqua: jusqua, montant_paye_fcfa: ABONNEMENT_PRO_FCFA });
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
  const sva = db.prepare(`SELECT COALESCE(SUM(montant_fcfa),0) AS total FROM sva_achats WHERE seller_id = ?`).get(auth.id);

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

// Prix du marché — public, calculé en temps réel à partir des lots actifs.
// Pas de flux de données externe (aucune API de prix agricoles librement
// disponible en Côte d'Ivoire) : ce sont les vrais prix constatés sur la
// plateforme, filière par filière.
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

router.post("/api/orders", (req, res, params, body) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "buyer") return send(res, 401, { error: "connexion acheteur requise" });

  const { product_id, quantite_kg, avec_transport, mode_paiement, virement_reference } = body;
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
  let creditUtilise = 0;
  if (fraisPaiement > 0) {
    const acheteur = db.prepare(`SELECT credit_parrainage_fcfa FROM buyers WHERE id = ?`).get(auth.id);
    if (acheteur.credit_parrainage_fcfa > 0) {
      creditUtilise = Math.min(acheteur.credit_parrainage_fcfa, fraisPaiement);
      fraisPaiement -= creditUtilise;
      db.prepare(`UPDATE buyers SET credit_parrainage_fcfa = credit_parrainage_fcfa - ? WHERE id = ?`).run(creditUtilise, auth.id);
    }
  }

  const info = db.prepare(`
    INSERT INTO orders (product_id, buyer_id, seller_id, quantite_kg, montant_total_fcfa, avec_transport,
      mode_paiement, virement_reference, frais_paiement_fcfa, commission_taux, commission_fcfa, montant_net_vendeur_fcfa, statut)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(product_id, auth.id, product.seller_id, quantite_kg, montant_total, wantsTransport ? 1 : 0,
         paiement, virement_reference || null, fraisPaiement, tauxApplique, commission, net_vendeur, statutInitial);

  db.prepare(`UPDATE products SET statut = 'reserve' WHERE id = ?`).run(product_id);
  if (creditUtilise > 0) {
    logEvent(info.lastInsertRowid, "creation", `Crédit de parrainage appliqué : ${creditUtilise} FCFA déduits des frais de traitement.`);
  }
  if (paiement === "virement") {
    logEvent(info.lastInsertRowid, "creation",
      `Commande créée par virement bancaire (réf. ${virement_reference}) — ${montant_total} FCFA en attente de confirmation de réception`);
  } else {
    logEvent(info.lastInsertRowid, "creation",
      `Commande créée (${wantsTransport ? "avec" : "sans"} transport) — ${montant_total} FCFA débités et bloqués en compte séquestre + ${fraisPaiement} FCFA de frais de traitement mobile money`);
  }
  send(res, 201, getOrder(info.lastInsertRowid));
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
  if (!photo_reclamation_url) return send(res, 400, { error: "une photo du problème constaté est requise pour ouvrir une réclamation" });
  if (!photoValide(photo_reclamation_url)) return send(res, 400, { error: "photo invalide ou trop volumineuse (compressez avant envoi)" });

  db.prepare(`UPDATE orders SET statut = 'litige', photo_reclamation_url = ? WHERE id = ?`).run(photo_reclamation_url, order.id);
  logEvent(order.id, "reclamation", `${motif} (photo de preuve jointe)`);
  send(res, 200, getOrder(order.id));
});

// Récompense le parrain quand son filleul clôture son tout premier achat.
// Le crédit versé est appliqué automatiquement (cf. création de commande)
// sur les frais mobile money de la prochaine commande du parrain.
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

router.post("/api/orders/:id/trancher-litige", (req, res, params, body) => {
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office (clé admin requise)" });
  const { resolution, note } = body;
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  if (order.statut !== "litige") return send(res, 409, { error: "aucun litige en cours sur cette commande" });
  if (!["rembourse", "cloture"].includes(resolution)) return send(res, 400, { error: "resolution invalide" });

  const now = new Date().toISOString();
  db.prepare(`UPDATE orders SET statut = ?, cloture_at = ? WHERE id = ?`).run(resolution, now, order.id);
  db.prepare(`UPDATE products SET statut = ? WHERE id = ?`).run(resolution === "cloture" ? "vendu" : "disponible", order.product_id);
  logEvent(order.id, "mediation", `Litige tranché : ${resolution}${note ? " — " + note : ""}`);
  if (resolution === "cloture") recompenserParrainageSiPremierAchat(order.buyer_id);
  send(res, 200, getOrder(order.id));
});

router.post("/api/orders/:id/cloturer", (req, res, params) => {
  const auth = getAuth(req);
  if (!auth || auth.type !== "buyer") return send(res, 401, { error: "connexion acheteur requise" });
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  if (order.buyer_id !== auth.id) return send(res, 403, { error: "cette commande n'appartient pas à cet acheteur" });
  if (!["expedie", "en_controle"].includes(order.statut)) return send(res, 409, { error: `clôture impossible depuis l'état '${order.statut}'` });

  const now = new Date().toISOString();
  db.prepare(`UPDATE orders SET statut = 'cloture', cloture_at = ? WHERE id = ?`).run(now, order.id);
  db.prepare(`UPDATE products SET statut = 'vendu' WHERE id = ?`).run(order.product_id);
  logEvent(order.id, "liberation_fonds", `Fonds nets (${order.montant_net_vendeur_fcfa} FCFA) libérés au vendeur — validation acheteur`);
  recompenserParrainageSiPremierAchat(order.buyer_id);
  send(res, 200, getOrder(order.id));
});

// Vérifie une commande "en_controle" et clôture automatiquement si le délai
// de contestation est expiré — utilisée à la fois par la route manuelle et
// par la tâche planifiée interne (cf. fin du fichier).
function cloturerSiDelaiExpire(order) {
  if (order.statut !== "en_controle") return false;
  const ouverture = new Date(order.controle_ouvert_at);
  const limite = new Date(ouverture.getTime() + order.delai_contestation_heures * 3600 * 1000);
  if (new Date() < limite) return false;

  const now = new Date().toISOString();
  db.prepare(`UPDATE orders SET statut = 'cloture', cloture_at = ? WHERE id = ?`).run(now, order.id);
  db.prepare(`UPDATE products SET statut = 'vendu' WHERE id = ?`).run(order.product_id);
  logEvent(order.id, "liberation_fonds",
    `Fonds nets (${order.montant_net_vendeur_fcfa} FCFA) libérés au vendeur — délai de contestation expiré (vérification automatique)`);
  recompenserParrainageSiPremierAchat(order.buyer_id);
  return true;
}

router.post("/api/orders/:id/verifier-delai", (req, res, params) => {
  if (!isAdmin(req)) return send(res, 403, { error: "réservé au back-office / job planifié (clé admin requise)" });
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  cloturerSiDelaiExpire(order);
  send(res, 200, getOrder(order.id));
});

router.get("/api/orders/:id", (req, res, params) => {
  const auth = getAuth(req);
  const order = getOrder(params.id);
  if (!order) return send(res, 404, { error: "commande introuvable" });
  const owns = auth && ((auth.type === "seller" && auth.id === order.seller_id) || (auth.type === "buyer" && auth.id === order.buyer_id));
  if (!owns && !isAdmin(req)) return send(res, 403, { error: "accès réservé aux parties de la commande" });
  send(res, 200, order);
});

router.get("/api/orders", (req, res) => {
  const auth = getAuth(req);
  if (isAdmin(req)) return send(res, 200, db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all());
  if (!auth) return send(res, 401, { error: "connexion requise" });
  const col = auth.type === "seller" ? "seller_id" : "buyer_id";
  send(res, 200, db.prepare(`SELECT * FROM orders WHERE ${col} = ? ORDER BY created_at DESC`).all(auth.id));
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
    const [user, pass] = Buffer.from(header.slice(6), "base64").toString().split(":");
    if (user === SITE_USER && pass === SITE_PASSWORD) return true;
  }
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="AgriSecur - acces restreint"', "Content-Type": "text/plain; charset=utf-8" });
  res.end("Accès restreint — identifiants requis.");
  return false;
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (!verifierAccesSite(req, res)) return;

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && !url.pathname.startsWith("/api")) {
    if (serveStatic(req, res, url.pathname)) return;
  }

  const found = match(req.method, url.pathname);
  if (!found) return send(res, 404, { error: "route inconnue" });

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "JSON invalide" }); }
    }
    try {
      found.handler(req, res, found.params, body);
    } catch (err) {
      console.error(err);
      send(res, 500, { error: "erreur serveur", detail: err.message });
    }
  });
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

function executerVerificationDelais() {
  const expedies = db.prepare(`SELECT * FROM orders WHERE statut = 'expedie'`).all();
  let ouvertes = 0;
  for (const order of expedies) {
    if (ouvrirControleSiLivraisonDepassee(order)) ouvertes++;
  }

  const enControle = db.prepare(`SELECT * FROM orders WHERE statut = 'en_controle'`).all();
  let cloturees = 0;
  for (const order of enControle) {
    if (cloturerSiDelaiExpire(order)) cloturees++;
  }

  if (expedies.length > 0 || enControle.length > 0) {
    console.log(`[tâche planifiée] ${expedies.length} commande(s) en transit vérifiée(s) (${ouvertes} contrôle ouvert), ${enControle.length} en contrôle vérifiée(s) (${cloturees} clôturée(s)).`);
  }
}

setInterval(executerVerificationDelais, CRON_INTERVAL_MINUTES * 60 * 1000);
executerVerificationDelais(); // premier passage immédiat au démarrage
