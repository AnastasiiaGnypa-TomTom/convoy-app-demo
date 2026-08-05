#!/usr/bin/env node
/**
 * BUILD-TIME POI category verification.
 *
 * Run: npm run verify:pois
 *
 * Produces server/data/poi-categories.verified.json, which is the ONLY thing the
 * runtime is allowed to query with. If a code is not proven here, the runtime will
 * not query it — and the layer degrades to "no data source connected" rather than
 * silently falling back to a text search.
 *
 * Why this step is needed at all: the numeric ids that `categorySet` requires are
 * not published alongside the UPPER_SNAKE_CASE classification codes that appear in
 * results. There is no endpoint mapping one to the other. So each code is resolved
 * by name against the poi-categories endpoint, then PROVEN empirically: query the
 * candidate id and confirm the classification code that comes back is the code we
 * expected. A name that resolves but returns a different code is a failed
 * verification, not a warning.
 *
 * Secrets are never printed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/env.js';
import { POI_LAYERS, NO_SOURCE_LAYERS } from '../lib/poiAllowlist.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'data');
const OUT_FILE = join(OUT_DIR, 'poi-categories.verified.json');

const C = process.stdout.isTTY
  ? { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' }
  : { reset: '', bold: '', dim: '', red: '', green: '', yellow: '', cyan: '' };

const ok = (m) => console.log(`   ${C.green}✓${C.reset} ${m}`);
const bad = (m) => console.log(`   ${C.red}✗${C.reset} ${m}`);
const warn = (m) => console.log(`   ${C.yellow}!${C.reset} ${m}`);
const info = (m) => console.log(`   ${C.dim}·${C.reset} ${m}`);

/** Dense, varied probe points — a category must return results SOMEWHERE to verify. */
const PROBE_POINTS = [
  { name: 'Utrecht NL', lat: 52.09, lon: 5.12 },
  { name: 'Rotterdam NL', lat: 51.92, lon: 4.48 },
  { name: 'Frankfurt DE', lat: 50.11, lon: 8.68 },
  { name: 'Norfolk VA US', lat: 36.9, lon: -76.3 },
  { name: 'Chicago US', lat: 41.88, lon: -87.63 },
  // Land-border points: FRONTIER_CROSSING cannot verify at coastal/inland cities.
  { name: 'Aachen DE/NL/BE', lat: 50.77, lon: 6.08 },
  { name: 'Basel CH/DE/FR', lat: 47.56, lon: 7.59 },
  { name: 'Kehl/Strasbourg DE/FR', lat: 48.57, lon: 7.81 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tomtom(path, params, { retries = 3 } = {}) {
  const url = new URL(`https://api.tomtom.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('key', config.tomtomKey);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 && attempt < retries) {
      await sleep(700 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 120);
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json();
  }
}

/** Normalise a category name into the shape a classification code tends to take. */
const normalise = (s) =>
  String(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

async function main() {
  console.log(`${C.bold}POI category verification${C.reset}`);
  if (!config.tomtomKey) {
    bad('TOMTOM_API_KEY is not set — cannot verify.');
    process.exitCode = 1;
    return;
  }

  /* ---------------------------------------------- 1. fetch the category list */
  console.log(`\n${C.bold}${C.cyan}── 1. poi-categories endpoint${C.reset}`);
  const catJson = await tomtom('/search/2/poiCategories.json', { language: 'en-GB' });
  const categories = catJson.poiCategories || [];
  ok(`${categories.length} categories returned`);
  info('note: this endpoint returns id + name only — it does NOT publish classification codes,');
  info('which is why each id must be proven empirically below.');

  const byNormalisedName = new Map();
  for (const c of categories) {
    byNormalisedName.set(normalise(c.name), c);
  }

  /* ------------------------------------- 2. resolve + PROVE each layer code */
  console.log(`\n${C.bold}${C.cyan}── 2. resolve and prove each allowlisted code${C.reset}`);

  const verified = {};
  const dropped = [];
  const proofs = {};

  /** Probe a numeric id until some point returns results; report codes AND ids seen. */
  async function proveId(id) {
    for (const p of PROBE_POINTS) {
      let json;
      try {
        json = await tomtom('/search/2/nearbySearch/.json', {
          lat: p.lat,
          lon: p.lon,
          radius: 50000,
          categorySet: id,
          limit: 20,
        });
      } catch (err) {
        info(`probe ${p.name} failed: ${err.message}`);
        await sleep(250);
        continue;
      }
      await sleep(250);
      const codes = new Set();
      const ids = new Set();
      let withoutIds = 0;
      for (const r of json.results || []) {
        for (const cl of r.poi?.classifications || []) if (cl.code) codes.add(cl.code);
        const rowIds = (r.poi?.categorySet || []).map((c) => c.id);
        if (!rowIds.length) withoutIds++;
        for (const i of rowIds) ids.add(i);
      }
      if (codes.size)
        return {
          codes: [...codes],
          ids: [...ids],
          withoutIds,
          at: p.name,
          count: (json.results || []).length,
        };
    }
    return null;
  }

  for (const layer of POI_LAYERS) {
    console.log(`\n  ${C.bold}${layer.id}${C.reset}`);

    // Commercial resolves from the live list rather than hard-coded codes, per spec.
    let wantedCodes = layer.codes;
    if (layer.resolveAtBuild) {
      const found = [];
      for (const term of layer.resolveAtBuild) {
        const match = categories.find((c) => normalise(c.name) === normalise(term));
        if (match) {
          found.push(normalise(match.name));
          info(`resolved "${term}" → ${match.name} (id ${match.id})`);
        } else {
          warn(`could not resolve "${term}" from the category list`);
        }
      }
      wantedCodes = found;
    }

    const entries = [];

    /*
     * Layers that assert on the returned category id rather than the classification
     * code (see the military layer's note). Verified by proving that every result
     * carries the id we queried — if any result lacked it, the assertion would be
     * unenforceable and the layer must not ship.
     */
    if (layer.assertBy === 'categoryId') {
      let allProven = true;
      for (const id of layer.categoryIds || []) {
        const proof = await proveId(id);
        if (!proof) {
          bad(`id ${id} returned no results at any probe point → DROPPED`);
          dropped.push({ layer: layer.id, code: `id:${id}`, reason: 'no results at any probe point' });
          allProven = false;
          continue;
        }
        if (proof.withoutIds > 0 || !proof.ids.includes(id)) {
          bad(
            `id ${id} cannot be asserted: ${proof.withoutIds} result(s) carried no categorySet → DROPPED`,
          );
          dropped.push({ layer: layer.id, code: `id:${id}`, reason: 'results lack categorySet ids' });
          allProven = false;
          continue;
        }
        ok(
          `id ${id} — every result carries categorySet ${id} (proven at ${proof.at}); ` +
            `reports code ${proof.codes.join('/')}`,
        );
        entries.push({ code: proof.codes[0], id, name: `(id-asserted ${id})` });
      }
      verified[layer.id] = {
        label: layer.label,
        color: layer.color,
        glyph: layer.glyph,
        defaultOn: Boolean(layer.defaultOn),
        lowerConfidence: Boolean(layer.lowerConfidence),
        caveat: layer.caveat || null,
        assertBy: 'categoryId',
        categorySet: entries.map((e) => e.id),
        allowedCategoryIds: entries.map((e) => e.id),
        allowedCodes: [...new Set(entries.map((e) => e.code))],
        resolved: entries,
        hasSource: entries.length > 0 && allProven,
      };
      if (!verified[layer.id].hasSource) {
        warn(`${layer.id} could not be verified → will render "no data source connected"`);
      }
      continue;
    }

    for (const code of wantedCodes) {
      const hints = layer.nameHints?.[code] || [];
      // Candidate ids: explicit name hints first, then the code read as a name.
      const candidates = [];
      for (const h of hints) {
        const c = byNormalisedName.get(normalise(h));
        if (c) candidates.push(c);
      }
      const direct = byNormalisedName.get(code);
      if (direct && !candidates.some((c) => c.id === direct.id)) candidates.push(direct);
      // Some codes differ from the category name (e.g. HOTEL → HOTEL_MOTEL).
      const alias = layer.codeAliases?.[code];

      if (!candidates.length) {
        bad(`${code} — no matching category in the endpoint output → DROPPED`);
        dropped.push({ layer: layer.id, code, reason: 'no matching category name' });
        continue;
      }

      let proven = false;
      for (const cand of candidates) {
        const proof = await proveId(cand.id);
        if (!proof) {
          warn(`${code} → id ${cand.id} ("${cand.name}") returned no results at any probe point`);
          continue;
        }
        if (proof.codes.includes(code) || (alias && proof.codes.includes(alias))) {
          const accepted = proof.codes.includes(code) ? code : alias;
          ok(`${accepted} → id ${cand.id} ("${cand.name}") — proven at ${proof.at}`);
          entries.push({ code: accepted, id: cand.id, name: cand.name });
          proofs[accepted] = { id: cand.id, provenAt: proof.at, codesSeen: proof.codes };
          proven = true;
          break;
        }
        // The id works but reports a different code. That is a spec mismatch, and
        // guessing would reintroduce exactly the false positives this replaces.
        bad(
          `${code} → id ${cand.id} ("${cand.name}") returns ${proof.codes.join('/')} instead → DROPPED`,
        );
        dropped.push({
          layer: layer.id,
          code,
          reason: `id ${cand.id} reports ${proof.codes.join('/')}`,
          actualCodes: proof.codes,
        });
      }
      if (!proven && !dropped.some((d) => d.layer === layer.id && d.code === code)) {
        dropped.push({ layer: layer.id, code, reason: 'no results at any probe point' });
      }
    }

    // extraIds: specific category ids whose results must still classify inside the
    // layer's allowlist. Used where several ids share one coarse code.
    for (const id of layer.extraIds || []) {
      if (entries.some((e) => e.id === id)) continue;
      const proof = await proveId(id);
      if (!proof) {
        warn(`extra id ${id} returned no results at any probe point`);
        continue;
      }
      const allowed = proof.codes.find((c) => wantedCodes.includes(c));
      if (allowed) {
        ok(`extra id ${id} — classifies as ${allowed}, inside allowlist`);
        entries.push({ code: allowed, id, name: `(extra id ${id})` });
      } else {
        bad(`extra id ${id} returns ${proof.codes.join('/')} — outside allowlist → DROPPED`);
        dropped.push({ layer: layer.id, code: `id:${id}`, reason: `reports ${proof.codes.join('/')}` });
      }
    }

    verified[layer.id] = {
      label: layer.label,
      color: layer.color,
      glyph: layer.glyph,
      defaultOn: Boolean(layer.defaultOn),
      lowerConfidence: Boolean(layer.lowerConfidence),
      caveat: layer.caveat || null,
      // Only these are ever sent to the API, and only these are accepted back.
      categorySet: entries.map((e) => e.id),
      allowedCodes: entries.map((e) => e.code),
      resolved: entries,
      hasSource: entries.length > 0,
    };

    if (!entries.length) {
      warn(`${layer.id} has NO verified codes → will render "no data source connected"`);
    }
  }

  /* ------------------------------------------------- 3. no-source layers */
  console.log(`\n${C.bold}${C.cyan}── 3. layers with no TomTom source (never queried)${C.reset}`);
  const noSource = {};
  for (const l of NO_SOURCE_LAYERS) {
    noSource[l.id] = { label: l.label, color: l.color, glyph: l.glyph, reason: l.reason };
    info(`${l.id} — ${l.label}`);
  }

  /* ------------------------------------------------------------ 4. write */
  const report = {
    generatedAt: new Date().toISOString(),
    note:
      'Generated by npm run verify:pois. The runtime queries ONLY categorySet ids listed here, ' +
      'and accepts ONLY allowedCodes back. `poiCategories` is not a real TomTom parameter — it is ' +
      'silently ignored by the API, so it is never used.',
    layers: verified,
    noSourceLayers: noSource,
    dropped,
    proofs,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));

  /* ----------------------------------------------------------- 5. summary */
  console.log(`\n${C.bold}${C.cyan}══ Summary ══${C.reset}\n`);
  const withSource = Object.entries(verified).filter(([, v]) => v.hasSource);
  const without = Object.entries(verified).filter(([, v]) => !v.hasSource);

  for (const [id, v] of withSource) {
    console.log(
      `   ${C.green}${id.padEnd(24)}${C.reset} ${String(v.categorySet.length).padStart(2)} id(s)  ${v.allowedCodes.join(', ')}`,
    );
  }
  for (const [id] of without) {
    console.log(`   ${C.yellow}${id.padEnd(24)}${C.reset} no verified codes → no data source`);
  }
  console.log(`   ${C.dim}${Object.keys(noSource).length} declared no-source layers${C.reset}`);

  if (dropped.length) {
    console.log(`\n${C.bold}Dropped codes (never substituted with a text search)${C.reset}`);
    for (const d of dropped) console.log(`   ${C.red}✗${C.reset} ${d.layer}.${d.code} — ${d.reason}`);
  }

  console.log(`\n${C.dim}→ ${OUT_FILE}${C.reset}`);
  process.exitCode = withSource.length ? 0 : 1;
}

main().catch((err) => {
  bad(`Verification failed: ${err.message}`);
  console.error(err);
  process.exitCode = 1;
});
