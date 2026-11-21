# Runtime paths and identity checks shared by the session commands.
set -e
SESSION_DIR=/run/vetro-twitch-session
TWITCH_APP_ID=Jz7aUrV2Q4.Twitch
FIREWALL_CHAIN=VETRO_TWITCH_AUTO

[ ! -L "$SESSION_DIR" ] || exit 40
if [ -e "$SESSION_DIR" ]; then
    [ -d "$SESSION_DIR" ] && [ "$(stat -c %u "$SESSION_DIR")" = 0 ] || exit 40
else
    mkdir "$SESSION_DIR"
fi
chmod 755 "$SESSION_DIR"

twitch_pid() {
    running_apps=$(app_launcher -S 2>/dev/null) || return 2
    printf '%s\n' "$running_apps" |
        awk -v app="$TWITCH_APP_ID" '$1==app {gsub(/[()]/,"",$2); print $2; exit}'
}

# PID plus kernel start time identifies one process, including after PID reuse.
process_start_time() {
    awk '{print $22}' "/proc/$1/stat" 2>/dev/null || true
}

twitch_is_foreground() {
    vconftool get memory/appfw/current_fullscreen_appid 2>/dev/null |
        grep -Fq "value = $TWITCH_APP_ID (String)"
}

inspector_is_listening() {
    listeners=$(netstat -ltn 2>/dev/null) || return 2
    printf '%s\n' "$listeners" |
        awk -v port_suffix=":$1" -v family="${2:-}" '
            $4 ~ port_suffix"$" && $6=="LISTEN" && (family=="" || $1==family) {found=1} END {exit !found}'
}

ipv6_available() {
    [ -e /proc/net/tcp6 ]
}

read_owned_session() {
    SESSION_PID=; SESSION_START=; INSPECTOR_PORT=
    [ -f "$SESSION_DIR/owner" ] && [ ! -L "$SESSION_DIR/owner" ] || return 1
    read SESSION_PID SESSION_START INSPECTOR_PORT < "$SESSION_DIR/owner"
    case "$SESSION_PID:$SESSION_START:$INSPECTOR_PORT" in
        *[!0-9:]*|::*|'') return 1 ;;
    esac
    [ -n "$SESSION_PID" ] && [ -n "$SESSION_START" ] &&
        [ "$INSPECTOR_PORT" -ge 1024 ] && [ "$INSPECTOR_PORT" -le 65535 ]
}

isolation_rules_present() {
    iptables -C INPUT -p tcp --dport "$INSPECTOR_PORT" -j "$FIREWALL_CHAIN" &&
    iptables -C "$FIREWALL_CHAIN" -i lo -j ACCEPT &&
    iptables -C "$FIREWALL_CHAIN" -j REJECT &&
    iptables -C INPUT -i lo -s 127.0.0.2 -p tcp --sport "$INSPECTOR_PORT" -j ACCEPT &&
    iptables -C OUTPUT -o lo -d 127.0.0.2 -p tcp --dport "$INSPECTOR_PORT" -j ACCEPT &&
    iptables -C OUTPUT -o lo -s 127.0.0.2 -p tcp --sport "$INSPECTOR_PORT" -j ACCEPT &&
    { ! ipv6_available || {
        ip6tables -C INPUT ! -i lo -p tcp --dport "$INSPECTOR_PORT" -j "$FIREWALL_CHAIN" &&
        ip6tables -C "$FIREWALL_CHAIN" -j REJECT
    }; }
}

inspect_session() {
    # Inspect app identity and verify any published inspector session.
    CURRENT_PID=$(twitch_pid); CURRENT_PID=${CURRENT_PID:-0}
    CURRENT_START=0
    IS_FOREGROUND=0
    [ "$CURRENT_PID" = 0 ] || CURRENT_START=$(process_start_time "$CURRENT_PID")
    if twitch_is_foreground; then IS_FOREGROUND=1; fi
    printf "pid=%s\nstart=%s\nforeground=%s\n" "$CURRENT_PID" "$CURRENT_START" "$IS_FOREGROUND"
    if [ -f "$SESSION_DIR/starting" ]; then
        echo unsafe=1
    elif read_owned_session; then
        if [ "$SESSION_PID" = "$CURRENT_PID" ] && [ "$SESSION_START" = "$CURRENT_START" ] &&
                inspector_is_listening "$INSPECTOR_PORT" && [ -f "$SESSION_DIR/state.json" ]; then
            if isolation_rules_present; then
                printf "state="; cat "$SESSION_DIR/state.json"
            else
                echo unsafe=1
            fi
        else
            echo stale=1
        fi
    fi
}
