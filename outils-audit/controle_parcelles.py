#!/usr/bin/env python3
"""
AgriSecur – contrôle qualité automatique d'un fichier de parcelles (Audit RDUE express).

Usage :
    python controle_parcelles.py FICHIER [--pays CI|GH] [--sortie DOSSIER]

Formats lus : GeoJSON (.geojson/.json), KML/KMZ, Shapefile (.shp ou .zip contenant
un .shp), CSV / Excel (.csv, .xlsx, .xls) avec colonnes latitude et longitude
(ou une colonne WKT « geometry »).

Sorties (dans le dossier de sortie) :
    anomalies.xlsx          Résumé, Anomalies (une ligne par anomalie), Parcelles
    anomalies.csv           La feuille « Anomalies » en CSV
    whisp_lot_NN.geojson    Géométries valides, identifiant seul (sans nom de
                            producteur), par lots de 5 000, prêtes pour Whisp

Contrôles : identifiant manquant ou en double ; coordonnées manquantes, invalides,
inversées ou à (0,0) ; parcelle hors pays ou près d'une frontière ; précision
insuffisante (moins de 6 décimales) ; point au lieu d'un polygone pour une
parcelle de 4 ha ou plus (RDUE, art. 2 (28)) ; polygone invalide ; surface
déclarée incohérente avec la surface calculée ; surface atypique ; doublons de
géométrie ; points très proches ; chevauchements entre polygones.

Aucune donnée n'est envoyée sur Internet par ce script.
"""
from __future__ import annotations

import argparse
import math
import os
import re
import sys
import tempfile
import unicodedata
import zipfile
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from pyproj import Geod
from shapely import make_valid
from shapely.geometry import MultiPolygon, Point, Polygon
from shapely.validation import explain_validity

ICI = Path(__file__).resolve().parent
FICHIER_PAYS = ICI / "donnees" / "pays.geojson"
GEOD = Geod(ellps="WGS84")

# Seuils (modifiables)
SEUIL_POLYGONE_HA = 4.0          # RDUE : polygone obligatoire au-delà de 4 ha
DECIMALES_MIN = 6                # précision attendue des coordonnées
ECART_SURFACE_MAX = 0.20         # écart toléré entre surface déclarée et calculée
SURFACE_MIN_HA = 0.05            # en dessous : surface atypique
SURFACE_MAX_HA = 50.0            # au-dessus : surface atypique (petite exploitation)
DISTANCE_POINTS_PROCHES_M = 10.0 # deux points à moins de 10 m : doublon probable
CHEVAUCHEMENT_MIN_HA = 0.01      # chevauchement ignoré en dessous de 100 m²
MARGE_FRONTIERE_M = 2000.0       # à moins de 2 km d'une frontière : à vérifier
TAILLE_LOT_WHISP = 5000          # Whisp : 5 000 géométries par tâche asynchrone

# Emprises approximatives utilisées pour détecter latitude/longitude inversées
EMPRISE = {"CI": (-8.7, 4.2, -2.4, 10.8), "GH": (-3.4, 4.6, 1.3, 11.2)}

GRAVITE_BLOQUANT = "Bloquant"
GRAVITE_CORRIGER = "À corriger"
GRAVITE_VERIFIER = "À vérifier"

ACTIONS = {
    "Identifiant manquant": "Attribuer un code parcelle unique.",
    "Identifiant en double": "Donner un code unique à chaque parcelle ou supprimer la ligne en trop.",
    "Coordonnées manquantes": "Relever la parcelle au GPS (point sous 4 ha, contour au-delà).",
    "Coordonnées invalides": "Relever à nouveau la parcelle au GPS.",
    "Latitude et longitude inversées": "Inverser les deux colonnes après vérification.",
    "Hors pays": "Vérifier les coordonnées ; relever à nouveau la parcelle si besoin.",
    "Près d'une frontière": "Vérifier sur une carte que la parcelle est bien dans le pays.",
    "Précision insuffisante": "Relever avec au moins 6 décimales (GPS du téléphone en degrés décimaux).",
    "Polygone obligatoire (4 ha ou plus)": "Relever le contour complet de la parcelle.",
    "Polygone invalide": "Relever à nouveau le contour en faisant le tour de la parcelle sans croiser le tracé.",
    "Surface incohérente": "Vérifier la surface déclarée ou le contour relevé.",
    "Surface atypique": "Vérifier la surface et le contour.",
    "Doublon de géométrie": "Vérifier s'il s'agit de la même parcelle enregistrée deux fois.",
    "Points très proches": "Vérifier s'il s'agit de la même parcelle enregistrée deux fois.",
    "Chevauchement": "Vérifier les limites des deux parcelles et relever à nouveau les contours.",
}

