// sw.js — Service Worker AgriSecur
//
// Rôle volontairement limité à ce stade : rendre l'app installable
// ("Ajouter à l'écran d'accueil") et mettre en cache les fichiers
// statiques (interface, icônes) pour un chargement plus rapide au
// second lancement. N'intercepte jamais les appels /api/ — les données
// (catalogue, commandes, comptes) doivent toujours venir du serveur en
// direct, jamais d'un cache local, pour ne jamais afficher une
// information financière périmée.

const CACHE_NAME = "agrisecur-static-v1";
const FICHIERS_A_METTRE_EN_CACHE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FICHIERS_A_METTRE_EN_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((noms) =>
      Promise.all(noms.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Jamais de cache sur l'API — toujours des données fraîches.
  if (url.pathname.startsWith("/api/")) return;

  // Pour le reste (interface, icônes) : réseau en priorité, cache en secours
  // si hors-ligne — pour ne jamais servir une vieille version de l'app tant
  // que la connexion fonctionne.
  event.respondWith(
    fetch(event.request)
      .then((reponse) => {
        const copie = reponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copie));
        return reponse;
      })
      .catch(() => caches.match(event.request))
  );
});
