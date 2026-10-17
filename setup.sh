#!/usr/bin/env bash
# Run in AWS CloudShell. The AWS session supplies authentication.
set -Eeuo pipefail
umask 077

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DOMAIN="snake.rootpilot.de"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-central-1}}"
HOSTED_ZONE_ID=""
PROFILE=""
STACK_PREFIX=""
CERTIFICATE_REGION="us-east-1"
PHASE="Vorbereitung"
WORK_DIR=""

usage() {
  cat <<'EOF'
Rootpilot Snake direkt in AWS veröffentlichen:
  bash setup.sh
  bash setup.sh --hosted-zone-id Z123456789 --region eu-central-1
  bash setup.sh --domain snake.example.de --profile mein-aws-profil

In AWS CloudShell mit dem gewünschten AWS-Konto ausführen. Das Script erstellt
einen privaten S3-Bucket, CloudFront, ein ACM-Zertifikat und Route-53-DNS-Einträge.
Es lädt die Website hoch und aktualisiert bei weiteren Aufrufen dieselben Stacks.

Optionen:
  --domain DOMAIN           Standard: snake.rootpilot.de
  --hosted-zone-id ID        Öffentliche Route-53-Zone; sonst automatisch erkennen
  --region REGION           S3-Region; Standard: aktuelle AWS-Region / eu-central-1
  --profile PROFIL          Optionales vorhandenes AWS-CLI-Profil
  --stack-prefix NAME       Optionaler Präfix für die beiden CloudFormation-Stacks
  -h, --help                Diese Hilfe

Die öffentliche DNS-Zone muss im angemeldeten AWS-Konto liegen und autoritativ
für die Domain sein. CloudFront-Zertifikate werden immer in us-east-1 erstellt.
Kein Linux-Webserver, sudo, nginx oder manueller Zertifikatsjob erforderlich.
EOF
}

die() { printf 'Fehler: %s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --domain|--hosted-zone-id|--region|--profile|--stack-prefix)
      (($# >= 2)) || die "Wert für $1 fehlt."
      [[ -n "$2" && "$2" != --* ]] || die "Wert für $1 fehlt."
      case "$1" in
        --domain) DOMAIN="$2" ;;
        --hosted-zone-id) HOSTED_ZONE_ID="${2#/hostedzone/}" ;;
        --region) REGION="$2" ;;
        --profile) PROFILE="$2" ;;
        --stack-prefix) STACK_PREFIX="$2" ;;
      esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unbekannter Parameter: $1 (siehe --help)." ;;
  esac
done

