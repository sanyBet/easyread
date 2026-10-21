#!/usr/bin/env bash
# Idempotent Cloudflare setup for easyread.vizce.com:
# tunnel ingress, DNS CNAME, One-time PIN IdP, Access app + policy, login branding.
# Usage: deploy/cloudflare_access.sh [--dry-run]
# Never add `set -x`: the token is read from env into a header file.
set -euo pipefail
# Steps return ids via $(...); without this bash drops errexit inside them (bash < 4.4 lacks it).
shopt -s inherit_errexit 2>/dev/null || true

readonly CF_API="https://api.cloudflare.com/client/v4"
readonly SECRETS_FILE="${HOME}/.secrets/cloudflare-zt.env"
readonly APP_HOST="easyread.vizce.com"
readonly ZONE_NAME="vizce.com"
readonly ORIGIN_SERVICE="http://127.0.0.1:8765"
readonly APP_NAME="EasyRead"
readonly SESSION_DURATION="720h"
readonly POLICY_NAME="EasyRead owner"
readonly OTP_IDP_NAME="One-time PIN"
readonly LOGIN_BG_COLOR="#f6f3ec"
readonly LOGIN_TEXT_COLOR="#23211d"
readonly LOGIN_LOGO_URL="https://raw.githubusercontent.com/sanyBet/easyread/main/electron/assets/icon.png"
readonly LOGIN_HEADER_TEXT="EasyRead"

is_dry_run=0
case "${1:-}" in
  --dry-run) is_dry_run=1 ;;
  "") ;;
  -h | --help) sed -n '2,5p' "$0"; exit 0 ;;
  *) echo "error: unknown argument: $1 (only --dry-run is supported)" >&2; exit 2 ;;
esac

if [[ ! -r "$SECRETS_FILE" ]]; then
  echo "error: cannot read ${SECRETS_FILE}" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$SECRETS_FILE"
for required in CF_API_TOKEN CF_ACCOUNT_ID CF_TUNNEL_ID EASYREAD_ACCESS_EMAIL; do
  if [[ -z "${!required:-}" ]]; then
    echo "error: ${required} is not set in ${SECRETS_FILE}" >&2
    exit 1
  fi
done
export EASYREAD_ACCESS_EMAIL

WORK_DIR="$(umask 077 && mktemp -d)"
readonly WORK_DIR
trap 'rm -rf "$WORK_DIR"' EXIT
readonly AUTH_HEADER_FILE="${WORK_DIR}/auth.header"
# Header file instead of -H "...$TOKEN" keeps the token out of the process list.
(umask 077 && printf 'Authorization: Bearer %s\n' "$CF_API_TOKEN" >"$AUTH_HEADER_FILE")
readonly JSON_TOOL="${WORK_DIR}/cf_json.py"
readonly ACCOUNT_PATH="/accounts/${CF_ACCOUNT_ID}"

cat >"$JSON_TOOL" <<'PY'
import json, os, sys

def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)

def dump(obj, path):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(obj, handle)

def host_of(value):
    return (value or "").split("/")[0].lower()

def app_hosts(app):
    hosts = [host_of(app.get("domain"))]
    hosts += [host_of(d) for d in app.get("self_hosted_domains") or []]
    hosts += [host_of(d.get("uri")) for d in app.get("destinations") or []]
    return hosts

def cmd_ok(path):
    try:
        sys.exit(0 if load(path).get("success") else 1)
    except (OSError, ValueError):
        sys.exit(1)

def cmd_errors(path):
    try:
        errors = load(path).get("errors") or []
    except (OSError, ValueError):
        print("(non-JSON response)")
        return
    print("; ".join(f"{e.get('code')}: {e.get('message')}" for e in errors) or "(no error detail)")

def cmd_first_id(path):
    result = load(path).get("result") or []
    print(result[0]["id"] if result else "")

def cmd_result_id(path):
    print(load(path)["result"]["id"])

def cmd_first_field(path, field):
    result = load(path).get("result") or []
    print(result[0].get(field, "") if result else "")

def cmd_ingress_has(path, host):
    ingress = ((load(path).get("result") or {}).get("config") or {}).get("ingress") or []
    sys.exit(0 if any(host_of(r.get("hostname")) == host for r in ingress) else 1)

def cmd_ingress_insert(path, host, service, out):
    config = (load(path).get("result") or {}).get("config") or {}
    ingress = config.get("ingress") or []
    if not ingress or ingress[-1].get("hostname"):
        sys.exit("error: last ingress rule is not a hostname-less catch-all; refusing to guess")
    ingress.insert(len(ingress) - 1, {"hostname": host, "service": service, "originRequest": {}})
    config["ingress"] = ingress
    dump({"config": config}, out)
    print(f"insert at position {len(ingress) - 1} of {len(ingress)}")

def cmd_otp_idp_id(path):
    found = [i["id"] for i in load(path).get("result") or [] if i.get("type") == "onetimepin"]
    print(found[0] if found else "")

def cmd_app_id(path, host):
    found = [a["id"] for a in load(path).get("result") or [] if host in app_hosts(a)]
    print(found[0] if found else "")

