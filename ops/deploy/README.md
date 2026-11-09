# Web deployment

Metapoo's website is deployed **by hand**, not by Vercel's Git integration.

## Why

The Vercel project's root directory is the repository root, and its build command
resolves to no build at that level. A push to `main` therefore produced a ~300 ms
**empty** production deployment — one that still took the `metapoo-testnet.vercel.app`
alias and answered `404` for `/`, `/wall`, `/skill.md` and everything else until
someone re-uploaded a prebuilt build.

That happened twice on 10 November 2026 (once during the #93 merge, and again on
the commits after it). The PR check labelled "Vercel" was green throughout: it was
deploying the empty site.

So Git deployments are disabled, in `/vercel.json` at the repository root:

```json
{ "git": { "deploymentEnabled": false } }
```

Adding that file stopped new deployments from being created for pushes — verified by
`gh api repos/satojandro/metapoo/commits/<sha>/check-runs` returning no Vercel run.

## The deploy, in order

```sh
cd web
vercel build --prod                                   # bakes env from the Vercel project
../ops/deploy/check-web-bundle.sh "$PWD"              # refuses to ship a bundle without the FastNEAR key
vercel deploy --prebuilt --prod
```

`check-web-bundle.sh` needs `BWS_ACCESS_TOKEN` in the environment. It is in
`~/.hermes/profiles/crypto-builder/.env`; `source`-ing that file does not set it
(bash drops the value), so export it explicitly:

```sh
export BWS_ACCESS_TOKEN="$(grep -E '^BWS_ACCESS_TOKEN=' ~/.hermes/profiles/crypto-builder/.env | head -1 | cut -d= -f2-)"
```

## Verify after every deploy

```sh
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://metapoo-testnet.vercel.app/skill.md
# 200 text/markdown
curl -s -o /dev/null -w '%{http_code}\n' https://metapoo-testnet.vercel.app/nope.md
# 404 — a missing file must not return the app HTML (see web/vercel.json)
```

If a push to `main` ever blanks the site again, the alias is on an empty deployment:
re-run the three deploy commands above, and check that `/vercel.json` is still present.
