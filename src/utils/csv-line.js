// src/utils/csv-line.js
//
// Découpe d'une ligne CSV : champs entre guillemets (séparateur ou "" à
// l'intérieur), espaces de bord retirés. Partagé par les imports qui lisaient
// chacun à leur façon — un simple split(',') coupait un libellé contenant une
// virgule et laissait les guillemets autour des valeurs.

export function splitCsvLine(line, delimiter = ',') {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(v => v.trim());
}

/** « ; » si l'en-tête en compte plus que de « , », sinon « , ». */
export function detectCsvDelimiter(headerLine) {
  const line = String(headerLine || '');
  return line.split(';').length > line.split(',').length ? ';' : ',';
}
