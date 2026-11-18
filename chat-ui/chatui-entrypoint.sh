#!/bin/bash
# Keep both local processes supervised and shut them down cleanly together.
export PUBLIC_VERSION="$(node -p 'require("/app/package.json").version')"
mongod --bind_ip 127.0.0.1 --port 27018 --dbpath /data/db --wiredTigerCacheSizeGB 0.25 --logpath /data/mongo.log &
mongo_pid=$!
node --env-file=/app/.env --dns-result-order=ipv4first /app/server.js &
web_pid=$!
stop_children() {
    kill -TERM "$web_pid" "$mongo_pid" 2>/dev/null || true
}
trap stop_children TERM INT
wait -n "$web_pid" "$mongo_pid"
status=$?
stop_children
wait "$web_pid" "$mongo_pid" 2>/dev/null || true
exit "$status"
