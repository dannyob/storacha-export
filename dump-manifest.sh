#!/bin/sh
# Dump the storacha-export DB to plain-text manifests for offline use
# (e.g. when bulk-importing into kubo). Produces two TSVs:
#
#   uploads.tsv   space_name <TAB> root_cid <TAB> status <TAB> shard_count <TAB> bytes_total
#   shards.tsv    space_name <TAB> root_cid <TAB> shard_order <TAB> shard_cid <TAB> location_url
#
# Filenames follow the convention <root_cid>.shard-<order>.car for
# multi-shard uploads, or <root_cid>.car for the legacy single-CAR
# layout — both derivable from root_cid without consulting the DB.
#
# Usage: dump-manifest.sh [--db PATH] [--out DIR]

set -eu

DB=./storacha-export.db
OUT=./manifest

while [ $# -gt 0 ]; do
  case "$1" in
    --db)  DB=$2;  shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -f "$DB" ] || { echo "no DB at $DB" >&2; exit 1; }
mkdir -p "$OUT"

{
  printf 'space_name\troot_cid\tstatus\tshard_count\tbytes_total\n'
  sqlite3 -separator '	' "$DB" \
    "SELECT space_name, root_cid, status, shard_count, bytes_total
     FROM uploads ORDER BY space_name, root_cid;"
} > "$OUT/uploads.tsv"

{
  printf 'space_name\troot_cid\tshard_order\tshard_cid\tlocation_url\n'
  sqlite3 -separator '	' "$DB" \
    "SELECT u.space_name, s.upload_root, s.shard_order, s.shard_cid, s.location_url
     FROM shards s JOIN uploads u ON u.root_cid = s.upload_root
     ORDER BY u.space_name, s.upload_root, s.shard_order;"
} > "$OUT/shards.tsv"

uploads=$(($(wc -l < "$OUT/uploads.tsv") - 1))
shards=$(($(wc -l < "$OUT/shards.tsv") - 1))
echo "$uploads uploads, $shards shards -> $OUT/"