# ---------------------------------------------------------------------------
# Lecture
# ---------------------------------------------------------------------------

NOMS_ID = ["plot_id", "id_parcelle", "code_parcelle", "code parcelle", "parcelle", "plot", "plotid",
           "farm_id", "id", "code", "name", "nom"]
NOMS_LAT = ["latitude", "lat", "y", "gps_lat", "lat_dd"]
NOMS_LON = ["longitude", "lon", "long", "lng", "x", "gps_lon", "lon_dd"]
NOMS_SURFACE = ["surface_ha", "superficie_ha", "area_ha", "surface", "superficie", "area", "ha",
                "hectares", "size_ha"]
NOMS_PRODUCTEUR = ["producteur", "code_producteur", "farmer", "farmer_id", "nom_producteur",
                   "producer", "planteur"]


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def trouver_colonne(colonnes, candidats):
    normes = {_norm(c): c for c in colonnes}
    for cand in candidats:
        if _norm(cand) in normes:
            return normes[_norm(cand)]
    return None


def _en_nombre(v):
    if v is None:
        return np.nan
    if isinstance(v, (int, float, np.integer, np.floating)):
        return float(v)
    s = str(v).strip().replace(",", ".").replace(" ", "")
    if s == "" or s.lower() in ("nan", "none", "null", "na", "n/a"):
        return np.nan
    try:
        return float(s)
    except ValueError:
        return np.nan


def _decimales(texte) -> int | None:
    """Nombre de décimales d'une coordonnée telle qu'écrite dans le fichier."""
    if texte is None:
        return None
    if isinstance(texte, float):
        if math.isnan(texte):
            return None
        texte = repr(texte)
        # un nombre lu en binaire perd ses zéros finaux (6.401200 -> 6.4012) : on tolère
        # un zéro perdu pour ne pas signaler à tort une coordonnée saisie avec 6 décimales
        s = texte.rstrip("0")
        if "." not in s or "e" in s.lower():
            return None
        d = len(s.split(".", 1)[1])
        return d + 1 if d == DECIMALES_MIN - 1 else d
    s = str(texte).strip().replace(",", ".")
    if s == "" or "e" in s.lower():
        return None
    if "." not in s:
        return 0
    return len(s.split(".", 1)[1])  # texte : les zéros finaux écrits comptent


def lire_tableau(chemin: Path) -> gpd.GeoDataFrame:
    if chemin.suffix.lower() == ".csv":
        brut = pd.read_csv(chemin, dtype=str, sep=None, engine="python", encoding_errors="replace")
    else:
        brut = pd.read_excel(chemin, dtype=str)
    col_lat = trouver_colonne(brut.columns, NOMS_LAT)
    col_lon = trouver_colonne(brut.columns, NOMS_LON)
    col_wkt = trouver_colonne(brut.columns, ["geometry", "wkt", "geom", "polygone", "polygon"])
    geoms, decs = [], []
    for _, ligne in brut.iterrows():
        g, d = None, None
        if col_wkt and isinstance(ligne[col_wkt], str) and ligne[col_wkt].strip():
            try:
                from shapely import wkt
                g = wkt.loads(ligne[col_wkt])
                d = _decimales_geometrie(g)
            except Exception:
                g = None
        if g is None and col_lat and col_lon:
            lat, lon = _en_nombre(ligne[col_lat]), _en_nombre(ligne[col_lon])
            if not (math.isnan(lat) or math.isnan(lon)):
                g = Point(lon, lat)
                dl, dn = _decimales(ligne[col_lat]), _decimales(ligne[col_lon])
                d = max(x for x in (dl, dn) if x is not None) if (dl is not None or dn is not None) else None
        geoms.append(g)
        decs.append(d)
    if not (col_lat and col_lon) and not col_wkt:
        raise SystemExit("Colonnes latitude/longitude introuvables. Colonnes lues : " + ", ".join(brut.columns))
    gdf = gpd.GeoDataFrame(brut, geometry=geoms, crs="EPSG:4326")
    gdf["_decimales"] = decs
    return gdf


