# Deployment

## What exists

One shared app image (Dockerfile at the repo root) running storefront, console, and worker; `infra/docker/docker-compose.prod.yml` for the full stack (only Caddy publishes ports); `infra/caddy/Caddyfile.local` (local CA, real on-demand-TLS ask gate) and the production `Caddyfile` + `infra/caddy/Dockerfile` (xcaddy + cloudflare DNS) for when a real domain exists.

## Local dry run — bring-up

### 1. Generate secrets (once)

```bash
bash infra/scripts/gen-env.sh
```

Writes `infra/env/production.env` (mode 0600, git-ignored) and `infra/docker/pgbouncer/userlist.prod.txt`. Refuses to overwrite existing files. See **Secrets model** section below for regeneration behavior.

### 2. Start the stack

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml up -d --build
```

**Expected timeline** (first build, clean cache):
- 0:00–6:00: npm dependencies download (261 packages)
- 6:00–6:21: postinstall scripts
- 6:21–6:49: Next.js production builds (storefront + console)
- 6:52: Image export complete
- 7:23: All containers created
- 10:00: All healthchecks passing

**Verify all services healthy:**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml ps
```

Expected output:
```
NAME                         STATUS
platform-prod-caddy-1        Up
platform-prod-console-1      Up (healthy)
platform-prod-storefront-1   Up (healthy)
platform-prod-worker-1       Up
platform-prod-pgbouncer-1    Up (healthy)
platform-prod-postgres-1     Up (healthy)
platform-prod-redis-1        Up (healthy)
platform-prod-minio-1        Up (healthy)
platform-prod-migrate-1      Exited (0)
platform-prod-minio-init-1   Exited (0)
```

Init containers (`migrate`, `minio-init`) must exit 0.

### 3. Seed database and create staff user

**Seed demo tenants:**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml run --rm migrate pnpm --filter @platform/db seed
```

Expected output:
```
✔ Seed complete.

  Acme Retail     →  http://acme.localhost
  Globex Trading  →  http://globex.localhost

  *.localhost resolves to 127.0.0.1 in Chrome/Firefox/Safari,
  so both hosts work immediately with no hosts-file edit.
```

**Create staff user and session:**

First generate a random session token:

```bash
TOKEN=$(openssl rand -hex 32)
echo "$TOKEN" > /tmp/console-session-token
```

Then insert the user, tenant membership, and session:

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml exec -T postgres psql -U postgres -d platform <<SQL
INSERT INTO users (phone_e164, name)
VALUES ('+919876543210', 'Dry Run Owner');

INSERT INTO tenant_members (tenant_id, user_id, role, accepted_at)
SELECT t.id, u.id, 'owner', now()
FROM tenants t, users u
WHERE t.slug = 'acme' AND u.phone_e164 = '+919876543210';

INSERT INTO sessions (id, token_hash, user_id, tenant_id, expires_at, idle_expires_at)
SELECT gen_random_uuid(), encode(sha256('\$TOKEN'::bytea), 'hex'), u.id, t.id,
       now() + interval '1 day', now() + interval '1 day'
FROM tenants t, users u
WHERE t.slug = 'acme' AND u.phone_e164 = '+919876543210';
SQL
```

Expected: `INSERT 0 1` three times.

**Verify hostnames are port-less:**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml exec -T postgres psql -U postgres -d platform -c "SELECT hostname FROM domains;"
```

Expected output:
```
     hostname     
------------------
 acme.localhost
 globex.localhost
```

**Save session token for verification commands:**

```bash
TOKEN=$(cat /tmp/console-session-token)
```

### 4. Export Caddy root CA

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml \
  cp caddy:/data/caddy/pki/authorities/local/root.crt infra/caddy/root.crt
```

Expected output:
```
 platform-prod-caddy-1 Copying platform-prod-caddy-1:/data/caddy/pki/authorities/local/root.crt to infra/caddy/root.crt
 platform-prod-caddy-1 Copied platform-prod-caddy-1:/data/caddy/pki/authorities/local/root.crt to infra/caddy/root.crt
```

