/* ==========================================================================
   AgriSecur — branchement des micro-interactions sur l'app existante
   ----------------------------------------------------------------------------
   Ce fichier ne modifie AUCUNE fonction existante de index.html.
   Il se place « autour » de deux fonctions déjà présentes :
     - api(path, opts)   → pour animer les boutons pendant les appels serveur
     - msg(el, text, ok) → pour faire trembler les messages d'erreur

   Routes animées (relevées dans server.js / index.html) :
     POST /api/orders                              bouton « Commander »          commander()
     POST /api/sellers/me/kyc-documents            bouton « Envoyer mon dossier » soumettreDocumentsKyc()
     POST /api/orders/:id/expedier                 bouton « Expédier le lot »     expedierLot()
     POST /api/orders/:id/confirmer-reception      bouton « Confirmer la réception »   action()
     POST /api/orders/:id/cloturer                 bouton « Valider la conformité… »   action()

   Installation — tout en bas de public/index.html, juste avant </body>,
   APRÈS le grand <script> existant :
     <link rel="stylesheet" href="/agrisecur-micro.css">
     <script src="/agrisecur-micro.js"></script>
     <script src="/agrisecur-branchement.js"></script>
   ========================================================================== */
(function () {
  'use strict';
  if (!window.ASMotion || typeof window.api !== 'function' || typeof window.msg !== 'function') {
    console.warn('[AgriSecur motion] api(), msg() ou agrisecur-micro.js introuvable — branchement ignoré.');
    return;
  }

  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, reduce ? 0 : ms); }); };

  /* Adapte .as-confirm aux boutons existants : on garde leur taille,
     leurs couleurs et leurs arrondis, seule la transformation est ajoutée. */
  var style = document.createElement('style');
  style.textContent =
    '.as-confirm.as-adapt{height:var(--as-h);padding:var(--as-p);border-radius:var(--as-r);background:var(--as-bg);color:var(--as-fg);font-size:inherit}' +
    '.as-confirm.as-adapt.is-loading,.as-confirm.as-adapt.is-done{width:var(--as-h)!important;padding:0;border-radius:999px}' +
    '.as-confirm.as-adapt.is-done{background:var(--as-green);color:#fff}' +
    '.as-confirm.as-adapt .as-check{stroke:currentColor}' +
    '.as-confirm.as-adapt .as-spin{border-color:color-mix(in srgb,currentColor 35%,transparent);border-top-color:currentColor}';
  document.head.appendChild(style);

  function prepare(btn) {
    if (btn.classList.contains('as-confirm')) return btn;
    var cs = getComputedStyle(btn);
    btn.style.setProperty('--as-h', btn.offsetHeight + 'px');
    btn.style.setProperty('--as-p', cs.padding);
    btn.style.setProperty('--as-r', cs.borderRadius);
    btn.style.setProperty('--as-bg', cs.backgroundColor);
    btn.style.setProperty('--as-fg', cs.color);
    var label = document.createElement('span');
    label.className = 'as-label';
    while (btn.firstChild) label.appendChild(btn.firstChild);
    btn.appendChild(label);
    btn.insertAdjacentHTML('beforeend',
      '<span class="as-spin"></span><svg class="as-check" viewBox="0 0 24 24" aria-hidden="true"><path pathLength="1" d="M5 12.5l4.5 4.5L19 7.5"/></svg>');
    btn.classList.add('as-confirm', 'as-adapt');
    return btn;
  }

  /* Dernier bouton touché : c'est lui qu'on anime pendant l'appel serveur.
     (commander() ouvre d'abord ses fenêtres de choix du paiement, le bouton
     reste bien celui qui a été cliqué.) */
  var lastBtn = null;
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button');
    if (b) lastBtn = b;
  }, true);

  var ROUTES = [
    { re: /^\/api\/orders$/,                                   btn: /^commander\(/ },
    { re: /^\/api\/sellers\/me\/kyc-documents$/,               btn: /^soumettreDocumentsKyc\(/ },
    { re: /^\/api\/orders\/\d+\/expedier$/,                    btn: /^expedierLot\(/ },
    { re: /^\/api\/orders\/\d+\/confirmer-reception$/,         btn: /confirmer-reception/ },
    { re: /^\/api\/orders\/\d+\/cloturer$/,                    btn: /cloturer/ }
  ];

  var originalApi = window.api;
  window.api = function (path, opts) {
    var call = originalApi.apply(this, arguments);
    var method = ((opts && opts.method) || 'GET').toUpperCase();
    if (method !== 'POST') return call;

    var route = null;
    for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].re.test(path)) { route = ROUTES[i]; break; }
    var btn = lastBtn;
    var onclick = btn && btn.getAttribute('onclick') || '';
    if (!route || !btn || !document.body.contains(btn) || !route.btn.test(onclick)) return call;

    // L'appelant reçoit exactement les mêmes données / erreurs qu'avant.
    // Seule différence en cas de succès : ~450 ms de plus pour laisser la
    // coche se dessiner avant que la liste soit rechargée.
    return window.ASMotion.confirm(prepare(btn), call, route.toast ? { success: route.toast } : null)
      .then(function (data) { return wait(450).then(function () { return data; }); });
  };

  /* Les messages d'erreur existants (div.msg.err) tremblent une fois. */
  var originalMsg = window.msg;
  window.msg = function (el, text, ok) {
    originalMsg.apply(this, arguments);
    if (!ok && el && el.firstElementChild) el.firstElementChild.classList.add('as-shake');
  };
})();
