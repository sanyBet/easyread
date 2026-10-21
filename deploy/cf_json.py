#!/usr/bin/env python3
"""JSON helpers for deploy/cloudflare_access.sh (stdlib only).

Usage: cf_json.py <subcommand> [args...]; each cmd_<name> is a subcommand.
"""
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
