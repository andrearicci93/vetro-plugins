## Shard

- id and version:
- what it does, in one line:
- permissions asked (and why `exec`, if asked):
- hosts it talks to, if any:
- Control center card (`controlCenter`), if any: what the rows show and what OK does:
- TV model and Vetro version it was tried on (or "not tried on a TV"):

## Checklist

- [ ] ES5 source and lifecycle smoke tests pass (`npm test`, `npm run test:runtime`)
- [ ] `node scripts/build.cjs` run; `dist/` and `index.json` committed
- [ ] a card: `card()` only reads, `cardSelect` acts only on listed rows, both answer without a config (`npm run test:runtime`)
- [ ] README says what it runs (`exec`), where it connects and what it stores
- [ ] `version` bumped if this changes an existing Shard
- [ ] source is readable (no minified code, no `eval`, no downloaded code)
- [ ] `author` is a GitHub account that can answer questions about it
