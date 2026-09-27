#!/usr/bin/env python3
"""
Génère un fichier de parcelles ENTIÈREMENT FICTIF (« Coopérative Exemple ») pour tester
controle_parcelles.py et illustrer l'exemple de rapport. Aucune donnée réelle.

Les erreurs sont volontaires et listées dans ERREURS_ATTENDUES (utilisé par les tests).

Usage : python generer_exemple.py [--dossier exemple]
"""
import argparse
import math
import zipfile
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point, Polygon

GRAINE = 2026
# Zone fictive dans l'intérieur de la Côte d'Ivoire (loin des frontières)
LON0, LAT0 = -5.60, 6.40

ERREURS_ATTENDUES = {
    "EX-0005": "Coordonnées manquantes",
    "EX-0012": "Latitude et longitude inversées",
    "EX-0018": "Coordonnées invalides",
    "EX-0023": "Hors pays",
    "EX-0031": "Précision insuffisante",
    "EX-0040": "Identifiant en double",
    "EX-0050": "Polygone obligatoire (4 ha ou plus)",
    "EX-0060": "Points très proches",
    "EX-0070": "Doublon de géométrie",
    "EX-0101": "Polygone invalide",
    "EX-0105": "Chevauchement",
    "EX-0110": "Surface incohérente",
    "EX-0119": "Doublon de géométrie",
    "(ligne 116)": "Identifiant manquant",
}


def polygone(cx, cy, surface_ha, rng):
    """Polygone irrégulier d'environ surface_ha, centré sur (cx, cy)."""
    r_m = math.sqrt(surface_ha * 10_000 / math.pi)
    angles = np.sort(rng.uniform(0, 2 * math.pi, 8))
    pts = []
    for a in angles:
        r = r_m * rng.uniform(0.85, 1.15)
        dx = r * math.cos(a) / (111_320 * math.cos(math.radians(cy)))
        dy = r * math.sin(a) / 110_574
        pts.append((cx + dx, cy + dy))
    from shapely.affinity import scale
    from pyproj import Geod
    brut = Polygon(pts)
    a = abs(Geod(ellps="WGS84").geometry_area_perimeter(brut)[0]) / 10_000
    f = math.sqrt(surface_ha / a)
    ajuste = scale(brut, xfact=f, yfact=f, origin=(cx, cy))
    return Polygon([(round(x, 6), round(y, 6)) for x, y in ajuste.exterior.coords])


