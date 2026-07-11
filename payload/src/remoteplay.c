#include "remoteplay.h"

#include <ps5/kernel.h>

#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "sys_registry.h"

#define RP_STATE_IDLE      0
#define RP_STATE_STARTING  1
#define RP_STATE_WAITING   2
#define RP_STATE_PAIRED    3
#define RP_STATE_FAILED    4
#define RP_STATE_TIMEOUT   5

#define RP_WAIT_SECONDS    300

/* libSceUserService — already link-time bound (-lSceUserService in the
 * Makefile) so a plain extern declaration is enough; dlsym(RTLD_DEFAULT)
 * resolves it at runtime. Same pattern as runtime.c line 9516. */
extern int sceUserServiceGetForegroundUser(int *user_id);

/* libSceRemoteplay function pointer types. The library is NOT link-time
 * bound (it's an optional SPRX; adding a DT_NEEDED entry would brick the
 * payload on firmwares where the module is absent), so we dlopen it once
 * and dlsym each symbol. NULL after resolve means "not available on this
 * firmware" — callers surface a clean error instead of crashing. */
typedef int (*rp_init_fn)(void);
typedef int (*rp_get_op_status_fn)(int32_t user_id);
typedef int (*rp_get_conn_status_fn)(void);
typedef int (*rp_gen_pin_fn)(int32_t user_id, char *pin, size_t pin_size);
typedef int (*rp_is_playing_fn)(void);
typedef int (*rp_get_mode_fn)(void);
typedef int (*rp_disconnect_fn)(void);

static rp_init_fn           g_init       = NULL;
static rp_get_op_status_fn  g_op_status  = NULL;
static rp_get_conn_status_fn g_conn_status = NULL;
static rp_gen_pin_fn        g_gen_pin    = NULL;
static rp_is_playing_fn     g_is_playing = NULL;
static rp_get_mode_fn       g_get_mode   = NULL;
static rp_disconnect_fn     g_disconnect = NULL;

static pthread_once_t g_resolve_once = PTHREAD_ONCE_INIT;
static int g_resolved = 0;

static void resolve_impl(void) {
    /* libSceRemoteplay.sprx may live in several system paths depending
     * on firmware. Try each and stop at the first dlopen success, same
     * strategy as bgft.c's libSceBgft lookup. RTLD_GLOBAL so the symbols
     * are visible to subsequent dlsym(RTLD_DEFAULT) if needed. */
    static const char *const RP_LIB_PATHS[] = {
        "/system/common/lib/libSceRemoteplay.sprx",
        "/system_ex/common/lib/libSceRemoteplay.sprx",
        "/system/priv/lib/libSceRemoteplay.sprx",
    };
    void *lib = NULL;
    for (size_t i = 0; i < sizeof(RP_LIB_PATHS) / sizeof(RP_LIB_PATHS[0]); i++) {
        lib = dlopen(RP_LIB_PATHS[i], RTLD_NOW | RTLD_GLOBAL);
        if (lib) break;
    }
    if (!lib) {
        /* Fall back to RTLD_DEFAULT in case another process already
         * pulled the module into our address space. */
        lib = RTLD_DEFAULT;
    }
    g_init       = (rp_init_fn)dlsym(lib, "sceRemoteplayInitialize");
    g_op_status  = (rp_get_op_status_fn)dlsym(lib, "sceRemoteplayGetOperationStatus");
    g_conn_status= (rp_get_conn_status_fn)dlsym(lib, "sceRemoteplayGetConnectionStatus");
    g_gen_pin    = (rp_gen_pin_fn)dlsym(lib, "sceRemoteplayGeneratePinCode");
    g_is_playing = (rp_is_playing_fn)dlsym(lib, "sceRemoteplayIsRemotePlaying");
    g_get_mode   = (rp_get_mode_fn)dlsym(lib, "sceRemoteplayGetRpMode");
    g_disconnect = (rp_disconnect_fn)dlsym(lib, "sceRemoteplayDisconnect");
    g_resolved = 1;
}

static void resolve_once(void) {
    pthread_once(&g_resolve_once, resolve_impl);
}

