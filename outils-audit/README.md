# Outils d'audit AgriSecur (branche `outils-audit`)

Outils internes pour l'Audit RDUE express. **Ce dossier ne fait pas partie du site** et ne doit
pas être fusionné dans `main` (la branche `main` met le site en ligne).

## Contenu

| Fichier | Rôle |
| --- | --- |
| `controle_parcelles.py` | Contrôle qualité automatique d'un fichier de parcelles et export du tableau des anomalies |
| `generer_exemple.py` | Génère le fichier **fictif** « Coopérative Exemple » (120 parcelles, erreurs volontaires) |
| `test_controle_parcelles.py` | Tests automatiques sur le fichier fictif |
| `donnees/pays.geojson` | Frontières simplifiées de la Côte d'Ivoire et du Ghana (Natural Earth, domaine public) |
| `exemple/` | Fichiers fictifs générés (GeoJSON, KML, CSV, Shapefile zippé) |

## Installation

```bash
pip install -r requirements.txt
```

## Utilisation

```bash
python controle_parcelles.py fichier_client.geojson --pays CI
python controle_parcelles.py fichier_client.csv --pays GH --sortie resultats_client
```

Formats lus : GeoJSON, KML/KMZ, Shapefile (`.shp` ou `.zip`), CSV/Excel avec colonnes
latitude/longitude (noms reconnus : `latitude`, `lat`, `y`… ; `longitude`, `lon`, `lng`, `x`…).
Colonnes reconnues aussi : code parcelle (`plot_id`, `code_parcelle`, `id`…), surface
(`surface_ha`, `superficie`…), producteur (`producteur`, `farmer_id`…).

Sorties dans `resultats_<fichier>/` :

- `anomalies.xlsx` : feuilles Résumé, Anomalies (une ligne par anomalie, avec gravité et action
  recommandée) et Parcelles (statut de chaque parcelle) ;
- `anomalies.csv` ;
- `whisp_lot_NN.geojson` : géométries utilisables, **identifiant seul, sans nom de producteur**,
  par lots de 5 000, à déposer dans Whisp (https://whisp.openforis.org).

## Contrôles

| Contrôle | Gravité |
| --- | --- |
| Coordonnées manquantes, invalides ou à (0,0) | Bloquant |
| Parcelle hors du pays (à plus de 2 km de la frontière) | Bloquant |
| Point GPS pour une parcelle déclarée de 4 ha ou plus (polygone obligatoire, RDUE) | Bloquant |
| Polygone invalide (contour qui se croise, moins de 3 sommets, ligne ouverte) | Bloquant |
| Identifiant manquant ou en double | À corriger |
| Latitude et longitude inversées | À corriger |
| Surface déclarée et calculée écartées de plus de 20 % | À corriger |
| Même géométrie pour deux parcelles | À corriger |
| Chevauchement entre polygones (≥ 5 % de la plus petite) | À corriger (sinon À vérifier) |
| Précision inférieure à 6 décimales | À vérifier |
| Points à moins de 10 m l'un de l'autre | À vérifier |
| Parcelle à moins de 2 km d'une frontière (tracé approximatif) | À vérifier |
| Surface atypique (< 0,05 ha ou > 50 ha) ou point sans surface déclarée | À vérifier |

Les seuils sont en tête du script. Le script ne se connecte à aucun service : l'analyse du risque
de déforestation (Whisp) se fait ensuite, séparément.

## Tests

```bash
python generer_exemple.py      # régénère exemple/
python -m pytest -q
```

Toutes les données de `exemple/` sont inventées : « Coopérative Exemple » et « Producteur fictif
NNN » n'existent pas.
