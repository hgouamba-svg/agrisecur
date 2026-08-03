# AgriSecur MVP — API backend (filière cacao, V1)

Backend fonctionnel implémentant le **tunnel séquestre** décrit dans les CGU/CGV
et le cahier des charges technique : commande → séquestre → expédition →
contrôle → libération des fonds (ou litige/remboursement).

Périmètre initial construit sur la filière cacao, désormais ouvert à d'autres
filières ivoiriennes (anacarde, café, coton, hévéa, palmier à huile, riz,
cultures vivrières) — le vendeur choisit sa filière à la publication du lot,
l'acheteur peut filtrer le catalogue par filière.

## Ce que c'est — et ce que ce n'est PAS

✅ La vraie logique métier : état des commandes, calcul de la commission (4%),
KYC bloquant, délai de contestation, piste d'audit horodatée.

❌ Pas encore branché sur un vrai paiement mobile money / virement bancaire.
Les fonds sont "séquestrés" au sens comptable dans la base de données, pas
réellement débités sur un compte. Le branchement à un agrégateur agréé BCEAO
(CinetPay, PayDunya, ou autre) est l'étape suivante, une fois votre RCCM
obtenu et un compte marchand ouvert.

✅ Une interface web réelle (`public/index.html`) est branchée sur cette API
— servie par le même serveur, donc pas de souci de CORS ni de configuration
séparée. C'est du HTML/JS simple (pas de framework, pas de build) volontairement,
pour rester dans le "zéro dépendance" du reste du projet.

✅ **Authentification réelle** : chaque vendeur et chaque acheteur crée un
compte (email + mot de passe, haché avec `scrypt`, jamais stocké en clair) et
reçoit un jeton de session. Seul le vendeur propriétaire d'une commande peut
l'expédier, seul l'acheteur qui l'a passée peut la clôturer ou réclamer.
Les actions de back-office (valider un KYC, trancher un litige) nécessitent
une clé admin séparée (`X-Admin-Key`), pas un compte vendeur/acheteur.

❌ Pas encore de base "producteur" enrichie ni de moyen de paiement réel — la
validation KYC et la médiation se font désormais depuis un vrai écran de
back-office (plus de commande `curl` à taper), mais le paiement reste "à
brancher" (cf. plus haut).

## Services à valeur ajoutée (SVA) — complément de marge à la commission

En plus de la commission de 4%, deux leviers de revenu sont maintenant actifs :

- **Mise en avant de lots** : 5 000 FCFA (3 jours), 9 000 FCFA (7 jours), ou
  15 000 FCFA (14 jours) — le lot remonte en tête du catalogue.
- **Abonnement Vendeur Pro** : 10 000 FCFA / 30 jours — badge visible des
  acheteurs, mise en avant continue, et accès à un comparatif de prix par
  filière (le prix moyen constaté sur la plateforme vs le prix du vendeur).

Comme pour le reste de la plateforme, ces achats sont enregistrés dans une
table dédiée (`sva_achats`) mais ne débitent pas encore un vrai moyen de
paiement — utile dès maintenant pour suivre ce que ces services généreraient
une fois le paiement réel branché. Le back-office (onglet **Revenus SVA**)
affiche le total et le détail de chaque achat.

## Promotion de lancement — commission réduite pour les 100 premiers vendeurs

