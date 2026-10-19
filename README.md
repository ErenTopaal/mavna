# Mavna

Cross-chain delivery into Stellar. Mavna moves money from another chain onto
Stellar and shows exactly what arrives before anything is sent. It is
non-custodial: it builds transactions, the user signs them, and no package ever
holds a key.

It ships in three forms that share one engine:

- **App** (`apps/app`): the hosted interface at [mavna.app](https://mavna.app).
- **SDK** (`packages/*`): the engine as a small set of packages to build on.
- **Widget** (`packages/widget`): the whole flow as one embeddable component.

## Links

- [Website](https://web.mavna.app)
- [App](https://mavna.app)
- [Docs](https://docs.mavna.app)
- [Playground](https://playground.mavna.app)

## Develop

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm --filter @mavna/app dev   # also @mavna/web, @mavna/playground, @mavna/docs
pnpm build       # build everything
pnpm test        # unit tests
pnpm typecheck
```

Copy `.env.example` to `.env` and set the values before running against a live
network.

## License

Apache-2.0