DOMAIN="${DOMAIN,,}"
[[ ${#DOMAIN} -le 253 && "$DOMAIN" == *.* && "$DOMAIN" != *. && "$DOMAIN" != *..* ]] \
  || die "Bitte einen vollständigen Domainnamen angeben."
IFS='.' read -r -a DOMAIN_LABELS <<< "$DOMAIN"
for label in "${DOMAIN_LABELS[@]}"; do
  [[ ${#label} -le 63 && "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] \
    || die "Ungültiger Domainname."
done
[[ "$REGION" =~ ^[a-z]{2}-[a-z]+-[0-9]+$ ]] || die "Ungültige AWS-Region."
if [[ -n "$HOSTED_ZONE_ID" ]]; then
  [[ "$HOSTED_ZONE_ID" =~ ^Z[A-Z0-9]+$ ]] || die "Ungültige Route-53-Zonen-ID."
fi
if [[ -z "$STACK_PREFIX" ]]; then STACK_PREFIX="rootpilot-${DOMAIN//./-}"; fi
[[ ${#STACK_PREFIX} -le 112 && "$STACK_PREFIX" =~ ^[A-Za-z][A-Za-z0-9-]*$ ]] \
  || die "Stack-Präfix muss mit einem Buchstaben beginnen und darf höchstens 112 Zeichen lang sein."
CERTIFICATE_STACK="$STACK_PREFIX-certificate"
HOSTING_STACK="$STACK_PREFIX-hosting"

command -v aws >/dev/null || die "AWS CLI fehlt. Bitte das Projekt in AWS CloudShell öffnen und dort bash setup.sh ausführen."
command -v python3 >/dev/null || die "Python 3 fehlt. In AWS CloudShell ist es bereits vorhanden."

WEB_FILES=(assets/game.js assets/favicon.svg styles.css index.html)
for source_file in "${WEB_FILES[@]}" infra/certificate.yaml infra/hosting.yaml; do
  [[ -f "$SOURCE_DIR/$source_file" && ! -L "$SOURCE_DIR/$source_file" ]] \
    || die "Projektdatei fehlt oder ist ein Symlink: $source_file"
done
[[ ! -L "$SOURCE_DIR/assets" && ! -L "$SOURCE_DIR/infra" ]] \
  || die "assets und infra müssen echte Projektverzeichnisse sein."

export AWS_PAGER=""
export AWS_CLI_AUTO_PROMPT=off
AWS_AUTH_ARGS=()
if [[ -n "$PROFILE" ]]; then AWS_AUTH_ARGS+=(--profile "$PROFILE"); fi
aws_cmd() { command aws "${AWS_AUTH_ARGS[@]}" "$@"; }

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rootpilot-snake-aws.XXXXXXXX")"
cleanup() {
  local result=$?
  trap - EXIT
  rm -rf -- "$WORK_DIR"
  if ((result != 0)); then
    printf '\nAbgebrochen bei: %s\n' "$PHASE" >&2
    printf 'CloudFormation: %s (%s), %s (%s).\n' \
      "$CERTIFICATE_STACK" "$CERTIFICATE_REGION" "$HOSTING_STACK" "$REGION" >&2
    printf 'Vorhandene AWS-Ressourcen bleiben erhalten. Nach Behebung denselben Befehl erneut ausführen.\n' >&2
  fi
  exit "$result"
}
trap cleanup EXIT

PHASE="AWS-Anmeldung"
if ! aws_cmd sts get-caller-identity --region "$REGION" --query Account --output text >/dev/null; then
  die "Keine nutzbare AWS-Sitzung. AWS CloudShell im gewünschten Konto öffnen oder ein vorhandenes Profil mit --profile verwenden. Keine Zugangsschlüssel ins Script schreiben."
fi

PHASE="Öffentliche Route-53-Zone ermitteln"
if [[ -z "$HOSTED_ZONE_ID" ]]; then
  aws_cmd route53 list-hosted-zones --region "$REGION" --output json > "$WORK_DIR/zones.json"
  HOSTED_ZONE_ID="$(python3 - "$WORK_DIR/zones.json" "$DOMAIN" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    zones = json.load(stream)["HostedZones"]
domain = sys.argv[2]
matching = [zone for zone in zones
            if not zone.get("Config", {}).get("PrivateZone", False)
            and (domain == zone["Name"].lower().rstrip(".")
                 or domain.endswith("." + zone["Name"].lower().rstrip(".")))]
if not matching:
    sys.exit("Keine passende öffentliche Route-53-Zone im Konto. Eine autoritative Zone für rootpilot.de bzw. die gewählte Domain wird benötigt.")
longest = max(len(zone["Name"]) for zone in matching)
matching = [zone for zone in matching if len(zone["Name"]) == longest]
if len(matching) != 1:
    sys.exit("Mehrere passende Route-53-Zonen. Die autoritative Zone mit --hosted-zone-id angeben.")
print(matching[0]["Id"].rsplit("/", 1)[-1])
PY
)"
fi

aws_cmd route53 get-hosted-zone --id "$HOSTED_ZONE_ID" --region "$REGION" --output json > "$WORK_DIR/zone.json"
python3 - "$WORK_DIR/zone.json" "$DOMAIN" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    zone = json.load(stream)["HostedZone"]
name = zone["Name"].lower().rstrip(".")
if zone.get("Config", {}).get("PrivateZone", False):
    sys.exit("Eine private Route-53-Zone kann die öffentliche Website nicht bereitstellen.")
if sys.argv[2] != name and not sys.argv[2].endswith("." + name):
    sys.exit("Die angegebene DNS-Zone passt nicht zur Domain.")
PY
printf 'AWS-Ziel: %s · S3-Region: %s · Route-53-Zone: %s\n' "$DOMAIN" "$REGION" "$HOSTED_ZONE_ID"

# Never adopt an unrelated stack just because its name happens to match.
check_existing_stack() {
  local stack_name="$1" stack_region="$2"
  if aws_cmd cloudformation describe-stacks --stack-name "$stack_name" --region "$stack_region" \
    --output json > "$WORK_DIR/stack.json" 2> "$WORK_DIR/stack-error.txt"; then
    python3 - "$WORK_DIR/stack.json" "$DOMAIN" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    stack = json.load(stream)["Stacks"][0]
tags = {tag["Key"]: tag["Value"] for tag in stack.get("Tags", [])}
parameters = {param["ParameterKey"]: param.get("ParameterValue") for param in stack.get("Parameters", [])}
if tags.get("Project") != "RootpilotSnake" or parameters.get("DomainName") != sys.argv[2]:
    sys.exit("Vorhandener Stack gehört nicht zu diesem Deployment. Anderen --stack-prefix verwenden.")
if stack["StackStatus"] in ("ROLLBACK_COMPLETE", "DELETE_FAILED"):
    sys.exit("Ein früherer fehlgeschlagener Stack muss zuerst in CloudFormation geprüft werden. Das Script löscht ihn nicht automatisch.")
PY
  elif ! python3 - "$WORK_DIR/stack-error.txt" <<'PY'
import sys
with open(sys.argv[1], encoding="utf-8") as stream:
    message = stream.read()
sys.exit(0 if "ValidationError" in message and "does not exist" in message else 1)
PY
  then
    cat "$WORK_DIR/stack-error.txt" >&2
    die "Vorhandener CloudFormation-Stack konnte nicht ermittelt werden."
  fi
}

check_existing_stack "$CERTIFICATE_STACK" "$CERTIFICATE_REGION"
check_existing_stack "$HOSTING_STACK" "$REGION"

PHASE="ACM-Zertifikat und DNS-Validierung in us-east-1"
printf '\nErstelle/aktualisiere das HTTPS-Zertifikat. Die DNS-Validierung kann einige Minuten dauern.\n'
aws_cmd cloudformation deploy \
  --region "$CERTIFICATE_REGION" \
  --stack-name "$CERTIFICATE_STACK" \
  --template-file "$SOURCE_DIR/infra/certificate.yaml" \
  --parameter-overrides "DomainName=$DOMAIN" "HostedZoneId=$HOSTED_ZONE_ID" \
  --tags Project=RootpilotSnake "Domain=$DOMAIN" \
  --no-fail-on-empty-changeset

CERTIFICATE_ARN="$(aws_cmd cloudformation describe-stacks --region "$CERTIFICATE_REGION" \
  --stack-name "$CERTIFICATE_STACK" --query "Stacks[0].Outputs[?OutputKey=='CertificateArn'].OutputValue | [0]" --output text)"
[[ "$CERTIFICATE_ARN" == arn:aws:acm:us-east-1:*:certificate/* ]] || die "ACM-Zertifikat wurde nicht bereitgestellt."

PHASE="Privater S3-Bucket, CloudFront und Domain"
printf '\nErstelle/aktualisiere S3 und CloudFront. Die globale Bereitstellung kann einige Minuten dauern.\n'
aws_cmd cloudformation deploy \
  --region "$REGION" \
  --stack-name "$HOSTING_STACK" \
  --template-file "$SOURCE_DIR/infra/hosting.yaml" \
  --parameter-overrides "DomainName=$DOMAIN" "HostedZoneId=$HOSTED_ZONE_ID" "CertificateArn=$CERTIFICATE_ARN" \
  --tags Project=RootpilotSnake "Domain=$DOMAIN" \
  --no-fail-on-empty-changeset

aws_cmd cloudformation describe-stacks --stack-name "$HOSTING_STACK" --region "$REGION" \
  --output json > "$WORK_DIR/hosting.json"
python3 - "$WORK_DIR/hosting.json" > "$WORK_DIR/outputs.txt" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    outputs = json.load(stream)["Stacks"][0]["Outputs"]
values = {item["OutputKey"]: item["OutputValue"] for item in outputs}
for key in ("BucketName", "DistributionId"):
    if not values.get(key):
        sys.exit("CloudFormation-Ausgabe fehlt: " + key)
    print(values[key])
PY
mapfile -t HOSTING_OUTPUTS < "$WORK_DIR/outputs.txt"
BUCKET="${HOSTING_OUTPUTS[0]}"
DISTRIBUTION_ID="${HOSTING_OUTPUTS[1]}"

PHASE="Website nach S3 übertragen"
# An explicit list keeps source code tooling, .git and credentials out of S3.
# Assets first, HTML last. Revalidate unversioned files after every update.
for web_file in "${WEB_FILES[@]}"; do
  case "$web_file" in
    *.html) content_type="text/html; charset=utf-8" ;;
    *.css) content_type="text/css; charset=utf-8" ;;
    *.js) content_type="application/javascript; charset=utf-8" ;;
    *.svg) content_type="image/svg+xml" ;;
  esac
  aws_cmd s3 cp "$SOURCE_DIR/$web_file" "s3://$BUCKET/$web_file" \
    --region "$REGION" --content-type "$content_type" \
    --cache-control "no-cache" --only-show-errors
done

PHASE="CloudFront-Cache aktualisieren"
INVALIDATION_ID="$(aws_cmd cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" \
  --paths '/*' --query Invalidation.Id --output text --region "$REGION")"
aws_cmd cloudfront wait invalidation-completed --distribution-id "$DISTRIBUTION_ID" \
  --id "$INVALIDATION_ID" --region "$REGION"

printf '\nAWS-Bereitstellung abgeschlossen: https://%s\n' "$DOMAIN"
printf 'S3-Bucket: %s\nCloudFront: %s\n' "$BUCKET" "$DISTRIBUTION_ID"
printf 'Updates: denselben setup.sh-Befehl erneut ausführen.\n'
printf 'Es wurden keine lokalen Tests oder lokalen Server gestartet.\n'
