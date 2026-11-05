/**
 * Inventaire des billets RÉELLEMENT ENVOYÉS, reconstitué depuis Gmail.
 *
 * À quoi cela sert. La base ne garde pas de journal d'envoi immuable : elle
 * garde l'état courant. Une commande annulée perd ses documents Ticket (ils
 * sont supprimés à l'annulation), et `attestationSentAt` n'est qu'une date,
 * sans destinataire ni liste de places. Quand une commande a basculé en
 * `failed` ou `canceled` APRÈS qu'un courriel soit parti, la boîte d'envoi est
 * donc la seule trace de ce que le spectateur a effectivement reçu — et de la
 * place qu'il présentera à l'entrée.
 *
 * Ce script lit Gmail, extrait de chaque courriel de billetterie le
 * destinataire, la date, les places et l'identifiant de commande, et écrit un
 * CSV. Rien n'est envoyé ni modifié : lecture seule.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * INSTALLATION (projet autonome, indépendant de la bibliothèque BTS)
 *
 *   1. script.google.com → Nouveau projet
 *   2. Coller ce fichier, l'enregistrer
 *   3. Exécuter `inventaireBillets` — Google demande l'autorisation Gmail +
 *      Drive la première fois
 *   4. Le CSV est déposé sur le Drive du compte ; son nom et son URL sont
 *      affichés dans le journal d'exécution (Affichage → Journaux)
 *
 * Doit être exécuté depuis le compte qui a ENVOYÉ les courriels (la recherche
 * porte sur les messages envoyés).
 * ────────────────────────────────────────────────────────────────────────────
 */

// ——— Réglages ——————————————————————————————————————————————————————————————

var CONFIG = {
  // Fragment du sujet des courriels de billetterie. Vient de
  // data/customization/default.json → "event.emailSubject".
  // À élargir si vous avez personnalisé le sujet par saison ou par match.
  sujet: 'Vos places pour le match',

  // Facultatif : ne garder que les courriels mentionnant ce match.
  // Le nom du match figure dans le sujet et dans le titre du message.
  // Laisser vide pour tout prendre.
  match: '',

  // Bornes de recherche Gmail (format AAAA/MM/JJ). La borne haute est exclue.
  depuis: '2026/09/01',
  jusqua: '',

  // Nombre maximal de fils à parcourir. Gmail ne rend pas tout d'un coup ;
  // au-delà, affiner `depuis`/`jusqua` plutôt que d'augmenter sans fin.
  maxFils: 500,

  // Nom du fichier produit sur le Drive.
  fichier: 'inventaire-billets-envoyes.csv'
};

// ——— Point d'entrée ———————————————————————————————————————————————————————

function inventaireBillets() {
  var requete = construireRequete_();
  Logger.log('Recherche Gmail : ' + requete);

  var fils = GmailApp.search(requete, 0, CONFIG.maxFils);
  Logger.log(fils.length + ' fil(s) trouvé(s)');

  var lignes = [];
  var messagesLus = 0;
  var sansPlace = 0;

  for (var i = 0; i < fils.length; i++) {
    var messages = fils[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      // Un fil peut mêler l'envoi et une réponse : on ne retient que les
      // messages dont le sujet porte la marque de la billetterie.
      if (msg.getSubject().indexOf(CONFIG.sujet) === -1) continue;
      if (CONFIG.match && msg.getSubject().indexOf(CONFIG.match) === -1
          && msg.getBody().indexOf(CONFIG.match) === -1) continue;

      messagesLus++;
      var extraites = extraireLignes_(msg);
      if (!extraites.length) sansPlace++;
      for (var k = 0; k < extraites.length; k++) lignes.push(extraites[k]);
    }
  }

  Logger.log(messagesLus + ' courriel(s) de billetterie · '
    + lignes.length + ' place(s) · ' + sansPlace + ' courriel(s) sans place lisible');

  var fichier = ecrireCsv_(lignes);
  Logger.log('CSV : ' + fichier.getName() + ' → ' + fichier.getUrl());
  return fichier.getUrl();
}

// ——— Recherche ————————————————————————————————————————————————————————————

function construireRequete_() {
  // `in:anywhere` couvre la corbeille et les archives : un courriel rangé ou
  // supprimé a tout de même été reçu par son destinataire.
  var parts = ['in:anywhere', 'subject:"' + CONFIG.sujet + '"'];
  if (CONFIG.depuis) parts.push('after:' + CONFIG.depuis);
  if (CONFIG.jusqua) parts.push('before:' + CONFIG.jusqua);
  return parts.join(' ');
}

// ——— Extraction ———————————————————————————————————————————————————————————

/**
 * Une ligne de sortie par PLACE. Un courriel couvre souvent plusieurs places
 * (une famille) : les éclater permet de retrouver un siège sans relire le
 * message.
 */
