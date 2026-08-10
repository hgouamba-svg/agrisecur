// pdf.js — générateur PDF minimal, sans dépendance externe (cohérent avec
// le reste du projet : http + node:sqlite natifs, zéro npm install).
// Écrit directement la syntaxe PDF (texte + flux de contenu non compressé)
// plutôt que de passer par une bibliothèque — suffisant pour un document
// simple d'une page comme un bon de commande.

function echapperPdf(texte) {
  return String(texte).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// Construit un PDF à partir d'une liste de lignes de texte positionnées.
// Chaque ligne : { texte, x, y, taille, gras }
function construirePdf(lignes, largeur = 595, hauteur = 842) {
  const objets = [];
  const ajouter = (contenu) => { objets.push(contenu); return objets.length; };

  const idCatalog = 1;
  const idPages = 2;
  const idPage = 3;
  const idFontNormal = 4;
  const idFontBold = 5;
  const idContenu = 6;

  let flux = "";
  for (const ligne of lignes) {
    if (ligne.texte === undefined) continue; // ligne purement décorative (trait), pas de texte à dessiner
    const police = ligne.gras ? "/F2" : "/F1";
    flux += `BT ${police} ${ligne.taille || 11} Tf ${ligne.x} ${hauteur - ligne.y} Td (${echapperPdf(ligne.texte)}) Tj ET\n`;
  }
  // Lignes de séparation horizontales (tableaux simples)
  for (const ligne of lignes) {
    if (ligne.trait) {
      flux += `${ligne.x} ${hauteur - ligne.y} m ${ligne.traitFin} ${hauteur - ligne.y} l S\n`;
    }
  }

  objets[0] = `<< /Type /Catalog /Pages ${idPages} 0 R >>`;
  objets[1] = `<< /Type /Pages /Kids [${idPage} 0 R] /Count 1 >>`;
  objets[2] = `<< /Type /Page /Parent ${idPages} 0 R /MediaBox [0 0 ${largeur} ${hauteur}] /Resources << /Font << /F1 ${idFontNormal} 0 R /F2 ${idFontBold} 0 R >> >> /Contents ${idContenu} 0 R >>`;
  objets[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objets[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`;
  objets[5] = `<< /Length ${Buffer.byteLength(flux, "utf-8")} >>\nstream\n${flux}endstream`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objets.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "utf-8"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const offsetXref = Buffer.byteLength(pdf, "utf-8");
  pdf += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objets.length + 1} /Root ${idCatalog} 0 R >>\nstartxref\n${offsetXref}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}

// Formate un montant FCFA avec séparateur de milliers (espace), sans
// dépendance à Intl côté rendu PDF (les caractères spéciaux de certaines
// locales ne s'affichent pas correctement dans une police PDF standard).
function fmtFcfa(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function genererBonCommandePDF(commande) {
  const y0 = 60;
  const lignes = [
    { texte: "AgriSecur", x: 50, y: y0, taille: 22, gras: true },
    { texte: "Marketplace agricole securisee - Cote d'Ivoire", x: 50, y: y0 + 18, taille: 10 },
    { texte: "www.agrisecur.com", x: 50, y: y0 + 32, taille: 10 },

    { texte: `Bon de commande n. ${commande.id}`, x: 50, y: y0 + 70, taille: 16, gras: true },
    { texte: `Date : ${new Date(commande.created_at).toLocaleDateString("fr-FR")}`, x: 50, y: y0 + 90, taille: 11 },
    { texte: `Statut : ${commande.statut}`, x: 50, y: y0 + 106, taille: 11 },

    { texte: "Vendeur", x: 50, y: y0 + 140, taille: 12, gras: true },
    { texte: commande.vendeur_nom || "-", x: 50, y: y0 + 156, taille: 11 },

    { texte: "Acheteur", x: 320, y: y0 + 140, taille: 12, gras: true },
    { texte: commande.acheteur_nom || "-", x: 320, y: y0 + 156, taille: 11 },

    { texte: "Detail de la commande", x: 50, y: y0 + 200, taille: 12, gras: true },
    { texte: "Produit", x: 50, y: y0 + 222, taille: 10, gras: true },
    { texte: "Quantite", x: 260, y: y0 + 222, taille: 10, gras: true },
    { texte: "Prix unitaire", x: 360, y: y0 + 222, taille: 10, gras: true },
    { texte: "Montant", x: 470, y: y0 + 222, taille: 10, gras: true },
    { x: 50, y: y0 + 230, trait: true, traitFin: 545 },

    { texte: commande.produit_nom || "-", x: 50, y: y0 + 248, taille: 10 },
    { texte: `${commande.quantite_kg} kg`, x: 260, y: y0 + 248, taille: 10 },
    { texte: `${fmtFcfa(commande.montant_total_fcfa / commande.quantite_kg)} FCFA/kg`, x: 360, y: y0 + 248, taille: 10 },
    { texte: `${fmtFcfa(commande.montant_total_fcfa)} FCFA`, x: 470, y: y0 + 248, taille: 10 },
    { x: 50, y: y0 + 260, trait: true, traitFin: 545 },

    { texte: "Montant marchandise", x: 320, y: y0 + 290, taille: 10 },
    { texte: `${fmtFcfa(commande.montant_total_fcfa)} FCFA`, x: 490, y: y0 + 290, taille: 10 },
    { texte: `Frais de traitement (${commande.mode_paiement === "virement" ? "virement" : "mobile money"})`, x: 320, y: y0 + 308, taille: 9 },
    { texte: `${fmtFcfa(commande.frais_paiement_fcfa)} FCFA`, x: 490, y: y0 + 308, taille: 10 },
    { texte: "Total paye par l'acheteur", x: 320, y: y0 + 330, taille: 11, gras: true },
    { texte: `${fmtFcfa(commande.montant_total_fcfa + commande.frais_paiement_fcfa)} FCFA`, x: 490, y: y0 + 330, taille: 11, gras: true },

    { texte: "Protection AgriSecur", x: 50, y: y0 + 380, taille: 12, gras: true },
    { texte: "Vos fonds restent bloques en compte sequestre jusqu'a votre validation", x: 50, y: y0 + 398, taille: 10 },
    { texte: "de la conformite du lot, ou pendant le delai de contestation en vigueur.", x: 50, y: y0 + 412, taille: 10 },
    { texte: "En cas de desaccord, notre mediation interne tranche avant toute", x: 50, y: y0 + 426, taille: 10 },
    { texte: "liberation des fonds.", x: 50, y: y0 + 440, taille: 10 },

    { texte: "Document genere automatiquement - AgriSecur Cote d'Ivoire", x: 50, y: 800, taille: 8 },
  ];
  return construirePdf(lignes);
}

module.exports = { genererBonCommandePDF };