def _decimales_geometrie(g) -> int | None:
    if g is None or g.is_empty:
        return None
    coords = []
    if isinstance(g, Point):
        coords = [g.coords[0]]
    elif isinstance(g, Polygon):
        coords = list(g.exterior.coords)
    elif isinstance(g, MultiPolygon):
        for p in g.geoms:
            coords += list(p.exterior.coords)
    else:
        try:
            coords = list(g.coords)
        except Exception:
            return None
    # par sommet : la meilleure des deux (une latitude « ronde » comme 6.4 est possible)
    ds = []
    for c in coords:
        dd = [d for d in (_decimales(float(c[0])), _decimales(float(c[1]))) if d is not None]
        if dd:
            ds.append(max(dd))
    if not ds:
        return None
    # médiane : un sommet « rond » par hasard ne déclenche pas d'alerte
    return int(np.median(ds))


def lire_fichier(chemin: Path) -> gpd.GeoDataFrame:
    ext = chemin.suffix.lower()
    if ext in (".csv", ".xlsx", ".xls"):
        return lire_tableau(chemin)
    if ext == ".zip":
        tmp = Path(tempfile.mkdtemp())
        with zipfile.ZipFile(chemin) as z:
            z.extractall(tmp)
        shps = list(tmp.rglob("*.shp"))
        if not shps:
            raise SystemExit("Aucun fichier .shp dans l'archive.")
        chemin, ext = shps[0], ".shp"
    if ext == ".kmz":
        tmp = Path(tempfile.mkdtemp())
        with zipfile.ZipFile(chemin) as z:
            z.extractall(tmp)
        kmls = list(tmp.rglob("*.kml"))
        if not kmls:
            raise SystemExit("Aucun fichier .kml dans le KMZ.")
        chemin, ext = kmls[0], ".kml"
    if ext == ".kml":
        import pyogrio
        couches = [c[0] for c in pyogrio.list_layers(chemin)]
        gdf = pd.concat([gpd.read_file(chemin, layer=c) for c in couches], ignore_index=True)
        gdf = gpd.GeoDataFrame(gdf, geometry="geometry", crs="EPSG:4326")
    else:
        gdf = gpd.read_file(chemin)
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")
    # retirer la 3e dimension (altitude) éventuelle
    from shapely import force_2d
    gdf["geometry"] = [force_2d(g) if g is not None else None for g in gdf.geometry]
    gdf["_decimales"] = [_decimales_geometrie(g) for g in gdf.geometry]
    return gdf


# ---------------------------------------------------------------------------
# Contrôles
# ---------------------------------------------------------------------------

def surface_ha(g) -> float:
    if g is None or g.is_empty or g.geom_type not in ("Polygon", "MultiPolygon"):
        return float("nan")
    a, _ = GEOD.geometry_area_perimeter(g)
    return abs(a) / 10_000


class Registre:
    def __init__(self):
        self.lignes = []

    def ajouter(self, idx, pid, prod, type_, gravite, detail):
        self.lignes.append({"_idx": idx, "Code parcelle": pid, "Producteur": prod, "Anomalie": type_,
                            "Gravité": gravite, "Détail": detail, "Action recommandée": ACTIONS.get(type_, "")})


