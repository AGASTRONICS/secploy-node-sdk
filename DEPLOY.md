# Releasing the Node SDK

The package is **`secploy`** on npm. This is the whole release path, plus the
things about this repo that have already caused a bad release or nearly did.

---

## Before you start

```bash
npm whoami          # must print your username
```

If it errors with `ENEEDAUTH`, log in first:

```bash
npm login           # or: npm config set //registry.npmjs.org/:_authToken=$NPM_TOKEN
```

Publishing is **irreversible in practice**. npm allows unpublish only within 72
hours and only when nothing depends on the version, and a yanked version can
never be reused. Treat a version number as spent the moment it goes out.

---

## What actually ships

```json
"files": ["dist/**/*"],
"main": "dist/index.js",
"types": "dist/index.d.ts"
```

Only `dist/` reaches the consumer — not `src/`, not tests, not `node_modules/`.
So **the compiled output is the product**, and everything below is about making
sure it matches the source you think you are shipping.

`dist/` is also committed to the repo, which means it can drift from `src/`
between builds. It has: a release check found the tracked `dist/` stale against
`src/` by thirteen files. `npm publish` runs `prepare` (which runs `tsc`) and
would have rebuilt it, so the *published* artefact was never wrong — but do not
rely on that. Rebuild and commit before tagging, so the repo tells the truth.

---

## Release

```bash
npm run lint          # eslint src --ext .ts   (NOT `eslint .` — see below)
npx tsc --noEmit      # type check without emitting
npm test              # jest, 255 tests
npm run build         # tsc -> dist/
git status            # dist/ should be clean, or commit the rebuild
```

Then bump and publish. `npm version` runs `preversion` (lint), `version`
(prettier + `git add -A src`) and `postversion` (`git push && git push --tags`),
so the tag and the push happen for you:

```bash
npm version patch     # or minor / major
npm publish
```

`prepublishOnly` runs `npm test && npm run lint` — a failing test or a lint
error stops the publish. `prepare` runs `tsc`, so `dist/` is always rebuilt
from the current `src/` at publish time.

Verify what the registry actually serves, not what you believe you sent:

```bash
npm view secploy version
npm view secploy dist-tags
cd $(mktemp -d) && npm pack secploy@latest && tar -tzf secploy-*.tgz | head
```

That last one is the useful check: it lists the files a consumer receives. If
`dist/index.js` is missing or stale, you find out here rather than from a user.

---

## Version state, as of this writing

| | |
|---|---|
| Published on npm | `0.1.0`, `0.1.1`, `0.2.0` |
| `package.json` | `1.5.0` |

The local version is **five majors ahead of anything released**. That gap is not
a mistake to paper over silently — decide it deliberately. The work sitting
unreleased (security gate, policy cache, identity reporter, scrubbing, sampling,
realtime, transport) is a large, breaking-shaped body of change, so `1.x` may
well be right. But anyone reading npm today sees `0.2.0`, and `npm i secploy`
gets a package **without the gate in it**. Until this is published, the
dashboard's install instructions describe software the registry does not serve.

---

## Traps in this repo

**Lint the source, not the build.** The script is `eslint src --ext .ts` for a
reason. Running `eslint .` also lints `dist/`, which is compiled CommonJS made
of `require()` calls, and produces ~39 spurious `no-require-imports` errors.
There is no `.eslintrc` ignore for `dist/`, so an IDE integration will do this
too.

**`node_modules/` is committed.** 7,761 files are tracked, and the repo has no
`.gitignore` at all. Every `npm install` therefore shows up as a huge diff, and
dependency contents are in the history. It does not affect what is published
(`files` covers that), but it should be fixed:

```bash
printf 'node_modules/\ncoverage/\n*.tgz\n' > .gitignore
git rm -r --cached node_modules
git commit -m "Stop tracking node_modules"
```

That rewrites nothing historical — the objects stay in the history and the repo
stays large — but it stops the bleeding.

**The `ws` dependency is optional on purpose.** `realtime.ts` resolves it with a
lazy `require()` so a browser consumer never needs it. The eslint suppression
there names `@typescript-eslint/no-require-imports`; it previously named
`no-var-requires`, which typescript-eslint **v8 renamed**, so the suppression
silently stopped matching and turned into a build-blocking error. If the rule is
renamed again, that line is where it surfaces.

**One test is timing-sensitive.** A full run under heavy CPU load (a parallel
emulated Docker build) failed 1 of 255; the same suite passes in 17s when the
machine is idle. Worth identifying before this runs in CI, where contention is
normal.

---

## No CI

There is no GitHub Actions workflow in this repo — no test run on push, and no
publish automation. Releases are manual, from a laptop, by whoever is logged in.
The Python SDK has `.github/workflows/publish.yml` (build + twine on a `v*` tag)
and is the obvious model to copy, with `npm publish --provenance` once it runs
in Actions.
