# Internal Docker-network endpoint for installed Umbrel apps. This is not a
# host/LAN port and must not be rewritten as umbrel.local:8080.
exports_app_id="${EXPORTS_APP_ID:-pebble-proxy}"
case "${exports_app_id}" in
  ""|-*|*-|*[!a-z0-9-]*) exports_app_id="pebble-proxy" ;;
esac
if [ "${#exports_app_id}" -lt 2 ]; then
  exports_app_id="pebble-proxy"
fi
export APP_PEBBLE_PROXY_API_HOST="${exports_app_id}_api_1"
export APP_PEBBLE_PROXY_API_PORT="8080"
export APP_PEBBLE_PROXY_API_URL="http://${APP_PEBBLE_PROXY_API_HOST}:${APP_PEBBLE_PROXY_API_PORT}"
unset exports_app_id
