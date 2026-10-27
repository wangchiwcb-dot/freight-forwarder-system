#!/usr/bin/env sh
set -eu
# Certbot runs this only after a successful renewal. Validate before reloading.
/usr/bin/docker exec freight-quotes-v2-web-1 nginx -t
/usr/bin/docker exec freight-quotes-v2-web-1 nginx -s reload
logger -t freight-quotes-https "Nginx loaded the renewed certificate"