function extraireLignes_(msg) {
  var corps = msg.getBody();
  var destinataire = msg.getTo() || '';
  var date = formaterDate_(msg.getDate());
  var sujet = msg.getSubject() || '';
  var orderId = extraireOrderId_(msg, corps);
  var match = extraireMatch_(sujet);

  var places = extrairePlaces_(corps);
  if (!places.length) {
    // On émet quand même une ligne : un courriel parti sans place lisible est
    // précisément ce qu'on veut voir, pas ce qu'on veut taire.
    return [{
      date: date, destinataire: destinataire, match: match, orderId: orderId,
      place: '', beneficiaire: '', tarif: '', montant: '',
      piecesJointes: listerPieces_(msg), remarque: 'aucune place lue dans le corps'
    }];
  }

  var out = [];
  for (var i = 0; i < places.length; i++) {
    out.push({
      date: date, destinataire: destinataire, match: match, orderId: orderId,
      place: places[i].place, beneficiaire: places[i].beneficiaire,
      tarif: places[i].tarif, montant: places[i].montant,
      piecesJointes: i === 0 ? listerPieces_(msg) : '', remarque: ''
    });
  }
  return out;
}

/**
 * Le tableau « Vos places » du gabarit : une ligne par place, quatre colonnes
 * (place/zone, bénéficiaire, tarif, montant). La dernière ligne est le total,
 * reconnaissable à sa cellule fusionnée — on l'écarte.
 */
function extrairePlaces_(corps) {
  var out = [];
  var rx = /<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  var m;
  while ((m = rx.exec(corps)) !== null) {
    var c1 = nettoyer_(m[1]);
    var c2 = nettoyer_(m[2]);
    var c3 = nettoyer_(m[3]);
    var c4 = nettoyer_(m[4]);
    if (!c1) continue;
    // En-tête du tableau et ligne de total : ni l'un ni l'autre n'est une place.
    if (/^place/i.test(c1) || /^total$/i.test(c1) || /^total$/i.test(c2)) continue;
    out.push({ place: c1, beneficiaire: c2, tarif: c3, montant: c4 });
  }
  return out;
}

/**
 * L'identifiant de commande n'est pas écrit en clair dans le corps : il est
 * dans le NOM du PDF joint — « billets-<orderId>.pdf » pour une confirmation,
 * « Billets_<match>_<6 derniers>.pdf » pour un envoi d'abonnements. À défaut,
 * on tente une chaîne de 24 caractères hexadécimaux dans le corps.
 */
function extraireOrderId_(msg, corps) {
  var pieces = msg.getAttachments({ includeInlineImages: false });
  for (var i = 0; i < pieces.length; i++) {
    var nom = pieces[i].getName() || '';
    var plein = nom.match(/billets-([0-9a-f]{24})\.pdf/i);
    if (plein) return plein[1];
    var court = nom.match(/Billets_.*_([0-9a-f]{6})\.pdf/i);
    if (court) return '…' + court[1];
  }
  var dansCorps = corps.match(/\b[0-9a-f]{24}\b/i);
  return dansCorps ? dansCorps[0] : '';
}

/** Le nom du match suit un tiret cadratin dans le sujet. */
function extraireMatch_(sujet) {
  var m = sujet.split('—');
  return m.length > 1 ? m[m.length - 1].trim() : '';
}

function listerPieces_(msg) {
  var pieces = msg.getAttachments({ includeInlineImages: false });
  var noms = [];
  for (var i = 0; i < pieces.length; i++) noms.push(pieces[i].getName());
  return noms.join(' | ');
}

// ——— Utilitaires ——————————————————————————————————————————————————————————

function nettoyer_(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8239;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formaterDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

function csvEchappe_(v) {
  var s = (v === null || v === undefined) ? '' : String(v);
  return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function ecrireCsv_(lignes) {
  var entetes = ['envoyeLe', 'destinataire', 'match', 'orderId', 'place',
                 'beneficiaire', 'tarif', 'montant', 'piecesJointes', 'remarque'];
  var sortie = [entetes.join(',')];
  for (var i = 0; i < lignes.length; i++) {
    var l = lignes[i];
    sortie.push([
      l.date, l.destinataire, l.match, l.orderId, l.place,
      l.beneficiaire, l.tarif, l.montant, l.piecesJointes, l.remarque
    ].map(csvEchappe_).join(','));
  }
  // ﻿ : sans cette marque, Excel ouvre le fichier en ASCII et abîme les
  // accents comme les noms de place.
  var contenu = '﻿' + sortie.join('\n') + '\n';
  return DriveApp.createFile(CONFIG.fichier, contenu, MimeType.CSV);
}

/**
 * Essai à blanc : affiche les cinq premières lignes dans le journal sans rien
 * écrire sur le Drive. À lancer d'abord pour vérifier que le sujet configuré
 * trouve bien les courriels.
 */
function apercuBillets() {
  var requete = construireRequete_();
  Logger.log('Recherche : ' + requete);
  var fils = GmailApp.search(requete, 0, 20);
  Logger.log(fils.length + ' fil(s)');
  var vues = 0;
  for (var i = 0; i < fils.length && vues < 5; i++) {
    var messages = fils[i].getMessages();
    for (var j = 0; j < messages.length && vues < 5; j++) {
      if (messages[j].getSubject().indexOf(CONFIG.sujet) === -1) continue;
      var lignes = extraireLignes_(messages[j]);
      for (var k = 0; k < lignes.length && vues < 5; k++) {
        var l = lignes[k];
        Logger.log([l.date, l.destinataire, l.match, l.orderId, l.place,
                    l.beneficiaire, l.tarif].join(' | '));
        vues++;
      }
    }
  }
  if (!vues) Logger.log('Aucune ligne : vérifier CONFIG.sujet et CONFIG.depuis.');
}
