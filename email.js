// email.js — envoi du bon de commande (PDF) à chaque achat.
// Passe par mailer.js : API Brevo si BREVO_API_KEY est défini (cas de
// Railway, qui bloque le SMTP), sinon SMTP OVH. nodemailer a été retiré
// (vulnérabilités connues, plus nécessaire).
//
// Sans configuration email : l'envoi est ignoré sans erreur, pour ne
// jamais bloquer une commande à cause d'un email qui ne part pas.

const { envoyerEmail, MAILER_ACTIF } = require("./mailer");

async function envoyerBonCommandeParEmail(commande, destinataireEmail, pdfBuffer) {
  if (!MAILER_ACTIF) {
    console.log(`[email] Envoi désactivé (email non configuré) — bon de commande #${commande.id} non envoyé.`);
    return { envoye: false, raison: "email non configuré" };
  }
  try {
    await envoyerEmail({
      to: destinataireEmail,
      subject: `AgriSecur — Confirmation de votre commande n°${commande.id}`,
      text: `Bonjour,\n\nVotre commande n°${commande.id} a bien été enregistrée sur AgriSecur.\nVous trouverez le bon de commande complet en pièce jointe.\n\nLe paiement suit les conditions indiquées sur le bon de commande. Pour toute question, répondez simplement à cet e-mail.\n\nL'équipe AgriSecur`,
      attachments: [{ filename: `agrisecur-bon-commande-${commande.id}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
    });
    return { envoye: true };
  } catch (err) {
    console.error(`[email] Échec de l'envoi pour la commande #${commande.id} :`, err.message);
    return { envoye: false, raison: err.message };
  }
}

module.exports = { envoyerBonCommandeParEmail, SMTP_CONFIGURE: MAILER_ACTIF };
