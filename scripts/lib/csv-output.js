// scripts/lib/csv-output.js
//
// Écriture d'un CSV d'export dans data/outputs/, avec la résolution de chemin
// et la gestion d'erreur que chaque script d'export réinventait.
//
// Le piège que ce module ferme : un chemin RELATIF contenant déjà un
// séparateur (« data/outputs/x.csv », la forme qu'on lit dans la doc et dans
// les formulaires d'admin) était concaténé à data/outputs/, donnant
// data/outputs/data/outputs/x.csv — un dossier inexistant. Seul un nom de
// fichier NU est résolu dans data/outputs/ ; tout chemin est pris tel quel,
// relatif au dossier courant.
import fs from 'fs';
import path from 'path';

export const OUTPUT_DIR = () => path.resolve(process.cwd(), 'data/outputs');

export function resolveOutputPath(outArg, defaultName) {
  const dir = OUTPUT_DIR();
  if (!outArg) return path.join(dir, defaultName);
  if (path.isAbsolute(outArg)) return outArg;
  return (outArg.includes(path.sep) || outArg.includes('/'))
    ? path.resolve(process.cwd(), outArg)
    : path.join(dir, outArg);
}

/**
 * Appelle `writer(stream)` en écrivant dans le fichier voulu, et rend le
 * chemin écrit avec le nombre de lignes de données.
 *
 * @param {object}   options
 * @param {string?}  options.outArg      valeur de --out, ou null
 * @param {string}   options.defaultName nom de fichier par défaut
 * @param {function} options.writer      reçoit le flux de sortie
 * @returns {Promise<{ path: string, lines: number }>}
 */
export async function writeCsvFile({ outArg, defaultName, writer }) {
  fs.mkdirSync(OUTPUT_DIR(), { recursive: true });
  const outPath = resolveOutputPath(outArg, defaultName);
  // Le dossier cible peut ne pas exister quand --out désigne un sous-chemin.
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const stream = fs.createWriteStream(outPath, { encoding: 'utf8' });
  // Handler posé AVANT la première écriture : une erreur d'ouverture survient
  // pendant l'export, donc avant que la promesse ci-dessous existe — sans
  // cela le flux émet un 'error' non géré et le process s'arrête sur une
  // trace au lieu d'un message.
  const failure = new Promise((_, reject) => stream.on('error', reject));
  await Promise.race([writer(stream), failure]);
  // Attendre la fermeture : sortir avant le vidage du tampon tronquerait le CSV.
  await Promise.race([
    new Promise((resolve) => { stream.on('finish', resolve); stream.end(); }),
    failure
  ]);

  const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean).length;
  return { path: outPath, lines: Math.max(0, lines - 1) };
}

/**
 * Signale l'échec d'un export. N'annonce « écriture impossible » que lorsque
 * c'en est une : ces scripts échouent aussi bien sur une cible introuvable,
 * et coiffer ces cas d'un message de disque envoie chercher au mauvais endroit.
 */
export function explainWriteFailure(err) {
  const isWrite = err?.code === 'EACCES' || err?.code === 'ENOENT' || err?.code === 'EPERM';
  console.error(`❌ ${isWrite ? 'Écriture impossible : ' : ''}${err?.message || err}`);
  if (isWrite) {
    console.error('   Vérifiez le chemin de --out. Un nom de fichier seul est écrit dans data/outputs/ ;');
    console.error('   un chemin est pris tel quel, relatif au dossier courant.');
  }
}
