#!/bin/bash
trap "" HUP
cd ~/storacha-export
node bin/storacha-export.js \
  --backend kubo --kubo-api http://127.0.0.1:5001 \
  --serve 0.0.0.0:8087 \
  --html-out /store/fastphils/www/storacha-export.html \
  "$@"
