# Prepare an observed foreground app or start it directly from its launcher tile.
acquire_session_lock || exit 0
trap release_session_lock EXIT
CURRENT_PID=$(twitch_pid); CURRENT_PID=${CURRENT_PID:-0}
CURRENT_START=0
[ "$CURRENT_PID" = 0 ] || CURRENT_START=$(process_start_time "$CURRENT_PID")
if [ "$CURRENT_PID:$CURRENT_START" != "$OBSERVED_PID:$OBSERVED_START" ] ||
        { [ "$FROM_TILE" = 0 ] && ! twitch_is_foreground; }; then
    echo raced=1
    exit 0
fi
if [ -f "$SESSION_DIR/starting" ]; then
    recover_unfinished_startup || exit 1
    echo raced=1
    exit 0
fi
if read_owned_session; then
    if [ "$FROM_TILE" = 1 ]; then
        if [ "$SESSION_PID:$SESSION_START" = "$CURRENT_PID:$CURRENT_START" ] &&
                [ -f "$SESSION_DIR/state.json" ] && inspector_is_listening "$INSPECTOR_PORT" && isolation_rules_present; then
            if ! twitch_is_foreground; then
                app_launcher -s "$TWITCH_APP_ID" -u "$APP_USER_ID" >/dev/null 2>&1
            fi
            echo reused=1
            exit 0
        fi
        close_owned_twitch
    fi
    retire_owned_session || exit 1
    INSPECTOR_PORT=
fi
iptables -S INPUT >/dev/null
if ipv6_available; then ip6tables -S INPUT >/dev/null; fi
if iptables -nL "$FIREWALL_CHAIN" >/dev/null 2>&1 ||
        { ipv6_available && ip6tables -nL "$FIREWALL_CHAIN" >/dev/null 2>&1; }; then
    echo foreign_chain=1
    exit 0
fi
SESSION_PREPARED=0
HAD_LAUNCH=0
LAUNCHER_PID=

restore_after_failed_preparation() {
    if [ "$SESSION_PREPARED" != 1 ]; then
        WAS_FOREGROUND=0
        if twitch_is_foreground; then WAS_FOREGROUND=1; fi
        if [ -n "$LAUNCHER_PID" ]; then
            kill "$LAUNCHER_PID" 2>/dev/null || true
            wait "$LAUNCHER_PID" 2>/dev/null || true
        fi
        RULES_RETIRED=1
        if [ -f "$SESSION_DIR/starting" ]; then
            recover_unfinished_startup || RULES_RETIRED=0
        elif [ "$HAD_LAUNCH" = 1 ] && read_owned_session; then
            close_owned_twitch
            retire_owned_session || RULES_RETIRED=0
        fi
        if [ "$FROM_TILE" = 0 ] && [ "$HAD_LAUNCH" = 1 ] && [ "$RULES_RETIRED" = 1 ] && [ "$WAS_FOREGROUND" = 1 ]; then
            app_launcher -s "$TWITCH_APP_ID" -u "$APP_USER_ID" >/dev/null 2>&1 || true
        fi
    fi
    release_session_lock
}
trap restore_after_failed_preparation EXIT
trap 'exit 1' HUP INT TERM
startup_stamp=$(process_start_time "$$")
[ -n "$startup_stamp" ] || exit 1
printf '%s %s\n' "$$" "$startup_stamp" > "$SESSION_DIR/starting"
nohup sh -c "echo $CLEANUP_GUARD_BASE64 | base64 -d | sh -s -- startup $$ $startup_stamp" > "$SESSION_DIR/startup-guard.log" 2>&1 </dev/null &

iptables -N "$FIREWALL_CHAIN"
touch "$SESSION_DIR/ipv4-chain"
iptables -A "$FIREWALL_CHAIN" -i lo -j ACCEPT
iptables -A "$FIREWALL_CHAIN" -j REJECT
# Tizen reports the dynamic inspector port after opening it. Protect new inbound connections until then.
add_startup_jump iptables
if ipv6_available; then
    ip6tables -N "$FIREWALL_CHAIN"
    touch "$SESSION_DIR/ipv6-chain"
    ip6tables -A "$FIREWALL_CHAIN" -j REJECT
    add_startup_jump ip6tables
