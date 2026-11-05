#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <string.h>

#define READ_WINDOW_BYTES 65536
#define READ_WINDOW_MAP_LIMIT 32768
#define AUDITED_SQLITE_VERSION 3051003
_Static_assert(sizeof(off_t) >= 8, "read windows require 64-bit file offsets");

/* One serial, killable read worker owns the scope. Never loaded into the API
 * process or writer. No data is retained after the SELECT's read transaction. */
typedef struct {
  sqlite3 *owner;
  dev_t device;
  ino_t inode;
  off_t size;
  int fd;
  void *mapping;
  off_t offset;
  size_t length;
  unsigned maps;
  int enabled;
} ReadWindow;

static ReadWindow window = {.fd = -1, .mapping = MAP_FAILED};
static ssize_t (*original_pread)(int, void *, size_t, off_t);
static int installed;

#ifdef MEMORY_READ_WINDOW_TEST
#include "sqlite-read-window-test.h"
#else
#define TEST_COUNT(field) ((void)0)
#define TEST_MAP_FAIL 0
#define TEST_UNMAP_FAIL 0
#define TEST_READ_FAIL 0
#define TEST_MAP_LIMIT READ_WINDOW_MAP_LIMIT
#define test_probe_read(fd) ((void)0)
#define test_before_copy() ((void)0)
#define test_finished() ((void)0)
#endif

static int unmap_window(void) {
  if (window.mapping != MAP_FAILED &&
      (TEST_UNMAP_FAIL || munmap(window.mapping, window.length) != 0)) return 0;
  window.mapping = MAP_FAILED;
  window.length = 0;
  return 1;
}

static int finish_window(void) {
  int released = unmap_window();
  window.owner = NULL;
  window.enabled = 0;
  window.fd = -1;
  test_finished();
  return released;
}

static ssize_t read_original(int fd, void *buffer, size_t count, off_t offset) {
  TEST_COUNT(pread_calls);
  if (TEST_READ_FAIL) {
    errno = EIO;
    return -1;
  }
  return original_pread(fd, buffer, count, offset);
}

static ssize_t read_with_window(int fd, void *buffer, size_t count, off_t offset) {
  test_probe_read(fd);
  if (!window.owner || !window.enabled) return original_pread(fd, buffer, count, offset);
  /* Resolve just the main database descriptor. WAL and every other file keep
   * SQLite's original path; after binding, never retarget another connection. */
  if (window.fd < 0) {
    struct stat st;
    if (fstat(fd, &st) != 0 || st.st_dev != window.device || st.st_ino != window.inode)
      return original_pread(fd, buffer, count, offset);
    window.fd = fd;
  }
  if (fd != window.fd) return original_pread(fd, buffer, count, offset);
  if (offset < 0 || count == 0 || count > 4096 || (uint64_t)count > (uint64_t)window.size ||
      offset > window.size - (off_t)count) return read_original(fd, buffer, count, offset);

  int saved_errno = errno;
  if (window.mapping == MAP_FAILED || offset < window.offset ||
      (uint64_t)(offset - window.offset) + count > window.length) {
    if (window.maps >= TEST_MAP_LIMIT) return read_original(fd, buffer, count, offset);
    if (!unmap_window()) {
      window.enabled = 0;
      errno = saved_errno;
      return read_original(fd, buffer, count, offset);
    }
    off_t start = offset - offset % READ_WINDOW_BYTES;
    size_t length = (size_t)(window.size - start);
    if (length > READ_WINDOW_BYTES) length = READ_WINDOW_BYTES;
    window.maps++;
    TEST_COUNT(map_calls);
    window.mapping = TEST_MAP_FAIL ? MAP_FAILED : mmap(NULL, length, PROT_READ, MAP_SHARED, fd, start);
    if (window.mapping == MAP_FAILED) {
      TEST_COUNT(map_failures);
      window.enabled = 0; /* One failure disables this optimization for this SELECT. */
      errno = saved_errno;
      return read_original(fd, buffer, count, offset);
    }
    window.offset = start;
    window.length = length;
  }
  test_before_copy();
  memcpy(buffer, (unsigned char *)window.mapping + (offset - window.offset), count);
  TEST_COUNT(mapped_reads);
  errno = saved_errno;
  return (ssize_t)count;
}

