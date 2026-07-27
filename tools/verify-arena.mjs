#!/usr/bin/env node
/**
 * verify-arena — the offline gate for the FPS Arena layer.
 *
 * The base repo already ships tools/verify.mjs, which drives a real browser and
 * compares captured frames. That needs `npm install` and a GPU. This gate is
 * deliberately the opposite: pure node, no dependencies, no network, so it can
 * run after every step of PLAN.md and in CI before the heavy checks.
 *
 *   node tools/verify-arena.mjs            all three tiers
 *   node tools/verify-arena.mjs --syntax   parse every source file
 *   node tools/verify-arena.mjs --contract architecture invariants
 *   node tools/verify-arena.mjs --unit     arsenal data and logic
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** Subsystem folders added by this project (as opposed to the base engine). */
const NEW_DIRS = ['arsenal', 'modes', 'net', 'shell'];

/* ------------------------------------------------------------------ harness */

let passed = 0;
let fileLevel = 0;
const failures = [];
let current = '(none)';
const collapsed = new Set(['syntax', 'import graph']);

function group(name, fn) {
  current = name;
  const before = passed;
  const failedBefore = failures.length;
  try {
    fn();
  } catch (err) {
    failures.push({ group: name, check: '(threw)', message: err.message });
  }
  const count = passed - before;
  const ok = failures.length === failedBefore;
  const mark = ok ? 'ok  ' : 'FAIL';
  if (collapsed.has(name)) {
    fileLevel += count;
    console.log(`  ${mark} ${name} — ${count} files`);
  } else {
    console.log(`  ${mark} ${name} — ${count} checks`);
  }
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ group: current, check: name, message: err.message });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function near(actual, expected, eps, what) {
  assert(
    Math.abs(actual - expected) <= eps,
    `${what}: expected ${expected} +/- ${eps}, got ${actual}`,
  );
}

/* -------------------------------------------------------------------- files */

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const sourceFiles = [...walk(SRC), ...walk(join(ROOT, 'tools'))];

/* -------------------------------------------------------------- tier: syntax */

function tierSyntax() {
  group('syntax', () => {
    for (const file of sourceFiles) {
      check(relative(ROOT, file), () => {
        // `node --check` honours package.json "type": "module", so top-level
        // await and ESM syntax parse correctly. A hand-rolled regex checker
        // reported fifteen false failures here before this was fixed.
        try {
          execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        } catch (err) {
          const out = (err.stderr?.toString() || err.message).split('\n').slice(0, 4).join(' ');
          throw new Error(out.trim());
        }
      });
    }
  });
}

/* ------------------------------------------------------------ tier: contract */

function readSource(file) {
  return readFileSync(file, 'utf8');
}

