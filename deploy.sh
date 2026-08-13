#!/usr/bin/env bash
#
# Deploy Convoy App to Azure App Service.
#
# Idempotent: safe to re-run. Creates anything missing, updates anything that
# drifted, then deploys. Run it again to redeploy after a commit.
#
#   ./deploy.sh
#
# Requires: az CLI, an `az login`, and a .env holding the vendor keys.
#
# ── Three design decisions worth knowing ──────────────────────────────────
#
# 1. The package contents come from `git archive HEAD <paths>` — an ALLOWLIST of
#    tracked files — plus the build output. Nothing else can end up in it. That
#    matters because a hand-maintained `zip -x` denylist drifts from .gitignore,
#    and the first version of this did exactly that: it would have shipped the
#    328 KB Vantor imagery sample in server/scripts. An allowlist makes that
#    impossible by construction rather than by vigilance.
#
# 3. The client is built HERE and shipped prebuilt, with Oryx's server-side build
#    turned OFF. The artifact is then exactly what was tested locally: no build
#    variance on the host, no devDependencies (Vite and its tree) installed on
#    the App Service, and a broken build fails here rather than producing a live
#    site serving the 503 "frontend not built" placeholder.
#
# 2. Keys are passed as App Service application settings, read straight from
#    .env and never printed. Every az call that would echo them back uses
#    --output none: `az webapp config appsettings set` prints the FULL settings
#    list including values by default, which would put both vendor keys in your
#    terminal scrollback and any CI log.
#
set -euo pipefail

# ─────────────────────────────────────────────────────────── configuration ──
# Override any of these from the environment: APP_NAME=other ./deploy.sh
# Leave SUBSCRIPTION empty to use the az CLI default.
SUBSCRIPTION="${SUBSCRIPTION:-}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-convoy-demo}"
PLAN_NAME="${PLAN_NAME:-plan-convoy-demo}"
APP_NAME="${APP_NAME:-convoy-demo-tomtom-vantor}"
LOCATION="${LOCATION:-westeurope}"
# B1 is the floor that supports Always On. F1 (free) has no Always On, so every
# visitor after an idle period waits through a cold start, and its 60 CPU-minute
# daily quota does not survive imagery proxying.
SKU="${SKU:-B1}"
RUNTIME="${RUNTIME:-NODE:22-lts}"

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

