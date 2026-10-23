# Mavna

Cross-chain delivery into Stellar. Mavna moves money from another chain onto Stellar and shows
exactly what arrives before anything is sent. It is non-custodial: it builds transactions, the user
signs them, and no package ever holds a key.

It ships in three forms that share one engine:

- **App** (`apps/app`): the hosted interface at [mavna.app](https://mavna.app), on Stellar's test
  and main networks.
- **SDK** (`packages/*`): the engine as a small set of packages to build on: `@mavna/core`,
  `@mavna/routing`, `@mavna/status`, `@mavna/stellar`, `@mavna/swap`, and one adapter per rail
  (`@mavna/adapter-cctp`, `@mavna/adapter-axelar`, `@mavna/adapter-layerzero`,
  `@mavna/adapter-near-intents`).
- **Widget** (`packages/widget`): the whole flow as one embeddable React component.

The packages are built from this repository; they are not published to npm.
[Install](https://docs.mavna.app/sdk/install) covers building them.

## Links

- [Website](https://web.mavna.app)
- [App](https://mavna.app)
- [Docs](https://docs.mavna.app)
- [Playground](https://playground.mavna.app)

## Develop

Requires Node 24.22.0 (`.nvmrc`) and pnpm 12.14.0; the workspace refuses any other pnpm.

```bash
pnpm install
export VITE_MAVNA_SPONSOR_URL=http://localhost:8787
pnpm build       # build everything; the apps import the packages from their dist/
pnpm --filter @mavna/app dev   # also @mavna/web, @mavna/playground, @mavna/docs
pnpm test        # unit tests
pnpm typecheck
```

A production build of the app, playground, landing or docs stops when no sponsor url is set, so a
hosted page can never fall back to one on localhost. For a local build, point them at the sponsor
you run (above); a hosted build names its own (`https://sponsor.mavna.app` for Mavna's testnet
pages, `https://sponsor-mainnet.mavna.app` for the app's main network).
[Deploy to production](https://docs.mavna.app/operate/deploy) has every setting.

After changing a package, build it again (`pnpm build` skips what has not changed) before the dev
server sees it.

`docker compose up` builds from `scripts/compose-files.txt`, the tracked files it copies. After
adding or removing a tracked file, run `node scripts/compose-sync.mjs --write-manifest`; a test
fails until you do.

Copy `.env.example` to `.env` and set the values before running against a live network.

## License

Apache-2.0