def cmd_other_app_names(path, host):
    names = [a.get("name", "?") for a in load(path).get("result") or [] if host not in app_hosts(a)]
    print(", ".join(names))

def cmd_policy_exists(path, name):
    sys.exit(0 if any(p.get("name") == name for p in load(path).get("result") or []) else 1)

def cmd_dns_body(host, target, out):
    dump({"type": "CNAME", "name": host, "content": target, "proxied": True, "ttl": 1}, out)

def cmd_app_body(host, name, duration, idp_id, out):
    dump({"name": name, "domain": host, "type": "self_hosted", "session_duration": duration,
          "allowed_idps": [idp_id], "auto_redirect_to_identity": True}, out)

def cmd_policy_body(name, out):
    email = os.environ["EASYREAD_ACCESS_EMAIL"]
    dump({"name": name, "decision": "allow", "include": [{"email": {"email": email}}]}, out)

def cmd_idp_body(name, out):
    dump({"name": name, "type": "onetimepin", "config": {}}, out)

def cmd_org_body(path, bg, text, logo, header, out):
    org = load(path).get("result") or {}
    design = {"background_color": bg, "text_color": text, "logo_path": logo, "header_text": header}
    current = org.get("login_design") or {}
    if all(current.get(k) == v for k, v in design.items()):
        print("same")
        return
    for read_only in ("created_at", "updated_at"):
        org.pop(read_only, None)
    org["login_design"] = {**current, **design}
    dump(org, out)
    print("changed")

COMMANDS = {name[4:]: fn for name, fn in globals().items() if name.startswith("cmd_")}
COMMANDS[sys.argv[1]](*sys.argv[2:])
PY

json_tool() {
  python3 "$JSON_TOOL" "$@"
}

mask_email() {
  local email="$1"
  printf '%s***@%s' "${email:0:1}" "${email#*@}"
}

# fd 3 = real stdout, so steps that return ids via $(...) can still report.
exec 3>&1
report() {
  printf '%-16s %s\n' "$1:" "$2" >&3
}

# cf_call METHOD PATH OUT_FILE [BODY_FILE]; prints a concise error and fails on non-2xx or success=false.
cf_call() {
  local method="$1" path="$2" out="$3" body="${4:-}"
  if [[ "$method" != "GET" && "$is_dry_run" == 1 ]]; then
    echo "error: refusing ${method} ${path} in --dry-run" >&2
    exit 1
  fi
  local -a args=(-sS -X "$method" -H "@${AUTH_HEADER_FILE}" -H "Content-Type: application/json"
    -o "$out" -w '%{http_code}')
  if [[ -n "$body" ]]; then
    args+=(--data-binary "@${body}")
  fi
  local status
  if ! status="$(curl "${args[@]}" "${CF_API}${path}")"; then
    echo "error: ${method} ${path}: request failed (network)" >&2
    exit 1
  fi
  if [[ "$status" != 2* ]] || ! json_tool ok "$out"; then
    echo "error: ${method} ${path} -> HTTP ${status}: $(json_tool errors "$out")" >&2
    exit 1
  fi
}

step_tunnel_ingress() {
  local current="${WORK_DIR}/tunnel.json" body="${WORK_DIR}/tunnel_put.json"
  local path="${ACCOUNT_PATH}/cfd_tunnel/${CF_TUNNEL_ID}/configurations"
  cf_call GET "$path" "$current"
  if json_tool ingress_has "$current" "$APP_HOST"; then
    report "tunnel-ingress" "exists"
    return
  fi
  local position
  position="$(json_tool ingress_insert "$current" "$APP_HOST" "$ORIGIN_SERVICE" "$body")"
  if [[ "$is_dry_run" == 1 ]]; then
    report "tunnel-ingress" "would create ${APP_HOST} -> ${ORIGIN_SERVICE} (${position})"
    return
  fi
  cf_call PUT "$path" "${WORK_DIR}/tunnel_put_result.json" "$body"
  report "tunnel-ingress" "created (${position})"
}

lookup_zone_id() {
  local out="${WORK_DIR}/zone.json" zone_id
  cf_call GET "/zones?name=${ZONE_NAME}" "$out"
  zone_id="$(json_tool first_id "$out")"
  if [[ -z "$zone_id" ]]; then
    echo "error: zone ${ZONE_NAME} not found for this token" >&2
    exit 1
  fi
  printf '%s' "$zone_id"
}

step_dns() {
  local zone_id out="${WORK_DIR}/dns.json" body="${WORK_DIR}/dns_post.json"
  local target="${CF_TUNNEL_ID}.cfargotunnel.com"
  zone_id="$(lookup_zone_id)"
  cf_call GET "/zones/${zone_id}/dns_records?name=${APP_HOST}" "$out"
  local existing
  existing="$(json_tool first_field "$out" content)"
  if [[ -n "$existing" ]]; then
    local note=""
    [[ "$existing" != "$target" ]] && note=" (WARNING: points to ${existing}, not the tunnel; left unchanged)"
    report "dns" "exists${note}"
    return
  fi
  if [[ "$is_dry_run" == 1 ]]; then
    report "dns" "would create CNAME ${APP_HOST} -> ${target} (proxied)"
    return
  fi
  json_tool dns_body "$APP_HOST" "$target" "$body"
  cf_call POST "/zones/${zone_id}/dns_records" "${WORK_DIR}/dns_result.json" "$body"
  report "dns" "created"
}

