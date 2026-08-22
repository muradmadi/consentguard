# Sluice task runner. `just` on its own lists everything.
#
# The toolchain (bun, just, node) is pinned in mise.toml — run `mise install`
# once, then everything below works without knowing which tool does what.

# List available recipes
default:
    @just --list --unsorted

# Install dependencies from the lockfile
install:
    bun install

# Run every package in watch mode: proxy, dashboard, and library rebuilds
dev:
    bun run dev

# Watch and serve only the admin dashboard
dev-dashboard:
    bun run --filter @sluice/admin dev

# Watch and restart only the proxy server
dev-server:
    bun run --filter @sluice/server dev

# Build every package
build:
    bun run build

# Run the whole test suite
test:
    bun run test

# Re-run tests on change for one package, e.g. `just watch client`
watch package:
    cd packages/{{ package }} && bun x vitest

# Run the Redis integration suite (flushes the db — use a throwaway Redis)
test-redis url="redis://127.0.0.1:6379":
    cd packages/server && REDIS_TEST_URL={{ url }} bun x vitest run src/engine/storage/redis.test.ts

# Lint every package
lint:
    bun run lint

# Report lint problems that can be fixed automatically
lint-fix:
    bun x eslint . --fix

# Rewrite every file with Prettier
fmt:
    bun run format

# Fail if anything is unformatted
fmt-check:
    bun run format:check

# Typecheck every package
typecheck:
    bun run typecheck

# Fail if a built bundle carries anything secret-shaped
check-dist:
    bun run check:dist

# The full gate: everything that must pass before committing
check: lint fmt-check typecheck build check-dist test

# Start the built proxy on PORT with in-memory storage (prints a dev admin token)
serve port="3000":
    PORT={{ port }} SLUICE_STORAGE=memory node packages/server/dist/index.js

# Remove build output and caches
clean:
    rm -rf packages/*/dist .turbo packages/*/.turbo

# Remove build output, caches and all installed dependencies
clean-all: clean
    rm -rf node_modules packages/*/node_modules
