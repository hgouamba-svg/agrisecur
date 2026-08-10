// email.js — envoi d'emails transactionnels (bon de commande à chaque
// achat) via le SMTP OVH Zimbra. Utilise nodemailer — seule dépendance
// externe du projet, par exception à la philosophie "zéro dépendance"
// suivie ailleurs : gérer le protocole SMTP et les pièces jointes MIME à
// la main serait risqué sans pouvoir tester un envoi réel en conditions
// de développement.
//
// Variables d'environnement nécessaires (à régler sur Railway) :
//   SMTP_HOST      — smtp.mail.ovh.net (valeur par défaut, confirmée OVH)
//   SMTP_PORT      — 465 par défaut (SSL). Si ça échoue, essayer 587 (STARTTLS).
//   SMTP_USER      — contact@agrisecur.com
//   SMTP_PASSWORD  — le vrai mot de passe de cette boîte Zimbra
//
// Sans ces variables : l'envoi est silencieusement désactivé (aucune
// erreur, l'app continue de fonctionner normalement) — pour ne jamais
// bloquer une commande à cause d'un email qui ne part pas.

let nodemailer;
try {
  nodemailer = require("nodemailer");
} catch (e) {
  console.warn("[email] nodemailer non installé — l'envoi d'email est désactivé.");
}

const SMTP_CONFIGURE = !!(process.env.SMTP_USER && process.env.SMTP_PASSWORD);

let transporteur = null;
if (nodemailer && SMTP_CONFIGURE) {
  transporteur = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.mail.ovh.net",
    port: Number(process.env.SMTP_PORT) || 465,
    secure: (Number(process.env.SMTP_PORT) || 465) === 465, // true pour le port 465 (SSL direct), false pour 587 (STARTTLS)
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
}

async function envoyerBonCommandeParEmail(commande, destinataireEmail, pdfBuffer) {
  if (!transporteur) {
    console.log(`[email] Envoi désactivé (SMTP non configuré) — bon de commande #${commande.id} non envoyé à ${destinataireEmail}.`);
    return { envoye: false, raison: "SMTP non configuré" };
  }
  try {
    await transporteur.sendMail({
      from: `"AgriSecur" <${process.env.SMTP_USER}>`,
      to: destinataireEmail,
      subject: `AgriSecur — Confirmation de votre commande n°${commande.id}`,
      text: `Bonjour,\n\nVotre commande n°${commande.id} a bien été enregistrée sur AgriSecur.\nVous trouverez le bon de commande complet en pièce jointe.\n\nVos fonds restent protégés en compte séquestre jusqu'à validation de la conformité du lot.\n\nL'équipe AgriSecur`,
      attachments: [
        {
          filename: `agrisecur-bon-commande-${commande.id}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });
    return { envoye: true };
  } catch (err) {
    console.error(`[email] Échec de l'envoi pour la commande #${commande.id} :`, err.message);
    return { envoye: false, raison: err.message };
  }
}

module.exports = { envoyerBonCommandeParEmail, SMTP_CONFIGURE };
