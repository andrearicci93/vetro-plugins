# Locking and mutation helpers, omitted from periodic inspection commands.
acquire_session_lock() {
    command -v flock >/dev/null 2>&1 || { echo lock_unavailable=1; return 1; }
    umask 077
    exec 9>>"$SESSION_DIR/session.lock"
    if flock -n 9; then return 0; fi
    release_session_lock
    echo busy
    return 1
}

release_session_lock() {
    exec 9>&-
}

add_startup_jump() {
    "$1" -I INPUT 1 ! -i lo -p tcp --syn -j "$FIREWALL_CHAIN" &&
    "$1" -C INPUT ! -i lo -p tcp --syn -j "$FIREWALL_CHAIN"
}

remove_startup_jump() {
    rules=$("$1" -S INPUT 2>/dev/null) || return 1
    if printf '%s\n' "$rules" | awk -v chain="$FIREWALL_CHAIN" '
        $0 ~ /--(syn|tcp-flags) / && $NF==chain {found=1} END {exit !found}'; then
        "$1" -D INPUT ! -i lo -p tcp --syn -j "$FIREWALL_CHAIN" || return 1
    fi
}

remove_startup_guard() {
    [ -f "$SESSION_DIR/starting" ] || return 0
    if [ -f "$SESSION_DIR/ipv4-chain" ]; then remove_startup_jump iptables || return 1; fi
    if [ -f "$SESSION_DIR/ipv6-chain" ]; then remove_startup_jump ip6tables || return 1; fi
    rm -f "$SESSION_DIR/starting" "$SESSION_DIR/launch-requested"
}

remove_isolation_rules() {
    remove_startup_guard || return 1
    if [ -n "$INSPECTOR_PORT" ]; then
        iptables -D INPUT -p tcp --dport "$INSPECTOR_PORT" -j "$FIREWALL_CHAIN" 2>/dev/null || true
        iptables -D INPUT -i lo -s 127.0.0.2 -p tcp --sport "$INSPECTOR_PORT" -j ACCEPT 2>/dev/null || true
        iptables -D OUTPUT -o lo -d 127.0.0.2 -p tcp --dport "$INSPECTOR_PORT" -j ACCEPT 2>/dev/null || true
        iptables -D OUTPUT -o lo -s 127.0.0.2 -p tcp --sport "$INSPECTOR_PORT" -j ACCEPT 2>/dev/null || true
        if [ -f "$SESSION_DIR/ipv6-chain" ]; then
            ip6tables -D INPUT ! -i lo -p tcp --dport "$INSPECTOR_PORT" -j "$FIREWALL_CHAIN" 2>/dev/null || true
        fi
    fi
    if [ -f "$SESSION_DIR/ipv4-chain" ] || [ -f "$SESSION_DIR/owner" ]; then
        iptables -F "$FIREWALL_CHAIN" 2>/dev/null || true
        iptables -X "$FIREWALL_CHAIN" 2>/dev/null || true
    fi
    if [ -f "$SESSION_DIR/ipv6-chain" ]; then
        ip6tables -F "$FIREWALL_CHAIN" 2>/dev/null || true
        ip6tables -X "$FIREWALL_CHAIN" 2>/dev/null || true
    fi
    rm -f "$SESSION_DIR/state.json" "$SESSION_DIR/owner" "$SESSION_DIR/ipv4-chain" "$SESSION_DIR/ipv6-chain"
}

retire_owned_session() {
    rm -f "$SESSION_DIR/state.json"
    # Wait at most three seconds. An unavailable socket table is not proof of closure.
    listener_checks=0
    while [ "$listener_checks" -le 30 ]; do
        listener_status=0
        inspector_is_listening "$INSPECTOR_PORT" || listener_status=$?
        if [ "$listener_status" = 1 ]; then
            remove_isolation_rules && return 0
            break
        fi
        [ "$listener_checks" -lt 30 ] || break
        sleep 0.1
        listener_checks=$((listener_checks+1))
    done
    echo cleanup_pending=1
    return 1
}