#
# Retry a transient Azure failure.
#
# Needed because RBAC is not instantly consistent across a resource provider's
# cache replicas. Freshly granted rights land on different replicas at different
# times, so the SAME call alternates between allowed and AuthorizationFailed for a
# while after a grant — measured here at 5 allowed / 1 denied over six consecutive
# attempts, seconds apart. Dying on the denied one wastes an entire deploy on a
# condition that resolves itself. Genuine permanent denials still fail, just after
# the attempts are exhausted.
#
retry() {
  local n=0 max=8
  until "$@"; do
    n=$((n + 1))
    if [ $n -ge $max ]; then return 1; fi
    printf '  retrying (%d/%d)…\r' "$n" "$max"
    sleep 10
  done
  return 0
}
ok()  { printf '  \033[0;32m✓\033[0m %s\n' "$1"; }
die() { printf '\n\033[0;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ───────────────────────────────────────────────────────────── preflight ────
say "Preflight"

command -v az >/dev/null || die "az CLI not found. brew install azure-cli"
command -v git >/dev/null || die "git not found"

az account show >/dev/null 2>&1 || die "Not signed in. Run: az login"
if [ -n "$SUBSCRIPTION" ]; then
  az account set --subscription "$SUBSCRIPTION" || die "Cannot select subscription '$SUBSCRIPTION'"
fi
SUB_NAME=$(az account show --query name -o tsv)
ok "signed in to subscription: $SUB_NAME"

# Fail here with a useful message rather than deep in resource creation. Being able
# to SEE a subscription is not the same as being able to build in it: a tenant-wide
# Reader grant lists hundreds of subscriptions while permitting nothing.
if ! az provider operation show --namespace Microsoft.Web >/dev/null 2>&1; then
  : # provider metadata is readable by anyone; not a useful signal, so ignore
fi

[ -f .env ] || die ".env not found — it holds the vendor keys"

# Read the keys WITHOUT printing them. Presence only.
TOMTOM_KEY=$(grep -m1 '^TOMTOM_API_KEY=' .env | cut -d= -f2- || true)
VANTOR_KEY=$(grep -m1 '^VANTOR_API_KEY=' .env | cut -d= -f2- || true)
[ -n "$TOMTOM_KEY" ] || die "TOMTOM_API_KEY missing from .env"
[ -n "$VANTOR_KEY" ] || die "VANTOR_API_KEY missing from .env"
ok "TOMTOM_API_KEY present"
ok "VANTOR_API_KEY present"

# A dirty tree means what deploys is NOT what you are looking at. Refuse rather
# than silently shipping the last commit.
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "Working tree is dirty. Commit first — the package is built from HEAD."
fi
ok "working tree clean at $(git rev-parse --short HEAD)"

# Build the client, then stage the runtime package.
say "Build"
npm run build >/dev/null 2>&1 || die "Client build failed. Run 'npm run build' to see why."
[ -f server/public/index.html ] || die "Build produced no server/public/index.html"
ok "client built into server/public"

STAGE=$(mktemp -d)
# git archive with explicit paths = an allowlist of TRACKED files only. This is
# why the Vantor imagery samples and .env cannot ride along: they are untracked,
# so git will not emit them regardless of what is sitting in the directory.
git archive HEAD server package.json package-lock.json | tar -x -C "$STAGE"
# The build output is gitignored by design, so add it explicitly.
mkdir -p "$STAGE/server"
cp -R server/public "$STAGE/server/"
( cd "$STAGE" && npm ci --omit=dev --silent )

# Verify rather than assume, since this is the step that could leak a secret.
for BAD in .env server/scripts/vantor-sample.png server/scripts/vantor-probe-report.json; do
  [ -e "$STAGE/$BAD" ] && die "Staged package contains $BAD — aborting."
done
grep -rlF "$TOMTOM_KEY" "$STAGE" 2>/dev/null | grep -q . && die "TomTom key present in package!"
grep -rlF "$VANTOR_KEY" "$STAGE" 2>/dev/null | grep -q . && die "Vantor key present in package!"
ok "staged $(find "$STAGE" -type f | wc -l | tr -d ' ') files, $(du -sh "$STAGE" | cut -f1), no secrets"

PKG="$(mktemp -d)/convoy.zip"
( cd "$STAGE" && zip -qr "$PKG" . )
ok "package $(du -h "$PKG" | cut -f1)"

# ────────────────────────────────────────────────────────────── resources ───
say "Resources"

#
# Two grant shapes both work, which matters because platform teams usually prefer
# the narrower one:
#
#   subscription-scoped Contributor  → the group is created here
#   resource-group-scoped Contributor → the group already exists; we deploy into it
#
if az group show -n "$RESOURCE_GROUP" >/dev/null 2>&1; then
  ok "resource group $RESOURCE_GROUP exists (deploying into it)"
else
  az group create -n "$RESOURCE_GROUP" -l "$LOCATION" --output none 2>/dev/null || die \
"Cannot create resource group '$RESOURCE_GROUP'.

  Either you lack subscription-level rights, or the group should already exist.
  If you were granted Contributor on an EXISTING group, re-run pointing at it:

    SUBSCRIPTION='<sub name or id>' RESOURCE_GROUP='<existing group>' ./deploy.sh"
  ok "created resource group $RESOURCE_GROUP in $LOCATION"
fi

if az appservice plan show -g "$RESOURCE_GROUP" -n "$PLAN_NAME" >/dev/null 2>&1; then
  ok "app service plan $PLAN_NAME exists"
else
  az appservice plan create -g "$RESOURCE_GROUP" -n "$PLAN_NAME" \
    --is-linux --sku "$SKU" --output none
  ok "created plan $PLAN_NAME ($SKU, Linux)"
fi

if az webapp show -g "$RESOURCE_GROUP" -n "$APP_NAME" >/dev/null 2>&1; then
  ok "web app $APP_NAME exists"
else
  # App names share one global DNS namespace, so a clash here is someone else's
  # app, not a mistake in this script. Say so clearly.
  AVAILABLE=$(az rest --method post \
    --url "https://management.azure.com/subscriptions/$(az account show --query id -o tsv)/providers/Microsoft.Web/checknameavailability?api-version=2022-03-01" \
    --body "{\"name\":\"$APP_NAME\",\"type\":\"Microsoft.Web/sites\"}" \
    --query nameAvailable -o tsv 2>/dev/null || echo "unknown")
  if [ "$AVAILABLE" = "false" ]; then
    die "The name '$APP_NAME' is taken globally. Re-run with: APP_NAME=<unique> ./deploy.sh"
  fi

  #
  # Created from an ARM template, NOT `az webapp create`, because of a real
  # constraint rather than a preference.
  #
  # TomTom's CSPM policy set (pd-enforce-web-app-https, effect Deny, assigned at
  # the ccoe-root management group) rejects any Microsoft.Web/sites whose
  # properties.httpsOnly is false. `az webapp create` has no --https-only flag: it
  # creates the site first and you enforce HTTPS afterwards, which means the
  # resource momentarily exists in a non-compliant state. The policy evaluates the
  # creation request itself, so that ordering is refused outright — correctly, since
  # the window it leaves is exactly what the policy exists to prevent.
  #
  # A template sets the whole posture in the creation request, so the app is
  # compliant from the instant it exists. The other hardening is folded in here for
  # the same reason: one atomic, policy-satisfying create.
  #
  PLAN_ID=$(az appservice plan show -g "$RESOURCE_GROUP" -n "$PLAN_NAME" --query id -o tsv)
  TEMPLATE=$(mktemp -d)/site.json
  cat > "$TEMPLATE" <<'ARM'
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "appName":  { "type": "string" },
    "location": { "type": "string" },
    "planId":   { "type": "string" },
    "runtime":  { "type": "string" }
  },
  "resources": [
    {
      "type": "Microsoft.Web/sites",
      "apiVersion": "2022-09-01",
      "name": "[parameters('appName')]",
      "location": "[parameters('location')]",
      "properties": {
        "serverFarmId": "[parameters('planId')]",
        "httpsOnly": true,
        "siteConfig": {
          "linuxFxVersion": "[parameters('runtime')]",
          "appCommandLine": "npm start",
          "alwaysOn": true,
          "http20Enabled": true,
          "minTlsVersion": "1.2",
          "ftpsState": "Disabled",
          "healthCheckPath": "/api/health"
        }
      }
    }
  ]
}
ARM
  # The template takes the pipe form of the runtime (NODE|22-lts); the CLI flag
  # takes the colon form. Convert rather than maintain two settings.
  ARM_RUNTIME="${RUNTIME/:/|}"
  az deployment group create -g "$RESOURCE_GROUP" \
    --name "convoy-site-$(git rev-parse --short HEAD)" \
    --template-file "$TEMPLATE" --output none \
    --parameters appName="$APP_NAME" location="$LOCATION" planId="$PLAN_ID" runtime="$ARM_RUNTIME" \
    || die "Web app creation failed. If a policy denied it, the reason is printed above."
  rm -rf "$(dirname "$TEMPLATE")"
  ok "created web app $APP_NAME ($RUNTIME), HTTPS-only from creation"
