# @percolator/keeper

Percolator Keeper — liquidation, oracle price pushing, and crank services for Percolator perpetual futures on Solana.

## Services

- **Liquidation** — Monitors undercollateralized accounts and submits liquidation transactions
- **Oracle** — Pushes Pyth/DEX oracle prices to on-chain markets
- **Crank** — Discovers markets and cranks funding/settlement cycles

## Quick Start

```bash
# Install
pnpm install

# Configure
cp .env.example .env
# Edit .env with your RPC URL and keeper wallet key

# Build
pnpm build

# Run
pnpm start

# Dev mode (with hot reload)
pnpm dev
```

## Testing

```bash
pnpm test
```

## Deployment

### Railway

```bash
railway link
railway up
```

### Docker

```bash
docker build -t percolator-keeper .
docker run --env-file .env percolator-keeper
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SOLANA_RPC_URL` | ✅ | Solana RPC endpoint |
| `SOLANA_RPC_WS_URL` | ✅ | Solana WebSocket RPC endpoint |
| `KEEPER_PRIVATE_KEY` | ✅ | Keeper wallet private key (base58) |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ✅ | Supabase service role key |
| `SENTRY_DSN` | ❌ | Sentry error tracking DSN |
| `KEEPER_HEALTH_PORT` | ❌ | Health check port (default: 8081) |

## License

Apache-2.0
