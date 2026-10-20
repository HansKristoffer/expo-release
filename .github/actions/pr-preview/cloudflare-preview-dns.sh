#!/usr/bin/env bash
# Upsert or delete Railway-required DNS records for a PR preview host on Cloudflare.
#
# Usage:
#   cloudflare-preview-dns.sh upsert <preview-host> <railway-domain-status.json>
#   cloudflare-preview-dns.sh delete <preview-host>
#   cloudflare-preview-dns.sh check-ssl
#
# Required env:
#   CLOUDFLARE_API_TOKEN  Zone.DNS Edit on the preview zone
#   CLOUDFLARE_ZONE_ID    Cloudflare zone id of the preview zone
#   CLOUDFLARE_ZONE_NAME  Preview zone, for example previews.example.com
set -euo pipefail

CF_API="https://api.cloudflare.com/client/v4"

usage() {
	echo "Usage: $0 upsert <preview-host> <railway-domain-status.json>" >&2
	echo "       $0 delete <preview-host>" >&2
	echo "       $0 check-ssl" >&2
	exit 2
}

require_env() {
	if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
		echo "::error::CLOUDFLARE_API_TOKEN is not set" >&2
		exit 1
	fi
	if [[ -z "${CLOUDFLARE_ZONE_ID:-}" ]]; then
		echo "::error::CLOUDFLARE_ZONE_ID is not set" >&2
		exit 1
	fi
	if [[ -z "${CLOUDFLARE_ZONE_NAME:-}" ]]; then
		echo "::error::CLOUDFLARE_ZONE_NAME is not set" >&2
		exit 1
	fi
}

cf() {
	local method="$1"
	local path="$2"
	local data="${3:-}"
	local args=(
		-sS
		-X "$method"
		-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
		-H "Content-Type: application/json"
		"${CF_API}${path}"
	)
	if [[ -n "$data" ]]; then
		args+=(--data "$data")
	fi
	local body
	body="$(curl "${args[@]}")"
	if ! echo "$body" | jq -e '.success == true' >/dev/null; then
		echo "::error::Cloudflare ${method} ${path} failed" >&2
		echo "$body" | jq . >&2
		return 1
	fi
	printf '%s' "$body"
}

fqdn_of() {
	local host="$1"
	if [[ "$host" == "$CLOUDFLARE_ZONE_NAME" || "$host" == *."$CLOUDFLARE_ZONE_NAME" ]]; then
		printf '%s' "$host"
	else
		printf '%s.%s' "$host" "$CLOUDFLARE_ZONE_NAME"
	fi
}

find_record() {
	local fqdn="$1"
	local type="$2"
	local encoded
	encoded="$(jq -rn --arg n "$fqdn" '$n | @uri')"
	cf GET "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=${type}&name=${encoded}" \
		| jq -c --arg type "$type" --arg name "$fqdn" '
			.result
			| map(select(.type == $type and .name == $name))
			| first // empty
		'
}

upsert_record() {
	local type="$1"
	local name="$2"
	local content="$3"
	local proxied="$4"
	local fqdn
	fqdn="$(fqdn_of "$name")"

	local payload
	payload="$(jq -n \
		--arg type "$type" \
		--arg name "$name" \
		--arg content "$content" \
		--argjson proxied "$proxied" \
		'{
			type: $type,
			name: $name,
			content: $content,
			ttl: 1,
			proxied: $proxied
		}')"

	local existing
	existing="$(find_record "$fqdn" "$type")"
	if [[ -n "$existing" ]]; then
		local id current_content current_proxied
		id="$(echo "$existing" | jq -r '.id')"
		current_content="$(echo "$existing" | jq -r '.content')"
		current_proxied="$(echo "$existing" | jq -r '.proxied')"
		if [[ "$current_content" == "$content" && "$current_proxied" == "$proxied" ]]; then
			echo "Unchanged ${type} ${fqdn}"
			return 0
		fi
		echo "Updating ${type} ${fqdn}"
		cf PUT "/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${id}" "$payload" >/dev/null
		return 0
	fi

	echo "Creating ${type} ${fqdn}"
	cf POST "/zones/${CLOUDFLARE_ZONE_ID}/dns_records" "$payload" >/dev/null
}

should_proxy() {
	local name="$1"
	local purpose="${2:-}"
	if [[ "$name" == *_acme-challenge* ]]; then
		echo false
		return
	fi
	if [[ "$purpose" == *ACME* || "$purpose" == *CHALLENGE* || "$purpose" == *VERIFY* ]]; then
		echo false
		return
	fi
	echo true
}

cf_type() {
	case "$1" in
		DNS_RECORD_TYPE_CNAME | CNAME) echo CNAME ;;
		DNS_RECORD_TYPE_TXT | TXT) echo TXT ;;
		DNS_RECORD_TYPE_A | A) echo A ;;
		DNS_RECORD_TYPE_AAAA | AAAA) echo AAAA ;;
		*) echo "" ;;
	esac
}