static void begin_window(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  sqlite3 *db = sqlite3_context_db_handle(ctx);
  const char *path = sqlite3_db_filename(db, "main");
  struct stat st;
  int moved = 0;
  if (window.owner || !unmap_window() || sqlite3_db_readonly(db, "main") != 1 ||
      sqlite3_txn_state(db, "main") != SQLITE_TXN_READ || !path ||
      sqlite3_uri_boolean(path, "immutable", 0) || sqlite3_uri_boolean(path, "nolock", 0) ||
      sqlite3_file_control(db, "main", SQLITE_FCNTL_HAS_MOVED, &moved) != SQLITE_OK || moved ||
      stat(path, &st) != 0 || !S_ISREG(st.st_mode)) {
    sqlite3_result_int(ctx, 0);
    return;
  }
  window.owner = db;
  window.device = st.st_dev;
  window.inode = st.st_ino;
  window.size = st.st_size;
  window.fd = -1;
  window.maps = 0;
  window.enabled = 1;
#ifdef MEMORY_READ_WINDOW_TEST
  memset(&test_stats, 0, sizeof(test_stats));
  test_paused = 0;
#endif
  sqlite3_result_int(ctx, 1);
}

static void end_window(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  int released = window.owner != sqlite3_context_db_handle(ctx) || finish_window();
  sqlite3_result_int(ctx, released);
}

static void connection_closed(void *db) {
  if (window.owner == db) finish_window();
}

/* xSetSystemCall is version-sensitive and optional. This backend is deliberately
 * audited/pinned to the shipped SQLite Unix implementation, with no fallback to
 * ABI offsets, another VFS, an immutable connection, or an unverified version. */
__attribute__((visibility("default")))
int sqlite3_extension_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
  (void)error;
  SQLITE_EXTENSION_INIT2(api);
  sqlite3_vfs *vfs = sqlite3_vfs_find(NULL);
  if (SQLITE_VERSION_NUMBER != AUDITED_SQLITE_VERSION ||
      sqlite3_libversion_number() != AUDITED_SQLITE_VERSION || !vfs ||
      strcmp(vfs->zName, "unix") != 0 || vfs->iVersion < 3 ||
      !vfs->xGetSystemCall || !vfs->xSetSystemCall) return SQLITE_MISMATCH;
  if (!installed) {
    original_pread = (ssize_t (*)(int, void *, size_t, off_t))vfs->xGetSystemCall(vfs, "pread");
    if (!original_pread) return SQLITE_NOTFOUND;
  }
  /* Scope ownership may only change through the wrapper's top-level SQL, never
   * through a persisted view, trigger, or schema expression. */
  const int flags = SQLITE_UTF8 | SQLITE_DIRECTONLY;
  int rc = sqlite3_create_function_v2(db, "memory_read_window_begin", 0, flags, db,
                                    begin_window, NULL, NULL, connection_closed);
  if (rc != SQLITE_OK) return rc;
  rc = sqlite3_create_function_v2(db, "memory_read_window_end", 0, flags, db,
                                end_window, NULL, NULL, connection_closed);
  if (rc == SQLITE_OK && !installed)
    rc = vfs->xSetSystemCall(vfs, "pread", (sqlite3_syscall_ptr)read_with_window);
  if (rc != SQLITE_OK) {
    sqlite3_create_function(db, "memory_read_window_begin", 0, flags, NULL, NULL, NULL, NULL);
    sqlite3_create_function(db, "memory_read_window_end", 0, flags, NULL, NULL, NULL, NULL);
    return rc;
  }
  installed = 1;
#ifdef MEMORY_READ_WINDOW_TEST
  register_test_functions(db);
#endif
  /* The VFS callback outlives any one connection. SQLite must not dlclose it. */
  return SQLITE_OK_LOAD_PERMANENTLY;
}
