// Portierte Version von src/lib/catalogMatch.js aus dem GradeTracker-Repo,
// erweitert um Token-basiertes Matching gegen eBay-Titel.
//
// Matching-Strategie (gleich wie im Frontend):
//   1. cardmarket_id (deterministisch)
//   2. cardId + Set + Sprache
//   3. cardId + Set
//   4. cardId-only
//   5. name + Set + Sprache
//
// Zusaetzlich: tokenBasiertes Fuzzy-Matching fuer eBay-Titel, die keine
// strukturierten Felder haben.

import type { CatalogEntry } from '../types.js';

const norm = (s: string | null | undefined) => String(s || '').toLowerCase().trim();
const cardIdKey = (id: string | null | undefined) => String(id || '').toUpperCase().replace(/[\s-]+/g, '');

export interface CatalogLookup {
  byKey: (item: { cardmarketId?: number | null; cardId?: string | null; set?: string | null; language?: string | null; name?: string | null }) => CatalogEntry | null;
  byEbayTitle: (title: string) => CatalogEntry | null;
  entries: CatalogEntry[];
}

export function createCatalogLookup(rawCatalog: Array<Record<string, unknown>>): CatalogLookup {
  const entries: CatalogEntry[] = rawCatalog.map(c => ({
    id: String(c.id),
    tcg: String(c.tcg || ''),
    name: String(c.name || ''),
    set: String(c.set || ''),
    language: String(c.language || ''),
    cardId: c.card_id ? String(c.card_id) : null,
    cardmarketId: c.cardmarket_id ? Number(c.cardmarket_id) : null,
    imageUrl: c.image_url ? String(c.image_url) : null,
    rawPriceCM: c.raw_price_cm ? Number(c.raw_price_cm) : 0,
    psa10Price: c.psa10_price ? Number(c.psa10_price) : 0,
  }));

  const byCmId = new Map<string, CatalogEntry>();
  const byCardIdSetLang = new Map<string, CatalogEntry>();
  const byCardIdSet = new Map<string, CatalogEntry>();
  const byCardId = new Map<string, CatalogEntry>();
  const byNameSetLang = new Map<string, CatalogEntry>();

  for (const c of entries) {
    if (c.cardmarketId) byCmId.set(String(c.cardmarketId), c);
    if (c.cardId) {
      const cid = cardIdKey(c.cardId);
      if (c.set) {
        const k = `${cid}|${norm(c.set)}|${norm(c.language)}`;
        if (!byCardIdSetLang.has(k)) byCardIdSetLang.set(k, c);
        const k2 = `${cid}|${norm(c.set)}`;
        if (!byCardIdSet.has(k2)) byCardIdSet.set(k2, c);
      }
      if (!byCardId.has(cid)) byCardId.set(cid, c);
    }
    if (c.name) {
      const nk = `${norm(c.name)}|${norm(c.set)}|${norm(c.language)}`;
      if (!byNameSetLang.has(nk)) byNameSetLang.set(nk, c);
    }
  }

  const byKey: CatalogLookup['byKey'] = (item) => {
    if (item.cardmarketId) {
      const hit = byCmId.get(String(item.cardmarketId));
      if (hit) return hit;
    }
    if (item.cardId) {
      const cid = cardIdKey(item.cardId);
      if (item.set) {
        const k = `${cid}|${norm(item.set)}|${norm(item.language)}`;
        const hit = byCardIdSetLang.get(k);
        if (hit) return hit;
        const k2 = `${cid}|${norm(item.set)}`;
        const hit2 = byCardIdSet.get(k2);
        if (hit2) return hit2;
      }
      const hit3 = byCardId.get(cid);
      if (hit3) return hit3;
    }
    if (item.name) {
      const nk = `${norm(item.name)}|${norm(item.set)}|${norm(item.language)}`;
      const hit = byNameSetLang.get(nk);
      if (hit) return hit;
    }
    return null;
  };

  // Token-Match auf eBay-Titel: extrahiert Set-Code (z.B. "OP09-050"),
  // sonst Name-Token-Overlap. Konservativ — bei Unsicherheit lieber null
  // zurueckgeben und als missing_catalog flaggen.
  const byEbayTitle: CatalogLookup['byEbayTitle'] = (title) => {
    if (!title) return null;
    const cardIdMatch = title.match(/\b(OP|EB|ST|PRB)\d{1,2}-\d{1,4}(?:-V\d+)?\b/i);
    if (cardIdMatch) {
      const cid = cardIdKey(cardIdMatch[0]);
      const hit = byCardId.get(cid);
      if (hit) return hit;
    }
    // Fallback: Name-Token-Overlap. Sehr defensiv (>= 2 Tokens uebereinstimmen
    // mit Karten-Namen).
    const titleTokens = new Set(
      norm(title).split(/[^a-z0-9]+/i).filter(t => t.length >= 3 && !['psa','one','piece','english','japanese','holo','rare','card','tcg'].includes(t))
    );
    if (titleTokens.size < 2) return null;
    let best: CatalogEntry | null = null;
    let bestScore = 0;
    for (const c of entries) {
      const nameTokens = norm(c.name).split(/[^a-z0-9]+/).filter(t => t.length >= 3);
      let score = 0;
      for (const t of nameTokens) if (titleTokens.has(t)) score++;
      if (score > bestScore && score >= Math.min(2, nameTokens.length)) {
        best = c; bestScore = score;
      }
    }
    return best;
  };

  return { byKey, byEbayTitle, entries };
}