close_owned_twitch() {
    if [ "$(process_start_time "$SESSION_PID")" = "$SESSION_START" ] && [ "$(twitch_pid)" = "$SESSION_PID" ]; then
        app_launcher -t "$TWITCH_APP_ID" -u "$APP_USER_ID" >/dev/null 2>&1 || true
    fi
}

recover_unfinished_startup() {
    [ -f "$SESSION_DIR/starting" ] || return 0
    if read_owned_session; then
        close_owned_twitch
        retire_owned_session
        return
    fi
    if [ -f "$SESSION_DIR/launch-requested" ]; then
        app_launcher -t "$TWITCH_APP_ID" -u "$APP_USER_ID" >/dev/null 2>&1 || true
        attempts=0
        while [ "$attempts" -le 30 ]; do
            if app_pid=$(twitch_pid) && [ -z "$app_pid" ]; then break; fi
            sleep 0.1
            attempts=$((attempts+1))
        done
        [ "$attempts" -le 30 ] || { echo cleanup_pending=1; return 1; }
        reported_port=$(sed -n 's/.* port: \([0-9]*\).*/\1/p' "$SESSION_DIR/launch.out" 2>/dev/null | head -1)
        if [ -n "$reported_port" ] && [ "$reported_port" -ge 1024 ] && [ "$reported_port" -le 65535 ]; then
            INSPECTOR_PORT=$reported_port
            retire_owned_session
            return
        fi
        netstat -ltn >/dev/null 2>&1 || { echo cleanup_pending=1; return 1; }
    fi
    remove_isolation_rules || { echo cleanup_pending=1; return 1; }
}

cleanup_session() {
    # Close/restore Twitch only when requested; always retain rules until the listener closes.
    acquire_session_lock || exit 0
    trap release_session_lock EXIT
    if [ -f "$SESSION_DIR/starting" ]; then
        recover_unfinished_startup || return 0
    elif read_owned_session; then
        WAS_FOREGROUND=0
        if [ "$RESTORE_NORMAL_APP" = 1 ]; then
            if twitch_is_foreground; then WAS_FOREGROUND=1; fi
            close_owned_twitch
        fi
        RULES_RETIRED=1
        retire_owned_session || RULES_RETIRED=0
        if [ "$RESTORE_NORMAL_APP" = 1 ] && [ "$WAS_FOREGROUND" = 1 ] && [ "$RULES_RETIRED" = 1 ]; then
            app_launcher -s "$TWITCH_APP_ID" -u "$APP_USER_ID" >/dev/null 2>&1 || true
        fi
    fi
    echo cleaned=1
}

guard_session() {
    # Runs independently of Vetro; retain isolation until this listener disappears.
    read_owned_session || exit 0
    GUARD_PID=$SESSION_PID
    GUARD_START=$SESSION_START
    GUARD_PORT=$INSPECTOR_PORT
    while :; do
        listener_status=0
        inspector_is_listening "$GUARD_PORT" || listener_status=$?
        [ "$listener_status" != 1 ] || break
        sleep 5
    done
    acquire_session_lock || exit 0
    trap release_session_lock EXIT
    if read_owned_session && [ "$SESSION_PID:$SESSION_START:$INSPECTOR_PORT" = "$GUARD_PID:$GUARD_START:$GUARD_PORT" ]; then
        retire_owned_session || true
    fi
}

guard_startup() {
    owner_pid=$1
    owner_start=$2
    while [ "$(cat "$SESSION_DIR/starting" 2>/dev/null || true)" = "$owner_pid $owner_start" ]; do
        if [ "$(process_start_time "$owner_pid")" != "$owner_start" ] && acquire_session_lock; then
            trap release_session_lock EXIT
            if [ "$(cat "$SESSION_DIR/starting" 2>/dev/null || true)" = "$owner_pid $owner_start" ]; then
                recover_unfinished_startup || true
            fi
            release_session_lock
            trap - EXIT
        fi
        sleep 1
    done
}