def controler(gdf: gpd.GeoDataFrame, pays: str) -> tuple[pd.DataFrame, pd.DataFrame, gpd.GeoDataFrame]:
    reg = Registre()
    remplies = [c for c in gdf.columns if c != "geometry" and not str(c).startswith("_")
                and gdf[c].notna().any() and (gdf[c].astype(str).str.strip() != "").any()]
    col_id = trouver_colonne(remplies, NOMS_ID)
    col_surf = trouver_colonne(remplies, NOMS_SURFACE)
    col_prod = trouver_colonne(remplies, NOMS_PRODUCTEUR)
    gdf = gdf.reset_index(drop=True).copy()
    gdf["_id"] = gdf[col_id].fillna("").astype(str).str.strip() if col_id else ""
    gdf.loc[gdf["_id"].isin(["", "nan", "None"]), "_id"] = ""
    gdf["_prod"] = gdf[col_prod].fillna("").astype(str) if col_prod else ""
    gdf["_surf_decl"] = gdf[col_surf].map(_en_nombre) if col_surf else np.nan
    gdf["_utilisable"] = True

    etiquette = lambda i: gdf.at[i, "_id"] or f"(ligne {i + 2})"

    # 1. Identifiants
    for i in gdf.index[gdf["_id"] == ""]:
        reg.ajouter(i, etiquette(i), gdf.at[i, "_prod"], "Identifiant manquant", GRAVITE_CORRIGER,
                    "Aucun code parcelle sur cette ligne.")
    dup = gdf[(gdf["_id"] != "") & gdf["_id"].duplicated(keep=False)]
    for pid, grp in dup.groupby("_id"):
        for i in grp.index:
            reg.ajouter(i, pid, gdf.at[i, "_prod"], "Identifiant en double", GRAVITE_CORRIGER,
                        f"Code utilisé {len(grp)} fois (lignes {', '.join(str(j + 2) for j in grp.index)}).")

    # 2. Coordonnées manquantes / invalides / inversées / précision
    pays_gdf = gpd.read_file(FICHIER_PAYS)
    frontiere = pays_gdf[pays_gdf["code"] == pays].geometry.union_all() if pays else None
    frontiere_m = gpd.GeoSeries([frontiere], crs="EPSG:4326").to_crs("EPSG:32630").iloc[0] if pays else None
    bord_m = frontiere_m.boundary if pays else None

    for i, g in gdf.geometry.items():
        pid, prod = etiquette(i), gdf.at[i, "_prod"]
        if g is None or g.is_empty:
            reg.ajouter(i, pid, prod, "Coordonnées manquantes", GRAVITE_BLOQUANT, "Aucune coordonnée ni contour.")
            gdf.at[i, "_utilisable"] = False
            continue
        minx, miny, maxx, maxy = g.bounds
        if not (-180 <= minx <= 180 and -180 <= maxx <= 180 and -90 <= miny <= 90 and -90 <= maxy <= 90) \
                or (abs(minx) < 1e-9 and abs(miny) < 1e-9):
            reg.ajouter(i, pid, prod, "Coordonnées invalides", GRAVITE_BLOQUANT,
                        f"Coordonnées impossibles ou nulles : lon {minx:.6f}, lat {miny:.6f}.")
            gdf.at[i, "_utilisable"] = False
            continue
        if pays and pays in EMPRISE:
            x0, y0, x1, y1 = EMPRISE[pays]
            c = g.centroid
            dedans = x0 <= c.x <= x1 and y0 <= c.y <= y1
            inverse = x0 <= c.y <= x1 and y0 <= c.x <= y1
            if not dedans and inverse:
                reg.ajouter(i, pid, prod, "Latitude et longitude inversées", GRAVITE_CORRIGER,
                            f"Point lu en lon {c.x:.6f}, lat {c.y:.6f} : les valeurs semblent inversées.")
                gdf.at[i, "_utilisable"] = False
                continue
        if pays:
            gm = gpd.GeoSeries([g], crs="EPSG:4326").to_crs("EPSG:32630").iloc[0]
            if not gm.intersects(frontiere_m):
                dist = gm.distance(frontiere_m)
                if dist > MARGE_FRONTIERE_M:
                    reg.ajouter(i, pid, prod, "Hors pays", GRAVITE_BLOQUANT,
                                f"Parcelle à {dist / 1000:.1f} km hors du territoire ({pays}).")
                    gdf.at[i, "_utilisable"] = False
                    continue
                reg.ajouter(i, pid, prod, "Près d'une frontière", GRAVITE_VERIFIER,
                            f"Parcelle à {dist:.0f} m hors du tracé de frontière (tracé approximatif).")
            elif gm.distance(bord_m) < MARGE_FRONTIERE_M and not gm.within(frontiere_m.buffer(-MARGE_FRONTIERE_M)):
                reg.ajouter(i, pid, prod, "Près d'une frontière", GRAVITE_VERIFIER,
                            f"Parcelle à moins de {MARGE_FRONTIERE_M / 1000:.0f} km de la frontière.")
        d = gdf.at[i, "_decimales"]
        if d is not None and not (isinstance(d, float) and math.isnan(d)) and int(d) < DECIMALES_MIN:
            reg.ajouter(i, pid, prod, "Précision insuffisante", GRAVITE_VERIFIER,
                        f"Coordonnées à {int(d)} décimale(s) ; au moins {DECIMALES_MIN} attendues "
                        f"(1 décimale en moins = précision 10 fois plus faible).")

    # 3. Géométrie : type, validité, surface
    gdf["_surf_calc"] = np.nan
    for i, g in gdf.geometry.items():
        if not gdf.at[i, "_utilisable"]:
            continue
        pid, prod, decl = etiquette(i), gdf.at[i, "_prod"], gdf.at[i, "_surf_decl"]
        t = g.geom_type
        if t in ("Point", "MultiPoint"):
            if not math.isnan(decl) and decl >= SEUIL_POLYGONE_HA:
                reg.ajouter(i, pid, prod, "Polygone obligatoire (4 ha ou plus)", GRAVITE_BLOQUANT,
                            f"Surface déclarée {decl:.2f} ha mais seul un point GPS est fourni.")
            elif math.isnan(decl):
                reg.ajouter(i, pid, prod, "Surface atypique", GRAVITE_VERIFIER,
                            "Point GPS sans surface déclarée : impossible de vérifier le seuil de 4 ha.")
            continue
        if t in ("LineString", "MultiLineString", "LinearRing"):
            reg.ajouter(i, pid, prod, "Polygone invalide", GRAVITE_BLOQUANT,
                        "Contour ouvert (ligne) au lieu d'un polygone fermé.")
            gdf.at[i, "_utilisable"] = False
            continue
        if t not in ("Polygon", "MultiPolygon"):
            reg.ajouter(i, pid, prod, "Polygone invalide", GRAVITE_BLOQUANT, f"Géométrie de type {t}.")
            gdf.at[i, "_utilisable"] = False
            continue
        nb_sommets = sum(len(p.exterior.coords) - 1 for p in (g.geoms if t == "MultiPolygon" else [g]))
        if nb_sommets < 3:
            reg.ajouter(i, pid, prod, "Polygone invalide", GRAVITE_BLOQUANT, "Moins de 3 sommets.")
            gdf.at[i, "_utilisable"] = False
            continue
        if not g.is_valid:
            raison = explain_validity(g)
            raison_fr = ("le contour se croise lui-même" if "Self-intersection" in raison or "Ring Self" in raison
                         else raison)
            reg.ajouter(i, pid, prod, "Polygone invalide", GRAVITE_BLOQUANT, f"Polygone non valide : {raison_fr}.")
            gdf.at[i, "geometry"] = make_valid(g)  # pour les calculs suivants seulement
            gdf.at[i, "_utilisable"] = False
        sc = surface_ha(gdf.at[i, "geometry"])
        gdf.at[i, "_surf_calc"] = sc
        if not math.isnan(decl) and decl > 0 and not math.isnan(sc):
            ecart = abs(sc - decl) / decl
            if ecart > ECART_SURFACE_MAX:
                reg.ajouter(i, pid, prod, "Surface incohérente", GRAVITE_CORRIGER,
                            f"Déclarée {decl:.2f} ha, calculée {sc:.2f} ha (écart {ecart:.0%}).")
        if not math.isnan(sc) and (sc < SURFACE_MIN_HA or sc > SURFACE_MAX_HA):
            reg.ajouter(i, pid, prod, "Surface atypique", GRAVITE_VERIFIER, f"Surface calculée {sc:.2f} ha.")

    # 4. Doublons, points proches, chevauchements
    ok = gdf[gdf["_utilisable"] & gdf.geometry.notna()].copy()
    ok["_wkb"] = ok.geometry.map(lambda g: g.normalize().wkb_hex)
    for _, grp in ok[ok["_wkb"].duplicated(keep=False)].groupby("_wkb"):
        ids = [etiquette(i) for i in grp.index]
        for i in grp.index:
            autres = [x for x in ids if x != etiquette(i)] or ids
            reg.ajouter(i, etiquette(i), gdf.at[i, "_prod"], "Doublon de géométrie", GRAVITE_CORRIGER,
                        "Mêmes coordonnées que : " + ", ".join(autres) + ".")
    deja_doublon = set(ok.index[ok["_wkb"].duplicated(keep=False)])

    metres = ok.to_crs("EPSG:32630")
    pts = metres[metres.geom_type == "Point"]
    if len(pts) > 1:
        tampon = gpd.GeoDataFrame(geometry=pts.buffer(DISTANCE_POINTS_PROCHES_M), crs=pts.crs, index=pts.index)
        j = gpd.sjoin(tampon, gpd.GeoDataFrame(geometry=pts.geometry, index=pts.index), predicate="intersects")
        for a, b in j["index_right"].items():
            if a < b and not (a in deja_doublon and b in deja_doublon):
                dist = pts.geometry[a].distance(pts.geometry[b])
                for x, y in ((a, b), (b, a)):
                    reg.ajouter(x, etiquette(x), gdf.at[x, "_prod"], "Points très proches", GRAVITE_VERIFIER,
                                f"À {dist:.1f} m de la parcelle {etiquette(y)}.")

    polys = metres[metres.geom_type.isin(["Polygon", "MultiPolygon"])]
    polys = polys[polys.is_valid]
    if len(polys) > 1:
        g2 = gpd.GeoDataFrame(geometry=polys.geometry, index=polys.index, crs=polys.crs)
        j = gpd.sjoin(g2, g2, predicate="intersects")
        j = j[j.index < j["index_right"]]
        for a, b in j["index_right"].items():
            if a in deja_doublon and b in deja_doublon:
                continue
            inter = polys.geometry[a].intersection(polys.geometry[b]).area / 10_000
            if inter < CHEVAUCHEMENT_MIN_HA:
                continue
            plus_petite = min(polys.geometry[a].area, polys.geometry[b].area) / 10_000
            part = inter / plus_petite if plus_petite else 0
            grav = GRAVITE_CORRIGER if part >= 0.05 else GRAVITE_VERIFIER
            for x, y in ((a, b), (b, a)):
                reg.ajouter(x, etiquette(x), gdf.at[x, "_prod"], "Chevauchement", grav,
                            f"Chevauche la parcelle {etiquette(y)} sur {inter:.2f} ha "
                            f"({part:.0%} de la plus petite).")

    anomalies = pd.DataFrame(reg.lignes, columns=["_idx", "Code parcelle", "Producteur", "Anomalie", "Gravité",
                                                  "Détail", "Action recommandée"])
    ordre = {GRAVITE_BLOQUANT: 0, GRAVITE_CORRIGER: 1, GRAVITE_VERIFIER: 2}
    anomalies = anomalies.sort_values(["Gravité", "Code parcelle"], key=lambda s: s.map(ordre) if s.name == "Gravité" else s)

    # Statut par parcelle
    def statut(i):
        grav = set(anomalies.loc[anomalies["_idx"] == i, "Gravité"])
        if GRAVITE_BLOQUANT in grav or GRAVITE_CORRIGER in grav:
            return "À corriger"
        if GRAVITE_VERIFIER in grav:
            return "À vérifier"
        return "Conforme (données)"
    parcelles = pd.DataFrame({
        "Code parcelle": [etiquette(i) for i in gdf.index],
        "Producteur": gdf["_prod"],
        "Type de géométrie": [g.geom_type if g is not None and not g.is_empty else "aucune" for g in gdf.geometry],
        "Surface déclarée (ha)": gdf["_surf_decl"].round(2),
        "Surface calculée (ha)": gdf["_surf_calc"].round(2),
        "Nombre d'anomalies": [int((anomalies["_idx"] == i).sum()) for i in gdf.index],
        "Statut données": [statut(i) for i in gdf.index],
        "Envoyée à Whisp": gdf["_utilisable"].map({True: "Oui", False: "Non"}),
    })
    return anomalies.drop(columns="_idx"), parcelles, gdf


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------

