# Mavna

Cross-chain delivery into Stellar. Mavna moves money from another chain onto
Stellar and shows exactly what arrives before anything is sent. It is
non-custodial: it builds transactions, the user signs them, and no package ever
holds a key.

It ships in three forms that share one engine:

- **App** (`apps/app`): the hosted interface at [mavna.app](https://mavna.app).
- **SDK** (`packages/*`): the engine as a small set of packages to build on.
- **Widget** (`packages/widget`): the whole flow as one embeddable component.

[Website](https://web.mavna.app) · [App](https://mavna.app) · [Docs](https://docs.mavna.app) · [Playground](https://playground.mavna.app)

## Layout

```
packages/
  core        shared types and route model
  routing     races the rails, ranks the results, adds the swap
  stellar     Stellar reads and account math
  swap        Stellar's exchanges (orderbook, Soroswap, Aquarius)
  status      follow a transfer and find it again later
  adapters/   one per rail: cctp, axelar, layerzero
  widget      the embeddable component
apps/
  app         the product
  web         the landing page
  playground  configure the widget against live quotes
  docs        the documentation site
services/
  sponsor     signs the reserve so a new account needs no XLM to start
```

## Develop

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm dev         # run an app (per-app: pnpm --filter @mavna/app dev)
pnpm build       # build everything
pnpm test        # unit tests
pnpm typecheck
```

Copy `.env.example` to `.env` and set the values before running against a live
network.

## License

Apache-2.0
