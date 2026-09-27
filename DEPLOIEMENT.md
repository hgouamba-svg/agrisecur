# Mettre AgriSecur en ligne sur Fly.io (option payante)

> Solution gratuite retenue : Oracle Cloud + Railway en secours, voir
> `deploy/oracle/GUIDE.md`. Ce guide Fly.io reste une alternative payante.

Railway (offre gratuite expirée) est remplacé par Fly.io : environ 4 $ par mois
pour un serveur toujours allumé (512 Mo) et 1 Go de disque persistant pour la
base SQLite. Le port SMTP 587 (e-mails OVH Zimbra) n'y est pas bloqué.

## 1. Créer l'application

Depuis un ordinateur :

```bash
# installer l'outil Fly (macOS / Linux)
curl -L https://fly.io/install.sh | sh
# Windows (PowerShell) : iwr https://fly.io/install.ps1 -useb | iex

fly auth signup                # ou : fly auth login
cd agrisecur                   # le dossier du projet
fly launch --no-deploy --copy-config --name agrisecur --region cdg
fly volumes create agrisecur_data --region cdg --size 1
```

Si le nom `agrisecur` est déjà pris, prenez-en un autre (ex. `agrisecur-ci`)
et mettez-le aussi dans `fly.toml` (ligne `app = ...`).

## 2. Renseigner les secrets

Mêmes valeurs que sur Railway. `ADMIN_KEY` est obligatoire : sans elle, le
serveur refuse de démarrer en production.

```bash
fly secrets set \
  ADMIN_KEY="..." \
  SMTP_HOST="ssl0.ovh.net" SMTP_PORT="587" \
  SMTP_USER="support@agrisecur.com" SMTP_PASS="..." \
  WHISP_API_KEY="..."
```

Facultatifs : `PAIEMENT_MODE`, `CINETPAY_API_KEY`, `CINETPAY_SITE_ID`,
`PROMO_ACTIVE`, `MOBILE_MONEY_FRAIS_TAUX`, etc.

Adresse IP des visiteurs (anti brute-force) : sur Fly, l'en-tête `Fly-Client-IP`
est utilisé automatiquement. Sur Railway (ou derrière Caddy sur Oracle), définir
`TRUST_PROXY=1` pour que le serveur lise la dernière entrée de `X-Forwarded-For`
ajoutée par le proxy ; sans cette variable, tous les visiteurs partagent l'IP du proxy.

Ne pas définir `SITE_PASSWORD` tant que le verrou d'accès n'est pas corrigé :
il utilise le même en-tête `Authorization` que les sessions, donc les
utilisateurs connectés seraient bloqués.

## 3. Déployer

```bash
fly deploy
```

L'app répond alors sur `https://agrisecur.fly.dev`. Vérification :
`https://agrisecur.fly.dev/api/health` doit afficher `{"ok":true,...}`.

## 4. Rebrancher www.agrisecur.com (Cloudflare)

```bash
fly certs add www.agrisecur.com
fly certs add agrisecur.com
```

Dans Cloudflare → DNS, remplacez les anciens enregistrements Railway :

| Type  | Nom | Cible                                     | Proxy                 |
|-------|-----|-------------------------------------------|-----------------------|
| CNAME | www | agrisecur.fly.dev                         | DNS only (nuage gris) |
| A     | @   | IPv4 donnée par `fly ips list`            | DNS only (nuage gris) |
| AAAA  | @   | IPv6 donnée par `fly ips list`            | DNS only (nuage gris) |

Laissez le nuage gris le temps que `fly certs show www.agrisecur.com` indique
que le certificat est émis (quelques minutes).

## 5. Mettre à jour

Après chaque modification poussée sur GitHub : `fly deploy`.

## Sauvegarder la base

```bash
fly ssh sftp get /data/agrisecur.db ./sauvegarde-agrisecur.db
```

## Récupérer la base Railway et la mettre sur Fly

1. Réactiver Railway (plan Free ou Hobby) pour que le service redémarre avec
   ce code : Railway conserve les données environ 30 jours après l'expiration.
2. Sur le site Railway, se connecter à l'espace admin et cliquer sur
   « Télécharger une sauvegarde de la base ». On obtient `agrisecur-AAAA-MM-JJ.db`.
3. Envoyer ce fichier sur Fly, puis redémarrer :

```bash
fly ssh sftp shell
put agrisecur-AAAA-MM-JJ.db /data/agrisecur.db
# (Ctrl+D pour quitter)
fly apps restart agrisecur
```

Le même bouton sert ensuite à faire des sauvegardes régulières depuis Fly.
