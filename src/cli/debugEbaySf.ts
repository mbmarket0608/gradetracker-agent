// Debug: rufe eBay-Suche via ScrapingFish, dump HTML + Struktur-Analyse.
// Damit sehen wir welche Selektoren eBay aktuell verwendet.

import 'dotenv/config';
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import { scrapeHtml } from '../lib/scrapingfish.js';

const URL = 'https://www.ebay.com/sch/i.html?_nkw=One+Piece+PSA+10&_sacat=0&LH_Sold=1&LH_Complete=1&LH_Auction=1&_sop=13&_udlo=700';

(async () => {
  console.log('Fetching via ScrapingFish:', URL);
  const html = await scrapeHtml(URL, { renderJs: true });
  console.log('HTML length:', html.length, 'bytes');

  await fs.writeFile('/tmp/ebay-sf.html', html);
  console.log('Saved: /tmp/ebay-sf.html');

  const $ = cheerio.load(html);
  console.log('Title:', $('title').text());

  // Mehrere moegliche Selektor-Hypothesen pruefen
  const counts: Record<string, number> = {
    'li.s-item':                       $('li.s-item').length,
    'div.s-item':                      $('div.s-item').length,
    '.s-item':                         $('.s-item').length,
    'li.srp-river-results-item':       $('li.srp-river-results-item').length,
    '[data-view*="mi"]':               $('[data-view*="mi"]').length,
    'div.s-item__wrapper':             $('div.s-item__wrapper').length,
    '.srp-results li':                 $('.srp-results li').length,
    'ul.srp-results > li':             $('ul.srp-results > li').length,
    'div.s-card':                      $('div.s-card').length,
    'li.s-card':                       $('li.s-card').length,
    '.s-card':                         $('.s-card').length,
  };
  console.log('\nSelektor-Counts:');
  for (const [sel, n] of Object.entries(counts)) {
    console.log(`  ${sel.padEnd(35)} → ${n}`);
  }

  // Einen Treffer im likely-Container untersuchen
  const probe = $('li.s-item, div.s-item, .s-item, .s-card, li.s-card').first();
  if (probe.length) {
    console.log('\nErste Treffer-Card (HTML, gekuerzt):');
    const html = $.html(probe).slice(0, 1500);
    console.log(html);
  } else {
    console.log('\nKein Treffer mit den geprueften Selektoren — duerfte eine andere Markierung sein.');
    // Stattdessen: schauen welche Klassen ueberhaupt vorkommen die "item" enthalten
    const seen = new Set<string>();
    $('[class*="item"]').each((_i, el) => {
      const cls = $(el).attr('class') || '';
      cls.split(/\s+/).filter(c => c.toLowerCase().includes('item')).forEach(c => seen.add(c));
    });
    console.log('Vorkommende Klassen mit "item":', Array.from(seen).slice(0, 30));
  }

  // Hinweise auf Captcha / Block obwohl HTTP 200
  const bodyText = $('body').text().slice(0, 2000).toLowerCase();
  const flags: string[] = [];
  if (bodyText.includes('captcha') || bodyText.includes('verify you')) flags.push('CAPTCHA');
  if (bodyText.includes('access denied') || bodyText.includes('blocked')) flags.push('BLOCK');
  if (bodyText.includes('robot')) flags.push('ROBOT-mention');
  console.log('\nBot-Hint-Flags:', flags.length ? flags.join(',') : '(none)');
})();