**Windows note:** Windows curl uses schannel (native SSL backend) which does not respect `--cacert` the same way OpenSSL-based curl does. All verification commands below use `-k` to skip certificate verification. This is safe for local dry-run testing. On a real VPS with a domain certificate, `-k` is not needed.

## Verification checklist

### Check 1: TLS issuance — verified tenant

```bash
curl -sS -k --resolve acme.localhost:443:127.0.0.1 https://acme.localhost/ | grep -i -o "acme" | head -1
```

**Expected output:** `Acme`

**What this proves:** On-demand TLS certificate issued successfully for verified tenant hostname. Storefront content served over HTTPS.

**Caddy logs (verify ask gate approved):**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml logs caddy | tail -20
```

Expected log entries:
```json
{"level":"info","ts":1786717203.9971912,"logger":"tls.on_demand","msg":"obtaining new certificate","remote_ip":"172.21.0.1","remote_port":"42222","server_name":"acme.localhost"}
{"level":"info","ts":1786717204.0124364,"logger":"tls.obtain","msg":"certificate obtained successfully","identifier":"acme.localhost","issuer":"local"}
```

### Check 2: TLS issuance — unverified hostname (security check)

```bash
curl -sS -k --resolve unknown.localhost:443:127.0.0.1 https://unknown.localhost/ ; echo "exit=$?"
```

**Expected output:**
```
curl: (35) schannel: next InitializeSecurityContext failed: SEC_E_INTERNAL_ERROR (0x80090304) - The Local Security Authority cannot be contacted
exit=35
```

**What this proves:** TLS handshake failed (exit code 35), no HTTP response. Certificate issuance refused for unverified hostname. The on-demand TLS ask endpoint correctly gated issuance.

**Console logs (verify ask gate refused):**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml logs console | grep "tls.issuance_refused"
```

Expected log entries:
```json
{"level":"warn","event":"tls.issuance_refused","domain":"unknown.localhost"}
```

### Check 3: Settings write → robots.txt flip (Redis invalidation)

**Fetch initial robots.txt:**

```bash
curl -sS -k --resolve acme.localhost:443:127.0.0.1 https://acme.localhost/robots.txt
```

Expected output:
```
User-agent: *
Allow: /
Disallow: /search

Sitemap: https://acme.localhost/sitemap.xml
```

**Update settings to noindex:**

```bash
curl -sS -k --resolve console.localhost:443:127.0.0.1 -X PUT https://console.localhost/api/settings \
  -H "content-type: application/json" \
  -H "Cookie: __Host-console_session=$TOKEN" \
  -d '{"searchIndexing":"noindex"}'
```

Expected response:
```json
{"searchIndexing":"noindex","changed":true,"requestId":"f842b602-e942-46fd-b9f9-3e2fd8029d45"}
```

**Verify immediate flip:**

```bash
curl -sS -k --resolve acme.localhost:443:127.0.0.1 https://acme.localhost/robots.txt
```

Expected output:
```
User-agent: *
Disallow: /
```

**What this proves:** Redis invalidation works across console → storefront containers. The change is **immediate** (no 300s cache wait).

**Restore to auto:**

```bash
curl -sS -k --resolve console.localhost:443:127.0.0.1 -X PUT https://console.localhost/api/settings \
  -H "content-type: application/json" \
  -H "Cookie: __Host-console_session=$TOKEN" \
  -d '{"searchIndexing":"auto"}'
```

Expected response:
```json
{"searchIndexing":"auto","changed":true,"requestId":"f1cdc966-c211-4b10-a9e9-5734b4b762ab"}
```

### Check 4: Internal endpoint blackhole (security check)

```bash
curl -sS -o /dev/null -w "%{http_code}" -k --resolve console.localhost:443:127.0.0.1 \
  "https://console.localhost/api/internal/verify-domain?domain=acme.localhost&secret=anything"
```

**Expected output:** `404`

**What this proves:** The public path to `/api/internal/verify-domain` is correctly blackholed by the Caddyfile rule, while Caddy's internal ask (`http://console:3001/api/internal/verify-domain?secret={$TLS_ASK_SECRET}`) still works (proven by Check 2's refusal logs).

