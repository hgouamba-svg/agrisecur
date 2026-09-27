// audit.js — outil d'Audit RDUE express (back-office uniquement)
//
// L'administrateur dépose le fichier de parcelles d'une coopérative (converti en
// GeoJSON par l'app admin). Le serveur :
//   1. contrôle la qualité de chaque parcelle (audit-controles.js) ;
//   2. envoie toutes les parcelles analysables à WHISP (FAO / Open Foris) en UNE
//      demande asynchrone (jusqu'à 5 000 parcelles par demande) ;
//   3. récupère le résultat dès qu'il est prêt (WHISP ne le garde que quelques
//      minutes : on interroge toutes les 20 secondes) et l'enregistre ;
//   4. permet d'exporter un tableau parcelle par parcelle (CSV pour Excel).
//
// WHISP fournit une INDICATION de risque à partir de données satellite
// publiques, « telle quelle », sans garantie : ce n'est pas une certification.

const { controlerParcelles } = require("./audit-controles");

const FILIERES_PERENNES = ["cacao", "cafe", "anacarde", "hevea", "palmier", "fruits"];
const FILIERES = ["cacao", "cafe", "anacarde", "hevea", "palmier", "autre"];
const MAX_PARCELLES = 5000;         // limite d'une demande asynchrone WHISP
const WHISP_DELAI_MAX_MIN = 20;     // au-delà : considéré en échec
const WHISP_INTERVALLE_S = 20;

