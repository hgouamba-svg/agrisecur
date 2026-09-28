// audit-controles.js — contrôles de qualité d'un fichier de parcelles (Audit RDUE express)
//
// Fonctions pures, sans dépendance : elles reçoivent une liste de « features »
// GeoJSON (Point, Polygon ou MultiPolygon, coordonnées [longitude, latitude])
// et renvoient, pour chaque parcelle, la liste des anomalies trouvées.
//
// Gravité des anomalies :
//   - "bloquante"  : la parcelle ne peut pas être analysée (coordonnées absentes,
//                    invalides, hors du pays, polygone cassé) ; elle n'est pas
//                    envoyée à l'analyse satellite ;
//   - "a_corriger" : exigence du RDUE non respectée (précision, polygone requis,
//                    doublon, chevauchement) ; l'analyse satellite est faite quand même ;
//   - "a_verifier" : valeur suspecte à confirmer avec la coopérative.

const PAYS = {
  // Cadres géographiques larges (degrés), avec une petite marge.
  ci: { nom: "Côte d'Ivoire", latMin: 4.2, latMax: 10.8, lonMin: -8.7, lonMax: -2.4 },
  gh: { nom: "Ghana", latMin: 4.5, latMax: 11.2, lonMin: -3.3, lonMax: 1.3 },
};

const SEUIL_POLYGONE_HA = 4;       // RDUE : au-delà de 4 ha, un polygone est obligatoire
const DECIMALES_MIN = 6;           // RDUE : au moins 6 décimales
const SURFACE_MIN_HA = 0.05;       // en dessous : surface anormalement petite
const SURFACE_MAX_HA = 50;         // au-dessus : surface anormalement grande pour une parcelle paysanne
const ECART_SURFACE_MAX = 0.3;     // 30 % d'écart entre surface déclarée et mesurée
// Plafond de calcul des contrôles géométriques (comparaisons de segments) pour
// un fichier. Ces contrôles coûtent le carré du nombre de sommets : sans plafond,
// un fichier piégé de quelques Mo déposé sur /depot bloquait le serveur pendant
// de longues secondes pour tous les utilisateurs. Un vrai fichier de coopérative
// (quelques milliers de parcelles de quelques dizaines de sommets) reste loin
// en dessous ; au-delà, les parcelles concernées sont signalées « à vérifier ».
const BUDGET_COMPARAISONS = 30000000;