# Prints the One-time PIN IdP id (or a placeholder in dry-run when it is missing).
ensure_otp_idp() {
  local out="${WORK_DIR}/idps.json" body="${WORK_DIR}/idp_post.json" idp_id
  cf_call GET "${ACCOUNT_PATH}/access/identity_providers" "$out"
  idp_id="$(json_tool otp_idp_id "$out")"
  if [[ -n "$idp_id" ]]; then
    report "otp-idp" "exists"
  elif [[ "$is_dry_run" == 1 ]]; then
    report "otp-idp" "would create type=onetimepin"
    idp_id="<new-onetimepin-id>"
  else
    json_tool idp_body "$OTP_IDP_NAME" "$body"
    cf_call POST "${ACCOUNT_PATH}/access/identity_providers" "${WORK_DIR}/idp_result.json" "$body"
    idp_id="$(json_tool result_id "${WORK_DIR}/idp_result.json")"
    report "otp-idp" "created"
  fi
  printf '%s' "$idp_id"
}

# Prints the Access app id (empty in dry-run when it would be created).
ensure_access_app() {
  local idp_id="$1" out="${WORK_DIR}/apps.json" body="${WORK_DIR}/app_post.json" app_id
  cf_call GET "${ACCOUNT_PATH}/access/apps" "$out"
  app_id="$(json_tool app_id "$out" "$APP_HOST")"
  if [[ -n "$app_id" ]]; then
    report "access-app" "exists"
  elif [[ "$is_dry_run" == 1 ]]; then
    report "access-app" "would create self_hosted ${APP_HOST}, session ${SESSION_DURATION}, idp=${idp_id}"
  else
    json_tool app_body "$APP_HOST" "$APP_NAME" "$SESSION_DURATION" "$idp_id" "$body"
    cf_call POST "${ACCOUNT_PATH}/access/apps" "${WORK_DIR}/app_result.json" "$body"
    app_id="$(json_tool result_id "${WORK_DIR}/app_result.json")"
    report "access-app" "created"
  fi
  printf '%s' "$app_id"
}

ensure_access_policy() {
  local app_id="$1" masked out="${WORK_DIR}/policies.json" body="${WORK_DIR}/policy_post.json"
  masked="$(mask_email "$EASYREAD_ACCESS_EMAIL")"
  if [[ -z "$app_id" ]]; then
    report "access-policy" "would create allow email=${masked}"
    return
  fi
  local path="${ACCOUNT_PATH}/access/apps/${app_id}/policies"
  cf_call GET "$path" "$out"
  if json_tool policy_exists "$out" "$POLICY_NAME"; then
    report "access-policy" "exists"
    return
  fi
  if [[ "$is_dry_run" == 1 ]]; then
    report "access-policy" "would create allow email=${masked}"
    return
  fi
  json_tool policy_body "$POLICY_NAME" "$body"
  cf_call POST "$path" "${WORK_DIR}/policy_result.json" "$body"
  report "access-policy" "created (allow email=${masked})"
}

step_login_branding() {
  local apps="${WORK_DIR}/apps_after.json" others
  cf_call GET "${ACCOUNT_PATH}/access/apps" "$apps"
  others="$(json_tool other_app_names "$apps" "$APP_HOST")"
  if [[ -n "$others" ]]; then
    report "login-branding" "skipped (account-wide setting; other Access apps exist: ${others})"
    return
  fi
  local org="${WORK_DIR}/org.json" body="${WORK_DIR}/org_put.json" change
  cf_call GET "${ACCOUNT_PATH}/access/organizations" "$org"
  change="$(json_tool org_body "$org" "$LOGIN_BG_COLOR" "$LOGIN_TEXT_COLOR" \
    "$LOGIN_LOGO_URL" "$LOGIN_HEADER_TEXT" "$body")"
  if [[ "$change" == "same" ]]; then
    report "login-branding" "exists"
    return
  fi
  if [[ "$is_dry_run" == 1 ]]; then
    report "login-branding" "would update login_design (bg ${LOGIN_BG_COLOR}, text ${LOGIN_TEXT_COLOR}, header ${LOGIN_HEADER_TEXT})"
    return
  fi
  cf_call PUT "${ACCOUNT_PATH}/access/organizations" "${WORK_DIR}/org_result.json" "$body"
  report "login-branding" "created"
}

main() {
  [[ "$is_dry_run" == 1 ]] && echo "dry-run: GET requests only, no changes will be made"
  step_tunnel_ingress
  step_dns
  local idp_id app_id
  idp_id="$(ensure_otp_idp)"
  app_id="$(ensure_access_app "$idp_id")"
  ensure_access_policy "$app_id"
  step_login_branding
}

main
