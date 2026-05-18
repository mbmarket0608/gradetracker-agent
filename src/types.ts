// Gemeinsame Domain-Typen. Ergeben den Daten-Vertrag zwischen den Modulen.

export interface EbaySale {
  title: string;
  soldPriceUsd: number;
  soldDate: string;       // ISO
  seller: string;
  listingUrl: string;
  // Optional, falls eBay sie im Listing zeigt:
  cardSet?: string;
  cardNumber?: string;
}

export interface CatalogEntry {
  id: string;
  tcg: string;
  name: string;
  set: string;
  language: string;
  cardId?: string | null;
  cardmarketId?: number | null;
  imageUrl?: string | null;
  rawPriceCM?: number;
  psa10Price?: number;
}

export interface Psa10PriceResult {
  weightedPriceUsd: number;
  weightedPriceEur: number;
  samples: EbaySale[];
  confidenceScore: number;   // 0..1, basierend auf Sample-Anzahl + Quellen-Mix
  reason: string;             // menschen-lesbare Begruendung fuer Audit
}

export interface CardmarketListing {
  listingUrl: string;
  sellerName: string;
  sellerCountry: string;       // ISO-2 ("DE", "FR", ...)
  priceEur: number;            // Listing-Preis ohne Versand
  shippingEur: number;         // Geschaetzter Versand zu Max
  totalEur: number;            // priceEur + shippingEur
  conditionGrade: string;      // "Mint", "Near Mint", ...
  language: string;
  productInfoRaw: string;
  qualifying: boolean;
  qualifyingReason: string;    // warum (nicht) qualifiziert
}

export interface OpportunityCandidate {
  catalog: CatalogEntry;
  psa10: Psa10PriceResult;
  cmListing: CardmarketListing;
  ebaySource: EbaySale;        // Der ausloesende Last-24h-Sale
}

export interface DataQualityFlag {
  kind: 'price_mismatch' | 'image_mismatch' | 'missing_catalog' | 'reprint_conflict';
  catalogId?: string;
  payload: Record<string, unknown>;
}

export interface AgentRunStats {
  ebaySalesFound: number;
  catalogMatches: number;
  qualifiedOpps: number;
  dqFlags: number;
  errors: number;
}

export type RunTrigger = 'cron' | 'manual';

export type StepName =
  | 'ebay_scrape'
  | 'catalog_match'
  | 'psa10_pricing'
  | 'cm_pick'
  | 'dq_check'
  | 'persist';
