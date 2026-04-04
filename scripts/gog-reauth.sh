#!/bin/bash
# Re-authorize all GOG accounts
# Each command opens a browser for OAuth consent — complete it before pressing Enter

# Load GOG_KEYRING_PASSWORD from .env if not already set
if [ -z "$GOG_KEYRING_PASSWORD" ] && [ -f "$(dirname "$0")/../.env" ]; then
  export GOG_KEYRING_PASSWORD=$(grep '^GOG_KEYRING_PASSWORD=' "$(dirname "$0")/../.env" | sed 's/^GOG_KEYRING_PASSWORD=//' | tr -d '"')
fi

if [ -z "$GOG_KEYRING_PASSWORD" ]; then
  echo "ERROR: GOG_KEYRING_PASSWORD not set. Set it in .env or export it."
  exit 1
fi

# Switch to file-based keyring so background processes (MCP servers, scheduled tasks)
# can access tokens without macOS Keychain interaction
echo "Setting keyring backend to file-based..."
gog auth keyring file
echo ""

accounts=(
  "personal@example.com:gmail,calendar"
  "work@example.com:gmail,calendar"
)

total=${#accounts[@]}
current=0

for entry in "${accounts[@]}"; do
  email="${entry%%:*}"
  services="${entry##*:}"
  current=$((current + 1))

  echo ""
  echo "[$current/$total] Authorizing: $email (services: $services)"
  echo "-----------------------------------------------------------"
  gog auth add "$email" --services "$services"

  if [ $? -eq 0 ]; then
    echo "✓ $email authorized successfully"
  else
    echo "✗ $email failed — you can retry later with: gog auth add $email --services $services"
  fi

  if [ $current -lt $total ]; then
    echo ""
    read -p "Press Enter when ready for the next account..."
  fi
done

echo ""
echo "Done! Verifying..."
echo ""
gog auth list
