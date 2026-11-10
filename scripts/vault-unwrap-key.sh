#!/usr/bin/env bash
# Unwraps the Anthropic API key that vault-wrap-key.sh wrapped in the `config`
# job. Runs in the `review` job BEFORE the agent. Unwrapping needs no Vault
# login: the wrapping token is the only credential, and Vault invalidates it
# here. If the unwrap fails, the token expired (WRAP_TTL) or something else
# used it first; either way the review must not run.
#
# Requires (env): VAULT_ADDR, WRAP_TOKEN.
# Writes ANTHROPIC_API_KEY (masked) to $GITHUB_OUTPUT.
set -euo pipefail

: "${VAULT_ADDR:?VAULT_ADDR is required}"
: "${WRAP_TOKEN:?WRAP_TOKEN is required (did the config job wrap the key?)}"

# The token goes in a header file, never on argv.
if ! resp=$(curl -sS --fail-with-body -X POST "${VAULT_ADDR%/}/v1/sys/wrapping/unwrap" \
  -H @<(printf 'X-Vault-Token: %s\n' "$WRAP_TOKEN")); then
  echo "::error::Could not unwrap the Anthropic key: $(jq -c '.errors // empty' <<<"${resp:-}" 2>/dev/null)"
  echo "::error::The wrapping token expired, or another process unwrapped it first. Treat the second case as tampering."
  exit 1
fi

if ! key=$(jq -er '.data.ANTHROPIC_API_KEY // empty' <<<"$resp"); then
  echo "::error::The unwrapped response holds no ANTHROPIC_API_KEY."
  exit 1
fi

echo "::add-mask::$key"
echo "ANTHROPIC_API_KEY=$key" >> "$GITHUB_OUTPUT"
echo "Unwrapped the Anthropic key."