def exporter(anomalies, parcelles, gdf, source: Path, sortie: Path, pays: str):
    sortie.mkdir(parents=True, exist_ok=True)
    n = len(parcelles)
    compte = parcelles["Statut données"].value_counts()
    resume = pd.DataFrame([
        ("Fichier contrôlé", source.name),
        ("Pays", pays or "non précisé"),
        ("Parcelles lues", n),
        ("Conformes (données)", int(compte.get("Conforme (données)", 0))),
        ("À vérifier", int(compte.get("À vérifier", 0))),
        ("À corriger", int(compte.get("À corriger", 0))),
        ("Anomalies relevées", len(anomalies)),
        ("Parcelles envoyables à Whisp", int((parcelles["Envoyée à Whisp"] == "Oui").sum())),
    ], columns=["Indicateur", "Valeur"])
    par_type = (anomalies.groupby(["Anomalie", "Gravité"]).size().reset_index(name="Nombre")
                .sort_values("Nombre", ascending=False))

    xlsx = sortie / "anomalies.xlsx"
    with pd.ExcelWriter(xlsx, engine="openpyxl") as w:
        resume.to_excel(w, sheet_name="Résumé", index=False)
        par_type.to_excel(w, sheet_name="Résumé", index=False, startrow=len(resume) + 2)
        anomalies.to_excel(w, sheet_name="Anomalies", index=False)
        parcelles.to_excel(w, sheet_name="Parcelles", index=False)
        for ws in w.book.worksheets:
            for col in ws.columns:
                largeur = max(len(str(c.value)) if c.value is not None else 0 for c in col)
                ws.column_dimensions[col[0].column_letter].width = min(max(12, largeur + 2), 70)
    anomalies.to_csv(sortie / "anomalies.csv", index=False, encoding="utf-8-sig")

    # GeoJSON pour Whisp : identifiant seul, sans nom de producteur
    w_gdf = gdf[gdf["_utilisable"]].copy()
    w_gdf = gpd.GeoDataFrame({"plot_id": [x or f"ligne_{i + 2}" for i, x in zip(w_gdf.index, w_gdf["_id"])]},
                             geometry=w_gdf.geometry.values, crs="EPSG:4326")
    for f in sortie.glob("whisp_lot_*.geojson"):
        f.unlink()
    for k, debut in enumerate(range(0, len(w_gdf), TAILLE_LOT_WHISP), start=1):
        w_gdf.iloc[debut:debut + TAILLE_LOT_WHISP].to_file(sortie / f"whisp_lot_{k:02d}.geojson", driver="GeoJSON")
    return resume, par_type


def main(argv=None):
    ap = argparse.ArgumentParser(description="Contrôle qualité d'un fichier de parcelles (AgriSecur).")
    ap.add_argument("fichier", type=Path)
    ap.add_argument("--pays", choices=["CI", "GH"], default="CI", help="Pays des parcelles (défaut : CI)")
    ap.add_argument("--sortie", type=Path, default=None, help="Dossier de sortie (défaut : resultats_<fichier>)")
    a = ap.parse_args(argv)
    if not a.fichier.exists():
        raise SystemExit(f"Fichier introuvable : {a.fichier}")
    sortie = a.sortie or a.fichier.parent / f"resultats_{a.fichier.stem}"
    gdf = lire_fichier(a.fichier)
    anomalies, parcelles, gdf = controler(gdf, a.pays)
    resume, par_type = exporter(anomalies, parcelles, gdf, a.fichier, sortie, a.pays)
    print(resume.to_string(index=False))
    print()
    print(par_type.to_string(index=False) if len(par_type) else "Aucune anomalie.")
    print(f"\nRésultats dans : {sortie}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
