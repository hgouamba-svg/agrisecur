/* ==========================================================================
   AgriSecur — micro-interactions (vanilla JS, aucune dépendance)
   Charger après agrisecur-micro.css :
     <link rel="stylesheet" href="/agrisecur-micro.css">
     <script src="/agrisecur-micro.js" defer></script>

   Tout est exposé sur window.ASMotion. Chaque fonction reçoit vos éléments
   existants et, quand il y a un appel serveur, la Promise de votre fetch :
   l'animation suit le vrai résultat, elle ne simule rien.

   ----------------------------------------------------------------------------
   1. CONFIRMATION DE COMMANDE
   HTML :
     <button class="as-confirm" id="btnCommande">
       <span class="as-label">Confirmer la commande</span>
       <span class="as-spin"></span>
       <svg class="as-check" viewBox="0 0 24 24"><path pathLength="1" d="M5 12.5l4.5 4.5L19 7.5"/></svg>
     </button>
   JS :
     btnCommande.addEventListener('click', () => {
       ASMotion.confirm(btnCommande,
         fetch('/api/commandes', { method:'POST', body: JSON.stringify(panier),
                                   headers:{'Content-Type':'application/json'} })
           .then(r => { if(!r.ok) throw new Error('refus'); return r.json(); }),
         { success: 'Commande confirmée · reçu PDF envoyé par e-mail',
           error:   'La commande n’a pas pu être enregistrée. Réessayez.' });
     });

   2. ENVOI KYC
   HTML :
     <div class="as-progress" id="kycBar"><i></i></div>
     <span class="as-stamp" id="kycStamp">Vérifié</span>
   JS :
     ASMotion.kyc(kycBar, kycStamp, fetch('/api/kyc', { method:'POST', body: formData }));

   3. BADGE WHISP
   HTML :  <span class="as-whisp" id="badge" hidden></span>
   JS :    ASMotion.whisp(badge, 'faible');   // 'faible' | 'moyen' | 'eleve'

   4. ERREUR DE PAIEMENT
   HTML :
     <input id="momo">
     <p class="as-error-msg" id="momoErr" role="alert"></p>
   JS :
     ASMotion.fieldError(momo, momoErr,
       'Paiement refusé par l’opérateur. Vérifiez votre solde Mobile Money, puis réessayez.');
     // l'erreur disparaît seule dès que l'utilisateur corrige le champ

   TOAST seul :  ASMotion.toast('Annonce publiée');
   ========================================================================== */
(function () {
  'use strict';

  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, reduce ? 0 : ms); }); };
  var restart = function (el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

  /* ---------- toast ---------- */
  var toastEl, toastTimer;
  function toast(message, ms) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'as-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    clearTimeout(toastTimer);
    requestAnimationFrame(function () { toastEl.classList.add('is-shown'); });
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-shown'); }, ms || 3200);
  }

  /* ---------- 1. confirmation ---------- */
  function confirm(btn, promise, msgs) {
    msgs = msgs || {};
    if (btn.classList.contains('is-loading')) return promise;
    // fige la largeur de départ pour que la transition vers le cercle soit fluide
    btn.style.width = btn.offsetWidth + 'px';
    void btn.offsetWidth;
    btn.classList.add('is-loading');
    btn.setAttribute('aria-busy', 'true');
    var started = Date.now();

    return Promise.resolve(promise).then(function (result) {
      // durée minimale de 500 ms pour que le chargement soit lisible
      return wait(Math.max(0, 500 - (Date.now() - started))).then(function () {
        btn.classList.remove('is-loading');
        btn.classList.add('is-done');
        btn.removeAttribute('aria-busy');
        if (msgs.success) toast(msgs.success);
        return result;
      });
    }, function (err) {
      btn.classList.remove('is-loading');
      btn.removeAttribute('aria-busy');
      btn.style.width = '';
      restart(btn, 'as-shake');
      if (msgs.error) toast(msgs.error);
      throw err;
    });
  }
  function resetConfirm(btn) {
    btn.classList.remove('is-loading', 'is-done', 'as-shake');
    btn.style.width = '';
  }

  /* ---------- 2. KYC ---------- */
  function kyc(bar, stamp, promise) {
    stamp.classList.remove('is-on');
    bar.classList.remove('is-running');
    void bar.offsetWidth;
    bar.classList.add('is-running');
    var barDone = wait(900);

    return Promise.all([Promise.resolve(promise), barDone]).then(function (res) {
      stamp.classList.add('is-on');
      return res[0];
    }, function (err) {
      bar.classList.remove('is-running');
      toast('Le document n’a pas pu être envoyé. Vérifiez votre connexion et réessayez.');
      throw err;
    });
  }

  /* ---------- 3. badge WHISP ---------- */
  var WHISP_TXT = { faible: 'Risque faible · WHISP', moyen: 'Risque moyen · WHISP', eleve: 'Risque élevé · WHISP' };
  function whisp(badge, level) {
    level = WHISP_TXT[level] ? level : 'faible';
    badge.dataset.level = level;
    badge.textContent = WHISP_TXT[level];
    badge.hidden = false;
    restart(badge, 'is-entering');
  }

  /* ---------- 4. erreur de champ ---------- */
  function fieldError(input, msgEl, text) {
    msgEl.textContent = text;
    input.classList.add('as-field-error');
    input.setAttribute('aria-invalid', 'true');
    if (msgEl.id) input.setAttribute('aria-describedby', msgEl.id);
    restart(input, 'as-shake');
    msgEl.classList.add('is-shown');

    var clear = function () {
      input.classList.remove('as-field-error', 'as-shake');
      input.removeAttribute('aria-invalid');
      msgEl.classList.remove('is-shown');
      input.removeEventListener('input', clear);
    };
    input.addEventListener('input', clear);
  }

  // la secousse doit pouvoir rejouer : on retire la classe à la fin
  document.addEventListener('animationend', function (e) {
    if (e.animationName === 'as-shake') e.target.classList.remove('as-shake');
  });

  window.ASMotion = { confirm: confirm, resetConfirm: resetConfirm, kyc: kyc, whisp: whisp, fieldError: fieldError, toast: toast };
})();
