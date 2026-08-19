#!/usr/bin/env bash
set -e

CERT_DIR="$(dirname "$0")/../certs"
CA_CERT="$CERT_DIR/ca.crt"

if [ ! -f "$CA_CERT" ]; then
    echo "Certificate not found at $CA_CERT. Run zalo-proxy first to generate certificates."
    exit 1
fi

echo "Importing Root CA into NSS DB..."

if [ -d "$HOME/.pki/nssdb" ]; then
    certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Universal Zalo Root CA" -i "$CA_CERT"
    echo "Root CA successfully imported into ~/.pki/nssdb"
else
    mkdir -p "$HOME/.pki/nssdb"
    certutil -d sql:$HOME/.pki/nssdb -N --empty-password
    certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Universal Zalo Root CA" -i "$CA_CERT"
    echo "Created NSS DB and imported Root CA"
fi
