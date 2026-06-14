#ifndef PS5UPLOAD2_PROC_LIST_H
#define PS5UPLOAD2_PROC_LIST_H

#include <stddef.h>

/*
 * Walk the kernel's allproc linked list and emit a JSON blob describing
 * every process on the system. Response shape:
 *
 *   {"ok":true,"procs":[{"pid":123,"name":"SceShellUI"}, ...]}
 *
 * or, when kernel R/W is unavailable (no kstuff loaded, etc):
 *
 *   {"ok":false,"error":"kernel_rw_unavailable"}
 *
 * This is a simple observability primitive, not a stepping stone to
 * process control. The payload never writes back to the kernel via
 * this path — only reads. The caller (the management-port handler)
 * is responsible for framing the returned bytes into an FTX2 frame.
 *
 * Returns 0 on success (buf contains valid JSON, *written_out set to
 * byte count), non-zero on internal error. `err_out` receives a short
 * ASCII code on failure and is left untouched on success.
 */
int proc_list_get_json(char *buf, size_t cap, size_t *written_out,
                       const char **err_out);

/*
 * Detailed variant for the in-app process manager. Same envelope as
 * proc_list_get_json, but each process object also carries:
 *
 *   {"pid":123,"name":"SceShellUI","comm":"SceShellUI","title_id":"",
 *    "app_id":0,"memory_mib":12.3,"threads":7,"kind":"system"}
 *
 * `kind` is one of "app" (registered game/app, has title_id), "payload"
 * (user .elf homebrew), or "system" (everything else — the UI hides and
 * guards these). Memory is resident set size in MiB; threads is the
 * process thread count. Reads only — no kernel write.
 */
int proc_list_get_json_ex(char *buf, size_t cap, size_t *written_out,
                          const char **err_out);

/*
 * SIGKILL a process by pid. Returns 0 on success, -1 on a guard trip
 * (pid <= 1, or the helper's own pid) or a failed kill. The caller (UI)
 * must confirm before killing a process classified as "system" — this
 * function trusts the request but still refuses self/kernel/init.
 */
int proc_kill(int pid);

/*
 * Look up the command/thread name of a single process by pid via
 * sysctl(KERN_PROC_PID) — same FreeBSD kinfo_proc offsets as the JSON walk.
 * Fills `out` (NUL-terminated) and returns 0 on success; returns non-zero if
 * the process does not exist or the query fails. Used by the takeover path to
 * verify a recorded pid still belongs to *our* payload before killing it
 * (guards against a recycled pid now owned by an unrelated process).
 */
int proc_name_by_pid(int pid, char *out, size_t cap);

#endif /* PS5UPLOAD2_PROC_LIST_H */
