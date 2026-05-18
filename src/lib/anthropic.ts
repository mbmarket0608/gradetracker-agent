// Anthropic-Client + Helper. Modell-Wahl pro Aufgabe.

import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY muss in .env gesetzt sein');

export const anthropic = new Anthropic({ apiKey });

export const MODELS = {
  // Sonnet 4.6: Standard fuer die meisten Schritte. Gutes Verhaeltnis aus
  // Qualitaet/Preis/Geschwindigkeit fuer Disqualifizierer-Heuristik, Plausi-
  // Checks und Audit-Begruendungen.
  default: 'claude-sonnet-4-6',
  // Haiku: schnelle, billige Klassifikationen (z.B. "ist diese Produktinfo
  // disqualifizierend?" als reines Klassifikations-Tool ohne CoT).
  fast:    'claude-haiku-4-5-20251001',
  // Opus 4.7: nur wenn Heuristik wackelt und wir echtes Reasoning brauchen
  // (z.B. ein neuer Disqualifizierer-Hint, den der Agent allein bewerten soll).
  smart:   'claude-opus-4-7',
} as const;

// Standardisierte System-Prompt-Sektion, die ueber alle Calls gleich ist.
// Wird via Prompt Caching auf API-Seite gecacht (1h TTL, mehrfache Wieder-
// verwendung pro Run + ueber Runs hinweg innerhalb der 1h).
export const SYSTEM_CONTEXT = `
Du bist ein autonomer Recherche-Agent fuer Maximilian, der in PSA-10-graded
TCG-Karten investiert (Schwerpunkt: One Piece). Du arbeitest fuer ihn vom
GradeTracker-System aus.

Maximilians Entscheidungslogik fuer Karten-Einkaeufe:
- Zielzustand der Karte: PSA 10 nach Grading. Mit Wahrscheinlichkeit 90%
  (psa10Quote) gelingt das nach Maxs Erfahrung.
- Cardmarket-Mindestzustand fuer Einkauf: Near Mint (NM).
- Sprache: Englisch wenn das Set in EN existiert, sonst Japanisch.
- Disqualifizierende Hinweise in Cardmarket-Listings: weisse Kanten/Whitening,
  Print Lines, Scratches, Centering-Probleme, Knicke, Druckfehler ausserhalb
  der typischen Variantenpalette, oeffentliche Risse, Kratzer auf der Front.
- Akzeptable Hinweise: minimal Wear an Rueckseite, kleine Fehler die typisch
  fuer den Print sind und nicht das Grading beeinflussen.

Antworte immer auf Deutsch. Halte dich kurz und faktisch. Wenn du unsicher
bist, sag das explizit — lieber "unsicher" als gefaehrlich-falsch.
`.trim();