function nombreDecimales(n) {
  if (!Number.isFinite(n)) return 0;
  const s = String(n);
  if (s.includes("e-")) return Number(s.split("e-")[1]) || 0;
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

function positionValide(p) {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
    && p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;
}

function dansPays(lon, lat, pays) {
  const b = PAYS[pays];
  return lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
}

// Anneaux extérieurs (et intérieurs) d'une géométrie surfacique.
function anneaux(geom) {
  if (geom.type === "Polygon") return [geom.coordinates];
  if (geom.type === "MultiPolygon") return geom.coordinates;
  return [];
}

function toutesPositions(geom) {
  if (geom.type === "Point") return [geom.coordinates];
  return anneaux(geom).flat(2); // polygones → anneaux → positions
}

// Surface en hectares d'un anneau (projection équirectangulaire locale : précise
// à quelques pour cent pour des parcelles de quelques hectares).
function surfaceAnneauHa(ring) {
  if (!ring || ring.length < 4) return 0;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = [ring[i][0] * kx, ring[i][1] * ky];
    const [x2, y2] = [ring[i + 1][0] * kx, ring[i + 1][1] * ky];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2 / 10000;
}

function surfaceHa(geom) {
  let total = 0;
  for (const poly of anneaux(geom)) {
    if (!poly.length) continue;
    total += surfaceAnneauHa(poly[0]);
    for (let k = 1; k < poly.length; k++) total -= surfaceAnneauHa(poly[k]);
  }
  return Math.max(0, total);
}

function bbox(positions) {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of positions) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function bboxSeCroisent(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

// Intersection stricte de deux segments (les extrémités communes ne comptent pas).
function segmentsSeCroisent(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1), d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3), d4 = orient(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function anneauSeRecoupe(ring) {
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // segments voisins par la fermeture
      if (segmentsSeCroisent(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

function pointDansAnneau(pt, ring) {
  let dedans = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
}

// Deux polygones se chevauchent si leurs contours se croisent ou si l'un contient
// un sommet (ou le centre) de l'autre. Les simples contacts de bordure ne comptent pas.
function polygonesSeChevauchent(ra, rb) {
  for (let i = 0; i < ra.length - 1; i++) {
    for (let j = 0; j < rb.length - 1; j++) {
      if (segmentsSeCroisent(ra[i], ra[i + 1], rb[j], rb[j + 1])) return true;
    }
  }
  const centre = (r) => [r.slice(0, -1).reduce((s, p) => s + p[0], 0) / (r.length - 1), r.slice(0, -1).reduce((s, p) => s + p[1], 0) / (r.length - 1)];
  return pointDansAnneau(centre(ra), rb) || pointDansAnneau(centre(rb), ra);
}

function lireNombre(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function identifiant(props, i) {
  const cles = ["id", "ID", "Id", "code", "CODE", "code_parcelle", "parcelle_id", "plot_id", "plotId", "Name", "name", "nom_parcelle"];
  for (const c of cles) if (props && props[c] !== undefined && props[c] !== null && String(props[c]).trim()) return String(props[c]).trim().slice(0, 80);
  return `P${i + 1}`;
}

function nomProducteur(props) {
  const cles = ["producteur", "nom_producteur", "farmer", "farmer_name", "nom", "owner", "proprietaire"];
  for (const c of cles) if (props && props[c]) return String(props[c]).trim().slice(0, 120);
  return "";
}

function superficieDeclaree(props) {
  const cles = ["superficie_ha", "superficie", "surface_ha", "surface", "area_ha", "area", "hectares", "ha"];
  for (const c of cles) { const n = lireNombre(props && props[c]); if (n !== null) return n; }
  return null;
}

/**
 * @param {Array} features  liste de features GeoJSON
 * @param {"ci"|"gh"} pays
 * @returns {{ parcelles: Array, resume: object }}
 */
function controlerParcelles(features, pays) {
  if (!PAYS[pays]) throw new Error("pays inconnu");
  let budget = BUDGET_COMPARAISONS;
  const parcelles = features.map((f, i) => {
    const props = (f && f.properties) || {};
    const p = {
      index: i, id: identifiant(props, i), producteur: nomProducteur(props),
      type: f && f.geometry ? f.geometry.type : null,
      superficie_declaree_ha: superficieDeclaree(props), superficie_mesuree_ha: null,
      anomalies: [], analysable: false,
    };
    const ajouter = (gravite, code, texte) => p.anomalies.push({ gravite, code, texte });
    const g = f && f.geometry;
    if (!g || !g.coordinates) { ajouter("bloquante", "coordonnees_absentes", "Coordonnées absentes"); return p; }
    if (!["Point", "Polygon", "MultiPolygon"].includes(g.type)) { ajouter("bloquante", "type_non_gere", `Type de géométrie non accepté (${g.type})`); return p; }

    let positions = [];
    try { positions = toutesPositions(g); } catch { positions = []; }
    const structureOk = g.type === "Point" || Array.isArray(g.coordinates) && anneaux(g).every((poly) => Array.isArray(poly) && poly.every((ring) => Array.isArray(ring) && ring.every(positionValide)));
    if (!structureOk || !positions.length || !positions.every(positionValide)) { ajouter("bloquante", "coordonnees_invalides", "Coordonnées invalides ou incomplètes"); return p; }

    const hors = positions.filter(([lon, lat]) => !dansPays(lon, lat, pays));
    if (hors.length) {
      const inverse = hors.every(([lon, lat]) => dansPays(lat, lon, pays));
      ajouter("bloquante", inverse ? "coordonnees_inversees" : "hors_pays",
        inverse ? "Latitude et longitude probablement inversées" : `Parcelle hors de ${PAYS[pays].nom}`);
      return p;
    }

    // On retient la meilleure précision de la parcelle : un zéro final perdu à la
    // lecture du fichier (5.784390 → 5.78439) ne doit pas déclencher d'alerte.
    const decimales = positions.reduce((m, [lon, lat]) => Math.max(m, nombreDecimales(lon), nombreDecimales(lat)), 0);
    if (decimales < DECIMALES_MIN) ajouter("a_corriger", "precision", `Précision insuffisante (${decimales} décimales, 6 exigées par le RDUE)`);

    if (g.type === "Point") {
      if (p.superficie_declaree_ha !== null && p.superficie_declaree_ha > SEUIL_POLYGONE_HA) {
        ajouter("a_corriger", "polygone_requis", `Polygone obligatoire : parcelle déclarée à ${p.superficie_declaree_ha} ha (plus de 4 ha)`);
      }
      if (p.superficie_declaree_ha === null) ajouter("a_verifier", "superficie_inconnue", "Point GPS sans superficie déclarée : impossible de savoir si un polygone est exigé");
      p.analysable = true;
      return p;
    }

    // Polygones
    for (const poly of anneaux(g)) {
      for (const ring of poly) {
        if (ring.length < 4) { ajouter("bloquante", "polygone_incomplet", "Polygone de moins de 3 sommets"); return p; }
        const [a, b] = [ring[0], ring[ring.length - 1]];
        if (a[0] !== b[0] || a[1] !== b[1]) { ajouter("bloquante", "polygone_ouvert", "Polygone non fermé"); return p; }
        const cout = (ring.length * ring.length) / 2;
        if (cout > budget) {
          ajouter("a_verifier", "controle_partiel", "Contour trop détaillé pour le contrôle automatique de croisement : à vérifier à la main");
        } else {
          budget -= cout;
          if (anneauSeRecoupe(ring)) { ajouter("bloquante", "polygone_croise", "Contour qui se recoupe (polygone invalide)"); return p; }
        }
      }
    }
    const s = surfaceHa(g);
    p.superficie_mesuree_ha = Math.round(s * 100) / 100;
    if (s < SURFACE_MIN_HA) ajouter("a_verifier", "surface_petite", `Surface anormalement petite (${p.superficie_mesuree_ha} ha)`);
    if (s > SURFACE_MAX_HA) ajouter("a_verifier", "surface_grande", `Surface anormalement grande (${p.superficie_mesuree_ha} ha)`);
    if (p.superficie_declaree_ha && p.superficie_declaree_ha > 0 && Math.abs(s - p.superficie_declaree_ha) / p.superficie_declaree_ha > ECART_SURFACE_MAX) {
      ajouter("a_verifier", "ecart_surface", `Surface mesurée (${p.superficie_mesuree_ha} ha) différente de la surface déclarée (${p.superficie_declaree_ha} ha)`);
    }
    p.analysable = true;
    return p;
  });

  // Doublons d'identifiant
  const parId = new Map();
  parcelles.forEach((p) => parId.set(p.id, (parId.get(p.id) || 0) + 1));
  parcelles.forEach((p) => { if (parId.get(p.id) > 1) p.anomalies.push({ gravite: "a_corriger", code: "id_double", texte: `Identifiant utilisé ${parId.get(p.id)} fois` }); });

  // Doublons de géométrie (coordonnées identiques à 6 décimales)
  const cle = (f) => JSON.stringify(f.geometry.coordinates, (k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v));
  const parGeom = new Map();
  parcelles.forEach((p) => {
    if (!p.analysable) return;
    const k = cle(features[p.index]);
    if (parGeom.has(k)) {
      const autre = parGeom.get(k);
      p.anomalies.push({ gravite: "a_corriger", code: "geometrie_double", texte: `Mêmes coordonnées que la parcelle ${autre.id}` });
    } else parGeom.set(k, p);
  });

  // Chevauchements entre polygones
  const polys = parcelles.filter((p) => p.analysable && p.type !== "Point").map((p) => {
    const ring = anneaux(features[p.index].geometry)[0][0];
    return { p, ring, bb: bbox(ring) };
  });
  let chevauchementsPartiels = false;
  for (let i = 0; i < polys.length && !chevauchementsPartiels; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      const A = polys[i], B = polys[j];
      if (!bboxSeCroisent(A.bb, B.bb)) continue;
      const cout = A.ring.length * B.ring.length;
      if (cout > budget) { chevauchementsPartiels = true; break; }
      budget -= cout;
      if (polygonesSeChevauchent(A.ring, B.ring)) {
        A.p.anomalies.push({ gravite: "a_corriger", code: "chevauchement", texte: `Chevauche la parcelle ${B.p.id}` });
        B.p.anomalies.push({ gravite: "a_corriger", code: "chevauchement", texte: `Chevauche la parcelle ${A.p.id}` });
      }
    }
  }

  const resume = {
    total: parcelles.length,
    analysables: parcelles.filter((p) => p.analysable).length,
    bloquantes: parcelles.filter((p) => p.anomalies.some((a) => a.gravite === "bloquante")).length,
    a_corriger: parcelles.filter((p) => p.anomalies.some((a) => a.gravite === "a_corriger")).length,
    a_verifier: parcelles.filter((p) => p.anomalies.some((a) => a.gravite === "a_verifier")).length,
    sans_anomalie: parcelles.filter((p) => p.anomalies.length === 0).length,
    polygones: parcelles.filter((p) => p.type === "Polygon" || p.type === "MultiPolygon").length,
    points: parcelles.filter((p) => p.type === "Point").length,
    chevauchements_partiels: chevauchementsPartiels,
  };
  return { parcelles, resume };
}

module.exports = { controlerParcelles, surfaceHa, PAYS };
