"""Tests sur le fichier fictif « Coopérative Exemple ». Lancer : python -m pytest -q"""
from pathlib import Path

import pytest

import controle_parcelles as cp
import generer_exemple as ge

# Parcelles touchées par ricochet d'une erreur volontaire (l'autre moitié d'une paire, etc.)
RICOCHETS = {"EX-0061", "EX-0071", "EX-0106", "EX-0120", "EX-0101"}


@pytest.fixture(scope="module")
def dossier(tmp_path_factory):
    d = tmp_path_factory.mktemp("exemple")
    ge.ecrire(ge.generer(), d)
    return d


def _controle(chemin):
    anomalies, parcelles, gdf = cp.controler(cp.lire_fichier(chemin), "CI")
    return anomalies


def test_geojson_trouve_toutes_les_erreurs(dossier):
    a = _controle(dossier / "cooperative_exemple.geojson")
    for code, type_ in ge.ERREURS_ATTENDUES.items():
        assert ((a["Code parcelle"] == code) & (a["Anomalie"] == type_)).any(), f"{code} : {type_} non détecté"


def test_pas_de_fausse_alerte(dossier):
    a = _controle(dossier / "cooperative_exemple.geojson")
    attendus = set(ge.ERREURS_ATTENDUES) | RICOCHETS
    en_trop = set(a["Code parcelle"]) - attendus
    assert not en_trop, f"Alertes inattendues : {sorted(en_trop)}"


@pytest.mark.parametrize("fichier", ["cooperative_exemple.kml", "cooperative_exemple_points.csv",
                                     "cooperative_exemple_polygones.zip"])
def test_autres_formats_lisibles(dossier, fichier):
    a = _controle(dossier / fichier)
    assert len(a) > 0


def test_csv_detecte_la_precision(dossier):
    a = _controle(dossier / "cooperative_exemple_points.csv")
    assert ((a["Code parcelle"] == "EX-0031") & (a["Anomalie"] == "Précision insuffisante")).any()


def test_exports(dossier, tmp_path):
    src = dossier / "cooperative_exemple.geojson"
    anomalies, parcelles, gdf = cp.controler(cp.lire_fichier(src), "CI")
    cp.exporter(anomalies, parcelles, gdf, src, tmp_path, "CI")
    assert (tmp_path / "anomalies.xlsx").exists()
    lot = tmp_path / "whisp_lot_01.geojson"
    assert lot.exists()
    texte = lot.read_text(encoding="utf-8")
    assert "Producteur fictif" not in texte  # aucun nom envoyé à Whisp
