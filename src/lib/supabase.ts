// Supabase-Client + DB-Operationen fuer den Agent-Service.
// Nutzt den Service-Role-Key (RLS-bypass), weil der Service ausserhalb des
// User-Session-Kontexts laeuft.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { AgentRunStats, RunTrigger, StepName, OpportunityCandidate, DataQualityFlag } from '../types.js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  throw new Error('SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY muessen in .env gesetzt sein');
}

export const supabase: SupabaseClient = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// ─── Runs ────────────────────────────────────────────────────────────────

export async function startAgentRun(trigger: RunTrigger): Promise<string> {
  const id = newId();
  const { error } = await supabase.from('agent_runs').insert({
    id, status: 'running', trigger, started_at: new Date().toISOString(),
  });
  if (error) throw error;
  return id;
}

export async function finishAgentRun(id: string, stats: AgentRunStats, errorMessage?: string): Promise<void> {
  const status = errorMessage ? 'error' : 'success';
  const { error } = await supabase.from('agent_runs').update({
    status, ended_at: new Date().toISOString(), stats, error_message: errorMessage,
  }).eq('id', id);
  if (error) throw error;
}

export async function abortAgentRun(id: string, reason: string): Promise<void> {
  const { error } = await supabase.from('agent_runs').update({
    status: 'aborted', ended_at: new Date().toISOString(), error_message: reason,
  }).eq('id', id);
  if (error) throw error;
}

// ─── Steps ───────────────────────────────────────────────────────────────

export interface StepHandle {
  id: string;
  finish(payload?: Record<string, unknown>, errorMessage?: string): Promise<void>;
}

export async function startStep(runId: string, stepName: StepName): Promise<StepHandle> {
  const id = newId();
  const { error } = await supabase.from('agent_run_steps').insert({
    id, run_id: runId, step_name: stepName, status: 'running', started_at: new Date().toISOString(),
  });
  if (error) throw error;
  return {
    id,
    async finish(payload, errorMessage) {
      const status = errorMessage ? 'error' : 'success';
      await supabase.from('agent_run_steps').update({
        status, ended_at: new Date().toISOString(), payload, error_message: errorMessage,
      }).eq('id', id);
    },
  };
}

// ─── Katalog lesen ───────────────────────────────────────────────────────

export async function loadCatalog(): Promise<Array<Record<string, unknown>>> {
  // Service ueberhitzt Supabase-Default-Limit (1000) bei groesserem Katalog —
  // paginieren wie im Frontend.
  const PAGE = 1000;
  const all: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('catalog').select('*').order('name').range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

// ─── Einkaufsplan-Session ────────────────────────────────────────────────

// Hole oder erzeuge die heutige Agent-Session. Eine Session pro Tag wird
// reserviert; Eintraege landen darin.
export async function getOrCreateTodaySession(): Promise<string> {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const { data } = await supabase
    .from('purchase_sessions')
    .select('id')
    .gte('started_at', todayStart.toISOString())
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data?.id) return data.id;

  const id = newId();
  const dd = String(todayStart.getDate()).padStart(2, '0');
  const mm = String(todayStart.getMonth() + 1).padStart(2, '0');
  const yyyy = todayStart.getFullYear();
  const { error } = await supabase.from('purchase_sessions').insert({
    id,
    name: `Agent-Session ${dd}.${mm}.${yyyy}`,
    started_at: new Date().toISOString(),
  });
  if (error) throw error;
  return id;
}

// ─── Opportunities schreiben ─────────────────────────────────────────────

export async function persistOpportunity(
  sessionId: string,
  agentRunId: string,
  candidate: OpportunityCandidate,
): Promise<void> {
  const { catalog, psa10, cmListing, ebaySource } = candidate;
  const row = {
    id: newId(),
    session_id: sessionId,
    is_skipped: false,
    catalog_id: catalog.id,
    cardmarket_id: catalog.cardmarketId ?? null,
    card_id_snapshot: catalog.cardId ?? null,
    name_snapshot: catalog.name,
    set_snapshot: catalog.set,
    language_snapshot: catalog.language,
    tcg_snapshot: catalog.tcg,
    image_url_snapshot: catalog.imageUrl ?? null,
    source_url: cmListing.listingUrl,
    current_cm_price: cmListing.totalEur,
    current_psa10_price: psa10.weightedPriceEur,
    recommended_qty: 1,
    ordered_qty: 0,
    note: `🤖 ${psa10.reason}`,
    source: 'agent',
    agent_run_id: agentRunId,
    ebay_sales_used: [
      { trigger: { seller: ebaySource.seller, priceUsd: ebaySource.soldPriceUsd, soldDate: ebaySource.soldDate, listingUrl: ebaySource.listingUrl } },
      ...psa10.samples.map(s => ({ seller: s.seller, priceUsd: s.soldPriceUsd, soldDate: s.soldDate, listingUrl: s.listingUrl })),
    ],
  };
  const { error } = await supabase.from('purchase_opportunities').insert(row);
  if (error) throw error;
}

// ─── DQ-Flags ────────────────────────────────────────────────────────────

export async function persistDqFlag(agentRunId: string, flag: DataQualityFlag): Promise<void> {
  const { error } = await supabase.from('agent_data_quality_flags').insert({
    id: newId(),
    agent_run_id: agentRunId,
    catalog_id: flag.catalogId ?? null,
    kind: flag.kind,
    payload: flag.payload,
  });
  if (error) throw error;
}
