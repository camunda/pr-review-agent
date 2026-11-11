#!/usr/bin/env bash
# Wraps the Anthropic API key in a single-use Vault response-wrapping token.
# AppRole only: with JWT, the shared vault-wrapped-secrets/wrap action does
# this. Remove this script once Infrastructure turns off AppRole
# (camunda/team-infrastructure#1076).
#
# Runs in the `config` job (no AI, no PR code), the only job that logs in to
# Vault. The `review` job unwraps the key with vault-wrapped-secrets/unwrap,
# so the agent's job needs no Vault login and no `id-token: write`
# (docs/security-model.md). The payload matches what that action expects.
#
# Only the key is wrapped, never the rest of what the Vault role can read. The
# token is NOT masked: GitHub drops job outputs that contain masked values. It
# is never printed, and it stops working after the first unwrap or after
# WRAP_TTL.
#
# Requires (env): VAULT_ADDR, VAULT_TOKEN, ANTHROPIC_API_KEY. Optional: WRAP_TTL
# (default 5m: the review job unwraps in its first step).
# Writes wrap_token to $GITHUB_OUTPUT.
set -euo pipefail

: "${VAULT_ADDR:?VAULT_ADDR is required}"
: "${VAULT_TOKEN:?VAULT_TOKEN is required}"
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"

# The key goes on stdin and the Vault token in a header file, never on argv.
if ! resp=$(jq -n '{ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY}' |
  curl -sS --fail-with-body -X POST "${VAULT_ADDR%/}/v1/sys/wrapping/wrap" \
    -H @<(printf 'X-Vault-Token: %s\n' "$VAULT_TOKEN") \
    -H "X-Vault-Wrap-TTL: ${WRAP_TTL:-5m}" \
    --data @-); then
  echo "::error::Vault refused to wrap the Anthropic key: $(jq -c '.errors // empty' <<<"${resp:-}" 2>/dev/null)"
  exit 1
fi

if ! token=$(jq -er '.wrap_info.token // empty' <<<"$resp"); then
  echo "::error::Vault returned no wrapping token."
  exit 1
fi

echo "wrap_token=$token" >> "$GITHUB_OUTPUT"
echo "Wrapped the Anthropic key (single use, TTL ${WRAP_TTL:-5m})."