upsert_from_railway() {
	local host="$1"
	local json_file="$2"
	if [[ ! -f "$json_file" ]]; then
		echo "::error::Railway domain status JSON not found: ${json_file}" >&2
		exit 1
	fi

	local domain
	domain="$(jq -c '.domain // .' "$json_file")"
	local reported
	reported="$(echo "$domain" | jq -r '.domain // empty')"
	if [[ -n "$reported" && "$reported" != "$host" ]]; then
		echo "::error::Railway status host ${reported} does not match ${host}" >&2
		exit 1
	fi

	local count
	count="$(echo "$domain" | jq '.dnsRecords | length')"
	if [[ "$count" -eq 0 ]]; then
		echo "::error::Railway status has no dnsRecords for ${host}" >&2
		exit 1
	fi

	local i record_type name required purpose cf_type proxied
	for ((i = 0; i < count; i++)); do
		record_type="$(echo "$domain" | jq -r --argjson i "$i" '.dnsRecords[$i].recordType')"
		name="$(echo "$domain" | jq -r --argjson i "$i" '.dnsRecords[$i].name')"
		required="$(echo "$domain" | jq -r --argjson i "$i" '.dnsRecords[$i].requiredValue')"
		purpose="$(echo "$domain" | jq -r --argjson i "$i" '.dnsRecords[$i].purpose // empty')"
		cf_type="$(cf_type "$record_type")"
		if [[ -z "$cf_type" || -z "$name" || -z "$required" || "$required" == "null" ]]; then
			echo "::error::Unusable Railway DNS record at index ${i}: ${record_type} ${name}" >&2
			exit 1
		fi
		if [[ "$cf_type" == "TXT" ]]; then
			proxied=false
		else
			proxied="$(should_proxy "$name" "$purpose")"
		fi
		upsert_record "$cf_type" "$name" "$required" "$proxied"
	done

	local verify_host verify_token
	verify_host="$(echo "$domain" | jq -r '.verification.dnsHost // empty')"
	verify_token="$(echo "$domain" | jq -r '.verification.token // empty')"
	if [[ -n "$verify_host" && -n "$verify_token" && "$verify_token" != "null" ]]; then
		upsert_record TXT "$verify_host" "$verify_token" false
	else
		echo "::error::Railway status is missing verification TXT for ${host}" >&2
		exit 1
	fi
}

delete_preview_records() {
	local host="$1"
	local suffix=".${host}"
	local page=1
	local deleted=0

	while true; do
		local body
		body="$(cf GET "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?per_page=100&page=${page}")"
		local ids
		ids="$(echo "$body" | jq -r --arg host "$host" --arg suffix "$suffix" '
			.result[]
			| select(.name == $host or (.name | endswith($suffix)))
			| .id
		')"
		if [[ -n "$ids" ]]; then
			while IFS= read -r id; do
				[[ -z "$id" ]] && continue
				echo "Deleting Cloudflare record ${id} for ${host}"
				cf DELETE "/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${id}" >/dev/null
				deleted=$((deleted + 1))
			done <<< "$ids"
		fi

		local total_pages
		total_pages="$(echo "$body" | jq -r '.result_info.total_pages // 1')"
		if [[ "$page" -ge "$total_pages" ]]; then
			break
		fi
		page=$((page + 1))
	done

	if [[ "$deleted" -eq 0 ]]; then
		echo "No Cloudflare records found for ${host}"
	else
		echo "Deleted ${deleted} Cloudflare record(s) for ${host}"
	fi
}

check_ssl() {
	local body mode
	# Zone.DNS Edit cannot read /settings/ssl. Treat that as a skip, not a
	# hard failure - the token this workflow documents is DNS-only.
	body="$(
		curl -sS \
			-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
			-H "Content-Type: application/json" \
			"${CF_API}/zones/${CLOUDFLARE_ZONE_ID}/settings/ssl"
	)"
	if ! echo "$body" | jq -e '.success == true' >/dev/null; then
		echo "::warning::Could not read Cloudflare SSL/TLS mode (token is likely DNS-only). Skipping the Full-mode check."
		echo "$body" | jq . >&2 || true
		return 0
	fi
	mode="$(echo "$body" | jq -r '.result.value // empty')"
	echo "Cloudflare SSL/TLS mode for ${CLOUDFLARE_ZONE_NAME}: ${mode}"
	if [[ "$mode" != "full" ]]; then
		echo "::warning::Expected SSL/TLS mode Full for proxied Railway CNAMEs; found '${mode}'. Flexible loops redirects; Full (Strict) can fail during Railway cert issuance."
	fi
}

cmd="${1:-}"
host="${2:-}"
[[ -z "$cmd" ]] && usage
require_env

case "$cmd" in
	upsert)
		[[ -z "$host" ]] && usage
		json_file="${3:-}"
		[[ -z "$json_file" ]] && usage
		upsert_from_railway "$host" "$json_file"
		;;
	delete)
		[[ -z "$host" ]] && usage
		delete_preview_records "$host"
		;;
	check-ssl)
		check_ssl
		;;
	*)
		usage
		;;
esac
