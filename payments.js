// payments.js — Point d'entrée unique pour tout ce qui touche au paiement
// réel. Aujourd'hui : entièrement simulé (aucun changement de comportement
// par rapport à avant ce fichier). Demain, une fois les identifiants
// CinetPay (ou autre agrégateur) obtenus : c'est ICI, et seulement ici,
// que les vrais appels API remplaceront la simulation — pas besoin de
// toucher au reste du code (server.js reste inchangé).

const PAIEMENT_MODE = process.env.PAIEMENT_MODE || "simulation"; // "simulation" | "reel"

// ---------------------------------------------------------------------
// ENCAISSEMENT — quand l'acheteur paie (mobile money)
// ---------------------------------------------------------------------
// Aujourd'hui : renvoie immédiatement un succès simulé, exactement comme
// le comportement actuel (les fonds sont "considérés" bloqués dès la
// création de la commande).
// Demain (mode "reel") : appeler l'API CinetPay pour initier réellement
// la collecte (ex. POST /v2/payment de leur API), récupérer une vraie
// référence de transaction, et gérer le webhook de confirmation avant de
// considérer les fonds comme bloqués.
async function encaisserPaiement(commande) {
  if (PAIEMENT_MODE === "reel") {
    // TODO une fois les identifiants CinetPay obtenus :
    // const reponse = await fetch("https://api-checkout.cinetpay.com/v2/payment", {
    //   method: "POST",
    //   headers: { "Content-Type": "application/json" },
    //   body: JSON.stringify({
    //     apikey: process.env.CINETPAY_API_KEY,
    //     site_id: process.env.CINETPAY_SITE_ID,
    //     transaction_id: `AGS-${commande.id}-${Date.now()}`,
    //     amount: commande.montant_total_fcfa,
    //     currency: "XOF",
    //     description: `AgriSecur — commande #${commande.id}`,
    //   }),
    // });
    // const data = await reponse.json();
    // return { succes: data.code === "201", reference: data.data?.payment_token, mode: "reel", brut: data };
    throw new Error("PAIEMENT_MODE=reel réglé mais l'intégration CinetPay n'est pas encore implémentée");
  }
  return {
    succes: true,
    reference: `SIM-${commande.id}-${Date.now()}`,
    mode: "simulation",
  };
}

// ---------------------------------------------------------------------
// REVERSEMENT — quand les fonds sont libérés au vendeur
// ---------------------------------------------------------------------
// Aujourd'hui : renvoie un succès simulé, exactement le comportement
// actuel (le statut passe à "cloture" sans mouvement d'argent réel).
// Demain : appeler l'API de reversement de l'agrégateur (le mécanisme
// "marque blanche" évoqué avec CinetPay — reverser au vendeur pour le
// compte duquel la plateforme agit).
async function declencherReversement(commande) {
  if (PAIEMENT_MODE === "reel") {
    // TODO une fois les identifiants CinetPay obtenus, et la marque
    // blanche confirmée avec eux :
    // const reponse = await fetch("https://api-checkout.cinetpay.com/v2/transfer/money/send", { ... });
    throw new Error("PAIEMENT_MODE=reel réglé mais le reversement CinetPay n'est pas encore implémenté");
  }
  return {
    succes: true,
    reference: `SIM-REV-${commande.id}-${Date.now()}`,
    mode: "simulation",
  };
}

module.exports = { encaisserPaiement, declencherReversement, PAIEMENT_MODE };