Argument commercial face à un concurrent déjà installé : les **100 premiers
vendeurs inscrits, dans les 60 premiers jours** (le premier des deux seuils
atteint ferme l'inscription à la promo) bénéficient automatiquement d'une
commission à **2% au lieu de 4%**, affichée comme badge "★ Fondateur" sur le
catalogue et dans leur espace vendeur. Un compteur en temps réel ("X places
restantes · X jours restants") s'affiche sur la page d'accueil publique.

Un vendeur déjà admis comme fondateur garde le **badge "★ Fondateur"** de
façon permanente (reconnaissance), mais **pas le tarif à 2% indéfiniment** —
une fois la fenêtre d'inscription fermée (100 vendeurs ou 60 jours), toutes
les commandes, y compris celles des fondateurs historiques, repassent
automatiquement à 4%. Sans cette limite, la plateforme perdrait de la marge
en continu sur cette cohorte — ce n'est pas ce que promettent les CGU/CGV,
qui ne protègent que les commandes déjà conclues au taux réduit, pas les
commandes futures indéfiniment.

La date de lancement de la promo est enregistrée en base au premier
démarrage du serveur (table `app_config`) — elle survit aux redémarrages,
contrairement à un simple calcul basé sur l'heure de démarrage du process.

C'est une promotion **datée et réversible**, pas un changement de tarif
permanent — désactivable ou ajustable à tout moment sans toucher au code :

```bash
PROMO_ACTIVE=false node server.js                                    # coupe la promo
PROMO_SEUIL_VENDEURS=50 PROMO_COMMISSION_TAUX=0 node server.js       # ajuste seuil/taux
PROMO_JOURS_LIMITE=90 node server.js                                 # ajuste la durée
```

## Libération automatique des fonds (tâche planifiée)

Conformément à l'Article 4 des CGU/CGV, une commande "En contrôle" dont le
délai de contestation expire sans réclamation doit être clôturée et les fonds
libérés — **automatiquement**, sans action manuelle. Le serveur exécute cette
vérification tout seul, toutes les 5 minutes par défaut (et une première fois
immédiatement au démarrage), sans dépendance externe.

Réglable via variable d'environnement :
```bash
CRON_INTERVAL_MINUTES=15 node server.js
```

**En production**, préférez un vrai ordonnanceur externe (cron système, tâche
planifiée du fournisseur cloud) à ce mécanisme interne — un `setInterval` ne
survit pas à un redémarrage du serveur, alors qu'un cron système continue de
tourner indépendamment.

## Marge nette (commission - frais de paiement)

Modèle appliqué depuis la dernière mise à jour, décidé pour ne jamais faire
perdre d'argent à la plateforme sur une commande, y compris avec la promo
fondateur à 2% :

- **Mobile money** : les frais de traitement (2,5% par défaut) sont
  **répercutés séparément sur l'acheteur**, annoncés clairement avant
  confirmation de la commande et détaillés sur la fiche de commande
  ("Frais de traitement" + "Total payé par l'acheteur"). Neutre pour votre
  marge — vous reversez ce montant à l'agrégateur.
- **Virement bancaire** : frais fixe (5 000 FCFA par défaut) toujours
  **absorbé par la plateforme**, sans ligne supplémentaire pour l'acheteur —
  négligeable sur les gros montants habituellement virés.

Le back-office (onglet **Rentabilité**) distingue "Frais absorbés (virement)"
et "Frais mobile money collectés (acheteurs)" pour un suivi transparent.

Réglable via variables d'environnement :

```bash
MOBILE_MONEY_FRAIS_TAUX=0.02 VIREMENT_FRAIS_FCFA=3000 node server.js
```

## Paiement par virement bancaire

En plus du mobile money (traité comme instantané dans ce MVP), l'acheteur peut
choisir le **virement bancaire** à la commande. Contrairement au mobile money,
aucune API ne confirme un virement en temps réel — la commande reste au statut
**« En attente de virement »** (le lot est réservé, mais le tunnel séquestre ne
démarre pas) jusqu'à ce qu'un administrateur vérifie le relevé bancaire et
clique **« Confirmer réception du virement »** depuis le back-office (onglet
« Virements en attente »). Une fois confirmée, la commande rejoint le tunnel
séquestre normal.

## Croissance côté acheteurs — parrainage et partage WhatsApp

- **Parrainage** : chaque acheteur a un code unique (visible dans "Mon
  compte"). Un filleul inscrit avec ce code déclenche, dès son **premier
  achat clôturé**, un crédit de 5 000 FCFA (par défaut) pour le parrain —
  appliqué **automatiquement** en réduction des frais mobile money de sa
  prochaine commande. Protégé contre le double crédit (un filleul ne
  récompense son parrain qu'une seule fois, quoi qu'il arrive).
- **Partage WhatsApp** : après une commande clôturée, l'acheteur peut
  partager son achat en un clic (lien `wa.me` pré-rempli) — et partager son
  code de parrainage depuis "Mon compte", pensé pour le canal réellement
  utilisé par vos acheteurs en Côte d'Ivoire.

Réglable via variable d'environnement :
```bash
REFERRAL_CREDIT_FCFA=3000 node server.js
```

## Traçabilité de la parcelle (base EUDR)

À la publication d'un lot, le vendeur peut renseigner (facultatif) les
**coordonnées GPS de la parcelle** et cocher une **déclaration sur l'honneur
de non-déforestation** (référence réglementaire EUDR, 31 décembre 2020).
Un badge "🌍 Parcelle traçable" apparaît alors sur le catalogue, cliquable
pour ouvrir la localisation sur Google Maps.

**Limites honnêtes** : les coordonnées sont validées comme géographiquement
plausibles pour la Côte d'Ivoire (latitude 4°-11°, longitude -9° à -2°), mais
**la déclaration de non-déforestation est auto-certifiée par le vendeur, non
vérifiée par AgriSecur** (pas d'analyse satellite ni de tiers de
certification à ce stade). C'est une base de traçabilité, pas une
certification EUDR complète — utile comme argument de confiance auprès
d'acheteurs export, à faire évoluer si la demande le justifie.

## Dépenses opérationnelles et export comptable

**Ce que c'est** : un journal léger de vos frais (hébergement, marketing,
juridique, déplacements...) dans l'onglet back-office **Dépenses**, et deux
boutons d'export CSV (commandes, dépenses) dans l'onglet **Rentabilité** —
compatibles Excel/Google Sheets, à transmettre directement à votre
comptable.

**Ce que ce n'est PAS** : un logiciel de comptabilité certifié SYSCOHADA. Ça
ne remplace pas un vrai outil comptable utilisé par un professionnel — c'est
un suivi interne et une base d'export, rien de plus.

Avec ça, l'onglet Rentabilité affiche un vrai **résultat net** :
commission + revenus SVA − frais absorbés − impôt estimé − dépenses
opérationnelles.

## Estimation fiscale dans l'onglet Rentabilité

En plus de la marge nette (commission - frais de paiement), l'onglet
**Rentabilité** affiche désormais une **estimation d'impôt** (5% par défaut,
hypothèse régime Microentreprises ivoirien qui remplace IS/TVA/patente par
une taxe unique sur le chiffre d'affaires) et la **marge nette après impôt**
qui en découle.

**Hypothèse à confirmer avec un comptable ivoirien** : ce calcul suppose que
le chiffre d'affaires fiscal d'AgriSecur est la **commission encaissée**
(vous êtes intermédiaire, pas propriétaire de la marchandise), pas le volume
total des transactions qui transitent par le séquestre. Si cette hypothèse
est fausse, le régime fiscal applicable — et donc ce calcul — change
significativement.

Réglable via variable d'environnement :
```bash
TAUX_IMPOT_ESTIME=0.04 node server.js
```

## Preuves photo — limiter les fausses réclamations

- **À l'expédition** : le vendeur peut joindre une photo du colis
  (facultatif mais recommandé — protège en cas de contestation sur l'état
  du lot au départ).
- **À la réclamation** : la photo devient **obligatoire**. Un acheteur ne
  peut plus ouvrir un litige sur simple déclaration — il doit produire une
  preuve visuelle du problème constaté.

Les deux photos sont affichées côte à côte dans le panneau admin
"Litiges en cours", pour trancher sur du concret plutôt que la parole de
l'un contre l'autre. Ne remplace pas une vraie vérification indépendante
(inspection tierce type SGS/Bureau Veritas pour les gros volumes), mais
relève significativement le coût d'une fausse réclamation.

## Délai de livraison distinct du délai de contestation

Correction d'une vraie faille de protection : auparavant, cliquer "Expédier"
démarrait immédiatement le délai de contestation de 24-48h, alors que rien
ne prouvait que la marchandise était réellement arrivée — un transport plus
long que ce délai aurait pu libérer les fonds au vendeur avant même que
l'acheteur reçoive quoi que ce soit.

**Nouveau flux** :
1. Le vendeur expédie et indique une **durée de livraison estimée** (1 à 30
   jours) — statut "En transit".
2. Le délai de contestation démarre seulement quand :
   - **l'acheteur confirme activement la réception** ("Confirmer la
     réception"), ou
   - **le délai de livraison estimé + 2 jours de marge est dépassé** sans
     confirmation — filet de sécurité automatique (tâche planifiée) pour ne
     pas bloquer indéfiniment le paiement du vendeur face à un acheteur
     injoignable ou de mauvaise foi.

L'acheteur peut aussi valider ou ouvrir une réclamation directement depuis
"En transit", sans étape de confirmation séparée si la marchandise est déjà
en main.

## Confiance et croissance — 4 ajouts

- **Barre de progression visuelle** dans le tunnel séquestre acheteur
  (paiement → expédition → délai de contrôle avec compte à rebours → fonds
  libérés), plus lisible qu'un simple statut texte.
- **Badge "⚡ Expédie en &lt;24h"** — calculé automatiquement à partir de
  l'historique réel du vendeur (moyenne sur au moins 3 expéditions), affiché
  sur le catalogue.
- **Parrainage gamifié** — paliers Bronze (1+ filleul), Argent (3+), Or (6+),
  affichés dans "Mon compte" avec le nombre de filleuls manquants avant le
  prochain palier.
- **Repères de coûts de transport** dans "Aide & contact" — ordres de
  grandeur indicatifs (Abidjan–Bouaké, Abidjan–Korhogo), explicitement
  présentés comme informatifs et non comme un devis ou une mise en relation
  transporteur réelle.

Volontairement non construits dans cette passe, pour des raisons différentes :
notifications WhatsApp/SMS (nécessite un compte professionnel payant type
WhatsApp Business API ou Twilio/Africa's Talking — hors de portée sans RCCM),
et gestion des acomptes/paiement partiel (touche à la machine à états des
commandes et au calcul de commission — mérite un chantier dédié).

## Accéder au back-office

Depuis l'écran de connexion (Vendeur/Acheteur), cliquez sur **« Accès
back-office »** en bas de la carte, puis saisissez la clé admin (celle définie
via `ADMIN_KEY`, ou `changez-cette-cle-admin` par défaut). Vous accédez à deux
écrans :

- **Vérifications KYC** : liste de tous les vendeurs inscrits, avec boutons
  Valider / Rejeter.
- **Litiges en cours** : liste des commandes en litige, avec boutons pour
  trancher en faveur du vendeur ou de l'acheteur (une note de médiation
  optionnelle est demandée et consignée dans la piste d'audit).

## Clé admin — IMPORTANT avant tout usage réel

Par défaut, la clé admin est `changez-cette-cle-admin` (visible dans
`auth.js`). Pour la définir vous-même au lancement :

```bash
ADMIN_KEY=votre-cle-secrete node server.js
```

Sans ça, n'importe qui connaissant la valeur par défaut pourrait valider des
KYC ou trancher des litiges. Changez-la avant toute exposition au-delà d'un
test local.

## Lancer le serveur (backend + frontend ensemble)

Aucune installation requise (`npm install` n'est pas nécessaire — tout est en
Node natif : module `http` + `node:sqlite`).

```bash
node server.js
# AgriSecur MVP API — écoute sur http://localhost:3001
```

Puis ouvrez **http://localhost:3001** dans votre navigateur : c'est l'interface
complète (catalogue, espace vendeur, tunnel séquestre), déjà branchée sur les
vraies routes de l'API ci-dessous.

Nécessite Node.js ≥ 22.5 (pour `node:sqlite`). Vérifiez avec `node -v`.

Un fichier `agrisecur.db` (SQLite) est créé automatiquement au premier lancement.

## Parcours à essayer dans le navigateur

1. Sur l'écran de connexion : choisissez **Vendeur**, cliquez **Créer un
   compte**, remplissez le formulaire et validez — vous êtes automatiquement
   connecté.
2. Ouvrez un **nouvel onglet** sur `http://localhost:3001`, cliquez **« Accès
   back-office »**, saisissez la clé admin, et validez le KYC du vendeur que
   vous venez de créer depuis l'écran « Vérifications KYC ».
3. Revenez sur votre premier onglet (vendeur), rechargez la page, publiez un
   lot de cacao.
4. **Déconnectez-vous**, recréez un compte cette fois côté **Acheteur**.
5. Onglet **Catalogue & achat** : le lot apparaît, cliquez « Commander ».
6. Onglet **Tunnel séquestre** : la commande apparaît avec montant/commission.
   Reconnectez-vous en Vendeur pour « Expédier », puis en Acheteur pour
   « Valider la conformité » — observez la piste d'audit se remplir à chaque
   étape.

## Parcours testé de bout en bout

1. `POST /api/sellers` — créer un vendeur (statut KYC "en_attente" par défaut)
2. `POST /api/products` sur ce vendeur → **rejeté (403)** tant que le KYC n'est
   pas validé
3. `POST /api/sellers/:id/kyc` avec `{"statut":"valide"}` — validation KYC
4. `POST /api/products` — publication d'un lot (réussit maintenant)
5. `POST /api/buyers` — créer un acheteur
6. `POST /api/orders` — passer commande : calcule montant total, commission
   4%, montant net vendeur ; statut = `sequestre`
7. `POST /api/orders/:id/expedier` — le vendeur expédie → statut = `en_controle`,
   ouvre le délai de contestation (48h par défaut)
8. `POST /api/orders/:id/cloturer` — l'acheteur valide la conformité →
   statut = `cloture`, fonds nets "libérés"

Chaque transition est enregistrée dans `order_events` (piste d'audit),
consultable via `GET /api/orders/:id`.

## Autres routes utiles

- `POST /api/orders/:id/reclamer` `{"motif": "..."}` — l'acheteur ouvre un
  litige pendant le délai de contestation (Article 5 des CGU/CGV)
- `POST /api/orders/:id/trancher-litige` `{"resolution": "rembourse"|"cloture", "note": "..."}`
  — la médiation interne tranche
- `POST /api/orders/:id/verifier-delai` — à appeler périodiquement (cron) pour
  clôturer automatiquement les commandes dont le délai de 48h a expiré sans
  réclamation
- `GET /api/products` — catalogue des lots disponibles
- `GET /api/orders` — liste de toutes les commandes

## Prochaines étapes techniques concrètes

1. **Authentification** minimale (email/mot de passe ou OTP mobile money) avant
   toute exposition au-delà d'un test local.
2. **Migration PostgreSQL** si le volume dépasse ce qu'une base SQLite fichier
   unique peut gérer confortablement (largement suffisant pour un pilote).
3. **Intégration paiement réelle** dès que le compte marchand chez un
   agrégateur agréé est ouvert — remplacer le "séquestre comptable" actuel
   par un vrai appel à leur API de cantonnement de fonds.
4. **Job planifié** (cron) qui appelle `verifier-delai` sur les commandes
   `en_controle` pour automatiser la libération après 48h.
