#!/bin/sh
# Memanto server entrypoint for the Ever Works `memanto` agent-memory plugin.
#
# Fails fast on the two credential mistakes that would otherwise start a
# server anyone can drive:
#   - an UNRENDERED manifest placeholder (`$MEMANTO_SECRET_KEY` applied without
#     envsubst / sealed-secrets) used verbatim as a credential — a value
#     everyone who has read the manifest knows;
#   - a short MEMANTO_SECRET_KEY: it signs every session JWT, and on the
#     on-prem backend it is also the management credential.
set -eu

for name in MOORCHEH_API_KEY MEMANTO_SECRET_KEY; do
	eval "value=\${$name:-}"
	case "$value" in
	'$'*)
		echo "memanto: $name is the unrendered placeholder '$value'. Render the Secret (envsubst, sealed-secrets or external-secrets) before applying the manifest." >&2
		exit 64
		;;
	esac
done

if [ -n "${MEMANTO_SECRET_KEY:-}" ] && [ "${#MEMANTO_SECRET_KEY}" -lt 32 ]; then
	echo "memanto: MEMANTO_SECRET_KEY must be at least 32 characters (it signs session tokens and is the on-prem management credential)." >&2
	exit 64
fi

exec uvicorn memanto.app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
