// lecture-parcelles.js — lecture d'un fichier de parcelles dans le navigateur
// (GeoJSON, KML, CSV avec latitude/longitude ou WKT), converti en liste de
// « features » GeoJSON. Utilisé par la page de dépôt d'audit (/depot.html).
// Même logique que l'onglet « Audits RDUE » du back-office.
(function () {
function nombresCoord(texte) {
  return texte.trim().split(/\s+/).filter(Boolean).map((t) => t.split(",").slice(0, 2).map(Number));
}

function lireKml(texte) {
  const doc = new DOMParser().parseFromString(texte, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("fichier KML illisible");
  const features = [];
  for (const pm of doc.getElementsByTagName("Placemark")) {
    const props = {};
    const nom = pm.getElementsByTagName("name")[0];
    if (nom) props.id = nom.textContent.trim();
    for (const d of pm.getElementsByTagName("Data")) {
      const v = d.getElementsByTagName("value")[0];
      if (d.getAttribute("name") && v) props[d.getAttribute("name")] = v.textContent.trim();
    }
    for (const d of pm.getElementsByTagName("SimpleData")) if (d.getAttribute("name")) props[d.getAttribute("name")] = d.textContent.trim();
    const polys = [...pm.getElementsByTagName("Polygon")].map((pg) => {
      const ext = pg.getElementsByTagName("outerBoundaryIs")[0];
      const rings = [];
      if (ext) rings.push(nombresCoord(ext.getElementsByTagName("coordinates")[0].textContent));
      for (const inn of pg.getElementsByTagName("innerBoundaryIs")) rings.push(nombresCoord(inn.getElementsByTagName("coordinates")[0].textContent));
      return rings;
    });
    let geometry = null;
    if (polys.length === 1) geometry = { type: "Polygon", coordinates: polys[0] };
    else if (polys.length > 1) geometry = { type: "MultiPolygon", coordinates: polys };
    else {
      const pt = pm.getElementsByTagName("Point")[0];
      if (pt) geometry = { type: "Point", coordinates: nombresCoord(pt.getElementsByTagName("coordinates")[0].textContent)[0] };
    }
    features.push({ type: "Feature", geometry, properties: props });
  }
  return features;
}

function lireWkt(w) {
  const t = String(w || "").trim().toUpperCase();
  const paires = (s) => s.split(",").map((c) => c.trim().split(/\s+/).slice(0, 2).map(Number));
  let m = t.match(/^POINT\s*\(\s*([^)]+)\)/);
  if (m) return { type: "Point", coordinates: paires(m[1])[0] };
  m = t.match(/^POLYGON\s*\(\s*\((.+)\)\s*\)$/);
  if (m) return { type: "Polygon", coordinates: m[1].split(/\)\s*,\s*\(/).map(paires) };
  return null;
}

function lireCsv(texte) {
  const lignes = texte.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lignes.length < 2) throw new Error("fichier CSV vide");
  const sep = [";", "\t", ","].map((c) => [c, lignes[0].split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const decouper = (l) => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === sep && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur); return out.map((v) => v.trim());
  };
  const tete = decouper(lignes[0]).map((h) => h.toLowerCase());
  const trouver = (noms) => tete.findIndex((h) => noms.includes(h));
  const iLat = trouver(["lat", "latitude", "y", "gps_lat", "gps_latitude"]);
  const iLon = trouver(["lon", "lng", "long", "longitude", "x", "gps_lon", "gps_long", "gps_longitude"]);
  const iWkt = trouver(["wkt", "geometry", "geometrie", "geom", "polygone", "polygon"]);
  if (iWkt === -1 && (iLat === -1 || iLon === -1)) throw new Error("colonnes latitude et longitude (ou WKT) introuvables dans le CSV");
  const num = (v) => Number(String(v).replace(",", "."));
  return lignes.slice(1).map((l) => {
    const v = decouper(l);
    const props = {};
    tete.forEach((h, i) => { if (i !== iLat && i !== iLon && i !== iWkt) props[h] = v[i]; });
    let geometry = null;
    if (iWkt !== -1 && v[iWkt]) geometry = lireWkt(v[iWkt]);
    else if (v[iLat] !== "" && v[iLon] !== "" && v[iLat] !== undefined && v[iLon] !== undefined) geometry = { type: "Point", coordinates: [num(v[iLon]), num(v[iLat])] };
    return { type: "Feature", geometry, properties: props };
  });
}

async function lireFichierParcelles(fichier) {
  const texte = await fichier.text();
  const nom = fichier.name.toLowerCase();
  if (nom.endsWith(".kml")) return lireKml(texte);
  if (nom.endsWith(".csv") || nom.endsWith(".txt")) return lireCsv(texte);
  let data;
  try { data = JSON.parse(texte); } catch { throw new Error("fichier GeoJSON illisible"); }
  if (Array.isArray(data)) return data;
  if (data.type === "FeatureCollection") return data.features || [];
  if (data.type === "Feature") return [data];
  if (data.type && data.coordinates) return [{ type: "Feature", geometry: data, properties: {} }];
  throw new Error("format GeoJSON non reconnu");
}

window.AgriSecurParcelles = { lire: lireFichierParcelles };
})();
