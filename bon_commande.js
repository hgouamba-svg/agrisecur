// bon_commande.js — génère un PDF de bon de commande à la main, sans
// dépendance externe. Un PDF texte simple (une page, police standard
// Helvetica déjà intégrée à tout lecteur PDF, pas besoin de l'embarquer)
// est un format assez simple pour être construit directement : c'est du
// texte positionné sur une page, rien de plus.

// Le format PDF n'accepte pas l'UTF-8 brut dans les chaînes de texte — il
// faut soit rester en ASCII, soit encoder les caractères accentués avec un
// échappement octal correspondant à leur position dans WinAnsiEncoding
// (qui correspond exactement à Latin-1 pour les caractères français
// courants : é, è, à, °, etc., tous entre 0x80 et 0xFF).
function echapperPdf(texte) {
  let resultat = "";
  for (const car of String(texte)) {
    const code = car.codePointAt(0);
    if (car === "\\" || car === "(" || car === ")") {
      resultat += "\\" + car;
    } else if (code > 126) {
      resultat += "\\" + code.toString(8).padStart(3, "0");
    } else {
      resultat += car;
    }
  }
  return resultat;
}

// Construit les lignes de contenu du document (texte positionné).
function construireContenu(lignes) {
  let y = 780;
  const parties = ["BT", "/F1 11 Tf"];
  for (const ligne of lignes) {
    const taille = ligne.taille || 11;
    parties.push(`/F1 ${taille} Tf`);
    parties.push(`${ligne.gras ? 1 : 0} Tr`); // pas de vrai gras sans 2e police, ignoré proprement
    parties.push(`50 ${y} Td`);
    parties.push(`(${echapperPdf(ligne.texte)}) Tj`);
    parties.push(`-50 -${y} Td`); // remet le curseur à l'origine avant la ligne suivante
    y -= ligne.espaceApres || 20;
  }
  parties.push("ET");
  return parties.join("\n");
}

function genererPdfBonCommande(commande) {
  const lignes = [
    { texte: "AgriSecur — Bon de commande", taille: 16, espaceApres: 30 },
    { texte: `Commande n° ${commande.id}`, taille: 12, espaceApres: 26 },
    { texte: `Date : ${new Date(commande.created_at).toLocaleString("fr-FR")}`, espaceApres: 20 },
    { texte: `Produit : ${commande.produit_nom}`, espaceApres: 18 },
    { texte: `Filière : ${commande.filiere}`, espaceApres: 18 },
    { texte: `Quantité : ${commande.quantite_kg} kg`, espaceApres: 18 },
    { texte: `Vendeur : ${commande.vendeur_nom}`, espaceApres: 18 },
    { texte: `Acheteur : ${commande.acheteur_nom}`, espaceApres: 26 },
    { texte: `Montant total : ${Math.round(commande.montant_total_fcfa).toLocaleString("fr-FR")} FCFA`, taille: 12, espaceApres: 18 },
    { texte: `Mode de paiement : ${commande.mode_paiement === "virement" ? "Virement bancaire" : "Mobile money"}`, espaceApres: 18 },
    { texte: `Statut : ${commande.statut}`, espaceApres: 30 },
    { texte: "Vos fonds restent bloqués en compte séquestre jusqu'à validation", taille: 9, espaceApres: 14 },
    { texte: "de la conformité de la marchandise, conformément aux CGU/CGV AgriSecur.", taille: 9, espaceApres: 14 },
  ];
  const contenu = construireContenu(lignes);

  const objets = [];
  objets.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj");
  objets.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj");
  objets.push("3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /MediaBox [0 0 595 842] /Contents 4 0 R >>\nendobj");
  objets.push(`4 0 obj\n<< /Length ${Buffer.byteLength(contenu, "utf-8")} >>\nstream\n${contenu}\nendstream\nendobj`);
  objets.push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj");

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objets) {
    offsets.push(Buffer.byteLength(pdf, "utf-8"));
    pdf += obj + "\n";
  }
  const xrefStart = Buffer.byteLength(pdf, "utf-8");
  pdf += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, "utf-8");
}

module.exports = { genererPdfBonCommande };
