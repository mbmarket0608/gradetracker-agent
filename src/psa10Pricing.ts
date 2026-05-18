// PSA10-Preis-Aggregator: aus einer Liste von eBay-Sales den gewichteten
// EUR-Preis berechnen.
//
// Gewichtung: aktuellster Verkauf 50%, mittlerer 30%, aeltester 20%.
// Bei weniger als 3 Samples: lineare Normalisierung der Gewichte.
// Bei 0 Samples: null.

import type { EbaySale, Psa10PriceResult } from './types.js';
import { searchSoldHistory } from './ebay.js';

const USD_TO_EUR = parseFloat(process.env.USD_TO_EUR_RATE || '0.85');

interface AggregateOptions {
  cardName: string;
  cardId?: string | null;
  preferredSellers: string[];   // lowercase
  daysBack: number;              // initial 14
  extendedDaysBack: number;      // wenn 0 Treffer: 28
}

export async function aggregatePsa10Price(opts: AggregateOptions): Promise<Psa10PriceResult | null> {
  const query = `${opts.cardName} ${opts.cardId || ''} PSA 10`.trim();

  // Erstversuch: preferredSellers im normalen Zeitfenster
  let samples = await searchSoldHistory({
    query,
    daysBack: opts.daysBack,
    sellerWhitelist: opts.preferredSellers,
  });

  let reason = `${samples.length} Sale(s) der bevorzugten Verkaeufer in ${opts.daysBack} Tagen`;

  // Falls keine preferred-Sales: erweitern auf 28 Tage
  if (samples.length === 0 && opts.extendedDaysBack > opts.daysBack) {
    samples = await searchSoldHistory({
      query,
      daysBack: opts.extendedDaysBack,
      sellerWhitelist: opts.preferredSellers,
    });
    reason = `${samples.length} Sale(s) der bevorzugten Verkaeufer in ${opts.extendedDaysBack} Tagen (erweitert)`;
  }

  // Falls immer noch keine: ohne Whitelist
  if (samples.length === 0) {
    samples = await searchSoldHistory({
      query,
      daysBack: opts.extendedDaysBack,
    });
    reason = `${samples.length} Sale(s) ohne Verkaeufer-Whitelist (Fallback)`;
  }

  if (samples.length === 0) return null;

  // Sortieren nach soldDate desc, dann max 3 nehmen
  samples.sort((a, b) => new Date(b.soldDate).getTime() - new Date(a.soldDate).getTime());
  const picked = samples.slice(0, 3);

  // Gewichtung
  const weights: number[] = picked.length === 3 ? [0.5, 0.3, 0.2]
                          : picked.length === 2 ? [0.65, 0.35]
                          : [1.0];

  let weightedUsd = 0;
  for (let i = 0; i < picked.length; i++) {
    weightedUsd += picked[i].soldPriceUsd * weights[i];
  }
  const weightedEur = weightedUsd * USD_TO_EUR;

  const confidence = pickedConfidence(picked, opts.preferredSellers);

  return {
    weightedPriceUsd: round2(weightedUsd),
    weightedPriceEur: round2(weightedEur),
    samples: picked,
    confidenceScore: confidence,
    reason: `${reason} · gewichtet ${weights.map(w => `${(w * 100).toFixed(0)}%`).join('/')}`,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pickedConfidence(samples: EbaySale[], preferred: string[]): number {
  if (samples.length === 0) return 0;
  let score = 0.4;                              // Basis fuer 1 Sample
  if (samples.length >= 2) score += 0.2;
  if (samples.length >= 3) score += 0.2;
  const preferredLc = preferred.map(s => s.toLowerCase());
  const preferredHits = samples.filter(s => preferredLc.includes(s.seller.toLowerCase())).length;
  if (preferredHits >= 1) score += 0.1;
  if (preferredHits >= 2) score += 0.1;
  return Math.min(1, score);
}
