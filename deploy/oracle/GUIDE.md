# AgriSecur sur Oracle Cloud (gratuit) + Railway en secours

## Qui fait quoi

- **Oracle Cloud** : le site principal. Serveur « Always Free », allumé en
  continu, donc les tâches automatiques (délais de contestation, analyses
  WHISP) tournent normalement.
- **Railway (plan Free)** : le secours. Il reste branché sur GitHub et se met
  en veille quand personne ne l'utilise. Si Oracle tombe, on y remet la
  dernière sauvegarde et on bascule le DNS.

Un seul des deux reçoit les vrais utilisateurs à un instant donné : chacun a
sa propre base, et deux sites actifs en même temps auraient deux bases
différentes.

## 1. Créer le serveur Oracle (15 minutes, sur ordinateur)

1. Créer un compte sur oracle.com/cloud/free. Région d'origine :
   **France Central (Paris)**. Ce choix est définitif. Une carte bancaire est
   demandée pour vérifier l'identité, sans prélèvement.
2. Menu → Compute → Instances → **Create instance** :
   - Image : **Ubuntu 24.04**
   - Shape : **VM.Standard.A1.Flex** (1 OCPU, 6 Go) ; si Oracle répond
     « out of capacity », prendre **VM.Standard.E2.1.Micro**
   - Télécharger la **clé SSH privée** proposée et la garder précieusement
3. Ouvrir les ports web : page de l'instance → Subnet → Security List →
   **Add Ingress Rules** : source `0.0.0.0/0`, TCP, ports `80,443`.

Point de vigilance : Oracle peut récupérer une instance gratuite qui reste
très peu utilisée pendant 7 jours. Passer le compte en « Pay As You Go »
(Billing → Upgrade) est la parade la plus citée ; la facture reste à 0 € tant
qu'on reste dans les ressources gratuites. Les sauvegardes quotidiennes et
Railway en secours couvrent ce risque de toute façon.

## 2. Installer AgriSecur (une commande)

Depuis le Terminal du Mac :

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@IP_DU_SERVEUR
```

Puis, sur le serveur :

```bash
curl -fsSL https://raw.githubusercontent.com/hgouamba-svg/agrisecur/main/deploy/oracle/install.sh -o install.sh
sudo bash install.sh
```

Compléter ensuite la configuration (mêmes valeurs que dans les Variables
Railway : `ADMIN_KEY`, `SMTP_PASS`, `WHISP_API_KEY`) :

```bash
sudo nano /etc/agrisecur.env
sudo systemctl restart agrisecur
```

Test : ouvrir `http://IP_DU_SERVEUR` dans le navigateur.

Ce que le script met en place :
- démarrage automatique du site, et redémarrage en cas de plantage ;
- mise à jour automatique depuis GitHub toutes les 5 minutes (comme Railway) ;
- sauvegarde de la base chaque nuit, 14 jours conservés dans
  `/var/lib/agrisecur/backups` ;
- HTTPS automatique dès que le domaine est branché.

## 3. Transférer la base

1. Dans l'app admin www.agrisecur.com/admin (Railway), onglet **Rentabilité** →
   **Télécharger une sauvegarde de la base**.
2. Depuis le Mac :

```bash
scp -i ~/Downloads/ssh-key-*.key ~/Downloads/agrisecur-*.db ubuntu@IP_DU_SERVEUR:~/
```

3. Sur le serveur :

```bash
sudo systemctl stop agrisecur
sudo cp ~/agrisecur-*.db /var/lib/agrisecur/agrisecur.db
sudo chown agrisecur:agrisecur /var/lib/agrisecur/agrisecur.db
sudo systemctl start agrisecur
```

## 4. Basculer www.agrisecur.com vers Oracle

Dans Cloudflare → DNS, remplacer les enregistrements qui pointent vers
Railway par :

| Type | Nom | Contenu          | Proxy                 |
|------|-----|------------------|-----------------------|
| A    | www | IP_DU_SERVEUR    | DNS only (nuage gris) |
| A    | @   | IP_DU_SERVEUR    | DNS only (nuage gris) |

Puis, sur le serveur, activer le HTTPS :

```bash
sudo DOMAIN="www.agrisecur.com agrisecur.com" bash install.sh
```

Railway reste en place comme secours ; retirer son domaine personnalisé dans
Railway (Settings → Networking) pour éviter toute confusion.

## Revenir sur Railway en cas de panne d'Oracle

1. Récupérer la dernière sauvegarde (`/var/lib/agrisecur/backups`) si le
   serveur est encore accessible.
2. Remettre le domaine sur Railway et repointer Cloudflare vers Railway.
3. Importer la sauvegarde sur Railway : me demander, je fournis la marche à
   suivre selon la situation.