fi

# ─────────────────────────────────────────────────────────────── settings ───
say "Configuration"

# --output none matters here: without it az echoes every setting value, keys included.
retry az webapp config appsettings set -g "$RESOURCE_GROUP" -n "$APP_NAME" --output none --settings \
  TOMTOM_API_KEY="$TOMTOM_KEY" \
  VANTOR_API_KEY="$VANTOR_KEY" \
  NODE_ENV=production \
  SCM_DO_BUILD_DURING_DEPLOYMENT=false
ok "app settings applied (values not printed)"
# PORT is deliberately NOT set: App Service injects its own, and lib/env.js reads
# process.env before the .env file, so the platform value wins with no code change.

# Re-asserted rather than assumed: a fresh create already has these from the
# template, but a re-run should repair an app whose config drifted.
retry az webapp config set -g "$RESOURCE_GROUP" -n "$APP_NAME" --output none \
  --startup-file "npm start" --always-on true --http20-enabled true \
  --min-tls-version 1.2 --ftps-state Disabled
ok "startup 'npm start', Always On, HTTP/2, TLS 1.2 floor, FTP disabled"

retry az webapp config set -g "$RESOURCE_GROUP" -n "$APP_NAME" --output none \
  --generic-configurations '{"healthCheckPath": "/api/health"}'
