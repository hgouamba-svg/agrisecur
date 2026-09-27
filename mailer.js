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
// Accepte SMTP_PASS ou SMTP_PASSWORD (nom déjà utilisé par email.js sur Railway)
const SMTP_PASS = process.env.SMTP_PASS || process.env.SMTP_PASSWORD || null;
// Brevo (API HTTPS) : Railway bloque le SMTP sur les offres Free/Trial/Hobby.
// Si BREVO_API_KEY est défini, on envoie par Brevo ; sinon par SMTP.
const BREVO_API_KEY = process.env.BREVO_API_KEY || null;
const EXPEDITEUR = process.env.EMAIL_FROM || SMTP_USER || "contact@agrisecur.com";
const MAILER_ACTIF = !!(BREVO_API_KEY || (SMTP_USER && SMTP_PASS));
const TIMEOUT_MS = 15000;

if (!MAILER_ACTIF) {
  console.log("[mailer] ni BREVO_API_KEY ni SMTP_USER / SMTP_PASSWORD définis — notifications email désactivées.");
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

async function envoyerParBrevo({ to, subject, text, attachments }) {
  const corps = {
    sender: { name: "AgriSecur", email: EXPEDITEUR },
    to: [{ email: assainirEntete(to) }],
    subject: assainirEntete(subject),
    textContent: String(text || ""),
  };
  if (attachments && attachments.length) {
    corps.attachment = attachments.map((pj) => ({
      name: String(pj.filename || "piece-jointe").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100),
      content: Buffer.from(pj.content).toString("base64"),
    }));
  }
  const r = await fetch(process.env.BREVO_API_URL || "https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(corps),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    throw new Error(`Brevo ${r.status} ${detail}`);
  }
  return true;
}

async function envoyerEmail({ to, subject, text, attachments }) {
  if (!MAILER_ACTIF) {
    console.log("[mailer] envoi ignoré (email non configuré) :", subject);
    return false;
  }
  if (BREVO_API_KEY) return envoyerParBrevo({ to, subject, text, attachments });

  const destinataire = assainirEntete(to);
  const sujet = assainirEntete(subject);

  return new Promise((resolve, reject) => {
    // Port 465 = TLS direct (SSL) ; autre port (587) = STARTTLS.
    const tlsDirect = SMTP_PORT === 465;
    const socket = tlsDirect
      ? tls.connect({ port: SMTP_PORT, host: SMTP_HOST, servername: SMTP_HOST })
      : net.connect(SMTP_PORT, SMTP_HOST);
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

    async function session(sock) {
      try {
        await envoyerCommande(sock, `EHLO agrisecur.com`);
        await envoyerCommande(sock, "AUTH LOGIN");
        await envoyerCommande(sock, Buffer.from(SMTP_USER).toString("base64"));
        await envoyerCommande(sock, Buffer.from(SMTP_PASS).toString("base64"));
        await envoyerCommande(sock, `MAIL FROM:<${SMTP_USER}>`);
        await envoyerCommande(sock, `RCPT TO:<${destinataire}>`);
        await envoyerCommande(sock, "DATA");

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

        await envoyerCommande(sock, message);
        await envoyerCommande(sock, "QUIT");
        sock.end();
        finir(resolve, true);
      } catch (err) {
        sock.destroy();
        finir(reject, err);
      }
    }

    socket.once("error", (err) => finir(reject, err));

    socket.once(tlsDirect ? "secureConnect" : "connect", async () => {
      try {
        await lireReponse(socket); // bannière de bienvenue
        if (tlsDirect) return session(socket);
        await envoyerCommande(socket, `EHLO agrisecur.com`);
        await envoyerCommande(socket, "STARTTLS");
        const secureSocket = tls.connect({ socket, servername: SMTP_HOST }, () => session(secureSocket));
        secureSocket.once("error", (err) => finir(reject, err));
      } catch (err) {
        socket.destroy();
        finir(reject, err);
      }
    });
  });
}

module.exports = { envoyerEmail, MAILER_ACTIF };
