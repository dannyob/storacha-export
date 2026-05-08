#!/bin/sh
# recover.sh — try to fetch files listed in a .missing.txt via a
# public IPFS gateway. The gateway sometimes succeeds where
# storacha-export's direct shard lookup didn't.
#
# Usage:
#   sh ./recover.sh files/<space>/<root>.missing.txt
#
# To process every missing file across every space at once:
#   find files -name '*.missing.txt' | xargs -n1 sh ./recover.sh
#
# Each input line is: <cid><tab><filename>
# Lines starting with # and blank lines are skipped.
#
# Files are written to the current directory (so cd into where you want
# them first; usually that's the same dir as the .missing.txt). For each
# attempt the script prints "OK <cid> <filename>" on success or
# "FAILED <cid> <filename>" on failure, so you can grep results.

set -u

GATEWAY="${GATEWAY:-https://w3s.link}"

if [ $# -ne 1 ]; then
    echo "usage: $0 <missing.txt>" >&2
    exit 64
fi

file=$1
if [ ! -r "$file" ]; then
    echo "$0: cannot read: $file" >&2
    exit 66
fi

ok=0
failed=0
while IFS="$(printf '\t')" read -r cid name; do
    case "$cid" in
        ''|\#*) continue ;;
    esac
    [ -n "$name" ] || continue

    dir=$(dirname -- "$name")
    if [ "$dir" != "." ]; then
        mkdir -p -- "$dir" || { echo "FAILED $cid $name (mkdir)" >&2; failed=$((failed+1)); continue; }
    fi

    if curl -sfL -o "$name" "$GATEWAY/ipfs/$cid"; then
        echo "OK $cid $name"
        ok=$((ok+1))
    else
        echo "FAILED $cid $name"
        failed=$((failed+1))
    fi
done < "$file"

echo "" >&2
echo "Recovered $ok file(s), $failed failed." >&2
[ "$failed" -eq 0 ]