module.exports = function installerAudit({ router, db, send, isAdminAvecLimite, limiterTentatives, envoyerEmail, whispKey, whispBase }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client TEXT NOT NULL,
      pays TEXT NOT NULL,
      filiere TEXT NOT NULL,
      fichier TEXT,
      cree_le TEXT NOT NULL,
      nb_parcelles INTEGER NOT NULL,
      resume TEXT NOT NULL,
      parcelles TEXT NOT NULL,
      geojson TEXT NOT NULL,
      whisp_statut TEXT NOT NULL,
      whisp_token TEXT,
      whisp_soumis_le TEXT,
      whisp_termine_le TEXT,
      whisp_erreur TEXT,
      resultats TEXT
    );
  `);

  // Colonnes ajoutées après la première version (dépôt par le client, notifications).
  for (const col of ["source TEXT NOT NULL DEFAULT 'admin'", "email_client TEXT", "notifie_le TEXT"]) {
    try { db.exec(`ALTER TABLE audits ADD COLUMN ${col}`); } catch { /* colonne déjà présente */ }
  }

  const whispActif = !!whispKey;
  const EMAIL_NOTIF = process.env.AUDIT_NOTIF_EMAIL || process.env.CONTACT_EMAIL || "contact@agrisecur.com";
  const entetes = () => ({ "x-api-key": whispKey, "Content-Type": "application/json", "x-whisp-agent": "agrisecur-audit" });

  async function lireEnveloppe(res) {
    const texte = await res.text().catch(() => "");
    try { return JSON.parse(texte); } catch { return { code: null, message: texte.slice(0, 300) }; }
  }

  function niveauRisque(props, filiere) {
    const cles = FILIERES_PERENNES.includes(filiere) ? ["risk_pcrop", "risk_acrop"] : ["risk_acrop", "risk_pcrop"];
    for (const c of cles) {
      if (props && props[c]) {
        const brut = String(props[c]).toLowerCase();
        if (brut.includes("low")) return "faible";
        if (brut.includes("high")) return "eleve";
        return "info_manquante";
      }
    }
    return "indetermine";
  }

  // Associe chaque résultat WHISP à notre parcelle : identifiant externe si WHISP
  // l'a renvoyé, sinon numéro de parcelle (plotId, compté à partir de 1), sinon ordre.
  function associerResultats(audit, featureCollection) {
    const envoyees = JSON.parse(audit.geojson).features;
    const parcelles = JSON.parse(audit.parcelles);
    const resultats = {};
    const features = (featureCollection && featureCollection.features) || [];
    features.forEach((f, k) => {
      const props = f.properties || {};
      let id = props.agrisecur_id || props.external_id || props.externalId || null;
      if (!id && props.plotId && envoyees[Number(props.plotId) - 1]) id = envoyees[Number(props.plotId) - 1].properties.agrisecur_id;
      if (!id && envoyees[k]) id = envoyees[k].properties.agrisecur_id;
      if (!id) return;
      resultats[id] = { risque: niveauRisque(props, audit.filiere), props };
    });
    // Parcelles analysables sans résultat
    for (const p of parcelles) if (p.analysable && !resultats[p.cle]) resultats[p.cle] = { risque: "indetermine", props: {} };
    return resultats;
  }

  async function soumettre(audit) {
    const fc = JSON.parse(audit.geojson);
    if (!fc.features.length) {
      db.prepare(`UPDATE audits SET whisp_statut = 'aucune_parcelle' WHERE id = ?`).run(audit.id);
      return;
    }
    if (!whispActif) {
      db.prepare(`UPDATE audits SET whisp_statut = 'desactive', whisp_erreur = 'Clé WHISP absente (variable WHISP_API_KEY)' WHERE id = ?`).run(audit.id);
      notifier(audit.id, "ERREUR");
      return;
    }
    const maintenant = new Date().toISOString();
    try {
      const res = await fetch(`${whispBase}/submit/geojson`, {
        method: "POST",
        headers: entetes(),
        body: JSON.stringify({ ...fc, analysisOptions: { nationalCodes: [audit.pays], async: true, externalIdColumn: "agrisecur_id" } }),
      });
      const env = await lireEnveloppe(res);
      if (env.code === "analysis_completed") return terminer(audit, env.data);
      if (["analysis_queued", "analysis_processing"].includes(env.code) && env.data && env.data.token) {
        db.prepare(`UPDATE audits SET whisp_statut = 'en_cours', whisp_token = ?, whisp_soumis_le = ?, whisp_erreur = NULL WHERE id = ?`).run(env.data.token, maintenant, audit.id);
        return;
      }
      throw new Error(`${res.status} ${env.code || ""} ${env.message || ""}`.trim());
    } catch (err) {
      console.error(`[audit] soumission WHISP échouée pour l'audit ${audit.id} :`, err.message);
      db.prepare(`UPDATE audits SET whisp_statut = 'erreur', whisp_erreur = ?, whisp_soumis_le = ? WHERE id = ?`).run(String(err.message).slice(0, 300), maintenant, audit.id);
      notifier(audit.id, "ERREUR");
    }
  }

  function terminer(audit, featureCollection) {
    const frais = db.prepare(`SELECT * FROM audits WHERE id = ?`).get(audit.id);
    const resultats = associerResultats(frais, featureCollection);
    db.prepare(`UPDATE audits SET whisp_statut = 'termine', whisp_token = NULL, whisp_termine_le = ?, resultats = ?, whisp_erreur = NULL WHERE id = ?`)
      .run(new Date().toISOString(), JSON.stringify(resultats), audit.id);
    notifier(audit.id, "RESULTAT");
  }

  // ---- Notifications par e-mail (lues par l'agent Audit RDUE dans Gmail) ----
  // DEPOT : fichier reçu + contrôles de qualité ; RESULTAT : analyse WHISP
  // terminée ; ERREUR : analyse impossible. Le CSV complet est joint.
  function notifier(id, type) {
    const a = db.prepare(`SELECT * FROM audits WHERE id = ?`).get(id);
    if (!a) return;
    const r = resumeAudit(a);
    const lignes = [
      `Audit n°${a.id} — ${a.client}`,
      `Pays : ${a.pays === "gh" ? "Ghana" : "Côte d'Ivoire"} · Filière : ${a.filiere} · Fichier : ${a.fichier || "-"}`,
      `Origine : ${a.source === "client" ? "déposé par le client sur le site" : "lancé depuis le back-office"}${a.email_client ? ` · Contact client : ${a.email_client}` : ""}`,
      "",
      `Parcelles : ${r.resume.total} · sans anomalie : ${r.resume.sans_anomalie} · bloquantes (non analysées) : ${r.resume.bloquantes} · à corriger : ${r.resume.a_corriger} · à vérifier : ${r.resume.a_verifier}`,
    ];
    if (type === "RESULTAT") lignes.push(`Risque de déforestation (WHISP) : faible ${r.risques.faible} · élevé ${r.risques.eleve} · informations manquantes ${r.risques.info_manquante} · indéterminé ${r.risques.indetermine}`, `Analyse terminée en ${r.whisp.duree_secondes ?? "?"} secondes.`);
    if (type === "ERREUR") lignes.push(`Analyse satellite impossible : ${a.whisp_erreur || "raison inconnue"}. Relancez-la depuis le back-office, onglet Audits RDUE.`);
    if (type === "DEPOT") lignes.push("Analyse satellite lancée automatiquement ; un second e-mail « RESULTAT AUDIT » suivra.");
    lignes.push("", "Tableau complet parcelle par parcelle en pièce jointe (CSV, séparateur « ; »).", "WHISP (FAO) fournit une indication sur données publiques, sans garantie : ce n'est pas une certification.");
    envoyerEmail({
      to: EMAIL_NOTIF,
      subject: `${type} AUDIT ${a.client} (n°${a.id})`,
      text: lignes.join("\n"),
      attachments: [{ filename: nomCsv(a), content: csvAudit(a), contentType: "text/csv; charset=utf-8" }],
    }).then((ok) => { if (ok && type !== "DEPOT") db.prepare(`UPDATE audits SET notifie_le = ? WHERE id = ?`).run(new Date().toISOString(), a.id); })
      .catch((e) => console.error(`[audit] e-mail ${type} non envoyé pour l'audit ${a.id} :`, e.message));
  }

  async function verifierEnCours() {
    if (!whispActif) return;
    const enCours = db.prepare(`SELECT * FROM audits WHERE whisp_statut = 'en_cours'`).all();
    for (const audit of enCours) {
      const depuis = (Date.now() - new Date(audit.whisp_soumis_le || 0).getTime()) / 60000;
      if (depuis > WHISP_DELAI_MAX_MIN) {
        db.prepare(`UPDATE audits SET whisp_statut = 'erreur', whisp_token = NULL, whisp_erreur = 'Délai dépassé : relancez l''analyse' WHERE id = ?`).run(audit.id);
        notifier(audit.id, "ERREUR");
        continue;
      }
      if (!audit.whisp_token) continue;
      try {
        const res = await fetch(`${whispBase}/status/${encodeURIComponent(audit.whisp_token)}`, { headers: entetes() });
        const env = await lireEnveloppe(res);
        if (["analysis_queued", "analysis_processing"].includes(env.code)) continue;
        if (env.code === "analysis_completed") { terminer(audit, env.data); continue; }
        db.prepare(`UPDATE audits SET whisp_statut = 'erreur', whisp_token = NULL, whisp_erreur = ? WHERE id = ?`)
          .run(`${res.status} ${env.code || ""} ${env.message || ""}`.trim().slice(0, 300), audit.id);
        notifier(audit.id, "ERREUR");
      } catch (err) {
        console.error(`[audit] vérification WHISP échouée pour l'audit ${audit.id} :`, err.message);
      }
    }
  }
  setInterval(() => verifierEnCours().catch((e) => console.error("[audit]", e.message)), WHISP_INTERVALLE_S * 1000);

  function resumeAudit(a) {
    const resume = JSON.parse(a.resume);
    const risques = { faible: 0, eleve: 0, info_manquante: 0, indetermine: 0 };
    if (a.resultats) for (const r of Object.values(JSON.parse(a.resultats))) risques[r.risque] = (risques[r.risque] || 0) + 1;
    const duree = a.whisp_termine_le && a.whisp_soumis_le ? Math.round((new Date(a.whisp_termine_le) - new Date(a.whisp_soumis_le)) / 1000) : null;
    return {
      id: a.id, client: a.client, pays: a.pays, filiere: a.filiere, fichier: a.fichier, cree_le: a.cree_le,
      source: a.source || "admin", email_client: a.email_client || null, notifie_le: a.notifie_le || null,
      nb_parcelles: a.nb_parcelles, resume, risques,
      whisp: { statut: a.whisp_statut, soumis_le: a.whisp_soumis_le, termine_le: a.whisp_termine_le, duree_secondes: duree, erreur: a.whisp_erreur },
    };
  }

  // ---- Routes ----

  // Test de connexion : une seule parcelle fictive au cœur de la zone cacaoyère.
  router.post("/api/admin/whisp/test", async (req, res, params, body) => {
    if (!isAdminAvecLimite(req, res)) return;
    if (!whispActif) return send(res, 200, { ok: false, message: "Clé WHISP absente : ajoutez la variable WHISP_API_KEY sur Railway." });
    const pays = body && body.pays === "gh" ? "gh" : "ci";
    const point = pays === "gh" ? [-2.047512, 6.201438] : [-6.603517, 5.784391];
    const debut = Date.now();
    try {
      const r = await fetch(`${whispBase}/submit/geojson`, {
        method: "POST", headers: entetes(),
        body: JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: point }, properties: {} }], analysisOptions: { nationalCodes: [pays], async: false } }),
      });
      let env = await lireEnveloppe(r);
      const enCours = (e) => ["analysis_queued", "analysis_processing"].includes(e.code);
      // WHISP peut mettre la demande en file d'attente même en mode direct :
      // on suit alors son avancement pendant 50 secondes au plus.
      const token = env.data && env.data.token;
      while (enCours(env) && token && Date.now() - debut < 50000) {
        await new Promise((ok) => setTimeout(ok, 3000));
        const s = await fetch(`${whispBase}/status/${encodeURIComponent(token)}`, { headers: entetes() });
        env = await lireEnveloppe(s);
      }
      const secondes = Math.round((Date.now() - debut) / 100) / 10;
      if (env.code === "analysis_completed") {
        const props = env.data && env.data.features && env.data.features[0] ? env.data.features[0].properties : {};
        return send(res, 200, { ok: true, secondes, risque: niveauRisque(props, "cacao"), nb_indicateurs: Object.keys(props || {}).length });
      }
      if (enCours(env)) {
        return send(res, 200, { ok: true, secondes, attente: true, message: `Clé WHISP acceptée : l'analyse test est en file d'attente chez WHISP (serveurs occupés, ${secondes} s d'attente). Les audits réels attendent automatiquement leur tour.` });
      }
      return send(res, 200, { ok: false, secondes, message: `WHISP a répondu : ${r.status} ${env.code || ""} ${env.message || ""}`.trim() });
    } catch (err) {
      return send(res, 200, { ok: false, message: "WHISP injoignable : " + err.message });
    }
  });

  // Valide la demande, contrôle les parcelles, enregistre l'audit et lance WHISP.
  // Renvoie { erreur } ou { audit }.
  function creerAudit(body, source, emailClient) {
    const client = String((body && body.client) || "").trim().slice(0, 120);
    const pays = body && ["ci", "gh"].includes(body.pays) ? body.pays : null;
    const filiere = body && FILIERES.includes(body.filiere) ? body.filiere : null;
    const features = body && Array.isArray(body.features) ? body.features : null;
    if (!client) return { erreur: "nom du client manquant" };
    if (!pays) return { erreur: "pays invalide" };
    if (!filiere) return { erreur: "filière invalide" };
    if (!features || !features.length) return { erreur: "aucune parcelle dans le fichier" };
    if (features.length > MAX_PARCELLES) return { erreur: `trop de parcelles (${features.length}) : ${MAX_PARCELLES} au maximum par audit, découpez le fichier` };

    const { parcelles, resume } = controlerParcelles(features, pays);
    // Clé unique par parcelle (l'identifiant du fichier peut être en double).
    const vues = new Map();
    parcelles.forEach((p) => {
      const n = (vues.get(p.id) || 0) + 1; vues.set(p.id, n);
      p.cle = n === 1 ? p.id : `${p.id}#${n}`;
    });
    const aEnvoyer = parcelles.filter((p) => p.analysable).map((p) => ({
      type: "Feature", geometry: features[p.index].geometry, properties: { agrisecur_id: p.cle },
    }));
    const info = db.prepare(`
      INSERT INTO audits (client, pays, filiere, fichier, cree_le, nb_parcelles, resume, parcelles, geojson, whisp_statut, source, email_client)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'a_envoyer', ?, ?)
    `).run(client, pays, filiere, String((body && body.fichier) || "").slice(0, 160), new Date().toISOString(), parcelles.length,
      JSON.stringify(resume), JSON.stringify(parcelles), JSON.stringify({ type: "FeatureCollection", features: aEnvoyer }), source, emailClient || null);
    const audit = db.prepare(`SELECT * FROM audits WHERE id = ?`).get(Number(info.lastInsertRowid));
    if (source === "client") notifier(audit.id, "DEPOT");
    soumettre(audit).catch((e) => console.error("[audit]", e.message));
    return { audit };
  }

  router.post("/api/admin/audits", (req, res, params, body) => {
    if (!isAdminAvecLimite(req, res)) return;
    const r = creerAudit(body, "admin", null);
    if (r.erreur) return send(res, 400, { error: r.erreur });
    send(res, 201, resumeAudit(r.audit));
  });

  // Dépôt public : le client envoie lui-même son fichier depuis le site.
  // Contrôle immédiat + analyse WHISP automatique + e-mails à AgriSecur.
  router.post("/api/depot-audit", (req, res, params, body) => {
    if (!limiterTentatives(req, res, "depot-audit", { max: 6 })) return;
    if (body && body.site_web) return send(res, 201, { ok: true }); // piège à robots
    const email = String((body && body.email) || "").trim().slice(0, 160);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: "adresse e-mail invalide" });
    const r = creerAudit(body, "client", email);
    if (r.erreur) return send(res, 400, { error: r.erreur });
    const { resume } = resumeAudit(r.audit);
    send(res, 201, { ok: true, reference: `AUD-${r.audit.id}`, resume });
  });

  router.get("/api/admin/audits", (req, res) => {
    if (!isAdminAvecLimite(req, res)) return;
    const rows = db.prepare(`SELECT * FROM audits ORDER BY id DESC LIMIT 100`).all();
    send(res, 200, rows.map(resumeAudit));
  });

  router.get("/api/admin/audits/:id", (req, res, params) => {
    if (!isAdminAvecLimite(req, res)) return;
    const a = db.prepare(`SELECT * FROM audits WHERE id = ?`).get(Number(params.id));
    if (!a) return send(res, 404, { error: "audit introuvable" });
    const resultats = a.resultats ? JSON.parse(a.resultats) : {};
    const parcelles = JSON.parse(a.parcelles).map((p) => ({
      id: p.id, cle: p.cle, producteur: p.producteur, type: p.type,
      superficie_declaree_ha: p.superficie_declaree_ha, superficie_mesuree_ha: p.superficie_mesuree_ha,
      anomalies: p.anomalies, risque: resultats[p.cle] ? resultats[p.cle].risque : (p.analysable ? null : "non_analysee"),
    }));
    send(res, 200, { ...resumeAudit(a), parcelles });
  });

  router.post("/api/admin/audits/:id/relancer", (req, res, params) => {
    if (!isAdminAvecLimite(req, res)) return;
    const a = db.prepare(`SELECT * FROM audits WHERE id = ?`).get(Number(params.id));
    if (!a) return send(res, 404, { error: "audit introuvable" });
    if (a.whisp_statut === "en_cours") return send(res, 409, { error: "analyse déjà en cours" });
    db.prepare(`UPDATE audits SET whisp_statut = 'a_envoyer', whisp_token = NULL, whisp_erreur = NULL, resultats = NULL, whisp_termine_le = NULL WHERE id = ?`).run(a.id);
    soumettre(db.prepare(`SELECT * FROM audits WHERE id = ?`).get(a.id)).catch((e) => console.error("[audit]", e.message));
    send(res, 202, { ok: true });
  });

  function celluleCsv(v) {
    if (v === null || v === undefined) return "";
    let s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // évite l'exécution de formules dans Excel
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function csvAudit(a) {
    const resultats = a.resultats ? JSON.parse(a.resultats) : {};
    const parcelles = JSON.parse(a.parcelles);
    const clesWhisp = [...new Set(Object.values(resultats).flatMap((r) => Object.keys(r.props || {})))];
    const libelleRisque = { faible: "Faible", eleve: "Élevé", info_manquante: "Informations manquantes", indetermine: "Indéterminé" };
    const entete = ["Identifiant", "Producteur", "Type", "Surface déclarée (ha)", "Surface mesurée (ha)", "Anomalies bloquantes", "À corriger", "À vérifier", "Risque de déforestation (WHISP)", ...clesWhisp.map((k) => "whisp_" + k)];
    const lignes = parcelles.map((p) => {
      const r = resultats[p.cle];
      const par = (g) => p.anomalies.filter((x) => x.gravite === g).map((x) => x.texte).join(" | ");
      return [p.id, p.producteur, p.type, p.superficie_declaree_ha, p.superficie_mesuree_ha, par("bloquante"), par("a_corriger"), par("a_verifier"),
        r ? libelleRisque[r.risque] : (p.analysable ? "En attente" : "Non analysée"),
        ...clesWhisp.map((k) => (r && r.props ? r.props[k] : ""))];
    });
    return "\uFEFF" + [entete, ...lignes].map((l) => l.map(celluleCsv).join(";")).join("\r\n");
  }

  function nomCsv(a) {
    return `audit-${a.id}-${a.client.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.csv`;
  }

  router.get("/api/admin/audits/:id/export.csv", (req, res, params) => {
    if (!isAdminAvecLimite(req, res)) return;
    const a = db.prepare(`SELECT * FROM audits WHERE id = ?`).get(Number(params.id));
    if (!a) return send(res, 404, { error: "audit introuvable" });
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${nomCsv(a)}"` });
    res.end(csvAudit(a));
  });
};
