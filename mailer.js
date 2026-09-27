// mailer.js — client SMTP minimal (modules natifs net + tls, aucune
// dépendance npm), pour l'envoi de notifications internes simples en texte
// brut via le compte Zimbra OVH d'AgriSecur. Suffisant pour des alertes
// internes ponctuelles — pas conçu pour du volume important ou des emails
// HTML élaborés (auquel cas une vraie librairie comme nodemailer serait
// préférable).
//
// Paramètres SMTP OVH (offre Zimbra Starter, identiques à l'offre MX Plan) :
// serveur ssl0.ovh.net, port 587 en STARTTLS, identifiant = adresse email
// complète, mot de passe = celui de la boîte mail.

const net = require("net");
const tls = require("tls");

const SMTP_HOST = process.env.SMTP_HOST || "ssl0.ovh.net";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || null;
const SMTP_PASS = process.env.SMTP_PASS || null;
const MAILER_ACTIF = !!(SMTP_USER && SMTP_PASS);
const TIMEOUT_MS = 15000;

if (!MAILER_ACTIF) {
  console.log("[mailer] SMTP_USER / SMTP_PASS non définis — notifications email désactivées.");
}

// Attend une réponse SMTP complète (gère les réponses multi-lignes : les
// lignes intermédiaires ont un tiret après le code, ex. "250-", la dernière
// a un espace, ex. "250 ").
function lireReponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lignes = buffer.split("\r\n").filter(Boolean);
      const derniere = lignes[lignes.length - 1] || "";
      if (/^\d{3} /.test(derniere)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onError = (err) => { cleanup(); reject(err); };
    function cleanup() {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function envoyerCommande(socket, commande) {
  socket.write(commande + "\r\n");
  return lireReponse(socket);
}

// Échappement du "point seul en début de ligne" imposé par le protocole SMTP
// (sinon une ligne commençant par "." serait interprétée comme la fin du
// message). Convertit aussi les retours à la ligne en CRLF, requis par SMTP.
function dotStuff(texte) {
  return texte
    .split(/\r\n|\r|\n/)
    .map((ligne) => (ligne.startsWith(".") ? "." + ligne : ligne))
    .join("\r\n");
}

// Retire tout retour à la ligne d'un champ d'en-tête (sujet, destinataire)
// pour empêcher une injection d'en-têtes SMTP si la valeur provient d'une
// saisie utilisateur (ex. nom de vendeur contenant un retour à la ligne).
function assainirEntete(valeur) {
  return String(valeur).replace(/[\r\n]+/g, " ").trim();
}

// Sujet encodé en UTF-8 (RFC 2047) dès qu'il contient un accent.
function encoderSujet(sujet) {
  return /^[\x20-\x7e]*$/.test(sujet) ? sujet : `=?UTF-8?B?${Buffer.from(sujet, "utf8").toString("base64")}?=`;
}

// Base64 découpé en lignes de 76 caractères (limite MIME).
function base64Lignes(contenu) {
  return Buffer.from(contenu).toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

// Corps du message : texte brut seul, ou multipart/mixed avec pièces jointes
// ({ filename, content: Buffer|string, contentType }).
function construireCorps(text, attachments) {
  if (!attachments || !attachments.length) {
    return { entetes: ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"], corps: base64Lignes(text) };
  }
  const frontiere = "agrisecur-" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const parties = [
    `--${frontiere}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64Lignes(text),
  ];
  for (const pj of attachments) {
    const nom = String(pj.filename || "piece-jointe").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100);
    parties.push(`--${frontiere}`, `Content-Type: ${pj.contentType || "application/octet-stream"}; name="${nom}"`,
      "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${nom}"`, "", base64Lignes(pj.content));
  }
  parties.push(`--${frontiere}--`);
  return { entetes: [`Content-Type: multipart/mixed; boundary="${frontiere}"`], corps: parties.join("\r\n") };
}

async function envoyerEmail({ to, subject, text, attachments }) {
  if (!MAILER_ACTIF) {
    console.log("[mailer] envoi ignoré (SMTP non configuré) :", subject);
    return false;
  }

  const destinataire = assainirEntete(to);
  const sujet = assainirEntete(subject);

  return new Promise((resolve, reject) => {
    const socket = net.connect(SMTP_PORT, SMTP_HOST);
    let termine = false;

    const minuteur = setTimeout(() => {
      if (termine) return;
      termine = true;
      socket.destroy();
      reject(new Error("délai SMTP dépassé"));
    }, TIMEOUT_MS);

    function finir(fn, valeur) {
      if (termine) return;
      termine = true;
      clearTimeout(minuteur);
      fn(valeur);
    }

    socket.once("error", (err) => finir(reject, err));

    socket.once("connect", async () => {
      try {
        await lireReponse(socket); // bannière de bienvenue
        await envoyerCommande(socket, `EHLO agrisecur.com`);
        await envoyerCommande(socket, "STARTTLS");

        const secureSocket = tls.connect({ socket, servername: SMTP_HOST }, async () => {
          try {
            await envoyerCommande(secureSocket, `EHLO agrisecur.com`);
            await envoyerCommande(secureSocket, "AUTH LOGIN");
            await envoyerCommande(secureSocket, Buffer.from(SMTP_USER).toString("base64"));
            await envoyerCommande(secureSocket, Buffer.from(SMTP_PASS).toString("base64"));
            await envoyerCommande(secureSocket, `MAIL FROM:<${SMTP_USER}>`);
            await envoyerCommande(secureSocket, `RCPT TO:<${destinataire}>`);
            await envoyerCommande(secureSocket, "DATA");

            const { entetes, corps } = construireCorps(String(text || ""), attachments);
            const message = [
              `From: AgriSecur <${SMTP_USER}>`,
              `To: ${destinataire}`,
              `Subject: ${encoderSujet(sujet)}`,
              `Date: ${new Date().toUTCString()}`,
              "MIME-Version: 1.0",
              ...entetes,
              "",
              dotStuff(corps),
              ".",
            ].join("\r\n");

            await envoyerCommande(secureSocket, message);
            await envoyerCommande(secureSocket, "QUIT");
            secureSocket.end();
            finir(resolve, true);
          } catch (err) {
            secureSocket.destroy();
            finir(reject, err);
          }
        });
        secureSocket.once("error", (err) => finir(reject, err));
      } catch (err) {
        socket.destroy();
        finir(reject, err);
      }
    });
  });
}

module.exports = { envoyerEmail, MAILER_ACTIF };
