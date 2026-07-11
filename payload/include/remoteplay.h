#ifndef PS5UPLOAD_REMOTEPLAY_H
#define PS5UPLOAD_REMOTEPLAY_H

#include <stdint.h>
#include <stddef.h>

void remoteplay_init(void);

int remoteplay_request(const char *manual_account_id);

int remoteplay_get_status(char *buf, size_t cap);

int remoteplay_cancel(void);

#endif