fi

rm -f "$SESSION_DIR/launch.out"
touch "$SESSION_DIR/launch-requested"
HAD_LAUNCH=1
if [ "$CURRENT_PID" != 0 ]; then
    app_launcher -t "$TWITCH_APP_ID" -u "$APP_USER_ID" >/dev/null 2>&1 || true
fi
app_launcher -w -s "$TWITCH_APP_ID" -u "$APP_USER_ID" > "$SESSION_DIR/launch.out" 2>&1 &
LAUNCHER_PID=$!
# Wait up to eight seconds for the launcher to report the PID and inspector port.
launch_poll=0
while [ "$launch_poll" -lt 80 ]; do
    if grep -q "port: [0-9]" "$SESSION_DIR/launch.out"; then break; fi
    if ! kill -0 "$LAUNCHER_PID" 2>/dev/null; then break; fi
    sleep 0.1
    launch_poll=$((launch_poll+1))
done
kill "$LAUNCHER_PID" 2>/dev/null || true
wait "$LAUNCHER_PID" 2>/dev/null || true
LAUNCHER_PID=
INSPECTOR_PORT=$(sed -n 's/.* port: \([0-9]*\).*/\1/p' "$SESSION_DIR/launch.out" | head -1)
SESSION_PID=$(sed -n 's/.* pid = \([0-9]*\).*/\1/p' "$SESSION_DIR/launch.out" | head -1)
case "$INSPECTOR_PORT:$SESSION_PID" in
    *[!0-9:]*|''|:*) echo launch_failed=1; exit 1 ;;
esac
[ -n "$INSPECTOR_PORT" ] && [ -n "$SESSION_PID" ] &&
    [ "$INSPECTOR_PORT" -ge 1024 ] && [ "$INSPECTOR_PORT" -le 65535 ] || exit 1
SESSION_START=$(process_start_time "$SESSION_PID")
[ -n "$SESSION_START" ] && [ "$(twitch_pid)" = "$SESSION_PID" ] || exit 1
printf "%s %s %s\n" "$SESSION_PID" "$SESSION_START" "$INSPECTOR_PORT" > "$SESSION_DIR/owner.tmp"
chmod 600 "$SESSION_DIR/owner.tmp"
mv "$SESSION_DIR/owner.tmp" "$SESSION_DIR/owner"

iptables -I INPUT 1 -p tcp --dport "$INSPECTOR_PORT" -j "$FIREWALL_CHAIN"
iptables -I INPUT 1 -i lo -s 127.0.0.2 -p tcp --sport "$INSPECTOR_PORT" -j ACCEPT
iptables -I OUTPUT 1 -o lo -d 127.0.0.2 -p tcp --dport "$INSPECTOR_PORT" -j ACCEPT
iptables -I OUTPUT 1 -o lo -s 127.0.0.2 -p tcp --sport "$INSPECTOR_PORT" -j ACCEPT
if ipv6_available; then ip6tables -I INPUT 1 ! -i lo -p tcp --dport "$INSPECTOR_PORT" -j "$FIREWALL_CHAIN"; fi
isolation_rules_present
inspector_is_listening "$INSPECTOR_PORT" tcp
ipv6_status=0
inspector_is_listening "$INSPECTOR_PORT" tcp6 || ipv6_status=$?
[ "$ipv6_status" = 1 ] || { echo ipv6_unconfirmed=1; exit 1; }
remove_startup_guard
printf '{"format":1,"pid":%s,"start":"%s","port":%s,"ready":true}\n' \
    "$SESSION_PID" "$SESSION_START" "$INSPECTOR_PORT" > "$SESSION_DIR/state.tmp"
chmod 644 "$SESSION_DIR/state.tmp"
mv "$SESSION_DIR/state.tmp" "$SESSION_DIR/state.json"
nohup sh -c "echo $CLEANUP_GUARD_BASE64 | base64 -d | sh" > "$SESSION_DIR/guard.log" 2>&1 </dev/null &
SESSION_PREPARED=1
echo ready=1
