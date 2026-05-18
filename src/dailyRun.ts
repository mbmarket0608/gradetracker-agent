// Orchestrator: ein kompletter Daily-Run von eBay-Scrape bis Persist.
//
// Schritte:
//   1. agent_run starten
//   2. eBay-Scrape: Last 24h sold ≥ $700
//   3. Pro Sale: Katalog-Match → wenn nicht: dq_flag (missing_catalog)
//   4. Pro Match: PSA10-Pricing-Aggregator
//   5. Pro Karte: Cardmarket-Pick (guenstigste qualifizierte NM)
//   6. Pro Karte: DQ-Check (Bild ↔ Preisniveau)
//   7. Persist als purchase_opportunity
//   8. agent_run abschliessen

import {
  startAgentRun, finishAgentRun, abortAgentRun,
  startStep, loadCatalog, getOrCreateTodaySession,
  persistOpportunity, persistDqFlag,
} from './lib/supabase.js';
import { createCatalogLookup } from './lib/catalogMatch.js';
import { searchSoldListings, closeAll as closeEbay, persistState as persistEbayState } from './ebay.js';
import { aggregatePsa10Price } from './psa10Pricing.js';
import { findCheapestQualifiedListing, closeAll as closeCm, persistState as persistCmState } from './cardmarket.js';
import type { AgentRunStats, RunTrigger, DataQualityFlag } from './types.js';

const SEARCH_TERM = process.env.EBAY_SEARCH_TERM || 'One Piece PSA 10';
const MIN_PRICE_USD = parseFloat(process.env.EBAY_MIN_PRICE_USD || '700');
const PREFERRED_SELLERS = (process.env.PSA10_PREFERRED_SELLERS || 'probstin123,dcsports87')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DQ_FACTOR = parseFloat(process.env.DQ_PRICE_MISMATCH_FACTOR || '3');

export async function runDaily(trigger: RunTrigger): Promise<{ runId: string; stats: AgentRunStats }> {
  const runId = await startAgentRun(trigger);
  const stats: AgentRunStats = { ebaySalesFound: 0, catalogMatches: 0, qualifiedOpps: 0, dqFlags: 0, errors: 0 };

  try {
    // ── Schritt 1: eBay-Sales ziehen ──────────────────────────────────────
    const stepEbay = await startStep(runId, 'ebay_scrape');
    const sales = await searchSoldListings({
      searchTerm: SEARCH_TERM,
      minPriceUsd: MIN_PRICE_USD,
      hoursBack: 24,
    });
    stats.ebaySalesFound = sales.length;
    await stepEbay.finish({ summary: `${sales.length} eBay-Sales gefunden`, sample: sales.slice(0, 3) });
    await persistEbayState();

    // ── Schritt 2: Katalog laden + matchen ────────────────────────────────
    const stepMatch = await startStep(runId, 'catalog_match');
    const catalog = await loadCatalog();
    const lookup = createCatalogLookup(catalog);

    const matched: Array<{ sale: typeof sales[number]; catalog: ReturnType<typeof lookup.byEbayTitle> }> = [];
    const missing: typeof sales = [];
    for (const sale of sales) {
      const cat = lookup.byEbayTitle(sale.title);
      if (cat) { matched.push({ sale, catalog: cat }); }
      else { missing.push(sale); }
    }
    stats.catalogMatches = matched.length;
    await stepMatch.finish({ summary: `${matched.length}/${sales.length} gematcht`, missingTitles: missing.slice(0, 5).map(s => s.title) });

    // Missing-Catalog DQ-Flags
    for (const sale of missing) {
      await persistDqFlag(runId, {
        kind: 'missing_catalog',
        payload: {
          summary: `eBay-Titel "${sale.title.slice(0, 60)}…" nicht im Katalog gefunden`,
          ebaySale: { title: sale.title, priceUsd: sale.soldPriceUsd, url: sale.listingUrl },
        },
      });
      stats.dqFlags++;
    }

    // ── Schritt 3: PSA10-Pricing ──────────────────────────────────────────
    const stepPricing = await startStep(runId, 'psa10_pricing');
    const sessionId = await getOrCreateTodaySession();
    let qualified = 0;

    for (const { sale, catalog: cat } of matched) {
      if (!cat) continue;

      const psa10 = await aggregatePsa10Price({
        cardName: cat.name,
        cardId: cat.cardId,
        preferredSellers: PREFERRED_SELLERS,
        daysBack: 14,
        extendedDaysBack: 28,
      });
      if (!psa10) continue;

      // ── Schritt 4: Cardmarket-Pick ──────────────────────────────────────
      const language = pickLanguagePreference(cat);
      const cmListing = await findCheapestQualifiedListing(cat, { preferredLanguage: language });
      if (!cmListing) continue;

      // ── Schritt 5: DQ-Check ─────────────────────────────────────────────
      const dqFlags = checkDataQuality(cat, psa10.weightedPriceEur, DQ_FACTOR);
      for (const flag of dqFlags) {
        await persistDqFlag(runId, flag);
        stats.dqFlags++;
      }

      // ── Schritt 6: Persist ──────────────────────────────────────────────
      await persistOpportunity(sessionId, runId, {
        catalog: cat,
        psa10,
        cmListing,
        ebaySource: sale,
      });
      qualified++;
    }
    stats.qualifiedOpps = qualified;
    await stepPricing.finish({ summary: `${qualified} Einkaufsplan-Eintraege persistiert` });
    await persistCmState();

    await finishAgentRun(runId, stats);
    return { runId, stats };
  } catch (e: unknown) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    stats.errors++;
    await abortAgentRun(runId, msg).catch(() => {});
    await finishAgentRun(runId, stats, msg).catch(() => {});
    throw e;
  } finally {
    await closeEbay().catch(() => {});
    await closeCm().catch(() => {});
  }
}

function pickLanguagePreference(cat: { tcg: string; language: string }): 'Englisch' | 'Japanisch' {
  // Default: Englisch. JP nur wenn die Karte im Katalog mit JP markiert ist
  // und es keine EN-Variante gibt (vereinfachte Heuristik fuer Iteration 1 —
  // spaeter genauere Cross-Reference im Katalog).
  return cat.language === 'Japanisch' ? 'Japanisch' : 'Englisch';
}

function checkDataQuality(
  cat: { id: string; name: string; psa10Price?: number; imageUrl?: string | null },
  newPsa10Eur: number,
  factor: number,
): DataQualityFlag[] {
  const flags: DataQualityFlag[] = [];
  const old = cat.psa10Price || 0;

  if (old > 0 && newPsa10Eur > 0) {
    const ratio = Math.max(old, newPsa10Eur) / Math.min(old, newPsa10Eur);
    if (ratio >= factor) {
      flags.push({
        kind: 'price_mismatch',
        catalogId: cat.id,
        payload: {
          summary: `Katalog ${old.toFixed(0)}€ vs. neu ${newPsa10Eur.toFixed(0)}€ — Faktor ${ratio.toFixed(1)}×`,
          old, new: newPsa10Eur, ratio,
        },
      });
    }
  }

  if (!cat.imageUrl) {
    flags.push({
      kind: 'image_mismatch',
      catalogId: cat.id,
      payload: { summary: `Kein Bild im Katalog (${cat.name})` },
    });
  }

  return flags;
}