/* ── Account ID auto-detect via the registry ──────────────────────────
 *
 * Chiaki/pxplay need the console's PSN account ID (base64 of the 8-byte
 * raw id) in addition to the pairing PIN. Sony buries it; we read it
 * straight from the registry for the foreground user. Ported from
 * elf-arsenal's remoteplay.c, adapted to ps5upload's sys_registry
 * wrappers (dlsym'd sceRegMgr, read-only — no writes to the registry).
 *
 * The key IDs are computed with Sony's regmgr entry-number formula:
 * (slot-1)*stride + base, with a per-namespace base for the user-id and
 * account-id slot tables. These bases match ps5-payload-dev/regdump. */
static uint32_t rp_regmgr_ent_num(uint32_t slot, uint32_t max,
                                  uint32_t stride, uint32_t base,
                                  uint32_t fallback) {
    if (slot < 1 || slot > max) return fallback;
    return (slot - 1) * stride + base;
}

static uint32_t rp_key_user_id(uint32_t slot) {
    return rp_regmgr_ent_num(slot, 16, 65536, 125829376, 127140096);
}

static uint32_t rp_key_account_id(uint32_t slot) {
    return rp_regmgr_ent_num(slot, 16, 65536, 125830400, 127141120);
}

static const char rp_b64tab[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* Standard base64 with '=' padding. Note: the elf-arsenal reference this
 * was ported from has a padding bug — its `i > inlen` guards can never
 * fire (i is capped at inlen by the read guards), so it emits trailing
 * 'A's instead of '=' and an 8-byte account id came out as
 * "…d4gA" instead of the correct "…d4g=". We drive padding off the
 * remaining-byte count of each group instead, which pads correctly for
 * all lengths (verified against RFC 4648 test vectors). */
static void rp_base64_encode(const uint8_t *in, size_t inlen, char *out) {
    size_t i = 0, j = 0;
    while (i < inlen) {
        size_t rem = inlen - i; /* bytes left in this group: 1, 2, or 3 */
        uint32_t o0 = in[i];
        uint32_t o1 = rem > 1 ? in[i + 1] : 0;
        uint32_t o2 = rem > 2 ? in[i + 2] : 0;
        uint32_t v = (o0 << 16) | (o1 << 8) | o2;
        out[j++] = rp_b64tab[(v >> 18) & 63];
        out[j++] = rp_b64tab[(v >> 12) & 63];
        out[j++] = rem > 1 ? rp_b64tab[(v >> 6) & 63] : '=';
        out[j++] = rem > 2 ? rp_b64tab[(v) & 63] : '=';
        i += 3;
    }
    out[j] = '\0';
}

/* Fill `out` with the foreground user's base64 account id, or leave it
 * an empty string if it can't be resolved (no user logged in, registry
 * symbols unavailable on this firmware, etc.). Never fails hard — a
 * missing account id just means the UI shows only the PIN. */
static void rp_get_account_id(char *out, size_t out_sz) {
    if (!out || out_sz == 0) return;
    out[0] = '\0';

    int uid = 0;
    if (sceUserServiceGetForegroundUser(&uid) != 0 || uid <= 0) return;

    /* Find the registry slot whose user-id matches the foreground user. */
    int slot = -1;
    for (uint32_t i = 1; i <= 16; i++) {
        int reg_uid = 0;
        if (sys_registry_get_int(rp_key_user_id(i), &reg_uid, NULL) == 0 &&
            reg_uid == uid) {
            slot = (int)i;
            break;
        }
    }
    if (slot < 0) return;

    uint8_t raw[8] = {0};
    if (sys_registry_get_bin(rp_key_account_id((uint32_t)slot), raw,
                             sizeof(raw), NULL) != 0) {
        return;
    }

    char b64[16];
    rp_base64_encode(raw, sizeof(raw), b64);
    snprintf(out, out_sz, "%s", b64);
}

static void rp_json_escape(const char *src, char *dst, size_t dst_cap) {
    if (!src || !dst || dst_cap == 0) return;
    size_t i = 0;
    while (*src && i + 2 < dst_cap) {
        char c = *src++;
        if (c == '"' || c == '\\') {
            dst[i++] = '\\';
            dst[i++] = c;
        } else if (c == '\n') {
            dst[i++] = '\\';
            dst[i++] = 'n';
        } else if ((unsigned char)c < 0x20) {
            continue;
        } else {
            dst[i++] = c;
        }
    }
    dst[i] = 0;
}

static pthread_mutex_t g_rp_mtx = PTHREAD_MUTEX_INITIALIZER;
static int g_rp_state = RP_STATE_IDLE;
static char g_rp_err[128] = "";
static char g_rp_pin[16] = "";
static char g_rp_account_id[32] = "";
static time_t g_rp_deadline = 0;

static const char *state_name(int s) {
    switch (s) {
        case RP_STATE_IDLE: return "idle";
        case RP_STATE_STARTING: return "starting";
        case RP_STATE_WAITING: return "waiting";
        case RP_STATE_PAIRED: return "paired";
        case RP_STATE_FAILED: return "failed";
        case RP_STATE_TIMEOUT: return "timeout";
        default: return "unknown";
    }
}

void remoteplay_init(void) {
    pthread_mutex_lock(&g_rp_mtx);
    g_rp_state = RP_STATE_IDLE;
    g_rp_err[0] = 0;
    g_rp_pin[0] = 0;
    g_rp_account_id[0] = 0;
    g_rp_deadline = 0;
    pthread_mutex_unlock(&g_rp_mtx);
}

int remoteplay_request(const char *manual_account_id) {
    resolve_once();

    /* Resolve the account id before taking the lock — it does registry +
     * user-service IPC we don't want to hold g_rp_mtx across (status
     * polls contend on it). A caller-supplied id wins; otherwise
     * auto-detect the foreground user's so the UI can show what Chiaki/
     * pxplay need without the user hunting it down. */
    char account_id[sizeof(g_rp_account_id)] = "";
    if (manual_account_id && manual_account_id[0]) {
        snprintf(account_id, sizeof(account_id), "%s", manual_account_id);
    } else {
        rp_get_account_id(account_id, sizeof(account_id));
    }

    pthread_mutex_lock(&g_rp_mtx);
    g_rp_pin[0] = 0;
    snprintf(g_rp_account_id, sizeof(g_rp_account_id), "%s", account_id);
    g_rp_err[0] = 0;
    g_rp_deadline = 0;
    if (!g_resolved) {
        g_rp_state = RP_STATE_FAILED;
        snprintf(g_rp_err, sizeof(g_rp_err), "remoteplay symbols not resolved");
        pthread_mutex_unlock(&g_rp_mtx);
        return -1;
    }
    if (!g_init || !g_gen_pin) {
        g_rp_state = RP_STATE_FAILED;
        snprintf(g_rp_err, sizeof(g_rp_err), "sceRemoteplayInitialize/GeneratePinCode unavailable");
        pthread_mutex_unlock(&g_rp_mtx);
        return -1;
    }

    g_rp_state = RP_STATE_STARTING;
    pthread_mutex_unlock(&g_rp_mtx);

    /* Initialize the Remoteplay module. Sony's init is idempotent — a
     * second call returns a benign "already initialised" code which we
     * treat as success. */
    int rc = g_init();
    if (rc != 0) {
        pthread_mutex_lock(&g_rp_mtx);
        g_rp_state = RP_STATE_FAILED;
        snprintf(g_rp_err, sizeof(g_rp_err),
                 "sceRemoteplayInitialize failed: 0x%08X", (unsigned)rc);
        pthread_mutex_unlock(&g_rp_mtx);
        return -1;
    }

    /* Get the foreground user id. sceUserServiceGetForegroundUser is
     * link-time bound via -lSceUserService, so the extern declaration
     * above resolves directly. A uid <= 0 means no user is logged in. */
    int uid = 0;
    rc = sceUserServiceGetForegroundUser(&uid);
    if (rc != 0 || uid <= 0) {
        pthread_mutex_lock(&g_rp_mtx);
        g_rp_state = RP_STATE_FAILED;
        snprintf(g_rp_err, sizeof(g_rp_err),
                 "no foreground user (rc=0x%08X uid=%d)", (unsigned)rc, uid);
        pthread_mutex_unlock(&g_rp_mtx);
        return -1;
    }

    /* Generate the pairing PIN. The caller enters this in the Remote
     * Play client to pair with this console. */
    char pin[16] = {0};
    rc = g_gen_pin((int32_t)uid, pin, sizeof(pin));
    if (rc != 0 || !pin[0]) {
        pthread_mutex_lock(&g_rp_mtx);
        g_rp_state = RP_STATE_FAILED;
        snprintf(g_rp_err, sizeof(g_rp_err),
                 "sceRemoteplayGeneratePinCode failed: 0x%08X", (unsigned)rc);
        pthread_mutex_unlock(&g_rp_mtx);
        return -1;
    }

    pthread_mutex_lock(&g_rp_mtx);
    snprintf(g_rp_pin, sizeof(g_rp_pin), "%s", pin);
    g_rp_state = RP_STATE_WAITING;
    g_rp_deadline = time(NULL) + RP_WAIT_SECONDS;
    g_rp_err[0] = 0;
    pthread_mutex_unlock(&g_rp_mtx);
    return 0;
}

int remoteplay_get_status(char *buf, size_t cap) {
    if (!buf || cap == 0) return -1;
    resolve_once();

    pthread_mutex_lock(&g_rp_mtx);
    int s = g_rp_state;

    /* If we're WAITING, probe the connection/playing status and advance
     * the state machine when a device pairs/connects or the countdown
     * expires. Done under the lock so the JSON snapshot below is
     * consistent with the probed state. */
    if (s == RP_STATE_WAITING) {
        if (g_resolved && g_conn_status && g_is_playing) {
            int conn = g_conn_status();
            int playing = g_is_playing();
            if (conn != 0 || playing != 0) {
                g_rp_state = RP_STATE_PAIRED;
                s = RP_STATE_PAIRED;
            }
        }
        if (s == RP_STATE_WAITING && g_rp_deadline != 0) {
            if (time(NULL) >= g_rp_deadline) {
                g_rp_state = RP_STATE_TIMEOUT;
                s = RP_STATE_TIMEOUT;
            }
        }
    }

    int seconds_left = 0;
    if (s == RP_STATE_WAITING && g_rp_deadline != 0) {
        time_t now = time(NULL);
        if (now < g_rp_deadline) {
            seconds_left = (int)(g_rp_deadline - now);
        }
    }

    char err_esc[160];
    char pin_esc[32];
    char acct_esc[48];
    rp_json_escape(g_rp_err, err_esc, sizeof(err_esc));
    rp_json_escape(g_rp_pin, pin_esc, sizeof(pin_esc));
    rp_json_escape(g_rp_account_id, acct_esc, sizeof(acct_esc));
    int len = snprintf(buf, cap,
        "{\"state\":\"%s\",\"pin\":\"%s\",\"account_id\":\"%s\","
        "\"seconds_left\":%d,\"err\":\"%s\"}",
        state_name(s), pin_esc, acct_esc, seconds_left, err_esc);
    pthread_mutex_unlock(&g_rp_mtx);
    return len > 0 ? 0 : -1;
}

int remoteplay_cancel(void) {
    resolve_once();
    pthread_mutex_lock(&g_rp_mtx);
    int s = g_rp_state;
    g_rp_state = RP_STATE_IDLE;
    g_rp_err[0] = 0;
    g_rp_pin[0] = 0;
    g_rp_deadline = 0;
    pthread_mutex_unlock(&g_rp_mtx);

    /* Disconnect any active session. Done outside the lock to avoid
     * holding the mutex over a Sony IPC round-trip. */
    if (s == RP_STATE_WAITING || s == RP_STATE_PAIRED) {
        if (g_resolved && g_disconnect) {
            (void)g_disconnect();
        }
    }
    return 0;
}
