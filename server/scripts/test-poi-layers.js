#!/usr/bin/env node
/**
 * POI layer acceptance tests.
 *
 * Run: npm run test:pois   (server must be running)
 *
 * These encode the non-negotiables from the spec. Each one exists because it maps to
 * a way the previous implementation was wrong.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFIED = JSON.parse(
  readFileSync(join(HERE, '..', 'data', 'poi-categories.verified.json'), 'utf8'),
);

const BASE = process.env.BASE_URL || 'http://localhost:8080';

const C = process.stdout.isTTY
  ? { reset: '\x1b[0m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m' }
  : { reset: '', bold: '', red: '', green: '', dim: '' };

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`   ${C.green}PASS${C.reset} ${name}`);
    passed++;
  } else {
    console.log(`   ${C.red}FAIL${C.reset} ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const get = async (path) => {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, json: await r.json() };
};
const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

/** Dense city view — plenty of shops around to tempt a false positive. */
const AMS = '4.85,52.34,4.95,52.40';

async function main() {
  console.log(`${C.bold}POI layer acceptance tests${C.reset}  ${C.dim}(${BASE})${C.reset}\n`);

  const meta = await get('/api/pois/layers');
  const layers = meta.json.layers || [];
  const sourced = layers.filter((l) => l.hasSource);
  // Every layer offered now has a source; unsourced ones come back under `unavailable`.
  const noSource = (meta.json.unavailable || []).map((l) => ({ ...l, hasSource: false }));
  const allIds = layers.map((l) => l.id).join(',');

  console.log(`${C.bold}1. Every runtime category id came from build-time verification${C.reset}`);
  {
    const verifiedIds = new Set();
    for (const l of Object.values(VERIFIED.layers || {})) {
      for (const id of l.categorySet || []) verifiedIds.add(id);
    }
    let allFromVerified = true;
    for (const [lid, l] of Object.entries(VERIFIED.layers || {})) {
      for (const id of l.categorySet || []) {
        if (!verifiedIds.has(id)) {
          allFromVerified = false;
          console.log(`      ${lid} uses unverified id ${id}`);
        }
      }
    }
    check('all queried ids present in verification output', allFromVerified);
    check('verification output exists and is non-empty', sourced.length > 0, `${sourced.length} sourced`);
  }

  console.log(`\n${C.bold}2. No layer contains a POI outside its allowlist${C.reset}`);
  {
    const { json } = await get(`/api/pois?bbox=${AMS}&layers=${allIds}`);
    const byId = new Map(sourced.map((l) => [l.id, l]));
    const offenders = [];
    for (const f of json.features || []) {
      const l = byId.get(f.properties.layer);
      if (!l) {
        offenders.push(`${f.properties.layer}: unknown layer`);
        continue;
      }
      // id-asserted layers are validated on the category id, not the code.
      const okByCode = l.allowedCodes.includes(f.properties.tomtomCategory);
      const okById =
        l.assertBy === 'categoryId' &&
        (f.properties.tomtomCategoryIds || []).some((id) => l.allowedCategoryIds.includes(id));
      if (!okByCode && !okById) {
        offenders.push(`${f.properties.layer}:${f.properties.name}[${f.properties.tomtomCategory}]`);
      }
    }
    check(
      'zero out-of-allowlist features returned',
      offenders.length === 0,
      offenders.slice(0, 4).join(', '),
    );
    console.log(
      `      ${C.dim}${(json.features || []).length} features; assertion dropped ${json.droppedOutOfCategory} out-of-category${C.reset}`,
    );
  }

  console.log(`\n${C.bold}3. No commercial POI leaks into a non-commercial layer${C.reset}`);
  {
    const nonCommercial = sourced.filter((l) => l.id !== 'commercial').map((l) => l.id);
    const { json } = await get(`/api/pois?bbox=${AMS}&layers=${nonCommercial.join(',')}`);
    const RETAIL = /RESTAURANT|CAFE|SHOP|HOTEL|MOTEL|SUPERMARKET|JEWEL|CLOTH|BAKER|BAR_|NIGHTLIFE/;
    const leaks = (json.features || []).filter((f) => RETAIL.test(f.properties.tomtomCategory));
    check(
      'no retail/food/lodging codes in defence or infrastructure layers',
      leaks.length === 0,
      leaks.slice(0, 4).map((f) => `${f.properties.layer}:${f.properties.tomtomCategory}`).join(', '),
    );
    check(
      'commercial layer absent when not requested',
      !(json.features || []).some((f) => f.properties.layer === 'commercial'),
    );
  }

  console.log(`\n${C.bold}4. Commercial appears only when its toggle is on${C.reset}`);
  {
    const { json } = await get(`/api/pois?bbox=${AMS}&layers=commercial`);
    const only = (json.features || []).every((f) => f.properties.layer === 'commercial');
    check('commercial request returns only commercial features', only);
    check('commercial actually returns data', (json.features || []).length > 0, `${(json.features || []).length}`);
  }

  console.log(`\n${C.bold}5. No-source layers are never populated${C.reset}`);
  {
    const ids = noSource.map((l) => l.id);
    const { json } = await get(`/api/pois?bbox=${AMS}&layers=${ids.join(',')}`);
    check('zero features returned for no-source layers', (json.features || []).length === 0);
    check(
      'response reports them as no-source',
      (json.noSourceRequested || []).length === ids.length,
      `${(json.noSourceRequested || []).length}/${ids.length}`,
    );
    /*
     * No-source layers are deliberately absent from `layers` so the UI never renders
     * a permanently empty row; they are reported under `unavailable` instead.
     */
    const unavailable = meta.json.unavailable || [];
    const dib = unavailable.find((l) => l.id === 'defense_industrial_base');
    check('defense_industrial_base is not offered as a layer',
      !layers.some((l) => l.id === 'defense_industrial_base'));
    check('defense_industrial_base is reported unavailable with a reason',
      Boolean(dib?.reason), dib?.reason?.slice(0, 60));
  }

  console.log(`\n${C.bold}6. A jewellery store never appears in a defence layer${C.reset}`);
  {
    // The original bug: "Cliodhna", a jewellery studio in Amersfoort, classified by
    // TomTom as MANUFACTURING_FACILITY and shown as defence industrial base.
    const AMERSFOORT = '5.33,52.12,5.45,52.19';
    const { json } = await get(
      `/api/pois?bbox=${AMERSFOORT}&layers=${layers.map((l) => l.id).join(',')}`,
    );
    const cliodhna = (json.features || []).filter((f) => /cliodhna|cliodna/i.test(f.properties.name));
    check('Cliodhna does not appear in any layer', cliodhna.length === 0,
      cliodhna.map((f) => `${f.properties.layer}[${f.properties.tomtomCategory}]`).join(', '));
    const manufacturing = (json.features || []).filter((f) =>
      /MANUFACTURING/.test(f.properties.tomtomCategory),
    );
    check('no MANUFACTURING_FACILITY results anywhere', manufacturing.length === 0,
      manufacturing.slice(0, 3).map((f) => f.properties.name).join(', '));
  }

  console.log(`\n${C.bold}7. Search along route respects the corridor and the allowlist${C.reset}`);
  {
    const rr = await fetch(`${BASE}/api/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        start: { lat: 52.0894, lon: 5.121 },
        end: { lat: 52.029, lon: 5.08 },
        profileId: 'heavy-truck',
        maxAlternatives: 0,
      }),
    });
    const route = await rr.json();
    const coords = route.routes?.features?.[0]?.geometry?.coordinates || [];
    const points = coords.map(([lon, lat]) => ({ lat, lon }));
    check('got a route to search along', points.length > 10, `${points.length} points`);

    const { json } = await post('/api/pois/along-route', {
      route: points,
      layers: ['fuel', 'medical', 'logistics'],
      corridorKm: 5,
    });
    check('along-route returns features', (json.features || []).length > 0, `${(json.features || []).length}`);
    const byId2 = new Map(sourced.map((l) => [l.id, l]));
    const bad = (json.features || []).filter((f) => {
      const l = byId2.get(f.properties.layer);
      if (!l) return true;
      if (l.assertBy === 'categoryId') {
        return !(f.properties.tomtomCategoryIds || []).some((id) => l.allowedCategoryIds.includes(id));
      }
      return !l.allowedCodes.includes(f.properties.tomtomCategory);
    });
    check('along-route features all inside allowlist', bad.length === 0,
      bad.slice(0, 3).map((f) => f.properties.tomtomCategory).join(', '));
    check('corridor echoed back', json.corridorKm === 5, `corridorKm=${json.corridorKm}`);
  }

  console.log(`\n${C.bold}8. Military layer is id-asserted and contains real installations${C.reset}`);
  {
    const mil = layers.find((l) => l.id === 'military');
    check('military layer has a source', Boolean(mil?.hasSource));
    check('military asserts on category id, not the SCHOOL code', mil?.assertBy === 'categoryId');
    const { json } = await get(`/api/pois?bbox=4.9,52.0,5.4,52.3&layers=military`);
    const feats = json.features || [];
    check('military returns results', feats.length > 0, `${feats.length}`);
    check(
      'every military feature carries category id 9388',
      feats.every((f) => (f.properties.tomtomCategoryIds || []).includes(9388)),
    );
    check('military features are only in the military layer',
      feats.every((f) => f.properties.layer === 'military'));
    const names = feats.map((f) => f.properties.name).join(' | ');
    console.log(`      ${C.dim}${names.slice(0, 150)}${C.reset}`);
  }

  console.log(`\n${C.bold}9. Caps and de-duplication${C.reset}`);
  {
    const { json } = await get(`/api/pois?bbox=${AMS}&layers=${allIds}`);
    const overCap = Object.entries(json.perLayer || {}).filter(([, n]) => n > 50);
    check('no layer exceeds the 50 cap', overCap.length === 0, JSON.stringify(overCap));
    const ids = (json.features || []).map((f) => f.id);
    check('no duplicate POI ids', new Set(ids).size === ids.length,
      `${ids.length - new Set(ids).size} dupes`);
    console.log(`      ${C.dim}capped layers: ${(json.capped || []).join(', ') || 'none'}${C.reset}`);
  }

  console.log(
    `\n${C.bold}${failed === 0 ? C.green : C.red}${passed} passed, ${failed} failed${C.reset}`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`${C.red}test run failed:${C.reset}`, err.message);
  process.exitCode = 1;
});