### Check 5: Media upload → worker → MinIO → public serving

**Create test image:**

```bash
echo -n "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" \
  | base64 -d > /tmp/test-image.png
```

Verify: `file /tmp/test-image.png` → `PNG image data, 1 x 1, 8-bit/color RGBA, non-interlaced` (70 bytes)

**Upload via console:**

```bash
curl -sS -k --resolve console.localhost:443:127.0.0.1 \
  -X POST https://console.localhost/api/media/upload \
  -H "Cookie: __Host-console_session=$TOKEN" \
  -F file=@/tmp/test-image.png
```

Expected response:
```json
{
  "mediaId": "01a000a9-9f0a-7382-8edc-8c7fd3a30342",
  "status": "pending",
  "alt": null,
  "checksum": "6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0",
  "requestId": "1e65e946-838f-4fc3-bd08-7d8623068287"
}
```

**Verify worker processed:**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml logs worker | tail -20
```

Expected log entries:
```json
{"ts":"2026-08-14T14:25:11.455Z","event":"job.start","queue":"media","jobId":"1","tenantId":"01a000a3-99be-7645-ada1-4c7e74a8d74f"}
{"ts":"2026-08-14T14:25:11.757Z","event":"job.done","jobId":"1","tenantId":"01a000a3-99be-7645-ada1-4c7e74a8d74f","width":1,"height":1,"derivatives":3}
```

**Verify media row status:**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml exec -T postgres psql -U postgres -d platform -c \
  "SELECT status, storage_key FROM media ORDER BY created_at DESC LIMIT 1;"
```

Expected output:
```
 status |                                                     storage_key                                                     
--------+---------------------------------------------------------------------------------------------------------------------
 ready  | 01a000a3-99be-7645-ada1-4c7e74a8d74f/originals/6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0.png
```

**Fetch derivatives and test public serving:**

```bash
DERIVATIVES=$(docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml exec -T postgres psql -U postgres -d platform -t -c \
  "SELECT derivatives FROM media WHERE status='ready' ORDER BY created_at DESC LIMIT 1;")

# Extract first derivative storageKey (AVIF)
STORAGE_KEY=$(echo "$DERIVATIVES" | grep -o '"storageKey":"[^"]*"' | head -1 | cut -d'"' -f4)

# Test public serving
curl -sS -o /dev/null -w "%{http_code}" -k --resolve media.localhost:443:127.0.0.1 \
  "https://media.localhost/$STORAGE_KEY"
```

Expected output: `200`

**What this proves:** Upload → Storage (MinIO) → Worker processing → Derivatives generated → Public serving through `media.localhost` works end-to-end.

### Check 6: Catalog purge across internal network

**Warm cache:**

```bash
curl -sS -k --resolve acme.localhost:443:127.0.0.1 https://acme.localhost/ > /tmp/before.html
```

**Identify first product:**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml exec -T postgres psql -U postgres -d platform -c \
  "SELECT id, title FROM products WHERE tenant_id = (SELECT id FROM tenants WHERE slug='acme') LIMIT 1;"
```

Expected output (may vary if seed changed):
```
                  id                  |        title         
--------------------------------------+----------------------
 01a000a3-9a07-7489-8718-8f8a55166f0a | Classic Cotton Shirt
```

**Update product title:**

```bash
PRODUCT_ID="01a000a3-9a07-7489-8718-8f8a55166f0a"

curl -sS -k --resolve console.localhost:443:127.0.0.1 \
  -X PUT "https://console.localhost/api/products/$PRODUCT_ID" \
  -H "content-type: application/json" \
  -H "Cookie: __Host-console_session=$TOKEN" \
  -d '{"title":"Updated Premium Shirt","status":"active","variants":[{"sku":"SHIRT-001","price":"1299","weightGrams":240}]}'