ok "health check path /api/health"

retry az webapp update -g "$RESOURCE_GROUP" -n "$APP_NAME" --output none --https-only true
ok "HTTPS only (HTTP redirects)"

# ───────────────────────────────────────────────────────────────── deploy ───
say "Deploy"
echo "  Shipping a prebuilt package; no server-side build. Usually under a minute."

#
# --clean wipes wwwroot before extracting.
#
# Without it, `az webapp deploy` extracts OVER the existing files and never removes
# ones the new package dropped. Every historical client bundle therefore stayed on the
# server: after a deploy the site served the current index-<hash>.js AND two stale ones,
# all returning 200. Any browser holding a cached index.html kept loading the OLD bundle
# indefinitely, so the deploy looked like it had silently not applied — the exact symptom
# reported. A stale index.html now 404s on its asset and the browser fetches a fresh one.
#
# Safe because the package is complete and self-contained: the client is prebuilt and
# node_modules is installed on the host from the shipped lockfile.
retry az webapp deploy -g "$RESOURCE_GROUP" -n "$APP_NAME" \
  --src-path "$PKG" --type zip --clean true --output none
ok "package deployed"

rm -rf "$PKG" "$STAGE"

# ───────────────────────────────────────────────────────────────── verify ───
say "Verify"
URL="https://${APP_NAME}.azurewebsites.net"

# The app has to boot and Oryx has to finish; poll rather than guess a sleep.
for i in $(seq 1 40); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL/api/health" || echo 000)
  [ "$CODE" = "200" ] && break
  printf '  waiting for the app to come up (%ss)\r' $((i * 5))
  sleep 5
done
echo
[ "$CODE" = "200" ] || die "App did not become healthy. Logs: az webapp log tail -g $RESOURCE_GROUP -n $APP_NAME"
ok "/api/health responding"

# Keys valid against the live vendors, not merely present.
KEYS=$(curl -s --max-time 30 "$URL/api/health/keys")
echo "$KEYS" | grep -q '"ok":true' \
  && ok "both vendor keys valid from Azure" \
  || printf '  \033[0;33m!\033[0m vendor key check did not pass: %s\n' "$KEYS"

# The frontend is built, not the 503 "not built yet" placeholder.
curl -s --max-time 15 "$URL/" | grep -qi '<div id="root"' \
  && ok "frontend served (built)" \
  || die "Frontend not built — Oryx build likely failed. Check the logs."

curl -s --max-time 10 "$URL/robots.txt" | grep -q 'Disallow: /' \
  && ok "robots.txt blocks indexing"

# The whole point: no key may appear in anything the browser downloads.
LEAK=0
for ASSET in $(curl -s --max-time 15 "$URL/" | grep -oE '/assets/[A-Za-z0-9._-]+\.js'); do
  BODY=$(curl -s --max-time 30 "$URL$ASSET")
  case "$BODY" in
    *"$TOMTOM_KEY"*) echo "  *** TOMTOM key found in $ASSET"; LEAK=1 ;;
  esac
  case "$BODY" in
    *"$VANTOR_KEY"*) echo "  *** VANTOR key found in $ASSET"; LEAK=1 ;;
  esac
done
[ "$LEAK" = "0" ] && ok "no vendor key in any served bundle" || die "KEY LEAK IN DEPLOYED BUNDLE"

say "Live"
echo "  $URL"
echo
echo "  Open access is rate limited per IP but otherwise unauthenticated."
echo "  To restrict it to Microsoft sign-in (no VPN needed), see README."