def generer():
    rng = np.random.default_rng(GRAINE)
    lignes = []
    # 90 points (parcelles de moins de 4 ha), grille espacée de ~400 m
    for k in range(1, 91):
        lon = LON0 + ((k - 1) % 10) * 0.0036 + rng.uniform(-0.0005, 0.0005)
        lat = LAT0 + ((k - 1) // 10) * 0.0036 + rng.uniform(-0.0005, 0.0005)
        lignes.append(dict(plot_id=f"EX-{k:04d}", producteur=f"Producteur fictif {k:03d}",
                           surface_ha=round(rng.uniform(0.8, 3.8), 2),
                           geometry=Point(round(lon, 6), round(lat, 6))))
    # 30 polygones (parcelles de 1 à 8 ha), plus au nord
    for k in range(91, 121):
        j = k - 91
        cx = LON0 + (j % 6) * 0.006
        cy = LAT0 + 0.05 + (j // 6) * 0.006
        s = round(rng.uniform(1.0, 8.0), 2)
        g = polygone(cx, cy, s, rng)
        while not g.is_valid:
            g = polygone(cx, cy, s, rng)
        lignes.append(dict(plot_id=f"EX-{k:04d}", producteur=f"Producteur fictif {k:03d}",
                           surface_ha=round(s * rng.uniform(0.95, 1.05), 2), geometry=g))
    df = pd.DataFrame(lignes).set_index("plot_id", drop=False)

    # --- Erreurs volontaires ---
    df.at["EX-0005", "geometry"] = None
    p = df.at["EX-0012", "geometry"]; df.at["EX-0012", "geometry"] = Point(p.y, p.x)
    df.at["EX-0018", "geometry"] = Point(0.0, 0.0)
    df.at["EX-0023", "geometry"] = Point(-1.623451, 6.688231)        # au Ghana
    p = df.at["EX-0031", "geometry"]; df.at["EX-0031", "geometry"] = Point(round(p.x, 3), round(p.y, 3))
    df.at["EX-0041", "plot_id"] = "EX-0040"                             # code en double
    df.at["EX-0050", "surface_ha"] = 6.2                                # point pour 6,2 ha
    p = df.at["EX-0060", "geometry"]
    df.at["EX-0061", "geometry"] = Point(round(p.x + 0.00004, 6), round(p.y + 0.00002, 6))  # ~5 m
    df.at["EX-0071", "geometry"] = df.at["EX-0070", "geometry"]         # même point
    c = df.at["EX-0101", "geometry"].centroid
    d = 0.0008
    df.at["EX-0101", "geometry"] = Polygon([(c.x - d, c.y - d), (c.x + d, c.y + d), (c.x + d, c.y - d),
                                            (c.x - d, c.y + d)])        # contour croisé (papillon)
    g105 = df.at["EX-0105", "geometry"]
    df.at["EX-0106", "geometry"] = Polygon([(round(x + 0.0006, 6), y) for x, y in g105.exterior.coords])
    df.at["EX-0106", "surface_ha"] = df.at["EX-0105", "surface_ha"]
    df.at["EX-0110", "surface_ha"] = round(df.at["EX-0110", "surface_ha"] / 2.5, 2)
    df.at["EX-0115", "plot_id"] = ""                                    # code manquant (ligne 116 du fichier)
    df.at["EX-0120", "geometry"] = df.at["EX-0119", "geometry"]         # même polygone
    df.at["EX-0120", "surface_ha"] = df.at["EX-0119", "surface_ha"]
    return df.reset_index(drop=True)


def ecrire_kml(gdf, chemin: Path):
    """KML écrit à la main : le pilote GDAL refuse les polygones invalides, qu'on veut garder."""
    from xml.sax.saxutils import escape
    morceaux = ['<?xml version="1.0" encoding="UTF-8"?>',
                '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
                "<name>Coopérative Exemple (données fictives)</name>"]
    for _, r in gdf.iterrows():
        g = r.geometry
        if g.geom_type == "Point":
            geo = f"<Point><coordinates>{g.x},{g.y}</coordinates></Point>"
        else:
            cs = " ".join(f"{x},{y}" for x, y in g.exterior.coords)
            geo = f"<Polygon><outerBoundaryIs><LinearRing><coordinates>{cs}</coordinates></LinearRing></outerBoundaryIs></Polygon>"
        morceaux.append(
            f"<Placemark><name>{escape(str(r.plot_id))}</name><ExtendedData>"
            f'<Data name="producteur"><value>{escape(str(r.producteur))}</value></Data>'
            f'<Data name="surface_ha"><value>{r.surface_ha}</value></Data>'
            f"</ExtendedData>{geo}</Placemark>")
    morceaux.append("</Document></kml>")
    chemin.write_text("\n".join(morceaux), encoding="utf-8")


def ecrire(df, dossier: Path):
    dossier.mkdir(parents=True, exist_ok=True)
    gdf = gpd.GeoDataFrame(df, geometry="geometry", crs="EPSG:4326")
    gdf.to_file(dossier / "cooperative_exemple.geojson", driver="GeoJSON")
    ecrire_kml(gdf[gdf.geometry.notna()], dossier / "cooperative_exemple.kml")
    # CSV : uniquement les points (latitude / longitude), comme un export Excel courant
    pts = df[df.geometry.map(lambda g: g is None or g.geom_type == "Point")].copy()
    pts["latitude"] = pts.geometry.map(lambda g: "" if g is None else f"{g.y:.{3 if abs(g.y*1000-round(g.y*1000))<1e-9 else 6}f}")
    pts["longitude"] = pts.geometry.map(lambda g: "" if g is None else f"{g.x:.{3 if abs(g.x*1000-round(g.x*1000))<1e-9 else 6}f}")
    pts[["plot_id", "producteur", "surface_ha", "latitude", "longitude"]].to_csv(
        dossier / "cooperative_exemple_points.csv", index=False)
    # Shapefile (zip) : uniquement les polygones
    shp_dir = dossier / "shp"
    shp_dir.mkdir(exist_ok=True)
    polys = gdf[gdf.geom_type == "Polygon"]
    polys.to_file(shp_dir / "cooperative_exemple_polygones.shp")
    with zipfile.ZipFile(dossier / "cooperative_exemple_polygones.zip", "w") as z:
        for f in shp_dir.iterdir():
            z.write(f, f.name)
    for f in shp_dir.iterdir():
        f.unlink()
    shp_dir.rmdir()
    print(f"{len(df)} parcelles fictives écrites dans {dossier}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dossier", type=Path, default=Path(__file__).resolve().parent / "exemple")
    ecrire(generer(), ap.parse_args().dossier)