```

Expected response:
```json
{
  "productId": "01a000a3-9a07-7489-8718-8f8a55166f0a",
  "slug": "updated-premium-shirt",
  "previousSlug": "classic-cotton-shirt",
  "requestId": "bc8714af-fdef-4250-9b50-6d2b339921bd"
}
```

**Verify immediate appearance on storefront:**

```bash
curl -sS -k --resolve acme.localhost:443:127.0.0.1 https://acme.localhost/ | grep -o "Updated Premium Shirt"
```

Expected output:
```
Updated Premium Shirt
Updated Premium Shirt
```

**What this proves:** Catalog purge crossed console → storefront over the internal Docker network successfully. The new title appeared **immediately** on the storefront homepage (no TTL wait).

### Check 7: All services still healthy

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml ps
```

Expected: postgres, pgbouncer, redis, minio, console, and storefront show `Up (healthy)`; caddy and worker show `Up`; migrate and minio-init show `Exited (0)`.

## Secrets model

`gen-env.sh` writes `production.env` + the PgBouncer userlist from one set of values (mode 0600, git-ignored). Regenerating does NOT change an initialized database — see the script's header comment. The script refuses to overwrite existing files; delete them first if regeneration is needed.

**TLS_ASK_SECRET** goes to BOTH console and caddy. Caddy passes it to the console's verify-domain endpoint; the console validates it before approving certificate issuance.

**INTERNAL_API_SECRET**: storefront refuses to boot without it. Used to authenticate console → storefront purge requests.

## What changes for a real VPS

### TLS and DNS

- **Caddy:** Build `infra/caddy/Dockerfile` (includes `xcaddy` + `cloudflare` DNS module) instead of using stock Caddy image
- Serve the production `infra/caddy/Caddyfile` instead of `Caddyfile.local`
- Set `CLOUDFLARE_API_TOKEN` environment variable with DNS edit permissions
- Point real domain's DNS at Cloudflare (automatic ACME via DNS-01 challenge)
- Remove local CA logic (production Caddyfile uses Let's Encrypt)

### Object Storage

- **Storage backend:** Point `STORAGE_*` environment variables at R2 or S3-compatible storage
- Set `STORAGE_FORCE_PATH_STYLE=false` for virtual-host-style bucket access (typical for managed S3)
- Set `MEDIA_PUBLIC_BASE_URL` to the CDN base URL (e.g., `https://cdn.example.com`)
- **Remove services:** Drop `minio` and `minio-init` from `docker-compose.prod.yml`

### Database

- **Do NOT run `db:seed`** (dev fixtures). Create tenants through production onboarding flow.
- Consider managed Postgres (e.g., RDS, Azure Database, Supabase) with connection pooling
- Transport `production.env` via secret store (Vault, AWS Secrets Manager, Azure Key Vault) — never commit to git

### Scaling

- **Storefront replicas:** Run one storefront replica per purge target, OR configure load balancer to fan out purge requests to all replicas
  - Cache purge reaches ONE process per call (Next.js tag manifest is in-memory)
  - Multiple replicas without fan-out will wait out the 300s TTL instead of immediate invalidation
- **Worker scaling:** Increase `deploy.replicas` for worker service as job volume grows

### Known Gaps (Phase 4 Blockers)

- **Console login:** Production console login requires OTP provider integration (SMS via TRAI DLT-registered sender, or WhatsApp Business)
  - Current test path (`+910000000000` with hardcoded session) is dev-only
- **Backups:** No automated backup strategy defined yet
- **Monitoring:** No health check endpoints exposed for external monitoring yet

### Caddyfile Validators (Deferred Polish)

The following Caddy configuration advisories from spec review are noted for future VPS deployment:

- `header_up X-Forwarded-Host` is unnecessary (Caddy sets it automatically)
- Deprecated path-matcher site block syntax in use
- Run `caddy fmt` on Caddyfile before production deploy

These do not affect functionality and are safe to defer.

## Teardown

**Preserve volumes (database, media, CA):**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml down
```

**Destroy volumes (DESTRUCTIVE — removes all data):**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml down -v
```

Volumes destroyed: `pgdata_prod` (database), `redisdata_prod`, `miniodata` (media), `caddy_data` (includes local CA certificate), `caddy_config`.
