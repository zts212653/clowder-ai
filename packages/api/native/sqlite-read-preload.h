/* Owned by the admitted read-window scope. Borrow SQLite's verified descriptor:
 * closing even a dup would drop this process's SQLite advisory locks. */
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>

#define PRELOAD_BYTES 4194304
static struct {
  int fd, attempted, started, joined, error, checked;
  long page_size;
  pthread_t thread;
  atomic_bool stop;
  off_t size;
  uint64_t bytes, calls;
  char resident[READ_WINDOW_BYTES / 4096];
} preload = {.fd = -1};

#ifdef MEMORY_READ_WINDOW_TEST
static unsigned preload_test_flags;
static char preload_test_ready[1024], preload_test_release[1024], preload_test_close[1024];
#define PRELOAD_TEST(flag) (preload_test_flags & (flag))
static void preload_test_checkpoint(void) {
  if (!preload_test_ready[0]) return;
  int fd = open(preload_test_ready, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd >= 0) { (void)write(fd, "reading", 7); close(fd); }
  struct timespec delay = {.tv_sec = 0, .tv_nsec = 1000000};
  for (unsigned i = 0; i < 3000 && access(preload_test_release, F_OK) != 0; i++) {
    /* A between-read pause can observe stop. An injected in-flight read cannot
     * observe it until it returns; the parent process deadline still applies. */
    if (!PRELOAD_TEST(256) && atomic_load_explicit(&preload.stop, memory_order_relaxed)) break;
    nanosleep(&delay, NULL);
  }
}
static void preload_test_closing(void) {
  if (!preload_test_close[0]) return;
  int fd = open(preload_test_close, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd >= 0) { (void)write(fd, "closing", 7); close(fd); }
}
#else
#define PRELOAD_TEST(flag) 0
#define preload_test_checkpoint() ((void)0)
#define preload_test_closing() ((void)0)
#endif

static void *preload_main(void *unused) {
  (void)unused;
  void *buffer = PRELOAD_TEST(8) ? NULL : malloc(PRELOAD_BYTES);
  if (!buffer) { preload.error = ENOMEM; return NULL; }
  for (off_t offset = 0; offset < preload.size && !atomic_load_explicit(&preload.stop, memory_order_relaxed);) {
    size_t length = (size_t)(preload.size - offset);
    if (length > PRELOAD_BYTES) length = PRELOAD_BYTES;
    ssize_t n;
    if (!offset && PRELOAD_TEST(256)) preload_test_checkpoint();
    if (PRELOAD_TEST(32)) { errno = EIO; n = -1; }
    else n = original_pread(preload.fd, buffer, length, offset);
    preload.calls++;
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { preload.error = n == 0 ? EIO : errno; break; }
    if (!offset && !PRELOAD_TEST(256)) preload_test_checkpoint();
    offset += n;
    preload.bytes += (uint64_t)n;
  }
  free(buffer);
  return NULL;
}

static void finish_preload(void) {
  atomic_store_explicit(&preload.stop, 1, memory_order_relaxed);
  if (preload.started && !preload.joined) {
    /* Only the serial owner joins its joinable helper. Continuing on an
     * impossible join failure could reuse live state; terminate this worker. */
    if (pthread_join(preload.thread, NULL) != 0) abort();
    preload.joined = 1;
  }
  preload.fd = -1; /* Borrowed, never closed here. Join precedes SQLite teardown. */
}

static void snapshot_preload(char *out, size_t size) {
  /* Scope end joins before retiring its owner. Never read helper-written
   * counters during a live scope, even if its SQL has already returned. */
  if (window.owner || (preload.started && !preload.joined)) {
    snprintf(out, size, "null");
    return;
  }
  snprintf(out, size,
    "{\"attempted\":%s,\"started\":%s,\"joined\":%s,\"logicalBytes\":%llu,\"readCalls\":%llu,\"errorCode\":%d}",
    preload.attempted ? "true" : "false", preload.started ? "true" : "false",
    preload.joined ? "true" : "false", (unsigned long long)preload.bytes,
    (unsigned long long)preload.calls, preload.error);
}

static void begin_preload(void) {
  memset(&preload, 0, sizeof(preload));
  atomic_init(&preload.stop, 0);
  preload.fd = -1;
  preload.page_size = sysconf(_SC_PAGESIZE);
}

static void maybe_start_preload(int fd, size_t relative, size_t count) {
  if (preload.attempted || PRELOAD_TEST(2)) return;
  int saved_errno = errno;
  if (!PRELOAD_TEST(1)) {
    long page = preload.page_size;
    if (page < 4096 || page > READ_WINDOW_BYTES) goto unavailable;
    if (!preload.checked) {
      if (PRELOAD_TEST(64) || mincore(window.mapping, window.length, preload.resident) != 0) goto unavailable;
      preload.checked = 1;
    }
    size_t first = relative / (size_t)page, last = (relative + count - 1) / (size_t)page;
    int cold = 0;
    for (size_t p = first; p <= last; p++) if (!(preload.resident[p] & 1)) cold = 1;
    if (!cold) { errno = saved_errno; return; }
  }
  preload.attempted = 1;
  preload.fd = fd;
  preload.size = window.size;
  int rc = PRELOAD_TEST(16) ? EAGAIN : pthread_create(&preload.thread, NULL, preload_main, NULL);
  if (rc) { preload.error = rc; finish_preload(); }
  else preload.started = 1;
  errno = saved_errno;
  return;
unavailable:
  preload.attempted = 1;
  preload.error = errno ? errno : EIO;
  errno = saved_errno;
}

#ifdef MEMORY_READ_WINDOW_TEST
static void test_preload_close_control(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  const char *path = (const char *)sqlite3_value_text(argv[0]);
  snprintf(preload_test_close, sizeof(preload_test_close), "%s", path ? path : "");
  sqlite3_result_int(ctx, 1);
}
static void test_preload_control(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  if (window.owner) { sqlite3_result_error(ctx, "active scope", -1); return; }
  preload_test_flags = (unsigned)sqlite3_value_int(argv[0]);
  const char *ready = (const char *)sqlite3_value_text(argv[1]);
  const char *release = (const char *)sqlite3_value_text(argv[2]);
  snprintf(preload_test_ready, sizeof(preload_test_ready), "%s", ready ? ready : "");
  snprintf(preload_test_release, sizeof(preload_test_release), "%s", release ? release : "");
  sqlite3_result_int(ctx, 1);
}
static void test_preload_report(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  char out[256];
  /* Worker-written counters are inspected only after join. */
  snprintf(out, sizeof(out),
    "{\"attempted\":%d,\"started\":%d,\"joined\":%d,\"borrowedFd\":%d,\"bytes\":%llu,\"calls\":%llu,\"error\":%d}",
    preload.attempted, preload.started, preload.joined, preload.fd >= 0,
    (unsigned long long)(preload.joined ? preload.bytes : 0),
    (unsigned long long)(preload.joined ? preload.calls : 0),
    (!preload.started || preload.joined) ? preload.error : 0);
  sqlite3_result_text(ctx, out, -1, SQLITE_TRANSIENT);
}
#endif
