# arsenal

The FPS Arena weapon roster, layered onto the base engine without touching it.

```
defs.js         nine weapon definitions in the base engine's schema
attachments.js  five mount points, sixteen attachments, pure stat resolution
```

Both files are free of any `three` import on purpose: the whole data layer runs
under plain node, so `tools/verify-arena.mjs` can assert on it without a GPU or
a DOM. Geometry (step 2 of `PLAN.md`) lives in `models/` and is the only part
that needs the renderer.

## Where the numbers came from

FPS Arena stored its roster in a single `WEAPON_STATS` table: seconds per shot,
magazine size, a `baseDamage` multiplier, two recoil scalars, muzzle velocity,
muzzle energy, ADS time, weight, zero distance. This engine wants a richer
shape — deterministic per-shot recoil patterns, spread cones in degrees,
viewmodel poses solved from the bore axis, ballistic drag.

So the port splits in two:

- **Carried over verbatim:** magazine, cadence (`0.10 s` becomes `600 rpm`),
  muzzle velocity, muzzle energy, ADS time, weight, zero distance, the M870's
  nine pellets and its cone, the SVD's default optic.
- **Derived:** damage in hitpoints (`26 * baseDamage`, so the roster's relative
  lethality is preserved exactly), recoil blocks (the old scalars become the
  pattern amplitude; spring frequency and damping scale off cadence and weight),
  spread cones, and poses (each weapon inherits a class archetype and offsets it
  by its own reach and bore height).

`tools/verify-arena.mjs` asserts both halves: the ported numbers must match FPS
Arena to 1e-6, and the derived ones must hold their ordering (an AKM must still
out-hit an AK-74, a full shotgun load must still kill).