function importsOf(text) {
  const out = [];
  const re = /(?:import|export)[^;'"]*?from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(text))) out.push(m[1]);
  return out;
}

function tierContract() {
  const texts = new Map(sourceFiles.map((f) => [f, readSource(f)]));

  group('import graph', () => {
    for (const [file, text] of texts) {
      check(relative(ROOT, file), () => {
        for (const spec of importsOf(text)) {
          if (!spec.startsWith('.')) continue; // bare specifier: npm's problem
          const base = resolve(dirname(file), spec);
          const candidates = [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js')];
          assert(
            candidates.some((p) => existsSync(p)),
            `unresolved import "${spec}"`,
          );
        }
      });
    }
  });

  group('subsystem ids', () => {
    const ids = new Map();
    for (const [file, text] of texts) {
      const m = text.match(/static\s+id\s*=\s*['"]([a-z0-9_]+)['"]/);
      if (!m) continue;
      check(`id "${m[1]}" is unique`, () => {
        assert(!ids.has(m[1]), `duplicate subsystem id "${m[1]}" in ${relative(ROOT, file)} and ${ids.get(m[1])}`);
      });
      ids.set(m[1], relative(ROOT, file));
    }
    check('the base subsystem set is intact', () => {
      assert(ids.size >= 11, `found only ${ids.size} subsystem ids`);
    });
  });

  group('determinism', () => {
    const newFiles = [...texts].filter(([f]) =>
      NEW_DIRS.some((d) => f.includes(join('src', d))),
    );
    check('no Math.random in new gameplay code', () => {
      for (const [file, text] of newFiles) {
        assert(
          !/Math\.random\s*\(/.test(text),
          `${relative(ROOT, file)} uses Math.random — use ctx.rng so replays stay deterministic`,
        );
      }
    });
    check('the data layer stays free of three.js', () => {
      for (const [file, text] of newFiles) {
        if (!/arsenal[\\/](defs|attachments)\.js$/.test(file)) continue;
        assert(
          !/from\s*['"]three['"]/.test(text),
          `${relative(ROOT, file)} imports three — this layer must stay node-testable`,
        );
      }
    });
  });
}

/* ---------------------------------------------------------------- tier: unit */

async function tierUnit() {
  const defsMod = await import(pathToFileURL(join(SRC, 'arsenal', 'defs.js')).href);
  const attMod = await import(pathToFileURL(join(SRC, 'arsenal', 'attachments.js')).href);

  const { ARSENAL_DEFS, ARSENAL_ORDER, SLOTS, weaponsInSlot, cycleTime, damageAt } = defsMod;
  const {
    ATTACHMENTS, SLOT_ORDER, BY_SLOT, canMount, defaultLoadout, resolveStats,
    nextOptic, statDelta,
  } = attMod;

  group('arsenal roster', () => {
    check('nine weapons, order matches the table', () => {
      assert(ARSENAL_ORDER.length === 9, `expected 9 weapons, got ${ARSENAL_ORDER.length}`);
      for (const id of ARSENAL_ORDER) assert(ARSENAL_DEFS[id], `${id} is in the order but not the table`);
      for (const id of Object.keys(ARSENAL_DEFS)) assert(ARSENAL_ORDER.includes(id), `${id} is missing from the order`);
    });
  });

  for (const id of ARSENAL_ORDER) {
    const def = ARSENAL_DEFS[id];
    group(`weapon: ${id}`, () => {
      check('identity fields', () => {
        assert(def.id === id, 'id mismatch');
        assert(typeof def.label === 'string' && def.label.length, 'missing label');
        assert(SLOTS.includes(def.slot), `bad slot "${def.slot}"`);
      });
      check('cadence is sane', () => {
        assert(def.rpm >= 60 && def.rpm <= 1300, `rpm ${def.rpm} out of range`);
        assert(def.modes.length >= 1, 'no fire modes');
      });
      check('ammunition', () => {
        assert(def.magSize >= 1, 'magazine is empty');
        assert(def.reserve >= def.magSize, 'reserve smaller than one magazine');
      });
      check('ballistics', () => {
        assert(def.muzzleVelocity > 100, 'muzzle velocity too low');
        assert(def.maxRange > 20, 'max range too low');
        assert(def.dropoff > 0 && def.dropoff <= 2, `dropoff ${def.dropoff} out of range`);
      });
      check('damage', () => {
        assert(def.damage > 0, 'no damage');
        const shotsToKill = def.pellets
          ? Math.ceil(100 / (def.damage * def.pellets))
          : Math.ceil(100 / def.damage);
        assert(shotsToKill >= 1 && shotsToKill <= 7, `${shotsToKill} shots to kill is off the scale`);
      });
      check('spread cone', () => {
        assert(def.spreadAds < def.spreadHip, 'aiming must be tighter than hipfire');
        assert(def.spreadMax >= def.spreadHip, 'spread ceiling below the hip cone');
      });
      check('recoil block', () => {
        const r = def.recoil;
        for (const key of ['pitch', 'yaw', 'kickBack', 'freq', 'damping', 'patternSeed']) {
          assert(typeof r[key] === 'number', `recoil.${key} missing`);
        }
        assert(r.pitch > r.yaw, 'vertical recoil should dominate');
        assert(r.patternLength >= 1, 'empty recoil pattern');
      });
      check('handling times', () => {
        assert(def.adsTime > 0.1 && def.adsTime < 0.6, `ads ${def.adsTime}s out of range`);
        assert(def.reloadEmpty >= def.reloadTac, 'empty reload must not be faster than tactical');
        assert(def.drawTime > def.holsterTime, 'draw should be slower than holster');
      });
      check('pose block', () => {
        for (const key of ['hipPos', 'hipRot', 'sprintPos', 'sprintRot', 'lowReadyPos', 'lowReadyRot']) {
          assert(Array.isArray(def[key]) && def[key].length === 3, `${key} must be a 3-vector`);
        }
        assert(def.eyeRelief > 0, 'eye relief must be positive');
        assert(def.hipPos[2] < 0, 'the weapon must sit in front of the camera');
      });
      check('mount points', () => {
        assert(Array.isArray(def.mounts) && def.mounts.length >= 1, 'no mount points');
        for (const slot of def.mounts) assert(SLOT_ORDER.includes(slot), `unknown mount "${slot}"`);
      });
    });
  }

  group('ported values', () => {
    // These must match FPS Arena's WEAPON_STATS exactly; they are the numbers
    // the game was balanced around.
    const table = {
      akm: { magSize: 30, muzzleVelocity: 715, muzzleEnergy: 2010, weight: 3.6, adsTime: 0.32, zeroDist: 100 },
      ak74: { magSize: 30, muzzleVelocity: 900, muzzleEnergy: 1390, weight: 3.3, adsTime: 0.3, zeroDist: 100 },
      m416: { magSize: 30, muzzleVelocity: 880, muzzleEnergy: 1796, weight: 3.4, adsTime: 0.27, zeroDist: 100 },
      scar: { magSize: 20, muzzleVelocity: 870, muzzleEnergy: 3400, weight: 3.8, adsTime: 0.34, zeroDist: 100 },
      svd: { magSize: 10, muzzleVelocity: 830, muzzleEnergy: 4090, weight: 4.3, adsTime: 0.42, zeroDist: 300 },
      mp5: { magSize: 30, muzzleVelocity: 400, muzzleEnergy: 620, weight: 2.5, adsTime: 0.22, zeroDist: 50 },
      m870: { magSize: 6, muzzleVelocity: 400, muzzleEnergy: 700, weight: 3.6, adsTime: 0.3, zeroDist: 20 },
      glock18: { magSize: 17, muzzleVelocity: 375, muzzleEnergy: 520, weight: 0.9, adsTime: 0.15, zeroDist: 25 },
      deagle: { magSize: 9, muzzleVelocity: 470, muzzleEnergy: 1900, weight: 2.0, adsTime: 0.22, zeroDist: 35 },
    };
    for (const [id, want] of Object.entries(table)) {
      check(`${id} keeps its FPS Arena numbers`, () => {
        const def = ARSENAL_DEFS[id];
        for (const [key, value] of Object.entries(want)) near(def[key], value, 1e-6, `${id}.${key}`);
      });
    }
    check('cadence round-trips from seconds per shot', () => {
      near(cycleTime(ARSENAL_DEFS.akm, 'auto'), 0.1, 1e-3, 'akm cycle');
      near(cycleTime(ARSENAL_DEFS.m416, 'auto'), 0.085, 1e-3, 'm416 cycle');
      near(cycleTime(ARSENAL_DEFS.svd, 'semi'), 0.34, 1e-3, 'svd cycle');
    });
    check('the Glock auto sear is faster than its semi cadence', () => {
      assert(cycleTime(ARSENAL_DEFS.glock18, 'auto') < cycleTime(ARSENAL_DEFS.glock18, 'semi'), 'sear did nothing');
    });
    check('relative lethality is preserved', () => {
      const d = (id) => ARSENAL_DEFS[id].damage;
      assert(d('svd') > d('deagle'), 'SVD must out-hit a Desert Eagle');
      assert(d('scar') > d('akm'), 'SCAR-H must out-hit an AKM');
      assert(d('akm') > d('ak74'), 'AKM must out-hit an AK-74');
      assert(d('ak74') > d('m416'), 'AK-74 must out-hit an M416');
      assert(d('m416') > d('mp5'), 'M416 must out-hit an MP5');
    });
    check('the shotgun kills at contact range', () => {
      const m870 = ARSENAL_DEFS.m870;
      assert(m870.damage * m870.pellets >= 100, 'full shotgun load should be lethal up close');
      assert(damageAt(m870, 45) * m870.pellets < 100, 'shotgun should not one-shot across the map');
    });
    check('damage falls off with distance', () => {
      const akm = ARSENAL_DEFS.akm;
      assert(damageAt(akm, 0) > damageAt(akm, 200), 'no dropoff');
      assert(damageAt(akm, 5000) > 0, 'damage must never reach zero');
    });
    check('carry slots cover the FPS Arena 1/2/3 keys', () => {
      for (const slot of SLOTS) assert(weaponsInSlot(slot).length >= 2, `slot ${slot} has too few weapons`);
    });
  });

  group('attachment catalog', () => {
    check('every entry declares a known slot', () => {
      for (const [id, att] of Object.entries(ATTACHMENTS)) {
        assert(att.id === id, `${id}: id mismatch`);
        assert(SLOT_ORDER.includes(att.slot), `${id}: unknown slot`);
        assert(typeof att.label === 'string' && att.label.length, `${id}: missing label`);
        assert(typeof att.mass === 'number', `${id}: missing mass`);
      }
    });
    check('every slot offers at least two choices', () => {
      for (const slot of SLOT_ORDER) assert(BY_SLOT[slot].length >= 2, `slot ${slot} is nearly empty`);
    });
    check('all four FPS Arena sight tiers exist', () => {
      for (const id of ['iron', 'reddot', 'holo', 'scope3x']) assert(ATTACHMENTS[id], `missing sight ${id}`);
    });
    check('magnification increases across the tiers', () => {
      const z = (id) => ATTACHMENTS[id].zoom;
      assert(z('reddot') > z('holo'), 'holo should show more magnification than a red dot');
      assert(z('holo') > z('scope3x'), '3x should magnify more than a holo');
      assert(z('scope3x') > z('pso4x'), 'PSO-1 should magnify more than the 3x');
    });
    check('irons and the standard magazine are not removable', () => {
      assert(ATTACHMENTS.iron.detachable === false, 'irons must stay');
      assert(ATTACHMENTS.magStandard.detachable === false, 'the standard mag must stay');
    });
  });

  group('compatibility', () => {
    check('the PSO-1 only fits AK-pattern rifles and the SVD', () => {
      assert(canMount(ARSENAL_DEFS.akm, 'pso4x').ok, 'PSO should fit an AKM');
      assert(canMount(ARSENAL_DEFS.svd, 'pso4x').ok, 'PSO should fit an SVD');
      assert(!canMount(ARSENAL_DEFS.m416, 'pso4x').ok, 'PSO should not fit an M416');
    });
    check('pistols take no underbarrel hardware', () => {
      assert(!canMount(ARSENAL_DEFS.glock18, 'foregrip').ok, 'a Glock cannot take a foregrip');
      assert(!canMount(ARSENAL_DEFS.deagle, 'bipod').ok, 'a Desert Eagle cannot take a bipod');
    });
    check('the SVD takes a bipod', () => {
      assert(canMount(ARSENAL_DEFS.svd, 'bipod').ok, 'SVD should take a bipod');
    });
    check('the pump shotgun has no detachable magazine', () => {
      assert(!canMount(ARSENAL_DEFS.m870, 'magExtended').ok, 'the M870 is tube-fed');
    });
    check('rejections come with a readable reason', () => {
      const r = canMount(ARSENAL_DEFS.m416, 'pso4x');
      assert(typeof r.reason === 'string' && r.reason.length > 4, 'missing reason');
    });
  });

  group('stat resolution', () => {
    const akm = ARSENAL_DEFS.akm;

    check('the default loadout resolves to the bare weapon', () => {
      const s = resolveStats(akm, defaultLoadout(akm));
      near(s.damage, akm.damage, 1e-9, 'damage');
      near(s.magSize, akm.magSize, 1e-9, 'magSize');
      assert(s.rejected.length === 0, `unexpected rejections: ${JSON.stringify(s.rejected)}`);
    });
    check('the SVD starts on its PSO-1', () => {
      assert(defaultLoadout(ARSENAL_DEFS.svd).optic === 'pso4x', 'SVD should come with the PSO-1');
    });
    check('resolveStats does not mutate the definition', () => {
      const before = JSON.stringify(akm);
      resolveStats(akm, { optic: 'scope3x', muzzle: 'suppressor', magazine: 'magExtended' });
      assert(JSON.stringify(akm) === before, 'the weapon definition was mutated');
    });
    check('a suppressor trades velocity and damage for silence', () => {
      const s = resolveStats(akm, { muzzle: 'suppressor' });
      assert(s.silent === true, 'not silent');
      assert(s.muzzleVelocity < akm.muzzleVelocity, 'velocity unchanged');
      assert(s.damage < akm.damage, 'damage unchanged');
      assert(s.flashScale < 0.2, 'flash not suppressed');
    });
    check('a brake tames vertical recoil', () => {
      const s = resolveStats(akm, { muzzle: 'brake' });
      assert(s.recoilPitch < akm.recoil.pitch, 'brake did nothing');
      assert(s.loudness > 1, 'a brake should be louder');
    });
    check('a compensator tames horizontal recoil more than a brake', () => {
      const brake = resolveStats(akm, { muzzle: 'brake' });
      const comp = resolveStats(akm, { muzzle: 'comp' });
      assert(comp.recoilYaw < brake.recoilYaw, 'the compensator should win on yaw');
    });
    check('an extended magazine costs reload speed', () => {
      const s = resolveStats(akm, { magazine: 'magExtended' });
      assert(s.magSize === 42, `expected 42 rounds, got ${s.magSize}`);
      assert(s.reloadTac > akm.reloadTac, 'reload should be slower');
      assert(s.magLen > akm.magLen, 'the magazine should stick out further');
    });
    check('a quickdraw magazine is faster and keeps capacity', () => {
      const s = resolveStats(akm, { magazine: 'magQuick' });
      assert(s.reloadTac < akm.reloadTac, 'reload not faster');
      assert(s.magSize === akm.magSize, 'capacity changed');
    });
    check('optics set the ADS zoom and shift eye relief', () => {
      const s = resolveStats(akm, { optic: 'scope3x' });
      near(s.zoom, ATTACHMENTS.scope3x.zoom, 1e-9, 'zoom');
      near(s.relief, akm.eyeRelief + ATTACHMENTS.scope3x.relief, 1e-9, 'relief');
      assert(s.adsTime > akm.adsTime, 'a scope should aim slower');
    });
    check('the flashlight publishes a light description', () => {
      const s = resolveStats(akm, { tactical: 'flashlight' });
      assert(s.hasLight === true, 'no light');
      assert(s.light && s.light.angle > 0 && s.light.distance > 1, 'incomplete light block');
    });
    check('the laser tightens hipfire only while lit', () => {
      const on = resolveStats(akm, { tactical: 'laser' }, { laserOn: true });
      const off = resolveStats(akm, { tactical: 'laser' }, { laserOn: false });
      assert(on.hasLaser && off.hasLaser, 'laser not detected');
      near(on.spreadHip, akm.spreadHip * 0.72, 1e-9, 'lit hip spread');
      near(off.spreadHip, akm.spreadHip, 1e-9, 'unlit hip spread');
    });
    check('a deployed bipod steadies the rifle', () => {
      const up = resolveStats(ARSENAL_DEFS.svd, { underbarrel: 'bipod' }, { bipodDeployed: false });
      const down = resolveStats(ARSENAL_DEFS.svd, { underbarrel: 'bipod' }, { bipodDeployed: true });
      assert(down.recoilPitch < up.recoilPitch, 'deployed bipod did nothing');
      assert(down.spreadAds < up.spreadAds, 'deployed bipod should tighten the group');
    });
    check('attachments that do not fit are reported, not applied', () => {
      const s = resolveStats(ARSENAL_DEFS.m416, { optic: 'pso4x' });
      assert(s.rejected.length === 1, 'the PSO should have been rejected');
      near(s.zoom, ARSENAL_DEFS.m416.adsFov, 1e-9, 'zoom should be untouched');
    });
    check('mass accumulates and slows aiming', () => {
      const s = resolveStats(akm, { optic: 'pso4x', underbarrel: 'bipod', muzzle: 'suppressor' });
      assert(s.weight > akm.weight + 1.2, `expected a heavy rifle, got ${s.weight} kg`);
      assert(s.adsTime > akm.adsTime * 1.3, 'a loaded rifle should aim much slower');
    });
    check('the optic ring cycles and comes back to irons', () => {
      let optic = 'iron';
      const seen = new Set();
      for (let i = 0; i < 12; i += 1) {
        optic = nextOptic(akm, optic);
        seen.add(optic);
        if (optic === 'iron' && seen.size > 1) break;
      }
      assert(optic === 'iron', 'the ring never returned to irons');
      assert(seen.size >= 4, `the ring only visited ${seen.size} optics`);
    });
    check('locked optics are skipped', () => {
      const owned = new Set(['reddot']);
      const ring = new Set();
      let optic = 'iron';
      for (let i = 0; i < 6; i += 1) {
        optic = nextOptic(akm, optic, owned);
        ring.add(optic);
      }
      assert(!ring.has('scope3x'), 'an unowned optic was offered');
    });
    check('the board can describe a loadout as deltas', () => {
      const rows = statDelta(akm, { optic: 'scope3x', muzzle: 'suppressor', magazine: 'magExtended' });
      assert(rows.length >= 4, `expected several changed stats, got ${rows.length}`);
      for (const row of rows) {
        assert(typeof row.label === 'string' && row.label.length, 'missing label');
        assert(typeof row.better === 'boolean', 'missing direction');
        assert(row.from !== row.to, `${row.stat} listed but unchanged`);
      }
      const mag = rows.find((r) => r.stat === 'magSize');
      assert(mag && mag.better === true, 'more rounds should read as an improvement');
    });
  });
}

/* --------------------------------------------------------------------- main */

const args = process.argv.slice(2);
const want = (flag) => args.length === 0 || args.includes(flag);

console.log('verify-arena');

if (want('--syntax')) tierSyntax();
if (want('--contract')) tierContract();
if (want('--unit')) await tierUnit();

if (failures.length) {
  console.log(`\n${failures.length} failure(s):\n`);
  for (const f of failures) console.log(`  [${f.group}] ${f.check}\n      ${f.message}`);
  process.exitCode = 1;
} else {
  console.log(`\nall green - ${passed + fileLevel} checks passed (${fileLevel} of them file-level)`);
}
